"""Rigid / similarity transforms, quaternions and the plane maths (§2 of the API doc).

Frames
------
W  The tracking world as the pose source reports it *after* conversion to this
   app's convention: libsurvive's world, gravity-aligned, right-handed, metres,
   **+Z up**. (libsurvive already is; a SteamVR source, +Y up, must convert with
   STEAMVR_TO_W before handing poses over.)
T  The tracker's reporting frame (libsurvive "head" frame for a Vive Tracker 3.0):
   origin at the 1/4" mount on the base, +Z pointing *out of* the base (the
   sensors sit at z < 0), so the contact face's outward normal is +Z_T.
F  The fixture's LED map frame from Splanc: metres, +Y up.

A pose is kept as a 4x4 matrix. A similarity (with map scale s) is
    x_W = s * R @ p + t
stored as the 4x4 [[s R, t], [0, 1]]; `sim_parts` splits it back into (s, R, t).
Quaternions are (w, x, y, z), as libsurvive streams them.
"""

import numpy as np

# Maps a +Y-up frame to a +Z-up frame: (x, y, z) -> (x, -z, y), a +90 deg turn about X.
# Used for SteamVR -> W, and as the initial guess of the F (+Y up) -> W (+Z up) rotation.
Y_UP_TO_Z_UP = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, -1.0], [0.0, 1.0, 0.0]])
STEAMVR_TO_W = Y_UP_TO_Z_UP


def quat_to_mat(q):
    """(w, x, y, z) -> 3x3 rotation. Normalises q."""
    w, x, y, z = np.asarray(q, float) / np.linalg.norm(q)
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


def mat_to_quat(R):
    """3x3 rotation -> (w, x, y, z) with w >= 0."""
    R = np.asarray(R, float)
    K = (
        np.array(
            [
                [
                    R[0, 0] - R[1, 1] - R[2, 2],
                    R[1, 0] + R[0, 1],
                    R[2, 0] + R[0, 2],
                    R[2, 1] - R[1, 2],
                ],
                [
                    R[1, 0] + R[0, 1],
                    R[1, 1] - R[0, 0] - R[2, 2],
                    R[2, 1] + R[1, 2],
                    R[0, 2] - R[2, 0],
                ],
                [
                    R[2, 0] + R[0, 2],
                    R[2, 1] + R[1, 2],
                    R[2, 2] - R[0, 0] - R[1, 1],
                    R[1, 0] - R[0, 1],
                ],
                [
                    R[2, 1] - R[1, 2],
                    R[0, 2] - R[2, 0],
                    R[1, 0] - R[0, 1],
                    R[0, 0] + R[1, 1] + R[2, 2],
                ],
            ]
        )
        / 3.0
    )
    vals, vecs = np.linalg.eigh(K)
    x, y, z, w = vecs[:, np.argmax(vals)]
    q = np.array([w, x, y, z])
    return q if q[0] >= 0 else -q


def rotvec_to_mat(v):
    v = np.asarray(v, float)
    th = np.linalg.norm(v)
    if th < 1e-12:
        K = skew(v)
        return np.eye(3) + K
    k = v / th
    K = skew(k)
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * K @ K


def mat_to_rotvec(R):
    R = np.asarray(R, float)
    c = np.clip((np.trace(R) - 1) / 2, -1.0, 1.0)
    th = np.arccos(c)
    if th < 1e-9:
        return np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]]) / 2
    if np.pi - th < 1e-6:
        # Near 180 deg: axis from the diagonal.
        k = np.sqrt(np.maximum((np.diag(R) + 1) / 2, 0))
        i = np.argmax(k)
        k[(i + 1) % 3] = np.copysign(k[(i + 1) % 3], R[i, (i + 1) % 3])
        k[(i + 2) % 3] = np.copysign(k[(i + 2) % 3], R[i, (i + 2) % 3])
        return th * k / np.linalg.norm(k)
    return (
        th / (2 * np.sin(th)) * np.array([R[2, 1] - R[1, 2], R[0, 2] - R[2, 0], R[1, 0] - R[0, 1]])
    )


def skew(v):
    x, y, z = v
    return np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]], float)


def rot_angle_deg(R):
    """Rotation angle of R in degrees."""
    return float(np.degrees(np.arccos(np.clip((np.trace(R) - 1) / 2, -1.0, 1.0))))


