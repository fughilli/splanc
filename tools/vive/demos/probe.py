"""Stylus calibration: a second tracker with a ball tip probes LEDs on a fixture that
carries its own tracker. Everything is in that fixture tracker's frame T, so the
fixture may move while it is probed, and the result is the mount T_TF directly.

A stylus pose relative to the fixture tracker is M = T_WT^-1 . T_WS (a rigid 4x4). The
ball centre is M . c, with c the tip in the stylus frame S.

- Pivot: the tip rests on one point q (in T) while the stylus rocks round it:
  M_k c = q. Linear least squares in (c, q); the rocking makes c observable.
- Touch on LED i (map position p_i, outward normal n_i, frame F):
  M_k c = s R (p_i + h n_i) + t, with T_TF = (s, R, t).
  h is the ball centre's height above the LED along its normal: the ball radius plus
  whatever the diffuser adds. Fixture geometry is learned, not given, so h is a fit
  parameter (one for the fixture), like the map scale s.

The joint fit refines c with the touches (each one is held at its own orientation) and
keeps the pivots as constraints: a pivot on an LED counts as a touch on it, one on any
other point gets its own unknown point q.
"""

import frames as fr
import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation

SIGMA = 0.001  # m, per axis: tip position noise (tracker + hand)
ROBUST = 0.005  # m: residuals are quadratic up to about this, robust beyond
PRIOR_H = 0.03  # m, h around 0 (weak)
PIVOT_MIN_SAMPLES = 60
PIVOT_MIN_SPREAD = 15.0  # deg: the stylus must rock at least this much round the tip
PIVOT_MAX_RMS = (
    0.008  # m (of the inliers, for a robust pivot); lhd's station disagreement alone gives ~5 mm
)
PIVOT_INLIER_FLOOR = (
    0.003  # m: a robust pivot keeps every sample this close, however tight the rest
)
PIVOT_MIN_INLIER_FRAC = 0.5
MIN_TOUCHES = 3  # for a fit (a similarity needs three points)
CONV_MIN_TOUCHES = 6
CONV_POS = 0.0005  # m, max LED displacement between successive fits
CONV_RMS = 0.003  # m, touch RMS


def relative(T_WT, T_WS):
    """Stylus pose in the fixture tracker's frame."""
    return np.linalg.inv(T_WT) @ T_WS


def pivot(Ms):
    """Pivot calibration from rigid poses M_k (stylus in T) rocking round one point:
    solves R_k c - q = -t_k. Returns (c, q, rms m, rotation spread deg)."""
    Ms = np.asarray(Ms, float)
    n = len(Ms)
    A = np.zeros((3 * n, 6))
    b = np.zeros(3 * n)
    for k, M in enumerate(Ms):
        A[3 * k : 3 * k + 3, :3] = M[:3, :3]
        A[3 * k : 3 * k + 3, 3:] = -np.eye(3)
        b[3 * k : 3 * k + 3] = -M[:3, 3]
    x, *_ = np.linalg.lstsq(A, b, rcond=None)
    c, q = x[:3], x[3:]
    r = (A @ x - b).reshape(-1, 3)
    rms = float(np.sqrt(np.mean(np.sum(r * r, axis=1))))
    axes = Ms[:, :3, :3] @ (c / max(np.linalg.norm(c), 1e-9))  # stylus axis directions in T
    mean = axes.mean(0)
    mean /= np.linalg.norm(mean)
    spread = float(np.degrees(np.arccos(np.clip(axes @ mean, -1, 1))).max())
    return c, q, rms, spread


