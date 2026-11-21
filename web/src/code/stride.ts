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

import type { CodeParams } from "@ledmapper/protocol";
import { secded, syncCode } from "./gray";
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

// ---------------------------------------------------------------------------
// Rolling stride (docs/design/rolling-stride.md): the lit subset is a pure
// function of (LED, pattern-clock frame), so the phone never reconfigures to
// stride. Blocks of A·S LEDs each step their offset on their own clock (block
// b+1 one code cycle ahead of block b), every D code cycles; each LED lights
// for whole own cycles only; at a block boundary the later-started LED yields.
// ---------------------------------------------------------------------------

/** The welcome feature of a player that runs the rolling stride
 * (firmware/player FEATURE_STRIDE_ROLLING). */
export const FEATURE_STRIDE_ROLLING = "stride_rolling";

/** The dwell the phone asks for, in code cycles (the design doc's D = 4: three
 * whole own cycles per dwell under hue code v2, one more than the two
 * confirmations a decode needs). */
export const ROLLING_DWELL_CYCLES = 4;

export type StrideMode = "phased" | "rolling";

/** A `?stride=` debug override: "phased" or "rolling", else null. */
export function forcedStrideMode(v: string | null): StrideMode | null {
  return v === "phased" || v === "rolling" ? v : null;
}

/**
 * The stride schedule a capture asks a player for: rolling when the player
 * advertises it, otherwise nothing (older firmware runs phased). A `?stride=`
 * override wins. The phone follows whatever codeParams.strideMode the reply
 * carries, so the request is never a promise.
 */
export function requestedStrideMode(
  forced: StrideMode | null,
  features: readonly string[] | undefined,
): { strideMode: StrideMode; dwellCycles?: number } | null {
  const mode = forced ?? (features?.includes(FEATURE_STRIDE_ROLLING) ? "rolling" : null);
  if (mode === null) return null;
  return mode === "rolling" ? { strideMode: mode, dwellCycles: ROLLING_DWELL_CYCLES } : { strideMode: mode };
}

/** True when the device is driving a rolling stride (striding on, mode rolling):
 * the phone then never sends a stride phase. */
export function isRollingStride(params: Pick<CodeParams, "strideMode" | "strideSpacing">): boolean {
  return params.strideMode === "rolling" && (params.strideSpacing ?? 0) > 1;
}

export interface RollingGeometry {
  spacing: number;
  anchorDensity: number;
  dwellCycles: number;
  /** Physical LEDs on the strip (0 = unbounded). */
  ledCount: number;
  /** Group capture: LED i transmits id i + codeOffset. */
  codeOffset?: number;
}

/** The rolling geometry the device runs, from its CodeParams (null when it is
 * not running a rolling stride). `ledCount` is the physical strip length. */
export function rollingGeometry(params: CodeParams, ledCount: number): RollingGeometry | null {
  if (!isRollingStride(params)) return null;
  return {
    spacing: params.strideSpacing ?? 0,
    anchorDensity: params.anchorDensity ?? 3,
    dwellCycles: params.dwellCycles ?? ROLLING_DWELL_CYCLES,
    ledCount,
    codeOffset: params.codeOffset ?? 0,
  };
}

/** The dwell the kernel actually runs for a requested one (clamped). */
export function rollingDwell(dwellCycles: number): number {
  return kernel().pk_stride_rolling_dwell(Math.max(0, Math.floor(dwellCycles)));
}

/** Frames per rolling period (every LED lights once per period): S·D·C. */
export function rollingPeriodFrames(params: Pick<CodeParams, "cycleFrames">, g: RollingGeometry): number {
  return Math.max(1, Math.floor(g.spacing)) * rollingDwell(g.dwellCycles) * Math.max(1, params.cycleFrames);
}

/**
 * Is physical LED `led` lit at pattern-clock frame `seq` (ABSOLUTE frames since
 * the epoch, not reduced modulo the cycle) under the rolling stride? The same
 * kernel function the player masks with (`stride_lit_rolling`).
 */
export function strideLitRolling(led: number, seq: number, params: CodeParams, g: RollingGeometry): boolean {
  return (
    kernel().pk_stride_lit_rolling(
      led,
      Math.max(0, Math.floor(seq)),
      params.ledCount,
      params.bits,
      params.symbols,
      secded(params),
      syncCode(params),
      Math.max(0, Math.floor(g.spacing)),
      Math.max(0, Math.floor(g.anchorDensity)),
      Math.max(0, Math.floor(g.dwellCycles)),
      Math.max(0, Math.floor(g.ledCount)),
      Math.max(0, Math.floor(g.codeOffset ?? 0)),
    ) !== 0
  );
}
