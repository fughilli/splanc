/**
 * Map recapture (§7.10): re-map a low-confidence SUBSET of an already-solved
 * fixture and splice the refreshed LEDs back in.
 *
 * The phone selects target LEDs (low confidence / a region), auto-picks
 * registration anchors from the well-solved LEDs, builds a bitmask (anchors ∪
 * targets), and re-enters mapping with it (start_mapping led_mask). Only those
 * LEDs light, so the recapture solve yields positions for the same ids. The
 * shared anchors then rigidly align the recapture to the original map, and the
 * target positions are replaced with the aligned ones (anchors keep their
 * original, already-good positions).
 *
 * Pure + unit-tested; the UI/capture wiring lives in ui/main.ts.
 */

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { applySimilarity, fitSimilarity } from "../geom/fit";

/** Base64 bitmask over `ledCount` LEDs — bit (b*8+i) set for each id in `ids`
 * (byte b, bit i). This is the wire form of start_mapping's led_mask/anchor_mask. */
export function buildLedMask(ids: Iterable<number>, ledCount: number): string {
  const bytes = new Uint8Array(Math.ceil(Math.max(1, ledCount) / 8));
  for (const id of ids) {
    if (id >= 0 && id < ledCount) bytes[id >> 3]! |= 1 << (id & 7);
  }
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

const dist2 = (a: Vec3, b: Vec3): number =>
  (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/** Pick up to `n` registration anchors: confident LEDs (>= minConf) that are
 * NOT targets, spread across the fixture by farthest-point sampling (seeded
 * with the most confident). Spread anchors pin the recapture's pose best. */
export function pickAnchors(
  map: OutputMap,
  targets: Set<number>,
  n: number,
  minConf = 0.5,
): number[] {
  const cand = map.leds.filter((l) => !targets.has(l.id) && l.confidence >= minConf);
  if (cand.length === 0 || n <= 0) return [];
  cand.sort((a, b) => b.confidence - a.confidence);
  const chosen: LedEntry[] = [cand[0]!];
  const inChosen = new Set<number>([cand[0]!.id]);
  while (chosen.length < n && chosen.length < cand.length) {
    let best: LedEntry | null = null;
    let bestD = -1;
    for (const c of cand) {
      if (inChosen.has(c.id)) continue;
      let md = Infinity;
      for (const ch of chosen) md = Math.min(md, dist2(c.xyz, ch.xyz));
      if (md > bestD) {
        bestD = md;
        best = c;
      }
    }
    if (best === null) break;
    chosen.push(best);
    inChosen.add(best.id);
  }
  return chosen.map((l) => l.id);
}

export interface MergeResult {
  map: OutputMap;
  /** LEDs whose positions were refreshed from the recapture. */
  updated: number;
  /** Anchor LEDs used for the alignment fit. */
  anchorsUsed: number;
}

/** Merge a masked recapture into `base`: rigidly (similarity) align the
 * recapture to `base` via the shared anchor ids, then replace each target LED's
 * position with the aligned recaptured one. Anchors keep their base positions.
 * With < 3 shared anchors the recapture is spliced without alignment. */
export function mergeRecapture(
  base: OutputMap,
  recap: OutputMap,
  anchorIds: Set<number>,
): MergeResult {
  const baseById = new Map(base.leds.map((l) => [l.id, l]));
  const src: Vec3[] = [];
  const dst: Vec3[] = [];
  for (const l of recap.leds) {
    const b = baseById.get(l.id);
    if (anchorIds.has(l.id) && b !== undefined) {
      src.push(l.xyz);
      dst.push(b.xyz);
    }
  }
  const fit = src.length >= 3 ? fitSimilarity(src, dst) : null;

  const merged = base.leds.map((l) => ({ ...l }));
  const mergedById = new Map(merged.map((l) => [l.id, l]));
  const unmapped = new Set(base.unmapped);
  let updated = 0;
  for (const l of recap.leds) {
    if (anchorIds.has(l.id)) continue; // anchors keep their good base positions
    const xyz = fit ? applySimilarity(fit, l.xyz) : l.xyz;
    const ex = mergedById.get(l.id);
    if (ex !== undefined) {
      ex.xyz = xyz;
      ex.confidence = l.confidence;
      ex.nViews = l.nViews;
      ex.rmsReprojPx = l.rmsReprojPx;
      ex.parallaxDeg = l.parallaxDeg;
    } else {
      const nl: LedEntry = { ...l, xyz };
      merged.push(nl);
      mergedById.set(l.id, nl);
    }
    unmapped.delete(l.id); // a recaptured LED is no longer unmapped
    updated++;
  }

  return {
    map: { ...base, leds: merged, unmapped: [...unmapped] },
    updated,
    anchorsUsed: src.length,
  };
}
