/**
 * LEDs the solver PLACED rather than measured.
 *
 * With the strip prior on (solver/src/strip.rs, `options.stripPrior`), the
 * solver places each interior run of unmapped LEDs on the segment between its
 * mapped neighbours and emits them as ordinary entries marked `nViews = 0`,
 * `confidence = 0` — measured by nothing, so any real observation outranks
 * them. (In-progress solve snapshots also carry `nViews = 0`, but with
 * confidence 1, so both fields are checked.)
 */

import type { LedEntry } from "@ledmapper/protocol";

export function isInferred(led: Pick<LedEntry, "nViews" | "confidence">): boolean {
  return led.nViews === 0 && led.confidence === 0;
}

/** Count of measured vs strip-prior-placed LEDs in a map. */
export function countPlacement(leds: readonly Pick<LedEntry, "nViews" | "confidence">[]): {
  measured: number;
  inferred: number;
} {
  let inferred = 0;
  for (const l of leds) if (isInferred(l)) inferred++;
  return { measured: leds.length - inferred, inferred };
}
