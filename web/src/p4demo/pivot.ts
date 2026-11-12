/**
 * Stylus pivot calibration (a port of the desktop demo's probe.pivot / pivot_robust /
 * pivot_ok): the tip rests in a small dimple while the stylus rocks round it, so every
 * pose k satisfies R_k c + t_k = q, with c the tip in the stylus frame and q the pivot
 * point in the world. That is linear least squares in (c, q):
 *     [R_k  -I] [c; q] = -t_k
 * The rocking makes c observable; the more the stylus tilts, the better.
 */

import type { Vec3 } from "./lh/types";
import { mulMV, normalize, dot, type Pose } from "./frames";

export const PIVOT_MIN_SAMPLES = 60;
export const PIVOT_MIN_SPREAD_DEG = 15; // the stylus must rock at least this much round the tip
export const PIVOT_MAX_RMS = 0.008; // m (of the inliers); lhd's station disagreement alone gives ~5 mm
export const PIVOT_INLIER_FLOOR = 0.003; // m: a robust pivot keeps every sample this close
export const PIVOT_MIN_INLIER_FRAC = 0.5;

export interface PivotResult {
  /** Tip in the stylus frame (m). */
  c: Vec3;
  /** The pivot point in the world (m). */
  q: Vec3;
  /** RMS residual of the samples used (m). */
  rms: number;
  /** Max angle (deg) between a sample's stylus axis and their mean. */
  spreadDeg: number;
  /** Which samples were kept (all true for the plain fit). */
  inliers: boolean[];
  /** Robust sigma (m); the plain fit reports its RMS. */
  sigma: number;
}

/** Solve the 6x6 system M x = v (Gaussian elimination, partial pivoting). Null if singular. */
function solve6(M: number[][], v: number[]): number[] | null {
  const n = 6;
  const A = M.map((row, i) => [...row, v[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r]![col]!) > Math.abs(A[piv]![col]!)) piv = r;
    if (Math.abs(A[piv]![col]!) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r]![col]! / A[col]![col]!;
      if (f === 0) continue;
      for (let k = col; k <= n; k++) A[r]![k]! -= f * A[col]![k]!;
    }
  }
  return A.map((row, i) => row[n]! / row[i]!);
}

/** Weighted least squares of [R_k -I][c; q] = -t_k. */
function solveWeighted(poses: Pose[], w: number[]): { c: Vec3; q: Vec3 } | null {
  const M = Array.from({ length: 6 }, () => new Array<number>(6).fill(0));
  const v = new Array<number>(6).fill(0);
  for (let k = 0; k < poses.length; k++) {
    const wk = w[k]!;
    if (wk <= 0) continue;
    const { R, t } = poses[k]!;
    // Rows of A for this pose: row i = [R[i,0..2], -e_i]; b_i = -t_i.
    for (let i = 0; i < 3; i++) {
      const row = [R[i * 3]!, R[i * 3 + 1]!, R[i * 3 + 2]!, i === 0 ? -1 : 0, i === 1 ? -1 : 0, i === 2 ? -1 : 0];
      const b = -t[i]!;
      for (let a = 0; a < 6; a++) {
        if (row[a] === 0) continue;
        v[a]! += wk * row[a]! * b;
        for (let c = 0; c < 6; c++) M[a]![c]! += wk * row[a]! * row[c]!;
      }
    }
  }
  const x = solve6(M, v);
  if (!x) return null;
  return { c: [x[0]!, x[1]!, x[2]!], q: [x[3]!, x[4]!, x[5]!] };
}

function residual(P: Pose, c: Vec3, q: Vec3): number {
  const p = mulMV(P.R, c);
  return Math.hypot(p[0] + P.t[0] - q[0], p[1] + P.t[1] - q[1], p[2] + P.t[2] - q[2]);
}

