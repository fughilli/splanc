"""The Wi-Fi cadence gate's pure logic (harness/wifi_cadence_core.py): analyzer frame
intervals against the steady baseline, the firmware's [fx] ft= fields, and the verdict.
The FAIL fixture mirrors the first hitl-rig-2 measurement: a heavy effect's frames
stretched 184 -> 196 ms while PBKDF2 shared the CPU 1:1 with rendering."""

import wifi_cadence_core as core


def frames(periods_ms, start=0.0, flags=None):
    out, t = [], start
    out.append({"start_us": t * 1000, "leds": 250, "flags": []})
    for i, p in enumerate(periods_ms):
        t += p
        out.append({"start_us": t * 1000, "leds": 250, "flags": (flags or {}).get(i + 1, [])})
    return out


def fx_line(rmax, wmax, dt=13, rn=77):
    return (
        f"[fx] t=1.00 frame=10 update=ok shade_cancelled=0/250 "
        f"ft=r{rn}:12000/13000/{rmax} w{rn}:12000/13000/{wmax} dt{dt}\n"
    )


def test_ft_fields_parse():
    s = core.ft_samples(fx_line(13500, 13600))
    assert s[0]["rmax"] == 13500 and s[0]["wmax"] == 13600 and s[0]["dt"] == 13
    v = core.device_view(fx_line(13500, 13600) + fx_line(14000, 13900))
    assert v["render_max_us"] == 14000 and v["wire_max_us"] == 13900 and v["windows"] == 2


def test_capture_truncated_edges_are_not_damage():
    f = frames([13.0] * 10)
    f[0]["flags"] = ["truncated", "bad_bit"]
    f[-1]["flags"] = ["truncated"]
    assert core.damaged(f) == []
    f[5]["flags"] = ["runt", "intra_gap"]
    assert [x["start_us"] for x in core.damaged(f)] == [f[5]["start_us"]]
    # "short_gap_before" alone isn't damage unless the latch low was really too short.
    f[6]["flags"] = ["short_gap_before"]
    f[6]["gap_before_us"] = 690.0
    assert len(core.damaged(f)) == 1
    f[6]["gap_before_us"] = 120.0
    assert len(core.damaged(f)) == 2
    assert len(core.wire_periods(f)) == 8  # the two truncated edge frames dropped


def test_baseline_threshold_has_a_floor():
    b = core.baseline([13000.0] * 100)
    assert b["median_us"] == 13000 and b["threshold_us"] == core.ABS_FLOOR_US
    b = core.baseline([13000.0] * 98 + [19000.0, 7000.0])
    assert b["threshold_us"] == 1.5 * 6000


def test_phase_flags_an_excursion():
    base = core.baseline(core.wire_periods(frames([184.0] * 60)))
    ok = core.phase_wire(core.wire_periods(frames([184.0] * 60)), frames([184.0] * 60), base)
    assert ok["excursions"] == 0 and ok["damaged"] == 0
    slow = frames([184.0] * 20 + [196.0] * 12 + [184.0] * 20)
    bad = core.phase_wire(core.wire_periods(slow), slow, base)
    assert bad["excursions"] == 12 and bad["worst_excursion_us"] == 196000


def test_grade_pass_fail_skip():
    base = core.baseline(core.wire_periods(frames([13.0] * 50)))
    good = {
        "wire": core.phase_wire(core.wire_periods(frames([13.0] * 50)), frames([13.0] * 50), base),
        "device": {"windows": 5, "render_excess_us": 0, "wire_excess_us": 0, "dt_max_ms": 13},
    }
    r = {"light": {"baseline": base, "scan": good, "rejoin": good}}
    assert core.grade(r, ("scan", "rejoin"))["verdict"] == "PASS"
    late = frames([13.0] * 20 + [16.5] * 5 + [13.0] * 20)
    r["light"]["rejoin"] = {
        "wire": core.phase_wire(core.wire_periods(late), late, base),
        "device": {},
    }
    g = core.grade(r, ("scan", "rejoin"))
    assert g["verdict"] == "FAIL" and "rejoin" in g["problems"][0]
    # No analyzer: the device view decides.
    r = {
        "light": {
            "scan": {
                "wire": {"frames": 0},
                "device": {
                    "windows": 5,
                    "render_excess_us": 6000,
                    "wire_excess_us": 0,
                    "dt_max_ms": 13,
                },
            }
        }
    }
    assert core.grade(r, ("scan",))["verdict"] == "FAIL"
    # Nothing measured: SKIP (infra), never FAIL.
    assert core.grade({"light": {}}, ("scan",))["verdict"] == "SKIP"
    # A time-base jump fails regardless of the cadence.
    r = {"heavy": {"scan": {"wire": good["wire"], "device": {"windows": 5, "dt_max_ms": 1500}}}}
    assert core.grade(r, ("scan",))["verdict"] == "FAIL"


def test_policy_round_trip_checks():
    ft = fx_line(13000, 13000)
    to_off = "[wifi] offline mode: Wi-Fi silent now (no scans, no TX)\n" + ft
    boot = (
        "rst:0x15\n[boot] reset_reason=USB (12)\n[wifi] offline mode: radio off (BLE + console)\n"
        + ft
    )
    back = (
        "[wifi] leaving offline mode: rejoining\n*** DHCP LEASE ACQUIRED — IP 10.42.0.9 ***\n" + ft
    )
    assert core.grade_policy(to_off, boot, back) == []
    # An offline boot that still started the radio, and no lease afterwards.
    bad_boot = boot.replace("offline mode: radio off", "x") + "[scan] err=0 found=3 AP(s)\n"
    p = core.grade_policy(to_off, bad_boot, ft)
    assert any("keep the radio off" in x for x in p) and any("vendor scan" in x for x in p)
    assert any("did not lease" in x for x in p)
    # A reset while going offline is a failure (the reboot in the boot step is expected).
    assert any("reset" in x for x in core.grade_policy(to_off + "ESP-ROM:esp32c6\n", boot, back))
