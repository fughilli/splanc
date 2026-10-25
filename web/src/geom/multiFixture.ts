/**
 * Multi-fixture relative localization (docs/design/multi-fixture-localization.md).
 *
 * Several fixtures, each with its OWN already-solved LED map (its own frame),
 * are filmed in ONE phone capture while all of them flash disjoint id codes on a
 * shared clock. Every camera frame then yields, per visible fixture, 2D↔3D
 * correspondences against that fixture's map. This module turns those into each
 * fixture's pose in a shared room frame:
 *
 *     p_room = t + s · R · p_map            (FixturePose: translation, rotation, scale)
 *
 * with the chosen REFERENCE fixture at identity (the room frame is the reference
 * map's frame, levelled with gravity when the reference's "up" is known).
 *
 * Method (§3 of the design doc):
 *   1. per (frame, fixture) robust PnP against that fixture's map (geom/pnp.ts),
 *      warm-started frame to frame;
 *   2. incremental initialization through the co-visibility graph — cameras from
 *      already-placed fixtures, newly seen fixtures from already-placed cameras
 *      (PnP-composed candidates, or a multi-start for degenerate/collinear maps),
 *      so partially overlapping captures chain A–B–C;
 *   3. joint bundle adjustment over RIGID camera poses and fixture SIM(3) poses
 *      only (the maps themselves are held fixed), Huber IRLS + an outlier gate,
 *      the camera blocks eliminated by a Schur complement so the reduced system
 *      is just the fixtures' 7·(F−1) parameters;
 *   4. priors: each map's metric scale (its solve's scale_rel_std_err) and its
 *      gravity "up" (a gravity-levelled map's +Y, or an IMU-measured up);
 *   5. quality: per-fixture residuals, marginal covariance (Schur inverse,
 *      inflated for the per-LED map error that does NOT average across frames),
 *      predicted LED-position σ, and degeneracy warnings.
 *
 * Pure TypeScript, no DOM — used by the app's room-localization screen, the
 * agent (read side) and the synthetic tests (web/tests/multiFixture.test.ts).
 */

import type { Intrinsics, Pose, Quat, Vec3 } from "@ledmapper/protocol";
import { quatToRotMat, rotMatToQuat, type Mat3 } from "./pinhole";
import { estimatePose, poseToStd, stdToPose, type Correspondence } from "./pnp";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One already-mapped fixture. */
export interface FixtureModel {
  id: string;
  name?: string;
  /** LED positions in the fixture's own map frame (metres), keyed by LED index. */
  leds: ReadonlyMap<number, Vec3>;
  /** Unit "up" (anti-gravity) direction in the MAP frame when known: [0,1,0] for
   * a gravity-levelled map (OutputMap.frame == "gravity_leveled"), or the
   * IMU-measured up rotated into the map frame. null/absent = unknown. */
  up?: Vec3 | null;
  /** 1-σ relative error of the map's metric scale (OutputMapStats
   * .scale_rel_std_err). Absent = {@link LocalizeOptions.defaultScaleRelStdErr}. */
  scaleRelStdErr?: number | null;
}

/** One decoded LED sighting in one camera frame. */
export interface FixtureSighting {
  /** Index into the fixtures array. */
  fixture: number;
  /** LED index within that fixture's map. */
  led: number;
  u: number;
  v: number;
}

/** One camera frame (all sightings share one exposure, so one camera pose). */
export interface CaptureView {
  /** Capture time, ms (ordering + warm starts only). */
  t: number;
  K: Intrinsics;
  sightings: FixtureSighting[];
}

/** A fixture's pose in the room frame (same shape as FixturePose / the agent's Pose). */
export interface RoomPose {
  /** Metres. */
  translation: Vec3;
  /** Unit quaternion [x, y, z, w]. */
  rotation: Quat;
  scale: number;
}

export interface LocalizeOptions {
  /** Fixture index whose frame is the room frame (default: the best-observed). */
  reference?: number;
  /** "prior" (default): solve each fixture's relative scale with a Gaussian
   * prior from its map's scale error; "fixed": hold every scale at 1; "free":
   * no prior (only with plenty of camera translation). */
  scale?: "prior" | "fixed" | "free";
  /** Prior σ for maps that don't state their scale error (default 0.05 = 5 %). */
  defaultScaleRelStdErr?: number;
  /** σ of the gravity-tilt prior, degrees (default 5; 0 disables). */
  tiltSigmaDeg?: number;
  /** Huber threshold on the reprojection error, px (default 2). */
  huberPx?: number;
  /** Floor of the outlier gate, px (default 6; the gate adapts to 4·σ̂ above it). */
  outlierPx?: number;
  /** Sightings of one fixture in one frame needed for that frame's PnP (default 6). */
  minPnpLeds?: number;
  /** Sightings of one fixture in one frame for it to count in the BA (default 3). */
  minGroupLeds?: number;
  /** Cap on frames used (default 150; evenly spaced over the multi-fixture frames). */
  maxViews?: number;
  /** Cap on sightings per (frame, fixture) used (default 64, spread over the
   * fixture's LED index range): the error is dominated by the per-LED map error,
   * which more sightings of the same LEDs don't average away. */
  maxGroupLeds?: number;
  /** LM iterations per BA stage (default 40). */
  maxIterations?: number;
  /** Warm-start poses (room frame, by fixture index), e.g. the previous live
   * solve or the stored poses: tried as extra candidates during initialization. */
  seedPoses?: readonly (RoomPose | null | undefined)[];
}

export type FixtureStatus = "reference" | "localized" | "weak" | "unlocalized";

export interface FixtureLocalization {
  index: number;
  id: string;
  status: FixtureStatus;
  /** Room-frame pose (null when unlocalized). */
  pose: RoomPose | null;
  /** Frames (used by the joint solve) with enough inlier sightings of this fixture. */
  views: number;
  /** Of those, frames where another localized fixture was also seen. */
  coViews: number;
  /** Frames (of all supplied) where this fixture had >= minPnpLeds sightings. */
  framesSeen: number;
  /** Distinct LEDs of this fixture sighted. */
  ledsSeen: number;
  observations: number;
  inliers: number;
  /** Inlier reprojection RMS, px. */
  rmsPx: number;
  /** 1-σ marginal uncertainties (null for the reference / unlocalized). */
  sigma: {
    /** Fixture-origin translation, m (RSS of the 3 axes). */
    translationM: number;
    /** Rotation, degrees (RSS of the 3 axes). */
    rotationDeg: number;
    /** Relative scale (0 when held fixed). */
    scale: number;
    /** RMS over the fixture's LEDs of the predicted room-position σ, m. */
    ledM: number;
  } | null;
  /** Angle between this fixture's map "up" and the room's up after the solve, deg. */
  tiltDeg: number | null;
  /** Map is (near-)collinear: its roll about its own axis is unobservable (harmless). */
  linear: boolean;
  warnings: string[];
}

export interface LocalizeResult {
  /** Every fixture localized (no "unlocalized"; "weak" still counts). */
  ok: boolean;
  reference: number;
  fixtures: FixtureLocalization[];
  /** Camera poses of the frames the joint solve used (room frame, pinhole.ts convention). */
  cameras: { t: number; pose: Pose }[];
  /** Global inlier reprojection RMS, px. */
  rmsPx: number;
  observations: number;
  inliers: number;
  /** Frames with >= 2 fixtures sighted (the ones that carry relative information). */
  multiViews: number;
  /** "reference_up": levelled by the reference's known up; "assumed_y_up": its +Y. */
  leveling: "reference_up" | "assumed_y_up";
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Small linear algebra (row-major 3x3, dense n×n)
// ---------------------------------------------------------------------------

const I3: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mm(a: Mat3, b: Mat3): Mat3 {
  const o = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Mat3;
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
}
function mT(a: Mat3): Mat3 {
  return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]];
}
function mv(a: Mat3, v: Vec3): Vec3 {
  return [
    a[0] * v[0] + a[1] * v[1] + a[2] * v[2],
    a[3] * v[0] + a[4] * v[1] + a[5] * v[2],
    a[6] * v[0] + a[7] * v[1] + a[8] * v[2],
  ];
}
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scl = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 0 ? scl(a, 1 / n) : [0, 1, 0];
};

/** Rodrigues: axis-angle -> rotation. */
export function expSO3(w: Vec3): Mat3 {
  const th = norm(w);
  if (th < 1e-12) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
  const [x, y, z] = scl(w, 1 / th);
  const s = Math.sin(th), c = Math.cos(th), v = 1 - c;
  return [
    c + x * x * v, x * y * v - z * s, x * z * v + y * s,
    y * x * v + z * s, c + y * y * v, y * z * v - x * s,
    z * x * v - y * s, z * y * v + x * s, c + z * z * v,
  ];
}

