"""mesh_app_e2e_core (the `mesh_app_e2e` HITL's pure logic): parsing, frame spread, late
frames with their cause, and the gate."""

from mesh_app_e2e_core import (
    app_requests,
    client_arms,
    fx_same_frame,
    late_report,
    late_summary,
    mt_applies,
    mt_same_frame,
    unlocks,
    verdict,
)

FT = "[ft] r1000:80/80/0 w0:0/0/0 dt12 fps=80 sl=0-0"


def _ap(rx: int, tsf: int) -> str:
    return f"[mt] ap tsf={tsf} rx={rx} hw=0 mesh=0 st=synced lag=10"


def test_unlocks():
    u = unlocks(
        [
            "[mesh] unlock conn=1 session=77 not_after=900 -> ok",
            "[mesh] unlock conn=2 session=78 not_after=901 -> refused",
        ]
    )
    assert [x["ok"] for x in u] == [True, False]
    assert u[0] == {"conn": 1, "session": 77, "not_after": 900, "ok": True}


def test_mt_same_frame_on_ap_clock():
    # Each DUT's own clock differs; one AP beacon maps them onto one clock.
    lines = {
        "a": [_ap(1_000_000, 50_000_000), "[mt] apply us=1_100_000 k=1 ms=0".replace("_", "")],
        "b": [_ap(7_000_000, 50_000_000), "[mt] apply us=7100400 k=9 ms=0"],
        "c": [_ap(3_000_000, 50_000_000), "[mt] apply us=3099800 k=4 ms=0"],
    }
    assert mt_applies(lines["b"]) == [{"us": 7100400, "k": 9, "ms": 0}]
    r = mt_same_frame(lines, 12_500)
    assert r["ok"] and r["skew_us"] == 600, r
    late = dict(lines, c=[_ap(3_000_000, 50_000_000), "[mt] apply us=3120000 k=4 ms=0"])
    assert not mt_same_frame(late, 12_500)["ok"]
    missing = dict(lines, c=[_ap(3_000_000, 50_000_000)])
    assert not mt_same_frame(missing, 12_500)["ok"]
    twice = dict(lines, a=lines["a"] + ["[mt] apply us=1200000 k=2 ms=0"])
    assert not mt_same_frame(twice, 12_500)["ok"], "applied twice"


def test_fx_same_frame():
    lines = {
        "a": [_ap(0, 10_000_000), "[mesh] fx applied us=500000 k=40 ms=1 load_us=3000"],
        "b": [_ap(100, 10_000_000), "[mesh] fx applied us=500900 k=40 ms=1 load_us=3000"],
    }
    r = fx_same_frame(lines, 12_500)
    assert r["ok"] and r["skew_us"] == 800 and r["k"] == {"a": 40, "b": 40}


def test_late_report_causes():
    lines = [
        FT,
        "[mesh] fx applied us=1 k=2 ms=3 load_us=4000",
        "[late] n=1 max=30000 ago_ms=5",
        FT,
        FT,
        "TLS HANDSHAKE COMPLETE",
        "[late] n=3 max=25000 ago_ms=9",
        FT,
        FT,
        "[late] n=2 max=20000 ago_ms=1",
        FT,
        FT,
        "[mesh] state saved 120 B",
        "[late] n=1 max=40000 ago_ms=2",
    ]
    r = late_report("p", "a", lines)
    assert [x["cause"] for x in r] == ["effect_load", "tls", "unattributed", "flash_write"]
    assert [x["n"] for x in r] == [1, 3, 2, 1]
    s = late_summary(r)
    assert s["frames"] == 7 and s["by_dut"] == {"a": 7}
    assert s["by_cause"] == {"effect_load": 1, "tls": 3, "unattributed": 2, "flash_write": 1}


def test_late_after_reset_is_boot():
    r = late_report("p", "b", ["ESP-ROM:esp32c6-20220919", FT, "[late] n=4 max=90000 ago_ms=1"])
    assert r[0]["cause"] == "boot"


def test_verdict():
    rec = {"steps": {"create": {"ok": True}, "effect": {"ok": True}}, "late": []}
    assert verdict(rec) == (True, [])
    rec["steps"]["eject"] = {"ok": False, "fail": "c still listed"}
    ok, why = verdict(rec)
    assert not ok and why == ["eject: c still listed"]
    rec = {"steps": {"x": {"ok": True}}, "late": [{"cause": "tls", "n": 1}]}
    assert verdict(rec)[0], "late frames are reported, not gated, by default"
    assert not verdict(rec, strict_late=True)[0]
    rec["late"] = [{"cause": "boot", "n": 2}]
    assert verdict(rec, strict_late=True)[0], "boot is not a blip"
    assert not verdict({"steps": {}})[0]


PROTO = """
message ClientMessage {
  oneof msg {
    Hello hello = 1;
    GetSensors get_sensors = 48;
    ListStoredEffects list_stored_effects = 140;
  }
}
message Other { uint32 x = 2; }
"""


def test_app_requests_name_the_arms():
    arms = client_arms(PROTO)
    assert arms == {1: "hello", 48: "get_sensors", 140: "list_stored_effects"}
    frames = [
        (-30, "tx", 3, "e20800"),  # field 140 (two-byte tag)
        (-29, "tx", 3, "820300"),  # field 48
        (-500, "tx", 3, "0a00"),  # long before: not it
        (5, "rx", 27, "9a031810"),  # a reply, not a request
    ]
    assert app_requests(frames, arms) == ["list_stored_effects", "get_sensors"]


def test_topology_view_and_gate():
    from mesh_app_e2e_core import topology_ok, topology_view

    rows = [
        {
            "name": "Lamp A (this one)",
            "detail": "Time synced · Connected to this phone · no room position",
            "placed": False,
        },
        {
            "name": "Lamp B",
            "detail": "Time synced · 80 fps · Direct neighbour · in Rig bench",
            "placed": True,
        },
        {
            "name": "Lamp C",
            "detail": "Time synced · 80 fps · Direct neighbour · in Rig bench",
            "placed": True,
        },
    ]
    v = topology_view("3 fixtures · 3 radio links · 2 of 3 placed in the room", rows)
    assert (v["fixtures"], v["links"], v["rows"], v["direct"]) == (3, 3, 3, 2)
    assert v["placed"] == ["Lamp B", "Lamp C"] and v["unplaced"] == ["Lamp A (this one)"]
    assert topology_ok(v, 3, 2) == (True, [])
    # Not converged yet: one link, a member heard through another, one on old firmware.
    rows2 = [dict(r) for r in rows]
    rows2[2]["detail"] = "Time synced · 2 hops away · no map data (older firmware)"
    rows2[2]["placed"] = False
    v2 = topology_view("3 fixtures · 1 radio link · 1 of 3 placed in the room", rows2)
    ok, why = topology_ok(v2, 3, 2)
    assert not ok and len(why) == 4, why
    assert topology_view("Reading the mesh…", [])["fixtures"] == 0