def pivot_robust(Ms, iters=12):
    """pivot() that shrugs off jiggle: the approach and lift-off, the tip slipping, pose
    jumps. Huber-reweighted least squares, then only the samples within 3 robust sigmas
    (at least PIVOT_INLIER_FLOOR) of the pivot, refitted until the set settles. Returns
    (c, q, inlier rms m, inlier spread deg, inlier mask, robust sigma m)."""
    Ms = np.asarray(Ms, float)
    n = len(Ms)
    A = np.zeros((n, 3, 6))
    A[:, :, :3] = Ms[:, :3, :3]
    A[:, :, 3:] = -np.eye(3)
    b = -Ms[:, :3, 3]
    w = np.ones(n)
    inl = np.ones(n, bool)
    sig = PIVOT_INLIER_FLOOR
    for it in range(iters):
        sw = np.sqrt(w)[:, None, None]
        x, *_ = np.linalg.lstsq((A * sw).reshape(-1, 6), (b * sw[:, :, 0]).ravel(), rcond=None)
        r = np.linalg.norm(np.einsum("nij,j->ni", A, x) - b, axis=1)
        sig = max(1.4826 * float(np.median(r[inl] if it >= 3 else r)), PIVOT_INLIER_FLOOR / 3)
        if it < 3:
            w = np.minimum(1.0, 1.5 * sig / np.maximum(r, 1e-12))  # Huber
            continue
        new = r < max(3 * sig, PIVOT_INLIER_FLOOR)
        if new.sum() < 6:
            break
        if np.array_equal(new, inl) and it > 3:
            break
        inl, w = new, new.astype(float)
    c, q = x[:3], x[3:]
    ri = r[inl]
    rms = float(np.sqrt(np.mean(ri * ri))) if inl.any() else float("inf")
    axes = Ms[inl, :3, :3] @ (c / max(np.linalg.norm(c), 1e-9))
    if len(axes):
        mean = axes.mean(0)
        mean /= np.linalg.norm(mean)
        spread = float(np.degrees(np.arccos(np.clip(axes @ mean, -1, 1))).max())
    else:
        spread = 0.0
    return c, q, rms, spread, inl, sig


def pivot_ok(n, rms, spread, inliers=None):
    """None if the pivot is usable, else why not (n, rms, spread: of the inliers, out of
    `inliers` = (kept, total) for a robust pivot)."""
    if inliers is not None and inliers[0] < PIVOT_MIN_INLIER_FRAC * inliers[1]:
        return "only %d of %d samples on one point (need %.0f%%): hold the tip in the fixture" % (
            inliers[0],
            inliers[1],
            PIVOT_MIN_INLIER_FRAC * 100,
        )
    if n < PIVOT_MIN_SAMPLES:
        return "only %d samples (need %d)" % (n, PIVOT_MIN_SAMPLES)
    if spread < PIVOT_MIN_SPREAD:
        return "rocked only %.0f° (need %.0f°)" % (spread, PIVOT_MIN_SPREAD)
    if rms > PIVOT_MAX_RMS:
        return "tip moved: RMS %.1f mm (max %.1f)" % (rms * 1e3, PIVOT_MAX_RMS * 1e3)
    return None


class ProbeFit:
    def __init__(self, c, T_TF, h, scale_estimated, rms, residuals, pivot_rms, cost):
        self.c, self.T_TF, self.h = c, T_TF, h
        self.scale_estimated = scale_estimated
        self.rms = rms  # m, touch RMS
        self.residuals = residuals  # (n, 3) m, per touch
        self.pivot_rms = pivot_rms  # m, per pivot set
        self.cost = cost

    @property
    def s(self):
        return fr.sim_parts(self.T_TF)[0]

    def to_json(self):
        return {
            "method": "stylus",
            "c_S": self.c.tolist(),
            "h_mm": self.h * 1e3,
            "s": self.s,
            "scale_estimated": self.scale_estimated,
            "touch_rms_mm": self.rms * 1e3,
            "touch_res_mm": (np.linalg.norm(self.residuals, axis=1) * 1e3).round(2).tolist(),
            "pivot_rms_mm": [r * 1e3 for r in self.pivot_rms],
        }