/** Rotation angle of R, radians. */
export function rotAngle(R: Mat3): number {
  return Math.acos(Math.max(-1, Math.min(1, (R[0] + R[4] + R[8] - 1) / 2)));
}

/** Minimal rotation taking unit a onto unit b. */
function alignVectors(a: Vec3, b: Vec3): Mat3 {
  const ax = cross(a, b);
  const s = norm(ax);
  const c = dot(a, b);
  if (s < 1e-12) {
    if (c > 0) return I3;
    // 180°: any axis ⟂ a.
    const p: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    return expSO3(scl(unit(cross(a, p)), Math.PI));
  }
  return expSO3(scl(ax, Math.atan2(s, c) / s));
}

/** Re-orthonormalize (polar-ish: Gram-Schmidt on rows). */
function orthonormalize(R: Mat3): Mat3 {
  let r0: Vec3 = [R[0], R[1], R[2]];
  let r1: Vec3 = [R[3], R[4], R[5]];
  r0 = unit(r0);
  r1 = unit(sub(r1, scl(r0, dot(r0, r1))));
  const r2 = cross(r0, r1);
  return [r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], r2[0], r2[1], r2[2]];
}

/** Solve A x = b (n×n dense, partial pivot). null when singular. */
function solveDense(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const a = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    if (!(Math.abs(a[piv]![col]!) > 1e-300)) return null;
    if (piv !== col) [a[col], a[piv]] = [a[piv]!, a[col]!];
    const pr = a[col]!;
    const pv = pr[col]!;
    for (let r = col + 1; r < n; r++) {
      const row = a[r]!;
      const f = row[col]! / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) row[c]! -= f * pr[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let s = a[i]![n]!;
    for (let j = i + 1; j < n; j++) s -= a[i]![j]! * x[j]!;
    x[i] = s / a[i]![i]!;
  }
  return x.every(Number.isFinite) ? x : null;
}

function invertDense(A: number[][]): number[][] | null {
  const n = A.length;
  const out: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let c = 0; c < n; c++) {
    const e = new Array<number>(n).fill(0);
    e[c] = 1;
    const x = solveDense(A, e);
    if (x === null) return null;
    for (let r = 0; r < n; r++) out[r]![c] = x[r]!;
  }
  return out;
}

/** Eigenvalues of a symmetric 3x3 (Jacobi), descending. */
function symEig3(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => [...r]);
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p]![q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++)
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k]![p]!, akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p]![k]!, aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k]![p]!, vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
  }
  const idx = [0, 1, 2].sort((i, j) => a[j]![j]! - a[i]![i]!);
  return {
    values: idx.map((i) => a[i]![i]!),
    vectors: idx.map((i) => [v[0]![i]!, v[1]![i]!, v[2]![i]!] as Vec3),
  };
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Standard +Z-forward extrinsics: Xc = R · P_room + t. */
interface Cam {
  R: Mat3;
  t: Vec3;
}
/** Fixture similarity: P_room = s · R · X_map + t. */
interface Fix {
  R: Mat3;
  t: Vec3;
  s: number;
}

interface Obs {
  view: number;
  fixture: number;
  led: number;
  X: Vec3;
  u: number;
  v: number;
  outlier: boolean;
}

interface ViewData {
  t: number;
  K: Intrinsics;
  /** Sightings per fixture (only LEDs present in that fixture's map). */
  groups: Map<number, Obs[]>;
}

interface Priors {
  /** Per-fixture σ of ln(scale); Infinity = no prior; 0 = scale held fixed. */
  scaleSigma: number[];
  /** Per-fixture up in map frame (null = no tilt prior). */
  up: (Vec3 | null)[];
  /** World up in the solve frame. */
  U: Vec3;
  tiltSigma: number; // radians; 0 = off
}

interface BAState {
  cams: (Cam | null)[];
  fix: (Fix | null)[];
}

function cloneState(s: BAState): BAState {
  return {
    cams: s.cams.map((c) => (c ? { R: [...c.R] as Mat3, t: [...c.t] as Vec3 } : null)),
    fix: s.fix.map((f) => (f ? { R: [...f.R] as Mat3, t: [...f.t] as Vec3, s: f.s } : null)),
  };
}

/** Project a map point of fixture f through camera c: residual (px) + intermediates. */
/** Shared result of {@link residual} (hot path: reused, read it immediately). */
const RES = { ru: 0, rv: 0, iz: 0, Pc: [0, 0, 0] as Vec3, sRX: [0, 0, 0] as Vec3 };

function residual(o: Obs, K: Intrinsics, c: Cam, f: Fix): typeof RES | null {
  const R = f.R, X = o.X, s = f.s;
  const x = s * (R[0] * X[0] + R[1] * X[1] + R[2] * X[2]);
  const y = s * (R[3] * X[0] + R[4] * X[1] + R[5] * X[2]);
  const z = s * (R[6] * X[0] + R[7] * X[1] + R[8] * X[2]);
  const Px = x + f.t[0], Py = y + f.t[1], Pz = z + f.t[2];
  const C = c.R;
  const cx = C[0] * Px + C[1] * Py + C[2] * Pz + c.t[0];
  const cy = C[3] * Px + C[4] * Py + C[5] * Pz + c.t[1];
  const cz = C[6] * Px + C[7] * Py + C[8] * Pz + c.t[2];
  if (cz < 1e-4) return null;
  const iz = 1 / cz;
  RES.ru = K[0] * cx * iz + K[2] - o.u;
  RES.rv = K[1] * cy * iz + K[3] - o.v;
  RES.iz = iz;
  RES.Pc[0] = cx; RES.Pc[1] = cy; RES.Pc[2] = cz;
  RES.sRX[0] = x; RES.sRX[1] = y; RES.sRX[2] = z;
  return RES;
}

function huberRho(e: number, d: number): number {
  return e <= d ? e * e : 2 * d * e - d * d;
}

// ---------------------------------------------------------------------------
// Bundle adjustment (cameras rigid, fixtures Sim(3), maps fixed)
// ---------------------------------------------------------------------------

interface BAConfig {
  obs: Obs[];
  views: ViewData[];
  freeCams: Set<number>;
  freeFix: number[];
  solveScale: boolean;
  priors: Priors;
  huber: number;
  iters: number;
}

function priorCost(st: BAState, cfg: BAConfig): number {
  let c = 0;
  for (const k of cfg.freeFix) {
    const f = st.fix[k]!;
    const ss = cfg.priors.scaleSigma[k]!;
    if (cfg.solveScale && Number.isFinite(ss) && ss > 0) c += (Math.log(f.s) / ss) ** 2;
    const up = cfg.priors.up[k];
    if (up && cfg.priors.tiltSigma > 0) {
      const a = mv(f.R, up);
      const d = sub(a, cfg.priors.U);
      c += dot(d, d) / cfg.priors.tiltSigma ** 2;
    }
  }
  return c;
}

function totalCost(st: BAState, cfg: BAConfig): number {
  let c = 0;
  for (const o of cfg.obs) {
    if (o.outlier) continue;
    const cam = st.cams[o.view];
    const f = st.fix[o.fixture];
    if (!cam || !f) continue;
    const r = residual(o, cfg.views[o.view]!.K, cam, f);
    if (r === null) {
      c += huberRho(1e3, cfg.huber);
      continue;
    }
    c += huberRho(Math.hypot(r.ru, r.rv), cfg.huber);
  }
  return c + priorCost(st, cfg);
}

interface Accum {
  /** Free-camera blocks keyed by view index. */
  Hcc: Map<number, number[][]>;
  gc: Map<number, number[]>;
  /** Hcf[view] -> fixture -> 6×d. */
  Hcf: Map<number, Map<number, number[][]>>;
  Hff: number[][];
  gf: number[];
  /** Offset of each free fixture in the reduced vector. */
  off: Map<number, number>;
  dim: number;
  d: number;
}

// Scratch Jacobians (hot path: no per-sighting allocation). Row-major 2×6 / 2×7.
const JC = new Float64Array(12);
const JF = new Float64Array(14);

/** Residual + Jacobians of one sighting into JC / JF (null when behind the
 * camera). JC is w.r.t. the camera's left perturbation [δω, δt]; JF w.r.t. the
 * fixture's [δθ, δτ, (δσ)] (d = 6 or 7 columns). */
