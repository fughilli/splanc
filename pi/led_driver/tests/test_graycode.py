"""Gray-code cycle generation (design doc §8.1)."""

import pytest

from ledmapper_protocol.fec import secded_decode

from led_driver.graycode import (
    CODE_OFFSET,
    codeword,
    data_bits,
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


def test_gray_bit_uses_offset_codeword():
    # Codewords carry id + CODE_OFFSET, so the all-zero data word is reserved.
    for i in range(16):
        for b in range(5):
            assert gray_bit(i, b) == bool((gray(i + CODE_OFFSET) >> b) & 1)
    assert any(gray_bit(0, b) for b in range(2)), "LED 0 must NOT be all-dark"


def test_frame_plan_structure():
    # 64 LEDs: 7 data bits, SEC-DED wraps to 12 transmitted bits, cycle 14.
    cp = default_code_params(64)
    plan = frame_plan(cp)
    assert len(plan) == cp.cycleFrames == 14
    assert plan[0] == frozenset(range(64))  # ALL_ON
    assert plan[1] == frozenset()  # ALL_OFF
    # Bit frame b lights exactly the LEDs whose codeword has bit b set.
    for b in range(cp.bits):
        assert plan[2 + b] == frozenset(
            i for i in range(64) if (codeword(i, cp) >> b) & 1
        )
    # The reserved all-zero word: no LED is dark in every data frame.
    union = frozenset().union(*plan[2:])
    assert union == frozenset(range(64))


def test_frame_plan_reconstructs_every_led_id():
    # Reading each LED's on/off across the bit frames must recover its id via
    # SEC-DED decode + Gray decode (minus the codeword offset) — i.e. the
    # cycle uniquely identifies every LED.
    cp = default_code_params(256)
    plan = frame_plan(cp)
    bit_frames = plan[2:]
    k = data_bits(256)
    for i in range(256):
        code = 0
        for b, frame in enumerate(bit_frames):
            if i in frame:
                code |= 1 << b
        data, corrected = secded_decode(code, k)
        assert not corrected
        assert data != 0, f"LED {i} uses the reserved all-zero word"
        assert decode_gray(data) - CODE_OFFSET == i


def test_frame_plan_survives_any_single_bit_frame_error():
    # The reason SEC-DED exists: one decisively-misread window used to decode
    # to a valid WRONG id (Gray codebook distance 1). Now it corrects.
    cp = default_code_params(16)
    k = data_bits(16)
    for i in range(16):
        word = codeword(i, cp)
        for b in range(cp.bits):
            data, corrected = secded_decode(word ^ (1 << b), k)
            assert corrected and data is not None
            assert decode_gray(data) - CODE_OFFSET == i
            for b2 in range(b + 1, cp.bits):
                data2, _ = secded_decode(word ^ (1 << b) ^ (1 << b2), k)
                assert data2 is None  # double: detected, never miscorrected


def test_frame_plan_rejects_wrong_bits_for_fec():
    cp = default_code_params(64)
    bad = cp.model_copy(update={"bits": 7, "cycleFrames": 9})  # forgot the FEC
    with pytest.raises(ValueError):
        frame_plan(bad)


def test_frame_plan_rejects_inconsistent_codebook():
    cp = default_code_params(64)
    bad = cp.model_copy(update={"cycleFrames": 99})
    with pytest.raises(ValueError):
        frame_plan(bad)


# bits = SEC-DED total: k data bits + r Hamming parity + 1 overall parity.
@pytest.mark.parametrize(
    "n,bits", [(1, 4), (2, 6), (3, 6), (63, 11), (64, 12), (1024, 16)]
)
def test_default_code_params(n, bits):
    cp = default_code_params(n)
    assert cp.fec == "secded"
    assert cp.bits == bits
    assert cp.cycleFrames == 2 + bits
    assert cp.encoding == "gray" and cp.syncPattern == "on_off"
