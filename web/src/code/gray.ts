/**
 * Gray-code cycle logic (design doc §8.1) — the TypeScript mirror of
 * `pi/led_driver/led_driver/graycode.py`. The two implementations MUST agree
 * frame-for-frame; `tests/gray.test.ts` checks this against a Python-generated
 * golden fixture.
 *
 * The cycle is:
 *
 *     [ ALL_ON ][ ALL_OFF ]               sync delimiter (self-clocking)
 *     [ bit 0  ][ bit 1 ] … [ bit B-1 ]   LED i lit iff bit b of gray(i+1) is set
 *
 * Bit 0 is the least-significant bit of the Gray code.
 *
 * Codewords carry `id + CODE_OFFSET`, never the raw id: the all-zero data word
 * (dark in every data frame) is RESERVED-INVALID, because "dark except the
 * sync flash" is exactly what a blinking artifact (reflection, exposure
 * pumping) looks like — without the offset, LED 0 is a decode magnet.
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

/** Codewords are gray(id + CODE_OFFSET); the all-zero word is reserved-invalid. */
export const CODE_OFFSET = 1;

/** True iff bit `bit` of the codeword `gray(ledId + CODE_OFFSET)` is set. */
export function grayBit(ledId: number, bit: number): boolean {
  return ((gray(ledId + CODE_OFFSET) >> bit) & 1) === 1;
}

/** Cycle-frame indices of the sync delimiter; data bit `b` is frame `2 + b`. */
export const FRAME_ALL_ON = 0;
export const FRAME_ALL_OFF = 1;
export const DATA_FRAME_OFFSET = 2;

/**
 * `gray-hue` frame palette (§7.6 encoding variant): the same frame plan at
 * constant brightness, carried by COLOR. White + the three primaries maximize
 * pairwise camera-RGB separation (every pair differs by 2.0 in L1), and put
 * the sync axis (g − (r+b)/2) orthogonal to the bit axis (r − b). The decoder
 * reads hue RELATIVE to the track's own ALL_ON (white) frame, which cancels
 * white balance / color correction exactly and makes static-hue clutter
 * normalize to neutral (failing the green sync).
 */
export const HUE_FRAME_COLORS = {
  /** ALL_ON: per-track color reference (measures the camera channel gains). */
  allOn: "#ffffff",
  /** ALL_OFF: chroma-domain sync delimiter. */
  allOff: "#00ff00",
  bit1: "#ff0000",
  bit0: "#0000ff",
} as const;

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
  const id = decodeGray(code) - CODE_OFFSET;
  // id < 0 is the reserved all-zero word — dark data frames, i.e. noise.
  return id >= 0 && id < params.ledCount ? id : null;
}