function fillJacobians(
  o: Obs,
  st: BAState,
  cfg: BAConfig,
  d: number,
  camFree: boolean,
  fixFree: boolean,
  weights = true,
): { ru: number; rv: number; w: number } | null {
  const cam = st.cams[o.view];
  const f = st.fix[o.fixture];
  if (!cam || !f) return null;
  const K = cfg.views[o.view]!.K;
  const r = residual(o, K, cam, f);
  if (r === null) return null;
  const e = Math.hypot(r.ru, r.rv);
  const w = !weights || e <= cfg.huber ? 1 : cfg.huber / e;
  const [X, Y, Z] = r.Pc;
  const iz = r.iz;
  // dπ/dPc rows: [p0, 0, p2] and [0, q1, q2].
  const p0 = K[0] * iz, p2 = -K[0] * X * iz * iz;
  const q1 = K[1] * iz, q2 = -K[1] * Y * iz * iz;
  if (camFree) {
    // Jp · [ -[Pc]x | I ]
    JC[0] = p2 * Y; JC[1] = p0 * Z - p2 * X; JC[2] = -p0 * Y; JC[3] = p0; JC[4] = 0; JC[5] = p2;
    JC[6] = -q1 * Z + q2 * Y; JC[7] = -q2 * X; JC[8] = q1 * X; JC[9] = 0; JC[10] = q1; JC[11] = q2;
  }
  if (fixFree) {
    // (Jp · Rc) · [ -[sRX]x | I | sRX ]
    const R = cam.R;
    const a0 = p0 * R[0] + p2 * R[6], a1 = p0 * R[1] + p2 * R[7], a2 = p0 * R[2] + p2 * R[8];
    const b0 = q1 * R[3] + q2 * R[6], b1 = q1 * R[4] + q2 * R[7], b2 = q1 * R[5] + q2 * R[8];
    const [x, y, z] = r.sRX;
    const base = d;
    JF[0] = -a1 * z + a2 * y; JF[1] = a0 * z - a2 * x; JF[2] = -a0 * y + a1 * x; JF[3] = a0; JF[4] = a1; JF[5] = a2;
    JF[base] = -b1 * z + b2 * y; JF[base + 1] = b0 * z - b2 * x; JF[base + 2] = -b0 * y + b1 * x;
    JF[base + 3] = b0; JF[base + 4] = b1; JF[base + 5] = b2;
    if (d === 7) {
      JF[6] = a0 * x + a1 * y + a2 * z;
      JF[13] = b0 * x + b1 * y + b2 * z;
    }
  }
  return { ru: r.ru, rv: r.rv, w };
}

const toRows = (a: Float64Array, rows: number, cols: number): number[][] =>
  Array.from({ length: rows }, (_, i) => Array.from(a.subarray(i * cols, i * cols + cols)));

function accumulate(st: BAState, cfg: BAConfig, weights = true): Accum {
  const d = cfg.solveScale ? 7 : 6;
  const off = new Map<number, number>();
  cfg.freeFix.forEach((k, i) => off.set(k, i * d));
  const dim = cfg.freeFix.length * d;
  const hff = new Float64Array(dim * dim);
  const gf = new Array<number>(dim).fill(0);
  const hcc = new Map<number, Float64Array>();
  const gcc = new Map<number, Float64Array>();
  const hcf = new Map<number, Map<number, Float64Array>>();

  for (const o of cfg.obs) {
    if (o.outlier) continue;
    const fo = off.get(o.fixture);
    const camFree = cfg.freeCams.has(o.view);
    const jr = fillJacobians(o, st, cfg, d, camFree, fo !== undefined, weights);
    if (jr === null) continue;
    const { w } = jr;
    const res0 = jr.ru, res1 = jr.rv;
    if (camFree) {
      let H = hcc.get(o.view);
      let g = gcc.get(o.view);
      if (!H || !g) {
        H = new Float64Array(36);
        g = new Float64Array(6);
        hcc.set(o.view, H);
        gcc.set(o.view, g);
      }
      for (let i = 0; i < 6; i++) {
        const u0 = w * JC[i]!, u1 = w * JC[6 + i]!;
        g[i]! += u0 * res0 + u1 * res1;
        for (let j = 0; j < 6; j++) H[i * 6 + j]! += u0 * JC[j]! + u1 * JC[6 + j]!;
      }
    }
    if (fo !== undefined) {
      for (let i = 0; i < d; i++) {
        const u0 = w * JF[i]!, u1 = w * JF[d + i]!;
        gf[fo + i]! += u0 * res0 + u1 * res1;
        const row = (fo + i) * dim + fo;
        for (let j = 0; j < d; j++) hff[row + j]! += u0 * JF[j]! + u1 * JF[d + j]!;
      }
      if (camFree) {
        let m = hcf.get(o.view);
        if (!m) hcf.set(o.view, (m = new Map()));
        let B = m.get(o.fixture);
        if (!B) m.set(o.fixture, (B = new Float64Array(6 * d)));
        for (let i = 0; i < 6; i++) {
          const u0 = w * JC[i]!, u1 = w * JC[6 + i]!;
          for (let j = 0; j < d; j++) B[i * d + j]! += u0 * JF[j]! + u1 * JF[d + j]!;
        }
      }
    }
  }
  const Hff = toRows(hff, dim, dim);
  const Hcc = new Map<number, number[][]>();
  const gc = new Map<number, number[]>();
  const Hcf = new Map<number, Map<number, number[][]>>();
  for (const [v, H] of hcc) {
    Hcc.set(v, toRows(H, 6, 6));
    gc.set(v, Array.from(gcc.get(v)!));
  }
  for (const [v, m] of hcf) {
    const mm2 = new Map<number, number[][]>();
    for (const [k, B] of m) mm2.set(k, toRows(B, 6, d));
    Hcf.set(v, mm2);
  }
  // Priors (quadratic).
  for (const k of cfg.freeFix) {
    const fo = off.get(k)!;
    const f = st.fix[k]!;
    const ss = cfg.priors.scaleSigma[k]!;
    if (d === 7 && Number.isFinite(ss) && ss > 0) {
      const ir = 1 / ss;
      gf[fo + 6]! += ir * (Math.log(f.s) * ir);
      Hff[fo + 6]![fo + 6]! += ir * ir;
    }
    const up = cfg.priors.up[k];
    if (up && cfg.priors.tiltSigma > 0) {
      const a = mv(f.R, up);
      const rv = scl(sub(a, cfg.priors.U), 1 / cfg.priors.tiltSigma);
      // d a / dθ = -[a]x
      const J = [
        [0, a[2], -a[1]],
        [-a[2], 0, a[0]],
        [a[1], -a[0], 0],
      ].map((row) => row.map((x) => x / cfg.priors.tiltSigma));
      for (let rr = 0; rr < 3; rr++)
        for (let i = 0; i < 3; i++) {
          gf[fo + i]! += J[rr]![i]! * rv[rr]!;
          for (let j = 0; j < 3; j++) Hff[fo + i]![fo + j]! += J[rr]![i]! * J[rr]![j]!;
        }
    }
  }
  return { Hcc, gc, Hcf, Hff, gf, off, dim, d };
}

/** Schur-reduced system S δf = -b (cameras eliminated). `lambda` = Marquardt damping. */
function schur(acc: Accum, lambda: number, reg: number) {
  const { dim } = acc;
  const S = acc.Hff.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) + reg : x)));
  const b = [...acc.gf];
  const camInv = new Map<number, number[][]>();
  for (const [view, H] of acc.Hcc) {
    const A = H.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) + 1e-9 : x)));
    const Ai = invertDense(A);
    if (Ai === null) continue;
    camInv.set(view, Ai);
    const blocks = acc.Hcf.get(view);
    if (!blocks || dim === 0) continue;
    const g = acc.gc.get(view)!;
    // W_k = Ai · B_k  (6×d)
    const W = new Map<number, number[][]>();
    for (const [k, B] of blocks) W.set(k, Ai.map((row) => B[0]!.map((_, j) => row.reduce((s, x, m) => s + x * B[m]![j]!, 0))));
    const Aig = Ai.map((row) => row.reduce((s, x, m) => s + x * g[m]!, 0));
    for (const [k1, B1] of blocks) {
      const o1 = acc.off.get(k1)!;
      for (let i = 0; i < acc.d; i++) b[o1 + i]! -= B1.reduce((s, row, m) => s + row[i]! * Aig[m]!, 0);
      for (const [k2] of blocks) {
        const o2 = acc.off.get(k2)!;
        const W2 = W.get(k2)!;
        for (let i = 0; i < acc.d; i++)
          for (let j = 0; j < acc.d; j++) {
            let s = 0;
            for (let m = 0; m < 6; m++) s += B1[m]![i]! * W2[m]![j]!;
            S[o1 + i]![o2 + j]! -= s;
          }
      }
    }
  }
  return { S, b, camInv };
}

