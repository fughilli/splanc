"""mesh_effect_core (the mesh M6 `mesh_effect` HITL's pure logic): line parsing and the gate."""

from mesh_effect_core import (
    applied,
    frame_aligned,
    gw_apply,
    late_frames,
    round_ok,
    scenes,
    verdict,
)

FT = "[ft] r1000:80/80/0 w0:0/0/0 dt12 fps=80 sl=0-0"


def test_applied_and_alignment():
    a = applied(["x", "[mesh] fx applied us=1000 k=812 ms=1 load_us=4100"])
    assert a == [{"us": 1000, "k": 812, "ms": 1, "load_us": 4100}]
    ok, ks = frame_aligned({"a": a, "b": [{"k": 812}], "c": [{"k": 812}]})
    assert ok and ks == {"a": 812, "b": 812, "c": 812}
    assert not frame_aligned({"a": a, "b": [{"k": 813}]})[0]
    assert not frame_aligned({"a": a, "b": []})[0]
    assert not frame_aligned({"a": a, "b": [{"k": 812}, {"k": 900}]})[0], "loaded twice"
    assert not frame_aligned({"a": [{"k": -1}], "b": [{"k": -1}]})[0], "off the grid"


def test_scenes_and_gateway():
    s = scenes(
        [
            "[mesh] scene have op=0x80000600 blobs=1 fetch_ms=640 heap=41000 heap_min=36200",
            "[mesh] scene apply op=0x600 at=9000 staged=1 late=0 catch_up=0 skipped=0 frames=0 status=Ok code=0",
        ]
    )
    assert [x["kind"] for x in s] == ["have", "apply"]
    assert s[0]["heap_min"] == 36200 and s[1]["staged"] == 1 and s[1]["op"] == 0x600
    g = gw_apply(
        [
            "[mesh] gw share apply op=0x600 have=2/2 fetch_ms=700 at=9000 lead_ms=250 sent=1 local=staged"
        ]
    )
    assert g[0]["have_n"] == 2 and g[0]["of_n"] == 2 and g[0]["local"] == "staged"


def test_late_frames_attributed():
    lines = [
        FT,
        "[mesh] fx applied us=1 k=2 ms=3 load_us=9000",
        FT,
        "[late] n=1 max=26000 ago_ms=400",
        FT,
        "[late] n=1 max=30000 ago_ms=100",
        "[mesh] shared effect persisted ok 3100 B us=48000",
        FT,
        "[late] n=1 max=30000 ago_ms=100",
    ]
    lf = late_frames(lines)
    assert [x["effect_load"] for x in lf] == [True, False, False]
    assert [x["save_us"] for x in lf] == [None, None, 0]


def _round(**kw):
    r = {
        "round": 0,
        "effect_id": "storm0",
        "reply": "result_ready",
        "members": {"4464": "MESH_MEMBER_OK", "7442": "MESH_MEMBER_OK"},
        "duts": 3,
        "running": {"a": "storm0", "b": "storm0", "c": "storm0"},
        "aligned": True,
        "scenes": {"b": {"late": False}, "c": {"late": False}},
        "all_ms": 1200,
    }
    r.update(kw)
    return r


def test_gate():
    assert round_ok(_round())
    assert not round_ok(_round(aligned=False))
    assert not round_ok(_round(running={"a": "storm0", "b": "x", "c": "storm0"}))
    assert not round_ok(_round(members={"4464": "MESH_MEMBER_MISSING"}))
    assert not round_ok(_round(scenes={"b": {"late": True}}))
    good = {
        "share": {"rounds": [_round()], "late": {"b": [{"effect_load": True, "save_us": None}]}},
        "late_joiner": {"caught_up": True, "uniforms_match": True},
        "reboot": {"caught_up": True, "resets": 1},
    }
    assert verdict(good, 5.0) == (True, [])
    slow = {**good, "share": {"rounds": [_round(all_ms=9000)]}}
    assert not verdict(slow, 5.0)[0]
    stall = {
        **good,
        "share": {"rounds": [_round()], "late": {"c": [{"effect_load": False, "save_us": None}]}},
    }
    ok, why = verdict(stall, 5.0)
    assert not ok and "late frame" in why[0]
    reset = {**good, "share": {"rounds": [_round()], "resets": 1}}
    assert not verdict(reset, 5.0)[0]
    assert not verdict({**good, "late_joiner": {"caught_up": True, "uniforms_match": False}}, 5.0)[
        0
    ]


def test_skew_on_the_ap_clock():
    from mesh_effect_core import ap_refs, apply_skew, on_ap_clock

    ra = ap_refs(["[mt] ap tsf=5000000 rx=100000 hw=1 mesh=2 st=synced lag=3"])
    rb = ap_refs(["[mt] ap tsf=5000000 rx=900000 hw=1 mesh=2 st=synced lag=3"])
    assert on_ap_clock(ra, 150000) == 5050000
    assert on_ap_clock(ra, 100000 + 4_000_000) is None, "too far from any beacon"
    per = {"a": [{"us": 150000}], "b": [{"us": 950700}]}
    assert apply_skew(per, {"a": ra, "b": rb}) == 700
    assert apply_skew({"a": [{"us": 1}], "b": []}, {"a": ra, "b": rb}) is None
