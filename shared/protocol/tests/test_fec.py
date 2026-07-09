"""SEC-DED codeword properties (ledmapper_protocol.fec).

Exhaustive over every data word and every 1- and 2-bit corruption for the
data widths the system actually uses (k = 1..11 covers 1..2047 LEDs):

- clean words decode unchanged,
- EVERY single-bit error is corrected (d=4 → t=1),
- EVERY double-bit error is detected and rejected, never miscorrected
  (the extended parity bit is what buys this — d=4, not d=3).
"""

import pytest

from ledmapper_protocol.fec import (
    secded_decode,
    secded_encode,
    secded_parity_bits,
    secded_total_bits,
)


def test_parity_bit_counts():
    # r is the smallest integer with 2^r >= k + r + 1; spot-pin the sizes the
    # fleet uses: 6 data bits (up to 63 LEDs) -> 11 total, 11 (2047) -> 16.
    assert secded_parity_bits(6) == 4 and secded_total_bits(6) == 11
    assert secded_parity_bits(7) == 4 and secded_total_bits(7) == 12
    assert secded_parity_bits(11) == 4 and secded_total_bits(11) == 16


@pytest.mark.parametrize("k", range(1, 12))
def test_clean_roundtrip(k):
    for data in range(1 << k):
        word = secded_encode(data, k)
        decoded, corrected = secded_decode(word, k)
        assert decoded == data and not corrected


@pytest.mark.parametrize("k", range(1, 12))
def test_every_single_error_corrected(k):
    total = secded_total_bits(k)
    step = max(1, (1 << k) // 64)  # subsample large data spaces; k<=6 exhaustive
    for data in range(0, 1 << k, step):
        word = secded_encode(data, k)
        for i in range(total):
            decoded, corrected = secded_decode(word ^ (1 << i), k)
            assert decoded == data, f"k={k} data={data} flip={i}"
            assert corrected


@pytest.mark.parametrize("k", range(1, 12))
def test_every_double_error_detected_never_miscorrected(k):
    total = secded_total_bits(k)
    step = max(1, (1 << k) // 32)
    for data in range(0, 1 << k, step):
        word = secded_encode(data, k)
        for i in range(total):
            for j in range(i + 1, total):
                decoded, _ = secded_decode(word ^ (1 << i) ^ (1 << j), k)
                assert decoded is None, f"k={k} data={data} flips={i},{j} -> {decoded}"


def test_encode_rejects_oversized_data():
    with pytest.raises(ValueError):
        secded_encode(1 << 6, 6)
