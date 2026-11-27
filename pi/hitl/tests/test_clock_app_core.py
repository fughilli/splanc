"""clock_app_core: the min-RTT sync, a reading against the harness's UTC window, and the
verdict over readings, the soft-reset carry-over and the per-phase frame data."""

from __future__ import annotations

import clock_app_core as core

T0 = 1_700_000_000 - (1_700_000_000 % 86400)  # a UTC midnight
LOG = """\
10:00:01.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:00:02.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:00:12.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:00:30.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
"""
PHASES = {
    "sync": (T0 + 36000, T0 + 36003),
    "read": (T0 + 36010, T0 + 36015),
    "after_restart": (T0 + 36029, T0 + 36032),
}


def rd(phase, unix, sent=1000.0, recv=1010.0, err=25.0, valid=True, src="CLOCK_SOURCE_PUSH"):
    return core.Reading(phase, sent, recv, valid, unix, err, src)


def good_report() -> core.Report:
    rep = core.Report(set_result="CLOCK_SET_RESULT_ACCEPTED", restart_source="CLOCK_SOURCE_CARRY")
    rep.readings = [
        rd("read", 1005.0),
        rd("after_restart", 1500.0, err=1200.0, src="CLOCK_SOURCE_CARRY"),
    ]
    rep.per_phase = core.frames(LOG, PHASES)
    return rep


def test_best_sync_keeps_the_min_rtt_round():
    # Device 1000 ms ahead; the second round is the quick one.
    off, rtt = core.best_sync([(0, 1020, 1021, 40), (100, 1105, 1106, 111), (200, 1230, 1231, 260)])
    assert rtt == 10
    assert off == 1000.0


def test_reading_window():
    assert rd("read", 1005.0).delta_ms() == 0.0
    assert rd("read", 990.0).delta_ms() == -10.0
    assert rd("read", 1030.0).delta_ms() == 20.0
    assert core.reading_ok(rd("read", 1030.0))[0]  # 20 ms out, ±25 + 10 allowed
    ok, why = core.reading_ok(rd("read", 1100.0))
    assert not ok and "outside" in why
    assert not core.reading_ok(rd("read", 0.0, valid=False))[0]


def test_pass():
    v, why = core.verdict(good_report())
    assert v == "PASS", why


def test_late_frame_in_a_gated_phase_fails():
    rep = good_report()
    log = LOG + "10:00:12.500Z [late] n=2 max=31000 ago_ms=300\n"
    rep.per_phase = core.frames(log, PHASES)
    v, why = core.verdict(rep)
    assert v == "FAIL"
    assert any("read: 2 late frame" in w for w in why)


def test_render_must_run():
    rep = good_report()
    rep.per_phase = core.frames("", PHASES)
    v, why = core.verdict(rep)
    assert v == "FAIL" and any("render not running" in w for w in why)


def test_lost_clock_after_restart_fails():
    rep = good_report()
    rep.restart_source = "CLOCK_SOURCE_NONE"
    rep.readings[1] = rd("after_restart", 0.0, err=0.0, valid=False, src="CLOCK_SOURCE_NONE")
    v, why = core.verdict(rep)
    assert v == "FAIL"
    assert any("not valid" in w for w in why)
    assert any("carry-over" in w for w in why)


def test_carry_too_far_off_fails_even_within_its_error():
    rep = good_report()
    rep.readings[1] = rd("after_restart", 1010.0 + 1600.0, err=2000.0, src="CLOCK_SOURCE_CARRY")
    v, why = core.verdict(rep)
    assert v == "FAIL" and any("> 1500" in w for w in why)


def test_refused_push_fails():
    rep = good_report()
    rep.set_result = "CLOCK_SET_RESULT_NOT_BETTER"
    assert core.verdict(rep)[0] == "FAIL"
