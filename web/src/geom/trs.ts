/**
 * Translate / rotate / scale <-> matrix for the mat3 / mat4 uniform gizmo
 * (D-541 PR 10). All matrices are column-major (GLSL), as the uniforms are.
 *
 * Three kinds of matrix uniform (D-556):
 * - `mat4`: a full 3D transform (translation in column 3).
 * - `mat3`: a 3D rotation / linear transform (no translation).
 * - `affine2d`: a mat3 annotated `: transform2d`, a 2D homogeneous affine
 *   (translation in column 2, rotation about z).
 *
 * The gizmo edits a matrix by LEFT-multiplying a delta (`applyDelta`) built
 * from the gesture so far, starting from the matrix at gesture start. So a
 * matrix the TRS form cannot express (shear, non-uniform scale, a projective
 * row) keeps that part while it is moved, turned or scaled. `compose` /
 * `decompose` are for the numeric TRS fields and the readouts.
 */

import { mul4 } from "./mat4";

export type MatKind = "mat4" | "mat3" | "affine2d";
export type V3 = [number, number, number];

export interface TRS {
  /** Translation (always 0 for a mat3). */
  t: V3;
  /** Rotation as XYZ Euler degrees: R = Rz · Ry · Rx (x applied first). */
  r: V3;
  /** Per-axis scale (the gizmo's scale handle is uniform). */
  s: V3;
}

const DEG = Math.PI / 180;

/** The matrix kind of a uniform from its width and UI kind. */
export function matKindOf(width: number, uiKind: string): MatKind {
  if (width === 16) return "mat4";
  return uiKind === "transform2d" ? "affine2d" : "mat3";
}

export function identity(kind: MatKind): number[] {
  const n = kind === "mat4" ? 4 : 3;
  return Array.from({ length: n * n }, (_, k) => (k % (n + 1) === 0 ? 1 : 0));
}

/** A uniform's matrix as a mat4 (the gizmo's working space). */
export function toMat4(kind: MatKind, m: readonly number[]): number[] {
  const g = (k: number, d = 0): number => (Number.isFinite(m[k]) ? m[k]! : d);
  if (kind === "mat4") return Array.from({ length: 16 }, (_, k) => g(k, k % 5 === 0 ? 1 : 0));
  const o = identity("mat4");
  if (kind === "mat3") {
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 4 + r] = g(c * 3 + r, c === r ? 1 : 0);
    return o;
  }
  // affine2d: [a b tx; c d ty; . . 1] -> the xy block, translation in column 3.
  o[0] = g(0, 1);
  o[1] = g(1);
  o[4] = g(3);
  o[5] = g(4, 1);
  o[12] = g(6);
  o[13] = g(7);
  return o;
}

/** Back from a mat4 to the uniform's own layout. Entries the mat4 cannot
 * carry (an affine2d's bottom row) come from `orig`. */
export function fromMat4(kind: MatKind, m4: readonly number[], orig?: readonly number[]): number[] {
  if (kind === "mat4") return m4.slice(0, 16);
  const o = new Array<number>(9).fill(0);
  if (kind === "mat3") {
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) o[c * 3 + r] = m4[c * 4 + r]!;
    return o;
  }
  o[0] = m4[0]!;
  o[1] = m4[1]!;
  o[3] = m4[4]!;
  o[4] = m4[5]!;
  o[6] = m4[12]!;
  o[7] = m4[13]!;
  o[2] = orig?.[2] ?? 0;
  o[5] = orig?.[5] ?? 0;
  o[8] = orig?.[8] ?? 1;
  return o;
}

function mul3(a: readonly number[], b: readonly number[]): number[] {
  const o = new Array<number>(9).fill(0);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[k * 3 + r]! * b[c * 3 + k]!;
      o[c * 3 + r] = s;
    }
  return o;
}

/** `D · m` in the uniform's own layout, with `D` a mat4 delta (for a mat3 its
 * linear block; for an affine2d its xy block and xy translation). */
