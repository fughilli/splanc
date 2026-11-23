"""Tracker <-> fixture calibration (§5): rub surface fit, LED-touch correspondences,
convergence, and the mount record T_TF = T_WT^-1 . T_WF.

Unknowns (one joint robust least-squares problem, scipy `least_squares`):
  T_WF   fixture map F in the world W, x_W = s R p + t       (6 DoF, + s optionally)
  c      the tracker's contact point, in the tracker frame T (3)
  o      surface offset along the outward normal, metres     (1)
  s      map scale (optional; only once touches span the fixture)

Residuals:
  rub i     (s * sd_F(T_WT,i . c mapped into F) - o) / SIGMA_RUB
  touch k   (T_WT,k . c - (s R p_k + t + o R n_k)) / SIGMA_TOUCH       (3 per touch)
  priors    weak: c around C0, o around 0, log s around 0 (see PRIOR_*)
with a Cauchy loss (scale 1 = one sigma), so lift-offs and edge samples are outliers;
then rubs beyond TRIM_K robust (MAD) sigmas are trimmed and the fit polished once more,
since one-sided lift-offs otherwise still bias o and s.
Rubs are down-weighted when there are many (they are strongly correlated), so a few
touches can still pin what the surface leaves free (rotation about a cylinder's axis,
translation along it, c vs o).
"""

import json
import time
from collections import deque
from dataclasses import dataclass, field

import frames as fr
import numpy as np
from ledmap import BASE_RADIUS
from scipy.optimize import least_squares

SIGMA_RUB = 0.0015  # m, per rub sample
SIGMA_TOUCH = 0.002  # m, per axis per touch
TOUCH_ROBUST = 0.015  # m, touch residuals are quadratic up to about this, robust beyond
RUB_EFF = 150  # rubs count as at most this many independent samples (the map surface
# is only approximate; touches, not rubs, should set the scale)
RUB_FIT_MAX = 1500  # subsample rubs to this many for fitting
TRIM_K = 3.5  # after the robust fit, drop rubs beyond this many robust sigmas...
TRIM_MIN_SIGMA = 0.0003  # m ...with the robust sigma floored here
# c along the base normal and o trade off almost exactly (both slide the contact along the
# surface normal). The tracker settles it: its head frame's origin is on the base plane,
# so c_z is known to a few mm for any fixture. o (how far the touchable surface stands out
# from the LED centres: a rope's radius, a diffuser) is the fixture's and is learned; its
# prior only keeps it finite.
PRIOR_C = np.array([0.01, 0.01, 0.003])  # m, c around C0 (x, y in the base plane; z along it)
PRIOR_O = 0.02  # m, o around 0 (weak)
PRIOR_LOG_S = 0.2  # log scale around 0 (weak: the gate makes s identifiable)
C0 = np.zeros(3)  # contact point initial guess: centre of the tracker's base (head origin)
SOFTMIN_TAU = 0.0001  # m, smoothness of the minimum over the base disc (it reads up to
# tau*ln(9) low where disc points tie, e.g. along a cylinder)
CONTACT_AXIS_T = np.array([0.0, 0.0, 1.0])  # outward normal of the tracker's contact face, in T

# Hold detection (§5 step 3) and convergence (§5 step 4).
HOLD_S = 1.0
HOLD_POS = 0.001  # m, max deviation of the contact point from its mean over HOLD_S
HOLD_ROT = 0.5  # deg, max deviation of the rotation from its mean over HOLD_S
REARM_POS = 0.01  # m the tracker must move before the next hold counts
CONV_POS = 0.0005  # m, max LED displacement between successive fits
CONV_ROT = 0.2  # deg
CONV_TOUCH_RMS = 0.003  # m
CONV_MIN_TOUCHES = 4
SCALE_MIN_TOUCHES = 4
SCALE_MIN_SPAN = 0.5  # touched span / map extent along every principal axis


@dataclass
class Params:
    T_WF: np.ndarray  # 4x4 similarity
    c: np.ndarray = field(default_factory=lambda: C0.copy())
    o: float = 0.0

    @property
    def s(self):
        return fr.sim_parts(self.T_WF)[0]

    def to_json(self):
        return {"T_WF": self.T_WF.tolist(), "c_T": self.c.tolist(), "o": self.o, "s": self.s}


