/**
 * Hue-code cycle logic (design doc §8.1, hue-only revision): thin typed
 * wrappers over the Rust hue-code kernel (//firmware/pattern, loaded as wasm by
 * ./kernel.ts). The kernel is the ONE implementation — the players link the
 * same crate — so the phone cannot disagree with the firmware about a
 * codeword, a symbol or a palette colour. Only argument validation, the
 * normalized palette the CV code measures against, and CSS helpers live here.
 *
 * The cycle is:
 *
 *     [ ALL_ON: white ][ ALL_OFF: green ]       sync delimiter (self-clocking)
 *     [ symbol 0 ] … [ symbol D-1 ]             data, log2(symbols) bits each
 *
 * Every LED is lit EVERY frame at constant brightness — the code is carried
 * entirely by COLOR. White is the per-track color reference (cancels white
 * balance / color correction exactly); green is the chroma sync; the data
 * palette depends on the negotiated alphabet:
 *
 *  - symbols=2: bit 1 → red, bit 0 → blue (maximum hue separation).
 *  - symbols=4: 2 bits/frame from the hue-adjacent path blue → magenta →
 *    red → yellow carrying binary-reflected-Gray bit pairs 00 → 01 → 11 →
 *    10, so the DOMINANT misread (confusing adjacent hues) flips exactly
 *    one bit — which SEC-DED corrects.
 *
 * With fec="secded" (the default code-book) the codeword is gray(i+1)
 * wrapped in an extended-Hamming distance-4 code (./fec.ts): one decisively
 * misread BIT is corrected, two are detected and the cycle rejected.
 *
 * Codewords carry `id + CODE_OFFSET`, never the raw id: the all-zero data
 * word is RESERVED-INVALID (see docs/decisions.md).
 */

import type { CodeParams } from "@ledmapper/protocol";
import {
  FLAG_CORRECTED,
  FLAG_MALFORMED,
  FLAG_UNCORRECTABLE,
  FLAG_VALUE,
  kernel,
  SYMBOL_BUF_LEN,
  VALUE_MASK,
} from "./kernel";

const secded = (params: CodeParams): number => ((params.fec ?? "none") === "secded" ? 1 : 0);

/** SEC-DED encodes gray(id+1) as a dataBits(ledCount)-bit word: an id whose
 * word does not fit is a caller bug (fec.ts secdedEncode's RangeError). */
function checkEncodable(ledId: number, params: CodeParams): void {
  if (!secded(params)) return;
  const k = kernel();
  const data = k.pk_gray(ledId + CODE_OFFSET);
  const bits = k.pk_data_bits(params.ledCount);
  if (data < 0 || data >>> bits !== 0) {
    throw new RangeError(`data word ${data} does not fit in ${bits} bits`);
  }
}

/** Binary-reflected Gray code of `i`. */
export function gray(i: number): number {
  return kernel().pk_gray(i);
}

/** Inverse of {@link gray} — recover the index from its Gray code. */
export function decodeGray(value: number): number {
  return kernel().pk_decode_gray(value);
}

/** Codewords are gray(id + CODE_OFFSET); the all-zero word is reserved-invalid.
 * (A protocol constant, pinned to the kernel's by tests/gray.test.ts.) */
export const CODE_OFFSET = 1;

/** Gray data-word width for `ledCount` LEDs (codewords carry id+1). */
export function dataBits(ledCount: number): number {
  return kernel().pk_data_bits(ledCount);
}

/**
 * The TRANSMITTED codeword for `ledId`: the Gray data word, wrapped in the
 * extended-Hamming d=4 code with fec="secded". Bits are sent log2(symbols)
 * per data frame, least-significant first.
 */
export function codewordForId(ledId: number, params: CodeParams): number {
  checkEncodable(ledId, params);
  return kernel().pk_codeword(ledId, params.ledCount, secded(params));
}

