/**
 * Pinhole camera math — the TypeScript mirror of
 * `pi/reconstruction/reconstruction/camera.py` (the production camera model).
 * Conventions (design doc §7.4, asserted against M3 in tests):
 *
 *   - Pose `(p, q)`: `p` camera position in the reference frame, `q = [x,y,z,w]`
 *     camera-to-world unit quaternion.
 *   - Camera-local frame: +X right, +Y up, looks down **-Z**.
 *   - Pixels: origin top-left, u right, v down. `K = [fx, fy, cx, cy]`.
 *     u = cx + fx·(x/d), v = cy − fy·(y/d) with d = −z_cam.
 *
 * Used by the UI's result preview and the synthetic CV-pipeline tests; the
 * production reprojection happens in M3 on the Pi.
 */

import type { Intrinsics, Pose, Quat, Vec3 } from "@ledmapper/protocol";

export type Mat3 = [number, number, number, number, number, number, number, number, number];

/** Camera-to-world rotation matrix (row-major) from `[x, y, z, w]`. */
export function quatToRotMat(q: Quat): Mat3 {
  const [x, y, z, w] = q;
  const n = x * x + y * y + z * z + w * w;
  if (n === 0) throw new Error("zero-norm quaternion");
  const s = 2 / n;
  const xx = x * x * s, yy = y * y * s, zz = z * z * s;
  const xy = x * y * s, xz = x * z * s, yz = y * z * s;
  const wx = w * x * s, wy = w * y * s, wz = w * z * s;
  return [
    1 - (yy + zz), xy - wz, xz + wy,
    xy + wz, 1 - (xx + zz), yz - wx,
    xz - wy, yz + wx, 1 - (xx + yy),
  ];
}

/** World point -> camera frame: X_cam = R^T (X_world - p). */
export function worldToCamera(pose: Pose, xw: Vec3): Vec3 {
  const r = quatToRotMat(pose.q);
  const dx = xw[0] - pose.p[0], dy = xw[1] - pose.p[1], dz = xw[2] - pose.p[2];
  return [
    r[0] * dx + r[3] * dy + r[6] * dz,
    r[1] * dx + r[4] * dy + r[7] * dz,
    r[2] * dx + r[5] * dy + r[8] * dz,
  ];
}

/**
 * Project a world point to pixels. Returns `{u, v, depth}`; `depth <= 0`
 * means the point is behind the camera and the pixel is meaningless.
 */
export function project(pose: Pose, k: Intrinsics, xw: Vec3): { u: number; v: number; depth: number } {
  const [fx, fy, cx, cy] = k;
  const xc = worldToCamera(pose, xw);
  const depth = -xc[2];
  const safe = Math.abs(depth) < 1e-12 ? 1e-12 : depth;
  return { u: cx + (fx * xc[0]) / safe, v: cy - (fy * xc[1]) / safe, depth };
}

/**
 * Orientation of a camera at `eye` looking at `target` (camera-to-world,
 * -Z toward the target). Mirrors `camera.look_at_quat`.
 */
export function lookAtQuat(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Quat {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  const fn = Math.hypot(fx, fy, fz);
  if (fn === 0) throw new Error("eye and target coincide");
  fx /= fn; fy /= fn; fz /= fn;
  let [ux, uy, uz] = up;
  let rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
  let rn = Math.hypot(rx, ry, rz);
  if (rn < 1e-9) {
    [ux, uy, uz] = Math.abs(fy) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    rx = fy * uz - fz * uy; ry = fz * ux - fx * uz; rz = fx * uy - fy * ux;
    rn = Math.hypot(rx, ry, rz);
  }
  rx /= rn; ry /= rn; rz /= rn;
  const tux = ry * fz - rz * fy, tuy = rz * fx - rx * fz, tuz = rx * fy - ry * fx;
  // Column-stack (right, trueUp, -forward), row-major.
  const m: Mat3 = [rx, tux, -fx, ry, tuy, -fy, rz, tuz, -fz];
  return rotMatToQuat(m);
}

/** Quaternion `[x, y, z, w]` from a row-major rotation matrix. */
export function rotMatToQuat(m: Mat3): Quat {
  const m00 = m[0], m01 = m[1], m02 = m[2];
  const m10 = m[3], m11 = m[4], m12 = m[5];
  const m20 = m[6], m21 = m[7], m22 = m[8];
  const t = m00 + m11 + m22;
  let x: number, y: number, z: number, w: number;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const n = Math.hypot(x, y, z, w);
  return [x / n, y / n, z / n, w / n];
}
