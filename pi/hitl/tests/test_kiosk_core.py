"""The kiosk-mode HITL gate's pure verdict (harness/kiosk_core.py)."""

import kiosk_core as core


def test_refused_is_exactly_kiosk_locked():
    assert core.refused({"type": "error", "code": "kiosk_locked", "message": "x"})
    assert not core.refused({"type": "error", "code": "unsupported"})
    assert not core.refused({"type": "welcome"})
    assert not core.refused(None)


def test_uniform_reads_chunks():
    r = {"current": [{"slot": 0, "value": [1.0, 0.0, 0.0]}, {"slot": 3, "value": [0.5]}]}
    assert core.uniform(r, 3) == 0.5
    assert core.uniform(r, 1) == 0.0
    assert core.uniform(r, 7) is None
    assert core.near(0.505, 0.5) and not core.near(None, 0.5) and not core.near(0.6, 0.5)


def test_verdict():
    run = core.Run()
    assert core.verdict(run) == core.SKIP  # never reached the DUT
    run.reached = True
    assert core.verdict(run) == core.SKIP  # nothing graded
    run.check("enable", "status", True)
    assert core.verdict(run) == core.PASS
    run.skip("reboot", "no reconnect")
    assert core.verdict(run) == core.PASS  # a bench skip is not a failure
    run.check("refuse", "rename", False, "renamed")
    assert core.verdict(run) == core.FAIL
    assert core.failures(run) == ["refuse/rename: renamed"]
    line = core.result_line(run, "1.2.3")
    assert line.startswith("RESULT kiosk verdict=FAIL fw=1.2.3")
    assert "enable=1/1" in line and "refuse=0/1" in line and "skipped=reboot:no reconnect" in line
