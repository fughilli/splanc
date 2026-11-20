"""bench_core verdict/metrics, the end-to-end simulation, and the hardware-path
analysis functions of hitl_mesh_bench on recorded-format files."""

import json
import os
import tempfile

import bench_core as bc
import benchsim
import camsim
import hitl_mesh_bench as hmb
import la_phase as la
import numpy as np
import pytest
import scenarios as sc

MARKS = [(1_000_000, "full"), (3_000_000, "down:01"), (6_000_000, "up:01")]


def _windows(spreads_ms, start_us=500_000, step_us=500_000, trusted=True):
    return [
        bc.Window(start_us + k * step_us, {"a": 0.0, "b": s * 1e-3}, trusted)
        for k, s in enumerate(spreads_ms)
    ]


def test_phase_of():
    assert bc.phase_of(0, MARKS) == "pre"
    assert bc.phase_of(3_500_000, MARKS) == "down"
    assert bc.phase_of(9_000_000, MARKS) == "up"


def test_reconvergence_and_stats():
    sp = [0.3] * 5 + [4.0, 6.0, 5.0, 3.0, 2.5, 5.0, 4.0, 3.0, 1.5, 1.0, 0.8]
    ws = _windows(sp)
    rc = {e["event"]: e for e in bc.reconvergence(ws, MARKS)}
    assert rc["up:01"]["reconverge_s"] == pytest.approx(
        1.0
    )  # 7.0 s window is the first of 3 < 2 ms
    assert rc["down:01"]["peak_spread_ms"] == pytest.approx(6.0)
    st = bc.phase_stats(ws, MARKS)
    assert st["full"]["max"] == pytest.approx(0.3)
    assert st["down"]["p50"] == pytest.approx(4.5)


def test_untrusted_windows_are_ignored():
    ws = _windows([0.2, 50.0, 0.2], trusted=True)
    ws[1].trusted = False
    assert bc.phase_stats(ws, MARKS)["pre"]["max"] == pytest.approx(0.2)


def test_verdict_skip_fail_pass():
    assert bc.verdict({"infra": {"controller": False}}).status == "SKIP"
    assert bc.verdict({"infra": {"controller": True}}).status == "SKIP"
    base = {"infra": {"controller": True, "camera": True}, "controller": {"late_max_us": 3}}
    r = bc.build_results(
        {"name": "t"}, MARKS, base["controller"], {"camera": _windows([0.3] * 20)}, base["infra"]
    )
    assert r["verdict"]["status"] == "PASS"
    r = bc.build_results(
        {"name": "t"},
        MARKS,
        base["controller"],
        {"camera": _windows([0.3] * 10 + [30.0] * 10)},
        base["infra"],
    )
    assert r["verdict"]["status"] == "FAIL"
    assert any("p99 spread" in x for x in r["verdict"]["reasons"])
    assert any("no reconvergence" in x for x in r["verdict"]["reasons"])
    r = bc.build_results(
        {"name": "t"}, MARKS, {"late_max_us": 400}, {"camera": _windows([0.3] * 20)}, base["infra"]
    )
    assert any("late" in x for x in r["verdict"]["reasons"])


def test_metrics_follow_schema_v1():
    r = bc.build_results(
        {"name": "link_flap"},
        MARKS,
        {"late_max_us": 3, "steps": 9},
        {"camera": _windows([0.3] * 20), "la": _windows([0.2] * 20)},
        {"controller": True, "camera": True, "la": True},
        rig="mesh-rig",
    )
    allowed = {"s", "ms", "us", "fps", "cycles", "bytes", "count", "pct", "kbps"}
    for m in r["metrics"]:
        assert m["v"] == 1 and m["gate"] == "mesh_bench"
        assert m["unit"] in allowed
        assert np.isfinite(m["value"])
        line = bc.metric_line(m)
        assert line.startswith("HITL_METRIC {") and "\n" not in line
        json.loads(line[len("HITL_METRIC ") :])
    names = {(m["metric"], m.get("phase"), m.get("stat")) for m in r["metrics"]}
    assert ("flip_spread", "link_flap:full", "p99") in names
    assert ("flip_spread_la", "link_flap:up", "max") in names
    assert any(m["metric"] == "switch_late" for m in r["metrics"])


def test_fit_sync_handles_missed_first_toggle():
    sync_us = [int(t * 1e6) for t in sc.SYNC_CODE] + [2_000_000, 5_000_000, 9_000_000]
    t_cam = [(0.77 + u * 1e-6 * (1 - 40e-6), k % 2 == 0) for k, u in enumerate(sync_us)]
    a, b, rms, n = bc.fit_sync(t_cam[1:], sync_us)  # the camera missed the first one
    assert n == len(sync_us) - 1 and rms < 1.0
    assert a + b * (0.77 + 3.0 * (1 - 40e-6)) == pytest.approx(3_000_000, abs=2)


