/**
 * FUG-112 — what the registered 3D overlay draws while a scan is running.
 *
 * The overlay shows the UNION of the base map (supplemental scans) and
 * everything the live solve of the current session has produced so far, each
 * LED tagged with its provenance and a 1-σ position uncertainty:
 *
 *   - first-time capture: every live-solved LED, provenance "scan";
 *   - supplemental scan: the live solve is registered into the base map's frame
 *     and merged exactly as the final fusion would (fuseMaps), so the user sees
 *     base LEDs, new ones, and low-confidence base LEDs being re-solved — live.
 *     Until enough known LEDs overlap to register, the base map alone is shown.
 *
 * The live solve re-gauges on every update (each solve picks its own origin,
 * heading and scale), which would invalidate the overlay's warm-started PnP lock
 * and make the dots jump. In a first-time capture each new solve is therefore
 * registered onto the previous display frame (stabilizeFrame), so the frame —
 * and the lock — survive across updates.
 */

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { applySimilarity } from "./fit";
import { fuseMaps, registerInto, type Provenance } from "./fuseMaps";
import { ledSigmaM, ledSpacingM, mapSigmaContext } from "./ledVariance";

/** One LED as the overlay draws it. */
export interface OverlayLed {
  id: number;
  xyz: Vec3;
  confidence: number;
  /** 1-σ position uncertainty, meters (geom/ledVariance). */
  sigmaM: number;
  provenance: Provenance;
}

export interface LiveUnion {
  /** The display map (prior frame in a supplement, else the stabilized live
   * frame) — for the 3D inset. Null until anything is solved. */
  map: OutputMap | null;
  leds: OverlayLed[];
  /** Median LED pitch of the display set (variance tiers are relative to it). */
  spacingM: number | null;
  /** Supplement only: the live solve is registered into the base map. */
  registered: boolean;
  /** The display frame was reset (could not be carried over) — callers drop
   * their pose lock. */
  frameReset: boolean;
  /** Short status for the HUD ("" when nothing to say). */
  note: string;
}

/** Overlay LEDs with σ from the map's own context. */
export function toOverlayLeds(
  leds: readonly LedEntry[],
  map: Pick<OutputMap, "leds" | "trajectory">,
  provenance: (id: number) => Provenance,
  focalPx?: number,
): OverlayLed[] {
  const ctx = mapSigmaContext(map, focalPx);
  return leds.map((l) => ({
    id: l.id,
    xyz: l.xyz,
    confidence: l.confidence,
    sigmaM: ledSigmaM(l, ctx),
    provenance: provenance(l.id),
  }));
}

/**
 * Re-express `next` in `prev`'s frame by a similarity fit over their common
 * LEDs, so successive live solves share one display frame. Returns `next`
 * unchanged with `reset: true` when there is no previous frame to keep or the
 * two don't register.
 */
export function stabilizeFrame(prev: OutputMap | null, next: OutputMap): { map: OutputMap; reset: boolean } {
  if (prev === null || prev.leds.length === 0) return { map: next, reset: prev !== null };
  // Every LED anchors: a live solve's confidence is not yet meaningful.
  const reg = registerInto(prev, next, { anchorConfidence: 0, maxRmsFrac: 0.15 });
  if (!reg.ok || reg.sim === null) return { map: next, reset: true };
  const sim = reg.sim;
  return {
    map: {
      ...next,
      leds: next.leds.map((l) => ({ ...l, xyz: applySimilarity(sim, l.xyz) })),
      ...(next.trajectory ? { trajectory: next.trajectory.map((p) => applySimilarity(sim, p)) } : {}),
    },
    reset: false,
  };
}

/**
 * Compose the overlay's LED set from the base map (null in a first-time
 * capture), the latest live solve of this session, and the previous display
 * map (for frame stabilization). Pure.
 */
export function liveUnion(
  prior: OutputMap | null,
  live: OutputMap | null,
  prevDisplay: OutputMap | null = null,
  focalPx?: number,
): LiveUnion {
  if (prior === null) {
    if (live === null || live.leds.length === 0) {
      return { map: prevDisplay, leds: [], spacingM: null, registered: false, frameReset: false, note: "" };
    }
    const { map, reset } = stabilizeFrame(prevDisplay, live);
    return {
      map,
      leds: toOverlayLeds(map.leds, map, () => "scan", focalPx),
      spacingM: ledSpacingM(map.leds.map((l) => l.xyz)),
      registered: false,
      frameReset: reset,
      note: "",
    };
  }
  const priorOnly = (note: string): LiveUnion => ({
    map: prior,
    leds: toOverlayLeds(prior.leds, prior, () => "base", focalPx),
    spacingM: ledSpacingM(prior.leds.map((l) => l.xyz)),
    registered: false,
    frameReset: false,
    note,
  });
  if (live === null || live.leds.length === 0) return priorOnly("");
  const fused = fuseMaps(prior, live);
  if (!fused.report.registered) {
    return priorOnly(`New scan not registered yet — ${fused.report.summary}`);
  }
  const m = fused.map;
  return {
    map: m,
    leds: toOverlayLeds(m.leds, m, (id) => fused.provenance.get(id) ?? "base", focalPx),
    spacingM: ledSpacingM(m.leds.map((l) => l.xyz)),
    registered: true,
    frameReset: false,
    note:
      `+${fused.report.added} new · ${fused.report.resolved} re-solved` +
      (fused.report.conflicts > 0 ? ` · ${fused.report.conflicts} conflicting` : ""),
  };
}
