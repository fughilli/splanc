"""Code-book derivation (design doc §7.6 / §8.1, hue-only revision).

The temporal hue cycle is fully determined by the LED count, the symbol
alphabet, the frame period and the FEC mode: ``ceil(log2(ledCount+1))`` Gray
data bits, wrapped in an extended-Hamming SEC-DED code by default
(``fec="secded"``), transmitted ``log2(symbols)`` bits per color frame, plus
the 2-frame white/green sync delimiter. The same :class:`CodeParams` go into
both the ``welcome`` and ``mapping_started`` messages.

The arithmetic is NOT reimplemented here: it is the Rust hue-code kernel
(``//firmware/pattern``, the one implementation the players link and the phone
runs as wasm), called through the one Python binding of its C ABI,
``ledmapper_pattern`` (``//firmware/pattern:pattern_py``, ctypes over the host
cdylib). This module only validates arguments and assembles the message.
"""

from __future__ import annotations

import ledmapper_pattern as pattern
from ledmapper_protocol import CodeParams

# design doc §12 default: frame period ≥ ~3 camera frame intervals at 30 fps.
DEFAULT_BIT_PERIOD_MS = 100.0

# Robust fallback alphabet for clients that don't negotiate one: red/blue has
# maximum hue separation; the client upgrades to 4 when its measured chroma
# SNR supports the finer palette.
DEFAULT_SYMBOLS = 2

# CodeParams.syncPattern values the dev backend can run (schema enum).
SYNC_PATTERNS = ("on_off", "stagger_pilot")


def data_bits_for(led_count: int) -> int:
    """Gray data-word width: ``ceil(log2(ledCount + 1))``, minimum 1.

    +1: codewords carry id + 1 (the kernel's CODE_OFFSET — the all-zero word is
    reserved-invalid), so the code space is [1, ledCount].
    """
    return pattern.data_bits(led_count)


secded_total_bits = pattern.secded_total_bits


def code_params_for(
    led_count: int,
    bit_period_ms: float = DEFAULT_BIT_PERIOD_MS,
    symbols: int = DEFAULT_SYMBOLS,
    fec: str = "secded",
    brightness: float | None = None,
    sync_pattern: str = "on_off",
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
    ``sync_pattern`` is ``"on_off"`` (v1) or ``"stagger_pilot"`` (hue code v2
    phase 2: per-LED rotated cycles behind a pilot of palette colours, over a
    code book the kernel prunes so the pilot is unique — a wider data word and
    a longer cycle; the kernel does the rotation).
    """
    if led_count < 1:
        raise ValueError(f"led_count must be ≥ 1, got {led_count}")
    if fec not in ("none", "secded"):
        raise ValueError(f"unknown fec {fec!r}")
    if symbols not in (2, 4):
        raise ValueError(f"symbols must be 2 or 4, got {symbols}")
    if sync_pattern not in SYNC_PATTERNS:
        raise ValueError(f"unknown sync pattern {sync_pattern!r}")
    if brightness is not None and not 0.0 <= brightness <= 1.0:
        raise ValueError(f"brightness must be in [0, 1], got {brightness}")
    return CodeParams(
        ledCount=led_count,
        bits=pattern.expected_bits(led_count, fec, symbols, sync_pattern),
        encoding="hue",
        symbols=symbols,
        bitPeriodMs=bit_period_ms,
        syncPattern=sync_pattern,
        cycleFrames=pattern.cycle_frames(led_count, symbols, fec, sync_pattern),
        fec=fec,
        # None (= 1.0 on the wire) unless the phone servoed it down against
        # measured bloom/wash-out (exposure.ts planLedBrightness).
        brightness=brightness,
    )
