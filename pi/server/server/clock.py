"""Server clock (design doc §7.3).

All server-side timestamps — the clock-sync ``t1``/``t2`` and the
``patternClockEpoch`` — must come from one monotonic clock so the phone can
align its capture times to the pattern clock with a single offset. ``time.time``
is wall-clock and can step (NTP, suspend); ``time.monotonic`` cannot, which is
what SNTP-style offset estimation wants.

The epoch is arbitrary (monotonic clocks have no fixed zero); only *differences*
are meaningful, which is exactly what §7.3's offset/rtt math uses.
"""

from __future__ import annotations

import time


def now_ms() -> float:
    """Monotonic time in milliseconds."""
    return time.monotonic() * 1000.0
