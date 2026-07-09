"""Bundle adjustment over LED points (M3, design doc §8.3 step 2).

The problem is bipartite: every reprojection residual touches exactly one LED
point and one camera pose. With WebXR poses taken as fixed (they are already
metric — design doc §8.3 "Scale"), the residual for an observation depends only
on its own point's 3 parameters — the Jacobian is EXACTLY block-diagonal in the
points, i.e. the joint problem decomposes into P independent 3-parameter
problems sharing one fixed pose frame (no cross-LED registration needed).

We exploit that directly: a batched Levenberg–Marquardt with ANALYTIC
Jacobians, vectorized across all LEDs at once (per-LED normal equations are
3×3, solved with one batched ``np.linalg.solve``; per-LED damping and step
acceptance). This replaced ``scipy.optimize.least_squares`` over one giant
sparse system, whose numerically-differentiated Jacobian dominated solve time
(~30× slower at 128-LED scale) — profiled on a real capture, 2026-07-05.
Robustness matches the previous solver: component-wise Huber via IRLS weights.
Adding pose parameters later (VIO drift, §13) means reintroducing cross-LED
coupling — that future solver replaces this seam wholesale.
"""

from __future__ import annotations

from typing import Tuple

import numpy as np

from .camera import quat_to_rotmat


class _Reprojector:
    """Precomputes per-observation pose/intrinsics terms for fast residuals.

    Poses are fixed, so the world→camera rotations are computed once up front;
    each residual evaluation is then pure vectorized arithmetic.
    """

    def __init__(
        self,
        point_idx: np.ndarray,
        obs_p: np.ndarray,
        obs_q: np.ndarray,
        obs_k: np.ndarray,
        obs_uv: np.ndarray,
    ) -> None:
        self.point_idx = point_idx
        self.obs_p = obs_p
        self.obs_uv = obs_uv
        self.fx = obs_k[:, 0]
        self.fy = obs_k[:, 1]
        self.cx = obs_k[:, 2]
        self.cy = obs_k[:, 3]
        # R_cw^T per observation, so X_cam = R_cw^T (X_world - p).
        self.r_cw_t = np.stack([quat_to_rotmat(q).T for q in obs_q], axis=0)

    def reproject(self, points: np.ndarray) -> np.ndarray:
        """Predicted ``(M, 2)`` pixels for the given ``(P, 3)`` points."""
        pts = points[self.point_idx]  # (M, 3)
        delta = pts - self.obs_p  # (M, 3)
        x_cam = np.einsum("mij,mj->mi", self.r_cw_t, delta)  # (M, 3)
        depth = -x_cam[:, 2]
        safe = np.where(np.abs(depth) < 1e-9, 1e-9, depth)
        u = self.cx + self.fx * (x_cam[:, 0] / safe)
        v = self.cy - self.fy * (x_cam[:, 1] / safe)
        return np.column_stack((u, v))

    def residuals_per_obs(self, points: np.ndarray) -> np.ndarray:
        """Euclidean reprojection error per observation, shape ``(M,)``."""
        d = self.reproject(points) - self.obs_uv
        return np.linalg.norm(d, axis=1)


def _residuals_and_jac(
    repro: _Reprojector, points: np.ndarray
) -> Tuple[np.ndarray, np.ndarray]:
    """Residuals ``(M, 2)`` and analytic Jacobians ``(M, 2, 3)`` w.r.t. the point.

    With ``xc = Rᵀ(X − p)``, ``d = −xc_z``:
      ∂u/∂xc = fx·[1/d, 0, xc_x/d²],  ∂v/∂xc = [0, −fy/d, −fy·xc_y/d²],
    chained with ∂xc/∂X = Rᵀ.
    """
    pts = points[repro.point_idx]
    delta = pts - repro.obs_p
    x_cam = np.einsum("mij,mj->mi", repro.r_cw_t, delta)
    depth = -x_cam[:, 2]
    d = np.where(np.abs(depth) < 1e-9, 1e-9, depth)
    u = repro.cx + repro.fx * (x_cam[:, 0] / d)
    v = repro.cy - repro.fy * (x_cam[:, 1] / d)
    res = np.column_stack((u, v)) - repro.obs_uv

    m = len(d)
    j_cam = np.zeros((m, 2, 3))
    j_cam[:, 0, 0] = repro.fx / d
    j_cam[:, 0, 2] = repro.fx * x_cam[:, 0] / d**2
    j_cam[:, 1, 1] = -repro.fy / d
    j_cam[:, 1, 2] = -repro.fy * x_cam[:, 1] / d**2
    jac = np.einsum("mab,mbj->maj", j_cam, repro.r_cw_t)
    return res, jac


