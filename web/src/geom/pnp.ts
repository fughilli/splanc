/**
 * FUG-112 — client-side PnP against the solved map.
 *
 * The WebXR-free capture path carries no per-frame camera pose (the joint
 * visual-inertial solver estimates poses only at solve time). To draw the
 * resolved LED positions *registered into the live camera viewport* — and to
 * tell the user whether the phone has reacquired absolute pose relative to an
 * existing map — we recover the current camera pose per frame from the
 * correspondences we already have: each decoded track gives a solved 3D LED
 * position (map frame) paired with its current 2D centroid. That's a classic
 * Perspective-n-Point problem (labels.ts / markers.ts call this out as the
 * "phase-4.5 follow-up that brings registered overlays back").
 *
 * Conventions match geom/pinhole.ts: pose `(p, q)` is the camera position in
 * the map frame plus the camera-to-world quaternion `[x,y,z,w]`; camera-local
 * is +X right, +Y up, looking down -Z; `K = [fx, fy, cx, cy]`, pixels
 * origin-top-left.
 *
 * The solve runs in the standard +Z-forward pinhole convention (textbook
 * reprojection Jacobians), then converts the extrinsics back to the pinhole.ts
 * pose. The map is gravity-leveled and the phone is held roughly upright, so a
 * gravity-up look-at makes a strong from-scratch initializer; once locked, the
 * previous frame's pose seeds the next, so steady state is a couple of
 * Gauss-Newton iterations.
 */

import type { Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import { project, quatToRotMat, rotMatToQuat, lookAtQuat, type Mat3 } from "./pinhole";

/** One 3D↔2D correspondence: a solved LED position and its current centroid. */
export interface Correspondence {
  xyz: Vec3;
  u: number;
  v: number;
}

export interface PnpOptions {
  /** Warm-start pose (e.g. last frame's lock); tried before the multi-start. */
  seed?: Pose;
  /** Inlier gate on reprojection error, px (default 6). */
  inlierPx?: number;
  /** Minimum inlier count to call the pose "locked" (default 5). */
  minInliers?: number;
  /** Max reprojection RMS over inliers to accept a lock, px (default 4). */
  maxRmsPx?: number;
}

export interface PnpResult {
  pose: Pose;
  /** RMS reprojection error over the inlier set, px. */
  rmsPx: number;
  /** Correspondences within `inlierPx` of the recovered pose. */
  inliers: number;
  /** Total correspondences supplied. */
  total: number;
  /** True when the pose registered: enough inliers and low RMS. A false `ok`
   * with a returned pose means "converged but not trustworthy". */
  ok: boolean;
}

// -- small 3x3 / SO(3) helpers (row-major, matching pinhole.ts Mat3) --------

function matMul(a: Mat3, b: Mat3): Mat3 {
  const o = new Array(9).fill(0) as unknown as Mat3;
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] =
        a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return o;
}

function matT(a: Mat3): Mat3 {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}

function matVec(a: Mat3, v: Vec3): Vec3 {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}

/** Rodrigues exponential: axis-angle vector -> rotation matrix. */
function expSO3(w: Vec3): Mat3 {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-9) {
    // I + [w]x for tiny angles.
    return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  }
  const k: Vec3 = [w[0] / th, w[1] / th, w[2] / th];
  const s = Math.sin(th);
  const c = Math.cos(th);
  const v = 1 - c;
  const [x, y, z] = k;
  return [
    c + x * x * v, x * y * v - z * s, x * z * v + y * s,
    y * x * v + z * s, c + y * y * v, y * z * v - x * s,
    z * x * v - y * s, z * y * v + x * s, c + z * z * v,
  ];
}

/** M = diag(1,-1,-1): maps pinhole.ts camera coords to +Z-forward pinhole
 * coords (a 180° rotation about X); its own inverse. */
const M_FLIP: Mat3 = [1, 0, 0, 0, -1, 0, 0, 0, -1];

