"""mesh_gateway's analysis (mesh_gateway_core): rounds clustered on the AP reference, the
firmware's refusal and result lines, decoded MeshResults and the verdict."""

from mesh_apply_at_skew_core import ApPair, Apply
from mesh_gateway_core import (
    all_ok,
    cluster_rounds,
    gw_results,
    member_results,
    refusals,
    skew_stats,
    verdict,
)


def _pairs(off: int) -> list[ApPair]:
    # A member whose clock is AP time + off, one beacon a second for 20 s.
    return [ApPair(s * 1_000_000, s * 1_000_000 + off, 0, "synced", 0) for s in range(1, 21)]


def test_rounds_cluster_by_ap_time_across_clocks():
    pairs = {"a": _pairs(0), "b": _pairs(5_000_000), "c": _pairs(-3_000_000)}
    # Three rounds 1.5 s apart; b lags 300 µs in round 2; c misses round 3.
    apps = {
        "a": [Apply(2_000_000, 10, 0), Apply(3_500_000, 30, 0), Apply(5_000_000, 50, 0)],
        "b": [Apply(7_000_100, 10, 0), Apply(8_500_300, 30, 0), Apply(10_000_000, 50, 0)],
        "c": [Apply(-1_000_000 + 50, 10, 0), Apply(500_000, 30, 0)],
    }
    cs = cluster_rounds(apps, pairs)
    assert len(cs) == 3
    s = skew_stats(cs, ["a", "b", "c"], 3)
    assert (s["measured"], s["partial"], s["same_frame"]) == (2, 1, 2)
    assert s["skew_max_us"] == 300
    assert round(cs[0].skew_us()) == 100


def test_firmware_lines():
    lines = [
        "123 [mesh] ctl refused op=1073741826 arm=27 from=1a2b (not relayed over the mesh)",
        "124 [mesh] gw result op=1073741826 n=2 ok=0 complete=1 nodes=[3c4d, 5e6f] lat_ms=[9, 12] "
        "status=[Refused, Refused] codes=[27, 27] gw=0",
    ]
    assert refusals(lines) == [{"op": 1073741826, "arm": 27, "from": "1a2b"}]
    r = gw_results(lines)[1073741826]
    assert (r["n"], r["ok"], r["complete"]) == (2, 0, True)


def test_member_results_and_verdict():
    res = {
        "members": [
            {"node": 5, "latencyMs": 9},
            {"node": 6, "status": "MESH_MEMBER_REFUSED", "code": 27},
        ]
    }
    assert member_results(res) == {5: ("MESH_MEMBER_OK", 0, 9), 6: ("MESH_MEMBER_REFUSED", 27, 0)}
    assert not all_ok(res, 2)
    assert all_ok({"members": [{"node": 5}, {"node": 6}]}, 2)
    assert not all_ok({"members": [{"node": 5}]}, 2)
    good = {
        "baseline": {"fps_min": 80},
        "gateway": {"epoch_refused": True, "fps_min": 80},
        "control": {
            "skew": {"rounds": 10, "measured": 10, "skew_max_us": 900},
            "results": {"sent": 10, "all_ok": 10},
            "fps_min": 79,
        },
        "live": {"live": {"sent": 60, "dispatched": {"b": 60, "c": 58}}},
        "refused": {
            "refused": {"by_arm": {"27": ["b", "c"]}, "dispatched": {}, "gateway_refused": True}
        },
    }
    assert verdict(good, 2) == (True, [])
    assert verdict({**good, "deploy": {"fps_min": 30, "fps_exempt": "autoscaler"}}, 2) == (True, [])
    bad = {
        **good,
        "gateway": {"epoch_refused": False},
        "control": {
            "skew": {"rounds": 10, "measured": 8, "skew_max_us": 12_000},
            "results": {"sent": 10, "all_ok": 7},
            "fps_min": 70,
        },
        "refused": {
            "refused": {"by_arm": {"27": ["b"]}, "dispatched": {"c": 1}, "gateway_refused": False}
        },
        "ble": {"resets": 1},
    }
    ok, why = verdict(bad, 2)
    assert not ok
    joined = " | ".join(why)
    for needle in (
        "rounds applied",
        "skew 12.00 ms",
        "every member OK in 7/10",
        "refused by 1/2",
        "dispatched",
        "did not refuse",
        "show epoch",
        "render 70 fps",
        "1 reset",
    ):
        assert needle in joined, needle
