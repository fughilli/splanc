"""Hue-code cycle generation (design doc §8.1, hue-only revision).

Pure, hardware-free logic: turn a :class:`CodeParams` code-book into the
ordered list of per-frame **colors** the driver emits.

The cycle is::

    [ ALL_ON: white ][ ALL_OFF: green ]      sync delimiter (self-clocking)
    [ symbol frame 0 ] … [ symbol frame D-1 ] data, log2(symbols) bits each

Every LED is lit EVERY frame at constant brightness — the code is carried
entirely by COLOR. This is the only carrier: the old intensity ("gray")
blink code was removed because its dark frames made blobs disappear, which
broke cross-frame track association in the phone's CV pipeline (the tracker
had to coast blind through every 0-bit). White is the per-track color
reference (measures the camera's channel gains); green is the chroma sync
delimiter; the data palette depends on the alphabet size:

* ``symbols=2``: bit 1 → red, bit 0 → blue (maximum hue separation).
* ``symbols=4``: 2 bits/frame from the hue-adjacent path
  blue → magenta → red → yellow carrying binary-reflected-Gray bit pairs
  00 → 01 → 11 → 10, so the DOMINANT misread (confusing adjacent hues)
  flips exactly one bit — which SEC-DED corrects. Negotiated by the client
  when the measured chroma SNR is good; halves the data frames.

With ``fec="secded"`` (the default code-book) the codeword is the Gray data
word ``gray(i+1)`` wrapped in an extended-Hamming distance-4 code
(``ledmapper_protocol.fec``): a single decisively-misread BIT is corrected,
a double detected and rejected.

Codewords carry ``id + CODE_OFFSET``, never the raw id: the all-zero data
word is RESERVED-INVALID (see docs/decisions.md — without the offset, LED 0
is a decode magnet for blinking artifacts).
"""

from __future__ import annotations

import math
from typing import List, Tuple

from ledmapper_protocol import CodeParams
from ledmapper_protocol.fec import secded_encode, secded_total_bits

RGB = Tuple[int, int, int]

# The palette (255-scale RGB). Green is reserved for the sync delimiter;
# cyan is unused (it scores on the green sync axis and would confuse the
# chroma-sync census).
WHITE: RGB = (255, 255, 255)
GREEN: RGB = (0, 255, 0)
RED: RGB = (255, 0, 0)
BLUE: RGB = (0, 0, 255)
MAGENTA: RGB = (255, 0, 255)
YELLOW: RGB = (255, 255, 0)

# Symbol value -> color, per alphabet. symbols=4 assigns values along the
# hue-adjacent path blue(240°) → magenta(300°) → red(0°) → yellow(60°) in
# binary-reflected Gray order (00, 01, 11, 10): adjacent-hue confusion
# flips one bit. Mirrored by web/src/code/gray.ts; pinned by the golden.
SYMBOL_COLORS = {
    2: (BLUE, RED),
    4: (BLUE, MAGENTA, YELLOW, RED),
}


def gray(i: int) -> int:
    """Binary-reflected Gray code of ``i``."""
    return i ^ (i >> 1)


# Codewords are gray(id + CODE_OFFSET); the all-zero word is reserved-invalid.
CODE_OFFSET = 1


def data_bits(led_count: int) -> int:
    """Gray data-word width for ``led_count`` LEDs (codewords carry id+1)."""
    return max(1, math.ceil(math.log2(led_count + CODE_OFFSET)))


def codeword(led_id: int, code_params: CodeParams) -> int:
    """The TRANSMITTED codeword for ``led_id`` (see ``ledmapper_protocol.fec``
    for the SEC-DED layout). Bits are sent ``log2(symbols)`` per data frame,
    least-significant first. Mirrored by ``web/src/code/gray.ts``; pinned by
    ``web/tests/golden_secded16.json`` / ``golden_secded16_sym4.json``."""
    data = gray(led_id + CODE_OFFSET)
    if code_params.fec == "secded":
        return secded_encode(data, data_bits(code_params.ledCount))
    return data


