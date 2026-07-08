"""VIO prototype acceptance (docs/vio-exploration.md §7).

Synthetic 6×6 LED wall + handheld-style arc walk with web-platform-pessimistic
IMU (60 Hz DeviceMotion, noise, constant biases, timestamp jitter). NO pose is
given to the solver — it must recover the trajectory AND the LED map from
id-labeled pixels + IMU alone, metrically (scale from the accelerometer).

The control test feeds the SAME observations to the production pose-trusting
solver paired with WebXR-degenerate poses (drift + relocalization jumps,
calibrated to the 2026-07-08 real-trace statistics) and shows the failure
mode this work eliminates.
"""

from __future__ import annotations

import numpy as np
import pytest

from reconstruction.api import reconstruct
from reconstruction.camera import look_at_quat, project, quat_to_rotmat
from reconstruction.vio import (
    FrameObservations,
    ImuSample,
    G_WORLD,
    preintegrate,
    similarity_align,
    so3_exp,
    so3_log,
    solve_vio,
)

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


# ---------------------------------------------------------------------------


def test_preintegration_matches_true_relative_states():
    imu = synth_imu(noise=False)
    times = np.array([2.0, 2.125])
    rots, ps, vs = true_states(times)
    zero = np.zeros(3)
    d_rot, d_vel, d_pos, dt = preintegrate(imu, times[0], times[1], zero, zero)
    # Predicted end state from the preintegration relation.
    r1 = rots[0] @ d_rot
    v1 = vs[0] + G_WORLD * dt + rots[0] @ d_vel
    p1 = ps[0] + vs[0] * dt + 0.5 * G_WORLD * dt * dt + rots[0] @ d_pos
    assert np.linalg.norm(so3_log(r1.T @ rots[1])) < 2e-3
    assert np.linalg.norm(v1 - vs[1]) < 5e-3
    assert np.linalg.norm(p1 - ps[1]) < 1e-3


def test_vio_recovers_map_metrically_without_poses():
    leds = wall_leds()
    frames, _times = synth_frames(leds)
    imu = synth_imu()

    result = solve_vio(frames, imu)

    ids = sorted(result.led_positions.keys())
    assert len(ids) == len(leds)
    est = np.array([result.led_positions[j] for j in ids])
    truth = leds[ids]

    s, rot, t = similarity_align(est, truth)
    aligned = (s * (rot @ est.T)).T + t
    rms = float(np.sqrt(np.mean(np.sum((aligned - truth) ** 2, axis=1))))
    scale_err = abs(s - 1.0)
    g_est_world = rot @ result.gravity  # into the truth frame for comparison
    g_angle = np.degrees(
        np.arccos(
            np.clip(
                np.dot(g_est_world, G_WORLD) / (np.linalg.norm(g_est_world) * 9.81),
                -1,
                1,
            )
        )
    )

    print(
        f"\nVIO synthetic acceptance: map rms {rms*1000:.2f} mm, "
        f"scale err {scale_err*100:.2f} %, gravity err {g_angle:.2f}°, "
        f"reproj rms {result.rms_reproj_px:.2f} px"
    )
    assert rms < 0.005, f"map rms {rms*1000:.2f} mm"
    assert scale_err < 0.02, f"scale error {scale_err*100:.2f}%"
    assert g_angle < 1.5, f"gravity direction error {g_angle:.2f}°"
    assert result.rms_reproj_px < 1.0


def _webxr_corrupt_poses(times: np.ndarray):
    """WebXR-degenerate pose stream: random-walk drift + relocalization jumps,
    magnitudes calibrated to the 2026-07-08 trace (13 m claimed path over a
    0.5 m walk; jumps up to 2.3 m)."""
    rots, ps, _vs = true_states(times)
    drift = np.zeros(3)
    rot_drift = np.eye(3)
    out = []
    jump_frames = set(RNG.choice(len(times), size=3, replace=False).tolist())
    for i, _t in enumerate(times):
        drift = drift + RNG.normal(0, 0.008, 3)  # ~8 mm/frame random walk
        if i in jump_frames:
            drift = drift + RNG.normal(0, 0.4, 3)  # relocalization snap
        rot_drift = rot_drift @ so3_exp(RNG.normal(0, np.radians(0.3), 3))
        r = rots[i] @ rot_drift
        from reconstruction.camera import rotmat_to_quat

        out.append((ps[i] + drift, rotmat_to_quat(r)))
    return out


def test_pose_trusting_solver_breaks_on_webxr_drift_but_vio_does_not():
    leds = wall_leds()
    frames, times = synth_frames(leds)
    corrupt = _webxr_corrupt_poses(times)

    records = []
    for fr, (p, q) in zip(frames, corrupt):
        for j, u, v in fr.obs:
            records.append(
                {
                    "ledId": int(j),
                    "tCaptureMs": fr.t * 1000.0,
                    "u": u,
                    "v": v,
                    "imgW": IMG_W,
                    "imgH": IMG_H,
                    "K": list(K),
                    "pose": {"p": [float(x) for x in p], "q": [float(x) for x in q]},
                    "confidence": 1.0,
                }
            )
    output = reconstruct(records, led_count=len(leds))
    solved = {e.id: np.array(e.xyz) for e in output.leds}
    ids = sorted(solved.keys())
    if len(ids) >= 4:
        est = np.array([solved[j] for j in ids])
        truth = leds[ids]
        s, rot, t = similarity_align(est, truth)
        aligned = (s * (rot @ est.T)).T + t
        rms_trusting = float(np.sqrt(np.mean(np.sum((aligned - truth) ** 2, axis=1))))
    else:
        rms_trusting = float("inf")  # couldn't even solve

    print(f"\npose-trusting solver on WebXR-drift poses: map rms {rms_trusting*1000:.1f} mm")
    # The production solver, fed drifting poses, is off by centimeters+ —
    # two orders of magnitude worse than the VIO acceptance bound above.
    assert rms_trusting > 0.02, "expected the pose-trusting solver to fail on drifting poses"