export function applyDelta(kind: MatKind, m: readonly number[], d4: readonly number[]): number[] {
  if (kind === "mat4") return Array.from(mul4(d4 as number[], m as number[]));
  if (kind === "mat3") return mul3(fromMat4("mat3", d4), m);
  const d = [d4[0]!, d4[1]!, 0, d4[4]!, d4[5]!, 0, d4[12]!, d4[13]!, 1];
  return mul3(d, m);
}

// -- delta builders (mat4, column-major) -------------------------------------

export function translation(t: readonly number[]): number[] {
  const o = identity("mat4");
  o[12] = t[0] ?? 0;
  o[13] = t[1] ?? 0;
  o[14] = t[2] ?? 0;
  return o;
}

/** Rotation by `angle` radians about the unit `axis` (right-hand rule). */
export function axisAngle(axis: readonly number[], angle: number): number[] {
  const [x, y, z] = [axis[0] ?? 0, axis[1] ?? 0, axis[2] ?? 0];
  const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
  // Column-major: o[col*4 + row].
  return [
    c + x * x * k, y * x * k + z * s, z * x * k - y * s, 0,
    x * y * k - z * s, c + y * y * k, z * y * k + x * s, 0,
    x * z * k + y * s, y * z * k - x * s, c + z * z * k, 0,
    0, 0, 0, 1,
  ];
}

export function uniformScale(s: number): number[] {
  const o = identity("mat4");
  o[0] = o[5] = o[10] = s;
  return o;
}

/** `T(p) · d · T(-p)`: the delta `d` about the pivot `p` instead of the origin. */
export function aboutPivot(d: readonly number[], p: readonly number[]): number[] {
  return Array.from(mul4(mul4(translation(p), d as number[]), translation(p.map((x) => -x))));
}

/** Where the matrix puts the local origin: the gizmo's pivot. A mat3 is
 * linear, so its pivot is the origin. */
export function pivotOf(kind: MatKind, m: readonly number[]): V3 {
  if (kind === "mat3") return [0, 0, 0];
  if (kind === "affine2d") {
    const w = Math.abs(m[8] ?? 1) > 1e-9 ? m[8]! : 1;
    return [(m[6] ?? 0) / w, (m[7] ?? 0) / w, 0];
  }
  const w = Math.abs(m[15] ?? 1) > 1e-9 ? m[15]! : 1;
  return [(m[12] ?? 0) / w, (m[13] ?? 0) / w, (m[14] ?? 0) / w];
}

// -- TRS <-> matrix -----------------------------------------------------------

/** Rz(c) · Ry(b) · Rx(a) as a row-major 3×3 (Euler degrees [a, b, c]). */
export function eulerToRot(r: readonly number[]): number[] {
  const [a, b, c] = [(r[0] ?? 0) * DEG, (r[1] ?? 0) * DEG, (r[2] ?? 0) * DEG];
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
  return [
    cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa,
    sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa,
    -sb, cb * sa, cb * ca,
  ];
}

/** XYZ Euler degrees of a row-major rotation (inverse of {@link eulerToRot}). */
export function rotToEuler(R: readonly number[]): V3 {
  const r20 = Math.max(-1, Math.min(1, R[6]!));
  const b = Math.asin(-r20);
  let a: number, c: number;
  if (Math.abs(r20) < 1 - 1e-9) {
    a = Math.atan2(R[7]!, R[8]!);
    c = Math.atan2(R[3]!, R[0]!);
  } else {
    // Gimbal lock (b = ±90°): fold the rotation into x.
    c = 0;
    a = Math.atan2(-R[5]!, R[4]!);
  }
  return [a / DEG, b / DEG, c / DEG].map((x) => (Object.is(x, -0) ? 0 : x)) as V3;
}

/** The uniform's matrix for a TRS (kind-appropriate: a mat3 drops t, an
 * affine2d keeps only z rotation, xy translation and xy scale). `orig`
 * supplies an affine2d's bottom row. */
