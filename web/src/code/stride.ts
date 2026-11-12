/**
 * Diffuse-capture striding schedule (docs/design/strided-capture.md): thin
 * typed wrappers over the Rust hue-code kernel (//firmware/pattern
 * `stride_lit`, loaded as wasm by ./kernel.ts) — the SAME function the players
 * run to mask their output, so the phone's capture rotation and the fixture
 * can never disagree about which LEDs a phase lights.
 *
 * On a diffused fixture, lighting every LED every frame blends adjacent spots
 * into one blob. Instead only a SPARSE, spatially-separated subset is lit per
 * epoch ("phase"), rotating to cover every LED: `S` COVERAGE phases (uniform
 * stride-`S`, offset +1 per phase) plus `S-1` FUSION "bridge" phases forming a
 * registration star through class 0 (anchor reps every `A·S` LEDs + a class-`j`
 * rep in each block's gap, all ≥ `S` apart for `A ≥ 3`). Each lit LED still
 * transmits its own full hue code, so ids stay absolute.
 */

import { kernel } from "./kernel";

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
   * lit spots stay ≥ `S` apart; smaller values are clamped up (by the kernel).
   */
  anchorDensity: number;
}

/** `S` as the kernel takes it: integral, and <= 1 (striding off) for anything below 2. */
function spacingOf(p: StrideParams): number {
  return Math.max(0, Math.floor(p.spacing));
}

/**
 * Number of phases in one full schedule: `S` coverage + `S-1` bridges = `2S-1`.
 * `1` when striding is disabled (`S <= 1`).
 */
export function phaseCount(p: StrideParams): number {
  return kernel().pk_stride_phase_count(spacingOf(p));
}

/** True for the coverage phases (`0 .. S-1`); the rest are bridges. */
export function isCoveragePhase(phase: number, p: StrideParams): boolean {
  return phase < Math.floor(p.spacing);
}

/**
 * Is `led` lit in phase `phase` (`0 .. phaseCount-1`)?
 *
 * `S <= 1` ⇒ always lit (striding disabled). Out-of-range phases wrap (a
 * negative phase counts back from the end) so the caller can advance a running
 * counter without bounds-checking. `led` is a non-negative LED index.
 */
export function strideLit(led: number, phase: number, p: StrideParams): boolean {
  const s = spacingOf(p);
  const k = kernel();
  const n = k.pk_stride_phase_count(s);
  const ph = ((phase % n) + n) % n;
  return k.pk_stride_lit(led, ph, s, Math.max(0, Math.floor(p.anchorDensity))) !== 0;
}

/** The lit LED indices of `[0, ledCount)` in `phase` (helper for tests/UI). */
export function litLeds(ledCount: number, phase: number, p: StrideParams): number[] {
  const out: number[] = [];
  for (let led = 0; led < ledCount; led++) if (strideLit(led, phase, p)) out.push(led);
  return out;
}
