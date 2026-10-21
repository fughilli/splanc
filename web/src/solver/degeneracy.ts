/**
 * Degenerate-solve detection + the final-vs-preview check (docs/design/
 * mapping-solve-paths.md).
 *
 * The wasm solver assesses its own output (solver/src/diag.rs, returned as
 * `diag.assessment`); `assessMap` here is the same verdict computed from an
 * OutputMap alone, for solves that come without one (the host solver's maps,
 * an older wasm). The reasons and thresholds are identical:
 *
 *   non-finite      a NaN/∞ in an LED position, the residual or the trajectory
 *   too-few-leds    < 4 measured LEDs, or < 25 % of the LEDs the capture saw
 *                   in ≥ 2 frames (when that count is known)
 *   huge-residual   global reprojection rms > 20 px (most rays miss)
 *   scale-collapse  median camera-to-fixture distance < 0.15 m, or LED spread
 *                   (rms distance from the centroid) < 2 mm
 *   scale-blowup    median camera-to-fixture distance > 30 m
 *
 * `scale-uncertain` (scale relative standard error > 0.5) is a warning only.
 *
 * `compareToPreview` then judges a final solve against the best interim
 * (live-preview) solve of the same capture, and `decideFinal` picks which map
 * the capture keeps: the final one unless it is degenerate (or failed, or
 * clearly regressed) where the preview was not — the capture then keeps the
 * preview's map and records why.
 */

import type { OutputMap, Vec3 } from "@ledmapper/protocol";

import { applySimilarity, fitSimilarity } from "../geom/fit";

export const MIN_MEASURED_LEDS = 4;
export const MIN_MEASURED_FRAC = 0.25;
export const MAX_RMS_PX = 20;
export const MIN_CAMERA_DIST_M = 0.15;
export const MAX_CAMERA_DIST_M = 30;
export const MIN_SPREAD_M = 0.002;
export const SCALE_UNCERTAIN_REL_SE = 0.5;

/** Final keeps < this fraction of the preview's measured LEDs → regression. */
export const MIN_LED_RATIO_VS_PREVIEW = 0.6;
/** Principal-axis ratio the preview had (≥) and the final lost (<): collapse. */
export const RANK_PRESENT = 0.05;
export const RANK_COLLAPSED = 0.005;
/** Final/preview LED-spread ratio outside [1/x, x] → size disagreement. */
export const SIZE_RATIO_FLAG = 2;
/** Similarity-aligned shape rms / preview spread above this → shape disagreement. */
export const SHAPE_RMS_FLAG = 0.25;

export type DegeneracyReason =
  | "non-finite"
  | "too-few-leds"
  | "huge-residual"
  | "scale-collapse"
  | "scale-blowup";

/** solver/src/diag.rs `Assessment` (serde-flattened geometry). */
export interface Assessment {
  degenerate: boolean;
  reasons: string[];
  warnings: string[];
  measured: number;
  observable: number;
  rmsPx: number;
  scaleRelStdErr: number | null;
  spreadM: number;
  /** Principal standard deviations of the LED cloud, largest first. */
  principalM: [number, number, number];
  medianCameraDistM: number | null;
}

function finite(v: readonly number[]): boolean {
  return v.every((c) => Number.isFinite(c));
}

/** Symmetric 3×3 eigenvalues (Jacobi; tiny and exact enough for a verdict). */
function eigSym3(m: number[][]): [number, number, number] {
  const a = m.map((r) => r.slice());
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p]![q]! ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p]![q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q]![q]! - a[p]![p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k]![p]!;
          const akq = a[k]![q]!;
          a[k]![p] = c * akp - s * akq;
          a[k]![q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p]![k]!;
          const aqk = a[q]![k]!;
          a[p]![k] = c * apk - s * aqk;
          a[q]![k] = s * apk + c * aqk;
        }
      }
    }
  }
  const ev = [a[0]![0]!, a[1]![1]!, a[2]![2]!].sort((x, y) => y - x);
  return [ev[0]!, ev[1]!, ev[2]!];
}

export interface Geometry {
  spreadM: number;
  principalM: [number, number, number];
  medianCameraDistM: number | null;
}

