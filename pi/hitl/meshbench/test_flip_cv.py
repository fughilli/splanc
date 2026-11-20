"""flip_cv on synthetic captures (camsim) and on a recorded MJPEG video round trip.

Accuracy bounds asserted here are the ones docs/design/mesh-hitl-rig.md §7.5 states;
the Monte Carlo behind them is accuracy.py."""

import json
import os
import tempfile

import camsim
import flip_cv as fc
import numpy as np
import pytest


def _strips(names, rows=None):
    rows = rows or {}
    return [
        fc.Strip(
            n,
            [
                fc.Roi(f"{n}.{i}", np.zeros(1, int), np.zeros(1, int), rows.get((n, i), 0.0))
                for i in range(3)
            ],
        )
        for n in names
    ]


def _run(
    duts,
    cam,
    duration=10.0,
    seed=0,
    rows=None,
    window=None,
    line_time=None,
    response=None,
    lohi=None,
):
    rng = np.random.default_rng(seed)
    s, ser, truth = camsim.series(duts, cam, duration, rng, rows=rows)
    c = fc.Camera(cam.E, cam.line_time if line_time is None else line_time)
    res = fc.analyse(
        None,
        s,
        c,
        _strips([d.name for d in duts], rows),
        series=ser,
        window=window,
        response=response,
        lohi=lohi,
    )
    return res, truth, s


def _true_skew(a, b, t):
    """Display offset of b minus a at camera time t (models without jitter)."""

    def off(d):
        return d.offset + d.latency + t * d.drift_ppm * 1e-6 / (1 + d.drift_ppm * 1e-6)

    return off(b) - off(a)


def test_flip_instants_partial_exposure():
    d = camsim.DutModel("a", offset=0.0042)
    res, truth, _ = _run([d], camsim.CameraModel(fps=120), duration=4.0)
    fl = res["flips"][("a", 0)]
    tr = np.array([t for t, _ in truth[("a", 0)]])
    err = np.array([f.t - tr[np.argmin(np.abs(tr - f.t))] for f in fl])
    kind = np.array([f.kind for f in fl])
    assert len(fl) >= 0.98 * np.sum((tr > 0.01) & (tr < 3.99))
    assert np.percentile(np.abs(err[kind != "gap"]), 95) < 60e-6  # 60 us at E = 7.9 ms
    gap = 1 / 120 - 0.95 / 120
    assert np.all(np.abs(err[kind == "gap"]) <= gap / 2 + 120e-6)  # + 5 sigma of share
    pol = {round(t, 6): r for t, r in truth[("a", 0)]}
    for f in fl:  # polarity always right
        k = min(pol, key=lambda q: abs(q - f.t))
        assert pol[k] == f.rising


@pytest.mark.parametrize("skew_ms", [0.0, 0.35, 1.7, 9.0, -23.0, 140.0, -700.0])
def test_skew_global_shutter(skew_ms):
    a = camsim.DutModel("a", offset=0.0031, drift_ppm=12)
    b = camsim.DutModel("b", offset=0.0031 + skew_ms * 1e-3, drift_ppm=-9)
    res, _, s = _run([a, b], camsim.CameraModel(fps=120), duration=6.0, seed=3)
    w = res["windows"][0]
    t_ref = 0.5 * (w["t0"] + w["t1"])
    assert w["skew_s"]["b"] == pytest.approx(_true_skew(a, b, t_ref), abs=20e-6)


def test_skew_windows_track_a_step():
    """A mid-run step of b's offset (a re-sync after a link change) shows in the
    windowed series at the right window."""
    step_t, step = 5.0, 0.0024
    a = camsim.DutModel("a", offset=0.002)
    b = camsim.DutModel("b", offset=0.0025, offset_fn=lambda t: np.where(t > step_t, step, 0.0))
    res, _, _ = _run([a, b], camsim.CameraModel(fps=120), duration=10.0, window=1.0)
    sk = [w["skew_s"]["b"] for w in res["windows"]]
    for w, v in zip(res["windows"], sk):
        if w["t1"] <= step_t:
            assert v == pytest.approx(0.0005, abs=30e-6)
        elif w["t0"] >= step_t:
            assert v == pytest.approx(0.0029, abs=30e-6)


