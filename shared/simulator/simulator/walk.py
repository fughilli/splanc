"""Virtual camera path for the simulator (M9).

Generates the *true* camera poses of a walk around a fixture. The design (§12)
prescribes an arc so that every LED is seen from a spread of directions (enough
parallax for triangulation); a straight-on walk is the degenerate case the
production UI rejects.
"""

from __future__ import annotations

from typing import List, Tuple

import numpy as np

from reconstruction import look_at_quat


def arc_walk(
    fixture_points: np.ndarray,
    *,
    views: int = 60,
    arc_degrees: float = 120.0,
    elevation_m: float = 0.4,
    radius_factor: float = 2.0,
) -> List[Tuple[np.ndarray, tuple]]:
    """Camera stations on an arc around ``fixture_points``, each looking at the
    centroid. Returns a list of ``(position, quaternion)`` true poses.
    """
    pts = np.asarray(fixture_points, dtype=float)
    centroid = pts.mean(axis=0)
    span = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0)))
    radius = max(span * radius_factor, span + 0.5)

    half = np.radians(arc_degrees) / 2.0
    angles = np.linspace(-half, half, views) if views > 1 else np.array([0.0])
    poses: List[Tuple[np.ndarray, tuple]] = []
    for k, a in enumerate(angles):
        # A small vertical sweep across the walk gives out-of-plane parallax,
        # which matters for planar fixtures (line/grid).
        vert = elevation_m * np.cos(np.pi * (k / max(len(angles) - 1, 1) - 0.5))
        eye = centroid + np.array([radius * np.sin(a), vert, radius * np.cos(a)])
        q = look_at_quat(eye, centroid)
        poses.append((eye, q))
    return poses
