"""Monotonic millisecond clock for the pattern epoch (design doc §8.2).

The pattern clock epoch and M2's clock-sync must share a monotonic time base so a
phone capture time can be mapped to a bit index. Kept local to M1 (no dependency
on M2) — the value is exported to M2 over the control socket.
"""

from __future__ import annotations

import time


def now_ms() -> float:
    """Monotonic time in milliseconds."""
    return time.monotonic() * 1000.0
