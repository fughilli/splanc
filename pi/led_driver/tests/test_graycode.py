"""Hue-code cycle generation (design doc §8.1, hue-only revision)."""

import pytest
from led_driver.graycode import (
    BLUE,
    CODE_OFFSET,
    GREEN,
    MAGENTA,
    RED,
    SYMBOL_COLORS,
    WHITE,
    YELLOW,
    codeword,
    color_plan,
    data_bits,
    data_frames,
    decode_gray,
    default_code_params,
    gray,
    symbol_at,
)
from ledmapper_protocol.fec import secded_decode

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-11", "PR-34")


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


def test_symbols4_palette_is_gray_ordered_along_the_hue_path():
    # The hue-adjacent path blue → magenta → red → yellow must carry
    # binary-reflected-Gray bit pairs 00, 01, 11, 10: confusing two
    # NEIGHBORING hues then flips exactly one bit (which SEC-DED corrects).
    path = [BLUE, MAGENTA, RED, YELLOW]
    value_of = {c: v for v, c in enumerate(SYMBOL_COLORS[4])}
    carried = [value_of[c] for c in path]
    assert carried == [gray(k) for k in range(4)]  # 0, 1, 3, 2
    for a, b in zip(carried, carried[1:]):
        diff = a ^ b
        assert diff and (diff & (diff - 1)) == 0


def test_color_plan_structure_sym2():
    # 64 LEDs: 7 data bits, SEC-DED wraps to 12 transmitted bits; at 1
    # bit/frame that is 12 data frames, cycle 14.
    cp = default_code_params(64, symbols=2)
    plan = color_plan(cp)
    assert len(plan) == cp.cycleFrames == 14
    assert all(c == WHITE for c in plan[0])  # ALL_ON reference
    assert all(c == GREEN for c in plan[1])  # ALL_OFF chroma sync
    # Data frame f shows red for a 1-bit, blue for a 0-bit of the codeword.
    for f in range(cp.bits):
        for i in range(64):
            want = RED if (codeword(i, cp) >> f) & 1 else BLUE
            assert plan[2 + f][i] == want
    # The reserved all-zero word: every LED shows red somewhere.
    for i in range(64):
        assert any(plan[2 + f][i] == RED for f in range(cp.bits))


def test_color_plan_structure_sym4():
    # Same 12 transmitted bits at 2 bits/frame: 6 data frames, cycle 8.
    cp = default_code_params(64, symbols=4)
    plan = color_plan(cp)
    assert len(plan) == cp.cycleFrames == 8
    assert data_frames(cp) == 6
    for f in range(6):
        for i in range(64):
            v = (codeword(i, cp) >> (2 * f)) & 3
            assert plan[2 + f][i] == SYMBOL_COLORS[4][v]
            assert symbol_at(i, f, cp) == v


def test_color_plan_reconstructs_every_led_id():
    # Reading each LED's symbols across the data frames must recover its id
    # via SEC-DED decode + Gray decode (minus the codeword offset) — i.e. the
    # cycle uniquely identifies every LED, in both alphabets.
    for symbols in (2, 4):
        cp = default_code_params(256, symbols=symbols)
        bps = 1 if symbols == 2 else 2
        k = data_bits(256)
        for i in range(256):
            code = 0
            for f in range(data_frames(cp)):
                code |= symbol_at(i, f, cp) << (f * bps)
            data, corrected = secded_decode(code, k)
            assert not corrected
            assert data != 0, f"LED {i} uses the reserved all-zero word"
            assert decode_gray(data) - CODE_OFFSET == i


def test_code_survives_any_single_bit_error():
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


def test_adjacent_hue_confusion_is_a_single_bit_error():
    # End-to-end property of the Gray-ordered palette: misreading a symbol
    # as its NEAREST hue neighbor is a 1-bit error, so SEC-DED recovers the
    # true id from one such misread per cycle.
    cp = default_code_params(16, symbols=4)
    k = data_bits(16)
    path = [BLUE, MAGENTA, RED, YELLOW]
    value_of = {c: v for v, c in enumerate(SYMBOL_COLORS[4])}
    for i in range(16):
        for f in range(data_frames(cp)):
            true_color = SYMBOL_COLORS[4][symbol_at(i, f, cp)]
            pos = path.index(true_color)
            for neighbor in (pos - 1, pos + 1):
                if not 0 <= neighbor < len(path):
                    continue
                wrong = value_of[path[neighbor]]
                code = 0
                for f2 in range(data_frames(cp)):
                    v = wrong if f2 == f else symbol_at(i, f2, cp)
                    code |= v << (2 * f2)
                # Mask to the transmitted bits (the padded high bit is 0).
                code &= (1 << cp.bits) - 1
                data, _corrected = secded_decode(code, k)
                assert data is not None
                assert decode_gray(data) - CODE_OFFSET == i


def test_color_plan_rejects_wrong_bits_for_fec():
    cp = default_code_params(64)
    bad = cp.model_copy(update={"bits": 7, "cycleFrames": 9})  # forgot the FEC
    with pytest.raises(ValueError):
        color_plan(bad)


def test_color_plan_rejects_inconsistent_codebook():
    cp = default_code_params(64)
    bad = cp.model_copy(update={"cycleFrames": 99})
    with pytest.raises(ValueError):
        color_plan(bad)


# bits = SEC-DED total: k data bits + r Hamming parity + 1 overall parity.
@pytest.mark.parametrize("n,bits", [(1, 4), (2, 6), (3, 6), (63, 11), (64, 12), (1024, 16)])
def test_default_code_params(n, bits):
    cp = default_code_params(n)
    assert cp.fec == "secded"
    assert cp.bits == bits
    assert cp.cycleFrames == 2 + bits  # symbols=2: one bit per frame
    assert cp.encoding == "hue" and cp.symbols == 2 and cp.syncPattern == "on_off"


@pytest.mark.parametrize("n,bits,frames", [(1, 4, 2), (64, 12, 6), (1024, 16, 8)])
def test_default_code_params_sym4(n, bits, frames):
    cp = default_code_params(n, symbols=4)
    assert cp.bits == bits and cp.cycleFrames == 2 + frames
