"""Linear triangulation and ray-geometry helpers (M3, design doc §8.3 step 1).

The DLT-style initializer finds the world point closest (in least squares) to a
bundle of observation rays. Each observation contributes a ray from its camera
center along the back-projected pixel direction; the point minimizing the sum of
squared perpendicular distances to all rays has a closed-form solution.
"""

from __future__ import annotations

from typing import Sequence, Tuple

import numpy as np

from .camera import back_project_ray


def rays_from_observations(observations: Sequence[dict]) -> Tuple[np.ndarray, np.ndarray]:
    """Return ``(origins, directions)`` arrays, each ``(N, 3)``, for observations.

    Each observation is a dict with ``pose`` (``p``, ``q``), ``K`` and ``u``/``v``.
    """
    origins = np.empty((len(observations), 3), dtype=float)
    dirs = np.empty((len(observations), 3), dtype=float)
    for i, obs in enumerate(observations):
        o, d = back_project_ray(obs["p"], obs["q"], obs["K"], obs["u"], obs["v"])
        origins[i] = o
        dirs[i] = d
    return origins, dirs


def triangulate_point(origins: np.ndarray, dirs: np.ndarray) -> np.ndarray:
    """Closest point (least squares) to a set of rays ``origin + t*dir``.

    Solves ``A x = b`` with ``A = Σ (I - d d^T)`` and ``b = Σ (I - d d^T) o``.
    Requires ≥ 2 rays that are not all parallel.
    """
    if len(origins) < 2:
        raise ValueError("need at least 2 observations to triangulate")
    a = np.zeros((3, 3), dtype=float)
    b = np.zeros(3, dtype=float)
    for o, d in zip(origins, dirs):
        d = d / np.linalg.norm(d)
        proj = np.eye(3) - np.outer(d, d)
        a += proj
        b += proj @ o
    # lstsq is robust to a near-singular A (all rays parallel ⇒ degenerate).
    x, *_ = np.linalg.lstsq(a, b, rcond=None)
    return x


def max_parallax_deg(dirs: np.ndarray) -> float:
    """Largest angle (degrees) between any two observation ray directions.

    This is the parallax quality metric (design doc §8.3 step 4): a small value
    means all views look from nearly the same direction, so depth is poorly
    constrained.
    """
    n = len(dirs)
    if n < 2:
        return 0.0
    unit = dirs / np.linalg.norm(dirs, axis=1, keepdims=True)
    # Pairwise angles via the Gram matrix of dot products.
    cos = np.clip(unit @ unit.T, -1.0, 1.0)
    iu = np.triu_indices(n, k=1)
    angles = np.degrees(np.arccos(cos[iu]))
    return float(np.max(angles)) if angles.size else 0.0
