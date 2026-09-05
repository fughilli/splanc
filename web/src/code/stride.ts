/**
 * Diffuse-capture striding schedule (design: diffuse_capture plan §"The striding
 * scheme"). On a diffused fixture, lighting every LED every frame blends adjacent
 * spots into one blob. Instead we light only a SPARSE, spatially-separated subset
 * per epoch ("phase") and rotate the phase to eventually cover every LED.
 *
 * Two jobs, deliberately split (overloading one formula either under-covers or
 * collides the shared anchor with its adjacent fill):
 *
 *   1. COVERAGE — `S` phases, uniform stride-`S`, offset +1 per phase. Phase `o`
 *      lights `{o, o+S, o+2S, …}`: spacing exactly `S`, and the union over
 *      `o = 0..S-1` is every LED.
 *   2. FUSION — `S-1` sparse "bridge" phases forming a star through class 0. Bridge
 *      for class `j` co-lights class-0 anchor reps (every `A·S`-th LED) AND class-`j`
 *      reps placed in class-0's GAPS, so all lit spots stay ≥ `S` apart (needs
 *      `A ≥ 3`). Class 0 is thereby co-observed with every class ⇒ the LED
 *      co-observation graph has diameter 2 (the "bounded degrees of intraframe
 *      association" the fixture registration needs).
 *
 * Each lit LED still transmits its own full hue code (gray.ts), so ledIds are
 * absolute and fuse automatically across phases — striding only changes WHICH LEDs
 * are lit in a given phase, never the code. This module is the authority the phone
 * (capture rotation) shares with the firmware pattern generator; Stage B mirrors it
 * in the Rust `pattern` crate against a golden fixture.
 */

export interface StrideParams {
  /**
   * `S`: min LED-index separation that keeps diffused spots from blending
   * (the diffuser knob). `S <= 1` disables striding — every LED lit, the
   * legacy all-at-once behavior.
   */
  spacing: number;
  /**
   * `A`: anchor density — one class-0 anchor rep per `A·S` LEDs (and one class-`j`
   * rep per bridge, placed in that block's gap). `A ≥ 3` guarantees every bridge's
   * lit spots stay ≥ `S` apart; smaller values are clamped up.
   */
  anchorDensity: number;
}

/** `A` clamped to its valid floor (see StrideParams.anchorDensity). */
function anchor(p: StrideParams): number {
  return Math.max(3, Math.floor(p.anchorDensity));
}

/**
 * Number of phases in one full schedule: `S` coverage + `S-1` bridges = `2S-1`.
 * `1` when striding is disabled (`S <= 1`).
 */
export function phaseCount(p: StrideParams): number {
  const s = Math.floor(p.spacing);
  return s <= 1 ? 1 : 2 * s - 1;
}

/** True for the coverage phases (`0 .. S-1`); the rest are bridges. */
export function isCoveragePhase(phase: number, p: StrideParams): boolean {
  return phase < Math.floor(p.spacing);
}

/**
 * Is `led` lit in phase `phase` (`0 .. phaseCount-1`)?
 *
 * `S <= 1` ⇒ always lit (striding disabled). Out-of-range phases wrap via modulo
 * so the caller can advance a running counter without bounds-checking.
 */
export function strideLit(led: number, phase: number, p: StrideParams): boolean {
  const S = Math.floor(p.spacing);
  if (S <= 1) return true;
  const nPhases = 2 * S - 1;
  const ph = ((phase % nPhases) + nPhases) % nPhases;

  if (ph < S) {
    // Coverage: uniform stride-S grid at offset `ph`.
    return ((led % S) + S) % S === ph;
  }
  // Bridge linking class 0 with class j (j = 1 .. S-1).
  const j = ph - S + 1;
  const A = anchor(p);
  const period = A * S;
  const m = ((led % period) + period) % period;
  // Class-0 anchor rep at the block start; class-j rep in the block's mid gap.
  return m === 0 || m === Math.floor(A / 2) * S + j;
}

/** The lit LED indices of `[0, ledCount)` in `phase` (helper for tests/UI). */
export function litLeds(ledCount: number, phase: number, p: StrideParams): number[] {
  const out: number[] = [];
  for (let led = 0; led < ledCount; led++) if (strideLit(led, phase, p)) out.push(led);
  return out;
}
