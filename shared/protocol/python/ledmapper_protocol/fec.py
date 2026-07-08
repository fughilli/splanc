"""Extended-Hamming SEC-DED codewords (design doc §8.1, FEC extension).

The temporal blink code originally transmitted the raw ``gray(id+1)`` data
word. That codebook is DENSE — minimum Hamming distance 1 — so a single
decisively-wrong bit window (chroma misread, brief track contamination)
decodes to a *valid wrong* LED id whenever the flipped word lands in range,
which poisons the wrong LED's observation bundle in the solver.

This module wraps the data word in an extended Hamming code (distance 4),
used as SEC-DED: single-window errors are CORRECTED, double-window errors are
DETECTED and rejected (never miscorrected — a d=4 guarantee). Triple errors
can alias to a correctable pattern; at that point the track was garbage
anyway and the geometric outlier rejection downstream is the backstop.

Layout (canonical across languages — ``web/src/code/fec.ts`` mirrors this and
``web/tests/golden_secded16.json`` pins the two):

- Data word: ``k`` bits (bit 0 = LSB).
- Inner Hamming code of length ``k + r``, 1-indexed positions ``1..k+r``,
  with ``r`` the smallest integer satisfying ``2**r >= k + r + 1``.
  Power-of-two positions hold (even) parity; the remaining positions hold the
  data bits in increasing order.
- One overall (even) parity bit over the whole inner word extends the
  distance to 4.
- Transmission order: codeword bit ``j`` (``j`` in ``0..k+r-1``) is inner
  position ``j+1``; the overall parity bit is transmitted LAST (bit ``k+r``).

The Gray mapping of the data word is kept: it costs nothing, and the
reserved-invalid all-zero data word (id-offset convention) still applies
before encoding.
"""

from __future__ import annotations

from typing import Optional, Tuple


def secded_parity_bits(k: int) -> int:
    """Number of Hamming parity bits ``r`` for ``k`` data bits (excluding the
    overall parity bit): the smallest ``r`` with ``2**r >= k + r + 1``."""
    if k < 1:
        raise ValueError(f"k must be >= 1, got {k}")
    r = 1
    while (1 << r) < k + r + 1:
        r += 1
    return r


def secded_total_bits(k: int) -> int:
    """Total transmitted code bits for ``k`` data bits: k + r + 1 (the +1 is
    the overall parity bit that extends the distance from 3 to 4)."""
    return k + secded_parity_bits(k) + 1


def _is_pow2(x: int) -> bool:
    return x & (x - 1) == 0


def secded_encode(data: int, k: int) -> int:
    """Encode a ``k``-bit data word into the transmitted codeword.

    Bit ``j`` of the result is the value of transmission frame ``j``
    (see module docstring for the layout).
    """
    if data < 0 or data >> k:
        raise ValueError(f"data word {data:#x} does not fit in {k} bits")
    r = secded_parity_bits(k)
    m_inner = k + r
    # Place data bits at non-power-of-two positions 1..m_inner.
    word = 0  # bit (pos-1) of `word` = inner position `pos`
    bit = 0
    for pos in range(1, m_inner + 1):
        if _is_pow2(pos):
            continue
        if (data >> bit) & 1:
            word |= 1 << (pos - 1)
        bit += 1
    # Even parity at each power-of-two position over the positions it covers.
    for p_log in range(r):
        p = 1 << p_log
        parity = 0
        for pos in range(1, m_inner + 1):
            if pos & p and (word >> (pos - 1)) & 1:
                parity ^= 1
        if parity:
            word |= 1 << (p - 1)
    # Overall even parity over the inner word, transmitted last.
    overall = bin(word).count("1") & 1
    if overall:
        word |= 1 << m_inner
    return word


def secded_decode(word: int, k: int) -> Tuple[Optional[int], bool]:
    """Decode a received codeword.

    Returns ``(data, corrected)``: the ``k``-bit data word (or ``None`` when a
    double error is detected — uncorrectable by design) and whether a
    single-bit correction was applied.
    """
    r = secded_parity_bits(k)
    m_inner = k + r
    if word < 0 or word >> (m_inner + 1):
        raise ValueError(f"codeword {word:#x} does not fit in {m_inner + 1} bits")
    syndrome = 0
    for pos in range(1, m_inner + 1):
        if (word >> (pos - 1)) & 1:
            syndrome ^= pos
    overall_ok = bin(word).count("1") & 1 == 0
    corrected = False
    if syndrome == 0:
        if not overall_ok:
            # The overall parity bit itself flipped; inner word is intact.
            corrected = True
    elif overall_ok:
        # Nonzero syndrome but overall parity consistent: DOUBLE error.
        return None, False
    else:
        # Single error at inner position `syndrome` — correct it. A syndrome
        # pointing outside the word is itself a multi-error signature.
        if syndrome > m_inner:
            return None, False
        word ^= 1 << (syndrome - 1)
        corrected = True
    # Extract data bits from non-power-of-two positions.
    data = 0
    bit = 0
    for pos in range(1, m_inner + 1):
        if _is_pow2(pos):
            continue
        if (word >> (pos - 1)) & 1:
            data |= 1 << bit
        bit += 1
    return data, corrected
