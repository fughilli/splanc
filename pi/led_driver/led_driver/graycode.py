"""Gray-code cycle generation (design doc §8.1).

Pure, hardware-free logic: turn a :class:`CodeParams` code-book into the ordered
list of *frames* the driver emits, where each frame is the set of LED indices
that should be lit for that frame.

The cycle is::

    [ ALL_ON ][ ALL_OFF ]            sync delimiter (self-clocking)
    [ bit 0  ][ bit 1 ] … [ bit B-1 ]   LED i lit iff bit b of gray(i+1) is set

Gray coding (``gray(i) = i ^ (i >> 1)``) means a single misread bit mislabels an
LED to an *adjacent* index rather than a random one.

Codewords carry ``id + CODE_OFFSET``, never the raw id: the all-zero data word
(dark in every data frame) is thereby RESERVED-INVALID. Without the offset,
LED 0's word is all-dark — exactly what any blinking artifact (a reflection, or
exposure pumping in a dark room) looks like, so id 0 becomes a decode magnet
(observed live 2026-07-03/05; see docs/decisions.md).
"""

from __future__ import annotations

from typing import List

from ledmapper_protocol import CodeParams


def gray(i: int) -> int:
    """Binary-reflected Gray code of ``i``."""
    return i ^ (i >> 1)


# Codewords are gray(id + CODE_OFFSET); the all-zero word is reserved-invalid.
CODE_OFFSET = 1


def gray_bit(led_id: int, bit: int) -> bool:
    """True iff ``bit`` of the codeword ``gray(led_id + CODE_OFFSET)`` is set
    (LED lit in that bit frame)."""
    return (gray(led_id + CODE_OFFSET) >> bit) & 1 == 1


# Sentinels for the two sync frames (kept distinct from a bit index).
FRAME_ALL_ON = "all_on"
FRAME_ALL_OFF = "all_off"


def frame_plan(code_params: CodeParams) -> List[frozenset]:
    """Return the ordered per-frame **on-sets** for one full cycle.

    The result has ``code_params.cycleFrames`` entries: the all-on frame (every
    LED), the all-off frame (empty), then one frame per data bit. Each entry is a
    ``frozenset`` of the LED ids lit in that frame.
    """
    n = code_params.ledCount
    bits = code_params.bits
    expected = 2 + bits
    if code_params.cycleFrames != expected:
        raise ValueError(
            f"cycleFrames={code_params.cycleFrames} but 2 + bits = {expected}; "
            "code-book is inconsistent"
        )
    all_ids = range(n)
    plan: List[frozenset] = [frozenset(all_ids), frozenset()]
    for bit in range(bits):
        plan.append(frozenset(i for i in all_ids if gray_bit(i, bit)))
    return plan


def default_code_params(led_count: int, bit_period_ms: float = 100.0) -> CodeParams:
    """Synthesize a default code-book from an LED count (CLI / dry-run only).

    During normal operation M2 computes the :class:`CodeParams` (see
    ``pi/server/server/codebook.py`, the authority) and hands it to ``start()``;
    this helper exists only so the standalone driver CLI can run without M2.
    """
    import math

    # +CODE_OFFSET: the codeword space is [1, ledCount], not [0, ledCount-1].
    bits = max(1, math.ceil(math.log2(led_count + CODE_OFFSET)))
    return CodeParams(
        ledCount=led_count,
        bits=bits,
        encoding="gray",
        bitPeriodMs=bit_period_ms,
        syncPattern="on_off",
        cycleFrames=2 + bits,
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
