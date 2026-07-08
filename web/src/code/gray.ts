/**
 * Gray-code cycle logic (design doc §8.1) — the TypeScript mirror of
 * `pi/led_driver/led_driver/graycode.py`. The two implementations MUST agree
 * frame-for-frame; `tests/gray.test.ts` checks this against a Python-generated
 * golden fixture.
 *
 * The cycle is:
 *
 *     [ ALL_ON ][ ALL_OFF ]               sync delimiter (self-clocking)
 *     [ bit 0  ][ bit 1 ] … [ bit B-1 ]   LED i lit iff bit b of codeword(i) is set
 *
 * With fec="secded" (the default code-book since 2026-07-08) codeword(i) is
 * gray(i+1) wrapped in an extended-Hamming distance-4 code (./fec.ts): one
 * decisively-misread bit window is CORRECTED, two are DETECTED and the cycle
 * rejected. The raw Gray codebook has distance 1 — without FEC a single wrong
 * window decodes to a valid WRONG id. fec="none" transmits gray(i+1) bare.
 * Bit 0 is the least-significant transmitted code bit.
 *
 * Codewords carry `id + CODE_OFFSET`, never the raw id: the all-zero data word
 * (dark in every data frame) is RESERVED-INVALID, because "dark except the
 * sync flash" is exactly what a blinking artifact (reflection, exposure
 * pumping) looks like — without the offset, LED 0 is a decode magnet.
 */

import type { CodeParams } from "@ledmapper/protocol";
import { secdedDecode, secdedEncode, secdedTotalBits } from "./fec";

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

/** True iff bit `bit` of the raw data word `gray(ledId + CODE_OFFSET)` is set
 * (fec="none" code-books only). */
export function grayBit(ledId: number, bit: number): boolean {
  return ((gray(ledId + CODE_OFFSET) >> bit) & 1) === 1;
}

/** Gray data-word width for `ledCount` LEDs (codewords carry id+1). */
export function dataBits(ledCount: number): number {
  return Math.max(1, Math.ceil(Math.log2(ledCount + CODE_OFFSET)));
}

/**
 * The TRANSMITTED codeword for `ledId`: bit `b` is the LED's state in bit
 * frame `b`. With fec="secded" (the default code-book) the Gray data word is
 * wrapped in an extended-Hamming d=4 code (see ./fec.ts) — single misread
 * windows become correctable instead of decoding to a valid wrong id.
 * Mirrors `graycode.codeword` in the Python driver.
 */
export function codewordForId(ledId: number, params: CodeParams): number {
  const data = gray(ledId + CODE_OFFSET);
  if ((params.fec ?? "none") === "secded") {
    return secdedEncode(data, dataBits(params.ledCount));
  }
  return data;
}

/** Transmitted bit-frame count implied by ledCount + fec (consistency). */
export function expectedBits(params: CodeParams): number {
  const k = dataBits(params.ledCount);
  return (params.fec ?? "none") === "secded" ? secdedTotalBits(k) : k;
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
  return ((codewordForId(ledId, params) >> (frameIndex - DATA_FRAME_OFFSET)) & 1) === 1;
}

export interface CycleDecode {
  /** The decoded LED id, or null (see the flags for why). */
  id: number | null;
  /** SEC-DED corrected a single misread bit frame. */
  corrected: boolean;
  /** SEC-DED detected a double error — rejected, not miscorrected. */
  uncorrectable: boolean;
}

/**
 * Decode a full cycle's per-frame on/off observations into an LED id.
 * `frames[k]` is the observed on/off state in cycle frame `k`.
 * `id` is null if the sync delimiter does not match (frame 0 must be on,
 * frame 1 off), the FEC detects an uncorrectable error, or the decoded id
 * is out of range.
 */
export function decodeCycleEx(frames: readonly boolean[], params: CodeParams): CycleDecode {
  const none: CycleDecode = { id: null, corrected: false, uncorrectable: false };
  if (frames.length !== params.cycleFrames) return none;
  if (!frames[FRAME_ALL_ON] || frames[FRAME_ALL_OFF]) return none;
  let code = 0;
  for (let b = 0; b < params.bits; b++) {
    if (frames[DATA_FRAME_OFFSET + b]) code |= 1 << b;
  }
  let corrected = false;
  if ((params.fec ?? "none") === "secded") {
    const res = secdedDecode(code, dataBits(params.ledCount));
    if (res.data === null) return { id: null, corrected: false, uncorrectable: true };
    code = res.data;
    corrected = res.corrected;
  }
  const id = decodeGray(code) - CODE_OFFSET;
  // id < 0 is the reserved all-zero word — dark data frames, i.e. noise.
  return {
    id: id >= 0 && id < params.ledCount ? id : null,
    corrected,
    uncorrectable: false,
  };
}

/** Back-compat convenience over {@link decodeCycleEx}. */
export function decodeCycle(frames: readonly boolean[], params: CodeParams): number | null {
  return decodeCycleEx(frames, params).id;
}
