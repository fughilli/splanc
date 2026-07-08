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
from typing import Callable, Dict, List, Optional, Sequence, Tuple

# Progress hook for long solves: (progress_frac, led_positions, rms_px,
# camera_positions). Called FROM THE OPTIMIZER THREAD, throttled to a few Hz;
# consumers own their thread-safety. progress_frac is the estimated fraction
# of the evaluation budget consumed (an estimate — LM may converge earlier).
ProgressCb = Callable[[float, Dict[int, "np.ndarray"], float, "np.ndarray"], None]

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


def so3_log_batch(rots: np.ndarray) -> np.ndarray:
    """Vectorized inverse of :func:`so3_exp_batch` for rotations away from π
    (residual rotations are small; the π neighborhood falls back to the
    scalar implementation)."""
    tr = np.trace(rots, axis1=1, axis2=2)
    cos_t = np.clip((tr - 1.0) / 2.0, -1.0, 1.0)
    theta = np.arccos(cos_t)
    w = np.stack(
        [
            rots[:, 2, 1] - rots[:, 1, 2],
            rots[:, 0, 2] - rots[:, 2, 0],
            rots[:, 1, 0] - rots[:, 0, 1],
        ],
        axis=1,
    )
    sin_t = np.sin(theta)
    # theta/(2 sin theta), series-guarded at 0; π handled below.
    factor = np.where(theta > 1e-9, theta / np.maximum(2.0 * sin_t, 1e-30), 0.5)
    out = w * factor[:, None]
    near_pi = np.pi - theta < 1e-4
    if near_pi.any():
        for idx in np.nonzero(near_pi)[0]:
            out[idx] = so3_log(rots[idx])
    return out


