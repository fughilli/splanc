"""Gray-code cycle generation (design doc §8.1, + SEC-DED FEC extension).

Pure, hardware-free logic: turn a :class:`CodeParams` code-book into the ordered
list of *frames* the driver emits, where each frame is the set of LED indices
that should be lit for that frame.

The cycle is::

    [ ALL_ON ][ ALL_OFF ]               sync delimiter (self-clocking)
    [ bit 0  ][ bit 1 ] … [ bit B-1 ]   LED i lit iff bit b of codeword(i) is set

With ``fec="secded"`` (the default code-book since 2026-07-08) the codeword is
the Gray data word ``gray(i+1)`` wrapped in an extended-Hamming distance-4
code (``ledmapper_protocol.fec``): a single decisively-misread bit window is
CORRECTED by the decoder, a double is DETECTED and rejected. The raw Gray
codebook has distance 1, so without FEC one wrong window decodes to a valid
WRONG id. ``fec="none"`` transmits the bare data word (legacy).

Gray coding (``gray(i) = i ^ (i >> 1)``) means a single misread bit mislabels an
LED to an *adjacent* index rather than a random one (fec="none" only; under
SEC-DED it is simply a cheap bijection that keeps the offset convention).

Codewords carry ``id + CODE_OFFSET``, never the raw id: the all-zero data word
(dark in every data frame) is thereby RESERVED-INVALID. Without the offset,
LED 0's word is all-dark — exactly what any blinking artifact (a reflection, or
exposure pumping in a dark room) looks like, so id 0 becomes a decode magnet
(observed live 2026-07-03/05; see docs/decisions.md).
"""

from __future__ import annotations

import math
from typing import List

from ledmapper_protocol import CodeParams
from ledmapper_protocol.fec import secded_encode, secded_total_bits


def gray(i: int) -> int:
    """Binary-reflected Gray code of ``i``."""
    return i ^ (i >> 1)


# Codewords are gray(id + CODE_OFFSET); the all-zero word is reserved-invalid.
CODE_OFFSET = 1


def gray_bit(led_id: int, bit: int) -> bool:
    """True iff ``bit`` of the raw data word ``gray(led_id + CODE_OFFSET)`` is
    set (LED lit in that bit frame — fec="none" code-books only)."""
    return (gray(led_id + CODE_OFFSET) >> bit) & 1 == 1


def data_bits(led_count: int) -> int:
    """Gray data-word width for ``led_count`` LEDs (codewords carry id+1)."""
    return max(1, math.ceil(math.log2(led_count + CODE_OFFSET)))


def codeword(led_id: int, code_params: CodeParams) -> int:
    """The TRANSMITTED codeword for ``led_id``: bit ``b`` is the LED's state
    in bit frame ``b`` (see ``ledmapper_protocol.fec`` for the SEC-DED
    layout). Mirrored by ``web/src/code/gray.ts`` / ``fec.ts``; pinned by
    ``web/tests/golden_gray16.json`` / ``golden_secded16.json``."""
    data = gray(led_id + CODE_OFFSET)
    if code_params.fec == "secded":
        return secded_encode(data, data_bits(code_params.ledCount))
    return data


def expected_bits(code_params: CodeParams) -> int:
    """Transmitted bit-frame count implied by ledCount + fec (consistency)."""
    k = data_bits(code_params.ledCount)
    return secded_total_bits(k) if code_params.fec == "secded" else k


# Sentinels for the two sync frames (kept distinct from a bit index).
FRAME_ALL_ON = "all_on"
FRAME_ALL_OFF = "all_off"


def frame_plan(code_params: CodeParams) -> List[frozenset]:
    """Return the ordered per-frame **on-sets** for one full cycle.

    The result has ``code_params.cycleFrames`` entries: the all-on frame (every
    LED), the all-off frame (empty), then one frame per transmitted code bit
    (data + FEC parity). Each entry is a ``frozenset`` of the lit LED ids.
    """
    n = code_params.ledCount
    bits = code_params.bits
    if code_params.cycleFrames != 2 + bits:
        raise ValueError(
            f"cycleFrames={code_params.cycleFrames} but 2 + bits = {2 + bits}; "
            "code-book is inconsistent"
        )
    if bits != expected_bits(code_params):
        raise ValueError(
            f"bits={bits} but ledCount={n} with fec={code_params.fec!r} "
            f"implies {expected_bits(code_params)}; code-book is inconsistent"
        )
    words = [codeword(i, code_params) for i in range(n)]
    plan: List[frozenset] = [frozenset(range(n)), frozenset()]
    for bit in range(bits):
        plan.append(frozenset(i for i in range(n) if (words[i] >> bit) & 1))
    return plan


def default_code_params(led_count: int, bit_period_ms: float = 100.0) -> CodeParams:
    """Synthesize a default code-book from an LED count (CLI / dry-run only).

    During normal operation M2 computes the :class:`CodeParams` (see
    ``pi/server/server/codebook.py``, the authority) and hands it to ``start()``;
    this helper exists only so the standalone driver CLI can run without M2.
    Matches the M2 default: SEC-DED on.
    """
    bits = secded_total_bits(data_bits(led_count))
    return CodeParams(
        ledCount=led_count,
        bits=bits,
        encoding="gray",
        bitPeriodMs=bit_period_ms,
        syncPattern="on_off",
        cycleFrames=2 + bits,
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
