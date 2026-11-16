/**
 * Extended-Hamming SEC-DED codewords: thin typed wrappers over the Rust
 * hue-code kernel (//firmware/pattern — see its SEC-DED section for the
 * canonical layout; loaded as wasm by ./kernel.ts). Only argument validation
 * lives here.
 *
 * Layout: data word `k` bits; inner Hamming positions `1..k+r` (`r` minimal
 * with `2^r >= k + r + 1`, power-of-two positions hold even parity); one
 * overall even-parity bit transmitted LAST. Single bit-frame errors are
 * corrected, double errors detected and the cycle rejected — never
 * miscorrected (a d=4 guarantee).
 */

import { FLAG_CORRECTED, FLAG_VALUE, kernel, VALUE_MASK } from "./kernel";

/** Hamming parity bit count for `k` data bits (excluding overall parity). */
export function secdedParityBits(k: number): number {
  if (k < 1) throw new RangeError(`k must be >= 1, got ${k}`);
  return kernel().pk_secded_parity_bits(k);
}

/** Total transmitted code bits for `k` data bits: k + r + 1. */
export function secdedTotalBits(k: number): number {
  secdedParityBits(k); // validate k
  return kernel().pk_secded_total_bits(k);
}

/** Encode a `k`-bit data word; bit `j` of the result is transmission frame `j`. */
export function secdedEncode(data: number, k: number): number {
  if (data < 0 || data >>> k !== 0) {
    throw new RangeError(`data word ${data} does not fit in ${k} bits`);
  }
  secdedParityBits(k);
  return kernel().pk_secded_encode(data, k);
}

export interface SecdedResult {
  /** The decoded data word, or null when a double error was detected. */
  data: number | null;
  /** True when a single-bit error was corrected. */
  corrected: boolean;
}

/** Decode a received codeword: correct singles, reject doubles. */
export function secdedDecode(word: number, k: number): SecdedResult {
  const mInner = k + secdedParityBits(k);
  if (word < 0 || word >>> (mInner + 1) !== 0) {
    throw new RangeError(`codeword ${word} does not fit in ${mInner + 1} bits`);
  }
  const r = kernel().pk_secded_decode(word, k);
  if ((r & FLAG_VALUE) === 0) return { data: null, corrected: false };
  return { data: r & VALUE_MASK, corrected: (r & FLAG_CORRECTED) !== 0 };
}