function applyDelta(st: BAState, cfg: BAConfig, acc: Accum, df: number[], camInv: Map<number, number[][]>): BAState {
  const out = cloneState(st);
  for (const k of cfg.freeFix) {
    const o = acc.off.get(k)!;
    const f = out.fix[k]!;
    f.R = orthonormalize(mm(expSO3([df[o]!, df[o + 1]!, df[o + 2]!]), f.R));
    f.t = add(f.t, [df[o + 3]!, df[o + 4]!, df[o + 5]!]);
    if (acc.d === 7) f.s *= Math.exp(Math.max(-0.5, Math.min(0.5, df[o + 6]!)));
  }
  for (const [view, Ai] of camInv) {
    const g = acc.gc.get(view)!;
    const rhs = g.map((x) => -x);
    const blocks = acc.Hcf.get(view);
    if (blocks)
      for (const [k, B] of blocks) {
        const o = acc.off.get(k)!;
        for (let i = 0; i < 6; i++) for (let j = 0; j < acc.d; j++) rhs[i]! -= B[i]![j]! * df[o + j]!;
      }
    const dc = Ai.map((row) => row.reduce((s, x, m) => s + x * rhs[m]!, 0));
    const c = out.cams[view]!;
    const dR = expSO3([dc[0]!, dc[1]!, dc[2]!]);
    c.R = orthonormalize(mm(dR, c.R));
    c.t = add(mv(dR, c.t), [dc[3]!, dc[4]!, dc[5]!]);
  }
  return out;
}

function bundleAdjust(st0: BAState, cfg: BAConfig): { state: BAState; cost: number; iterations: number } {
  let st = st0;
  let cost = totalCost(st, cfg);
  let lambda = 1e-3;
  let it = 0;
  for (; it < cfg.iters; it++) {
    const acc = accumulate(st, cfg);
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const { S, b, camInv } = schur(acc, lambda, 1e-9);
      const df = acc.dim > 0 ? solveDense(S, b.map((x) => -x)) : [];
      if (df === null) {
        lambda *= 10;
        continue;
      }
      const cand = applyDelta(st, cfg, acc, df, camInv);
      const c2 = totalCost(cand, cfg);
      if (c2 < cost) {
        const rel = (cost - c2) / Math.max(cost, 1e-12);
        st = cand;
        cost = c2;
        lambda = Math.max(lambda / 3, 1e-7);
        improved = true;
        if (rel < 1e-6) return { state: st, cost, iterations: it + 1 };
        break;
      }
      lambda *= 6;
      if (lambda > 1e10) break;
    }
    if (!improved) break;
  }
  return { state: st, cost, iterations: it };
}

/**
 * Marginal covariance of the free fixture parameters, CLUSTER-ROBUST by LED
 * (a sandwich S⁻¹ M S⁻¹ with the cameras profiled out). The dominant error is
 * each map's own per-LED error, which is the SAME in every frame: treating the
 * sightings as independent would shrink σ by √(frames) and be wildly
 * over-confident. Clustering the scores by (fixture, LED) charges every LED's
 * frames as one correlated unit — whatever the mix of pixel noise and map error.
 */
function clusterRobustCov(st: BAState, cfg: BAConfig, acc: Accum, Sinv: number[][]): number[][] {
  const { dim, d } = acc;
  // M_view,k = B_kᵀ · Hcc⁻¹ (d×6): how a camera's residual leaks into fixture k.
  const leak = new Map<number, Map<number, number[][]>>();
  for (const [view, H] of acc.Hcc) {
    const Ai = invertDense(H.map((row, i) => row.map((x, j) => (i === j ? x + 1e-9 : x))));
    const blocks = acc.Hcf.get(view);
    if (!Ai || !blocks) continue;
    const m = new Map<number, number[][]>();
    for (const [k, B] of blocks)
      m.set(
        k,
        Array.from({ length: d }, (_, i) => Array.from({ length: 6 }, (_, c) => B.reduce((s, row, r) => s + row[i]! * Ai[r]![c]!, 0))),
      );
    leak.set(view, m);
  }
  const G = new Map<string, number[]>();
  for (const o of cfg.obs) {
    if (o.outlier) continue;
    const fo = acc.off.get(o.fixture);
    const camFree = cfg.freeCams.has(o.view);
    const jr = fillJacobians(o, st, cfg, d, camFree, fo !== undefined);
    if (jr === null) continue;
    const jac = {
      w: jr.w,
      res: [jr.ru, jr.rv],
      Jf: fo !== undefined ? [Array.from(JF.subarray(0, d)), Array.from(JF.subarray(d, 2 * d))] : null,
      Jc: camFree ? [Array.from(JC.subarray(0, 6)), Array.from(JC.subarray(6, 12))] : null,
    };
    const key = `${o.fixture}:${o.led}`;
    let g = G.get(key);
    if (!g) G.set(key, (g = new Array<number>(dim).fill(0)));
    for (let rr = 0; rr < 2; rr++) {
      const wr = jac.w * jac.res[rr]!;
      if (jac.Jf && fo !== undefined) for (let i = 0; i < d; i++) g[fo + i]! += jac.Jf[rr]![i]! * wr;
      const m = jac.Jc ? leak.get(o.view) : undefined;
      if (m)
        for (const [k, M] of m) {
          const ok = acc.off.get(k)!;
          for (let i = 0; i < d; i++) {
            let s = 0;
            for (let c = 0; c < 6; c++) s += M[i]![c]! * jac.Jc![rr]![c]!;
            g[ok + i]! -= s * wr;
          }
        }
    }
  }
  const nC = G.size;
  const meat = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  for (const g of G.values()) for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) meat[i]![j]! += g[i]! * g[j]!;
  const corr = nC > 1 ? nC / (nC - 1) : 1;
  for (let i = 0; i < dim; i++) for (let j = 0; j < dim; j++) meat[i]![j]! *= corr;
  // The priors are information too (unit-variance residuals): their Hessian.
  for (const k of cfg.freeFix) {
    const fo = acc.off.get(k)!;
    const ss = cfg.priors.scaleSigma[k]!;
    if (d === 7 && Number.isFinite(ss) && ss > 0) meat[fo + 6]![fo + 6]! += 1 / (ss * ss);
    const up = cfg.priors.up[k];
    if (up && cfg.priors.tiltSigma > 0) {
      const a = mv(st.fix[k]!.R, up);
      const J = [
        [0, a[2], -a[1]],
        [-a[2], 0, a[0]],
        [a[1], -a[0], 0],
      ];
      const t2 = cfg.priors.tiltSigma ** 2;
      for (let r = 0; r < 3; r++)
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) meat[fo + i]![fo + j]! += (J[r]![i]! * J[r]![j]!) / t2;
    }
  }
  const tmp = Sinv.map((row) => Array.from({ length: dim }, (_, j) => row.reduce((s, x, m) => s + x * meat[m]![j]!, 0)));
  return tmp.map((row) => Array.from({ length: dim }, (_, j) => row.reduce((s, x, m) => s + x * Sinv[m]![j]!, 0)));
}

// ---------------------------------------------------------------------------
// Pose composition helpers
// ---------------------------------------------------------------------------

/** room<-fixture from cam<-room (camera known) and cam<-fixture (PnP, unit scale). */
function fixFromCam(cam: Cam, pnp: Cam): Fix {
  const Rt = mT(cam.R);
  return { R: mm(Rt, pnp.R), t: mv(Rt, sub(pnp.t, cam.t)), s: 1 };
}

/** cam<-room from a placed fixture and cam<-fixture (PnP in the fixture's units). */
function camFromFix(f: Fix, pnp: Cam): Cam {
  // Camera centre in fixture frame, then in room.
  const cK = scl(mv(mT(pnp.R), pnp.t), -1);
  const cRoom = add(scl(mv(f.R, cK), f.s), f.t);
  const R = mm(pnp.R, mT(f.R));
  return { R, t: scl(mv(R, cRoom), -1) };
}

function camToPose(c: Cam): Pose {
  return stdToPose(c.R, c.t);
}

function fixToRoomPose(f: Fix): RoomPose {
  const q = rotMatToQuat(f.R);
  // Canonical sign (w >= 0) so equal rotations serialize equally.
  const qq: Quat = q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q;
  return { translation: [...f.t] as Vec3, rotation: qq, scale: f.s };
}

