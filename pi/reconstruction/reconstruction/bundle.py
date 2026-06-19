"""Sparse bundle adjustment over LED points (M3, design doc §8.3 step 2).

The problem is bipartite: every reprojection residual touches exactly one LED
point and one camera pose. With WebXR poses taken as fixed (they are already
metric — design doc §8.3 "Scale"), the residual for an observation depends only
on its own point's 3 parameters, so the Jacobian is block-diagonal in the points.
We still solve it as one global least-squares problem with a sparse Jacobian, via
``scipy.optimize.least_squares`` with a Huber loss — this is the canonical sparse
BA and leaves a clean seam to add pose parameters later if VIO drift matters
(design doc §13).
"""

from __future__ import annotations

from typing import Tuple

import numpy as np
from scipy.optimize import least_squares
from scipy.sparse import lil_matrix

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


def _flat_residual(x: np.ndarray, repro: _Reprojector, n_points: int) -> np.ndarray:
    points = x.reshape(n_points, 3)
    return (repro.reproject(points) - repro.obs_uv).reshape(-1)


def _jac_sparsity(point_idx: np.ndarray, n_obs: int, n_points: int) -> lil_matrix:
    s = lil_matrix((2 * n_obs, 3 * n_points), dtype=float)
    rows = np.arange(n_obs)
    for axis in (0, 1):
        r = 2 * rows + axis
        for c in range(3):
            s[r, 3 * point_idx + c] = 1.0
    return s


def bundle_adjust(
    points0: np.ndarray,
    point_idx: np.ndarray,
    obs_p: np.ndarray,
    obs_q: np.ndarray,
    obs_k: np.ndarray,
    obs_uv: np.ndarray,
    *,
    huber_delta: float = 1.5,
    max_nfev: int = 200,
) -> Tuple[np.ndarray, _Reprojector]:
    """Refine ``points0`` (``(P, 3)``) to minimize Huber reprojection error.

    Returns the refined points and the :class:`_Reprojector` (reused by the
    caller for outlier residuals / quality metrics).
    """
    n_points = len(points0)
    repro = _Reprojector(point_idx, obs_p, obs_q, obs_k, obs_uv)
    if len(obs_uv) == 0 or n_points == 0:
        return points0, repro
    sparsity = _jac_sparsity(point_idx, len(obs_uv), n_points)
    result = least_squares(
        _flat_residual,
        points0.reshape(-1),
        jac_sparsity=sparsity,
        loss="huber",
        f_scale=huber_delta,
        method="trf",
        max_nfev=max_nfev,
        args=(repro, n_points),
    )
    return result.x.reshape(n_points, 3), repro