@pytest.mark.parametrize("scenario", ["link_flap", "partition_heal"])
def test_end_to_end_simulation(scenario):
    params = (
        {"cycles": 2}
        if scenario == "link_flap"
        else {"t_cut": 4.0, "t_heal": 12.0, "duration": 30.0}
    )
    cfg = benchsim.SimConfig(scenario=scenario, params=params, ppm=(0.0, 40.0, -300.0, 250.0))
    r = benchsim.run(cfg)
    assert r["verdict"]["status"] == "PASS", r["verdict"]
    cam = r["measurements"]["camera"]
    la_m = r["measurements"]["la"]
    assert cam["windows_trusted"] >= 0.9 * len(cam["windows"])
    # the steady spread: base offsets 0.7 ms apart (+ the 0.8 ms render jitter's mean)
    full = cam["phases"]["full"]
    assert 0.4 < full["p50"] < 1.3
    assert r["camera_map"]["rms_us"] < 300
    if scenario == "partition_heal":
        # nodes 2 and 3 drift apart while cut off (-300 and +250 ppm for 8 s)...
        assert cam["phases"]["partition"]["max"] > 3.0
        # ...and slew back after the heal (0.5 ms/s)
        heal = [e for e in cam["reconvergence"] if e["event"] == "heal"][0]
        assert heal["reconverge_s"] is not None and 2.0 < heal["reconverge_s"] < 15.0
        # the analyser taps nodes 0 and 1, which never lost each other
        assert la_m["phases"]["partition"]["max"] < 1.5


def test_hardware_analysis_path_on_recorded_files():
    """analyse_camera / analyse_la on the file formats the rig agent writes: an MJPEG
    video + V4L2 timestamps with a dropped frame, and a sigrok VCD with SYNC."""
    rng = np.random.default_rng(3)
    duts = [camsim.DutModel("a", offset=0.5 + 0.002), camsim.DutModel("b", offset=0.5 + 0.0031)]
    layout = {(d.name, i): (30 + 25 * i, 30 + 40 * k) for k, d in enumerate(duts) for i in range(3)}
    cam = camsim.CameraModel(fps=120)
    frames, s = camsim.render_frames(duts, layout, cam, 4.0, rng, size=(140, 160), t0=0.3)
    # the sync LED at (130, 120): toggles at the code + one mark, controller t0 = 0.5 s
    sync_us = [int(t * 1e6) for t in sc.SYNC_CODE] + [2_000_000]
    lt = np.concatenate([[-10.0], 0.5 + np.asarray(sync_us) * 1e-6])
    st = np.concatenate([[0.0], (np.arange(len(sync_us)) % 2 == 0).astype(float)])
    yy, xx = np.mgrid[0:140, 0:160]
    spot = np.exp(-((xx - 130) ** 2 + (yy - 120) ** 2) / (2 * 1.8**2))
    for r in np.nonzero(spot.max(axis=1) > 1e-3)[0]:
        f = camsim.on_fraction(lt, st, s, cam.E)
        frames[:, r, :] = np.clip(
            frames[:, r, :] + (f[:, None] * spot[r][None, :] * 188), 0, 255
        ).astype(np.uint8)
    drop = 200
    frames = np.delete(frames, drop, axis=0)
    pts = np.delete(s, drop) + rng.normal(0, 150e-6, size=s.size - 1)  # host timestamp jitter
    with tempfile.TemporaryDirectory() as d:
        vid = os.path.join(d, "video.mkv")
        camsim.write_mjpeg(vid, frames, cam.fps)
        box = lambda x, y: [x - 3, y - 3, x + 4, y + 4]  # noqa: E731
        lay = {
            "strips": [{"dut": n, "boxes": [box(*layout[(n, i)]) for i in range(3)]} for n in "ab"],
            "syncled": box(130, 120),
        }
        windows, cmap = hmb.analyse_camera(
            vid,
            {"pts_s": pts.tolist(), "fps": 120, "exposure_us": cam.E * 1e6},
            lay,
            sync_us,
            window_s=1.0,
        )
    assert cmap["frames"] == s.size - 1
    good = [w for w in windows if w.trusted]
    assert len(good) >= 3
    for w in good:
        assert w.offsets["b"] == pytest.approx(0.0011, abs=0.1e-3)
    # controller time of a window centre ~ camera time - 0.5 s
    assert good[0].t_us == pytest.approx((0.3 + 0.5 - 0.5) * 1e6, abs=0.2e6)

    # the analyser: two data lines + SYNC toggling at each step
    chans = {}
    for n, dm in zip(("D0", "D1"), duts):
        lt_d, pt, idx = dm.frames(0.0, 4.0, rng)
        keep = (lt_d > 0.6) & (lt_d < 3.9)
        stt = np.stack([dm.led_states(idx[keep], i) for i in range(3)], axis=1)
        chans[n] = la.synth_wire(
            lt_d[keep],
            [[(255 * int(v), 0, 0) for v in row] for row in stt],
            sample_rate=10e6,
            data_lead=140e-6,
        )
    steps_ctrl = [10_000_000 + u for u in sync_us]
    t_sync = 0.5 + np.asarray(sync_us) * 1e-6
    chans["D12"] = (t_sync, (np.arange(t_sync.size) % 2 == 0).astype(np.int8))
    vcd = la.to_vcd(chans, 10e6)
    windows, lmap = hmb.analyse_la(
        vcd, {"D0": "a", "D1": "b", "D12": "sync"}, steps_ctrl, window_s=1.0
    )
    assert lmap["rms_us"] < 1.0
    vals = [w.offsets["b"] for w in windows if w.trusted and w.offsets.get("b") is not None]
    assert vals and all(v == pytest.approx(0.0011, abs=5e-6) for v in vals)


def test_camera_frame_starts_handles_drops_and_jitter():
    n = np.arange(600)
    n = np.delete(n, [100, 101, 350])
    pts = 12.0 + n / 120.0 * (1 + 30e-6) + np.random.default_rng(0).normal(0, 200e-6, n.size)
    fs = hmb.camera_frame_starts(pts.tolist(), 120.0)
    assert np.max(np.abs(fs - (12.0 + n / 120.0 * (1 + 30e-6)))) < 60e-6
