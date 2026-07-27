/**
 * Pure formatting helpers for the topology Diagnostics overlay (design doc §7.7
 * debug view). Kept DOM-free + side-effect-free so it unit-tests cleanly and so
 * mapDetail's Debug section and any future consumer share one wording.
 *
 * The extractor (topology/extract.ts) emits a {@link TopologyDebug} of solved
 * coordinates; these helpers turn its counts + length scale into the terse
 * summary line and per-pair labels the user reads to hunt down false "bridges".
 */

import type { TopologyDebug } from "./extract";

/** Compact metric label for a length in METRES (the solve's unit) — mm under a
 * cm, cm under a metre, else metres. Mirrors mapview.ts's fmtMeters wording so
 * the overlay text reads the same as the 3D view's graduations. */
export function fmtLen(m: number): string {
  const a = Math.abs(m);
  if (a < 0.01) return `${Math.round(m * 1000)}mm`;
  if (a < 1) return `${(m * 100).toFixed(a < 0.1 ? 1 : 0)}cm`;
  return `${m.toFixed(a < 10 ? 1 : 0)}m`;
}

/** Count of loop-chords among the kept graph edges. */
export function countChords(debug: TopologyDebug): number {
  let n = 0;
  for (const e of debug.edges) if (e.chord) n++;
  return n;
}

/** Terse one-line summary, e.g.
 *   "⚠ 3 coincident pairs · 2 loop-chords · spacing 4.1cm"
 * Singular/plural is handled; a leading ⚠ appears only when there are
 * coincident pairs (the prime suspect for a false geodesic bridge). */
export function summarizeTopologyDebug(debug: TopologyDebug): string {
  const nc = debug.coincident.length;
  const nch = countChords(debug);
  const parts = [
    `${nc} coincident ${nc === 1 ? "pair" : "pairs"}`,
    `${nch} loop-${nch === 1 ? "chord" : "chords"}`,
    `spacing ${fmtLen(debug.spacing)}`,
  ];
  return (nc > 0 ? "⚠ " : "") + parts.join(" · ");
}