export function roomPoseToMatrix(p: RoomPose): { R: Mat3; t: Vec3; s: number } {
  return { R: quatToRotMat(p.rotation), t: [...p.translation] as Vec3, s: p.scale };
}

/** Apply a room pose to a map-frame point. */
export function applyRoomPose(p: RoomPose, x: Vec3): Vec3 {
  return add(scl(mv(quatToRotMat(p.rotation), x), p.scale), p.translation);
}

// ---------------------------------------------------------------------------
// Map geometry
// ---------------------------------------------------------------------------

function mapShape(leds: ReadonlyMap<number, Vec3>): {
  centroid: Vec3;
  extent: number;
  linear: boolean;
  planar: boolean;
  axis: Vec3;
} {
  const pts = [...leds.values()];
  const n = Math.max(1, pts.length);
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) c[k] = c[k]! + p[k]! / n;
  const C = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i]![j]! += (d[i]! * d[j]!) / n;
  }
  const { values, vectors } = symEig3(C);
  const l0 = Math.max(values[0]!, 1e-12);
  return {
    centroid: c,
    extent: 2 * Math.sqrt(l0),
    // Second principal spread under ~3 % of the first (σ ratio): a strip/line.
    linear: Math.sqrt(Math.max(values[1]!, 0) / l0) < 0.03,
    // Thin in one direction: PnP has the two-fold planar ambiguity.
    planar: Math.sqrt(Math.max(values[2]!, 0) / l0) < 0.05,
    axis: vectors[0]!,
  };
}

// ---------------------------------------------------------------------------
// The solve
// ---------------------------------------------------------------------------

