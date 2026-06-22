"""Gray-code cycle generation (design doc §8.1)."""

import pytest

from led_driver.graycode import (
    decode_gray,
    default_code_params,
    frame_plan,
    gray,
    gray_bit,
)


def test_gray_sequence_first_values():
    # Canonical binary-reflected Gray code.
    assert [gray(i) for i in range(8)] == [0, 1, 3, 2, 6, 7, 5, 4]


def test_gray_is_invertible():
    for i in range(1024):
        assert decode_gray(gray(i)) == i


def test_adjacent_indices_differ_by_one_bit():
    for i in range(1, 1024):
        diff = gray(i) ^ gray(i - 1)
        assert diff and (diff & (diff - 1)) == 0  # exactly one bit set


def test_gray_bit_matches_gray():
    for i in range(16):
        for b in range(4):
            assert gray_bit(i, b) == bool((gray(i) >> b) & 1)


def test_frame_plan_structure():
    cp = default_code_params(64)  # bits=6, cycleFrames=8
    plan = frame_plan(cp)
    assert len(plan) == cp.cycleFrames == 8
    assert plan[0] == frozenset(range(64))  # ALL_ON
    assert plan[1] == frozenset()  # ALL_OFF
    # Bit frame b lights exactly the LEDs whose gray code has bit b set.
    for b in range(cp.bits):
        assert plan[2 + b] == frozenset(i for i in range(64) if gray_bit(i, b))


def test_frame_plan_reconstructs_every_led_id():
    # Reading each LED's on/off across the bit frames must recover its id via
    # Gray decode — i.e. the cycle uniquely identifies every LED.
    cp = default_code_params(256)
    plan = frame_plan(cp)
    bit_frames = plan[2:]
    for i in range(256):
        code = 0
        for b, frame in enumerate(bit_frames):
            if i in frame:
                code |= 1 << b
        assert decode_gray(code) == i


def test_frame_plan_rejects_inconsistent_codebook():
    cp = default_code_params(64)
    bad = cp.model_copy(update={"cycleFrames": 99})
    with pytest.raises(ValueError):
        frame_plan(bad)


@pytest.mark.parametrize("n,bits", [(1, 1), (2, 1), (3, 2), (64, 6), (1024, 10)])
def test_default_code_params(n, bits):
    cp = default_code_params(n)
    assert cp.bits == bits
    assert cp.cycleFrames == 2 + bits
    assert cp.encoding == "gray" and cp.syncPattern == "on_off"