export function geometry(leds: readonly Vec3[], cams: readonly Vec3[]): Geometry {
  const n = leds.length;
  if (n === 0) return { spreadM: 0, principalM: [0, 0, 0], medianCameraDistM: null };
  const c: Vec3 = [0, 0, 0];
  for (const l of leds) for (let k = 0; k < 3; k++) c[k]! += l[k]! / n;
  const cov = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let ss = 0;
  for (const l of leds) {
    const d = [l[0] - c[0], l[1] - c[1], l[2] - c[2]];
    ss += d[0]! ** 2 + d[1]! ** 2 + d[2]! ** 2;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i]![j]! += (d[i]! * d[j]!) / n;
  }
  const ev = eigSym3(cov);
  let medianCameraDistM: number | null = null;
  if (cams.length > 0) {
    const d = cams.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])).sort((a, b) => a - b);
    const m = d.length;
    medianCameraDistM = m % 2 === 1 ? d[(m - 1) / 2]! : 0.5 * (d[m / 2 - 1]! + d[m / 2]!);
  }
  return {
    spreadM: Math.sqrt(ss / n),
    principalM: [Math.sqrt(Math.max(0, ev[0])), Math.sqrt(Math.max(0, ev[1])), Math.sqrt(Math.max(0, ev[2]))],
    medianCameraDistM,
  };
}

/** The diag.rs verdict from its inputs. */
export function verdict(
  measured: number,
  observable: number,
  rmsPx: number,
  allFinite: boolean,
  scaleRelStdErr: number | null,
  geo: Geometry,
): Assessment {
  const reasons: DegeneracyReason[] = [];
  if (!allFinite || !Number.isFinite(rmsPx)) reasons.push("non-finite");
  const need = Math.max(MIN_MEASURED_LEDS, Math.ceil(MIN_MEASURED_FRAC * observable));
  if (measured < need) reasons.push("too-few-leds");
  if (rmsPx > MAX_RMS_PX) reasons.push("huge-residual");
  if (measured >= 2) {
    const cam = geo.medianCameraDistM;
    if ((cam !== null && cam < MIN_CAMERA_DIST_M) || geo.spreadM < MIN_SPREAD_M) reasons.push("scale-collapse");
    if (cam !== null && cam > MAX_CAMERA_DIST_M) reasons.push("scale-blowup");
  }
  const warnings: string[] = [];
  if (scaleRelStdErr !== null && scaleRelStdErr > SCALE_UNCERTAIN_REL_SE) warnings.push("scale-uncertain");
  return {
    degenerate: reasons.length > 0,
    reasons,
    warnings,
    measured,
    observable,
    rmsPx,
    scaleRelStdErr,
    spreadM: geo.spreadM,
    principalM: geo.principalM,
    medianCameraDistM: geo.medianCameraDistM,
  };
}

/** Assess an OutputMap (`observable` = LEDs the capture saw in ≥ 2 frames,
 * 0 when unknown — then only the absolute 4-LED floor applies). */
export function assessMap(map: OutputMap, observable = 0): Assessment {
  const measured = map.leds.filter((l) => l.nViews > 0).map((l) => l.xyz);
  const traj = map.trajectory ?? [];
  const allFinite = map.leds.every((l) => finite(l.xyz)) && traj.every((p) => finite(p));
  return verdict(
    measured.length,
    observable,
    map.stats.rmsReprojPxGlobal,
    allFinite,
    map.stats.scaleRelStdErr ?? null,
    geometry(measured, traj),
  );
}

/** LEDs observed in at least two distinct capture frames (diag.rs). */
export function observableLeds(detections: readonly { ledId: number; tCaptureMs: number }[]): number {
  const frames = new Map<number, Set<number>>();
  for (const d of detections) {
    let s = frames.get(d.ledId);
    if (!s) frames.set(d.ledId, (s = new Set()));
    s.add(d.tCaptureMs);
  }
  let n = 0;
  for (const s of frames.values()) if (s.size >= 2) n++;
  return n;
}

/** diag.rs `better`: non-degenerate beats degenerate; then more measured
 * LEDs; then the lower residual. */
export function better(a: Assessment, b: Assessment): boolean {
  if (a.degenerate !== b.degenerate) return !a.degenerate;
  if (a.measured !== b.measured) return a.measured > b.measured;
  return a.rmsPx < b.rmsPx;
}

export type PreviewRegression =
  | "degenerate"
  | "fewer-leds-than-preview"
  | "collapsed-to-line"
  | "collapsed-to-plane"
  | "size-differs-from-preview"
  | "shape-differs-from-preview";

/** Regressions that make the preview's map the better one to keep. */
export const FALLBACK_REGRESSIONS: ReadonlySet<PreviewRegression> = new Set([
  "degenerate",
  "fewer-leds-than-preview",
  "collapsed-to-line",
  "collapsed-to-plane",
]);

export interface PreviewComparison {
  regressions: PreviewRegression[];
  /** Final/preview LED spread (null when either has < 2 measured LEDs). */
  sizeRatio: number | null;
  /** Similarity-aligned shape rms over the common LEDs, as a fraction of the
   * preview's spread (null with < 4 common LEDs). */
  shapeRms: number | null;
}

/** Judge a final solve against the preview (best interim) of the capture.
 * Only the first two regression kinds are about the final being broken; size
 * and shape disagreements are recorded (either side could be the wrong one —
 * the final had more data and outlier rejection) but don't trigger fallback. */
