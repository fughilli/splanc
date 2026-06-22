"""Reconstruction job runner (design doc §3 / §6 M2).

After a capture ends, M2 turns the session log into an :class:`OutputMap` by
calling M3. The design frames this as a subprocess/job; for the MVP we call the
M3 library in a worker thread (``asyncio.to_thread``) so the event loop and the
WebSocket stay responsive during the (potentially multi-second) bundle
adjustment. The seam is a single async callable, so swapping in a real
subprocess later (process isolation, cancellation, resource caps) is a local
change.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from ledmapper_protocol import OutputMap
from reconstruction.api import reconstruct

from .session import MapStore


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