/** Localize fixtures from one multi-fixture capture. See the module doc. */
export function localizeFixtures(
  fixtures: readonly FixtureModel[],
  inputViews: readonly CaptureView[],
  options: LocalizeOptions = {},
): LocalizeResult {
  const F = fixtures.length;
  const opt = {
    scale: options.scale ?? "prior",
    defaultScaleRelStdErr: options.defaultScaleRelStdErr ?? 0.05,
    tiltSigma: ((options.tiltSigmaDeg ?? 5) * Math.PI) / 180,
    huber: options.huberPx ?? 2,
    outlierPx: options.outlierPx ?? 6,
    minPnp: Math.max(4, options.minPnpLeds ?? 6),
    minGroup: Math.max(1, options.minGroupLeds ?? 3),
    maxViews: options.maxViews ?? 150,
    maxGroupLeds: Math.max(6, options.maxGroupLeds ?? 64),
    iters: options.maxIterations ?? 40,
  };
  const warnings: string[] = [];
  const shapes = fixtures.map((f) => mapShape(f.leds));

  // -- 1. Normalize views: group sightings per fixture, keep useful frames ----
  const ledsSeenSets = fixtures.map(() => new Set<number>());
  const allViews: ViewData[] = [...inputViews]
    .sort((a, b) => a.t - b.t)
    .map((v, vi) => {
      const groups = new Map<number, Obs[]>();
      const seen = new Set<string>();
      for (const s of v.sightings) {
        const fx = fixtures[s.fixture];
        const X = fx?.leds.get(s.led);
        if (!X || !Number.isFinite(s.u) || !Number.isFinite(s.v)) continue;
        const key = `${s.fixture}:${s.led}`;
        if (seen.has(key)) continue; // one sighting per LED per frame
        seen.add(key);
        let g = groups.get(s.fixture);
        if (!g) groups.set(s.fixture, (g = []));
        g.push({ view: -1, fixture: s.fixture, led: s.led, X, u: s.u, v: s.v, outlier: false });
      }
      for (const [k, g] of groups) {
        if (g.length < opt.minGroup) groups.delete(k);
        else if (g.length > opt.maxGroupLeds) {
          g.sort((a, b) => a.led - b.led);
          const step = g.length / opt.maxGroupLeds;
          // Rotate the subset frame to frame so every LED is used across the capture.
          const phase = (vi * 0.618034) % 1;
          const keep = Array.from({ length: opt.maxGroupLeds }, (_, i) => g[Math.floor((i + phase) * step)]!);
          for (const o of g) ledsSeenSets[k]!.add(o.led);
          groups.set(k, keep);
        }
      }
      return { t: v.t, K: v.K, groups };
    });

  const framesSeen = new Array<number>(F).fill(0);
  for (const v of allViews)
    for (const [k, g] of v.groups) {
      if (g.length >= opt.minPnp) framesSeen[k]!++;
      for (const o of g) ledsSeenSets[k]!.add(o.led);
    }

  // Frames that carry RELATIVE information: >= 2 fixtures, one PnP-able.
  const isMulti = (v: ViewData) => v.groups.size >= 2 && [...v.groups.values()].some((g) => g.length >= opt.minPnp);
  let views = allViews.filter(isMulti);
  const multiViews = views.length;
  if (views.length > opt.maxViews) {
    const step = views.length / opt.maxViews;
    views = Array.from({ length: opt.maxViews }, (_, i) => views[Math.floor(i * step)]!);
  }
  views.forEach((v, i) => {
    for (const g of v.groups.values()) for (const o of g) o.view = i;
  });
  const obs: Obs[] = views.flatMap((v) => [...v.groups.values()].flat());

  const emptyResult = (reason: string, reference: number): LocalizeResult => ({
    ok: false,
    reference,
    fixtures: fixtures.map((f, i) => ({
      index: i,
      id: f.id,
      status: i === reference ? "reference" : "unlocalized",
      pose: i === reference ? { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: 1 } : null,
      views: 0,
      coViews: 0,
      framesSeen: framesSeen[i]!,
      ledsSeen: ledsSeenSets[i]!.size,
      observations: 0,
      inliers: 0,
      rmsPx: 0,
      sigma: null,
      tiltDeg: null,
      linear: shapes[i]!.linear,
      warnings: [],
    })),
    cameras: [],
    rmsPx: 0,
    observations: 0,
    inliers: 0,
    multiViews,
    leveling: fixtures[reference]?.up ? "reference_up" : "assumed_y_up",
    warnings: [...warnings, reason],
  });

  if (F === 0) return emptyResult("no fixtures", 0);

  // -- 2. Per (frame, fixture) PnP, warm-started along time ------------------
  const pnp: (Cam | null)[][] = views.map(() => new Array<Cam | null>(F).fill(null));
  const pnpOk = new Array<number>(F).fill(0);
  for (let k = 0; k < F; k++) {
    if (shapes[k]!.linear) continue; // PnP is degenerate on a line: placed via cameras instead
    let seed: Pose | undefined;
    for (let i = 0; i < views.length; i++) {
      const g = views[i]!.groups.get(k);
      if (!g || g.length < opt.minPnp) continue;
      const corrs: Correspondence[] = g.map((o) => ({ xyz: o.X, u: o.u, v: o.v }));
      const r = estimatePose(corrs, views[i]!.K, {
        ...(seed ? { seed } : {}),
        inlierPx: 8,
        minInliers: Math.max(opt.minPnp, Math.ceil(0.6 * g.length)),
        maxRmsPx: 4,
      });
      if (r && r.ok) {
        pnp[i]![k] = poseToStd(r.pose);
        seed = r.pose;
        pnpOk[k]!++;
      }
    }
  }

  // Reference + anchor (the gauge during initialization: must be PnP-able).
  let reference = options.reference ?? -1;
  if (!(reference >= 0 && reference < F)) {
    reference = 0;
    for (let k = 1; k < F; k++) if (pnpOk[k]! > pnpOk[reference]!) reference = k;
  }
  // The anchor seeds every camera at first, so prefer a fixture whose PnP is
  // unambiguous (not planar: a flat panel's PnP has a two-fold flip).
  let anchor = reference;
  const anchorScore = (k: number) => (pnpOk[k]! > 0 ? (shapes[k]!.planar ? 0 : 1e6) + pnpOk[k]! : 0);
  for (let k = 0; k < F; k++) if (anchorScore(k) > anchorScore(anchor) * (shapes[anchor]!.planar ? 1 : 2)) anchor = k;
  if (views.length === 0) {
    return emptyResult(
      "no frame showed two fixtures at once — keep at least two fixtures in view while you move",
      reference,
    );
  }
  if (pnpOk[anchor] === 0) {
    return emptyResult("no fixture could be registered in any frame (too few decoded LEDs per fixture)", reference);
  }

  // -- 3. Incremental initialization through the co-visibility graph ---------
  const anchorUp = fixtures[anchor]!.up ? unit(fixtures[anchor]!.up!) : ([0, 1, 0] as Vec3);
  const scaleSigma = fixtures.map((f) => {
    if (opt.scale === "fixed") return 0;
    if (opt.scale === "free") return Infinity;
    const e = f.scaleRelStdErr;
    return e !== null && e !== undefined && e > 0 ? e : opt.defaultScaleRelStdErr;
  });
  const solveScale = opt.scale !== "fixed";
  const ups = fixtures.map((f) => (f.up ? unit(f.up) : null));
  const initPriors: Priors = { scaleSigma, up: ups, U: anchorUp, tiltSigma: opt.tiltSigma };

  let st: BAState = { cams: views.map(() => null), fix: fixtures.map(() => null) };
  st.fix[anchor] = { R: I3, t: [0, 0, 0], s: 1 };
  for (let i = 0; i < views.length; i++) {
    const p = pnp[i]![anchor];
    if (p) st.cams[i] = { R: p.R, t: p.t };
  }

  const obsByFix: Obs[][] = fixtures.map(() => []);
  for (const o of obs) obsByFix[o.fixture]!.push(o);
  /** Score a fixture hypothesis against the placed cameras: per-frame inlier
   * ratios, so a few wrongly placed cameras (e.g. a planar fixture's PnP flip)
   * can't veto a hypothesis the majority of frames agree on. */
  const fixScore = (k: number, f: Fix) => {
    let cost = 0, inl = 0, n = 0;
    const perView = new Map<number, { n: number; inl: number }>();
    for (const o of obsByFix[k]!) {
      const cam = st.cams[o.view];
      if (!cam) continue;
      n++;
      const r = residual(o, views[o.view]!.K, cam, f);
      const e = r === null ? 1e3 : Math.hypot(r.ru, r.rv);
      const pv = perView.get(o.view) ?? { n: 0, inl: 0 };
      pv.n++;
      if (e < 8) {
        inl++;
        pv.inl++;
      }
      perView.set(o.view, pv);
      cost += huberRho(Math.min(e, 50), 4);
    }
    const good = new Set<number>();
    const bad = new Set<number>();
    for (const [v, pv] of perView) {
      if (pv.inl >= 0.6 * pv.n) good.add(v);
      else if (pv.inl < 0.3 * pv.n) bad.add(v);
    }
    return { cost, inl, n, good, bad, views: perView.size };
  };
  const better = (a: ReturnType<typeof fixScore>, b: ReturnType<typeof fixScore> | null) =>
    !b || a.good.size > b.good.size || (a.good.size === b.good.size && (a.inl > b.inl || (a.inl === b.inl && a.cost < b.cost)));

  const refineFixture = (k: number, f: Fix, only?: Set<number>, iters = 25): Fix => {
    const cfg: BAConfig = {
      obs: obsByFix[k]!.filter((o) => st.cams[o.view] !== null && (!only || only.has(o.view))),
      views,
      freeCams: new Set(),
      freeFix: [k],
      solveScale: false,
      priors: initPriors,
      huber: 4,
      iters,
    };
    const tmp = cloneState(st);
    tmp.fix[k] = f;
    return bundleAdjust(tmp, cfg).state.fix[k]!;
  };

  const placeFixture = (k: number): boolean => {
    const cands: Fix[] = [];
    for (let i = 0; i < views.length; i++) {
      const cam = st.cams[i];
      const p = pnp[i]![k];
      if (cam && p) cands.push(fixFromCam(cam, p));
    }
    const seedPose = options.seedPoses?.[k];
    const seedRef = options.seedPoses?.[anchor];
    let seeded: Fix | null = null;
    if (seedPose && seedRef) {
      // Express the seed relative to the anchor (seeds are in the room frame).
      const a = roomPoseToMatrix(seedRef), b = roomPoseToMatrix(seedPose);
      const Rt = mT(a.R);
      seeded = { R: mm(Rt, b.R), t: scl(mv(Rt, sub(b.t, a.t)), 1 / a.s), s: b.s / a.s };
    }
    const multiStart = cands.length === 0;
    if (cands.length === 0) {
      // Multi-start from the best-covered frames: depth from apparent size,
      // yaw sweep about up (handles collinear strips and PnP failures).
      const frames = views
        .map((v, i) => ({ i, g: v.groups.get(k) }))
        .filter((x) => x.g && st.cams[x.i])
        .sort((a, b) => b.g!.length - a.g!.length)
        .slice(0, 2);
      const upK = ups[k] ?? ([0, 1, 0] as Vec3);
      const level = alignVectors(upK, anchorUp);
      for (const { i, g } of frames) {
        const cam = st.cams[i]!;
        const K = views[i]!.K;
        let us = 0, vs = 0, umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
        for (const o of g!) {
          us += o.u;
          vs += o.v;
          umin = Math.min(umin, o.u);
          umax = Math.max(umax, o.u);
          vmin = Math.min(vmin, o.v);
          vmax = Math.max(vmax, o.v);
        }
        const n = g!.length;
        const spanPx = Math.max(8, Math.hypot(umax - umin, vmax - vmin));
        // Extent of the sighted subset in the map.
        const sub3 = mapShape(new Map(g!.map((o) => [o.led, o.X])));
        const depth = (K[0] * Math.max(sub3.extent, 0.02) * 1.5) / spanPx;
        const ray: Vec3 = unit([(us / n - K[2]) / K[0], (vs / n - K[3]) / K[1], 1]);
        const cRoom = scl(mv(mT(cam.R), cam.t), -1);
        const target = add(cRoom, scl(mv(mT(cam.R), ray), depth));
        for (let a = 0; a < 8; a++) {
          const R = mm(expSO3(scl(anchorUp, (a * Math.PI) / 4)), level);
          for (const dScale of [0.7, 1, 1.4]) {
            const tgt = add(cRoom, scl(sub(target, cRoom), dScale));
            cands.push({ R, t: sub(tgt, mv(R, sub3.centroid)), s: 1 });
          }
        }
      }
    }
    if (multiStart) {
      // Rough starts must be refined before they can be scored.
      for (let i = 0; i < cands.length; i++) cands[i] = refineFixture(k, cands[i]!, undefined, 6);
    }
    if (seeded) cands.push(seeded);
    if (cands.length === 0) return false;
    // Bound the candidate set (one per frame can be hundreds): evenly spaced.
    if (cands.length > 24) {
      const step = cands.length / 24;
      cands.splice(0, cands.length, ...Array.from({ length: 24 }, (_, i) => cands[Math.floor(i * step)]!));
      if (seeded) cands.push(seeded);
    }
    // Score candidates, refine the best few on the frames that agree with them.
    const scored = cands.map((f) => ({ f, sc: fixScore(k, f) }));
    scored.sort((x, y) => (better(x.sc, y.sc) ? -1 : better(y.sc, x.sc) ? 1 : 0));
    const top = scored.slice(0, 3);
    const seededEntry = seeded ? scored.find((x) => x.f === seeded) : undefined;
    if (seededEntry && !top.includes(seededEntry)) top.push(seededEntry);
    let best: { f: Fix; sc: ReturnType<typeof fixScore> } | null = null;
    for (const c of top) {
      if (c.sc.good.size === 0) continue;
      const f = refineFixture(k, c.f, c.sc.good, 8);
      const sc = fixScore(k, f);
      if (better(sc, best?.sc ?? null)) best = { f, sc };
    }
    if (best && best.sc.good.size > 0) {
      const f = refineFixture(k, best.f, best.sc.good, 20);
      best = { f, sc: fixScore(k, f) };
    }
    // Accept on a consistent minority too: wrongly placed cameras (planar flips)
    // disagree with each other as well, so >= 3 agreeing frames is a real signal.
    if (!best || best.sc.good.size < Math.min(3, best.sc.views) || best.sc.good.size < 0.2 * best.sc.views) return false;
    st.fix[k] = best.f;
    // Frames whose camera contradicts the new fixture outright were placed wrongly
    // (single planar/partial fixture): drop them, they get re-placed from the union.
    for (const v of best.sc.bad) if (fixPerViewPlaced(v) <= 2) st.cams[v] = null;
    return true;
  };

  /** Placed fixtures sighted in frame v. */
  const fixPerViewPlaced = (v: number) => [...views[v]!.groups.keys()].filter((k) => st.fix[k]).length;

  const placeCameras = (): number => {
    let added = 0;
    for (let i = 0; i < views.length; i++) {
      if (st.cams[i]) continue;
      // Seeds: each placed fixture's PnP, and the temporally nearest placed
      // camera (a handheld path is smooth — this keeps planar fixtures on the
      // right branch of their two-fold PnP ambiguity). Refined on the union of
      // every placed fixture sighted in the frame.
      const seeds: Pose[] = [];
      const corrs: Correspondence[] = [];
      for (const [k, g] of views[i]!.groups) {
        const f = st.fix[k];
        if (!f) continue;
        const p = pnp[i]![k];
        if (p) seeds.push(camToPose(camFromFix(f, p)));
        for (const o of g) corrs.push({ xyz: add(scl(mv(f.R, o.X), f.s), f.t), u: o.u, v: o.v });
      }
      if (corrs.length < opt.minPnp) continue;
      for (let dt = 1; dt <= 3; dt++) {
        const nb = st.cams[i - dt] ?? st.cams[i + dt];
        if (nb) {
          seeds.push(camToPose(nb));
          break;
        }
      }
      const popts = {
        inlierPx: 8,
        minInliers: Math.max(opt.minPnp, Math.ceil(0.6 * corrs.length)),
        maxRmsPx: 5,
      };
      let best: ReturnType<typeof estimatePose> = null;
      for (const seed of seeds) {
        const r = estimatePose(corrs, views[i]!.K, { ...popts, seed, refineOnly: true });
        if (r && (!best || r.inliers > best.inliers || (r.inliers === best.inliers && r.rmsPx < best.rmsPx))) best = r;
      }
      if (!best || !best.ok) best = estimatePose(corrs, views[i]!.K, popts);
      if (best && best.ok) {
        st.cams[i] = poseToStd(best.pose);
        added++;
      }
    }
    return added;
  };

  for (let round = 0; round < 3 * F + 2; round++) {
    let progress = placeCameras();
    // Place the unplaced fixture with the most sightings in placed cameras.
    const pending = fixtures
      .map((_, k) => k)
      .filter((k) => !st.fix[k])
      .map((k) => ({ k, n: obsByFix[k]!.filter((o) => st.cams[o.view]).length }))
      .filter((x) => x.n >= opt.minGroup)
      .sort((a, b) => b.n - a.n);
    for (const { k } of pending) {
      if (placeFixture(k)) {
        progress++;
        break; // re-extend cameras before the next fixture
      }
    }
    if (progress === 0) break;
  }

  // -- 4. Re-express in the reference frame ----------------------------------
  if (anchor !== reference && st.fix[reference]) {
    const r = st.fix[reference]!;
    const Rt = mT(r.R);
    const inv = (P: Vec3): Vec3 => scl(mv(Rt, sub(P, r.t)), 1 / r.s);
    st.fix = st.fix.map((f) => (f ? { R: mm(Rt, f.R), t: inv(f.t), s: f.s / r.s } : null));
    st.cams = st.cams.map((c) => {
      if (!c) return null;
      // Camera centre/orientation in the new frame (rigid camera; scale on positions).
      const cRoom = scl(mv(mT(c.R), c.t), -1);
      const cNew = inv(cRoom);
      const R = mm(c.R, r.R);
      return { R, t: scl(mv(R, cNew), -1) };
    });
  } else if (anchor !== reference) {
    warnings.push(`reference fixture "${fixtures[reference]!.name ?? fixtures[reference]!.id}" could not be placed`);
  }
  const refPlaced = st.fix[reference] !== null;
  const gauge = refPlaced ? reference : anchor;
  const U: Vec3 = fixtures[gauge]!.up ? unit(fixtures[gauge]!.up!) : [0, 1, 0];

  // -- 5. Joint bundle adjustment -------------------------------------------
  const placed = fixtures.map((_, k) => st.fix[k] !== null);
  const baObs = obs.filter((o) => placed[o.fixture] && st.cams[o.view]);
  // Only frames that see >= 2 placed fixtures constrain relative poses.
  const fixPerView = views.map((v) => [...v.groups.keys()].filter((k) => placed[k]).length);
  const jointObs = baObs.filter((o) => fixPerView[o.view]! >= 2);
  const freeFix = fixtures.map((_, k) => k).filter((k) => placed[k] && k !== gauge);
  const priors: Priors = { scaleSigma, up: ups, U, tiltSigma: opt.tiltSigma };
  const mkCfg = (huber: number): BAConfig => ({
    obs: jointObs,
    views,
    freeCams: new Set(jointObs.map((o) => o.view)),
    freeFix,
    solveScale,
    priors,
    huber,
    iters: opt.iters,
  });
  let ba = bundleAdjust(st, mkCfg(opt.huber));
  // Outlier gate: robust σ̂ from the MAD of the reprojection errors.
  let iterations = ba.iterations;
  for (let pass = 0; pass < 3; pass++) {
    const errs: number[] = [];
    for (const o of jointObs) {
      const r = residual(o, views[o.view]!.K, ba.state.cams[o.view]!, ba.state.fix[o.fixture]!);
      errs.push(r === null ? Infinity : Math.hypot(r.ru, r.rv));
    }
    const sorted = errs.filter(Number.isFinite).sort((a, b) => a - b);
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
    const gate = Math.max(opt.outlierPx, 4 * 1.4826 * med);
    // A (frame, fixture) group that mostly disagrees is a wrong camera/branch for
    // that frame, not a few bad pixels: drop the whole group.
    const grp = new Map<string, { n: number; inl: number }>();
    jointObs.forEach((o, i) => {
      const key = `${o.view}:${o.fixture}`;
      const g = grp.get(key) ?? { n: 0, inl: 0 };
      g.n++;
      if (errs[i]! <= gate) g.inl++;
      grp.set(key, g);
    });
    let changed = 0;
    jointObs.forEach((o, i) => {
      const g = grp.get(`${o.view}:${o.fixture}`)!;
      const out = !(errs[i]! <= gate) || g.inl < 0.5 * g.n;
      if (out !== o.outlier) changed++;
      o.outlier = out;
    });
    if (changed === 0) break;
    ba = bundleAdjust(ba.state, mkCfg(opt.huber));
    iterations += ba.iterations;
  }
  st = ba.state;

  // -- 6. Statistics + covariance ---------------------------------------------
  const perFix = fixtures.map(() => ({ n: 0, inl: 0, sse: 0, viewSet: new Set<number>(), ledViews: new Map<number, number>() }));
  let totN = 0, totInl = 0, totSse = 0;
  for (const o of jointObs) {
    const p = perFix[o.fixture]!;
    p.n++;
    totN++;
    if (o.outlier) continue;
    const r = residual(o, views[o.view]!.K, st.cams[o.view]!, st.fix[o.fixture]!);
    if (r === null) continue;
    const e2 = r.ru * r.ru + r.rv * r.rv;
    p.inl++;
    p.sse += e2;
    p.viewSet.add(o.view);
    p.ledViews.set(o.led, (p.ledViews.get(o.led) ?? 0) + 1);
    totInl++;
    totSse += e2;
  }
  const covCfg = mkCfg(opt.huber);
  const acc = accumulate(st, covCfg);
  const { S } = schur(acc, 0, 1e-10);
  const Sinv = acc.dim > 0 ? invertDense(S) : null;
  const Cov = Sinv ? clusterRobustCov(st, covCfg, acc, Sinv) : null;

  // -- 7. Leveling: rotate the solve frame's up (U) onto +Y ------------------
  const L = alignVectors(U, [0, 1, 0]);
  const levelFix = (f: Fix): Fix => ({ R: mm(L, f.R), t: mv(L, f.t), s: f.s });

  const results: FixtureLocalization[] = fixtures.map((fx, k) => {
    const f = st.fix[k];
    const p = perFix[k]!;
    const name = fx.name ?? fx.id;
    const w: string[] = [];
    const coViews = [...p.viewSet].filter((i) => fixPerView[i]! >= 2).length;
    let sigma: FixtureLocalization["sigma"] = null;
    const o = acc.off.get(k);
    if (f && o !== undefined && Cov) {
      const C = (i: number, j: number) => Cov[o + i]![o + j]!;
      const rot = Math.sqrt(Math.max(0, C(0, 0) + C(1, 1) + C(2, 2)));
      const tr = Math.sqrt(Math.max(0, C(3, 3) + C(4, 4) + C(5, 5)));
      const sc = acc.d === 7 ? Math.sqrt(Math.max(0, C(6, 6))) : 0;
      // Predicted LED position σ: J = [-[sRX]x | I | sRX] per LED.
      let led2 = 0;
      let nl = 0;
      for (const X of fx.leds.values()) {
        const q = scl(mv(f.R, X), f.s);
        const J = [
          [0, q[2], -q[1], 1, 0, 0, q[0]],
          [-q[2], 0, q[0], 0, 1, 0, q[1]],
          [q[1], -q[0], 0, 0, 0, 1, q[2]],
        ];
        for (let r = 0; r < 3; r++)
          for (let i = 0; i < acc.d; i++) for (let j = 0; j < acc.d; j++) led2 += J[r]![i]! * C(i, j) * J[r]![j]!;
        nl++;
      }
      sigma = {
        translationM: tr,
        rotationDeg: (rot * 180) / Math.PI,
        scale: sc,
        ledM: Math.sqrt(led2 / Math.max(1, nl)),
      };
    }
    const lf = f ? levelFix(f) : null;
    const up = ups[k];
    const tiltDeg = f && up ? (Math.acos(Math.max(-1, Math.min(1, dot(mv(f.R, up), U)))) * 180) / Math.PI : null;
    // A straight strip is placed by triangulating its line: every camera centre
    // and the line span a plane, and if those planes all coincide (camera moved
    // only along the strip's own plane) its depth is barely constrained.
    let lineSpreadDeg: number | null = null;
    if (f && shapes[k]!.linear && k !== gauge) {
      const axis = unit(mv(f.R, shapes[k]!.axis));
      const c0 = add(scl(mv(f.R, shapes[k]!.centroid), f.s), f.t);
      const ns: Vec3[] = [];
      for (const i of p.viewSet) {
        const c = st.cams[i];
        if (!c) continue;
        const n = cross(axis, sub(scl(mv(mT(c.R), c.t), -1), c0));
        if (norm(n) > 1e-9) ns.push(unit(n));
      }
      let spread = 0;
      for (const n of ns) for (const m of ns) spread = Math.max(spread, Math.acos(Math.min(1, Math.abs(dot(n, m)))));
      lineSpreadDeg = (spread * 180) / Math.PI;
    }
    const lineWeak = lineSpreadDeg !== null && lineSpreadDeg < 20;
    let status: FixtureStatus;
    if (!f) status = "unlocalized";
    else if (k === gauge) status = "reference";
    else if (lineWeak || coViews < 3 || (sigma !== null && (sigma.ledM > 0.05 || (!shapes[k]!.linear && sigma.rotationDeg > 5))))
      status = "weak";
    else status = "localized";

    if (!f) {
      if (framesSeen[k] === 0 && p.n === 0)
        w.push(`${name} was never decoded — check it is flashing and in view`);
      else w.push(`${name} was never seen in the same frame as an already-placed fixture`);
    } else if (k !== gauge) {
      if (coViews < 3) w.push(`${name}: only ${coViews} shared frame(s) — capture more with it and a neighbour in view`);
      if (sigma && sigma.ledM > 0.05) w.push(`${name}: position uncertain (±${(sigma.ledM * 100).toFixed(0)} cm)`);
      if (sigma && !shapes[k]!.linear && sigma.rotationDeg > 5)
        w.push(`${name}: orientation uncertain (±${sigma.rotationDeg.toFixed(0)}°)`);
      const ss = scaleSigma[k]!;
      if (solveScale && sigma && Math.abs(f.s - 1) > Math.max(0.03, 3 * sigma.scale))
        w.push(`${name}: its map's scale differs by ${((f.s - 1) * 100).toFixed(1)} % from the reference's — consider re-mapping`);
      if (solveScale && sigma && Number.isFinite(ss) && ss > 0 && sigma.scale > 0.8 * ss)
        w.push(`${name}: relative scale not observable from this capture (move the phone more); kept near its map's scale`);
      if (lineWeak)
        w.push(
          `${name}: a straight strip seen from only ${lineSpreadDeg!.toFixed(0)}° of viewpoints across it — ` +
            "move the phone up and down (across the strip) to pin its depth",
        );
      if (tiltDeg !== null && tiltDeg > 10 && !shapes[k]!.linear)
        w.push(`${name}: tilted ${tiltDeg.toFixed(0)}° from its map's level — was it moved or tilted since mapping?`);
    }
    if (p.inl > 0 && Math.sqrt(p.sse / p.inl) > 3) w.push(`${name}: high reprojection error — its map may be stale`);
    return {
      index: k,
      id: fx.id,
      status,
      pose: lf ? fixToRoomPose(lf) : null,
      views: p.viewSet.size,
      coViews,
      framesSeen: framesSeen[k]!,
      ledsSeen: ledsSeenSets[k]!.size,
      observations: p.n,
      inliers: p.inl,
      rmsPx: p.inl ? Math.sqrt(p.sse / p.inl) : 0,
      sigma,
      tiltDeg,
      linear: shapes[k]!.linear,
      warnings: w,
    };
  });

  const leveling = fixtures[gauge]!.up ? "reference_up" : "assumed_y_up";
  if (leveling === "assumed_y_up")
    warnings.push("the reference fixture has no known gravity direction; assuming its map's +Y is up");
  if (gauge !== reference) warnings.push("solved relative to another fixture because the reference could not be placed");

  const cameras = views
    .map((v, i) => ({ v, c: st.cams[i], i }))
    .filter((x) => x.c && fixPerView[x.i]! >= 2)
    .map(({ v, c }) => {
      const cRoom = mv(L, scl(mv(mT(c!.R), c!.t), -1));
      const R = mm(c!.R, mT(L));
      return { t: v.t, pose: camToPose({ R, t: scl(mv(R, cRoom), -1) }) };
    });

  return {
    ok: results.every((r) => r.status !== "unlocalized"),
    reference: gauge,
    fixtures: results,
    cameras,
    rmsPx: totInl ? Math.sqrt(totSse / totInl) : 0,
    observations: totN,
    inliers: totInl,
    multiViews,
    leveling,
    warnings,
  };
}

