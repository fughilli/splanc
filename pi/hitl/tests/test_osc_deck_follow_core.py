"""The OSC deck-follow gate's pure logic (harness/osc_deck_follow_core.py, #402)."""

import struct

import osc_deck_follow_core as core


def test_osc_message_encoding():
    m = core.osc_message("/plane", [0.1, -0.2, 0.3, -0.4])
    # Address and type tags NUL-padded to 4 bytes, then big-endian float32s.
    assert m[:8] == b"/plane\0\0"
    assert m[8:16] == b",ffff\0\0\0"
    assert struct.unpack(">4f", m[16:]) == struct.unpack(
        ">4f", struct.pack(">4f", 0.1, -0.2, 0.3, -0.4)
    )
    assert core.osc_message("/k", [1.0]) == b"/k\0\0,f\0\0" + struct.pack(">f", 1.0)


def _c(step, got, want, baseline=False, deck=0, slot=3):
    return core.Check(step, deck, slot, want, got, baseline)


def test_check_tolerance_and_width():
    assert _c("x", [0.25000001], [0.25]).ok
    assert not _c("x", [0.26], [0.25]).ok
    assert not _c("x", None, [0.25]).ok
    assert not _c("x", [0.0, 0.5], [0.0, 0.5, 0.0]).ok


def test_verdict_pass():
    checks = [_c("base", [0.25], [0.25], baseline=True), _c("b", [0.75], [0.75], deck=1, slot=4)]
    assert core.verdict(checks) == (core.PASS, [])


def test_verdict_fail_on_deck_follow_miss():
    # The #402 bug: /k mid-fade stays on deck A, deck B's k never moves.
    checks = [
        _c("base", [0.25], [0.25], baseline=True),
        _c("mid-fade to B /k", [0.5], [0.75], deck=1, slot=4),
        _c("A.k untouched", [0.75], [0.25]),
    ]
    status, reasons = core.verdict(checks)
    assert status == core.FAIL
    assert len(reasons) == 2 and "deck B slot 4" in reasons[0]
    line = core.result_line("c6-x", status, checks, reasons)
    assert line.startswith("RESULT osc_deck_follow verdict=FAIL unit=c6-x checks=1/3")


def test_verdict_skip_without_baseline():
    # OSC never reached the DUT (bench): later misses are not a firmware verdict.
    checks = [_c("base", [0.5], [0.25], baseline=True), _c("b", None, [0.75], deck=1)]
    assert core.verdict(checks)[0] == core.SKIP
    assert core.verdict([])[0] == core.SKIP


def test_joined_reassembles_chunks():
    # get_effect_uniforms reports a mat4 as 4-float chunks at slot, slot+4, ...
    cur = {0: [0.9, 0.8, 0.7], 3: [0.25], 8: [0.0] * 4, 12: [1.0] * 4, 16: [2.0] * 4, 20: [3.0] * 4}
    assert core.joined(cur, 0, 4) == [0.9, 0.8, 0.7, 0.25]
    assert core.joined(cur, 8, 16) == [0.0] * 4 + [1.0] * 4 + [2.0] * 4 + [3.0] * 4
    assert core.joined(cur, 3, 1) == [0.25]
    assert core.joined(cur, 4, 1) is None
    assert core.joined({8: [0.0] * 4}, 8, 16) == [0.0] * 4
