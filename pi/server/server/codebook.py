"""Code-book derivation (design doc §7.6 / §8.1).

The temporal blink cycle is fully determined by the LED count, the bit period
and the FEC mode: ``ceil(log2(ledCount+1))`` Gray data bits, wrapped in an
extended-Hamming SEC-DED code by default (``fec="secded"``), plus the 2-frame
all-on / all-off sync delimiter. M2 owns this derivation so the same
:class:`CodeParams` go into both the ``welcome`` and ``mapping_started``
messages and (eventually) to the M1 driver.
"""

from __future__ import annotations

import math

from ledmapper_protocol import CodeParams
from ledmapper_protocol.fec import secded_total_bits

# design doc §12 default: bit period ≥ ~3 camera frame intervals at 30 fps.
DEFAULT_BIT_PERIOD_MS = 100.0


def data_bits_for(led_count: int) -> int:
    """Gray data-word width: ``ceil(log2(ledCount + 1))``, minimum 1.

    +1: codewords carry id + 1 (led_driver.graycode.CODE_OFFSET — the
    all-zero word is reserved-invalid), so the code space is [1, ledCount].
    """
    return max(1, math.ceil(math.log2(led_count + 1)))


def code_params_for(
    led_count: int,
    bit_period_ms: float = DEFAULT_BIT_PERIOD_MS,
    encoding: str = "gray",
    fec: str = "secded",
) -> CodeParams:
    """Build the :class:`CodeParams` code-book for a fixture of ``led_count`` LEDs.

    ``bits`` counts the TRANSMITTED bit frames: the Gray data word plus, with
    ``fec="secded"`` (the default), the extended-Hamming parity frames that
    make single-window misreads correctable and double misreads detectable —
    the raw Gray codebook has Hamming distance 1, so without FEC one decisive
    window error decodes to a valid WRONG id. ``cycleFrames`` adds the 2-frame
    sync delimiter. ``encoding`` selects intensity blinking (``gray``) or
    constant-brightness color coding (``gray-hue``, §7.6) — the frame PLAN is
    identical, only the physical carrier differs.
    """
    if led_count < 1:
        raise ValueError(f"led_count must be ≥ 1, got {led_count}")
    if fec not in ("none", "secded"):
        raise ValueError(f"unknown fec {fec!r}")
    k = data_bits_for(led_count)
    bits = k if fec == "none" else secded_total_bits(k)
    return CodeParams(
        ledCount=led_count,
        bits=bits,
        encoding=encoding,
        bitPeriodMs=bit_period_ms,
        syncPattern="on_off",
        cycleFrames=2 + bits,
        fec=fec,
    )
