/**
 * FUG-112 — fuse a supplemental scan into an existing map.
 *
 * Two sources of new evidence, best first:
 *
 *  1. **Joint re-solve** (`opts.joint`): the base capture's raw observations and
 *     the supplemental session's, concatenated on one timeline
 *     (concatObservations) and solved together. Every low-confidence base LED
 *     then gets a genuinely NEW solution from base + supplemental measurements
 *     accumulated in one bundle adjustment. This needs a solver that keeps every
 *     stretch of an interrupted timeline (splanc#250 removed the time-gap
 *     segment filter that kept only the "dominant" arc); with the old filter the
 *     joint solve silently drops one session, which validateJoint detects (the
 *     LEDs only one session saw go missing) and we fall back to (2).
 *  2. **Registered estimate fusion** (the supplemental session solved alone):
 *     still a fusion of both captures' evidence, but at the estimate level —
 *     each re-seen low-confidence LED's two position estimates are combined by
 *     inverse-variance weighting (geom/ledVariance σ model).
 *
 * Either source is in its own gauge, so it is first REGISTERED into the prior
 * map's frame by a robust similarity fit anchored on the prior's WELL-SOLVED
 * LEDs (confidence ≥ anchorConfidence) that the new solve also resolved. Then,
 * per LED:
 *
 *   - well-solved base LED  → stays anchored at its base position (corroborated
 *                             by agreeing re-observations; a disagreement is a
 *                             conflict and the anchor wins);
 *   - low-confidence base LED re-observed → NEW position (joint solution, or the
 *                             inverse-variance fused estimate) — "updated";
 *   - LED the base lacked   → added at its registered position — "scan";
 *   - base LED not re-seen  → unchanged — "base".
 *
 * The registration is also the honest "did the phone reacquire absolute pose?"
 * check: too few common LEDs, or a high post-fit residual (the fixture's
 * gravity-relative transform changed between scans), means the new scan could
 * not be registered — the caller surfaces that and lets the user reject it.
 */