def _huber_weights(res: np.ndarray, delta: float) -> np.ndarray:
    """Component-wise IRLS weights for the Huber loss (matches scipy's
    per-component 'huber' with f_scale=delta)."""
    a = np.abs(res)
    return np.where(a <= delta, 1.0, delta / np.maximum(a, 1e-12))


def _huber_cost_per_point(
    res: np.ndarray, point_idx: np.ndarray, n_points: int, delta: float
) -> np.ndarray:
    a = np.abs(res)
    rho = np.where(a <= delta, res**2, 2 * delta * a - delta**2)
    return np.bincount(point_idx, weights=rho.sum(axis=1), minlength=n_points)


def _scatter_sum(point_idx: np.ndarray, values: np.ndarray, n_points: int) -> np.ndarray:
    """Per-point sums of ``(M, ...)`` values — bincount per trailing component
    (much faster than ``np.add.at``'s unbuffered scatter)."""
    flat = values.reshape(len(values), -1)
    out = np.empty((n_points, flat.shape[1]))
    for c in range(flat.shape[1]):
        out[:, c] = np.bincount(point_idx, weights=flat[:, c], minlength=n_points)
    return out.reshape((n_points,) + values.shape[1:])


def bundle_adjust(
    points0: np.ndarray,
    point_idx: np.ndarray,
    obs_p: np.ndarray,
    obs_q: np.ndarray,
    obs_k: np.ndarray,
    obs_uv: np.ndarray,
    *,
    huber_delta: float = 1.5,
    max_nfev: int = 60,
) -> Tuple[np.ndarray, _Reprojector]:
    """Refine ``points0`` (``(P, 3)``) to minimize Huber reprojection error.

    Batched per-LED Levenberg–Marquardt (see module docstring). ``max_nfev``
    caps LM iterations. Returns the refined points and the
    :class:`_Reprojector` (reused by the caller for outlier residuals /
    quality metrics).
    """
    n_points = len(points0)
    repro = _Reprojector(point_idx, obs_p, obs_q, obs_k, obs_uv)
    if len(obs_uv) == 0 or n_points == 0:
        return points0, repro

    points = np.array(points0, dtype=float)
    lam = np.full(n_points, 1e-3)
    frozen = np.zeros(n_points, dtype=bool)
    eye3 = np.eye(3)

    res, jac = _residuals_and_jac(repro, points)
    cost = _huber_cost_per_point(res, point_idx, n_points, huber_delta)

    for _ in range(max_nfev):
        if frozen.all():
            break
        # Per-LED normal equations from Huber-weighted residuals/Jacobians.
        w = _huber_weights(res, huber_delta)
        jw = jac * w[:, :, None]
        a_contrib = np.einsum("mai,maj->mij", jw, jac)
        g_contrib = np.einsum("mai,ma->mi", jw, res)
        A = _scatter_sum(point_idx, a_contrib, n_points)
        g = _scatter_sum(point_idx, g_contrib, n_points)

        # LM damping on the diagonal; ε guards observation-poor/degenerate LEDs.
        diag = np.einsum("pii->pi", A)
        A_damped = A + lam[:, None, None] * (diag[:, :, None] * eye3) + 1e-12 * eye3
        try:
            dx = np.linalg.solve(A_damped, g[:, :, None])[:, :, 0]
        except np.linalg.LinAlgError:
            dx = np.stack([np.linalg.lstsq(A_damped[i], g[i], rcond=None)[0] for i in range(n_points)])
        dx[frozen] = 0.0

        trial = points - dx
        res_t, jac_t = _residuals_and_jac(repro, trial)
        cost_t = _huber_cost_per_point(res_t, point_idx, n_points, huber_delta)

        accept = (cost_t <= cost) & ~frozen
        points[accept] = trial[accept]
        lam = np.where(accept, np.maximum(lam / 3.0, 1e-9), np.minimum(lam * 5.0, 1e6))
        frozen |= accept & (np.linalg.norm(dx, axis=1) < 1e-8)
        # A step rejected at very high damping cannot improve further.
        frozen |= ~accept & (lam >= 1e6)

        if accept.any():
            res, jac = _residuals_and_jac(repro, points)
            cost = np.minimum(cost, cost_t)

    return points, repro
