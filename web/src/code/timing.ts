/**
 * Pattern-clock timing (design doc §8.2): map a server-clock time to a
 * position in the repeating hue-code cycle. Thin wrappers over the Rust
 * hue-code kernel's float clock (//firmware/pattern `timing`, loaded as wasm by
 * ./kernel.ts). Shared by the decoder and the virtual LED wall, so a wall pixel
 * and the phone's bit-window sampling can never disagree about which frame is
 * showing.
 */

import type { CodeParams } from "@ledmapper/protocol";
import { kernel } from "./kernel";

/** Length of one full cycle in milliseconds. */
export function cycleMs(params: CodeParams): number {
  return kernel().pk_cycle_ms(params.cycleFrames, params.bitPeriodMs);
}

/** Non-negative phase in ms within the current cycle. */
export function phaseMs(tServerMs: number, epochMs: number, params: CodeParams): number {
  return kernel().pk_phase_ms(tServerMs, epochMs, params.cycleFrames, params.bitPeriodMs);
}

/** Cycle frame index (0..cycleFrames-1) showing at server time `tServerMs`. */
export function frameIndexAt(tServerMs: number, epochMs: number, params: CodeParams): number {
  return kernel().pk_frame_index_at(tServerMs, epochMs, params.cycleFrames, params.bitPeriodMs);
}

/** Which cycle (integer, may be negative before the epoch) contains `tServerMs`. */
export function cycleIndexAt(tServerMs: number, epochMs: number, params: CodeParams): number {
  return kernel().pk_cycle_index_at(tServerMs, epochMs, params.cycleFrames, params.bitPeriodMs);
}

/**
 * Fraction [0, 1) through the current frame window. The decoder discards
 * samples near window edges (bit transitions + rolling shutter smear).
 */
export function frameFractionAt(tServerMs: number, epochMs: number, params: CodeParams): number {
  return kernel().pk_frame_fraction_at(tServerMs, epochMs, params.cycleFrames, params.bitPeriodMs);
}