export function compareToPreview(
  final: OutputMap,
  finalA: Assessment,
  preview: OutputMap,
  previewA: Assessment,
): PreviewComparison {
  const regressions: PreviewRegression[] = [];
  if (finalA.degenerate && !previewA.degenerate) regressions.push("degenerate");
  if (finalA.measured < MIN_LED_RATIO_VS_PREVIEW * previewA.measured) regressions.push("fewer-leds-than-preview");
  const [p1, p2, p3] = previewA.principalM;
  const [f1, f2, f3] = finalA.principalM;
  if (p1 > 0 && f1 > 0) {
    if (p2 / p1 >= RANK_PRESENT && f2 / f1 < RANK_COLLAPSED) regressions.push("collapsed-to-line");
    else if (p3 / p1 >= RANK_PRESENT && f3 / f1 < RANK_COLLAPSED) regressions.push("collapsed-to-plane");
  }
  let sizeRatio: number | null = null;
  if (finalA.measured >= 2 && previewA.measured >= 2 && previewA.spreadM > 0) {
    sizeRatio = finalA.spreadM / previewA.spreadM;
    if (sizeRatio > SIZE_RATIO_FLAG || sizeRatio < 1 / SIZE_RATIO_FLAG) regressions.push("size-differs-from-preview");
  }
  let shapeRms: number | null = null;
  const pv = new Map(preview.leds.filter((l) => l.nViews > 0).map((l) => [l.id, l.xyz] as const));
  const src: Vec3[] = [];
  const dst: Vec3[] = [];
  for (const l of final.leds) {
    const q = pv.get(l.id);
    if (l.nViews > 0 && q) {
      src.push(l.xyz);
      dst.push(q);
    }
  }
  if (src.length >= 4 && previewA.spreadM > 0) {
    const sim = fitSimilarity(src, dst);
    if (sim !== null) {
      let ss = 0;
      for (let i = 0; i < src.length; i++) {
        const a = applySimilarity(sim, src[i]!);
        const b = dst[i]!;
        ss += (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
      }
      shapeRms = Math.sqrt(ss / src.length) / previewA.spreadM;
      if (shapeRms > SHAPE_RMS_FLAG) regressions.push("shape-differs-from-preview");
    }
  }
  return { regressions, sizeRatio, shapeRms };
}

/** How a mapping run ended (the capture bundle's `outcome`). */
export type RunOutcome =
  /** Final solve kept, nothing suspicious. */
  | "ok"
  /** Final solve kept, but it disagrees with the preview (size/shape). */
  | "flagged"
  /** Final solve was degenerate/regressed; the preview's map was kept. */
  | "fallback-degenerate"
  /** Final solve threw; the preview's map was kept. */
  | "fallback-failed"
  /** Final solve degenerate and no usable preview to fall back to. */
  | "degenerate"
  /** Final solve threw and no usable preview. */
  | "failed";

export interface FinalDecision {
  use: "final" | "preview" | "none";
  outcome: RunOutcome;
  /** Every finding: degeneracy reasons (prefixed `final:`), regressions vs
   * the preview, and the solve error. */
  reasons: string[];
  comparison: PreviewComparison | null;
}

/** Pick the map a capture keeps. `preview` = the best interim solve (null if
 * none succeeded); `final.map` null with `final.error` when it threw. */
export function decideFinal(
  final: { map: OutputMap | null; assessment: Assessment | null; error: string | null },
  preview: { map: OutputMap; assessment: Assessment } | null,
): FinalDecision {
  const usablePreview = preview !== null && !preview.assessment.degenerate ? preview : null;
  if (final.map === null || final.assessment === null) {
    const reasons = [`final-error: ${final.error ?? "unknown"}`];
    return usablePreview
      ? { use: "preview", outcome: "fallback-failed", reasons, comparison: null }
      : { use: "none", outcome: "failed", reasons, comparison: null };
  }
  const reasons = final.assessment.reasons.map((r) => `final:${r}`);
  if (usablePreview === null) {
    return final.assessment.degenerate
      ? { use: "final", outcome: "degenerate", reasons, comparison: null }
      : { use: "final", outcome: "ok", reasons, comparison: null };
  }
  const comparison = compareToPreview(final.map, final.assessment, usablePreview.map, usablePreview.assessment);
  reasons.push(...comparison.regressions);
  if (comparison.regressions.some((r) => FALLBACK_REGRESSIONS.has(r))) {
    return { use: "preview", outcome: "fallback-degenerate", reasons, comparison };
  }
  return {
    use: "final",
    outcome: comparison.regressions.length > 0 || final.assessment.degenerate ? "flagged" : "ok",
    reasons,
    comparison,
  };
}