def test_render_jitter_shows_in_rms_not_in_mean():
    a = camsim.DutModel("a", offset=0.001, jitter=0.001)
    b = camsim.DutModel("b", offset=0.0016, jitter=0.001)
    res, _, _ = _run([a, b], camsim.CameraModel(fps=120), duration=10.0, seed=5)
    w = res["windows"][0]
    assert w["skew_s"]["b"] == pytest.approx(0.0006, abs=60e-6)
    o = w["phases"]["a"].offsets[0]
    # uniform [0, 1 ms) jitter: rms 289 us about its mean
    assert 230e-6 < o.rms < 350e-6
    fa, fb = res["flips"][("a", 0)], res["flips"][("b", 0)]
    per = fc.per_flip_skews(fb, fa, 0.0006, 0.005)
    assert len(per) > 300
    assert np.std(per) == pytest.approx(np.sqrt(2) * 0.001 / np.sqrt(12), rel=0.15)


def test_short_exposure_commensurate_is_flagged():
    """80 fps = the render grid: every flip lands at the same exposure phase, and with
    a 4 ms exposure and that phase in the gap no flip is timestamped. The fit must
    say it can't be trusted."""
    a = camsim.DutModel("a", offset=0.006)
    cam = camsim.CameraModel(fps=80, exposure=0.004)
    res, _, _ = _run([a], cam, duration=10.0, seed=7)
    assert not res["windows"][0]["phases"]["a"].offsets[0].trusted


def test_short_exposure_incommensurate_rate_is_fine():
    """The same 4 ms exposure at 97 fps: the flip phase sweeps the frame, and the
    flips that land inside exposures carry the estimate."""
    a = camsim.DutModel("a", offset=0.0)
    b = camsim.DutModel("b", offset=0.00113)
    cam = camsim.CameraModel(fps=97, exposure=0.004)
    res, _, _ = _run([a, b], cam, duration=10.0, seed=7)
    w = res["windows"][0]
    assert w["phases"]["a"].offsets[0].trusted
    assert w["skew_s"]["b"] == pytest.approx(0.00113, abs=40e-6)


def test_rolling_shutter_needs_line_time():
    """120 fps rolling shutter (8 us/row, Camera Module 3 class): strips 800 rows apart."""
    a = camsim.DutModel("a", offset=0.0)
    b = camsim.DutModel("b", offset=0.0005)
    cam = camsim.CameraModel(fps=120, line_time=8e-6)
    rows = {("a", i): 100.0 for i in range(3)}
    rows.update({("b", i): 900.0 for i in range(3)})
    res, _, _ = _run([a, b], cam, duration=8.0, rows=rows)
    assert res["windows"][0]["skew_s"]["b"] == pytest.approx(0.0005, abs=30e-6)
    # ignoring the row offset biases the skew by 800 rows * 8 us = 6.4 ms
    res0, _, _ = _run([a, b], cam, duration=8.0, rows=rows, line_time=0.0)
    assert res0["windows"][0]["skew_s"]["b"] == pytest.approx(0.0005 - 0.0064, abs=60e-6)


def _cal_levels(cam, names, area=40.0, seed=99):
    """The calibration phase: every LED held on, then off (meshFlipClock ev-free
    hold, §7.4), giving each ROI's plateau levels."""
    rng = np.random.default_rng(seed)
    on = cam.sensor(np.ones(60), area, rng)
    off = cam.sensor(np.zeros(60), area, rng)
    return {(n, i): (float(np.median(off)), float(np.median(on))) for n in names for i in range(3)}


def test_60fps_needs_measured_levels():
    """At 60 fps LED 0 can go a whole capture without a fully-on frame; measured
    plateau levels fix the normalisation."""
    a = camsim.DutModel("a", offset=0.0)
    b = camsim.DutModel("b", offset=0.0005)
    cam = camsim.CameraModel(fps=60)
    res, _, _ = _run([a, b], cam, duration=10.0, lohi=_cal_levels(cam, "ab"))
    assert res["windows"][0]["skew_s"]["b"] == pytest.approx(0.0005, abs=40e-6)


def test_gamma_bias_removed_by_response():
    a = camsim.DutModel("a", offset=0.0)
    b = camsim.DutModel("b", offset=0.003)
    cam = camsim.CameraModel(fps=120, gamma=2.2)
    res, _, _ = _run([a, b], cam, duration=8.0, seed=2)
    biased = res["windows"][0]["skew_s"]["b"] - 0.003
    # exposure sweep of a steady-on LED -> the response LUT
    rel = np.linspace(0, 1.0, 41)
    lv = cam._encode(rel)
    resp = fc.Response.from_sweep(rel, lv)
    res2, _, _ = _run([a, b], cam, duration=8.0, seed=2, response=resp)
    fixed = res2["windows"][0]["skew_s"]["b"] - 0.003
    assert abs(fixed) < 30e-6
    assert abs(biased) > 3 * abs(fixed)


