"""Code-book derivation (design doc §7.6 / §8.1).

The temporal Gray-code cycle is fully determined by the LED count and the bit
period: ``bits = ceil(log2(ledCount))`` and ``cycleFrames = 2 + bits`` (the two
extra frames are the all-on / all-off sync delimiter). M2 owns this derivation
so the same :class:`CodeParams` go into both the ``welcome`` and
``mapping_started`` messages and (eventually) to the M1 driver.
"""

from __future__ import annotations

import math

from ledmapper_protocol import CodeParams

# design doc §12 default: bit period ≥ ~3 camera frame intervals at 30 fps.
DEFAULT_BIT_PERIOD_MS = 100.0


def code_params_for(led_count: int, bit_period_ms: float = DEFAULT_BIT_PERIOD_MS) -> CodeParams:
    """Build the :class:`CodeParams` code-book for a fixture of ``led_count`` LEDs.

    ``bits`` is at least 1 even for a single LED (the schema requires ``bits ≥ 1``
    and a 0-bit code is meaningless); ``cycleFrames`` adds the 2-frame sync
    delimiter on top of the data bits.
    """
    if led_count < 1:
        raise ValueError(f"led_count must be ≥ 1, got {led_count}")
    bits = max(1, math.ceil(math.log2(led_count))) if led_count > 1 else 1
    return CodeParams(
        ledCount=led_count,
        bits=bits,
        encoding="gray",
        bitPeriodMs=bit_period_ms,
        syncPattern="on_off",
        cycleFrames=2 + bits,
    )
