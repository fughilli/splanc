/**
 * Hue-code cycle logic (design doc §8.1, hue-only revision) — the TypeScript
 * mirror of `pi/led_driver/led_driver/graycode.py`. The two implementations
 * MUST agree frame-for-frame; `tests/gray.test.ts` checks this against
 * Python-generated golden fixtures (both alphabets).
 *
 * The cycle is:
 *
 *     [ ALL_ON: white ][ ALL_OFF: green ]       sync delimiter (self-clocking)
 *     [ symbol 0 ] … [ symbol D-1 ]             data, log2(symbols) bits each
 *
 * Every LED is lit EVERY frame at constant brightness — the code is carried
 * entirely by COLOR. This is the only carrier: the old intensity ("gray")
 * blink code was removed because its dark frames made blobs disappear, which
 * broke cross-frame track association (the tracker had to coast blind
 * through every 0-bit). White is the per-track color reference (cancels
 * white balance / color correction exactly); green is the chroma sync; the
 * data palette depends on the negotiated alphabet:
 *
 *  - symbols=2: bit 1 → red, bit 0 → blue (maximum hue separation).
 *  - symbols=4: 2 bits/frame from the hue-adjacent path blue → magenta →
 *    red → yellow carrying binary-reflected-Gray bit pairs 00 → 01 → 11 →
 *    10, so the DOMINANT misread (confusing adjacent hues) flips exactly
 *    one bit — which SEC-DED corrects. Halves the data frames; negotiated
 *    when the measured chroma SNR is good.
 *
 * With fec="secded" (the default code-book) the codeword is gray(i+1)
 * wrapped in an extended-Hamming distance-4 code (./fec.ts): one decisively
 * misread BIT is corrected, two are detected and the cycle rejected.
 *
 * Codewords carry `id + CODE_OFFSET`, never the raw id: the all-zero data
 * word is RESERVED-INVALID (without the offset, LED 0 is a decode magnet
 * for blinking artifacts — see docs/decisions.md).
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

/** Gray data-word width for `ledCount` LEDs (codewords carry id+1). */
export function dataBits(ledCount: number): number {
  return Math.max(1, Math.ceil(Math.log2(ledCount + CODE_OFFSET)));
}

/**
 * The TRANSMITTED codeword for `ledId`: the Gray data word, wrapped in the
 * extended-Hamming d=4 code with fec="secded" (see ./fec.ts). Bits are sent
 * log2(symbols) per data frame, least-significant first. Mirrors
 * `graycode.codeword` in the Python driver.
 */
export function codewordForId(ledId: number, params: CodeParams): number {
  const data = gray(ledId + CODE_OFFSET);
  if ((params.fec ?? "none") === "secded") {
    return secdedEncode(data, dataBits(params.ledCount));
  }
  return data;
}

/** Transmitted code-bit count implied by ledCount + fec (consistency). */
export function expectedBits(params: CodeParams): number {
  const k = dataBits(params.ledCount);
  return (params.fec ?? "none") === "secded" ? secdedTotalBits(k) : k;
}

/** Bits carried per data frame: log2 of the symbol alphabet. */
export function bitsPerSymbol(params: CodeParams): number {
  if (params.symbols !== 2 && params.symbols !== 4) {
    throw new RangeError(`unsupported symbol alphabet ${params.symbols}`);
  }
  return params.symbols === 2 ? 1 : 2;
}

/** Data-frame count: ceil(bits / bitsPerSymbol); the last frame's high bit
 * is zero-padded when bits is odd. */
export function dataFrames(params: CodeParams): number {
  return Math.ceil(params.bits / bitsPerSymbol(params));
}

/** The symbol VALUE `ledId` transmits in data frame `frame`. */
export function symbolAt(ledId: number, frame: number, params: CodeParams): number {
  const bps = bitsPerSymbol(params);
  return (codewordForId(ledId, params) >> (frame * bps)) & ((1 << bps) - 1);
}