def test_common_camera_jitter_cancels():
    a = camsim.DutModel("a", offset=0.0)
    b = camsim.DutModel("b", offset=0.0008)
    cam = camsim.CameraModel(fps=120, start_jitter=300e-6)
    res, _, _ = _run([a, b], cam, duration=10.0, seed=9)
    assert res["windows"][0]["skew_s"]["b"] == pytest.approx(0.0008, abs=40e-6)


def test_led2_event_flip_is_visible():
    """ev flips LED 2 off its 1.6 s grid: find_flips reports the extra edge."""
    a = camsim.DutModel("a", offset=0.0, events=[(2.4125, 1)])
    res, truth, _ = _run([a], camsim.CameraModel(fps=120), duration=4.0)
    times = [f.t for f in res["flips"][("a", 2)]]
    assert any(abs(t - 2.4125) < 1e-4 for t in times)


def _frame_pipeline(jpeg, tmpdir=None):
    duts = [camsim.DutModel("a", offset=0.0021), camsim.DutModel("b", offset=0.0021 + 0.0013)]
    layout = {}
    for k, d in enumerate(duts):
        for i in range(3):
            layout[(d.name, i)] = (30 + 25 * i, 30 + 50 * k)
    cam = camsim.CameraModel(fps=120, jpeg_quality=None)
    rng = np.random.default_rng(11)
    frames, s = camsim.render_frames(duts, layout, cam, 4.0, rng)
    if jpeg:
        path = os.path.join(tmpdir, "rec.avi")
        camsim.write_mjpeg(path, frames, cam.fps, quality=85)
        frames = fc._load_video(path)
        assert frames.shape[0] == s.size
    rois = fc.detect_rois(frames)
    assert len(rois) == 6
    strips = [fc.Strip("a", rois[0:3]), fc.Strip("b", rois[3:6])]
    res = fc.analyse(frames, s, fc.Camera(cam.E), strips)
    return res["windows"][0]["skew_s"]["b"]


def test_full_frames_detect_and_measure():
    assert _frame_pipeline(jpeg=False) == pytest.approx(0.0013, abs=40e-6)


def test_recorded_mjpeg_video_round_trip():
    with tempfile.TemporaryDirectory() as d:
        assert _frame_pipeline(jpeg=True, tmpdir=d) == pytest.approx(0.0013, abs=80e-6)


def test_cli_on_recorded_video(capsys):
    duts = [camsim.DutModel("a", offset=0.0), camsim.DutModel("b", offset=0.0007)]
    layout = {(d.name, i): (30 + 25 * i, 30 + 50 * k) for k, d in enumerate(duts) for i in range(3)}
    cam = camsim.CameraModel(fps=120)
    frames, s = camsim.render_frames(duts, layout, cam, 3.0, np.random.default_rng(4))
    with tempfile.TemporaryDirectory() as d:
        vid = os.path.join(d, "v.avi")
        camsim.write_mjpeg(vid, frames, cam.fps)
        meta = {
            "exposure": cam.E,
            "frame_start": s.tolist(),
            "strips": [
                {
                    "dut": n,
                    "boxes": [
                        [x - 3, y - 3, x + 4, y + 4] for x, y in (layout[(n, i)] for i in range(3))
                    ],
                }
                for n in ("a", "b")
            ],
        }
        mp = os.path.join(d, "meta.json")
        json.dump(meta, open(mp, "w"))
        assert fc.main([vid, "--meta", mp]) == 0
    out = json.loads(capsys.readouterr().out)
    assert out["windows"][0]["skew_ms"]["b"] == pytest.approx(0.7, abs=0.08)


REC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "testdata", "recorded")


@pytest.mark.skipif(not os.path.isdir(REC), reason="no real-camera recording committed yet (§7.6)")
def test_real_recordings():
    """Each testdata/recorded/<name>/ holds video.avi + meta.json + expect.json (the LA
    skew of the same run); the camera must agree with the analyser within 0.3 ms."""
    for name in sorted(os.listdir(REC)):
        d = os.path.join(REC, name)
        meta = json.load(open(os.path.join(d, "meta.json")))
        want = json.load(open(os.path.join(d, "expect.json")))
        frames = fc._load_video(os.path.join(d, "video.avi"))
        fs = np.asarray(meta["frame_start"])[: len(frames)]
        strips = [
            fc.Strip(
                s["dut"], [fc.roi_from_box(f"{s['dut']}.{i}", *b) for i, b in enumerate(s["boxes"])]
            )
            for s in meta["strips"]
        ]
        res = fc.analyse(
            frames[: len(fs)], fs, fc.Camera(meta["exposure"], meta.get("line_time", 0.0)), strips
        )
        for dut, ms in want["skew_ms"].items():
            assert res["windows"][0]["skew_s"][dut] * 1e3 == pytest.approx(ms, abs=0.3), (name, dut)
