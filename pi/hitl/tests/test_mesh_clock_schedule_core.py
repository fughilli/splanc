"""mesh_clock_schedule_core: the serial-log parsers, matching a rule's frame to its
`[mt] apply` line, and the verdict (the member's clock from the mesh, the fan-out, on time,
the same grid frame on both DUTs, render)."""

from __future__ import annotations

import mesh_clock_schedule_core as core
from mesh_apply_at_skew_core import ApPair, Apply
from schedule_core import applied

T1 = 1_795_600_020_000.0
GW_LOG = [
    "[ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=60 sl=11-11",
    "[mt] clock sent gen=1 wmm=1795500000000000 err_us=14000 src=3 n=1",
    "[sched] fire id=1 in_ms=1984",
    "[sched] mesh id=1 k=3600",
    f"[sched] applied id=1 at_ms=601000 due_ms=600992 late_ms=8 unix_ms={int(T1) + 4}",
]
MEMBER_LOG = [
    "[ft] r84:11970/12000/12040 w84:1/1/1 dt12 fps=60 sl=11-11",
    "[mt] clock taken gen=1 origin=4d2a wmm=1795500000000000 err_us=14000 src=3 zone_changed=1",
    "[sched] mesh id=1 k=3600",
    f"[sched] applied id=1 at_ms=1201000 due_ms=1200992 late_ms=8 unix_ms={int(T1) + 5}",
]


def rule(log: list[str], us: int, k: int) -> core.DutRule:
    a = applied("\n".join(log))[0]
    return core.DutRule(applied=a, mesh_k=core.mesh_frames(log)[1], apply=Apply(us, k, 0))


def good() -> core.Report:
    rep = core.Report(gw_err_ms=14.0, member_source="CLOCK_SOURCE_MESH", member_err_ms=16.0)
    rep.member_delta_ms = 3.0
    rep.member_listed_source = "CLOCK_SOURCE_MESH"
    rep.taken = core.clock_taken(MEMBER_LOG)
    rep.sent = core.clock_sent(GW_LOG)
    rep.fanout = {
        "opId": 801,
        "members": [{"node": 7, "status": "MESH_MEMBER_OK"}],
        "complete": True,
    }
    rep.targets = {1: T1}
    rep.rules = {
        "gw": {1: rule(GW_LOG, 601_000_200, 3600)},
        "member": {1: rule(MEMBER_LOG, 1_201_000_150, 3600)},
    }
    rep.render = {"gw": {"windows": 3}, "member": {"windows": 3}}
    rep.late = {"gw": [], "member": []}
    # Both heard one AP beacon at their own 600.9 s / 1200.9 s.
    rep.ap = {
        "gw": [
            ApPair(10_000_000, 600_900_000, 0, "synced", 0),
            ApPair(10_100_000, 601_000_000, 0, "synced", 0),
        ],
        "member": [
            ApPair(10_000_000, 1_200_900_000, 0, "synced", 0),
            ApPair(10_100_000, 1_201_000_000, 0, "synced", 0),
        ],
    }
    return rep


def test_parsers():
    assert core.mesh_frames(GW_LOG) == {1: 3600}
    assert core.clock_taken(MEMBER_LOG) == [(1, 0x4D2A)]
    assert core.clock_sent(GW_LOG) == 1 and core.clock_sent(MEMBER_LOG) == 0


def test_match_apply_picks_the_frame_within_one_frame():
    a = applied("\n".join(GW_LOG))[0]
    near = Apply(601_004_000, 3600, 0)
    far = Apply(601_100_000, 3606, 0)
    assert core.match_apply(a, [far, near], lambda us: us / 1000.0) is near
    assert core.match_apply(a, [far], lambda us: us / 1000.0) is None


def test_good_passes_and_skew_is_on_the_ap_clock():
    rep = good()
    assert core.verdict(rep) == ("PASS", [])
    assert abs(rep.skew_us(1) - 50.0) < 1.0


def test_member_without_mesh_time_fails():
    rep = good()
    rep.taken = []
    rep.member_source = "CLOCK_SOURCE_NONE"
    rep.member_listed_source = "CLOCK_SOURCE_NONE"
    v, why = core.verdict(rep)
    assert v == "FAIL"
    assert any("clock taken" in w for w in why)
    assert any("expected MESH" in w for w in why)
    assert any("lists the member" in w for w in why)


def test_member_clock_outside_its_error_fails():
    rep = good()
    rep.member_delta_ms = 40.0
    v, why = core.verdict(rep)
    assert v == "FAIL" and any("off UTC" in w for w in why)


def test_different_grid_frames_fail():
    rep = good()
    rep.rules["member"][1].apply = Apply(1_201_016_800, 3601, 0)
    rep.rules["member"][1].mesh_k = 3601
    v, why = core.verdict(rep)
    assert v == "FAIL" and any("different grid frames" in w for w in why)


def test_unmapped_or_off_grid_or_late_fails():
    rep = good()
    rep.rules["gw"][1].mesh_k = None
    rep.rules["member"][1].mesh_k = -1
    v, why = core.verdict(rep)
    assert any("not mapped" in w for w in why) and any("off the frame grid" in w for w in why)
    rep = good()
    rep.rules["member"][1].applied.unix_ms = int(T1) + 200
    v, why = core.verdict(rep)
    assert v == "FAIL" and any("member: rule 1 +200 ms" in w for w in why)


def test_fanout_refused_or_missing_fails():
    rep = good()
    rep.fanout = {"members": [{"node": 7, "status": "MESH_MEMBER_REFUSED", "code": 114}]}
    assert core.verdict(rep)[0] == "FAIL"
    rep.fanout = {}
    assert core.verdict(rep)[0] == "FAIL"


def test_unattributed_late_frames_fail_attributed_ones_do_not():
    rep = good()
    rep.late["member"] = [
        {"n": 1, "max_us": 40_000, "save_us": 0, "effect_load": False, "tls": False}
    ]
    assert core.verdict(rep) == ("PASS", [])
    rep.late["member"] = [
        {"n": 2, "max_us": 40_000, "save_us": None, "effect_load": False, "tls": False}
    ]
    v, why = core.verdict(rep)
    assert v == "FAIL" and any("2 late frame" in w for w in why)


def test_skew_over_the_gate_fails():
    rep = good()
    rep.ap["member"] = [
        ApPair(10_000_000, 1_200_880_000, 0, "synced", 0),
        ApPair(10_100_000, 1_200_980_000, 0, "synced", 0),
    ]
    v, why = core.verdict(rep)
    assert v == "FAIL" and any("apart on the AP" in w for w in why)