export function compose(kind: MatKind, trs: TRS, orig?: readonly number[]): number[] {
  const flat = kind === "affine2d";
  const r = flat ? [0, 0, trs.r[2]] : trs.r;
  const R = eulerToRot(r);
  const s = flat ? [trs.s[0], trs.s[1], 1] : trs.s;
  const t = kind === "mat3" ? [0, 0, 0] : flat ? [trs.t[0], trs.t[1], 0] : trs.t;
  const m4 = identity("mat4");
  for (let c = 0; c < 3; c++) for (let row = 0; row < 3; row++) m4[c * 4 + row] = R[row * 3 + c]! * s[c]!;
  m4[12] = t[0]!;
  m4[13] = t[1]!;
  m4[14] = t[2]!;
  return fromMat4(kind, m4, orig);
}

export interface Decomposed extends TRS {
  /** False when the matrix holds something TRS cannot express (shear,
   * a projective row): the fields then show the nearest TRS. */
  exact: boolean;
}

/** TRS of a uniform's matrix: scale = column lengths (one negated for a
 * mirror), rotation from the normalised columns. */
export function decompose(kind: MatKind, m: readonly number[]): Decomposed {
  const m4 = toMat4(kind, m);
  const col = (c: number): V3 => [m4[c * 4]!, m4[c * 4 + 1]!, m4[c * 4 + 2]!];
  const cols = [col(0), col(1), col(2)];
  const s = cols.map((v) => Math.hypot(...v)) as V3;
  const det =
    cols[0]![0] * (cols[1]![1] * cols[2]![2] - cols[2]![1] * cols[1]![2]) -
    cols[1]![0] * (cols[0]![1] * cols[2]![2] - cols[2]![1] * cols[0]![2]) +
    cols[2]![0] * (cols[0]![1] * cols[1]![2] - cols[1]![1] * cols[0]![2]);
  if (det < 0) s[0] = -s[0];
  const R = new Array<number>(9).fill(0); // row-major
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) R[r * 3 + c] = Math.abs(s[c]!) > 1e-12 ? cols[c]![r]! / s[c]! : r === c ? 1 : 0;
  let exact = true;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      let d = 0;
      for (let k = 0; k < 3; k++) d += R[k * 3 + i]! * R[k * 3 + j]!;
      if (Math.abs(d - (i === j ? 1 : 0)) > 1e-4) exact = false;
    }
  if (kind === "mat4" && (Math.abs(m4[3]!) + Math.abs(m4[7]!) + Math.abs(m4[11]!) > 1e-9 || Math.abs(m4[15]! - 1) > 1e-9)) exact = false;
  if (kind === "affine2d" && (Math.abs(m[2] ?? 0) + Math.abs(m[5] ?? 0) > 1e-9 || Math.abs((m[8] ?? 1) - 1) > 1e-9)) exact = false;
  const t: V3 = kind === "mat3" ? [0, 0, 0] : [m4[12]!, m4[13]!, m4[14]!];
  return { t, r: rotToEuler(R), s, exact };
}

/** The rotation angle (degrees, 0..180) of a matrix's rotation part. */
export function rotationAngle(kind: MatKind, m: readonly number[]): number {
  const { r } = decompose(kind, m);
  const R = eulerToRot(r);
  const tr = R[0]! + R[4]! + R[8]!;
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / DEG;
}

/** A short label for a matrix uniform's value column / swatch. */
export function trsSummary(kind: MatKind, m: readonly number[]): string {
  const d = decompose(kind, m);
  const f = (x: number, dp = 2): string => {
    const v = Math.round(x * 10 ** dp) / 10 ** dp;
    return String(Object.is(v, -0) ? 0 : v);
  };
  const sc = Math.abs(d.s[0] - d.s[1]) < 1e-4 && (kind === "affine2d" || Math.abs(d.s[0] - d.s[2]) < 1e-4) ? `×${f(d.s[0])}` : "×…";
  const rot = kind === "affine2d" ? `${f(d.r[2], 1)}°` : `${f(rotationAngle(kind, m), 1)}°`;
  if (kind === "mat3") return `${rot} ${sc}`;
  const t = kind === "affine2d" ? `${f(d.t[0])},${f(d.t[1])}` : `${f(d.t[0])},${f(d.t[1])},${f(d.t[2])}`;
  return `${t} · ${rot} ${sc}`;
}