@dataclass
class Touch:
    row: int  # LED row in the map (map.index[row] is the CSV index / OSC pick)
    T_WT: np.ndarray  # mean tracker pose over the hold
    t: float = 0.0
    residual: np.ndarray = None  # last fit's residual (m, W)

    def to_json(self, ledmap=None):
        return {
            "row": self.row,
            "led": int(ledmap.index[self.row]) if ledmap is not None else self.row,
            "T_WT": self.T_WT.tolist(),
            "t": self.t,
            "residual_mm": None if self.residual is None else (self.residual * 1e3).tolist(),
        }


@dataclass
class FitResult:
    params: Params
    scale_estimated: bool
    rub_rms: float  # m, robust-ish RMS of rub residuals (inliers |r| < 5 sigma)
    rub_inliers: float  # fraction
    touch_res: list  # per-touch 3-vectors (m)
    touch_rms: float
    cost: float
    seconds: float
    starts: int

    def to_json(self):
        return {
            **self.params.to_json(),
            "scale_estimated": self.scale_estimated,
            "rub_rms_mm": self.rub_rms * 1e3,
            "rub_inliers": self.rub_inliers,
            "touch_residuals_mm": [float(np.linalg.norm(r) * 1e3) for r in self.touch_res],
            "touch_rms_mm": self.touch_rms * 1e3,
            "cost": self.cost,
            "seconds": self.seconds,
            "starts": self.starts,
        }


# ---------------------------------------------------------------- the fit


def _unpack(x, R0, est_scale, s_fixed):
    R = fr.rotvec_to_mat(x[0:3]) @ R0
    t = x[3:6]
    c = x[6:9]
    o = x[9]
    s = float(np.exp(x[10])) if est_scale else s_fixed
    return R, t, c, o, s


def _disc_offsets(radius=BASE_RADIUS):
    """Sample points of the tracker's flat base (in T, relative to the contact point c):
    the centre and the rim, in the plane normal to CONTACT_AXIS_T. On a smooth surface a
    flat disc's smallest gap is at its centre (convex) or on its rim (concave, tilted)."""
    a = 2 * np.pi * np.arange(8) / 8
    return np.vstack([np.zeros(3), radius * np.stack([np.cos(a), np.sin(a), np.zeros(8)], 1)])


DISC = _disc_offsets()


def rub_distance(ledmap, rub_R, rub_t, c, R, t, s, o):
    """Gap between the tracker's base and the fixture surface for rub poses (0 when
    resting on it). The base is a disc, not a point: over a concave part (a waist) it
    rests on the proud parts around it, with its centre standing off. So the gap is a
    smooth minimum, over points of the disc, of their signed distance to the surface."""
    q = np.einsum("nij,kj->nki", rub_R, c + DISC) + rub_t[:, None]  # (n, k, 3) in W
    qF = (q.reshape(-1, 3) - t) @ R / s
    d = (s * ledmap.signed_distance(qF) - o).reshape(len(rub_t), len(DISC))
    m = d.min(1)
    return m - SOFTMIN_TAU * np.log(np.exp(-(d - m[:, None]) / SOFTMIN_TAU).sum(1))


def _cauchy(r, k=1.0):
    """Residuals whose squares are k^2 * ln(1 + (r/k)^2): least squares on these is a
    Cauchy fit, quadratic within about k (whitened units) and logarithmic beyond."""
    return np.sign(r) * k * np.sqrt(np.log1p((r / k) ** 2))