def expected_bits(code_params: CodeParams) -> int:
    """Transmitted code-bit count implied by ledCount + fec (consistency)."""
    k = data_bits(code_params.ledCount)
    return secded_total_bits(k) if code_params.fec == "secded" else k


def bits_per_symbol(code_params: CodeParams) -> int:
    if code_params.symbols not in SYMBOL_COLORS:
        raise ValueError(f"unsupported symbol alphabet {code_params.symbols}")
    return 1 if code_params.symbols == 2 else 2


def data_frames(code_params: CodeParams) -> int:
    """Data-frame count: ceil(bits / bits-per-symbol) (last frame zero-padded
    in its high bit when bits is odd)."""
    return math.ceil(code_params.bits / bits_per_symbol(code_params))


def symbol_at(led_id: int, frame: int, code_params: CodeParams) -> int:
    """The symbol VALUE ``led_id`` transmits in data frame ``frame``."""
    bps = bits_per_symbol(code_params)
    return (codeword(led_id, code_params) >> (frame * bps)) & ((1 << bps) - 1)


# Cycle-frame indices of the sync delimiter; data frame d is cycle frame 2+d.
FRAME_ALL_ON = 0
FRAME_ALL_OFF = 1
DATA_FRAME_OFFSET = 2


def color_for_frame(led_id: int, frame_index: int, code_params: CodeParams) -> RGB:
    """The color ``led_id`` shows in cycle frame ``frame_index``."""
    if frame_index < 0 or frame_index >= code_params.cycleFrames:
        raise ValueError(f"frame_index {frame_index} outside cycle of {code_params.cycleFrames}")
    if frame_index == FRAME_ALL_ON:
        return WHITE
    if frame_index == FRAME_ALL_OFF:
        return GREEN
    value = symbol_at(led_id, frame_index - DATA_FRAME_OFFSET, code_params)
    return SYMBOL_COLORS[code_params.symbols][value]


def color_plan(code_params: CodeParams) -> List[List[RGB]]:
    """The ordered per-frame **color lists** for one full cycle.

    ``code_params.cycleFrames`` entries; entry ``f`` lists every LED's color
    in that frame (every LED is lit every frame — constant brightness).
    """
    n = code_params.ledCount
    frames = data_frames(code_params)
    if code_params.cycleFrames != 2 + frames:
        raise ValueError(
            f"cycleFrames={code_params.cycleFrames} but 2 + data frames = "
            f"{2 + frames}; code-book is inconsistent"
        )
    if code_params.bits != expected_bits(code_params):
        raise ValueError(
            f"bits={code_params.bits} but ledCount={n} with "
            f"fec={code_params.fec!r} implies {expected_bits(code_params)}; "
            "code-book is inconsistent"
        )
    return [
        [color_for_frame(i, f, code_params) for i in range(n)]
        for f in range(code_params.cycleFrames)
    ]


def default_code_params(
    led_count: int, bit_period_ms: float = 100.0, symbols: int = 2
) -> CodeParams:
    """Synthesize a default code-book from an LED count (CLI / dry-run only).

    During normal operation M2 computes the :class:`CodeParams` (see
    ``pi/server/server/codebook.py``, the authority) and hands it to
    ``start()``; this helper exists only so the standalone driver CLI can run
    without M2. Matches the M2 defaults: SEC-DED on, hue carrier.
    """
    bits = secded_total_bits(data_bits(led_count))
    bps = 1 if symbols == 2 else 2
    return CodeParams(
        ledCount=led_count,
        bits=bits,
        encoding="hue",
        symbols=symbols,
        bitPeriodMs=bit_period_ms,
        syncPattern="on_off",
        cycleFrames=2 + math.ceil(bits / bps),
        fec="secded",
    )


def decode_gray(value: int) -> int:
    """Inverse of :func:`gray` — recover the index from its Gray code.

    Useful for tests and for any decode-side sanity checks.
    """
    result = 0
    while value:
        result ^= value
        value >>= 1
    return result