/** Cycle-frame indices of the sync delimiter; data frame d is frame 2 + d. */
export const FRAME_ALL_ON = 0;
export const FRAME_ALL_OFF = 1;
export const DATA_FRAME_OFFSET = 2;

/** Normalized-RGB palette targets (what an ideal camera measures after
 * dividing by the white reference). Green is reserved for the sync; cyan is
 * unused (it scores on the green sync axis). */
export type Rgb = readonly [number, number, number];
export const COLOR_WHITE: Rgb = [1, 1, 1];
export const COLOR_GREEN: Rgb = [0, 1, 0];
export const COLOR_RED: Rgb = [1, 0, 0];
export const COLOR_BLUE: Rgb = [0, 0, 1];
export const COLOR_MAGENTA: Rgb = [1, 0, 1];
export const COLOR_YELLOW: Rgb = [1, 1, 0];

/**
 * Symbol value → palette color, per alphabet. symbols=4 assigns values
 * along the hue-adjacent path blue(240°) → magenta(300°) → red(0°) →
 * yellow(60°) in binary-reflected Gray order (00, 01, 11, 10): adjacent-hue
 * confusion flips one bit. Mirrors `graycode.SYMBOL_COLORS`; pinned by the
 * goldens.
 */
export const SYMBOL_COLORS: Record<number, readonly Rgb[]> = {
  2: [COLOR_BLUE, COLOR_RED],
  4: [COLOR_BLUE, COLOR_MAGENTA, COLOR_YELLOW, COLOR_RED],
};

/** CSS hex for a normalized palette color (wall page rendering). */
export function cssColor(c: Rgb): string {
  const h = (v: number): string => (v >= 1 ? "ff" : "00");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/**
 * The color `ledId` shows in cycle frame `frameIndex` (0-based within one
 * cycle). Mirrors `graycode.color_for_frame` in the Python driver.
 */
export function colorForFrame(ledId: number, frameIndex: number, params: CodeParams): Rgb {
  if (frameIndex < 0 || frameIndex >= params.cycleFrames) {
    throw new RangeError(`frameIndex ${frameIndex} outside cycle of ${params.cycleFrames}`);
  }
  if (frameIndex === FRAME_ALL_ON) return COLOR_WHITE;
  if (frameIndex === FRAME_ALL_OFF) return COLOR_GREEN;
  const value = symbolAt(ledId, frameIndex - DATA_FRAME_OFFSET, params);
  return SYMBOL_COLORS[params.symbols]![value]!;
}

export interface CycleDecode {
  /** The decoded LED id, or null (see the flags for why). */
  id: number | null;
  /** SEC-DED corrected a single misread bit. */
  corrected: boolean;
  /** SEC-DED detected a double error — rejected, not miscorrected. */
  uncorrectable: boolean;
}

/**
 * Decode one cycle's per-data-frame symbol values into an LED id.
 * `symbols[d]` is the observed symbol value in data frame `d` (the caller
 * has already verified the white/green sync delimiter). `id` is null if the
 * FEC detects an uncorrectable error or the decoded id is out of range.
 */
export function decodeCycleSymbols(symbols: readonly number[], params: CodeParams): CycleDecode {
  const none: CycleDecode = { id: null, corrected: false, uncorrectable: false };
  if (symbols.length !== dataFrames(params)) return none;
  const bps = bitsPerSymbol(params);
  let code = 0;
  for (let d = 0; d < symbols.length; d++) {
    code |= symbols[d]! << (d * bps);
  }
  code &= (1 << params.bits) - 1; // drop the zero-padded high bit
  let corrected = false;
  if ((params.fec ?? "none") === "secded") {
    const res = secdedDecode(code, dataBits(params.ledCount));
    if (res.data === null) return { id: null, corrected: false, uncorrectable: true };
    code = res.data;
    corrected = res.corrected;
  }
  const id = decodeGray(code) - CODE_OFFSET;
  // id < 0 is the reserved all-zero word — a dark/noise artifact.
  return {
    id: id >= 0 && id < params.ledCount ? id : null,
    corrected,
    uncorrectable: false,
  };
}