def _residuals(
    x,
    R0,
    est_scale,
    s_fixed,
    ledmap,
    rub_R,
    rub_t,
    rub_w,
    touch_R,
    touch_t,
    touch_p,
    touch_n,
    touch_w,
):
    R, t, c, o, s = _unpack(x, R0, est_scale, s_fixed)
    out = []
    if len(rub_t):
        out.append(rub_w * _cauchy(rub_distance(ledmap, rub_R, rub_t, c, R, t, s, o) / SIGMA_RUB))
    if len(touch_t):
        # Touches are confirmed by hand, so they stay quadratic out to TOUCH_ROBUST: rubs
        # can't overrule a set of consistent touches; a wrong one (far off) still can't
        # drag the fit.
        q = np.einsum("nij,j->ni", touch_R, c) + touch_t
        target = s * touch_p @ R.T + t + o * touch_n @ R.T
        k = TOUCH_ROBUST / SIGMA_TOUCH
        out.append((_cauchy((q - target) / SIGMA_TOUCH, k) * touch_w[:, None]).ravel())
    out.append((c - C0) / PRIOR_C)
    out.append([o / PRIOR_O])
    if est_scale:
        out.append([x[10] / PRIOR_LOG_S])
    return np.concatenate(out)


def _subsample(n, m, rng):
    if n <= m:
        return np.arange(n)
    return np.sort(rng.choice(n, m, replace=False))


def scale_span(ledmap, touch_rows):
    """Smallest ratio, over the map's principal axes, of the touched LEDs' span to the
    map's extent (0..1). Scale is only identifiable once this is large."""
    if len(touch_rows) < 2:
        return 0.0
    proj = (ledmap.p[list(touch_rows)] - ledmap.centroid) @ ledmap.axes
    span = proj.max(0) - proj.min(0)
    return float(np.min(span / np.maximum(ledmap.extent, 1e-9)))


def should_estimate_scale(ledmap, touches, mode):
    """mode: 'auto' (once touches span the fixture), 'on', or 'off'."""
    if mode == "on":
        return True
    if mode == "off":
        return False
    return (
        len(touches) >= SCALE_MIN_TOUCHES
        and scale_span(ledmap, [t.row for t in touches]) >= SCALE_MIN_SPAN
    )


def initial_guesses(ledmap, rub_poses, touches, c, prev=None, n_yaw=8, s_fixed=1.0):
    """Candidate T_WF starts. Upright assumption (F +Y -> W +Z) with yaw candidates about
    the vertical through the rub points' centroid; from >= 3 touches also a Umeyama fit
    (no orientation assumption); and the previous solution."""
    out = []
    if prev is not None:
        out.append(prev.copy())
    if len(touches) >= 3:
        src = ledmap.p[[t.row for t in touches]]
        dst = np.array([fr.apply(t.T_WT, c) for t in touches])
        _, R, tt = fr.umeyama(s_fixed * src, dst, with_scale=False)
        out.append(fr.make_pose(R, tt, s=s_fixed))
    pts = []
    if len(rub_poses):
        pts.append(np.einsum("nij,j->ni", rub_poses[:, :3, :3], c) + rub_poses[:, :3, 3])
    if touches:
        pts.append(np.array([fr.apply(t.T_WT, c) for t in touches]))
    if pts:
        X = np.concatenate(pts)
        # The surface points' centroid ~ the cloud's centroid if coverage is fair.
        centre_W = X.mean(0)
        for k in range(n_yaw):
            yaw = 2 * np.pi * k / n_yaw
            Rz = fr.rotvec_to_mat([0, 0, yaw])
            R = Rz @ fr.Y_UP_TO_Z_UP
            t = centre_W - s_fixed * R @ ledmap.centroid
            out.append(fr.make_pose(R, t, s=s_fixed))
    return out


