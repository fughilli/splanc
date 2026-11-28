"""clock_sntp_core: the verdict over the SNTP sync time, readings against the harness's UTC,
the sync_now round, the infra SKIP and the per-phase frame data."""

from __future__ import annotations

import clock_sntp_core as core

T0 = 1_700_000_000 - (1_700_000_000 % 86400)  # a UTC midnight
LOG = """\
10:00:01.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
10:00:12.000Z [ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=80 sl=11-11
"""
PHASES = {"sync": (T0 + 36000, T0 + 36003), "read": (T0 + 36010, T0 + 36015)}


def rd(unix, err=20.0, src="CLOCK_SOURCE_SNTP", valid=True):
    return core.Reading("read", 1000.0, 1010.0, valid, unix, err, src)


def good() -> core.Report:
    rep = core.Report(synced_after_s=4.0, rounds_before=1, rounds_after=2)
    rep.ntp = {"lastResult": "CLOCK_NTP_RESULT_SYNCED", "server": "162.159.200.1"}
    rep.readings = [rd(1005.0), rd(1012.0)]
    rep.per_phase = core.frames(LOG, PHASES)
    return rep


def test_pass():
    assert core.verdict(good(), 30) == ("PASS", [])


def test_no_server_reachable_is_a_skip():
    for res in ("CLOCK_NTP_RESULT_TIMEOUT", "CLOCK_NTP_RESULT_DNS_TIMEOUT", ""):
        rep = core.Report(ntp={"lastResult": res})
        v, why = core.verdict(rep, 30)
        assert v == "SKIP", (res, why)


def test_never_synced_for_a_firmware_reason_fails():
    rep = core.Report(ntp={"lastResult": "CLOCK_NTP_RESULT_DISAGREE"})
    rep.per_phase = core.frames(LOG, PHASES)
    v, why = core.verdict(rep, 30)
    assert v == "FAIL" and "never synced" in why[0]


def test_slow_sync_wrong_source_offset_and_no_new_round_fail():
    rep = good()
    rep.synced_after_s = 45.0
    rep.readings = [rd(1005.0, src="CLOCK_SOURCE_PUSH"), rd(1080.0, err=100.0), rd(1040.0, err=5.0)]
    rep.rounds_after = 1
    v, why = core.verdict(rep, 30)
    assert v == "FAIL"
    text = " ".join(why)
    assert "after 45 s" in text
    assert "source CLOCK_SOURCE_PUSH" in text
    assert "> 50" in text
    assert "outside its own" in text
    assert "sync_now" in text


def test_late_frames_and_no_render_fail():
    rep = good()
    rep.per_phase = core.frames(LOG + "10:00:11.000Z [late] n=2 max=48000 ago_ms=10\n", PHASES)
    v, why = core.verdict(rep, 30)
    assert v == "FAIL" and any("late frame" in w for w in why)
    rep.per_phase = core.frames("", PHASES)
    v, why = core.verdict(rep, 30)
    assert any("render not running" in w for w in why)
