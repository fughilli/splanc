"""Pinhole camera model for LED Mapper (M3).

This is the production camera model used by reconstruction's bundle adjustment
to reproject points, and — because the simulator (M9) must produce data that is
*in distribution* for the solver — it is imported by the simulator to forward-
project ground-truth LEDs into synthetic detections. Keeping a single model
means the synthetic data and the solver can never disagree about conventions.

Conventions (matching WebXR / OpenGL, design doc §7.4):

  - A camera pose is ``(p, q)`` where ``p`` is the camera position in the
    reference ("world") frame and ``q = [x, y, z, w]`` is the unit quaternion
    of the camera orientation, mapping camera-local axes into world axes
    (camera-to-world).
  - The camera-local frame is +X right, +Y up, and looks down **-Z**.
  - Image coordinates have their origin at the top-left, ``u`` increasing right
    and ``v`` increasing down. Intrinsics are ``K = [fx, fy, cx, cy]``.

The forward projection and the back-projected ray are exact inverses, which is
asserted in the unit tests.
"""

from __future__ import annotations

from typing import Sequence, Tuple

import numpy as np

# Type aliases mirroring the protocol's small fixed-arity arrays.
Vec3 = Tuple[float, float, float]
Quat = Tuple[float, float, float, float]
Intrinsics = Tuple[float, float, float, float]


def quat_to_rotmat(q: Sequence[float]) -> np.ndarray:
    """Camera-to-world rotation matrix from a quaternion ``[x, y, z, w]``.

    Columns of the returned matrix are the camera's local axes expressed in
    world coordinates: ``R[:, 0]`` is camera +X (right), ``R[:, 1]`` camera +Y
    (up), ``R[:, 2]`` camera +Z (which points *away* from the scene since the
    camera looks down -Z).
    """
    x, y, z, w = (float(c) for c in q)
    n = x * x + y * y + z * z + w * w
    if n == 0.0:
        raise ValueError("zero-norm quaternion")
    s = 2.0 / n
    xx, yy, zz = x * x * s, y * y * s, z * z * s
    xy, xz, yz = x * y * s, x * z * s, y * z * s
    wx, wy, wz = w * x * s, w * y * s, w * z * s
    return np.array(
        [
            [1.0 - (yy + zz), xy - wz, xz + wy],
            [xy + wz, 1.0 - (xx + zz), yz - wx],
            [xz - wy, yz + wx, 1.0 - (xx + yy)],
        ],
        dtype=float,
    )


def rotmat_to_quat(r: np.ndarray) -> Quat:
    """Quaternion ``[x, y, z, w]`` from a rotation matrix (inverse of above)."""
    m = np.asarray(r, dtype=float)
    t = np.trace(m)
    if t > 0.0:
        s = np.sqrt(t + 1.0) * 2.0
        w = 0.25 * s
        x = (m[2, 1] - m[1, 2]) / s
        y = (m[0, 2] - m[2, 0]) / s
        z = (m[1, 0] - m[0, 1]) / s
    elif m[0, 0] > m[1, 1] and m[0, 0] > m[2, 2]:
        s = np.sqrt(1.0 + m[0, 0] - m[1, 1] - m[2, 2]) * 2.0
        w = (m[2, 1] - m[1, 2]) / s
        x = 0.25 * s
        y = (m[0, 1] + m[1, 0]) / s
        z = (m[0, 2] + m[2, 0]) / s
    elif m[1, 1] > m[2, 2]:
        s = np.sqrt(1.0 + m[1, 1] - m[0, 0] - m[2, 2]) * 2.0
        w = (m[0, 2] - m[2, 0]) / s
        x = (m[0, 1] + m[1, 0]) / s
        y = 0.25 * s
        z = (m[1, 2] + m[2, 1]) / s
    else:
        s = np.sqrt(1.0 + m[2, 2] - m[0, 0] - m[1, 1]) * 2.0
        w = (m[1, 0] - m[0, 1]) / s
        x = (m[0, 2] + m[2, 0]) / s
        y = (m[1, 2] + m[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w], dtype=float)
    q /= np.linalg.norm(q)
    return (float(q[0]), float(q[1]), float(q[2]), float(q[3]))