def test_wrong_focal_preserves_shape_and_scale_tracks_fx_error():
    """Focal-length observability, measured honestly: in a wall-facing walk
    fx trades almost one-for-one against METRIC SCALE (image geometry is
    invariant when depth scales with fx; the radial-motion signal that
    separates them is weak vs pixel noise + trajectory slack). The probe:
    an 8 % fx error leaves the SHAPE essentially perfect and moves metric
    scale by ~the same 8 %.

    Consequence for the WebXR-free path (docs/vio-exploration.md): a FOV
    guess gives a correct map up to a few-% metric scale; a calibrated fx
    (from a previous WebXR session's projectionMatrix K, cached per device,
    or a known-pitch wall) restores metric accuracy. refine_intrinsics
    exists as a polish, not a discovery mechanism.
    """
    global RADIAL_AMP
    RADIAL_AMP = 0.35
    try:
        leds = wall_leds()
        frames, _times = synth_frames(leds)
        imu = synth_imu()
    finally:
        RADIAL_AMP = 0.0
    fx_true = K[0]
    k_guess = (fx_true * 1.08, fx_true * 1.08, K[2] + 15.0, K[3] - 12.0)
    frames_wrong_k = [FrameObservations(t=f.t, k=k_guess, obs=f.obs) for f in frames]

    result = solve_vio(frames_wrong_k, imu, max_nfev=150)
    ids = sorted(result.led_positions.keys())
    est = np.array([result.led_positions[j] for j in ids])
    s, rot, t = similarity_align(est, leds[ids])
    aligned = (s * (rot @ est.T)).T + t
    shape_rms = float(np.sqrt(np.mean(np.sum((aligned - leds[ids]) ** 2, axis=1))))
    scale_err = abs(s - 1.0)
    print(f"\n8% wrong fx: shape rms {shape_rms*1000:.2f} mm, "
          f"metric scale err {scale_err*100:.2f} %, reproj {result.rms_reproj_px:.2f} px")
    assert shape_rms < 0.005, f"shape rms {shape_rms*1000:.2f} mm"
    assert result.rms_reproj_px < 1.0
    # Scale error tracks the fx error (the trade-off this test documents).
    assert 0.04 < scale_err < 0.12, f"scale err {scale_err*100:.2f}%"

    # refine_intrinsics is a polish: it must not make anything worse, and it
    # returns the shared K it settled on.
    refined = solve_vio(frames_wrong_k, imu, refine_intrinsics=True, max_nfev=120)
    assert refined.intrinsics is not None
    assert refined.rms_reproj_px < 1.0


def test_reconstruct_vio_wire_end_to_end():
    # The production path: §7.4 records with pose=None + imu_batch samples in
    # wire format -> gravity-leveled OutputMap.
    from reconstruction.vio_api import reconstruct_vio

    leds = wall_leds()
    frames, _times = synth_frames(leds)
    imu = synth_imu()

    records = []
    for fr in frames:
        for j, u, v in fr.obs:
            records.append(
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
            )
    imu_wire = [
        {"t": s.t * 1000.0, "gyro": [float(x) for x in s.gyro], "accel": [float(x) for x in s.accel]}
        for s in imu
    ]
    progress = []
    out = reconstruct_vio(
        records,
        imu_wire,
        led_count=len(leds),
        refine_intrinsics=False,
        progress_cb=lambda frac, leds_now, rms, positions: progress.append(
            (frac, len(leds_now), rms, len(positions))
        ),
    )

    # The optimizer reported throttled progress snapshots: fractions ascend
    # within [0, 1), interim maps carry every LED, camera path present.
    assert progress, "progress callback never fired"
    fracs = [p[0] for p in progress]
    assert all(0 <= f < 1 for f in fracs)
    assert fracs == sorted(fracs)
    assert all(p[1] == len(leds) for p in progress)
    assert all(p[3] > 0 for p in progress)

    # The final map carries the solved camera path for the viewport overlay.
    assert out.trajectory is not None and len(out.trajectory) > 10
    traj = np.array(out.trajectory)
    assert np.linalg.norm(traj[-1] - traj[0]) > 0.1  # a real walk, leveled frame

    assert out.frame == "gravity_leveled"
    assert len(out.leds) == len(leds) and not out.unmapped
    assert out.stats.rmsReprojPxGlobal < 1.0
    # Gravity-leveled: the wall was built in the x/y plane in a y-up world,
    # so the solved wall must be near-vertical — its plane normal ⊥ Y.
    pts = np.array([e.xyz for e in out.leds])
    centered = pts - pts.mean(axis=0)
    _u, _sv, vt = np.linalg.svd(centered, full_matrices=False)
    assert abs(vt[2][1]) < 0.05, f"wall normal has y-component {vt[2][1]:.3f}"
    # Quality fields are populated with the shared conventions.
    assert all(e.nViews >= 2 for e in out.leds)
    assert all(0.0 <= e.confidence <= 1.0 for e in out.leds)
    assert np.median([e.parallaxDeg for e in out.leds]) > 10


def test_pose_trusting_solver_rejects_poseless_records():
    with pytest.raises(ValueError, match="no pose"):
        reconstruct(
            [
                {
                    "ledId": 0,
                    "tCaptureMs": 0.0,
                    "u": 1.0,
                    "v": 1.0,
                    "imgW": IMG_W,
                    "imgH": IMG_H,
                    "K": list(K),
                    "pose": None,
                    "confidence": 1.0,
                }
            ]
            * 3,
            led_count=1,
        )
