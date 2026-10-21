/**
 * IMU-to-fixture extrinsic calibration (docs/design/sensor-core.md §7): solve
 * R_fi, the rotation taking the IMU body frame into the fixture/map frame (the
 * frame of led.pos, +Y up), from still poses that each pair the IMU's settled
 * "up" (g_i, body frame) with "up" in the fixture frame (g_f). Pose 1 is the
 * mapping itself (the map is gravity-leveled, so g_f = +Y); later poses come
 * from a PnP re-localisation of the known map plus the phone's gravity.
 *
 * One pair pins R_fi only up to a rotation about gravity (the "360° rotation
 * group"); two or more non-parallel pairs resolve it. ≥2 pairs: Wahba's problem
 * via the Davenport q-method (largest eigenvector of the 4×4 K matrix, by
 * Jacobi), weighted by each pose's direction noise. 1 pair: the minimal
 * rotation, with the yaw taken from a prior (or 0) and flagged unresolved.
 *
 * Quaternions here are scalar-first [w, x, y, z] — the device protocol's
 * convention (SetSensorMount / SensorState).
 */

export type V3 = [number, number, number];
export type QuatWxyz = [number, number, number, number];

export interface GravityPose {
  /** IMU-measured up (specific-force direction), IMU body frame; any length. */
  imuUp: V3;
  /** Up in the fixture/map frame; any length. Pose 1 (mapping) = [0, 1, 0]. */
  fixtureUp: V3;
  /** 1-sigma direction noise of this pose, degrees (IMU and camera combined).
   * Default 1°. */
  sigmaDeg?: number;
}

export type SolveQuality = "good" | "marginal" | "degenerate";

export interface ExtrinsicSolve {
  /** R_fi as a quaternion [w, x, y, z]: v_fixture = q · v_imu · q⁻¹. */
  q: QuatWxyz;
  /** False with one pose, or when every pose's g_f is (nearly) parallel. */
  yawResolved: boolean;
  /** Largest angle between any two poses' fixture-up directions, degrees. */
  separationDeg: number;
  /** RMS angle between g_f and R·g_i over the poses, degrees. */
  residualDeg: number;
  /** Predicted 1-sigma yaw error, degrees (σ_dir / sin(separation)); Infinity
   * when unresolved. */
  predictedYawErrDeg: number;
  quality: SolveQuality;
  /** Index of the most suspect pose (to offer "drop it"): with ≥3 poses the
   * one whose leave-one-out prediction error is largest (a least-squares fit
   * spreads a single bad pose over all residuals), else the largest residual. */
  worstPose: number;
  /** Per-pose residual angles, degrees. */
  poseResidualsDeg: number[];
}

/** Separation (deg) below which a second pose can't resolve yaw. */
export const DEGENERATE_SEPARATION_DEG = 20;
/** Separation (deg) the guided flow asks for before accepting a pose. */
export const MIN_SEPARATION_DEG = 45;
/** Residual (deg) above which some pose is suspect (with ≥3 poses). */
export const SUSPECT_RESIDUAL_DEG = 3;

const DEG = Math.PI / 180;

function norm(v: V3): V3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  if (!(n > 0)) throw new Error("zero-length gravity vector");
  return [v[0] / n, v[1] / n, v[2] / n];
}
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Angle between two directions, degrees. */
export function angleDeg(a: V3, b: V3): number {
  const an = norm(a);
  const bn = norm(b);
  return Math.atan2(Math.hypot(...cross(an, bn)), dot(an, bn)) / DEG;
}

export function quatMul(a: QuatWxyz, b: QuatWxyz): QuatWxyz {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

function quatNorm(q: QuatWxyz): QuatWxyz {
  const n = Math.hypot(...q);
  const s = q[0] < 0 ? -1 / n : 1 / n; // canonical: w >= 0
  return [q[0] * s, q[1] * s, q[2] * s, q[3] * s];
}

export function rotate(q: QuatWxyz, v: V3): V3 {
  const u: V3 = [q[1], q[2], q[3]];
  const t = cross(u, v).map((c) => 2 * c) as V3;
  const ut = cross(u, t);
  return [v[0] + q[0] * t[0] + ut[0], v[1] + q[0] * t[1] + ut[1], v[2] + q[0] * t[2] + ut[2]];
}

export function axisAngle(axis: V3, rad: number): QuatWxyz {
  const a = norm(axis);
  const s = Math.sin(rad / 2);
  return [Math.cos(rad / 2), a[0] * s, a[1] * s, a[2] * s];
}

/** Shortest-arc rotation taking unit `from` onto unit `to`. */
function shortestArc(from: V3, to: V3): QuatWxyz {
  const d = dot(from, to);
  if (d < -0.999999) {
    const ax = Math.abs(from[0]) < 0.9 ? cross(from, [1, 0, 0]) : cross(from, [0, 1, 0]);
    return quatNorm([0, ...norm(ax)]);
  }
  const c = cross(from, to);
  return quatNorm([1 + d, c[0], c[1], c[2]]);
}

/** Eigen-decomposition of a symmetric 4×4 by cyclic Jacobi; returns the
 * eigenvector of the largest eigenvalue. */
function largestEigenvector(m: number[][]): number[] {
  const a = m.map((r) => r.slice());
  const v: number[][] = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p]![q]! ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i]![i]! > a[best]![best]!) best = i;
  return [v[0]![best]!, v[1]![best]!, v[2]![best]!, v[3]![best]!];
}