def fit(
    ledmap, rub_poses, touches, prev=None, scale_mode="auto", s_fixed=1.0, seed=0, multistart=True
):
    """Joint robust fit. rub_poses: (N, 4, 4) T_WT; touches: list[Touch]; prev: Params.
    Returns FitResult and writes each touch's residual into it."""
    t0 = time.time()
    rng = np.random.default_rng(seed)
    rub_poses = np.asarray(rub_poses, float).reshape(-1, 4, 4)
    est_scale = should_estimate_scale(ledmap, touches, scale_mode)
    c_init = prev.c.copy() if prev is not None else C0.copy()
    o_init = prev.o if prev is not None else 0.0

    touch_R = np.array([t.T_WT[:3, :3] for t in touches]).reshape(-1, 3, 3)
    touch_t = np.array([t.T_WT[:3, 3] for t in touches]).reshape(-1, 3)
    rows = [t.row for t in touches]
    touch_p = ledmap.p[rows].reshape(-1, 3)
    touch_n = ledmap.n[rows].reshape(-1, 3)
    touch_w = np.sqrt(ledmap.w[rows]) if rows else np.zeros(0)

    def run(T_init, idx, max_nfev):
        s0, R0, t_init = fr.sim_parts(T_init)
        if not est_scale:
            s0 = s_fixed
        x0 = np.concatenate(
            [np.zeros(3), t_init, c_init, [o_init], [np.log(s0)] if est_scale else []]
        )
        rR, rt = rub_poses[idx, :3, :3], rub_poses[idx, :3, 3]
        rw = min(1.0, np.sqrt(RUB_EFF / max(len(idx), 1)))
        args = (
            R0,
            est_scale,
            s_fixed,
            ledmap,
            rR,
            rt,
            rw,
            touch_R,
            touch_t,
            touch_p,
            touch_n,
            touch_w,
        )
        sol = least_squares(
            _residuals, x0, args=args, loss="linear", x_scale="jac", max_nfev=max_nfev, method="trf"
        )
        return sol, R0

    starts = initial_guesses(
        ledmap,
        rub_poses,
        touches,
        c_init,
        prev.T_WF if prev is not None else None,
        n_yaw=8 if multistart else 1,
        s_fixed=s_fixed if not est_scale else (prev.s if prev is not None else s_fixed),
    )
    if not multistart and prev is not None:
        starts = starts[:1]
    if len(starts) > 1:
        idx = _subsample(len(rub_poses), 300, rng)
        best = None
        for T in starts:
            sol, R0 = run(T, idx, 60)
            if best is None or sol.cost < best[0].cost:
                best = (sol, R0)
        sol, R0 = best
        R, t, c, o, s = _unpack(sol.x, R0, est_scale, s_fixed)
        T_best = fr.make_pose(R, t, s)
        c_init, o_init = c, o
    else:
        T_best = starts[0]
    idx = _subsample(len(rub_poses), RUB_FIT_MAX, rng)
    sol, R0 = run(T_best, idx, 200)
    R, t, c, o, s = _unpack(sol.x, R0, est_scale, s_fixed)
    if len(idx) > 20:
        # Lift-offs are one-sided (the tracker can't go into the fixture), so even a
        # robust loss leaves a bias when the real noise is well below SIGMA_RUB. Trim rubs
        # beyond TRIM_K robust sigmas (MAD) of this fit and polish once more.
        r = rub_distance(ledmap, rub_poses[idx, :3, :3], rub_poses[idx, :3, 3], c, R, t, s, o)
        med = np.median(r)
        sig = max(1.4826 * np.median(np.abs(r - med)), TRIM_MIN_SIGMA)
        keep = np.abs(r - med) < TRIM_K * sig
        if keep.sum() > 20 and not keep.all():
            c_init, o_init = c, o
            sol, R0 = run(fr.make_pose(R, t, s), idx[keep], 100)
            R, t, c, o, s = _unpack(sol.x, R0, est_scale, s_fixed)
    params = Params(fr.make_pose(R, t, s), c, float(o))
    return evaluate(
        ledmap,
        rub_poses,
        touches,
        params,
        est_scale,
        cost=float(sol.cost),
        seconds=time.time() - t0,
        starts=len(starts),
    )


def evaluate(ledmap, rub_poses, touches, params, est_scale=False, cost=0.0, seconds=0.0, starts=0):
    s, R, t = fr.sim_parts(params.T_WF)
    rub_rms, inl = 0.0, 0.0
    if len(rub_poses):
        r = rub_distance(
            ledmap, rub_poses[:, :3, :3], rub_poses[:, :3, 3], params.c, R, t, s, params.o
        )
        m = np.abs(r) < 5 * SIGMA_RUB
        inl = float(m.mean())
        rub_rms = float(np.sqrt(np.mean(r[m] ** 2))) if m.any() else float("nan")
    res = []
    for tc in touches:
        q = fr.apply(tc.T_WT, params.c)
        target = s * R @ ledmap.p[tc.row] + t + params.o * R @ ledmap.n[tc.row]
        tc.residual = q - target
        res.append(tc.residual)
    trms = float(np.sqrt(np.mean([r @ r for r in res]))) if res else float("nan")
    return FitResult(params, est_scale, rub_rms, inl, res, trms, cost, seconds, starts)


