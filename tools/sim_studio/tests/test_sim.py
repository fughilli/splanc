"""Sim Studio core: scene → capture → solve, scored against ground truth."""

import math

import numpy as np
import pytest
from simulator import NoiseModel
from studio.sim import StudioSession, intrinsics_from_fov, noise_from_dict


def _arc_captures(session, *, views=24, arc_deg=160.0, noise=None, seed0=0):
    """Drive an arc of captures around the current scene (like the front-end)."""
    info = session.scene_info()
    c = np.asarray(info["centroid"])
    r = info["suggestedRadius"]
    span = info["span"]
    arc = math.radians(arc_deg)
    for i in range(views):
        a = -arc / 2 + arc * (i / (views - 1))
        vert = span * 0.25 * math.cos(math.pi * (i / (views - 1) - 0.5))
        eye = [c[0] + r * math.sin(a), c[1] + vert, c[2] + r * math.cos(a)]
        session.capture(eye, c.tolist(), noise=noise, seed=seed0 + i)


def test_intrinsics_from_fov():
    fx, fy, cx, cy = intrinsics_from_fov(70.0, 1280, 720)
    assert fx == fy
    assert (cx, cy) == (640.0, 360.0)
    # 70° hfov on 1280px ≈ 914px focal.
    assert abs(fx - (640.0 / math.tan(math.radians(35.0)))) < 1e-6
    assert 900 < fx < 920


def test_set_scene_reports_geometry():
    s = StudioSession()
    info = s.set_scene("cube", 64, 1.5)
    assert info["ledCount"] == 64
    assert len(info["leds"]) == 64
    assert info["span"] > 0
    assert info["suggestedRadius"] > info["span"]


def test_capture_sees_leds_and_accumulates():
    s = StudioSession()
    info = s.set_scene("grid", 36, 1.0)
    c = info["centroid"]
    eye = [c[0], c[1], c[2] + info["suggestedRadius"]]
    r = s.capture(eye, c)
    assert r["visible"] > 0
    assert r["added"] == r["visible"]  # no noise/dropout → all visible kept
    assert r["totalViews"] == 1
    assert r["totalDetections"] == r["added"]
    assert len(r["pose"]["q"]) == 4


def test_capture_requires_scene_and_solve_requires_detections():
    s = StudioSession()
    with pytest.raises(RuntimeError):
        s.capture([0, 0, 1], [0, 0, 0])
    s.set_scene("line", 16, 1.0)
    with pytest.raises(RuntimeError):
        s.solve()


def test_zero_noise_arc_recovers_ground_truth():
    s = StudioSession()
    s.set_scene("cube", 64, 1.5)
    _arc_captures(s, views=28, arc_deg=170.0)
    res = s.solve()
    # No noise → near-perfect recovery, like the M9/M3 acceptance.
    assert res["solvedCount"] >= int(0.9 * res["ledCount"])
    assert res["maxErrorM"] < 1e-3  # < 1 mm
    assert res["map"]["stats"]["rmsReprojPxGlobal"] < 0.5


def test_noise_increases_error():
    clean = StudioSession()
    clean.set_scene("helix", 48, 1.5)
    _arc_captures(clean, views=24)
    clean_res = clean.solve()

    noisy = StudioSession()
    noisy.set_scene("helix", 48, 1.5)
    _arc_captures(
        noisy,
        views=24,
        noise=NoiseModel(pixel_noise_px=1.0, pose_noise_deg=1.0, pose_noise_pos_m=0.005),
    )
    noisy_res = noisy.solve()

    assert noisy_res["meanErrorM"] > clean_res["meanErrorM"]
    assert clean_res["meanErrorM"] < 1e-3


def test_reset_clears_captures_but_keeps_scene():
    s = StudioSession()
    s.set_scene("cube", 27, 1.0)
    _arc_captures(s, views=6)
    assert s.state()["detections"] > 0
    s.reset_captures()
    st = s.state()
    assert st["detections"] == 0 and st["views"] == 0
    assert st["ledCount"] == 27  # scene preserved


def test_noise_from_dict():
    nm = noise_from_dict(
        {"pixelNoisePx": 0.5, "poseNoiseDeg": 1.0, "poseNoisePosM": 0.003, "dropoutProb": 0.1}
    )
    assert nm.pixel_noise_px == 0.5
    assert nm.dropout_prob == 0.1
    assert noise_from_dict(None).is_zero