def look_at_quat(eye: np.ndarray, target: np.ndarray, up: Sequence[float] = (0.0, 1.0, 0.0)) -> Quat:
    """Orientation (as ``[x, y, z, w]``) of a camera at ``eye`` looking at ``target``.

    Builds the camera-to-world rotation whose -Z axis points from ``eye`` toward
    ``target``, then converts to a quaternion.
    """
    eye = np.asarray(eye, dtype=float)
    target = np.asarray(target, dtype=float)
    forward = target - eye
    fn = np.linalg.norm(forward)
    if fn == 0.0:
        raise ValueError("eye and target coincide")
    forward = forward / fn
    up_v = np.asarray(up, dtype=float)
    right = np.cross(forward, up_v)
    rn = np.linalg.norm(right)
    if rn < 1e-9:
        # forward is parallel to up; pick an arbitrary perpendicular up.
        up_v = np.array([1.0, 0.0, 0.0]) if abs(forward[1]) > 0.9 else np.array([0.0, 1.0, 0.0])
        right = np.cross(forward, up_v)
        rn = np.linalg.norm(right)
    right = right / rn
    true_up = np.cross(right, forward)
    # Camera +Z points away from the scene, hence -forward.
    r_cw = np.column_stack((right, true_up, -forward))
    return rotmat_to_quat(r_cw)


def world_to_camera(p: Sequence[float], q: Sequence[float], x_world: np.ndarray) -> np.ndarray:
    """Transform world point(s) into the camera frame. Accepts (3,) or (N, 3)."""
    r_cw = quat_to_rotmat(q)
    p = np.asarray(p, dtype=float)
    x_world = np.asarray(x_world, dtype=float)
    # X_cam = R_cw^T (X_world - p)
    return (x_world - p) @ r_cw  # (x_world - p) @ R  ==  (R^T (x_world - p)^T)^T


def project(
    p: Sequence[float],
    q: Sequence[float],
    k: Sequence[float],
    x_world: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    """Project world point(s) to pixels.

    Returns ``(uv, depth)`` where ``uv`` is shape ``(2,)`` or ``(N, 2)`` and
    ``depth`` is the positive distance in front of the camera (negative or zero
    means the point is behind the image plane and the pixel is meaningless).
    """
    fx, fy, cx, cy = (float(c) for c in k)
    x_cam = world_to_camera(p, q, x_world)
    single = x_cam.ndim == 1
    x_cam = np.atleast_2d(x_cam)
    depth = -x_cam[:, 2]  # camera looks down -Z, so depth = -z_cam
    safe = np.where(np.abs(depth) < 1e-12, 1e-12, depth)
    x_n = x_cam[:, 0] / safe
    y_n = x_cam[:, 1] / safe
    u = cx + fx * x_n
    v = cy - fy * y_n  # image v grows downward, camera +Y is up
    uv = np.column_stack((u, v))
    if single:
        return uv[0], depth[0]
    return uv, depth


def back_project_ray(
    p: Sequence[float],
    q: Sequence[float],
    k: Sequence[float],
    u: float,
    v: float,
) -> Tuple[np.ndarray, np.ndarray]:
    """Ray (origin, unit direction) in world space through a pixel ``(u, v)``.

    The exact inverse of :func:`project`: projecting any point ``origin + t*dir``
    (``t > 0``) returns ``(u, v)``.
    """
    fx, fy, cx, cy = (float(c) for c in k)
    x_n = (u - cx) / fx
    y_n = -(v - cy) / fy
    d_cam = np.array([x_n, y_n, -1.0], dtype=float)
    r_cw = quat_to_rotmat(q)
    d_world = r_cw @ d_cam
    d_world /= np.linalg.norm(d_world)
    return np.asarray(p, dtype=float), d_world