/** pinhole.ts pose -> standard +Z-forward extrinsics (Rc', t'): X' = Rc' Xw + t'. */
function poseToStd(pose: Pose): { R: Mat3; t: Vec3 } {
  const Rc2w = quatToRotMat(pose.q); // camera-to-world
  const Rc = matT(Rc2w); // world-to-camera (our convention)
  const t: Vec3 = [
    -(Rc[0] * pose.p[0] + Rc[1] * pose.p[1] + Rc[2] * pose.p[2]),
    -(Rc[3] * pose.p[0] + Rc[4] * pose.p[1] + Rc[5] * pose.p[2]),
    -(Rc[6] * pose.p[0] + Rc[7] * pose.p[1] + Rc[8] * pose.p[2]),
  ];
  return { R: matMul(M_FLIP, Rc), t: matVec(M_FLIP, t) };
}

/** Standard +Z extrinsics -> pinhole.ts pose. */
function stdToPose(R: Mat3, t: Vec3): Pose {
  const Rc = matMul(M_FLIP, R); // undo the flip: world-to-camera (our convention)
  const tt = matVec(M_FLIP, t);
  const Rc2w = matT(Rc);
  const p: Vec3 = [
    -(Rc2w[0] * tt[0] + Rc2w[1] * tt[1] + Rc2w[2] * tt[2]),
    -(Rc2w[3] * tt[0] + Rc2w[4] * tt[1] + Rc2w[5] * tt[2]),
    -(Rc2w[6] * tt[0] + Rc2w[7] * tt[1] + Rc2w[8] * tt[2]),
  ];
  return { p, q: rotMatToQuat(Rc2w) };
}

/** Solve the 6x6 SPD system H x = -g (Gaussian elimination, partial pivot).
 * Returns null if singular. */
function solve6(H: number[][], g: number[]): number[] | null {
  const n = 6;
  // Augmented [H | -g].
  const a: number[][] = H.map((row, i) => [...row, -g[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (Math.abs(a[piv]![col]!) < 1e-12) return null;
    if (piv !== col) [a[col], a[piv]] = [a[piv]!, a[col]!];
    const pivRow = a[col]!;
    const pv = pivRow[col]!;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const row = a[r]!;
      const f = row[col]! / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c]! -= f * pivRow[c]!;
    }
  }
  const x = new Array(n).fill(0) as number[];
  for (let i = 0; i < n; i++) x[i] = a[i]![n]! / a[i]![i]!;
  return x;
}

/** Refine a standard-convention pose (Rc', t') by damped Gauss-Newton on
 * Huber-robust reprojection error. Mutates nothing; returns the refined pair. */
