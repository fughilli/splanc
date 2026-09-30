"""Unit tests for M3 reconstruction seams (design doc §10.2).

These are self-contained (no simulator dependency): they build synthetic
observations directly from the camera model and known 3D points, so a failure
points squarely at the projection math, the triangulator, or the BA solver.
The full M9→M3 pipeline acceptance lives in the simulator package.
"""

from __future__ import annotations

import numpy as np
import pytest
from reconstruction import back_project_ray, look_at_quat, project, reconstruct

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-11", "PR-31")


def _camera_at(eye, target=(0.0, 0.0, 0.0)):
    eye = np.asarray(eye, dtype=float)
    q = look_at_quat(eye, np.asarray(target, dtype=float))
    return eye, q


K = [900.0, 900.0, 640.0, 360.0]


def test_project_backproject_are_inverse():
    p, q = _camera_at((1.0, 0.5, 2.0), (0.0, 0.0, 0.0))
    x_world = np.array([0.2, -0.1, 0.3])
    uv, depth = project(p, q, K, x_world)
    assert depth > 0
    origin, direction = back_project_ray(p, q, K, uv[0], uv[1])
    # The true point lies along the ray at distance ~depth.
    t = np.dot(x_world - origin, direction)
    closest = origin + t * direction
    assert np.linalg.norm(closest - x_world) < 1e-9
    # And reprojecting a point along the ray returns the same pixel.
    uv2, _ = project(p, q, K, origin + 5.0 * direction)
    assert np.allclose(uv2, uv, atol=1e-6)


def test_point_in_front_projects_inside_reasonable_range():
    p, q = _camera_at((0.0, 0.0, 3.0))
    uv, depth = project(p, q, K, np.array([0.0, 0.0, 0.0]))
    # Looking straight at the origin: it lands at the principal point.
    assert np.allclose(uv, [640.0, 360.0], atol=1e-6)
    assert depth > 0


