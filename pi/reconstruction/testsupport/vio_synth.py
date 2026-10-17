"""Synthetic visual-inertial capture sessions shared by the solver suites.

A 6×6 LED wall and a handheld-style arc walk with web-platform-pessimistic IMU
(60 Hz DeviceMotion, noise, constant biases, timestamp jitter). Module globals
(DURATION, RADIAL_AMP) shape the trajectory; tests adjust them in place.
"""

from __future__ import annotations

import numpy as np
from reconstruction.camera import look_at_quat, project, quat_to_rotmat
from reconstruction.vio import G_WORLD, FrameObservations, ImuSample, similarity_align, so3_log

RNG = np.random.default_rng(11)

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


# -- analytic trajectory (smooth, with real acceleration for observability) --


# Radial (toward/away) excitation, settable per test: focal length is only
# strongly observable when the wall DISTANCE varies (with metric baseline
# from the IMU, depth change separates fx from scene scale; a constant-radius
# arc leaves fx pinned only by weak perspective nonlinearity). The no-XR
# capture guidance must therefore include moving closer/farther.
RADIAL_AMP = 0.0


def cam_pos(t: float) -> np.ndarray:
    theta = -0.5 + 1.0 * (t / DURATION) + 0.12 * np.sin(1.7 * t)
    radius = 1.8 + RADIAL_AMP * np.sin(0.9 * t)
    return np.array(
        [
            radius * np.sin(theta),
            0.12 + 0.15 * np.sin(2.1 * t),
            radius * np.cos(theta),
        ]
    )


def cam_rot(t: float) -> np.ndarray:
    q = look_at_quat(cam_pos(t), np.array([0.0, 0.0, 0.0]))
    return quat_to_rotmat(q)


def true_states(times: np.ndarray):
    h = 1e-4
    rots = [cam_rot(t) for t in times]
    ps = np.array([cam_pos(t) for t in times])
    vs = np.array([(cam_pos(t + h) - cam_pos(t - h)) / (2 * h) for t in times])
    return rots, ps, vs


def synth_imu(noise: bool = True) -> list[ImuSample]:
    h = 1e-4
    gyro_bias = np.array([2e-3, -1e-3, 1.5e-3])
    accel_bias = np.array([0.03, -0.02, 0.04])
    samples = []
    n = int(DURATION * IMU_HZ)
    for i in range(n):
        t = i / IMU_HZ
        r = cam_rot(t)
        omega = so3_log(cam_rot(t).T @ cam_rot(t + h)) / h
        a_world = (cam_pos(t + h) - 2 * cam_pos(t) + cam_pos(t - h)) / (h * h)
        f_body = r.T @ (a_world - G_WORLD)
        ts = t
        if noise:
            omega = omega + gyro_bias + RNG.normal(0, 2e-3, 3)
            f_body = f_body + accel_bias + RNG.normal(0, 5e-2, 3)
            ts = t + RNG.normal(0, 1.5e-3)  # DeviceMotion timestamp jitter
        samples.append(ImuSample(t=ts, gyro=omega, accel=f_body))
    samples.sort(key=lambda s: s.t)
    return samples


def synth_frames(leds: np.ndarray, px_noise: float = 0.3, drop_p: float = 0.05):
    times = np.arange(0.0, DURATION, 1.0 / FRAME_HZ)
    frames = []
    for t in times:
        p = cam_pos(t)
        q = look_at_quat(p, np.array([0.0, 0.0, 0.0]))
        uv, depth = project(p, q, K, leds)
        obs = []
        for j in range(len(leds)):
            if depth[j] <= 0:
                continue
            u, v = uv[j]
            if not (0 <= u < IMG_W and 0 <= v < IMG_H):
                continue
            if RNG.uniform() < drop_p:
                continue
            obs.append((j, float(u + RNG.normal(0, px_noise)), float(v + RNG.normal(0, px_noise))))
        frames.append(FrameObservations(t=float(t), k=K, obs=obs))
    return frames, times


def to_records(frames) -> list:
    """Wire-shaped pose-less detection records for reconstruct_vio."""
    return [
        {
            "ledId": int(j),
            "tCaptureMs": fr.t * 1000.0,
            "u": u,
            "v": v,
            "imgW": IMG_W,
            "imgH": IMG_H,
            "K": list(K),
            "pose": None,
            "confidence": 1.0,
        }
        for fr in frames
        for j, u, v in fr.obs
    ]


def to_imu_wire(imu) -> list:
    return [
        {"t": s.t * 1000.0, "gyro": list(map(float, s.gyro)), "accel": list(map(float, s.accel))}
        for s in sorted(imu, key=lambda s: s.t)
    ]


def map_rms(out, leds: np.ndarray) -> float:
    """Similarity-aligned map error (m) of a reconstruct_vio OutputMap."""
    ids = sorted(e.id for e in out.leds)
    est = np.array([e.xyz for e in sorted(out.leds, key=lambda e: e.id)])
    s, rot, t = similarity_align(est, leds[ids])
    aligned = (s * (rot @ est.T)).T + t
    return float(np.sqrt(np.mean(np.sum((aligned - leds[ids]) ** 2, axis=1))))