def fit(ledmap, touches, pivots, c0, est_scale, s_fixed=1.0, prev=None, fix_c=False):
    """touches: [(row, M)], pivots: [(row or None, [M, ...]), ...] (each set round one
    point: that LED, or an unknown one), c0: the tip from the pivot. fix_c: hold the tip at
    c0 (it came from a pivot on its own fixture; touches with an unknown h can trade the
    tip's length against h). Returns ProbeFit."""
    rows = np.array([r for r, _ in touches], int)
    Mt = np.array([M for _, M in touches]).reshape(-1, 4, 4)
    if len(rows) + sum(r is not None for r, _ in pivots) < MIN_TOUCHES:
        raise ValueError("need %d touches" % MIN_TOUCHES)
    p, nrm = ledmap.p[rows], ledmap.n[rows]

    # Start: tips from c0, then a similarity from the LEDs (h = 0) unless a previous fit is closer.
    pv = [(r, np.asarray(P, float)) for r, P in pivots]
    if prev is not None:
        s0, R0, t0 = fr.sim_parts(prev.T_TF)
        h0 = prev.h
    else:
        src = np.concatenate([p] + [ledmap.p[[r]] for r, _ in pv if r is not None])
        dst = np.concatenate(
            [fr.apply_each(Mt, c0)]
            + [fr.apply_each(P, c0).mean(0)[None] for r, P in pv if r is not None]
        )
        s0, R0, t0 = fr.umeyama(src, dst, with_scale=est_scale)
        h0 = 0.0
    if not est_scale:
        s0 = s_fixed
    q0 = [fr.apply_each(P, c0).mean(0) for r, P in pv if r is None]

    def unpack(x):
        if fix_c:
            x = np.concatenate([c0, x])
        c, rv, t, h = x[:3], x[3:6], x[6:9], x[9]
        s = float(np.exp(x[10])) if est_scale else s_fixed
        k = 11 if est_scale else 10
        qs = x[k:].reshape(-1, 3)
        return c, Rotation.from_rotvec(rv).as_matrix() @ R0, t, h, s, qs

    def residuals(x):
        c, R, t, h, s, qs = unpack(x)
        pred = s * (p + h * nrm) @ R.T + t
        out = [((fr.apply_each(Mt, c) - pred) / SIGMA).ravel()]
        out += [r.ravel() for r in pivot_res(c, R, t, h, s, qs)]
        out.append([h / PRIOR_H])
        return np.concatenate(out)

    def pivot_res(c, R, t, h, s, qs):
        """Per pivot set, its samples' residuals (in sigmas; a set weighs about as much as
        30 touches at most, its samples aren't independent)."""
        out, qi = [], iter(qs)
        for r, P in pv:
            target = next(qi) if r is None else s * (ledmap.p[r] + h * ledmap.n[r]) @ R.T + t
            out.append((fr.apply_each(P, c) - target) / SIGMA / np.sqrt(max(len(P) / 30, 1)))
        return out

    parts = ([] if fix_c else [c0]) + [np.zeros(3), t0, [h0]]
    if est_scale:
        parts.append([np.log(s0)])
    parts += [np.ravel(q) for q in q0]
    x0 = np.concatenate(parts)
    sol = least_squares(residuals, x0, loss="soft_l1", f_scale=ROBUST / SIGMA, x_scale="jac")
    c, R, t, h, s, qs = unpack(sol.x)
    T_TF = fr.make_pose(R, t, s)
    res = fr.apply_each(Mt, c) - (s * (p + h * nrm) @ R.T + t)
    rms = float(np.sqrt(np.mean(np.sum(res * res, axis=1))))
    prms = [
        float(np.sqrt(np.mean(np.sum(r * r, axis=1)))) * SIGMA * np.sqrt(max(len(P) / 30, 1))
        for r, (_, P) in zip(pivot_res(c, R, t, h, s, qs), pv)
    ]
    return ProbeFit(c, T_TF, float(h), est_scale, rms, res, prms, float(sol.cost))


def converged(ledmap, prev, cur, n_touches, scale_mode="auto"):
    """(bool, info): LEDs moved < CONV_POS between the last two fits, touch RMS
    < CONV_RMS, enough touches, and (auto) the scale is being estimated."""
    info = {"touches": n_touches, "touch_rms_mm": cur.rms * 1e3, "h_mm": cur.h * 1e3, "s": cur.s}
    if prev is None:
        return False, {**info, "why": "need two fits to compare"}
    dpos = float(
        np.linalg.norm(fr.apply(prev.T_TF, ledmap.p) - fr.apply(cur.T_TF, ledmap.p), axis=1).max()
    )
    info["dpos_mm"] = dpos * 1e3
    why = []
    if n_touches < CONV_MIN_TOUCHES:
        why.append("need %d touches" % CONV_MIN_TOUCHES)
    if dpos >= CONV_POS:
        why.append("still moving")
    if not cur.rms < CONV_RMS:
        why.append("touch RMS too high")
    if scale_mode == "auto" and not cur.scale_estimated:
        why.append("touches don't span the fixture yet (scale not estimated)")
    info["why"] = "; ".join(why)
    return not why, info