import type { DetectionRecord, ImuSample, LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { applySimilarity, fitSimilarity, type Similarity } from "./fit";
import { ledSigmaM, mapSigmaContext } from "./ledVariance";

/** Where an LED's current position came from, relative to the base map. */
export type Provenance = "base" | "scan" | "updated";

/** Prior LEDs at/above this confidence are "well-solved": they anchor the
 * registration and keep their position. Below it they are re-solved. */
export const ANCHOR_CONFIDENCE = 0.75;

export interface FuseOptions {
  /** Minimum LEDs common to both scans to attempt registration (default 4). */
  minCommon?: number;
  /** Max post-fit RMS (as a fraction of the prior fixture's radius) to accept
   * the registration (default 0.08 = 8%). */
  maxRmsFrac?: number;
  /** Well-solved threshold (default ANCHOR_CONFIDENCE). */
  anchorConfidence?: number;
  /** The joint (base + supplemental observations) re-solve, when one ran. */
  joint?: OutputMap | null;
  /** LED ids the supplemental session decoded (from its raw detections) — lets
   * validateJoint check the joint solve really used them even when the
   * standalone supplemental solve failed. */
  observedIds?: ReadonlySet<number>;
}

export interface FusionReport {
  /** The new scan registered into the prior frame within tolerance. */
  registered: boolean;
  /** "joint" = low-confidence LEDs re-solved from base+supplemental
   * observations; "registered" = estimate-level fusion of the separate solve. */
  method: "joint" | "registered";
  /** Why a supplied joint re-solve was not used (null when it was, or none was
   * supplied). */
  jointRejected: string | null;
  /** LEDs resolved by both scans. */
  common: number;
  /** Of those, the well-solved anchors the registration was fitted on. */
  anchors: number;
  /** RMS of the agreeing fit LEDs after registration, meters. */
  rmsM: number;
  /** LEDs present after fusion that the prior map lacked. */
  added: number;
  /** Re-seen LEDs whose confidence rose. */
  improved: number;
  /** Low-confidence base LEDs that received a new position. */
  resolved: number;
  /** Common LEDs whose two positions disagreed past tolerance. */
  conflicts: number;
  /** Human-readable one-liner for the review UI. */
  summary: string;
}

export interface FusionResult {
  map: OutputMap;
  report: FusionReport;
  /** Per-LED provenance of `map` (every LED in `map.leds` has an entry). */
  provenance: Map<number, Provenance>;
}

function radiusOf(leds: readonly LedEntry[]): number {
  if (leds.length === 0) return 1;
  let cx = 0, cy = 0, cz = 0;
  for (const l of leds) {
    cx += l.xyz[0];
    cy += l.xyz[1];
    cz += l.xyz[2];
  }
  cx /= leds.length;
  cy /= leds.length;
  cz /= leds.length;
  let r = 1e-6;
  for (const l of leds) r = Math.max(r, Math.hypot(l.xyz[0] - cx, l.xyz[1] - cy, l.xyz[2] - cz));
  return r;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * How far a point set is from collinear: √(λ₂/λ₁) of its scatter matrix (0 = a
 * line, 1 = isotropic in its two widest directions). A similarity fitted to a
 * (near-)collinear set leaves the rotation about that line unconstrained —
 * extrapolated across the fixture, a sub-mm residual on the fit LEDs can hide
 * decimetres of error elsewhere. Closed-form symmetric 3×3 eigenvalues.
 */
export function spreadRatio(pts: readonly Vec3[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  const mu: Vec3 = [0, 0, 0];
  for (const p of pts) for (let k = 0; k < 3; k++) mu[k] = mu[k]! + p[k]! / n;
  let a = 0, b = 0, c = 0, d = 0, e = 0, f = 0; // xx yy zz xy xz yz
  for (const p of pts) {
    const x = p[0] - mu[0], y = p[1] - mu[1], z = p[2] - mu[2];
    a += x * x;
    b += y * y;
    c += z * z;
    d += x * y;
    e += x * z;
    f += y * z;
  }
  const p1 = d * d + e * e + f * f;
  const q = (a + b + c) / 3;
  const p2 = (a - q) ** 2 + (b - q) ** 2 + (c - q) ** 2 + 2 * p1;
  if (p2 < 1e-30) return 1; // isotropic (or a single point, caught above)
  const p = Math.sqrt(p2 / 6);
  // B = (A − qI)/p; r = det(B)/2.
  const [ba, bb, bc, bd, be, bf] = [(a - q) / p, (b - q) / p, (c - q) / p, d / p, e / p, f / p];
  const r = (ba * (bb * bc - bf * bf) - bd * (bd * bc - bf * be) + be * (bd * bf - bb * be)) / 2;
  const phi = Math.acos(Math.min(1, Math.max(-1, r))) / 3;
  const l1 = q + 2 * p * Math.cos(phi);
  const l3 = q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3);
  const l2 = 3 * q - l1 - l3;
  return l1 > 0 ? Math.sqrt(Math.max(0, l2) / l1) : 0;
}

/** Below this spreadRatio a fit set counts as collinear. */
const MIN_SPREAD = 0.1;

export interface Registration {
  ok: boolean;
  sim: Similarity | null;
  common: number;
  anchors: number;
  rmsM: number;
  /** Agreement tolerance used (meters, prior frame). */
  tolM: number;
  /** Failure reason when !ok. */
  reason: string;
}

/**
 * Robustly register `addition` into `prior`'s frame. The fit uses the common
 * LEDs that are well-solved in the prior (falling back to every common LED when
 * there are too few anchors — a map that is low-confidence everywhere can still
 * be supplemented), with one outlier-rejecting refit.
 */
export function registerInto(
  prior: OutputMap,
  addition: OutputMap,
  opts: Pick<FuseOptions, "minCommon" | "maxRmsFrac" | "anchorConfidence"> = {},
): Registration {
  const minCommon = opts.minCommon ?? 4;
  const maxRmsFrac = opts.maxRmsFrac ?? 0.08;
  const anchorConf = opts.anchorConfidence ?? ANCHOR_CONFIDENCE;
  const priorById = new Map(prior.leds.map((l) => [l.id, l]));
  const common: { a: Vec3; p: Vec3; anchor: boolean }[] = [];
  for (const a of addition.leds) {
    const p = priorById.get(a.id);
    if (p) common.push({ a: a.xyz, p: p.xyz, anchor: p.confidence >= anchorConf });
  }
  const tolM = maxRmsFrac * radiusOf(prior.leds);
  const fail = (reason: string, anchors: number, rmsM = Infinity): Registration => ({
    ok: false,
    sim: null,
    common: common.length,
    anchors,
    rmsM,
    tolM,
    reason,
  });
  if (common.length < minCommon) {
    return fail(
      `Only ${common.length} LED${common.length === 1 ? "" : "s"} seen in both scans — need ${minCommon} to register.`,
      0,
    );
  }
  // Fit on the well-solved anchors when there are enough of them AND they span
  // more than a line; otherwise every common LED (a weak LED's few-mm error is
  // far better than an unconstrained rotation about the anchor line).
  // (A fixture that is itself a straight line — a bar — is exempt: the free
  // rotation then moves nothing.)
  const lineFixture = spreadRatio(prior.leds.map((l) => l.xyz)) < MIN_SPREAD;
  const wellSpread = (set: typeof common): boolean => lineFixture || spreadRatio(set.map((c) => c.p)) >= MIN_SPREAD;
  const anchorSet = common.filter((c) => c.anchor);
  const fitSet = anchorSet.length >= minCommon && wellSpread(anchorSet) ? anchorSet : common;
  if (!wellSpread(fitSet)) {
    return fail("The overlapping LEDs are nearly collinear — scan more of the fixture to register.", fitSet.length);
  }
  const src = fitSet.map((c) => c.a);
  const dst = fitSet.map((c) => c.p);
  let sim = fitSimilarity(src, dst);
  if (sim === null) return fail("The overlapping LEDs are degenerate — could not register.", fitSet.length);

  // One robust refit: a few mismatched LEDs (a decode swap, or a genuinely
  // moved LED) would otherwise skew the least-squares fit and its residual.
  const resid0 = src.map((s, i) => dist(applySimilarity(sim!, s), dst[i]!));
  const cut = Math.max(tolM, 3 * median(resid0));
  const inl: number[] = [];
  for (let i = 0; i < src.length; i++) if (resid0[i]! <= cut) inl.push(i);
  if (inl.length >= Math.max(3, minCommon) && inl.length < src.length) {
    const s2 = fitSimilarity(inl.map((i) => src[i]!), inl.map((i) => dst[i]!));
    if (s2 !== null) sim = s2;
  }

  // Acceptance is decided over the fit LEDs that agree under the final fit.
  const resid = src.map((s, i) => dist(applySimilarity(sim!, s), dst[i]!));
  const agree = resid.filter((r) => r <= tolM);
  if (agree.length < minCommon) {
    const rough = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / resid.length);
    return fail(
      `Only ${agree.length}/${src.length} overlapping LEDs line up — the fixture may have moved.`,
      fitSet.length,
      rough,
    );
  }
  const rmsM = Math.sqrt(agree.reduce((a, r) => a + r * r, 0) / agree.length);
  return { ok: true, sim, common: common.length, anchors: fitSet.length, rmsM, tolM, reason: "" };
}

/**
 * Does a joint re-solve really contain both captures? A solver that keeps only
 * the dominant arc of an interrupted timeline returns ONE session's LEDs: the
 * LEDs only the other session resolved go missing. Require (almost) every LED
 * that either separate solve resolved to be present. Returns the rejection
 * reason, or null when the joint solve is usable.
 */
export function validateJoint(
  prior: OutputMap,
  supplement: OutputMap | null,
  joint: OutputMap,
  opts: { observedIds?: ReadonlySet<number>; anchorConfidence?: number } = {},
): string | null {
  const jointById = new Map(joint.leds.map((l) => [l.id, l]));
  const missing = (m: OutputMap): number => m.leds.filter((l) => !jointById.has(l.id)).length;
  const check = (m: OutputMap, what: string): string | null => {
    const miss = missing(m);
    // Tolerate a stray LED or two the joint outlier rejection legitimately
    // drops; a dropped session loses a block of them.
    return miss > Math.max(1, Math.floor(0.1 * m.leds.length))
      ? `the joint re-solve lost ${miss} of the ${what}'s ${m.leds.length} LEDs`
      : null;
  };
  const coverage = check(prior, "base map") ?? (supplement ? check(supplement, "new scan") : null);
  if (coverage !== null) return coverage;
  // Coverage can't see a dropped session whose LEDs are a subset of the other's
  // (a short supplemental pass over a few weak LEDs, dropped in favour of the
  // long base arc). Then the joint solve is just the base solve again — so the
  // weak base LEDs the supplement observed gained no views. Require that most
  // of them did.
  const anchorConf = opts.anchorConfidence ?? ANCHOR_CONFIDENCE;
  const seen = (id: number): boolean =>
    opts.observedIds ? opts.observedIds.has(id) : (supplement?.leds.some((l) => l.id === id) ?? false);
  const weak = prior.leds.filter((l) => l.confidence < anchorConf && seen(l.id));
  if (weak.length > 0) {
    const gained = weak.filter((l) => (jointById.get(l.id)?.nViews ?? 0) > l.nViews).length;
    if (2 * gained < weak.length) {
      return `the joint re-solve gained no new views on ${weak.length - gained} of the ${weak.length} low-confidence LEDs the new scan saw — the solver kept only one capture`;
    }
  }
  return null;
}

/**
 * Register the supplemental evidence into `prior`'s frame and merge (see the
 * module comment). `addition` is the supplemental session solved on its own;
 * `opts.joint`, when given and valid, is preferred as the source of new
 * positions. When registration fails the returned map is the prior unchanged
 * and `report.registered` is false. Never mutates its inputs.
 */
export function fuseMaps(prior: OutputMap, addition: OutputMap | null, opts: FuseOptions = {}): FusionResult {
  const anchorConf = opts.anchorConfidence ?? ANCHOR_CONFIDENCE;

  // Pick the evidence source: the joint re-solve when it holds both sessions
  // and registers, else the supplemental solve.
  let source: OutputMap | null = addition;
  let method: "joint" | "registered" = "registered";
  let jointRejected: string | null = null;
  let reg: Registration | null = null;
  if (opts.joint) {
    jointRejected = validateJoint(prior, addition, opts.joint, opts);
    if (jointRejected === null) {
      const r = registerInto(prior, opts.joint, opts);
      if (r.ok) {
        source = opts.joint;
        method = "joint";
        reg = r;
      } else {
        jointRejected = `the joint re-solve did not register (${r.reason})`;
      }
    }
  }
  const baseProvenance = (): Map<number, Provenance> => new Map(prior.leds.map((l) => [l.id, "base"]));
  if (source === null) {
    return {
      map: prior,
      provenance: baseProvenance(),
      report: {
        registered: false,
        method,
        jointRejected,
        common: 0,
        anchors: 0,
        rmsM: Infinity,
        added: 0,
        improved: 0,
        resolved: 0,
        conflicts: 0,
        summary: "No new LEDs were solved in this scan.",
      },
    };
  }
  reg ??= registerInto(prior, source, opts);
  if (!reg.ok || reg.sim === null) {
    return {
      map: prior,
      provenance: baseProvenance(),
      report: {
        registered: false,
        method,
        jointRejected,
        common: reg.common,
        anchors: reg.anchors,
        rmsM: reg.rmsM,
        added: 0,
        improved: 0,
        resolved: 0,
        conflicts: 0,
        summary: reg.reason,
      },
    };
  }
  const sim = reg.sim;
  const agreeTol = reg.tolM;
  const priorById = new Map(prior.leds.map((l) => [l.id, l]));
  const priorCtx = mapSigmaContext(prior);
  const srcCtx = mapSigmaContext(source);

  const merged = new Map<number, LedEntry>(priorById);
  const provenance = baseProvenance();
  let added = 0;
  let improved = 0;
  let resolved = 0;
  let conflicts = 0;

  for (const a of source.leds) {
    const id = a.id;
    const xyzReg = applySimilarity(sim, a.xyz);
    const p = priorById.get(id);
    if (!p) {
      // New LED: extends coverage. Registered position, carried statistics.
      merged.set(id, { ...a, id, xyz: xyzReg });
      provenance.set(id, "scan");
      added++;
      continue;
    }
    const agrees = dist(p.xyz, xyzReg) <= agreeTol;
    const wellSolved = p.confidence >= anchorConf;

    if (wellSolved) {
      // Anchor: keeps its base position. Agreement corroborates; disagreement is
      // a conflict the anchor wins (no boost for it).
      if (!agrees) {
        conflicts++;
        merged.set(id, { ...p, confidence: p.confidence * 0.9 });
        continue;
      }
      const confidence =
        method === "joint"
          ? Math.max(p.confidence, a.confidence) // joint already counts the base rays
          : Math.min(1, 1 - (1 - p.confidence) * (1 - a.confidence));
      merged.set(id, {
        ...p,
        confidence,
        nViews: method === "joint" ? Math.max(p.nViews, a.nViews) : p.nViews + a.nViews,
        rmsReprojPx: Math.min(p.rmsReprojPx, a.rmsReprojPx),
        parallaxDeg: Math.max(p.parallaxDeg, a.parallaxDeg),
      });
      if (confidence > p.confidence + 1e-6) improved++;
      continue;
    }

    // Low-confidence base LED re-observed: give it a new solution.
    if (method === "joint") {
      // The joint bundle adjustment solved this LED from base + supplemental
      // rays together: take its (registered) position and statistics outright.
      merged.set(id, { ...a, id, xyz: xyzReg });
    } else if (agrees) {
      // Two independent estimates of the same point: inverse-variance fusion.
      // σ of the addition is scaled into the prior frame by the fit's scale.
      const sp = ledSigmaM(p, priorCtx);
      const sa = ledSigmaM(a, srcCtx) * sim.c;
      const wp = 1 / Math.max(1e-12, sp * sp);
      const wa = 1 / Math.max(1e-12, sa * sa);
      const xyz: Vec3 = [
        (wp * p.xyz[0] + wa * xyzReg[0]) / (wp + wa),
        (wp * p.xyz[1] + wa * xyzReg[1]) / (wp + wa),
        (wp * p.xyz[2] + wa * xyzReg[2]) / (wp + wa),
      ];
      merged.set(id, {
        id,
        xyz,
        confidence: Math.min(1, 1 - (1 - p.confidence) * (1 - a.confidence)),
        nViews: p.nViews + a.nViews,
        rmsReprojPx: Math.min(p.rmsReprojPx, a.rmsReprojPx),
        parallaxDeg: Math.max(p.parallaxDeg, a.parallaxDeg),
      });
    } else {
      // Disagreement on a weak base LED: defer to the stronger observation,
      // without rewarding the disagreement.
      conflicts++;
      if (a.confidence > p.confidence) {
        merged.set(id, { ...a, id, xyz: xyzReg, confidence: a.confidence * 0.9 });
      } else {
        merged.set(id, { ...p, confidence: p.confidence * 0.9 });
        continue; // the base value stood
      }
    }
    provenance.set(id, "updated");
    resolved++;
    if (merged.get(id)!.confidence > p.confidence + 1e-6) improved++;
  }

  const leds = [...merged.values()].sort((a, b) => a.id - b.id);
  const mappedIds = new Set(leds.map((l) => l.id));
  const unmapped = [...new Set([...prior.unmapped, ...(addition?.unmapped ?? []), ...source.unmapped])]
    .filter((id) => !mappedIds.has(id))
    .sort((a, b) => a - b);

  const map: OutputMap = {
    ...prior,
    ledCount: Math.max(prior.ledCount, source.ledCount, addition?.ledCount ?? 0),
    leds,
    unmapped,
    stats: {
      rmsReprojPxGlobal:
        method === "joint"
          ? source.stats.rmsReprojPxGlobal
          : Math.max(prior.stats.rmsReprojPxGlobal, source.stats.rmsReprojPxGlobal),
      medianParallaxDeg: Math.max(prior.stats.medianParallaxDeg, source.stats.medianParallaxDeg),
    },
  };

  const how = method === "joint" ? "re-solved from both captures" : "fused with the new scan";
  const summary =
    `Registered on ${reg.anchors} LEDs (${(reg.rmsM * 1000).toFixed(reg.rmsM < 0.01 ? 1 : 0)} mm). ` +
    `+${added} new, ${resolved} low-confidence ${how}, ${improved} improved` +
    (conflicts > 0 ? `, ${conflicts} conflicting.` : ".");
  return {
    map,
    provenance,
    report: {
      registered: true,
      method,
      jointRejected,
      common: reg.common,
      anchors: reg.anchors,
      rmsM: reg.rmsM,
      added,
      improved,
      resolved,
      conflicts,
      summary,
    },
  };
}

/** Observations of one capture session (structurally mapStore's
 * CaptureObservations). */
export interface SessionObservations {
  detections: DetectionRecord[];
  imu: ImuSample[];
  ledCount: number;
}

/** Idle gap inserted between concatenated sessions (ms). Comfortably longer
 * than the solver's IMU-hole threshold, so no inertial factor bridges the two
 * sessions — they are linked only through the LEDs they share. */
export const SESSION_GAP_MS = 5000;

function timeSpan(o: Pick<SessionObservations, "detections" | "imu">): { t0: number; t1: number } | null {
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const d of o.detections) {
    t0 = Math.min(t0, d.tCaptureMs);
    t1 = Math.max(t1, d.tCaptureMs);
  }
  for (const s of o.imu) {
    t0 = Math.min(t0, s.t);
    t1 = Math.max(t1, s.t);
  }
  return Number.isFinite(t0) ? { t0, t1 } : null;
}

/**
 * Append session `add` after `base` on ONE monotonic timeline. Each session's
 * timestamps are its own phone-monotonic clock (which restarts on reload), so
 * a plain concat can interleave two sessions' frames into nonsense; `add` is
 * shifted (detections and IMU by the same offset, preserving its internal
 * sync) to start SESSION_GAP_MS after `base` ends. Never mutates its inputs.
 */
export function concatObservations(
  base: SessionObservations,
  add: Pick<SessionObservations, "detections" | "imu">,
  gapMs: number = SESSION_GAP_MS,
): SessionObservations {
  const b = timeSpan(base);
  const a = timeSpan(add);
  const shift = b !== null && a !== null ? b.t1 + gapMs - a.t0 : 0;
  return {
    detections: base.detections.concat(add.detections.map((d) => ({ ...d, tCaptureMs: d.tCaptureMs + shift }))),
    imu: base.imu.concat(add.imu.map((s) => ({ ...s, t: s.t + shift }))),
    ledCount: base.ledCount,
  };
}
