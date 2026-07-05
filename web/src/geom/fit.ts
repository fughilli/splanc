/**
 * Similarity (Procrustes/Umeyama) alignment: the rigid transform + uniform
 * scale mapping one point set onto another, minimizing squared error.
 *
 * Used to overlay GROUND TRUTH on a reconstruction: the wall's truth layout is
 * pitch-normalized planar coordinates, comparable to a solve only up to a
 * similarity transform — this finds that transform so per-point deltas are
 * measured in the solve's meters.
 *
 * Rotation via Horn's quaternion method (closed-form N matrix, dominant
 * eigenvector by shifted power iteration) — dependency-free, robust for the
 * ≥3 non-collinear points we need.
 */

import type { Vec3 } from "@ledmapper/protocol";

export interface Similarity {
  /** Uniform scale. */
  c: number;
  /** Rotation, row-major 3×3. */
  R: number[];
  /** Translation. */
  d: Vec3;
}

export function applySimilarity(t: Similarity, p: Vec3): Vec3 {
  const { c, R, d } = t;
  return [
    c * (R[0]! * p[0] + R[1]! * p[1] + R[2]! * p[2]) + d[0],
    c * (R[3]! * p[0] + R[4]! * p[1] + R[5]! * p[2]) + d[1],
    c * (R[6]! * p[0] + R[7]! * p[1] + R[8]! * p[2]) + d[2],
  ];
}

/**
 * Fit `dst_i ≈ c·R·src_i + d` over paired points. Returns null when the fit
 * is underdetermined (< 3 points, or degenerate/collinear geometry).
 */
export function fitSimilarity(src: readonly Vec3[], dst: readonly Vec3[]): Similarity | null {
  const n = src.length;
  if (n < 3 || dst.length !== n) return null;

  const muS: Vec3 = [0, 0, 0];
  const muD: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    muS[0] += src[i]![0] / n;
    muS[1] += src[i]![1] / n;
    muS[2] += src[i]![2] / n;
    muD[0] += dst[i]![0] / n;
    muD[1] += dst[i]![1] / n;
    muD[2] += dst[i]![2] / n;
  }

  // Correlation M = Σ a bᵀ with a = src centered, b = dst centered.
  const M = new Array<number>(9).fill(0);
  let varS = 0;
  for (let i = 0; i < n; i++) {
    const a = [src[i]![0] - muS[0], src[i]![1] - muS[1], src[i]![2] - muS[2]];
    const b = [dst[i]![0] - muD[0], dst[i]![1] - muD[1], dst[i]![2] - muD[2]];
    varS += a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]!;
    for (let r = 0; r < 3; r++) {
      for (let cc = 0; cc < 3; cc++) M[r * 3 + cc] = M[r * 3 + cc]! + a[r]! * b[cc]!;
    }
  }
  if (varS < 1e-12) return null;

  // Horn's N matrix (symmetric 4×4); its dominant eigenvector is the
  // quaternion (w, x, y, z) of the best rotation src→dst.
  const [Sxx, Sxy, Sxz, Syx, Syy, Syz, Szx, Szy, Szz] = M as [
    number, number, number, number, number, number, number, number, number,
  ];
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  // Shift so the dominant eigenvalue is the largest in magnitude.
  let norm = 0;
  for (const v of M) norm += v * v;
  const shift = 2 * Math.sqrt(norm) + 1e-9;
  for (let k = 0; k < 4; k++) N[k]![k]! += shift;

  let q = [1, 0.31, -0.24, 0.17]; // arbitrary non-symmetric start
  for (let it = 0; it < 100; it++) {
    const next = [0, 0, 0, 0];
    for (let r = 0; r < 4; r++) {
      for (let cc = 0; cc < 4; cc++) next[r]! += N[r]![cc]! * q[cc]!;
    }
    const len = Math.hypot(...next);
    if (len < 1e-12) return null;
    q = next.map((v) => v / len);
  }
  const [w, x, y, z] = q as [number, number, number, number];

  // Quaternion → row-major rotation (src→dst).
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];

  // Scale: projection of rotated src onto dst over src variance.
  let dot = 0;
  for (let i = 0; i < n; i++) {
    const a: Vec3 = [src[i]![0] - muS[0], src[i]![1] - muS[1], src[i]![2] - muS[2]];
    const ra = [
      R[0]! * a[0] + R[1]! * a[1] + R[2]! * a[2],
      R[3]! * a[0] + R[4]! * a[1] + R[5]! * a[2],
      R[6]! * a[0] + R[7]! * a[1] + R[8]! * a[2],
    ];
    const b = [dst[i]![0] - muD[0], dst[i]![1] - muD[1], dst[i]![2] - muD[2]];
    dot += ra[0]! * b[0]! + ra[1]! * b[1]! + ra[2]! * b[2]!;
  }
  const c = dot / varS;
  if (!(c > 0) || !Number.isFinite(c)) return null;

  const rm: Vec3 = [
    R[0]! * muS[0] + R[1]! * muS[1] + R[2]! * muS[2],
    R[3]! * muS[0] + R[4]! * muS[1] + R[5]! * muS[2],
    R[6]! * muS[0] + R[7]! * muS[1] + R[8]! * muS[2],
  ];
  const d: Vec3 = [muD[0] - c * rm[0], muD[1] - c * rm[1], muD[2] - c * rm[2]];
  return { c, R, d };
}
