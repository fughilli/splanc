/**
 * Rigid-transform maths for the P4 demo (a port of the parts of the desktop demo's
 * frames.py the page needs).
 *
 * Frames: W is lhd's world (metres, +Z up), S the stylus tracker's own frame (the
 * libsurvive "head": origin at the 1/4" mount, +Z out of the base). A pose is the
 * pair (R, t) with x_W = R x_S + t; R is a row-major 3x3 (`Mat3`, 9 numbers).
 * Quaternions are (w, x, y, z), as lhd streams them.
 */

import type { Quat, Vec3 } from "./lh/types";

/** Row-major 3x3. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export interface Pose {
  R: Mat3;
  t: Vec3;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  return n > 1e-12 ? scale(a, 1 / n) : [0, 0, 1];
}

/** (w, x, y, z) -> row-major rotation. Normalises q. */
export function quatToMat(q: Quat): Mat3 {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const w = q[0] / n,
    x = q[1] / n,
    y = q[2] / n,
    z = q[3] / n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/** Rotation -> (w, x, y, z) with w >= 0 (Shepperd's method). */
export function matToQuat(R: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = R;
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [(m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s];
  }
  return q[0] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
}

/** Quaternion product a * b (w, x, y, z). */
export function quatMul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** Axis-angle (axis need not be unit) -> quaternion. */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const a = normalize(axis);
  const s = Math.sin(angle / 2);
  return [Math.cos(angle / 2), a[0] * s, a[1] * s, a[2] * s];
}

export function mulMV(R: Mat3, v: Vec3): Vec3 {
  return [
    R[0] * v[0] + R[1] * v[1] + R[2] * v[2],
    R[3] * v[0] + R[4] * v[1] + R[5] * v[2],
    R[6] * v[0] + R[7] * v[1] + R[8] * v[2],
  ];
}

export function mulMM(A: Mat3, B: Mat3): Mat3 {
  const out = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      out[i * 3 + j] = A[i * 3]! * B[j]! + A[i * 3 + 1]! * B[3 + j]! + A[i * 3 + 2]! * B[6 + j]!;
  return out as Mat3;
}

export function transpose(R: Mat3): Mat3 {
  return [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
}

/** Rotation angle of R, radians. */
export function rotAngle(R: Mat3): number {
  return Math.acos(Math.min(1, Math.max(-1, (R[0] + R[4] + R[8] - 1) / 2)));
}

export function poseFromPQ(pos: Vec3, quat: Quat): Pose {
  return { R: quatToMat(quat), t: [pos[0], pos[1], pos[2]] };
}

/** x_W = R p + t. */
export function apply(P: Pose, p: Vec3): Vec3 {
  return add(mulMV(P.R, p), P.t);
}

/** The stylus tip in the world: the pose applied to the tip offset c_S. */
export function tipWorld(P: Pose, cS: Vec3): Vec3 {
  return apply(P, cS);
}

/** The stylus axis in the world: from the tracker's origin towards the tip (as
 * flashlight.py: axis = c_S / |c_S| in S). Without a tip yet, the tracker's +Z
 * (a stylus's tip sits along it: mounts/stylus-LHR-10F97524.json has c_S ~ 18 cm
 * along +Z). */
export function axisWorld(P: Pose, cS: Vec3 | null): Vec3 {
  const a: Vec3 = cS && norm(cS) > 1e-6 ? normalize(cS) : [0, 0, 1];
  return normalize(mulMV(P.R, a));
}

/** A plane through `point` with unit normal `n`, as (n, d) with n . x = d. */
export function planeFromPointNormal(point: Vec3, n: Vec3): { n: Vec3; d: number } {
  const u = normalize(n);
  return { n: u, d: dot(u, point) };
}

/** Column-major mat4 (GLSL order) of a similarity x' = s R x + t, e.g. for /lh/mount. */
export function toColumnMajor(P: Pose, s = 1): number[] {
  const R = P.R;
  return [
    s * R[0], s * R[3], s * R[6], 0,
    s * R[1], s * R[4], s * R[7], 0,
    s * R[2], s * R[5], s * R[8], 0,
    P.t[0], P.t[1], P.t[2], 1,
  ];
}

/** Inverse of a column-major mat4 rigid/similarity pose: (s, R, t) back out. */
export function fromColumnMajor(m: ArrayLike<number>): { pose: Pose; s: number } {
  const c0: Vec3 = [m[0]!, m[1]!, m[2]!];
  const c1: Vec3 = [m[4]!, m[5]!, m[6]!];
  const c2: Vec3 = [m[8]!, m[9]!, m[10]!];
  const s = Math.cbrt(dot(c0, cross(c1, c2))) || 1;
  const R: Mat3 = [
    c0[0] / s, c1[0] / s, c2[0] / s,
    c0[1] / s, c1[1] / s, c2[1] / s,
    c0[2] / s, c1[2] / s, c2[2] / s,
  ];
  return { pose: { R, t: [m[12]!, m[13]!, m[14]!] }, s };
}