def fit_delta(ledmap, a, b):
    """(max LED displacement in m, rotation change in deg, contact point change in m)
    between two Params."""
    pa, pb = fr.apply(a.T_WF, ledmap.p), fr.apply(b.T_WF, ledmap.p)
    _, Ra, _ = fr.sim_parts(a.T_WF)
    _, Rb, _ = fr.sim_parts(b.T_WF)
    return (
        float(np.linalg.norm(pa - pb, axis=1).max()),
        fr.rot_angle_deg(Ra.T @ Rb),
        float(np.linalg.norm(a.c - b.c)),
    )


def converged(ledmap, prev, cur, n_touches, scale_mode="auto"):
    """§5 step 4: parameters moved < CONV_POS / CONV_ROT between the last two fits, the
    touch RMS is < CONV_TOUCH_RMS, at least CONV_MIN_TOUCHES touches, and (scale_mode
    'auto') the scale has been estimated, i.e. the touches span the fixture. A fixed
    wrong scale otherwise hides in t, c and o with small residuals.
    Returns (bool, info dict with the reason it is not converged in 'why')."""
    info = {"touches": n_touches, "touch_rms_mm": cur.touch_rms * 1e3}
    if prev is None:
        return False, {**info, "why": "need two fits to compare"}
    dpos, drot, dc = fit_delta(ledmap, prev.params, cur.params)
    info.update(dpos_mm=dpos * 1e3, drot_deg=drot, dc_mm=dc * 1e3)
    why = []
    if n_touches < CONV_MIN_TOUCHES:
        why.append("need %d touches" % CONV_MIN_TOUCHES)
    if dpos >= CONV_POS or drot >= CONV_ROT or dc >= CONV_POS:
        why.append("still moving")
    if not cur.touch_rms < CONV_TOUCH_RMS:
        why.append("touch RMS too high")
    if scale_mode == "auto" and prev.scale_estimated != cur.scale_estimated:
        why.append("scale just switched on")
    if scale_mode == "auto" and not cur.scale_estimated:
        why.append("touches don't span the fixture yet (scale not estimated)")
    info["why"] = "; ".join(why)
    return not why, info


# ---------------------------------------------------------------- touches


def next_led(ledmap, touched_rows, skip_rows=(), w_side=0.3, reachable_only=True):
    """Most informative next LED: far from those already touched (in F) and on a
    different side (normal differs), restricted to mapped LEDs the tracker's base can
    reach (LedMap.reachable; reachable_only=False for a stylus, which reaches them all).
    Without touches, the LED at one end of the map's major axis."""
    cand = np.nonzero(ledmap.mapped & (ledmap.reachable if reachable_only else True))[0]
    if not len(cand):
        cand = np.nonzero(ledmap.mapped)[0]
    if not len(cand):
        cand = np.arange(len(ledmap.p))
    excl = set(touched_rows) | set(skip_rows)
    cand = np.array([i for i in cand if i not in excl])
    if not len(cand):
        return None
    if not touched_rows:
        proj = (ledmap.p[cand] - ledmap.centroid) @ ledmap.axes[:, 0]
        return int(cand[np.argmax(proj)])
    T = ledmap.p[list(touched_rows)]
    Tn = ledmap.n[list(touched_rows)]
    dmin = np.linalg.norm(ledmap.p[cand][:, None] - T[None], axis=2).min(1)
    side = 1.0 - (ledmap.n[cand] @ Tn.T).max(1)  # 0 same side .. 2 opposite
    score = dmin / ledmap.extent.max() + w_side * side / 2
    return int(cand[np.argmax(score)])


