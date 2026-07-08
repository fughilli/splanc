"""Capture-session bookkeeping and the map store (design doc §6 M2).

`SessionManager` holds **one** active capture session at a time (the MVP
constraint, §6 M2 "State"). It ingests :class:`DetectionRecord` batches, tracks
live coverage counts for ``status`` messages, and on stop writes a **session
log** — ``{"ledCount", "detections": [...]}`` — which is exactly the format the
M3 reconstruction CLI/library consumes, so a capture can be re-reconstructed
offline and reused as a test fixture.

`MapStore` persists the reconstructed :class:`OutputMap` as ``{mapId}.json`` plus
a flat ``{mapId}.csv`` (design doc §7.5), which the ``GET /maps/{id}`` routes
serve.

Detections are buffered in memory and flushed on stop. The trade-off: a crash
mid-capture loses the in-flight session. Incremental on-disk journaling is a
deliberate later hardening, not needed for the bench MVP.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import List, Optional, Sequence, Tuple

from ledmapper_protocol import CodeParams, DetectionRecord, ExposureStats, OutputMap

from .clock import now_ms


class Session:
    """A single in-progress capture."""

    def __init__(self, session_id: str, code_params: CodeParams, pattern_clock_epoch: float):
        self.session_id = session_id
        self.code_params = code_params
        self.pattern_clock_epoch = pattern_clock_epoch
        self.detections: List[DetectionRecord] = []
        # Client exposure telemetry (§7.1 exposure_report), kept for the log.
        self.exposure: List[ExposureStats] = []
        # ledId -> number of observations, for live coverage guidance.
        self._views: dict = {}

    @property
    def led_count(self) -> int:
        return self.code_params.ledCount

    def add(self, records: Sequence[DetectionRecord]) -> None:
        for r in records:
            self.detections.append(r)
            self._views[r.ledId] = self._views.get(r.ledId, 0) + 1

    def status(self) -> Tuple[int, int, int]:
        """Return ``(identified, total, lowParallax)`` for a ``status`` message.

        We cannot compute true parallax live without running the geometry, so
        this reports honest *proxies* the UI (M8) can act on during the walk:
        ``identified`` = LEDs with ≥2 observations (the minimum to triangulate);
        ``lowParallax`` = LEDs seen exactly once (not yet triangulable — "keep
        moving"). True per-LED parallax is computed at reconstruction and
        surfaced in the :class:`OutputMap`.
        """
        identified = sum(1 for n in self._views.values() if n >= 2)
        low = sum(1 for n in self._views.values() if n == 1)
        return identified, self.led_count, low


class SessionManager:
    """Owns the (at most one) active session and writes its log on stop."""

    def __init__(self, session_dir: Path):
        self.session_dir = Path(session_dir)
        self.session_dir.mkdir(parents=True, exist_ok=True)
        self._active: Optional[Session] = None
        self._lock = threading.Lock()

    @property
    def active(self) -> Optional[Session]:
        return self._active

    def start(self, session_id: str, code_params: CodeParams) -> float:
        """Begin a capture; returns the ``patternClockEpoch`` (design doc §8.2).

        The full code-book comes from the client (start_mapping options overlaid
        on server defaults by the handler) — the phone measured the scene, so it
        owns the encoding/rate choice.

        Until the M1 driver exists to report the true start-of-cycle epoch, the
        server stamps the epoch with the current server clock; the driver's
        ``get_clock().epoch`` will replace this once M1 lands.
        """
        with self._lock:
            epoch = now_ms()
            self._active = Session(session_id, code_params, epoch)
            return epoch

    def reconfigure(self, code_params: CodeParams) -> float:
        """Mid-capture renegotiation (§7.1 configure): swap the code-book and
        restamp the pattern epoch; detections already collected are kept (they
        are (ledId, pixel, pose) records — independent of the signaling that
        produced them). Followers pick the new clock up via ``get_pattern``.

        Returns the new ``patternClockEpoch``. Raises if no capture is active.
        """
        with self._lock:
            if self._active is None:
                raise RuntimeError("no active capture session")
            epoch = now_ms()
            self._active.code_params = code_params
            self._active.pattern_clock_epoch = epoch
            return epoch

    def add_detections(self, records: Sequence[DetectionRecord]) -> None:
        with self._lock:
            if self._active is None:
                raise RuntimeError("no active capture session")
            self._active.add(records)

    def add_exposure(self, report: ExposureStats) -> None:
        """Record one exposure_report; silently dropped when no capture is
        active (reports are telemetry, racing stop is not an error)."""
        with self._lock:
            if self._active is not None:
                self._active.exposure.append(report)

    def status(self) -> Tuple[int, int, int]:
        with self._lock:
            if self._active is None:
                return 0, 0, 0
            return self._active.status()

    def snapshot(self) -> Optional[Tuple[str, int, List[DetectionRecord]]]:
        """``(session_id, led_count, detections copy)`` of the active capture.

        The copy is what lets the continuous solver work on a consistent view
        while new batches keep arriving.
        """
        with self._lock:
            if self._active is None:
                return None
            s = self._active
            return s.session_id, s.led_count, list(s.detections)

    def pattern_state(self) -> Optional[Tuple[float, CodeParams]]:
        """Return ``(patternClockEpoch, codeParams)`` of the active capture, or None.

        Pattern followers (the virtual LED wall) poll this via ``get_pattern`` so
        they can render the blink code against the same clock the phone decodes.
        The full CodeParams (not just ledCount) matter: a mid-capture configure
        can change the encoding or bit period, and followers must track it.
        """
        with self._lock:
            if self._active is None:
                return None
            return self._active.pattern_clock_epoch, self._active.code_params

    def stop(self) -> Tuple[str, Path]:
        """Finalize the active session: write its log, clear active state.

        Returns ``(session_id, log_path)``. Raises if there is no active session.
        """
        with self._lock:
            if self._active is None:
                raise RuntimeError("no active capture session")
            session = self._active
            self._active = None

        # codeParams + exposure are additive diagnostic keys; M3's log reader
        # takes ledCount/detections and ignores the rest.
        log = {
            "ledCount": session.led_count,
            "codeParams": session.code_params.model_dump(),
            "exposure": [e.model_dump() for e in session.exposure],
            "detections": [d.model_dump() for d in session.detections],
        }
        path = self.session_dir / f"{session.session_id}.json"
        path.write_text(json.dumps(log, indent=2))
        return session.session_id, path


class MapStore:
    """Persists reconstructed maps as ``{id}.json`` and ``{id}.csv``."""

    def __init__(self, maps_dir: Path):
        self.maps_dir = Path(maps_dir)
        self.maps_dir.mkdir(parents=True, exist_ok=True)

    def json_path(self, map_id: str) -> Path:
        return self.maps_dir / f"{map_id}.json"

    def csv_path(self, map_id: str) -> Path:
        return self.maps_dir / f"{map_id}.csv"

    def exists(self, map_id: str) -> bool:
        return self.json_path(map_id).is_file()

    def save(self, output_map: OutputMap) -> None:
        self.json_path(output_map.mapId).write_text(output_map.model_dump_json(indent=2))
        self.csv_path(output_map.mapId).write_text(_to_csv(output_map))


def _to_csv(output_map: OutputMap) -> str:
    """Flat CSV per design doc §7.5: ``id,x,y,z,confidence,n_views``."""
    lines = ["id,x,y,z,confidence,n_views"]
    for e in output_map.leds:
        x, y, z = e.xyz
        lines.append(f"{e.id},{x:.6f},{y:.6f},{z:.6f},{e.confidence:.4f},{e.nViews}")
    return "\n".join(lines) + "\n"
