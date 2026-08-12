/**
 * FUG-112 — fuse a supplemental scan into an existing map.
 *
 * A supplemental capture solves as its own independent reconstruction (its own
 * gravity-leveled, arbitrarily-gauged frame — the VIO segment selector will not
 * stitch two disjoint camera arcs, so we cannot just re-solve the union of
 * observations). To fuse it we REGISTER the new solve into the prior map's
 * frame via a similarity fit over the LEDs both scans resolved, then merge
 * per-LED: new LEDs extend coverage, re-seen LEDs corroborate (raising
 * confidence) or, when they disagree after registration, defer to the stronger
 * observation.
 *
 * The registration is also the honest "did the phone reacquire absolute pose?"
 * check at fuse time: too few common LEDs, or a high post-fit residual (the
 * fixture's gravity-relative transform changed between scans), means the new
 * scan could not be registered — the caller surfaces that and lets the user
 * reject the result.
 */

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { applySimilarity, fitSimilarity } from "./fit";

export interface FuseOptions {
  /** Minimum LEDs common to both scans to attempt registration (default 4). */
  minCommon?: number;
  /** Max post-fit RMS (as a fraction of the prior fixture's radius) to accept
   * the registration (default 0.08 = 8%). */
  maxRmsFrac?: number;
}

export interface FusionReport {
  /** The new scan registered into the prior frame within tolerance. */
  registered: boolean;
  /** LEDs resolved by both scans (used for the fit). */
  common: number;
  /** RMS of the common LEDs after registration, meters. */
  rmsM: number;
  /** LEDs present after fusion that the prior map lacked. */
  added: number;
  /** Common LEDs whose confidence rose from corroboration. */
  improved: number;
  /** Common LEDs whose two positions disagreed past tolerance. */
  conflicts: number;
  /** Human-readable one-liner for the review UI. */
  summary: string;
}

export interface FusionResult {
  map: OutputMap;
  report: FusionReport;
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
 * Register `addition` into `prior`'s frame and merge. When registration fails
 * (too few common LEDs, or the fit residual is too large) the returned map is
 * the prior unchanged and `report.registered` is false — the caller rejects or
 * retries. Never mutates its inputs.
 */
export function fuseMaps(prior: OutputMap, addition: OutputMap, opts: FuseOptions = {}): FusionResult {
  const minCommon = opts.minCommon ?? 4;
  const maxRmsFrac = opts.maxRmsFrac ?? 0.08;

  const priorById = new Map(prior.leds.map((l) => [l.id, l]));
  const addById = new Map(addition.leds.map((l) => [l.id, l]));

  // Common LEDs anchor the similarity fit (addition frame -> prior frame).
  const src: Vec3[] = [];
  const dst: Vec3[] = [];
  for (const [id, a] of addById) {
    const p = priorById.get(id);
    if (p) {
      src.push(a.xyz);
      dst.push(p.xyz);
    }
  }
  const common = src.length;
  const priorR = radiusOf(prior.leds);
  const fail = (summary: string, rmsM = Infinity): FusionResult => ({
    map: prior,
    report: { registered: false, common, rmsM, added: 0, improved: 0, conflicts: 0, summary },
  });

  if (common < minCommon) {
    return fail(
      `Only ${common} LED${common === 1 ? "" : "s"} seen in both scans — need ${minCommon} to register.`,
    );
  }
  let sim = fitSimilarity(src, dst);
  if (sim === null) return fail("The overlapping LEDs are degenerate — could not register.");

  const agreeTol = maxRmsFrac * priorR; // "same LED" if within the fit tolerance
  // One robust refit: a few mismatched LEDs (a decode swap, or a genuinely
  // moved LED) would otherwise skew the least-squares fit and its residual.
  // Drop the gross outliers and refit on what agrees.
  const resid0 = src.map((s, i) => dist(applySimilarity(sim!, s), dst[i]!));
  const cut = Math.max(agreeTol, 3 * median(resid0));
  const inl: number[] = [];
  for (let i = 0; i < common; i++) if (resid0[i]! <= cut) inl.push(i);
  if (inl.length >= Math.max(3, minCommon) && inl.length < common) {
    const s2 = fitSimilarity(inl.map((i) => src[i]!), inl.map((i) => dst[i]!));
    if (s2 !== null) sim = s2;
  }

  // Acceptance is decided over the LEDs that actually agree under the final fit.
  const resid = src.map((s, i) => dist(applySimilarity(sim!, s), dst[i]!));
  const agree: number[] = [];
  for (let i = 0; i < common; i++) if (resid[i]! <= agreeTol) agree.push(i);
  if (agree.length < minCommon) {
    const rough = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / common);
    return fail(
      `Only ${agree.length}/${common} overlapping LEDs line up — the fixture may have moved.`,
      rough,
    );
  }
  const rmsM = Math.sqrt(agree.reduce((a, i) => a + resid[i]! ** 2, 0) / agree.length);
  const merged = new Map<number, LedEntry>(priorById);
  let added = 0;
  let improved = 0;
  let conflicts = 0;

