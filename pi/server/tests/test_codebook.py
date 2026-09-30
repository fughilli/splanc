"""Code-book derivation (design doc §7.6 + SEC-DED FEC extension)."""

import math

import pytest
from ledmapper_protocol.fec import secded_total_bits
from server.codebook import DEFAULT_BIT_PERIOD_MS, code_params_for, data_bits_for

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-11")


# Codewords carry id + 1 (the all-zero word is reserved-invalid, see
# led_driver.graycode.CODE_OFFSET), so the DATA word is
# ceil(log2(ledCount + 1)) bits; the default code-book wraps it in SEC-DED.
@pytest.mark.parametrize(
    "led_count,data_bits",
    [(1, 1), (2, 2), (3, 2), (63, 6), (64, 7), (1000, 10), (1023, 10), (1024, 11)],
)
def test_bits_covers_offset_code_space_plus_fec(led_count, data_bits):
    assert data_bits_for(led_count) == data_bits
    cp = code_params_for(led_count)
    assert cp.fec == "secded"
    assert cp.bits == secded_total_bits(data_bits)
    # cycle = 2-frame sync delimiter + transmitted code bits.
    assert cp.cycleFrames == 2 + cp.bits
    assert cp.ledCount == led_count


def test_fec_none_transmits_the_bare_data_word():
    cp = code_params_for(64, fec="none")
    assert cp.fec == "none"
    assert cp.bits == 7  # ceil(log2(65))
    assert cp.cycleFrames == 9


def test_unknown_fec_raises():
    with pytest.raises(ValueError):
        code_params_for(64, fec="turbo")


def test_fixed_fields_and_default_period():
    cp = code_params_for(1024)
    assert cp.encoding == "hue" and cp.symbols == 2
    assert cp.syncPattern == "on_off"
    assert cp.bitPeriodMs == DEFAULT_BIT_PERIOD_MS
    assert cp.cycleFrames >= 3  # schema floor


def test_bit_period_override():
    assert code_params_for(64, bit_period_ms=50.0).bitPeriodMs == 50.0


def test_invalid_led_count_raises():
    with pytest.raises(ValueError):
        code_params_for(0)


def test_matches_design_doc_example():
    # §7.6 worked example was ledCount=1024 → bits=10; the id+1 codeword
    # offset (docs/decisions.md, 2026-07-05) makes 1024 need 11 data bits,
    # and SEC-DED (2026-07-08) wraps those in 4 Hamming parity bits + 1
    # overall parity → 16 transmitted bits, 18-frame cycle.
    cp = code_params_for(1024)
    assert data_bits_for(1024) == 11 == math.ceil(math.log2(1024 + 1))
    assert (cp.bits, cp.cycleFrames) == (16, 18)
