"""Unit tests for the lamp-power HITL verdict (pi/hitl/harness/power_core.py)."""

import power_core as core


def test_unreached_is_skip():
    r = core.Run()
    r.check("power", "x", False)
    assert core.verdict(r) == core.SKIP


def test_any_failed_check_fails():
    r = core.Run(reached=True)
    r.check("power", "a", True)
    r.check("trigger", "b", False, "no push")
    assert core.verdict(r) == core.FAIL
    assert core.failures(r) == ["trigger/b: no push"]
    assert "power=1/1" in core.result_line(r) and "trigger=0/1" in core.result_line(r)


def test_pass_needs_checks():
    r = core.Run(reached=True)
    assert core.verdict(r) == core.SKIP
    r.check("setup", "a", True)
    assert core.verdict(r) == core.PASS


def test_state_helpers_default_proto3_zeros():
    assert core.phase({}) == core.OFF
    assert not core.is_on({})
    assert core.source({"source": 2}) == core.SRC_TRIGGER


def test_fps_kept():
    assert core.fps_kept(60, 60)
    assert core.fps_kept(60, 55)
    assert not core.fps_kept(60, 40)
    assert not core.fps_kept(None, 60)


def test_settle_time():
    assert core.settle_time_ok(1.6, 1500)
    assert not core.settle_time_ok(0.3, 1500), "a cut is not a 1.5 s transition"
    assert not core.settle_time_ok(4.0, 1500)
