"""Cross-language solver parity: the Rust solver (//solver:solver_cli) must
functionally match the Python reference (reconstruction.vio_api) on the same
synthetic session.

Bitwise equality is not the goal — the two optimizers walk different LM
schedules — so parity is asserted in solution space: both maps must recover
the ground-truth wall to the same acceptance thresholds, and the two maps
must agree with EACH OTHER (similarity-aligned) far more tightly than either
is required to agree with truth.
"""

from __future__ import annotations

import json
import subprocess
import sys

import numpy as np
import pytest
from python.runfiles import runfiles
from reconstruction.camera import look_at_quat, project, quat_to_rotmat
from reconstruction.vio import G_WORLD, similarity_align, so3_log
from reconstruction.vio_api import reconstruct_vio

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-11", "PR-34")

RNG = np.random.default_rng(23)

IMG_W, IMG_H = 1280, 720
K = (800.0, 800.0, 640.0, 360.0)
DURATION = 12.0
FRAME_HZ = 8.0
IMU_HZ = 60.0


def wall_leds(cols: int = 6, rows: int = 6, pitch: float = 0.12) -> np.ndarray:
    pts = []
    for i in range(cols * rows):
        r, c = divmod(i, cols)
        pts.append([(c - (cols - 1) / 2) * pitch, ((rows - 1) / 2 - r) * pitch, 0.0])
    return np.array(pts)


def cam_pos(t: float) -> np.ndarray:
    theta = -0.5 + 1.0 * (t / DURATION) + 0.12 * np.sin(1.7 * t)
    return np.array([1.8 * np.sin(theta), 0.12 + 0.15 * np.sin(2.1 * t), 1.8 * np.cos(theta)])


def cam_rot(t: float) -> np.ndarray:
    return quat_to_rotmat(look_at_quat(cam_pos(t), np.zeros(3)))


def synth_session(leds: np.ndarray):
    """Wire-shaped (detections, imu) for a noisy handheld arc session."""
    h = 1e-4
    gyro_bias = np.array([2e-3, -1e-3, 1.5e-3])
    accel_bias = np.array([0.03, -0.02, 0.04])
    imu = []
    for i in range(int(DURATION * IMU_HZ)):
        t = i / IMU_HZ
        r = cam_rot(t)
        omega = so3_log(r.T @ cam_rot(t + h)) / h + gyro_bias + RNG.normal(0, 2e-3, 3)
        a_world = (cam_pos(t + h) - 2 * cam_pos(t) + cam_pos(t - h)) / (h * h)
        f_body = r.T @ (a_world - G_WORLD) + accel_bias + RNG.normal(0, 5e-2, 3)
        ts = t + RNG.normal(0, 1.5e-3)
        imu.append({"t": ts * 1000.0, "gyro": list(omega), "accel": list(f_body)})
    imu.sort(key=lambda s: s["t"])

    detections = []
    for t in np.arange(0.0, DURATION, 1.0 / FRAME_HZ):
        p = cam_pos(t)
        q = look_at_quat(p, np.zeros(3))
        uv, depth = project(p, q, K, leds)
        for j in range(len(leds)):
            if depth[j] <= 0:
                continue
            u, v = uv[j]
            if not (0 <= u < IMG_W and 0 <= v < IMG_H):
                continue
            if RNG.uniform() < 0.05:
                continue
            detections.append(
                {
                    "ledId": int(j),
                    "u": float(u + RNG.normal(0, 0.3)),
                    "v": float(v + RNG.normal(0, 0.3)),
                    "K": list(K),
                    "tCaptureMs": float(t * 1000.0),
                    "pose": None,
                }
            )
    return detections, imu


def _aligned_rms(src: np.ndarray, dst: np.ndarray):
    s, rot, t = similarity_align(src, dst)
    aligned = (s * (rot @ src.T)).T + t
    rms = float(np.sqrt(np.mean(np.sum((aligned - dst) ** 2, axis=1))))
    return rms, abs(s - 1.0)


def _solve_both(detections, imu, leds):
    """(rust map, python map) for the same wire-shaped session."""
    problem = {
        "detections": detections,
        "imu": imu,
        "ledCount": len(leds),
        "mapId": "parity-test",
        "createdAt": "2026-07-09T00:00:00Z",
    }

    solver = runfiles.Create().Rlocation("_main/solver/solver_cli")
    proc = subprocess.run(
        [solver],
        input=json.dumps(problem).encode(),
        capture_output=True,
        timeout=600,
        check=True,
    )
    rust_map = json.loads(proc.stdout)

    py_map = reconstruct_vio(detections, imu, led_count=len(leds)).model_dump()
    return rust_map, py_map


