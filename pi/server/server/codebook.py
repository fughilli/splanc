"""Code-book derivation (design doc §7.6 / §8.1, hue-only revision).

The temporal hue cycle is fully determined by the LED count, the symbol
alphabet, the frame period and the FEC mode: ``ceil(log2(ledCount+1))`` Gray
data bits, wrapped in an extended-Hamming SEC-DED code by default
(``fec="secded"``), transmitted ``log2(symbols)`` bits per color frame, plus
the 2-frame white/green sync delimiter. M2 owns this derivation so the same
:class:`CodeParams` go into both the ``welcome`` and ``mapping_started``
messages and (eventually) to the M1 driver.
"""

from __future__ import annotations

import math

from ledmapper_protocol import CodeParams
from ledmapper_protocol.fec import secded_total_bits

# design doc §12 default: frame period ≥ ~3 camera frame intervals at 30 fps.
DEFAULT_BIT_PERIOD_MS = 100.0

# Robust fallback alphabet for clients that don't negotiate one: red/blue has
# maximum hue separation; the client upgrades to 4 when its measured chroma
# SNR supports the finer palette.
DEFAULT_SYMBOLS = 2


def data_bits_for(led_count: int) -> int:
    """Gray data-word width: ``ceil(log2(ledCount + 1))``, minimum 1.

    +1: codewords carry id + 1 (led_driver.graycode.CODE_OFFSET — the
    all-zero word is reserved-invalid), so the code space is [1, ledCount].
    """
    return max(1, math.ceil(math.log2(led_count + 1)))


def code_params_for(
    led_count: int,
    bit_period_ms: float = DEFAULT_BIT_PERIOD_MS,
    symbols: int = DEFAULT_SYMBOLS,
    fec: str = "secded",
    brightness: float | None = None,
) -> CodeParams:
    """Build the :class:`CodeParams` code-book for a fixture of ``led_count`` LEDs.

    ``bits`` counts the coded BITS: the Gray data word plus, with
    ``fec="secded"`` (the default), the extended-Hamming parity bits that
    make single misreads correctable and double misreads detectable — the
    raw Gray codebook has Hamming distance 1, so without FEC one decisive
    window error decodes to a valid WRONG id. Bits are transmitted
    ``log2(symbols)`` per color frame (``symbols`` is the client-negotiated
    data alphabet: 2 = red/blue, 4 = the Gray-ordered
    blue/magenta/red/yellow palette that halves the data frames);
    ``cycleFrames`` adds the 2-frame white/green sync delimiter.
    """
    if led_count < 1:
        raise ValueError(f"led_count must be ≥ 1, got {led_count}")
    if fec not in ("none", "secded"):
        raise ValueError(f"unknown fec {fec!r}")
    if symbols not in (2, 4):
        raise ValueError(f"symbols must be 2 or 4, got {symbols}")
    if brightness is not None and not 0.0 <= brightness <= 1.0:
        raise ValueError(f"brightness must be in [0, 1], got {brightness}")
    k = data_bits_for(led_count)
    bits = k if fec == "none" else secded_total_bits(k)
    bits_per_frame = 1 if symbols == 2 else 2
    return CodeParams(
        ledCount=led_count,
        bits=bits,
        encoding="hue",
        symbols=symbols,
        bitPeriodMs=bit_period_ms,
        syncPattern="on_off",
        cycleFrames=2 + math.ceil(bits / bits_per_frame),
        fec=fec,
        # None (= 1.0 on the wire) unless the phone servoed it down against
        # measured bloom/wash-out (exposure.ts planLedBrightness).
        brightness=brightness,
    )
