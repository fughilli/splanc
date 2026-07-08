"""Visual-inertial joint pose + LED-position solver (WebXR-free exploration).

Why this exists: the production pipeline trusts the WebXR pose per §7.4 and
optimizes ONLY LED positions (bundle.py). ARCore's tracker degenerates in our
operating conditions (dim room + emissive screen + code-correlated
reflections): the 2026-07-08 trace shows pose/image correlation ≈ 0 and
multi-meter relocalization jumps, which poisons every back-projected ray.
See docs/vio-exploration.md for the full analysis and plan.

The reframe: LED detections are IDENTIFIED landmarks (the blink code solves
data association), so this is structure-from-motion with known
correspondences — poses become unknowns alongside the LED positions, and the
phone IMU (DeviceMotion accel + gyro) supplies dead reckoning between frames,
metric scale, and gravity. This module is the OFFLINE prototype of that
estimator; it deliberately trades speed for clarity.

Pipeline (`solve_vio`):

  1. Gyro-integrated rotation seeds, gravity-anchored at t0 (roll/pitch from
     the early accelerometer mean; yaw is a gauge freedom).
  2. Known-rotation linear init: with rotations fixed, every observation's
     ray-membership constraint ``(I − ww^T)(X_j − c_i) = 0`` is LINEAR in the
     camera centers and LED positions → one sparse least-squares solve gives
     the whole geometry up to scale (no essential matrix, no PnP chain).
  3. Linear visual-inertial alignment (VINS-Mono-style): solve scale s,
     gravity g and per-frame velocities from the IMU preintegration deltas.
  4. Full nonlinear VI bundle adjustment over poses, velocities, LED
     positions, constant IMU biases and gravity (scipy.least_squares, sparse
     Jacobian, Huber on the reprojection terms via the global robust loss).

Conventions match reconstruction/camera.py exactly (camera-to-world R, -Z
look, y-up world): the IMU body frame is taken to BE the camera frame (the
camera↔IMU extrinsic on a real phone is a follow-up refinement), and gravity
is nominally (0, −9.81, 0).

The accelerometer measures specific force f = R^T (a_world − g_world); the
gyro measures body angular rate ω with Ṙ = R [ω]×.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix
from scipy.sparse.linalg import lsqr

from .camera import quat_to_rotmat, rotmat_to_quat

GRAVITY = 9.81
G_WORLD = np.array([0.0, -GRAVITY, 0.0])


# ---------------------------------------------------------------------------
# SO(3) helpers (Rodrigues exp/log). Kept local and dependency-free.
# ---------------------------------------------------------------------------


def so3_exp(r: np.ndarray) -> np.ndarray:
    """Rotation matrix from a rotation vector."""
    theta = float(np.linalg.norm(r))
    if theta < 1e-12:
        return np.eye(3) + skew(r)  # first order
    k = r / theta
    kx = skew(k)
    return np.eye(3) + np.sin(theta) * kx + (1.0 - np.cos(theta)) * (kx @ kx)


def so3_log(rot: np.ndarray) -> np.ndarray:
    """Rotation vector from a rotation matrix."""
    cos_theta = float(np.clip((np.trace(rot) - 1.0) / 2.0, -1.0, 1.0))
    theta = float(np.arccos(cos_theta))
    if theta < 1e-9:
        return unskew(rot - rot.T) / 2.0
    if abs(np.pi - theta) < 1e-6:
        # Near π: extract axis from the symmetric part.
        m = (rot + np.eye(3)) / 2.0
        axis = np.sqrt(np.maximum(np.diagonal(m), 0.0))
        axis = axis / (np.linalg.norm(axis) + 1e-15)
        # Fix signs from off-diagonals.
        if m[0, 1] < 0:
            axis[1] = -axis[1]
        if m[0, 2] < 0:
            axis[2] = -axis[2]
        return theta * axis
    return theta * unskew(rot - rot.T) / (2.0 * np.sin(theta))


def skew(v: np.ndarray) -> np.ndarray:
    return np.array(
        [[0.0, -v[2], v[1]], [v[2], 0.0, -v[0]], [-v[1], v[0], 0.0]], dtype=float
    )


def unskew(m: np.ndarray) -> np.ndarray:
    return np.array([m[2, 1], m[0, 2], m[1, 0]], dtype=float)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


@dataclass
class ImuSample:
    """One DeviceMotion sample: body-frame angular rate + specific force."""

    t: float  # seconds, same clock as frame times
    gyro: np.ndarray  # rad/s, body frame
    accel: np.ndarray  # m/s^2, specific force (a − g), body frame


@dataclass
class FrameObservations:
    """One camera frame's decoded LED observations (id-labeled pixels)."""

    t: float  # seconds
    k: Tuple[float, float, float, float]  # fx, fy, cx, cy
    obs: List[Tuple[int, float, float]]  # (ledId, u, v)