def _synthetic_detections(points, eyes, k=K, noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    detections = []
    for eye in eyes:
        p, q = _camera_at(eye, target=points.mean(axis=0))
        for led_id, x in enumerate(points):
            uv, depth = project(p, q, k, x)
            if depth <= 0:
                continue
            u = uv[0] + rng.normal(0, noise)
            v = uv[1] + rng.normal(0, noise)
            detections.append(
                {
                    "ledId": led_id,
                    "tCaptureMs": 0.0,
                    "u": float(u),
                    "v": float(v),
                    "imgW": 1280,
                    "imgH": 720,
                    "K": list(k),
                    "pose": {"p": [float(c) for c in p], "q": [float(c) for c in q]},
                    "confidence": 1.0,
                }
            )
    return detections


def test_reconstruct_recovers_known_points_zero_noise():
    # A small 3D point cloud.
    points = np.array(
        [
            [0.0, 0.0, 0.0],
            [0.3, 0.0, 0.0],
            [0.0, 0.25, 0.1],
            [-0.2, -0.15, -0.1],
            [0.15, 0.2, -0.2],
        ]
    )
    # An arc of viewpoints around it (parallax).
    angles = np.linspace(-0.9, 0.9, 8)
    eyes = [[2.0 * np.sin(a), 0.3, 2.0 * np.cos(a)] for a in angles]
    detections = _synthetic_detections(points, eyes, noise=0.0)

    out = reconstruct(detections, led_count=len(points))
    assert len(out.leds) == len(points)
    assert out.unmapped == []
    by_id = {e.id: np.array(e.xyz) for e in out.leds}
    errors = [np.linalg.norm(by_id[i] - points[i]) for i in range(len(points))]
    max_err_mm = max(errors) * 1000.0
    assert max_err_mm < 1.0, f"max error {max_err_mm:.4f} mm exceeds 1 mm"
    assert out.stats.rmsReprojPxGlobal < 1e-3


def test_low_view_led_is_unmapped():
    points = np.array([[0.0, 0.0, 0.0], [0.3, 0.1, 0.0]])
    eyes = [[2.0, 0.3, 2.0], [-2.0, 0.3, 2.0]]
    detections = _synthetic_detections(points, eyes, noise=0.0)
    # Strip LED 1 down to a single observation.
    seen = 0
    pruned = []
    for d in detections:
        if d["ledId"] == 1:
            seen += 1
            if seen > 1:
                continue
        pruned.append(d)
    out = reconstruct(pruned, led_count=2, min_views=2)
    assert 1 in out.unmapped
    assert {e.id for e in out.leds} == {0}


def test_outlier_observation_is_rejected():
    points = np.array([[0.0, 0.0, 0.0], [0.2, 0.1, 0.05], [-0.1, 0.2, -0.05]])
    angles = np.linspace(-0.9, 0.9, 10)
    eyes = [[2.0 * np.sin(a), 0.2, 2.0 * np.cos(a)] for a in angles]
    detections = _synthetic_detections(points, eyes, noise=0.0)
    # Corrupt one observation of LED 0 with a large pixel error.
    for d in detections:
        if d["ledId"] == 0:
            d["u"] += 80.0
            break
    out = reconstruct(detections, led_count=len(points))
    by_id = {e.id: np.array(e.xyz) for e in out.leds}
    # Despite the gross outlier, LED 0 is recovered accurately.
    assert np.linalg.norm(by_id[0] - points[0]) * 1000.0 < 1.0


def test_majority_contamination_recovered_by_consensus():
    """Reflections/exposure artifacts blink the LED's own code, so an LED's
    observation set can be MAJORITY-wrong — beyond MAD rejection (which needs
    a good median). The consensus pre-filter must find the true mode."""
    true_point = np.array([[0.1, 0.05, 0.0]])
    angles = np.linspace(-0.9, 0.9, 12)
    eyes = [[2.0 * np.sin(a), 0.3, 2.0 * np.cos(a)] for a in angles]
    detections = _synthetic_detections(true_point, eyes, noise=0.0)
    assert len(detections) == 12

    # Add 60% contamination: same id, uniformly random pixels per view.
    rng = np.random.default_rng(7)
    junk = []
    for eye in eyes + eyes[:6]:
        p, q = _camera_at(eye, target=true_point.mean(axis=0))
        junk.append(
            {
                "ledId": 0,
                "tCaptureMs": 0.0,
                "u": float(rng.uniform(0, 1280)),
                "v": float(rng.uniform(0, 720)),
                "imgW": 1280,
                "imgH": 720,
                "K": list(K),
                "pose": {"p": [float(c) for c in p], "q": [float(c) for c in q]},
                "confidence": 1.0,
            }
        )
    out = reconstruct(detections + junk, led_count=1)
    assert len(out.leds) == 1
    err_mm = np.linalg.norm(np.array(out.leds[0].xyz) - true_point[0]) * 1000.0
    assert err_mm < 1.0, f"contaminated solve missed by {err_mm:.2f} mm"
    # The clean views survive; the junk is excluded from the fit.
    assert out.leds[0].nViews >= 10


def test_warm_start_matches_cold_solve():
    """initial_points seeding (the continuous solver's warm start) must land
    on the same solution as a cold solve — it only changes the starting
    point, not the optimum."""
    points = np.array([[0.0, 0.0, 0.0], [0.2, 0.1, 0.05], [-0.1, 0.2, -0.05]])
    angles = np.linspace(-0.9, 0.9, 10)
    eyes = [[2.0 * np.sin(a), 0.2, 2.0 * np.cos(a)] for a in angles]
    detections = _synthetic_detections(points, eyes, noise=0.3, seed=3)

    cold = reconstruct(detections, led_count=len(points))
    seeds = {e.id: e.xyz for e in cold.leds}
    # Perturb the seeds a little, like a map that moved between interim solves.
    seeds = {i: (x + 0.004, y - 0.003, z + 0.002) for i, (x, y, z) in seeds.items()}
    warm = reconstruct(detections, led_count=len(points), initial_points=seeds)

    cold_by = {e.id: np.array(e.xyz) for e in cold.leds}
    warm_by = {e.id: np.array(e.xyz) for e in warm.leds}
    assert set(cold_by) == set(warm_by)
    for i in cold_by:
        assert np.linalg.norm(cold_by[i] - warm_by[i]) < 1e-4, f"led {i} diverged"