def test_rust_solver_matches_python_reference():
    leds = wall_leds()
    detections, imu = synth_session(leds)
    rust_map, py_map = _solve_both(detections, imu, leds)

    # Both solved essentially the whole wall.
    rust_ids = {led["id"] for led in rust_map["leds"]}
    py_ids = {led["id"] for led in py_map["leds"]}
    assert len(rust_ids) >= 34, f"rust solved only {len(rust_ids)}"
    assert len(py_ids) >= 34, f"python solved only {len(py_ids)}"

    # Each matches ground truth to the standard acceptance thresholds.
    for name, out in (("rust", rust_map), ("python", py_map)):
        ids = sorted(led["id"] for led in out["leds"])
        est = np.array([next(led["xyz"] for led in out["leds"] if led["id"] == i) for i in ids])
        rms, scale_err = _aligned_rms(est, leds[ids])
        print(f"{name}: vs truth rms {rms * 1000:.2f} mm, scale err {scale_err * 100:.2f}%")
        assert rms < 0.005, f"{name} map rms {rms * 1000:.2f} mm"
        assert scale_err < 0.02, f"{name} scale err {scale_err * 100:.2f}%"
        assert out["stats"]["rmsReprojPxGlobal"] < 1.5

    # And they agree with each other tighter than the truth threshold.
    common = sorted(rust_ids & py_ids)
    rust_xyz = np.array(
        [next(led["xyz"] for led in rust_map["leds"] if led["id"] == i) for i in common]
    )
    py_xyz = np.array(
        [next(led["xyz"] for led in py_map["leds"] if led["id"] == i) for i in common]
    )
    rms_cross, scale_cross = _aligned_rms(rust_xyz, py_xyz)
    print(f"cross: rust vs python rms {rms_cross * 1000:.2f} mm, scale {scale_cross * 100:.2f}%")
    assert rms_cross < 0.003, f"cross-solver rms {rms_cross * 1000:.2f} mm"
    assert scale_cross < 0.02, f"cross-solver scale err {scale_cross * 100:.2f}%"

    # Wire-shape parity: same §7.5 fields.
    assert set(rust_map.keys()) == set(py_map.keys())
    assert rust_map["units"] == "meters" and rust_map["frame"] == "gravity_leveled"


def _stride_lit(led: int, phase: int, spacing: int, anchor: int) -> bool:
    """web/src/code/stride.ts strideLit (S coverage phases + S-1 bridges)."""
    n = 2 * spacing - 1
    ph = phase % n
    if ph < spacing:
        return led % spacing == ph
    j = ph - spacing + 1
    m = led % (anchor * spacing)
    return m == 0 or m == (anchor // 2) * spacing + j


def test_rust_solver_fuses_a_strided_capture_like_python(monkeypatch):
    # The phone solves with the Rust port, so the interrupted-timeline handling
    # (vio_api / test_interrupted_capture.py) must hold there too: a strided
    # diffuse capture — disjoint LED phases, each followed by a 3.5 s
    # decode-lock dead time — fuses every phase in both implementations.
    monkeypatch.setattr(sys.modules[__name__], "DURATION", 36.0)
    leds = wall_leds()
    detections, imu = synth_session(leds)
    period = 3.0 + 3.5
    strided = []
    for d in detections:
        phase, into = divmod(d["tCaptureMs"] / 1000.0, period)
        if into < 3.0 and _stride_lit(d["ledId"], int(phase), 3, 3):
            strided.append(d)

    rust_map, py_map = _solve_both(strided, imu, leds)

    for name, out in (("rust", rust_map), ("python", py_map)):
        assert len(out["leds"]) == len(leds), f"{name} solved only {len(out['leds'])}"
        ids = sorted(led["id"] for led in out["leds"])
        est = np.array([next(led["xyz"] for led in out["leds"] if led["id"] == i) for i in ids])
        rms, _scale_err = _aligned_rms(est, leds[ids])
        assert rms < 0.005, f"{name} map rms {rms * 1000:.2f} mm"
    rust_xyz = np.array([led["xyz"] for led in sorted(rust_map["leds"], key=lambda e: e["id"])])
    py_xyz = np.array([led["xyz"] for led in sorted(py_map["leds"], key=lambda e: e["id"])])
    rms_cross, _ = _aligned_rms(rust_xyz, py_xyz)
    assert rms_cross < 0.003, f"cross-solver rms {rms_cross * 1000:.2f} mm"


def test_rust_benchmark_mode_reports_score():
    solver = runfiles.Create().Rlocation("_main/solver/solver_cli")
    proc = subprocess.run([solver, "--benchmark"], capture_output=True, timeout=600, check=True)
    score = json.loads(proc.stdout)
    assert score["ms"] > 0 and np.isfinite(score["rms"]) and score["rms"] < 5.0