/** Transmitted code-bit count implied by ledCount + fec (consistency). */
export function expectedBits(params: CodeParams): number {
  return kernel().pk_expected_bits(params.ledCount, secded(params));
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
  bitsPerSymbol(params); // validate the alphabet
  return kernel().pk_data_frames(params.bits, params.symbols);
}

/** The symbol VALUE `ledId` transmits in data frame `frame`. */
export function symbolAt(ledId: number, frame: number, params: CodeParams): number {
  bitsPerSymbol(params);
  checkEncodable(ledId, params);
  return kernel().pk_symbol_at(ledId, frame, params.ledCount, params.symbols, secded(params));
}

/** Cycle-frame indices of the sync delimiter; data frame d is frame 2 + d.
 * (Protocol constants, pinned to the kernel's by tests/gray.test.ts.) */
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

/** The kernel's `Color` discriminants (firmware/pattern/src/lib.rs) -> the
 * normalized colour the CV code measures against. */
const COLOR_BY_INDEX: readonly Rgb[] = [
  COLOR_WHITE,
  COLOR_GREEN,
  COLOR_RED,
  COLOR_BLUE,
  COLOR_MAGENTA,
  COLOR_YELLOW,
];

/**
 * Symbol value → palette color, per alphabet: the decoder's classification
 * targets. symbols=4 assigns values along the hue-adjacent path blue(240°) →
 * magenta(300°) → red(0°) → yellow(60°) in binary-reflected Gray order
 * (00, 01, 11, 10). Pinned to the kernel's `symbol_color` by
 * tests/gray.test.ts.
 */
export const SYMBOL_COLORS: Record<number, readonly Rgb[]> = {
  2: [COLOR_BLUE, COLOR_RED],
  4: [COLOR_BLUE, COLOR_MAGENTA, COLOR_YELLOW, COLOR_RED],
};

/** The normalized colour for a kernel `Color` discriminant. */
export function colorOfIndex(index: number): Rgb {
  const c = COLOR_BY_INDEX[index];
  if (c === undefined) throw new RangeError(`kernel returned unknown color ${index}`);
  return c;
}

/** CSS hex for a normalized palette color (wall page rendering). */
export function cssColor(c: Rgb): string {
  const h = (v: number): string => (v >= 1 ? "ff" : "00");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/** The color `ledId` shows in cycle frame `frameIndex` (0-based within one cycle). */
export function colorForFrame(ledId: number, frameIndex: number, params: CodeParams): Rgb {
  if (frameIndex < 0 || frameIndex >= params.cycleFrames) {
    throw new RangeError(`frameIndex ${frameIndex} outside cycle of ${params.cycleFrames}`);
  }
  if (frameIndex >= DATA_FRAME_OFFSET) {
    bitsPerSymbol(params);
    checkEncodable(ledId, params);
  }
  return colorOfIndex(
    kernel().pk_color_index(ledId, frameIndex, params.ledCount, params.symbols, secded(params)),
  );
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
  if (symbols.length !== dataFrames(params) || symbols.length > SYMBOL_BUF_LEN) return none;
  const k = kernel();
  const buf = new Uint8Array(k.memory.buffer, k.pk_symbol_buf(), symbols.length);
  for (let d = 0; d < symbols.length; d++) buf[d] = symbols[d]!;
  const r = k.pk_decode_cycle(symbols.length, params.ledCount, params.bits, params.symbols, secded(params));
  if ((r & FLAG_MALFORMED) !== 0) {
    // The code-book's `bits` exceed the SEC-DED width its ledCount implies.
    const width = k.pk_secded_total_bits(k.pk_data_bits(params.ledCount));
    throw new RangeError(`codeword ${r & (FLAG_MALFORMED - 1)} does not fit in ${width} bits`);
  }
  return {
    id: (r & FLAG_VALUE) !== 0 ? r & VALUE_MASK : null,
    corrected: (r & FLAG_CORRECTED) !== 0,
    uncorrectable: (r & FLAG_UNCORRECTABLE) !== 0,
  };
}
