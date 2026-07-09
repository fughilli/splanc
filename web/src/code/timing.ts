/**
 * Pattern-clock timing (design doc §8.2): map a server-clock time to a
 * position in the repeating Gray-code cycle. Shared by the decoder (M6) and
 * the virtual LED wall, so a wall pixel and the phone's bit-window sampling
 * can never disagree about which frame is showing.
 */

import type { CodeParams } from "@ledmapper/protocol";

/** Length of one full cycle in milliseconds. */
export function cycleMs(params: CodeParams): number {
  return params.cycleFrames * params.bitPeriodMs;
}

/** Non-negative phase in ms within the current cycle. */
export function phaseMs(tServerMs: number, epochMs: number, params: CodeParams): number {
  const cycle = cycleMs(params);
  let phase = (tServerMs - epochMs) % cycle;
  if (phase < 0) phase += cycle;
  return phase;
}

/** Cycle frame index (0..cycleFrames-1) showing at server time `tServerMs`. */
export function frameIndexAt(tServerMs: number, epochMs: number, params: CodeParams): number {
  const idx = Math.floor(phaseMs(tServerMs, epochMs, params) / params.bitPeriodMs);
  // Guard the phase == cycleMs float edge case.
  return Math.min(params.cycleFrames - 1, idx);
}

/** Which cycle (integer, may be negative before the epoch) contains `tServerMs`. */
export function cycleIndexAt(tServerMs: number, epochMs: number, params: CodeParams): number {
  return Math.floor((tServerMs - epochMs) / cycleMs(params));
}

/**
 * Fraction [0, 1) through the current frame window. The decoder discards
 * samples near window edges (bit transitions + rolling shutter smear).
 */
export function frameFractionAt(tServerMs: number, epochMs: number, params: CodeParams): number {
  const phase = phaseMs(tServerMs, epochMs, params);
  return (phase % params.bitPeriodMs) / params.bitPeriodMs;
}