  for (const [id, a] of addById) {
    const xyzReg = applySimilarity(sim, a.xyz);
    const p = priorById.get(id);
    if (!p) {
      // New LED: extends coverage. Registered position, carried confidence.
      merged.set(id, {
        id,
        xyz: xyzReg,
        confidence: a.confidence,
        nViews: a.nViews,
        rmsReprojPx: a.rmsReprojPx,
        parallaxDeg: a.parallaxDeg,
      });
      added++;
      continue;
    }
    const delta = dist(p.xyz, xyzReg);
    const wa = Math.max(p.confidence, 0.05);
    const wb = Math.max(a.confidence, 0.05);
    if (delta <= agreeTol) {
      // Corroboration: blend position, combine as independent evidence.
      const xyz: Vec3 = [
        (wa * p.xyz[0] + wb * xyzReg[0]) / (wa + wb),
        (wa * p.xyz[1] + wb * xyzReg[1]) / (wa + wb),
        (wa * p.xyz[2] + wb * xyzReg[2]) / (wa + wb),
      ];
      const confidence = Math.min(1, 1 - (1 - p.confidence) * (1 - a.confidence));
      merged.set(id, {
        id,
        xyz,
        confidence,
        nViews: p.nViews + a.nViews,
        rmsReprojPx: Math.min(p.rmsReprojPx, a.rmsReprojPx),
        parallaxDeg: Math.max(p.parallaxDeg, a.parallaxDeg),
      });
      if (confidence > p.confidence + 1e-6) improved++;
    } else {
      // Conflict: keep the stronger observation, don't reward the disagreement.
      conflicts++;
      const keepAdd = a.confidence > p.confidence;
      const win = keepAdd ? { ...a, xyz: xyzReg } : p;
      merged.set(id, { ...win, id, confidence: win.confidence * 0.9 });
    }
  }

  const leds = [...merged.values()].sort((a, b) => a.id - b.id);
  const mappedIds = new Set(leds.map((l) => l.id));
  const unmapped = [...new Set([...prior.unmapped, ...addition.unmapped])].filter(
    (id) => !mappedIds.has(id),
  );

  const map: OutputMap = {
    ...prior,
    ledCount: Math.max(prior.ledCount, addition.ledCount),
    leds,
    unmapped,
    stats: {
      rmsReprojPxGlobal: Math.max(prior.stats.rmsReprojPxGlobal, addition.stats.rmsReprojPxGlobal),
      medianParallaxDeg: Math.max(prior.stats.medianParallaxDeg, addition.stats.medianParallaxDeg),
    },
  };

  const summary =
    `Registered on ${common} LEDs (${(rmsM * 1000).toFixed(0)} mm). ` +
    `+${added} new, ${improved} improved` +
    (conflicts > 0 ? `, ${conflicts} conflicting.` : ".");
  return { map, report: { registered: true, common, rmsM, added, improved, conflicts, summary } };
}