function refineStd(
  R0: Mat3,
  t0: Vec3,
  corrs: readonly Correspondence[],
  K: Intrinsics,
  iters: number,
): { R: Mat3; t: Vec3 } {
  const [fx, fy, cx, cy] = K;
  const huber = 6; // px
  let R = R0;
  let t = t0;
  let lambda = 1e-3;
  for (let it = 0; it < iters; it++) {
    const H: number[][] = Array.from({ length: 6 }, () => new Array(6).fill(0) as number[]);
    const g = new Array(6).fill(0) as number[];
    let cost = 0;
    let used = 0;
    for (const cr of corrs) {
      // P' = R Xw + t (standard +Z pinhole camera frame).
      const P = matVec(R, cr.xyz);
      const X = P[0] + t[0];
      const Y = P[1] + t[1];
      const Z = P[2] + t[2];
      if (Z < 1e-4) continue; // behind the camera; skip this iteration
      const iZ = 1 / Z;
      const ru = fx * X * iZ + cx - cr.u;
      const rv = fy * Y * iZ + cy - cr.v;
      const e = Math.hypot(ru, rv);
      const w = e <= huber ? 1 : huber / e; // Huber weight
      cost += w * e * e;
      used++;
      // d(pi)/dP' (2x3)
      const dudX = fx * iZ, dudZ = -fx * X * iZ * iZ;
      const dvdY = fy * iZ, dvdZ = -fy * Y * iZ * iZ;
      // dP'/d[dw dt] = [ -[P']x | I ] with P' = (X,Y,Z)
      // -[P']x = [[0,Z,-Y],[-Z,0,X],[Y,-X,0]]
      // Ju row for u: dpi/dP' . dP'/ddelta
      const Ju = [
        dudX * 0 + 0 * -Z + dudZ * Y, // dω x
        dudX * Z + 0 * 0 + dudZ * -X, // dω y
        dudX * -Y + 0 * X + dudZ * 0, // dω z
        dudX, // dt x
        0, // dt y
        dudZ, // dt z
      ];
      const Jv = [
        0 * 0 + dvdY * -Z + dvdZ * Y,
        0 * Z + dvdY * 0 + dvdZ * -X,
        0 * -Y + dvdY * X + dvdZ * 0,
        0,
        dvdY,
        dvdZ,
      ];
      for (let i = 0; i < 6; i++) {
        g[i]! += w * (Ju[i]! * ru + Jv[i]! * rv);
        for (let j = 0; j < 6; j++) H[i]![j]! += w * (Ju[i]! * Ju[j]! + Jv[i]! * Jv[j]!);
      }
    }
    if (used < 3) break;
    // Levenberg damping for conditioning.
    for (let i = 0; i < 6; i++) H[i]![i]! *= 1 + lambda;
    const dx = solve6(H, g);
    if (dx === null) {
      lambda *= 10;
      if (lambda > 1e6) break;
      continue;
    }
    const dω: Vec3 = [dx[0]!, dx[1]!, dx[2]!];
    const dt: Vec3 = [dx[3]!, dx[4]!, dx[5]!];
    const dR = expSO3(dω);
    // Left perturbation in the camera frame: R <- dR R, t <- dR t + dt.
    const Rn = matMul(dR, R);
    const tn: Vec3 = [
      dR[0] * t[0] + dR[1] * t[1] + dR[2] * t[2] + dt[0],
      dR[3] * t[0] + dR[4] * t[1] + dR[5] * t[2] + dt[1],
      dR[6] * t[0] + dR[7] * t[1] + dR[8] * t[2] + dt[2],
    ];
    // Accept if the update reduced cost; else back off damping.
    let newCost = 0;
    for (const cr of corrs) {
      const P = matVec(Rn, cr.xyz);
      const Z = P[2] + tn[2];
      if (Z < 1e-4) {
        newCost = Infinity;
        break;
      }
      const iZ = 1 / Z;
      const ru = fx * (P[0] + tn[0]) * iZ + cx - cr.u;
      const rv = fy * (P[1] + tn[1]) * iZ + cy - cr.v;
      const e = Math.hypot(ru, rv);
      const w = e <= huber ? 1 : huber / e;
      newCost += w * e * e;
    }
    if (newCost <= cost) {
      R = Rn;
      t = tn;
      lambda = Math.max(lambda * 0.5, 1e-6);
    } else {
      lambda *= 4;
      if (lambda > 1e6) break;
    }
  }
  return { R, t };
}

/** Reprojection stats for a candidate pose over the correspondences. */
function score(pose: Pose, corrs: readonly Correspondence[], K: Intrinsics, inlierPx: number) {
  let inl = 0;
  let sse = 0;
  for (const cr of corrs) {
    const pr = project(pose, K, cr.xyz);
    if (pr.depth <= 0) continue;
    const e2 = (pr.u - cr.u) ** 2 + (pr.v - cr.v) ** 2;
    if (e2 <= inlierPx * inlierPx) {
      inl++;
      sse += e2;
    }
  }
  return { inliers: inl, rmsPx: inl > 0 ? Math.sqrt(sse / inl) : Infinity };
}