/** Rotation / translation / LED-position error between two room poses of the
 * same fixture map (for tests + the app's "how much did it move" readout). */
export function poseError(
  a: RoomPose,
  b: RoomPose,
  leds: Iterable<Vec3>,
): { rotDeg: number; transM: number; ledRmsM: number; scaleRel: number } {
  const Ra = quatToRotMat(a.rotation), Rb = quatToRotMat(b.rotation);
  let s2 = 0, n = 0;
  for (const x of leds) {
    const d = sub(applyRoomPose(a, x), applyRoomPose(b, x));
    s2 += dot(d, d);
    n++;
  }
  return {
    rotDeg: (rotAngle(mm(mT(Ra), Rb)) * 180) / Math.PI,
    transM: norm(sub(a.translation, b.translation)),
    ledRmsM: n ? Math.sqrt(s2 / n) : 0,
    scaleRel: b.scale / a.scale - 1,
  };
}

/** Compose a manual nudge onto a room pose: rotate by `yaw/pitch/roll` degrees
 * about the fixture's own room-frame centroid (`pivot`), then translate. Used by
 * the app's manual-alignment controls. */
export function nudgeRoomPose(
  p: RoomPose,
  d: { dx?: number; dy?: number; dz?: number; yawDeg?: number; pitchDeg?: number; rollDeg?: number },
  pivot: Vec3,
): RoomPose {
  const deg = Math.PI / 180;
  const Rd = mm(
    expSO3([0, (d.yawDeg ?? 0) * deg, 0]),
    mm(expSO3([(d.pitchDeg ?? 0) * deg, 0, 0]), expSO3([0, 0, (d.rollDeg ?? 0) * deg])),
  );
  const R = orthonormalize(mm(Rd, quatToRotMat(p.rotation)));
  // Rotate about the pivot: t' = pivot + Rd (t - pivot).
  const t = add(add(pivot, mv(Rd, sub(p.translation, pivot))), [d.dx ?? 0, d.dy ?? 0, d.dz ?? 0]);
  const q = rotMatToQuat(R);
  return { translation: t, rotation: q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q, scale: p.scale };
}

/** a ∘ b (apply b, then a): p ↦ a(b(p)). */
export function composeRoomPose(a: RoomPose, b: RoomPose): RoomPose {
  const Ra = quatToRotMat(a.rotation), Rb = quatToRotMat(b.rotation);
  const R = mm(Ra, Rb);
  const q = rotMatToQuat(R);
  return {
    translation: add(a.translation, scl(mv(Ra, b.translation), a.scale)),
    rotation: q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q,
    scale: a.scale * b.scale,
  };
}

/** a⁻¹. */
export function invertRoomPose(a: RoomPose): RoomPose {
  const Rt = mT(quatToRotMat(a.rotation));
  const q = rotMatToQuat(Rt);
  return {
    translation: scl(mv(Rt, a.translation), -1 / a.scale),
    rotation: q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q,
    scale: 1 / a.scale,
  };
}