function spread(poses: Pose[], c: Vec3, keep: boolean[]): number {
  const axis = normalize(c);
  const axes = poses.filter((_, k) => keep[k]).map((P) => mulMV(P.R, axis));
  if (axes.length === 0) return 0;
  const mean = normalize(axes.reduce<Vec3>((s, a) => [s[0] + a[0], s[1] + a[1], s[2] + a[2]], [0, 0, 0]));
  let max = 0;
  for (const a of axes) max = Math.max(max, Math.acos(Math.min(1, Math.max(-1, dot(a, mean)))));
  return (max * 180) / Math.PI;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Plain least-squares pivot (probe.pivot). Null with fewer than 3 poses or a
 * degenerate set (no rotation). */
export function pivot(poses: Pose[]): PivotResult | null {
  if (poses.length < 3) return null;
  const all = poses.map(() => true);
  const sol = solveWeighted(poses, poses.map(() => 1));
  if (!sol) return null;
  const r = poses.map((P) => residual(P, sol.c, sol.q));
  const rms = Math.sqrt(r.reduce((s, x) => s + x * x, 0) / r.length);
  return { ...sol, rms, spreadDeg: spread(poses, sol.c, all), inliers: all, sigma: rms };
}

/**
 * pivot() that shrugs off jiggle (probe.pivot_robust): the approach and lift-off, the
 * tip slipping, pose jumps. Three Huber-reweighted rounds, then only the samples within
 * 3 robust sigmas (at least PIVOT_INLIER_FLOOR) of the pivot, refitted until the set
 * settles.
 */
export function pivotRobust(poses: Pose[], iters = 12): PivotResult | null {
  const n = poses.length;
  if (n < 3) return null;
  let w = new Array<number>(n).fill(1);
  let inl = new Array<boolean>(n).fill(true);
  let sig = PIVOT_INLIER_FLOOR;
  let sol: { c: Vec3; q: Vec3 } | null = null;
  let r: number[] = [];
  for (let it = 0; it < iters; it++) {
    const next = solveWeighted(poses, w);
    if (!next) break;
    sol = next;
    r = poses.map((P) => residual(P, sol!.c, sol!.q));
    sig = Math.max(1.4826 * median(it >= 3 ? r.filter((_, k) => inl[k]) : r), PIVOT_INLIER_FLOOR / 3);
    if (it < 3) {
      w = r.map((x) => Math.min(1, (1.5 * sig) / Math.max(x, 1e-12))); // Huber
      continue;
    }
    const thr = Math.max(3 * sig, PIVOT_INLIER_FLOOR);
    const nw = r.map((x) => x < thr);
    if (nw.filter(Boolean).length < 6) break;
    if (nw.every((b, k) => b === inl[k]) && it > 3) break;
    inl = nw;
    w = nw.map((b) => (b ? 1 : 0));
  }
  if (!sol) return null;
  const ri = r.filter((_, k) => inl[k]);
  const rms = ri.length ? Math.sqrt(ri.reduce((s, x) => s + x * x, 0) / ri.length) : Infinity;
  return { c: sol.c, q: sol.q, rms, spreadDeg: spread(poses, sol.c, inl), inliers: inl, sigma: sig };
}

/** Null if the pivot is usable, else why not (probe.pivot_ok). */
export function pivotProblem(res: PivotResult, total: number): string | null {
  const kept = res.inliers.filter(Boolean).length;
  if (kept < PIVOT_MIN_INLIER_FRAC * total)
    return `only ${kept} of ${total} samples on one point (need ${PIVOT_MIN_INLIER_FRAC * 100}%): keep the tip in the dimple`;
  if (kept < PIVOT_MIN_SAMPLES) return `only ${kept} samples (need ${PIVOT_MIN_SAMPLES})`;
  if (res.spreadDeg < PIVOT_MIN_SPREAD_DEG)
    return `rocked only ${res.spreadDeg.toFixed(0)}° (need ${PIVOT_MIN_SPREAD_DEG}°)`;
  if (res.rms > PIVOT_MAX_RMS)
    return `tip moved: RMS ${(res.rms * 1e3).toFixed(1)} mm (max ${(PIVOT_MAX_RMS * 1e3).toFixed(1)})`;
  return null;
}