def so3_exp_batch(r: np.ndarray) -> np.ndarray:
    """Vectorized Rodrigues: (n, 3) rotation vectors → (n, 3, 3) matrices.

    Series-guarded for small angles; agrees with :func:`so3_exp` to machine
    precision. This is the hot path of the solver's residual function (one
    batch per evaluation), hence the dedicated implementation.
    """
    r = np.asarray(r, dtype=float)
    theta = np.linalg.norm(r, axis=1)
    theta2 = theta * theta
    safe = np.maximum(theta, 1e-30)
    a = np.where(theta > 1e-8, np.sin(theta) / safe, 1.0 - theta2 / 6.0)
    b = np.where(theta > 1e-8, (1.0 - np.cos(theta)) / np.maximum(theta2, 1e-60), 0.5 - theta2 / 24.0)
    kx = np.zeros((len(r), 3, 3))
    kx[:, 0, 1] = -r[:, 2]
    kx[:, 0, 2] = r[:, 1]
    kx[:, 1, 0] = r[:, 2]
    kx[:, 1, 2] = -r[:, 0]
    kx[:, 2, 0] = -r[:, 1]
    kx[:, 2, 1] = r[:, 0]
    eye = np.broadcast_to(np.eye(3), (len(r), 3, 3))
    return eye + a[:, None, None] * kx + b[:, None, None] * (kx @ kx)


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
    # Keyframe times (s), aligned with positions/quats/velocities — what a
    # warm start joins on.
    frame_times: Optional[np.ndarray] = None
    # Refined shared camera model (fx, fy, cx, cy) when refine_intrinsics.
    intrinsics: Optional[Tuple[float, float, float, float]] = None


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
    scale_pins: int = 64,
) -> Tuple[np.ndarray, Dict[int, np.ndarray]]:
    """Solve camera centers + LED positions with rotations held fixed.

    Every observation constrains its LED to lie on a known world-direction ray
    through the (unknown) camera center: (I − ww^T)(X_j − c_i) = 0 — linear.
    Gauge: c_0 = 0; scale is fixed by pinning the MEAN depth of ~64
    observations spread across the session to 1 (metric scale comes later
    from the IMU alignment). The spread matters: pinning a single
    observation made the gauge hostage to that observation being an inlier —
    one mislabeled sample as the pin collapsed the whole linear solution
    toward zero on the 2026-07-08 real session.
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

    pin_candidates: List[Tuple[np.ndarray, int, Optional[int]]] = []  # (w, led col j, c col i)
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
            pin_candidates.append((w, j, i))
    # Scale gauge: ~64 spread observations' depths pinned to 1
    # (w·(X_j − c_i) = 1), each row DOWN-WEIGHTED. The weight resolves a
    # three-way tension, all failure modes observed on real sessions:
    #  * ONE full-strength pin → hostage to that observation being an inlier
    #    (a mislabeled pin collapsed the whole solution);
    #  * N full-strength pins → they fight each other (true depths differ)
    #    and WARP the geometry (89% metric-scale error downstream);
    #  * one sum-of-depths row → exact and shape-neutral, but loses the mild
    #    per-point depth regularization that keeps weakly-observed LEDs from
    #    wandering in ill-conditioned real sessions (collapse returned).
    # Down-weighted rows: the scale DOF has no competing constraint, so even
    # small weights fix it exactly; the shape distortion from conflicting
    # depth targets enters the least-squares trade-off ∝ weight² and becomes
    # negligible, while the weak depth regularization survives.
    assert pin_candidates, "no observations"
    stride = max(1, len(pin_candidates) // scale_pins)
    pins = pin_candidates[::stride]
    w_pin = 0.05
    rhs_vec = np.zeros(row + len(pins))
    for w0, j0, i0 in pins:
        for cc in range(3):
            triplets.append((row, col_x(j0) + cc, w_pin * float(w0[cc])))
            ci = col_c(i0)
            if ci is not None:
                triplets.append((row, ci + cc, -w_pin * float(w0[cc])))
        rhs_vec[row] = w_pin
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

    # Gravity-magnitude refinement (VINS-Mono style): with weak motion
    # excitation the free linear solve can trade scale against |g| and
    # collapse s toward zero (observed on a slow 88 s session: the whole
    # solution initialized — and then stayed — at 1/400 scale). Gravity's
    # 9.81 m/s² is the strongest accelerometer signal, so re-solve with g
    # constrained to that sphere: g = 9.81·(ĝ + B·δ), δ ∈ R² in ĝ's tangent
    # plane, iterated twice.
    for _ in range(2):
        g_norm = np.linalg.norm(g)
        if g_norm < 1e-6:
            break
        g_dir = g / g_norm
        # Tangent basis of the unit sphere at g_dir.
        tmp = np.array([1.0, 0.0, 0.0]) if abs(g_dir[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        b1 = np.cross(g_dir, tmp)
        b1 /= np.linalg.norm(b1)
        b2 = np.cross(g_dir, b1)
        basis = np.stack([b1, b2], axis=1)  # (3, 2)
        # Unknowns [s, δ(2), v(3n)]: substitute g = GRAVITY·(g_dir + B δ).
        a2 = np.zeros((a.shape[0], 3 + 3 * n))
        a2[:, 0] = a[:, 0]
        a2[:, 1:3] = a[:, 1:4] @ (GRAVITY * basis)
        a2[:, 3:] = a[:, 4:]
        b2v = b - a[:, 1:4] @ (GRAVITY * g_dir)
        sol2, *_ = np.linalg.lstsq(a2, b2v, rcond=None)
        s = float(sol2[0])
        delta = sol2[1:3]
        g = GRAVITY * (g_dir + basis @ delta)
        g = GRAVITY * g / np.linalg.norm(g)
        v = sol2[3:].reshape(n, 3)
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
    refine_intrinsics: bool = False,
    progress_cb: Optional["ProgressCb"] = None,
    warm_start: Optional[VioResult] = None,
    ftol: float = 1e-6,
) -> VioResult:
    """Jointly estimate camera trajectory and LED positions; no pose input.

    `frames` must be time-ordered; `imu` must cover the frame time span.
    Returns a metric, gravity-consistent solution in an arbitrary yaw/origin
    gauge (pose 0 pinned at its seed).

    ``refine_intrinsics`` adds a SHARED camera model [fx (=fy), cx, cy] to the
    unknowns, seeded from frames[0].k with loose priors — for the WebXR-free
    capture path, where there is no projectionMatrix and the client can only
    guess K from a typical field of view. The dense observation graph
    constrains focal length well (it trades off against scene depth, which
    the IMU pins metrically).
    """
    frames = list(frames)
    led_ids = sorted({led for fr in frames for led, _u, _v in fr.obs})
    n = len(frames)
    m = len(led_ids)
    id_index = {led: j for j, led in enumerate(led_ids)}

    # ---- Stages 1–3: seeds (or a warm start from a previous solution) -------
    if warm_start is not None and warm_start.frame_times is not None:
        # Re-solves after outlier pruning: the state barely moves, so seed
        # from the previous solution (frames join on their timestamps — the
        # pruned frame set is a subset of the previous one) and skip the
        # init stages entirely.
        prev_idx = {float(t): i for i, t in enumerate(warm_start.frame_times)}
        rotations = []
        centers = np.zeros((n, 3))
        v_seed = np.zeros((n, 3))
        for i, fr in enumerate(frames):
            pi = prev_idx.get(float(fr.t))
            if pi is None:
                pi = int(np.argmin(np.abs(warm_start.frame_times - fr.t)))
            rotations.append(quat_to_rotmat(warm_start.quats[pi]))
            centers[i] = warm_start.positions[pi]
            v_seed[i] = warm_start.velocities[pi]
        led_seed = {
            led: warm_start.led_positions.get(led, np.zeros(3)).copy() for led in led_ids
        }
        g_seed = warm_start.gravity.copy()
        bg_seed = warm_start.gyro_bias.copy()
        ba_seed = warm_start.accel_bias.copy()
        if refine_intrinsics and warm_start.intrinsics is not None:
            k_seed = np.array(
                [warm_start.intrinsics[0], warm_start.intrinsics[2], warm_start.intrinsics[3]]
            )
    else:
        rotations = _rotation_seeds(frames, imu)
        centers, led_seed = _known_rotation_linear_init(frames, rotations, led_ids)
        scale, g_seed, v_seed = _inertial_alignment(frames, rotations, centers, imu)
        centers = centers * scale
        led_seed = {led: x * scale for led, x in led_seed.items()}
        bg_seed = np.zeros(3)
        ba_seed = np.zeros(3)

    # ---- Stage 4: nonlinear VI-BA -------------------------------------------
    # Parameter vector layout:
    #   per frame i: rotvec(3), p(3), v(3)      → 9n
    #   per led j:   X(3)                       → 3m
    #   gyro bias(3), accel bias(3), gravity(3) → 9
    #   [refine_intrinsics] shared fx, cx, cy   → 3
    off_led = 9 * n
    off_bias = off_led + 3 * m
    off_k = off_bias + 9
    n_par = off_k + (3 if refine_intrinsics else 0)
    k_seed = np.array([frames[0].k[0], frames[0].k[2], frames[0].k[3]])

    def pack(rots, ps, vs, leds, bg, ba, g, kk=None) -> np.ndarray:
        parts = []
        for i in range(n):
            parts.append(so3_log(rots[i]))
            parts.append(ps[i])
            parts.append(vs[i])
        for led in led_ids:
            parts.append(leds[led])
        parts += [bg, ba, g]
        if refine_intrinsics:
            parts.append(k_seed if kk is None else kk)
        return np.concatenate(parts)

    def unpack(x):
        pose = x[:off_led].reshape(n, 9)
        rots = [so3_exp(pose[i, 0:3]) for i in range(n)]
        ps = pose[:, 3:6]
        vs = pose[:, 6:9]
        leds = x[off_led:off_bias].reshape(m, 3)
        bg = x[off_bias : off_bias + 3]
        ba = x[off_bias + 3 : off_bias + 6]
        g = x[off_bias + 6 : off_bias + 9]
        kk = x[off_k : off_k + 3] if refine_intrinsics else None
        return rots, ps, vs, leds, bg, ba, g, kk

    x0 = pack(
        rotations,
        centers,
        v_seed,
        led_seed,
        bg_seed,
        ba_seed,
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
    sig_r = np.array([s[0] for s in sigmas]).reshape(-1, 1)
    sig_v = np.array([s[1] for s in sigmas]).reshape(-1, 1)
    sig_p = np.array([s[2] for s in sigmas]).reshape(-1, 1)

    n_k_res = 3 if refine_intrinsics else 0

    # ---- Residual-function precomputation. The residuals run thousands of
    # times (numeric Jacobian × LM iterations); everything that does not
    # depend on the parameter vector is hoisted out, and the two former
    # per-eval hot spots are eliminated:
    #  * reprojection is fully vectorized over observations,
    #  * IMU preintegration depends ONLY on the biases (6 of thousands of
    #    parameters), so segments are pre-bucketed once and the integrated
    #    deltas are cached keyed by bias values — Jacobian columns for poses,
    #    LEDs, gravity and K hit the cache.
    n_obs = len(obs_flat)
    obs_i = np.array([o[0] for o in obs_flat], dtype=np.intp)
    obs_j = np.array([o[1] for o in obs_flat], dtype=np.intp)
    obs_u = np.array([o[2] for o in obs_flat])
    obs_v = np.array([o[3] for o in obs_flat])
    obs_k = np.array([frames[i].k for i, _j, _u, _v in obs_flat])  # (n_obs, 4)

    imu_sorted = sorted(imu, key=lambda s: s.t)
    imu_t = np.array([s.t for s in imu_sorted])

    def _bucket(i: int):
        """Per-interval integration segments (bounds + held rates), mirroring
        preintegrate()'s ZOH-with-leading-span semantics exactly."""
        t0, t1 = frames[i].t, frames[i + 1].t
        lo = int(np.searchsorted(imu_t, t0, side="right"))
        hi = int(np.searchsorted(imu_t, t1, side="left"))
        inside = imu_sorted[lo:hi]
        active = imu_sorted[lo - 1] if lo > 0 else (inside[0] if inside else None)
        if active is None:
            return None
        rates = [active] + inside
        bounds = np.array([t0] + [s.t for s in inside] + [t1])
        gyr = np.array([s.gyro for s in rates])
        acc = np.array([s.accel for s in rates])
        return np.diff(bounds), gyr, acc

    segments = [_bucket(i) for i in intervals]
    interval_dts = np.array([frames[i + 1].t - frames[i].t for i in intervals])

    # Flattened sample arrays across all intervals: one batched exp per
    # integration pass instead of thousands of scalar so3_exp calls.
    flat_dts = np.concatenate([s[0] for s in segments if s is not None]) if intervals else np.zeros(0)
    flat_gyr = (
        np.concatenate([s[1] for s in segments if s is not None])
        if intervals
        else np.zeros((0, 3))
    )
    flat_acc = (
        np.concatenate([s[2] for s in segments if s is not None])
        if intervals
        else np.zeros((0, 3))
    )
    seg_slices = []
    pos = 0
    for s in segments:
        if s is None:
            seg_slices.append(None)
        else:
            cnt = len(s[0])
            seg_slices.append(slice(pos, pos + cnt))
            pos += cnt

    def integrate_all(bg: np.ndarray, ba: np.ndarray):
        """(ΔR^T, Δv, Δp) arrays over all intervals for given biases."""
        steps = so3_exp_batch((flat_gyr - bg) * flat_dts[:, None])
        acc_c = flat_acc - ba
        rot_t = np.empty((len(intervals), 3, 3))
        vel = np.empty((len(intervals), 3))
        posn = np.empty((len(intervals), 3))
        for idx, sl in enumerate(seg_slices):
            d_rot = np.eye(3)
            d_vel = np.zeros(3)
            d_pos = np.zeros(3)
            if sl is not None:
                for mi in range(sl.start, sl.stop):
                    dt = flat_dts[mi]
                    if dt <= 0:
                        continue
                    a_w = d_rot @ acc_c[mi]
                    d_pos = d_pos + d_vel * dt + 0.5 * a_w * dt * dt
                    d_vel = d_vel + a_w * dt
                    d_rot = d_rot @ steps[mi]
            rot_t[idx] = d_rot.T
            vel[idx] = d_vel
            posn[idx] = d_pos
        return rot_t, vel, posn

    # Bias-linearized preintegration cache (Forster-style, numerically
    # derived): integrating is only ever a function of the 6 bias parameters,
    # so integrate ONCE at a reference bias, compute the 6-column bias
    # Jacobian numerically, and answer nearby-bias queries (finite-difference
    # perturbations, in particular) with the first-order correction:
    #     ΔR(b) ≈ ΔR_ref · exp(J_r δ),  Δv(b) ≈ Δv_ref + J_v δ,  …
    # The reference is refreshed whenever the query strays beyond the
    # linearization neighborhood (an accepted LM step on the biases).
    _JH = 1e-6
    preint_ref: dict = {"b": None, "vals": None, "jac": None}

    def preint_all(bg: np.ndarray, ba: np.ndarray):
        b = np.concatenate([bg, ba])
        if preint_ref["b"] is None or np.max(np.abs(b - preint_ref["b"])) > 1e-4:
            rot_t, vel, posn = integrate_all(bg, ba)
            jr = np.empty((len(intervals), 3, 6))
            jv = np.empty((len(intervals), 3, 6))
            jp = np.empty((len(intervals), 3, 6))
            for kdim in range(6):
                bpert = b.copy()
                bpert[kdim] += _JH
                rot_t_k, vel_k, posn_k = integrate_all(bpert[:3], bpert[3:])
                # log(ΔR_ref^T ΔR_k) = log((rot_t @ rot_t_k^T)^T)
                rel = np.einsum("nij,nkj->nki", rot_t_k, rot_t)  # ΔR_ref^T ΔR_k
                jr[:, :, kdim] = so3_log_batch(rel) / _JH
                jv[:, :, kdim] = (vel_k - vel) / _JH
                jp[:, :, kdim] = (posn_k - posn) / _JH
            preint_ref["b"] = b
            preint_ref["vals"] = (rot_t, vel, posn)
            preint_ref["jac"] = (jr, jv, jp)
        rot_t, vel, posn = preint_ref["vals"]
        delta = b - preint_ref["b"]
        if not delta.any():
            return rot_t, vel, posn
        jr, jv, jp = preint_ref["jac"]
        # ΔR(b)^T = exp(-J_r δ) · ΔR_ref^T
        corr = so3_exp_batch(-(jr @ delta))
        return (
            np.einsum("nij,njk->nik", corr, rot_t),
            vel + jv @ delta,
            posn + jp @ delta,
        )

    _hub_delta = huber_px / px_sigma

    def _robustify(r: np.ndarray) -> np.ndarray:
        # Pseudo-Huber in residual space: quadratic near 0, ~sqrt beyond δ.
        return np.sign(r) * _hub_delta * np.sqrt(
            2.0 * (np.sqrt(1.0 + (r / _hub_delta) ** 2) - 1.0)
        )

    # Progress reporting: the optimizer offers no iteration hook, but WE own
    # the residual function. The total evaluation count is estimated from the
    # sparsity coloring (each Jacobian costs ~one eval per column group —
    # filled in below, once the pattern exists) and throttled snapshots of the
    # current LED/camera estimates go to the callback.
    eval_state = {"count": 0, "est_total": 0, "last_report": 0.0, "raw_rms": 0.0}

    def _report(out: np.ndarray, leds: np.ndarray, ps: np.ndarray) -> None:
        import time as _time

        eval_state["count"] += 1
        if progress_cb is None or eval_state["est_total"] == 0:
            return
        now = _time.monotonic()
        if now - eval_state["last_report"] < 0.25:
            return
        eval_state["last_report"] = now
        rms = eval_state["raw_rms"]
        frac = min(0.99, eval_state["count"] / eval_state["est_total"])
        progress_cb(frac, {led: leds[id_index[led]].copy() for led in led_ids}, rms, ps.copy())

    def residuals(x: np.ndarray) -> np.ndarray:
        pose = x[:off_led].reshape(n, 9)
        rotm = so3_exp_batch(pose[:, 0:3])
        ps = pose[:, 3:6]
        vs = pose[:, 6:9]
        leds = x[off_led:off_bias].reshape(m, 3)
        bg = x[off_bias : off_bias + 3]
        ba = x[off_bias + 3 : off_bias + 6]
        g = x[off_bias + 6 : off_bias + 9]
        kk = x[off_k : off_k + 3] if refine_intrinsics else None
        out = np.empty(2 * n_obs + 9 * len(intervals) + 3 + 3 + 1 + 6 + n_k_res)
        # Reprojection, vectorized: xc = R^T (X - p) per observation.
        d = leds[obs_j] - ps[obs_i]
        xc = np.einsum("nba,nb->na", rotm[obs_i], d)
        depth = -xc[:, 2]
        bad = depth <= 1e-6
        depth_safe = np.where(bad, 1.0, depth)
        if kk is not None:
            fx = fy = kk[0]
            cx, cy = kk[1], kk[2]
        else:
            fx, fy, cx, cy = obs_k[:, 0], obs_k[:, 1], obs_k[:, 2], obs_k[:, 3]
        ru = (cx + fx * xc[:, 0] / depth_safe - obs_u) / px_sigma
        rv = (cy - fy * xc[:, 1] / depth_safe - obs_v) / px_sigma
        ru[bad] = 50.0  # behind the camera: hard penalty
        rv[bad] = 50.0
        eval_state["raw_rms"] = float(np.sqrt(np.mean(ru * ru + rv * rv) / 2.0)) * px_sigma
        # Robustify the REPROJECTION block ONLY (pseudo-Huber via the
        # residual-space transform r' = sign(r)·√ρ(r²)). scipy's global
        # `loss=` would also saturate the IMU factors — and since
        # reprojection is scale-invariant, a saturated IMU cost opens a
        # degenerate basin where the whole scene collapses to near-zero
        # scale (reprojection perfect, IMU penalty bounded — observed on the
        # 2026-07-08 88 s session as an 8 mm "trajectory"). The IMU and
        # prior residuals stay quadratic, so scale collapse costs what
        # physics says it should.
        out[: 2 * n_obs : 2] = _robustify(ru)
        out[1 : 2 * n_obs : 2] = _robustify(rv)
        k = 2 * n_obs
        # IMU preintegration factors, fully batched over intervals.
        if intervals:
            d_rot_t, d_vel, d_pos = preint_all(bg, ba)
            ri = rotm[:-1]  # (nI, 3, 3), camera-to-world at interval starts
            rj = rotm[1:]
            dt = interval_dts[:, None]
            # r_err = log(ΔR_meas^T · R_i^T · R_j); d_rot_t already holds ΔR^T.
            rel = np.einsum("nij,njk->nik", d_rot_t, np.einsum("nji,njk->nik", ri, rj))
            r_err = so3_log_batch(rel)
            v_world = vs[1:] - vs[:-1] - g[None, :] * dt
            v_err = np.einsum("nji,nj->ni", ri, v_world) - d_vel
            p_world = ps[1:] - ps[:-1] - vs[:-1] * dt - 0.5 * g[None, :] * dt * dt
            p_err = np.einsum("nji,nj->ni", ri, p_world) - d_pos
            block = np.concatenate([r_err / sig_r, v_err / sig_v, p_err / sig_p], axis=1)
            out[k : k + 9 * len(intervals)] = block.ravel()
            k += 9 * len(intervals)
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
        k += 6
        if kk is not None:
            # Loose intrinsics priors: the seed is a FOV guess, not truth.
            out[k] = (kk[0] - k_seed[0]) / (0.2 * k_seed[0])
            out[k + 1] = (kk[1] - k_seed[1]) / (0.1 * 2 * k_seed[1])
            out[k + 2] = (kk[2] - k_seed[2]) / (0.1 * 2 * k_seed[2])
        _report(out, leds, ps)
        return out

    # Sparsity pattern for 2-point finite differencing.
    n_res = 2 * len(obs_flat) + 9 * len(intervals) + 6 + 1 + 6 + n_k_res
    spar = lil_matrix((n_res, n_par), dtype=np.uint8)
    k = 0
    for i, j, _u, _v in obs_flat:
        spar[k : k + 2, 9 * i : 9 * i + 6] = 1
        spar[k : k + 2, off_led + 3 * j : off_led + 3 * j + 3] = 1
        if refine_intrinsics:
            spar[k : k + 2, off_k : off_k + 3] = 1
        k += 2
    for i in intervals:
        spar[k : k + 9, 9 * i : 9 * i + 18] = 1  # poses i and i+1
        spar[k : k + 9, off_bias : off_bias + 9] = 1  # biases + gravity
        k += 9
    spar[k : k + 6, off_bias : off_bias + 6] = 1
    k += 6
    spar[k, off_bias + 6 : off_bias + 9] = 1
    k += 1
    spar[k : k + 6, 0:6] = 1
    k += 6
    if refine_intrinsics:
        spar[k : k + 3, off_k : off_k + 3] = 1

    if progress_cb is not None:
        try:
            from scipy.optimize._numdiff import group_columns

            n_groups = int(np.max(group_columns(spar.tocsc()))) + 1
        except Exception:
            n_groups = 30  # typical coloring for this problem shape
        eval_state["est_total"] = max_nfev * (1 + n_groups)

    fit = least_squares(
        residuals,
        x0,
        jac_sparsity=spar.tocsr(),
        # loss stays linear: reprojection is robustified inside residuals();
        # see the comment there for why a global robust loss is unsafe.
        ftol=ftol,
        max_nfev=max_nfev,
        x_scale="jac",
        tr_solver="lsmr",
    )

    rots, ps, vs, leds, bg, ba, g, kk = unpack(fit.x)

    # A-posteriori metric re-anchor: on low-excitation (slow) sessions the
    # accel-bias freedom absorbs much of the motion signal and the BA can
    # drift the GLOBAL SCALE (shape stays excellent — reprojection is
    # scale-invariant; observed as a map at 1/4 to 1/400 of true size).
    # The gravity-constrained inertial alignment against the SOLVED
    # trajectory is exactly the metric estimator for a fixed shape — re-fit
    # scale and apply it to the whole solution.
    if intervals:
        s_post, _g_post, v_post = _inertial_alignment(frames, rots, ps, imu)
        if np.isfinite(s_post) and s_post > 1e-3 and abs(s_post - 1.0) > 0.02:
            ps = ps * s_post
            vs = v_post
            leds = leds * s_post

    residuals(pack(rots, ps, vs, {led: leds[id_index[led]] for led in led_ids}, bg, ba, g, kk))
    rms = eval_state["raw_rms"]
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
        frame_times=np.array([fr.t for fr in frames]),
        intrinsics=(float(kk[0]), float(kk[0]), float(kk[1]), float(kk[2])) if kk is not None else None,
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