@dataclass
class VioResult:
    led_positions: Dict[int, np.ndarray]
    positions: np.ndarray  # (N, 3) camera centers
    quats: np.ndarray  # (N, 4) camera-to-world [x, y, z, w]
    velocities: np.ndarray  # (N, 3)
    gravity: np.ndarray  # (3,) estimated world gravity vector
    gyro_bias: np.ndarray
    accel_bias: np.ndarray
    rms_reproj_px: float


# ---------------------------------------------------------------------------
# IMU preintegration
# ---------------------------------------------------------------------------


def preintegrate(
    samples: Sequence[ImuSample],
    t0: float,
    t1: float,
    gyro_bias: np.ndarray,
    accel_bias: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, float]:
    """Preintegrate IMU samples over [t0, t1] (body frame at t0).

    Returns (ΔR, Δv, Δp, Δt) such that, with world states:
        R1 = R0 · ΔR
        v1 = v0 + g·Δt + R0 · Δv
        p1 = p0 + v0·Δt + ½·g·Δt² + R0 · Δp

    Piecewise-constant (zero-order hold) integration: each sample's rates are
    held until the next sample (or t1). Bias correction is by re-integration
    (adequate offline; the Forster bias-Jacobian refinement is a later
    optimization).
    """
    d_rot = np.eye(3)
    d_vel = np.zeros(3)
    d_pos = np.zeros(3)
    # Segment boundaries: every sample time inside (t0, t1). The rates active
    # over [t0, first-inside) come from the LAST sample at/before t0 —
    # dropping that leading span under-integrates every interval by up to one
    # sample period (a systematic scale bias, seen as 13% in the first
    # prototype run).
    in_window = [s for s in samples if t0 < s.t < t1]
    before = [s for s in samples if s.t <= t0]
    active = before[-1] if before else (in_window[0] if in_window else None)
    if active is None:
        return d_rot, d_vel, d_pos, t1 - t0
    bounds = [t0] + [s.t for s in in_window] + [t1]
    rates = [active] + in_window
    for seg, s in zip(range(len(rates)), rates):
        dt = bounds[seg + 1] - bounds[seg]
        if dt <= 0:
            continue
        acc = s.accel - accel_bias
        d_pos = d_pos + d_vel * dt + 0.5 * (d_rot @ acc) * dt * dt
        d_vel = d_vel + (d_rot @ acc) * dt
        d_rot = d_rot @ so3_exp((s.gyro - gyro_bias) * dt)
    return d_rot, d_vel, d_pos, t1 - t0


# ---------------------------------------------------------------------------
# Initialization
# ---------------------------------------------------------------------------


def _rotation_seeds(
    frames: Sequence[FrameObservations], imu: Sequence[ImuSample]
) -> List[np.ndarray]:
    """Camera-to-world rotation seed per frame: gyro-integrated increments,
    with roll/pitch anchored by the early-capture accelerometer mean (gravity
    dominates handheld motion accelerations ~30:1). Yaw is a gauge freedom."""
    t_start = frames[0].t
    early = [s.accel for s in imu if s.t <= t_start + 0.5] or [imu[0].accel]
    f_dir = np.mean(early, axis=0)
    f_dir = f_dir / np.linalg.norm(f_dir)
    up_world = np.array([0.0, 1.0, 0.0])
    # R0 must map the measured specific-force direction (≈ −gravity in body
    # frame) onto world up: R0 @ f_dir = ŷ, yaw chosen arbitrarily.
    axis = np.cross(f_dir, up_world)
    s = float(np.linalg.norm(axis))
    c = float(np.dot(f_dir, up_world))
    if s < 1e-9:
        r0 = np.eye(3) if c > 0 else so3_exp(np.array([np.pi, 0.0, 0.0]))
    else:
        r0 = so3_exp(axis / s * np.arctan2(s, c))
    zero = np.zeros(3)
    seeds = [r0]
    for i in range(1, len(frames)):
        d_rot, _dv, _dp, _dt = preintegrate(imu, frames[i - 1].t, frames[i].t, zero, zero)
        seeds.append(seeds[-1] @ d_rot)
    return seeds


