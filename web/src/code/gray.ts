/**
 * Gray-code cycle logic (design doc §8.1) — the TypeScript mirror of
 * `pi/led_driver/led_driver/graycode.py`. The two implementations MUST agree
 * frame-for-frame; `tests/gray.test.ts` checks this against a Python-generated
 * golden fixture.
 *
 * The cycle is:
 *
 *     [ ALL_ON ][ ALL_OFF ]               sync delimiter (self-clocking)
 *     [ bit 0  ][ bit 1 ] … [ bit B-1 ]   LED i lit iff bit b of gray(i) is set
 *
 * Bit 0 is the least-significant bit of the Gray code.
 */

import type { CodeParams } from "@ledmapper/protocol";

/** Binary-reflected Gray code of `i`. */
export function gray(i: number): number {
  return i ^ (i >> 1);
}

/** Inverse of {@link gray} — recover the index from its Gray code. */
export function decodeGray(value: number): number {
  let result = 0;
  while (value) {
    result ^= value;
    value >>= 1;
  }
  return result;
}

/** True iff bit `bit` of `gray(ledId)` is set (LED lit in that bit frame). */
export function grayBit(ledId: number, bit: number): boolean {
  return ((gray(ledId) >> bit) & 1) === 1;
}

/** Cycle-frame indices of the sync delimiter; data bit `b` is frame `2 + b`. */
export const FRAME_ALL_ON = 0;
export const FRAME_ALL_OFF = 1;
export const DATA_FRAME_OFFSET = 2;

/**
 * Is `ledId` lit in cycle frame `frameIndex` (0-based within one cycle)?
 * Mirrors `graycode.frame_plan` in the Python driver.
 */
export function ledLitInFrame(ledId: number, frameIndex: number, params: CodeParams): boolean {
  if (frameIndex < 0 || frameIndex >= params.cycleFrames) {
    throw new RangeError(`frameIndex ${frameIndex} outside cycle of ${params.cycleFrames}`);
  }
  if (frameIndex === FRAME_ALL_ON) return true;
  if (frameIndex === FRAME_ALL_OFF) return false;
  return grayBit(ledId, frameIndex - DATA_FRAME_OFFSET);
}

/**
 * Decode a full cycle's per-frame on/off observations into an LED id.
 * `frames[k]` is the observed on/off state in cycle frame `k`.
 * Returns null if the sync delimiter does not match (frame 0 must be on,
 * frame 1 off) or the decoded id is out of range.
 */
export function decodeCycle(frames: readonly boolean[], params: CodeParams): number | null {
  if (frames.length !== params.cycleFrames) return null;
  if (!frames[FRAME_ALL_ON] || frames[FRAME_ALL_OFF]) return null;
  let code = 0;
  for (let b = 0; b < params.bits; b++) {
    if (frames[DATA_FRAME_OFFSET + b]) code |= 1 << b;
  }
  const id = decodeGray(code);
  return id < params.ledCount ? id : null;
}
