/**
 * FUG-112 — a per-LED positional-uncertainty proxy from the solver's per-LED
 * statistics.
 *
 * The solver does not export a covariance (a per-landmark marginal would need
 * the inverse of the Schur complement — not cheap in wasm on a phone), but every
 * LedEntry carries the three quantities that dominate a triangulated point's
 * uncertainty: how many rays (`nViews`), how noisy they are (`rmsReprojPx`) and
 * how wide a baseline they span (`parallaxDeg`). The standard first-order
 * triangulation error model turns those into a 1-σ position error in meters:
 *
 *   lateral σ  ≈ depth · σ_px / (focal · √nViews)      (per-ray angular noise
 *                                                       averaged over the views)
 *   σ_pos      ≈ lateral σ / sin(parallax)              (depth along the rays is
 *                                                       recovered only through
 *                                                       the baseline angle)
 *
 * σ_px is the LED's own reprojection RMS, floored at PX_FLOOR (an rms near 0
 * from 2–3 views means "consistent", not "exact"). `depth` is the typical
 * camera→fixture distance — taken from the map's solved trajectory when it has
 * one — and `focal` the camera focal length in pixels (the capture's K, or a
 * phone-typical default). It is a proxy, not a marginal covariance: it ignores
 * pose uncertainty and correlation between LEDs. But it is monotone in exactly
 * the right things, is computable from any persisted map (no solver changes),
 * and — unlike the solver's [0,1] `confidence` score — is in meters, so it
 * can be drawn as a 1-σ ring at its true projected size and compared to the
 * LED pitch (varianceTier).
 */

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";

/** Reprojection noise floor (px). */
export const PX_FLOOR = 0.5;
/** Parallax floor (deg) — keeps the ~0° (single-spot) case finite but huge. */
export const PARALLAX_FLOOR_DEG = 0.5;
/** Phone-typical focal length in pixels (1280-wide frame, ~65° HFOV). */
export const DEFAULT_FOCAL_PX = 1000;
/** Typical capture distance when a map carries no trajectory (m). */
export const DEFAULT_DEPTH_M = 1.5;

/** The scene-level inputs to the per-LED σ model. */
export interface SigmaContext {
  /** Typical camera→LED distance, meters. */
  depthM: number;
  /** Camera focal length, pixels. */
  focalPx: number;
}

type LedStats = Pick<LedEntry, "nViews" | "rmsReprojPx" | "parallaxDeg">;

/** 1-σ position uncertainty (meters) of one solved LED. */
export function ledSigmaM(led: LedStats, ctx: SigmaContext): number {
  const n = Math.max(1, led.nViews);
  const px = Math.max(PX_FLOOR, Number.isFinite(led.rmsReprojPx) ? led.rmsReprojPx : PX_FLOOR);
  const par = Math.min(90, Math.max(PARALLAX_FLOOR_DEG, Number.isFinite(led.parallaxDeg) ? led.parallaxDeg : 0));
  const lateral = (ctx.depthM * px) / (ctx.focalPx * Math.sqrt(n));
  return lateral / Math.sin((par * Math.PI) / 180);
}

function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function centroid(pts: readonly Vec3[]): Vec3 {
  const c: Vec3 = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0] / pts.length;
    c[1] += p[1] / pts.length;
    c[2] += p[2] / pts.length;
  }
  return c;
}

/** Derive the σ context of a map: median trajectory→LED-centroid distance as
 * the capture depth (falls back to DEFAULT_DEPTH_M), and `focalPx` if known. */
export function mapSigmaContext(
  map: Pick<OutputMap, "leds" | "trajectory">,
  focalPx: number = DEFAULT_FOCAL_PX,
): SigmaContext {
  let depthM = DEFAULT_DEPTH_M;
  const traj = map.trajectory ?? [];
  if (traj.length > 0 && map.leds.length > 0) {
    const c = centroid(map.leds.map((l) => l.xyz));
    const d = median(traj.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2])));
    if (Number.isFinite(d) && d > 0.05) depthM = d;
  }
  return { depthM, focalPx: focalPx > 0 ? focalPx : DEFAULT_FOCAL_PX };
}

/** Median nearest-neighbour distance between solved LEDs — the LED pitch the
 * σ tiers are judged against (scale-free: a 5 mm σ is great on a 10 cm-pitch
 * wall and useless on a 16 mm-pitch strip). Null with fewer than 2 LEDs. */
export function ledSpacingM(pts: readonly Vec3[]): number | null {
  if (pts.length < 2) return null;
  // O(n²) is fine for the few hundred LEDs a fixture has; only called when the
  // solved set changes, not per frame.
  const nn: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    let best = Infinity;
    for (let j = 0; j < pts.length; j++) {
      if (i === j) continue;
      const b = pts[j]!;
      const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      if (d > 1e-9 && d < best) best = d;
    }
    if (Number.isFinite(best)) nn.push(best);
  }
  const m = median(nn);
  return Number.isFinite(m) && m > 0 ? m : null;
}

export type VarianceTier = "tight" | "moderate" | "loose";

/** Bucket σ against the LED pitch: tight < ¼ pitch (neighbours unambiguous),
 * moderate < ¾ pitch, loose beyond (the LED could be its neighbour). */
export function varianceTier(sigmaM: number, spacingM: number | null): VarianceTier {
  const pitch = spacingM ?? 0.03;
  if (!(sigmaM < 0.75 * pitch)) return "loose";
  return sigmaM < 0.25 * pitch ? "tight" : "moderate";
}
