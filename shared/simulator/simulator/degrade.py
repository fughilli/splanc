"""Injectable degradations for the simulator (M9, design doc §10.1).

The detection-log path models the two error sources that survive the (idealized)
CV+pose pipeline:

  - **pixel noise** on the observed centroid ``(u, v)``;
  - **pose noise** — the phone reports a *noisy* VIO pose while the pixel was
    produced by the *true* pose, so the reconstruction sees an inconsistent
    (pixel, pose) pair, exactly as on a real device.

Plus per-observation **dropout**. Frame-mode degradations (blur, rolling
shutter, phantom blobs) belong to the future frame renderer for M6.

Defaults are the nominal-noise point from docs/decisions.md.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from reconstruction import quat_to_rotmat, rotmat_to_quat


@dataclass(frozen=True)
class NoiseModel:
    pixel_noise_px: float = 0.0
    pose_noise_deg: float = 0.0
    pose_noise_pos_m: float = 0.0
    dropout_prob: float = 0.0

    @property
    def is_zero(self) -> bool:
        return (
            self.pixel_noise_px == 0.0
            and self.pose_noise_deg == 0.0
            and self.pose_noise_pos_m == 0.0
            and self.dropout_prob == 0.0
        )


NONE = NoiseModel()
NOMINAL = NoiseModel(
    pixel_noise_px=0.5,
    pose_noise_deg=1.0,
    pose_noise_pos_m=0.003,
    dropout_prob=0.0,
)

PRESETS = {"none": NONE, "nominal": NOMINAL}


def _random_small_rotation(angle_rad: float, rng: np.random.Generator) -> np.ndarray:
    """Rotation matrix for ``angle_rad`` about a uniformly random axis."""
    if angle_rad == 0.0:
        return np.eye(3)
    axis = rng.normal(size=3)
    n = np.linalg.norm(axis)
    if n == 0.0:
        return np.eye(3)
    axis = axis / n
    c, s = np.cos(angle_rad), np.sin(angle_rad)
    x, y, z = axis
    cross = np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]], dtype=float)
    return c * np.eye(3) + s * cross + (1 - c) * np.outer(axis, axis)


def perturb_pose(p, q, noise: NoiseModel, rng: np.random.Generator):
    """Return a noisy ``(p, q)`` reported pose given the true pose."""
    p = np.asarray(p, dtype=float)
    if noise.pose_noise_pos_m > 0.0:
        p = p + rng.normal(0.0, noise.pose_noise_pos_m, size=3)
    if noise.pose_noise_deg > 0.0:
        angle = rng.normal(0.0, np.radians(noise.pose_noise_deg))
        delta = _random_small_rotation(angle, rng)
        q = rotmat_to_quat(delta @ quat_to_rotmat(q))
    return p, tuple(float(c) for c in q)


def perturb_pixel(u: float, v: float, noise: NoiseModel, rng: np.random.Generator):
    if noise.pixel_noise_px > 0.0:
        u = u + rng.normal(0.0, noise.pixel_noise_px)
        v = v + rng.normal(0.0, noise.pixel_noise_px)
    return float(u), float(v)
