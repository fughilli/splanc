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

from ledmapper_protocol import DetectionRecord, OutputMap

from .clock import now_ms


class Session:
    """A single in-progress capture."""

    def __init__(self, session_id: str, led_count: int, pattern_clock_epoch: float):
        self.session_id = session_id
        self.led_count = led_count
        self.pattern_clock_epoch = pattern_clock_epoch
        self.detections: List[DetectionRecord] = []
        # ledId -> number of observations, for live coverage guidance.
        self._views: dict = {}

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

    def start(self, session_id: str, led_count: int) -> float:
        """Begin a capture; returns the ``patternClockEpoch`` (design doc §8.2).

        Until the M1 driver exists to report the true start-of-cycle epoch, the
        server stamps the epoch with the current server clock; the driver's
        ``get_clock().epoch`` will replace this once M1 lands.
        """
        with self._lock:
            epoch = now_ms()
            self._active = Session(session_id, led_count, epoch)
            return epoch

    def add_detections(self, records: Sequence[DetectionRecord]) -> None:
        with self._lock:
            if self._active is None:
                raise RuntimeError("no active capture session")
            self._active.add(records)

    def status(self) -> Tuple[int, int, int]:
        with self._lock:
            if self._active is None:
                return 0, 0, 0
            return self._active.status()

    def pattern_state(self) -> Optional[Tuple[float, int]]:
        """Return ``(patternClockEpoch, ledCount)`` of the active capture, or None.

        Pattern followers (the virtual LED wall) poll this via ``get_pattern`` so
        they can render the blink code against the same clock the phone decodes.
        """
        with self._lock:
            if self._active is None:
                return None
            return self._active.pattern_clock_epoch, self._active.led_count

    def stop(self) -> Tuple[str, Path]:
        """Finalize the active session: write its log, clear active state.

        Returns ``(session_id, log_path)``. Raises if there is no active session.
        """
        with self._lock:
            if self._active is None:
                raise RuntimeError("no active capture session")
            session = self._active
            self._active = None

        log = {
            "ledCount": session.led_count,
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