def _known_rotation_linear_init(
    frames: Sequence[FrameObservations],
    rotations: Sequence[np.ndarray],
    led_ids: Sequence[int],
) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
    """Solve camera centers + LED positions with rotations held fixed.

    Every observation constrains its LED to lie on a known world-direction ray
    through the (unknown) camera center: (I − ww^T)(X_j − c_i) = 0 — linear.
    Gauge: c_0 = 0; scale is fixed by pinning the first observation's depth
    to 1 (metric scale comes later from the IMU alignment).
    """
    id_index = {led: j for j, led in enumerate(led_ids)}
    n_frames = len(frames)
    n_leds = len(led_ids)
    n_unknowns = 3 * (n_frames - 1) + 3 * n_leds  # c_0 fixed at origin

    rows: List[Tuple[int, np.ndarray, int]] = []  # (frame idx, projector row, led col)
    a = lil_matrix((0, 0))  # placeholder; built below once count is known
    triplets: List[Tuple[int, int, float]] = []
    rhs: List[float] = []
    row = 0

    def col_c(i: int) -> Optional[int]:
        return None if i == 0 else 3 * (i - 1)

    def col_x(j: int) -> int:
        return 3 * (n_frames - 1) + 3 * j

    scale_pin: Optional[Tuple[np.ndarray, int]] = None
    for i, fr in enumerate(frames):
        fx, fy, cx, cy = fr.k
        r = rotations[i]
        for led, u, v in fr.obs:
            d_cam = np.array([(u - cx) / fx, -(v - cy) / fy, -1.0])
            w = r @ d_cam
            w = w / np.linalg.norm(w)
            proj = np.eye(3) - np.outer(w, w)  # rank 2
            j = id_index[led]
            for rr in range(3):
                for cc in range(3):
                    val = proj[rr, cc]
                    if abs(val) < 1e-14:
                        continue
                    triplets.append((row + rr, col_x(j) + cc, val))
                    ci = col_c(i)
                    if ci is not None:
                        triplets.append((row + rr, ci + cc, -val))
            row += 3
            if scale_pin is None and i == 0:
                scale_pin = (w, j)
    # Scale gauge: depth of the first frame-0 observation = 1  →  w·X_j = 1.
    assert scale_pin is not None, "frame 0 has no observations"
    w0, j0 = scale_pin
    for cc in range(3):
        triplets.append((row, col_x(j0) + cc, float(w0[cc])))
    rhs_vec = np.zeros(row + 1)
    rhs_vec[row] = 1.0
    row += 1

    a = lil_matrix((row, n_unknowns))
    for rr, cc, val in triplets:
        a[rr, cc] += val
    sol = lsqr(a.tocsr(), rhs_vec, atol=1e-10, btol=1e-10, iter_lim=8000)[0]

    centers = np.zeros((n_frames, 3))
    centers[1:] = sol[: 3 * (n_frames - 1)].reshape(-1, 3)
    leds = {led: sol[col_x(j) : col_x(j) + 3].copy() for led, j in id_index.items()}
    return centers, leds


def _inertial_alignment(
    frames: Sequence[FrameObservations],
    rotations: Sequence[np.ndarray],
    centers: np.ndarray,
    imu: Sequence[ImuSample],
) -> Tuple[float, np.ndarray, np.ndarray]:
    """Linear solve for metric scale, gravity and per-frame velocities from
    the zero-bias preintegration deltas (VINS-Mono-style initialization).

    Unknowns [s, g(3), v_0..v_{N-1}(3N)]; each consecutive-frame interval
    contributes the Δp and Δv preintegration equations.
    """
    n = len(frames)
    zero = np.zeros(3)
    n_unknowns = 1 + 3 + 3 * n
    rows = []
    rhs = []
    for i in range(n - 1):
        d_rot, d_vel, d_pos, dt = preintegrate(imu, frames[i].t, frames[i + 1].t, zero, zero)
        ri = rotations[i]
        rit = ri.T
        # R_i^T (s·(c_j − c_i) − v_i·dt − ½·g·dt²) = Δp
        row_p = np.zeros((3, n_unknowns))
        row_p[:, 0] = rit @ (centers[i + 1] - centers[i])
        row_p[:, 1:4] = -0.5 * dt * dt * rit
        row_p[:, 4 + 3 * i : 7 + 3 * i] = -dt * rit
        rows.append(row_p)
        rhs.append(d_pos)
        # R_i^T (v_j − v_i − g·dt) = Δv
        row_v = np.zeros((3, n_unknowns))
        row_v[:, 1:4] = -dt * rit
        row_v[:, 4 + 3 * i : 7 + 3 * i] = -rit
        row_v[:, 4 + 3 * (i + 1) : 7 + 3 * (i + 1)] = rit
        rows.append(row_v)
        rhs.append(d_vel)
    a = np.vstack(rows)
    b = np.concatenate(rhs)
    sol, *_ = np.linalg.lstsq(a, b, rcond=None)
    s = float(sol[0])
    g = sol[1:4]
    v = sol[4:].reshape(n, 3)
    return s, g, v