/** Multi-start look-at seeds for a gravity-leveled map + upright phone. */
function seedPoses(corrs: readonly Correspondence[]): Pose[] {
  let cx = 0, cy = 0, cz = 0;
  for (const c of corrs) {
    cx += c.xyz[0];
    cy += c.xyz[1];
    cz += c.xyz[2];
  }
  const n = corrs.length;
  const C: Vec3 = [cx / n, cy / n, cz / n];
  let radius = 1e-6;
  for (const c of corrs) {
    radius = Math.max(radius, Math.hypot(c.xyz[0] - C[0], c.xyz[1] - C[1], c.xyz[2] - C[2]));
  }
  const seeds: Pose[] = [];
  const dists = [radius, 2 * radius];
  const elevs = [(25 * Math.PI) / 180, (55 * Math.PI) / 180];
  for (let a = 0; a < 6; a++) {
    const az = (a * Math.PI) / 3;
    for (const el of elevs) {
      for (const d of dists) {
        const eye: Vec3 = [
          C[0] + d * Math.cos(el) * Math.cos(az),
          C[1] + d * Math.sin(el),
          C[2] + d * Math.cos(el) * Math.sin(az),
        ];
        try {
          seeds.push({ p: eye, q: lookAtQuat(eye, C) });
        } catch {
          /* eye == C — skip */
        }
      }
    }
  }
  return seeds;
}

/**
 * Recover the camera pose from solved-LED ↔ centroid correspondences.
 *
 * Warm-starts from `opts.seed` (last frame's lock) when given, falling back to
 * a gravity-up multi-start. Returns the best converged pose with an `ok` flag
 * that gates on inlier count and RMS — callers use `ok` as the "reacquired
 * absolute pose" signal. Returns null only when there is nothing to solve
 * (fewer than 4 correspondences).
 */
export function estimatePose(
  corrs: readonly Correspondence[],
  K: Intrinsics,
  opts: PnpOptions = {},
): PnpResult | null {
  if (corrs.length < 4) return null;
  const inlierPx = opts.inlierPx ?? 6;
  const minInliers = opts.minInliers ?? 5;
  const maxRmsPx = opts.maxRmsPx ?? 4;

  let best: { pose: Pose; inliers: number; rmsPx: number } | null = null;
  const consider = (pose: Pose): void => {
    const s = score(pose, corrs, K, inlierPx);
    if (
      best === null ||
      s.inliers > best.inliers ||
      (s.inliers === best.inliers && s.rmsPx < best.rmsPx)
    ) {
      best = { pose, inliers: s.inliers, rmsPx: s.rmsPx };
    }
  };

  // Warm start: a few iterations from the caller's seed. If it already locks
  // well, skip the (much costlier) multi-start entirely.
  if (opts.seed) {
    const std = poseToStd(opts.seed);
    const r = refineStd(std.R, std.t, corrs, K, 8);
    const pose = stdToPose(r.R, r.t);
    consider(pose);
    if (best !== null && (best as { inliers: number }).inliers >= minInliers &&
        (best as { rmsPx: number }).rmsPx <= maxRmsPx) {
      const b = best as { pose: Pose; inliers: number; rmsPx: number };
      return { pose: b.pose, rmsPx: b.rmsPx, inliers: b.inliers, total: corrs.length, ok: true };
    }
  }

  for (const seed of seedPoses(corrs)) {
    const std = poseToStd(seed);
    const r = refineStd(std.R, std.t, corrs, K, 12);
    consider(stdToPose(r.R, r.t));
  }

  if (best === null) return null;
  const b = best as { pose: Pose; inliers: number; rmsPx: number };
  const ok = b.inliers >= minInliers && b.rmsPx <= maxRmsPx;
  return { pose: b.pose, rmsPx: b.rmsPx, inliers: b.inliers, total: corrs.length, ok };
}
