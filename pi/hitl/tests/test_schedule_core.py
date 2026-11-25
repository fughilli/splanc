"""schedule_core: the serial-log parsers, the on-time bound, and the verdict over the
fire / hold / after_reset phases."""

from __future__ import annotations

import schedule_core as core

T0 = 1_700_000_000 - (1_700_000_000 % 86400)  # a UTC midnight
LOG = """\
10:00:01.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:01:00.012Z [sched] applied id=1 at_ms=61000 due_ms=61000 late_ms=0 unix_ms=1700042460012
10:01:00.013Z [sched] applied id=3 at_ms=61000 due_ms=61000 late_ms=0 unix_ms=1700042460012
10:01:02.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:01:58.000Z [sched] skip id=4 why=1
10:02:05.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:02:30.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
"""
PHASES = {
    "fire": (T0 + 36000, T0 + 36065),
    "hold": (T0 + 36065, T0 + 36126),
    "after_reset": (T0 + 36140, T0 + 36151),
}


def good() -> core.Report:
    rep = core.Report(clock_err_ms=12.0, skipped_count=1, last_skip="SCHEDULE_SKIP_LIVE")
    rep.target["fire"] = 1_700_042_460_000.0
    rep.fired["fire"] = 1_700_042_460_012.0
    rep.fired_count["fire"] = 3
    rep.after_reset_effect = "__sched_night"
    rep.applied_lines = core.applied(LOG)
    rep.per_phase = core.frames(LOG, PHASES)
    return rep


def test_parsers():
    a = core.applied(LOG)
    assert [x.rule for x in a] == [1, 3]
    assert a[0].late_ms == 0 and a[0].unix_ms == 1_700_042_460_012
    assert core.skipped(LOG) == [(4, 1)]


def test_on_time_bounds():
    assert core.on_time(1012.0, 1000.0, 5.0)[0]
    assert core.on_time(990.0, 1000.0, 5.0)[0]  # within the clocks' error
    assert not core.on_time(940.0, 1000.0, 5.0)[0]  # a minute-boundary rule a frame early
    assert not core.on_time(1100.0, 1000.0, 5.0)[0]  # over a frame late


def test_pass():
    assert core.verdict(good()) == ("PASS", [])


def test_fail_reasons():
    rep = good()
    rep.fired["fire"] += 200.0
    rep.skipped_count = 0
    rep.after_reset_effect = "__sched_day"
    rep.applied_lines[0].late_ms = 120
    verdict, why = core.verdict(rep)
    assert verdict == "FAIL"
    text = " ".join(why)
    for k in ("fire:", "hold:", "after_reset:", "applied late"):
        assert k in text, why


def test_no_render_is_a_fail():
    rep = good()
    rep.per_phase = core.frames("", PHASES)
    assert core.verdict(rep)[0] == "FAIL"
