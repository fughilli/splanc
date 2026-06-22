"""Code-book derivation (design doc §7.6)."""

import math

import pytest

from server.codebook import DEFAULT_BIT_PERIOD_MS, code_params_for


@pytest.mark.parametrize(
    "led_count,expected_bits",
    [(1, 1), (2, 1), (3, 2), (64, 6), (1000, 10), (1024, 10), (1025, 11)],
)
def test_bits_is_ceil_log2(led_count, expected_bits):
    cp = code_params_for(led_count)
    assert cp.bits == expected_bits
    # cycle = 2-frame sync delimiter + data bits.
    assert cp.cycleFrames == 2 + expected_bits
    assert cp.ledCount == led_count


def test_fixed_fields_and_default_period():
    cp = code_params_for(1024)
    assert cp.encoding == "gray"
    assert cp.syncPattern == "on_off"
    assert cp.bitPeriodMs == DEFAULT_BIT_PERIOD_MS
    assert cp.cycleFrames >= 3  # schema floor


def test_bit_period_override():
    assert code_params_for(64, bit_period_ms=50.0).bitPeriodMs == 50.0


def test_invalid_led_count_raises():
    with pytest.raises(ValueError):
        code_params_for(0)


def test_matches_design_doc_example():
    # §7.6 worked example: ledCount=1024 → bits=10, cycleFrames=12.
    cp = code_params_for(1024)
    assert (cp.bits, cp.cycleFrames) == (10, 12)
    assert cp.bits == math.ceil(math.log2(1024))