def make_pose(R=None, t=None, s=1.0):
    M = np.eye(4)
    M[:3, :3] = s * (np.eye(3) if R is None else np.asarray(R, float))
    if t is not None:
        M[:3, 3] = t
    return M


def pose_from_pq(p, q):
    """Pose matrix from position and (w, x, y, z) quaternion."""
    return make_pose(quat_to_mat(q), p)


def sim_parts(M):
    """Split a similarity [[sR, t], [0, 1]] into (s, R, t)."""
    A = M[:3, :3]
    s = float(np.cbrt(np.linalg.det(A)))
    return s, A / s, M[:3, 3].copy()


def inv(M):
    """Inverse of a similarity transform."""
    s, R, t = sim_parts(M)
    out = np.eye(4)
    out[:3, :3] = R.T / s
    out[:3, 3] = -(R.T @ t) / s
    return out


def apply(M, p):
    """Apply a 4x4 transform to points (..., 3)."""
    p = np.asarray(p, float)
    return p @ M[:3, :3].T + M[:3, 3]


def plane_to_fixture(T_WF, n_W, d_W):
    """§2: the plane n_W . x = d_W (in W) expressed in F, for x_W = s R p + t.

    Returns (n_F, d_F) with |n_F| = 1 so that n_F . p = d_F on the plane."""
    s, R, t = sim_parts(T_WF)
    n_W = np.asarray(n_W, float)
    norm = np.linalg.norm(n_W)
    n_W, d_W = n_W / norm, d_W / norm
    n_F = R.T @ n_W
    d_F = (d_W - n_W @ t) / s
    return n_F / np.linalg.norm(n_F), float(d_F)


def sphere_to_fixture(T_WF, c_W, r_W):
    """The sphere |x - c_W| = r_W (in W) expressed in F, for x_W = s R p + t: (c_F, r_F)."""
    s, R, t = sim_parts(T_WF)
    return R.T @ (np.asarray(c_W, float) - t) / s, float(r_W) / s


def plane_from_point_normal(point, normal):
    n = np.asarray(normal, float)
    n = n / np.linalg.norm(n)
    return n, float(n @ np.asarray(point, float))


def mean_rotation(Rs):
    """Chordal L2 mean of rotations (Markley quaternion average)."""
    Q = np.array([mat_to_quat(R) for R in Rs])
    M = Q.T @ Q
    vals, vecs = np.linalg.eigh(M)
    return quat_to_mat(vecs[:, np.argmax(vals)])


def mean_pose(Ms):
    """Mean of rigid poses: mean position, averaged rotation."""
    Ms = np.asarray(Ms)
    return make_pose(mean_rotation(Ms[:, :3, :3]), Ms[:, :3, 3].mean(0))


def pose_spread(Ms, point=None):
    """(max position deviation from the mean in metres, max rotation deviation from the mean
    in degrees) of a set of rigid poses. Position is that of `point` (in the posed frame,
    default the origin), e.g. the contact point."""
    Ms = np.asarray(Ms)
    pts = (
        Ms[:, :3, 3]
        if point is None
        else np.einsum("nij,j->ni", Ms[:, :3, :3], point) + Ms[:, :3, 3]
    )
    dpos = np.linalg.norm(pts - pts.mean(0), axis=1).max()
    Rm = mean_rotation(Ms[:, :3, :3])
    drot = max(rot_angle_deg(Rm.T @ R) for R in Ms[:, :3, :3])
    return float(dpos), float(drot)


def apply_each(Ms, p):
    """One point p (3,) through each of n transforms Ms (n, 4, 4): (n, 3)."""
    Ms = np.asarray(Ms, float)
    return Ms[:, :3, :3] @ np.asarray(p, float) + Ms[:, :3, 3]


def umeyama(src, dst, with_scale=True, w=None):
    """Similarity (s, R, t) minimising sum w |dst - (s R src + t)|^2."""
    src, dst = np.asarray(src, float), np.asarray(dst, float)
    w = np.ones(len(src)) if w is None else np.asarray(w, float)
    w = w / w.sum()
    ms, md = w @ src, w @ dst
    xs, xd = src - ms, dst - md
    C = (xd * w[:, None]).T @ xs
    U, S, Vt = np.linalg.svd(C)
    D = np.eye(3)
    if np.linalg.det(U @ Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    var = (w * (xs**2).sum(1)).sum()
    s = float(np.trace(np.diag(S) @ D) / var) if with_scale else 1.0
    t = md - s * R @ ms
    return s, R, t