# ---------------------------------------------------------------------------
# Full visual-inertial bundle adjustment
# ---------------------------------------------------------------------------


def solve_vio(
    frames: Sequence[FrameObservations],
    imu: Sequence[ImuSample],
    *,
    px_sigma: float = 0.5,
    gyro_noise: float = 2e-3,  # rad/s at the sample rate
    accel_noise: float = 5e-2,  # m/s² at the sample rate
    huber_px: float = 4.0,
    max_nfev: int = 60,
) -> VioResult:
    """Jointly estimate camera trajectory and LED positions; no pose input.

    `frames` must be time-ordered; `imu` must cover the frame time span.
    Returns a metric, gravity-consistent solution in an arbitrary yaw/origin
    gauge (pose 0 pinned at its seed).
    """
    frames = list(frames)
    led_ids = sorted({led for fr in frames for led, _u, _v in fr.obs})
    n = len(frames)
    m = len(led_ids)
    id_index = {led: j for j, led in enumerate(led_ids)}

    # ---- Stages 1–3: seeds --------------------------------------------------
    rotations = _rotation_seeds(frames, imu)
    centers, led_seed = _known_rotation_linear_init(frames, rotations, led_ids)
    scale, g_seed, v_seed = _inertial_alignment(frames, rotations, centers, imu)
    centers = centers * scale
    led_seed = {led: x * scale for led, x in led_seed.items()}

    # ---- Stage 4: nonlinear VI-BA -------------------------------------------
    # Parameter vector layout:
    #   per frame i: rotvec(3), p(3), v(3)      → 9n
    #   per led j:   X(3)                       → 3m
    #   gyro bias(3), accel bias(3), gravity(3) → 9
    def pack(rots, ps, vs, leds, bg, ba, g) -> np.ndarray:
        parts = []
        for i in range(n):
            parts.append(so3_log(rots[i]))
            parts.append(ps[i])
            parts.append(vs[i])
        for led in led_ids:
            parts.append(leds[led])
        parts += [bg, ba, g]
        return np.concatenate(parts)

    def unpack(x):
        pose = x[: 9 * n].reshape(n, 9)
        rots = [so3_exp(pose[i, 0:3]) for i in range(n)]
        ps = pose[:, 3:6]
        vs = pose[:, 6:9]
        leds = x[9 * n : 9 * n + 3 * m].reshape(m, 3)
        bg = x[-9:-6]
        ba = x[-6:-3]
        g = x[-3:]
        return rots, ps, vs, leds, bg, ba, g

    x0 = pack(
        rotations,
        centers,
        v_seed,
        led_seed,
        np.zeros(3),
        np.zeros(3),
        g_seed,
    )
    rot0_seed = so3_log(rotations[0])

    # Interval sample counts drive the preintegration noise scaling.
    obs_flat = [
        (i, id_index[led], u, v) for i, fr in enumerate(frames) for led, u, v in fr.obs
    ]
    intervals = list(range(n - 1))

    def interval_sigmas(i: int) -> Tuple[float, float, float]:
        t0, t1 = frames[i].t, frames[i + 1].t
        cnt = max(1, sum(1 for s in imu if t0 <= s.t < t1))
        dt = (t1 - t0) / cnt
        sr = gyro_noise * np.sqrt(cnt) * dt
        sv = accel_noise * np.sqrt(cnt) * dt
        sp = 0.5 * accel_noise * np.sqrt(cnt) * dt * (t1 - t0)
        return max(sr, 1e-6), max(sv, 1e-6), max(sp, 1e-7)

    sigmas = [interval_sigmas(i) for i in intervals]

    def residuals(x: np.ndarray) -> np.ndarray:
        rots, ps, vs, leds, bg, ba, g = unpack(x)
        out = np.empty(2 * len(obs_flat) + 9 * len(intervals) + 3 + 3 + 1 + 6)
        k = 0
        # Reprojection.
        for i, j, u, v in obs_flat:
            fx, fy, cx, cy = frames[i].k
            xc = rots[i].T @ (leds[j] - ps[i])
            depth = -xc[2]
            if depth <= 1e-6:
                out[k] = out[k + 1] = 50.0  # behind the camera: hard penalty
                k += 2
                continue
            uu = cx + fx * xc[0] / depth
            vv = cy - fy * xc[1] / depth
            out[k] = (uu - u) / px_sigma
            out[k + 1] = (vv - v) / px_sigma
            k += 2
        # IMU preintegration factors.
        for idx, i in enumerate(intervals):
            d_rot, d_vel, d_pos, dt = preintegrate(imu, frames[i].t, frames[i + 1].t, bg, ba)
            sr, sv, sp = sigmas[idx]
            r_err = so3_log(d_rot.T @ rots[i].T @ rots[i + 1])
            v_err = rots[i].T @ (vs[i + 1] - vs[i] - g * dt) - d_vel
            p_err = rots[i].T @ (ps[i + 1] - ps[i] - vs[i] * dt - 0.5 * g * dt * dt) - d_pos
            out[k : k + 3] = r_err / sr
            out[k + 3 : k + 6] = v_err / sv
            out[k + 6 : k + 9] = p_err / sp
            k += 9
        # Bias priors (biases are small and constant per session).
        out[k : k + 3] = bg / 5e-3
        out[k + 3 : k + 6] = ba / 5e-2
        k += 6
        # Gravity magnitude prior (direction is free — it absorbs the seed
        # attitude error left by pinning pose 0).
        out[k] = (np.linalg.norm(g) - GRAVITY) / 1e-3
        k += 1
        # Gauge: pin pose 0 (position + full attitude seed; yaw is arbitrary
        # and roll/pitch error transfers into the gravity estimate).
        out[k : k + 3] = (x[0:3] - rot0_seed) / 1e-6
        out[k + 3 : k + 6] = x[3:6] / 1e-6
        return out

    # Sparsity pattern for 2-point finite differencing.
    n_res = 2 * len(obs_flat) + 9 * len(intervals) + 6 + 1 + 6
    n_par = 9 * n + 3 * m + 9
    spar = lil_matrix((n_res, n_par), dtype=np.uint8)
    k = 0
    for i, j, _u, _v in obs_flat:
        spar[k : k + 2, 9 * i : 9 * i + 6] = 1
        spar[k : k + 2, 9 * n + 3 * j : 9 * n + 3 * j + 3] = 1
        k += 2
    for i in intervals:
        spar[k : k + 9, 9 * i : 9 * i + 18] = 1  # poses i and i+1
        spar[k : k + 9, n_par - 9 : n_par] = 1  # biases + gravity
        k += 9
    spar[k : k + 6, n_par - 9 : n_par - 3] = 1
    k += 6
    spar[k, n_par - 3 : n_par] = 1
    k += 1
    spar[k : k + 6, 0:6] = 1

    fit = least_squares(
        residuals,
        x0,
        jac_sparsity=spar.tocsr(),
        loss="huber",
        f_scale=huber_px / px_sigma,
        max_nfev=max_nfev,
        x_scale="jac",
        tr_solver="lsmr",
    )

    rots, ps, vs, leds, bg, ba, g = unpack(fit.x)
    reproj = fit.fun[: 2 * len(obs_flat)] * px_sigma
    rms = float(np.sqrt(np.mean(reproj**2)))
    quats = np.array([rotmat_to_quat(r) for r in rots])
    return VioResult(
        led_positions={led: leds[id_index[led]].copy() for led in led_ids},
        positions=ps.copy(),
        quats=quats,
        velocities=vs.copy(),
        gravity=g.copy(),
        gyro_bias=bg.copy(),
        accel_bias=ba.copy(),
        rms_reproj_px=rms,
    )


# ---------------------------------------------------------------------------
# Evaluation helper: similarity (Horn) alignment for gauge-free comparison.
# ---------------------------------------------------------------------------


def similarity_align(
    src: np.ndarray, dst: np.ndarray
) -> Tuple[float, np.ndarray, np.ndarray]:
    """Least-squares similarity transform mapping src → dst.

    Returns (s, R, t) with dst ≈ s·R·src + t. Used by tests/evaluation to
    compare a gauge-free solution against ground truth; the residual scale
    factor is also the metric-scale error when the solution CLAIMS metric
    units (|s − 1|).
    """
    src = np.asarray(src, float)
    dst = np.asarray(dst, float)
    mu_s = src.mean(axis=0)
    mu_d = dst.mean(axis=0)
    sc = src - mu_s
    dc = dst - mu_d
    cov = dc.T @ sc / len(src)
    u, d, vt = np.linalg.svd(cov)
    sgn = np.eye(3)
    if np.linalg.det(u @ vt) < 0:
        sgn[2, 2] = -1.0
    rot = u @ sgn @ vt
    var = (sc**2).sum() / len(src)
    s = float(np.trace(np.diag(d) @ sgn) / var)
    t = mu_d - s * rot @ mu_s
    return s, rot, t
