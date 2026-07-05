"""Reconstruction job runners (design doc §3 / §6 M2).

Two solvers share the M3 library:

* :class:`ReconstructionRunner` — the final solve. After a capture ends, M2
  turns the session log into an :class:`OutputMap`, persisted to the map store.
  The design frames this as a subprocess/job; for the MVP we call the M3
  library in a worker thread (``asyncio.to_thread``) so the event loop and the
  WebSocket stay responsive during the (potentially multi-second) bundle
  adjustment. The seam is a single async callable, so swapping in a real
  subprocess later (process isolation, cancellation, resource caps) is a local
  change.

* :class:`LiveSolver` — the continuous solve. While a capture is running,
  ``get_live_map`` polls drive interim reconstructions of the in-memory
  detections so the phone can watch the map converge during the walk. Interim
  maps are advisory and in-memory only; the persisted artifact is still the
  final solve.
"""

from __future__ import annotations

import asyncio
import json
from collections import deque
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable, Deque, Optional, Sequence, Tuple

from ledmapper_protocol import DetectionRecord, OutputMap
from reconstruction.api import reconstruct

from .clock import now_ms
from .session import MapStore, SessionManager


def _reconstruct_sync(log_path: Path) -> OutputMap:
    data = json.loads(Path(log_path).read_text())
    if isinstance(data, list):
        detections, led_count = data, None
    else:
        detections, led_count = data.get("detections", []), data.get("ledCount")
    return reconstruct(detections, led_count=led_count)


class ReconstructionRunner:
    """Async wrapper: reconstruct a session log off the event loop, then store it."""

    def __init__(self, map_store: MapStore):
        self.map_store = map_store

    async def __call__(self, log_path: Path) -> OutputMap:
        output_map = await asyncio.to_thread(_reconstruct_sync, log_path)
        self.map_store.save(output_map)
        return output_map


# A live solve: (detections, led_count, session_id, prev_map=...) -> OutputMap.
# ``prev_map`` is the previously adopted interim map (or None) — the default
# solve warm-starts from it, which is what keeps interim cadence flat as the
# session grows.
LiveSolve = Callable[..., OutputMap]

# Interim solves subsample to this many observations per LED so the live map
# keeps a fast, roughly constant update cadence however long the walk gets.
# The final (stop_mapping) solve still uses every observation.
LIVE_MAX_VIEWS_PER_LED = 16


def _decimate_per_led(
    detections: Sequence[DetectionRecord], max_views: int
) -> list[DetectionRecord]:
    """Evenly subsample each LED's observations to at most ``max_views``.

    An even stride over the (chronological) observation list preserves each
    LED's pose spread — parallax is what conditions the solve — unlike a
    most-recent-N cut, which would cluster views at the end of the walk.
    """
    by_led: dict = {}
    for d in detections:
        by_led.setdefault(d.ledId, []).append(d)
    out: list[DetectionRecord] = []
    for obs in by_led.values():
        n = len(obs)
        if n <= max_views:
            out.extend(obs)
        else:
            step = (n - 1) / (max_views - 1)
            out.extend(obs[round(i * step)] for i in range(max_views))
    return out


def _live_solve(
    detections: Sequence[DetectionRecord],
    led_count: int,
    session_id: str,
    prev_map: Optional[OutputMap] = None,
) -> OutputMap:
    sample = _decimate_per_led(detections, LIVE_MAX_VIEWS_PER_LED)
    seeds = {e.id: e.xyz for e in prev_map.leds} if prev_map is not None else None
    # A stable, recognizable mapId: interim maps are never persisted, so there
    # is no store to collide with.
    return reconstruct(
        sample, led_count=led_count, map_id=f"live-{session_id}", initial_points=seeds
    )


class LiveSolver:
    """Poll-driven continuous reconstruction of the active capture session.

    ``poll()`` is cheap and never blocks: it returns the latest interim map
    immediately and, when new detections have arrived since the last solve and
    none is in flight, kicks a fresh solve of a snapshot on the worker thread
    (single-flight — the polling cadence, not the solve duration, sets the
    update rate, and a slow bundle adjustment can never pile up).

    All state is touched only from the event-loop thread; the worker thread
    sees nothing but its snapshot. Thread-based rather than asyncio-task-based
    so it has no affinity to a particular event loop.
    """

    def __init__(self, solve: Optional[LiveSolve] = None, *, clock: Optional[Callable[[], float]] = None):
        self._solve = solve or _live_solve
        self._clock = clock or now_ms
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="live-solve")
        self._future: Optional[Future] = None
        self._future_n = 0
        self._map: Optional[OutputMap] = None
        self._session_id: Optional[str] = None
        self._solved_count = 0
        # (adopted_at_ms, n_detections_solved, map) — diagnostics (debug.py):
        # lets /debug/led/{id} show how each LED's estimate evolved.
        self.history: Deque[Tuple[float, int, OutputMap]] = deque(maxlen=300)

    @property
    def latest_map(self) -> Optional[OutputMap]:
        """Most recent adopted interim map (None when idle). Diagnostics."""
        return self._map

    def poll(self, sessions: SessionManager) -> Tuple[bool, Optional[OutputMap]]:
        """Return ``(active, latest interim map)``; may kick a new solve."""
        snap = sessions.snapshot()
        if snap is None:
            self.reset()
            return False, None
        session_id, led_count, detections = snap
        if session_id != self._session_id:
            self.reset()
            self._session_id = session_id

        if self._future is not None and self._future.done():
            future, self._future = self._future, None
            try:
                self._map = future.result()
                self.history.append((self._clock(), self._future_n, self._map))
            except Exception:
                # Interim solves are best-effort (early snapshots can be
                # degenerate); the next poll with new detections retries.
                pass

        if self._future is None and len(detections) > self._solved_count:
            self._solved_count = len(detections)
            self._future_n = len(detections)
            self._future = self._executor.submit(
                self._solve, detections, led_count, session_id, prev_map=self._map
            )
        return True, self._map

    def reset(self) -> None:
        # An in-flight solve is not cancelled, just orphaned: dropping the
        # future means its result is never adopted. History survives the
        # reset so a just-stopped session can still be studied.
        self._future = None
        self._map = None
        self._session_id = None
        self._solved_count = 0

    def flush(self) -> None:
        """Block until any in-flight solve finishes (testing hook)."""
        if self._future is not None:
            self._future.exception()  # waits; swallows the error like poll()