/** Davenport q-method for Σ w‖b − R r‖² (b = fixture, r = IMU). */
function qMethod(pairs: { b: V3; r: V3; w: number }[]): QuatWxyz {
  const B = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const { b, r, w } of pairs) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) B[i]![j]! += w * b[i]! * r[j]!;
  const sigma = B[0]![0]! + B[1]![1]! + B[2]![2]!;
  const z = [B[1]![2]! - B[2]![1]!, B[2]![0]! - B[0]![2]!, B[0]![1]! - B[1]![0]!];
  const K = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) K[i]![j] = B[i]![j]! + B[j]![i]! - (i === j ? sigma : 0);
    K[i]![3] = z[i]!;
    K[3]![i] = z[i]!;
  }
  K[3]![3] = sigma;
  const e = largestEigenvector(K); // [x, y, z, w] in Markley's (passive) convention
  // Markley's q is the transpose of our active rotation in some conventions:
  // take whichever of q / q⁻¹ actually fits the data (they differ unless the
  // fit is trivial).
  const cand: QuatWxyz[] = [quatNorm([e[3]!, e[0]!, e[1]!, e[2]!]), quatNorm([e[3]!, -e[0]!, -e[1]!, -e[2]!])];
  const cost = (q: QuatWxyz) => pairs.reduce((s, { b, r, w }) => s + w * (1 - dot(b, rotate(q, r))), 0);
  return cost(cand[0]!) <= cost(cand[1]!) ? cand[0]! : cand[1]!;
}

/**
 * Solve R_fi from still poses. `prior` (a previous R_fi) only matters with one
 * pose / degenerate geometry: its yaw about gravity is kept.
 */
export function solveImuExtrinsic(poses: GravityPose[], prior?: QuatWxyz): ExtrinsicSolve {
  if (poses.length === 0) throw new Error("need at least one pose");
  const pairs = poses.map((p) => {
    // Floor the noise so a "perfect" pose (sigma 0) can't make an infinite weight.
    const sd = Math.max(p.sigmaDeg ?? 1, 0.01) * DEG;
    return { b: norm(p.fixtureUp), r: norm(p.imuUp), w: 1 / (sd * sd), sd };
  });
  let sep = 0;
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) sep = Math.max(sep, angleDeg(pairs[i]!.b, pairs[j]!.b));
  }
  const resolved = pairs.length >= 2 && sep >= DEGENERATE_SEPARATION_DEG;
  let q: QuatWxyz;
  if (resolved) {
    q = qMethod(pairs);
  } else {
    // Gravity-only: minimal rotation of the (weighted mean) IMU up onto the
    // fixture up, then the prior's yaw about that up (else 0).
    const r = pairs[0]!.r;
    const b = pairs[0]!.b;
    q = shortestArc(r, b);
    if (prior) {
      const h: V3 = norm(Math.abs(r[0]) < 0.9 ? cross(r, [1, 0, 0]) : cross(r, [0, 1, 0]));
      const cur = rotate(q, h);
      const want0 = rotate(prior, h);
      const want = norm([
        want0[0] - dot(want0, b) * b[0],
        want0[1] - dot(want0, b) * b[1],
        want0[2] - dot(want0, b) * b[2],
      ]);
      const theta = Math.atan2(dot(cross(cur, want), b), dot(cur, want));
      q = quatNorm(quatMul(axisAngle(b, theta), q));
    }
  }
  const res = pairs.map(({ b, r }) => angleDeg(b, rotate(q, r)));
  const rms = Math.sqrt(res.reduce((s, x) => s + x * x, 0) / res.length);
  let worst = 0;
  if (resolved && pairs.length >= 3) {
    let worstErr = -1;
    pairs.forEach((p, k) => {
      const rest = pairs.filter((_, j) => j !== k);
      const qk = qMethod(rest);
      const e = angleDeg(p.b, rotate(qk, p.r));
      if (e > worstErr) {
        worstErr = e;
        worst = k;
      }
    });
  } else {
    res.forEach((x, i) => {
      if (x > res[worst]!) worst = i;
    });
  }
  const sdDeg = Math.sqrt(pairs.reduce((s, p) => s + (p.sd / DEG) ** 2, 0) / pairs.length);
  const yawErr = resolved ? sdDeg / Math.sin(Math.min(sep, 90) * DEG) : Infinity;
  const quality: SolveQuality = !resolved
    ? "degenerate"
    : sep < MIN_SEPARATION_DEG || (pairs.length >= 3 && rms > SUSPECT_RESIDUAL_DEG)
      ? "marginal"
      : "good";
  return {
    q: quatNorm(q),
    yawResolved: resolved,
    separationDeg: sep,
    residualDeg: rms,
    predictedYawErrDeg: yawErr,
    quality,
    worstPose: worst,
    poseResidualsDeg: res,
  };
}

/** Guidance: the smallest angle between a candidate IMU up and every accepted
 * pose's IMU up (the live "turn it further" readout), degrees. */
export function separationFromAccepted(candidateImuUp: V3, accepted: GravityPose[]): number {
  if (accepted.length === 0) return 180;
  return Math.min(...accepted.map((p) => angleDeg(candidateImuUp, p.imuUp)));
}