class HoldDetector:
    """§5 step 3 'hold': fires once the contact point has stayed within HOLD_POS and the
    rotation within HOLD_ROT of their means for HOLD_S. Then re-arms only after the
    tracker moves REARM_POS away. Feed it T_WT samples; it returns the mean pose on a hold."""

    def __init__(self, hold_s=HOLD_S, pos=HOLD_POS, rot=HOLD_ROT, rearm=REARM_POS):
        self.hold_s, self.pos, self.rot, self.rearm = hold_s, pos, rot, rearm
        self.buf = deque()
        self.still_since = None
        self.armed_at = None  # position of the last hold; None = armed
        self.status = {"progress": 0.0, "pos_mm": None, "rot_deg": None, "armed": True}
        self._last_eval = -1.0

    def reset(self, keep_arm=False):
        """Start over. keep_arm: still require the move-away after the last hold (so a
        tracker still resting on the previous LED can't count for the next one)."""
        self.buf.clear()
        self.still_since = None
        if not keep_arm:
            self.armed_at = None

    def feed(self, t, M, c):
        p = M[:3, :3] @ c + M[:3, 3]
        q = fr.mat_to_quat(M[:3, :3])
        self.buf.append((t, p, q, M))
        while self.buf and self.buf[0][0] < t - self.hold_s - 0.05:
            self.buf.popleft()
        if self.armed_at is not None:
            if np.linalg.norm(p - self.armed_at) > self.rearm:
                self.armed_at = None
                self.still_since = None
            self.status = {"progress": 0.0, "pos_mm": None, "rot_deg": None, "armed": False}
            return None
        if self.still_since is None:
            self.still_since = t
        win = [b for b in self.buf if b[0] >= max(self.still_since, t - self.hold_s)]
        P = np.array([b[1] for b in win])
        Q = np.array([b[2] for b in win])
        dpos = float(np.linalg.norm(P - P.mean(0), axis=1).max())
        qm = np.linalg.eigh(Q.T @ Q)[1][:, -1]
        drot = float(np.degrees(2 * np.arccos(np.clip(np.abs(Q @ qm), 0, 1))).max())
        if dpos > self.pos or drot > self.rot:
            # Restart the stillness window from the latest few samples.
            self.still_since = t
            win = win[-1:]
        span = t - self.still_since
        self.status = {
            "progress": min(1.0, span / self.hold_s),
            "pos_mm": dpos * 1e3,
            "rot_deg": drot,
            "armed": True,
        }
        if span >= self.hold_s and len(win) >= 10:
            Ms = np.array([b[3] for b in win])
            mean = fr.mean_pose(Ms)
            self.armed_at = mean[:3, :3] @ c + mean[:3, 3]
            self.still_since = None
            return mean
        return None


# ---------------------------------------------------------------- mount record


def mount_transform(T_WT_mount, T_WF):
    """§5 step 5: T_TF = T_WT^-1 . T_WF (a similarity: carries the map scale s)."""
    return fr.inv(T_WT_mount) @ T_WF


def save_mount(
    path, T_TF, fit_result=None, ledmap=None, device=None, name=None, touches=(), extra=None
):
    s, R, t = fr.sim_parts(T_TF)
    doc = {
        "version": 1,
        "kind": "splanc-tracker-mount",
        "name": name,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "device": device,
        "frames": "T = tracker head frame (libsurvive POSE), F = Splanc LED map frame (+Y up). "
        "x_T = s * R_TF @ p_F + t_TF; T_WF = T_WT @ T_TF. W = libsurvive world (+Z up).",
        "T_TF": T_TF.tolist(),
        "s": s,
        "R_TF": R.tolist(),
        "q_TF_wxyz": fr.mat_to_quat(R).tolist(),
        "t_TF": t.tolist(),
        "map": ledmap.summary() if ledmap is not None else None,
        "calibration": fit_result.to_json() if fit_result is not None else None,
        "touches": [tc.to_json(ledmap) for tc in touches],
    }
    if extra:
        doc.update(extra)
    with open(path, "w") as f:
        json.dump(doc, f, indent=1)
    return doc


def load_mount(path):
    """Returns (T_TF 4x4, doc)."""
    with open(path) as f:
        doc = json.load(f)
    return np.array(doc["T_TF"], float), doc


def live_fixture_pose(T_WT, T_TF):
    """T_WF = T_WT . T_TF."""
    return T_WT @ T_TF
