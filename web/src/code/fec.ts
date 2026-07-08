/**
 * Extended-Hamming SEC-DED codewords — the TypeScript mirror of
 * `ledmapper_protocol/fec.py`. The two implementations MUST agree bit-for-bit;
 * `tests/fec.test.ts` checks this against a Python-generated golden
 * (`golden_secded16.json`) plus exhaustive corruption properties.
 *
 * Layout (canonical, see the Python module for the full rationale):
 * - Data word: `k` bits (bit 0 = LSB).
 * - Inner Hamming code, 1-indexed positions `1..k+r`, `r` minimal with
 *   `2^r >= k + r + 1`; power-of-two positions hold even parity, the rest
 *   hold data bits in increasing order.
 * - One overall even-parity bit over the inner word (extends distance to 4),
 *   transmitted LAST. Transmitted bit `j` = inner position `j+1`.
 *
 * Used as SEC-DED: single bit-frame errors are corrected, double errors are
 * detected and the cycle rejected — never miscorrected (a d=4 guarantee).
 */

/** Hamming parity bit count for `k` data bits (excluding overall parity). */
export function secdedParityBits(k: number): number {
  if (k < 1) throw new RangeError(`k must be >= 1, got ${k}`);
  let r = 1;
  while (1 << r < k + r + 1) r++;
  return r;
}

/** Total transmitted code bits for `k` data bits: k + r + 1. */
export function secdedTotalBits(k: number): number {
  return k + secdedParityBits(k) + 1;
}

function isPow2(x: number): boolean {
  return (x & (x - 1)) === 0;
}

function popcountParity(x: number): number {
  let p = 0;
  while (x) {
    p ^= x & 1;
    x >>>= 1;
  }
  return p;
}

/** Encode a `k`-bit data word; bit `j` of the result is transmission frame `j`. */
export function secdedEncode(data: number, k: number): number {
  if (data < 0 || data >>> k !== 0) {
    throw new RangeError(`data word ${data} does not fit in ${k} bits`);
  }
  const r = secdedParityBits(k);
  const mInner = k + r;
  let word = 0; // bit (pos-1) = inner position pos
  let bit = 0;
  for (let pos = 1; pos <= mInner; pos++) {
    if (isPow2(pos)) continue;
    if ((data >> bit) & 1) word |= 1 << (pos - 1);
    bit++;
  }
  for (let pLog = 0; pLog < r; pLog++) {
    const p = 1 << pLog;
    let parity = 0;
    for (let pos = 1; pos <= mInner; pos++) {
      if (pos & p && (word >> (pos - 1)) & 1) parity ^= 1;
    }
    if (parity) word |= 1 << (p - 1);
  }
  if (popcountParity(word)) word |= 1 << mInner;
  return word;
}

export interface SecdedResult {
  /** The decoded data word, or null when a double error was detected. */
  data: number | null;
  /** True when a single-bit error was corrected. */
  corrected: boolean;
}

/** Decode a received codeword: correct singles, reject doubles. */
export function secdedDecode(word: number, k: number): SecdedResult {
  const r = secdedParityBits(k);
  const mInner = k + r;
  if (word < 0 || word >>> (mInner + 1) !== 0) {
    throw new RangeError(`codeword ${word} does not fit in ${mInner + 1} bits`);
  }
  let syndrome = 0;
  for (let pos = 1; pos <= mInner; pos++) {
    if ((word >> (pos - 1)) & 1) syndrome ^= pos;
  }
  const overallOk = popcountParity(word) === 0;
  let corrected = false;
  if (syndrome === 0) {
    if (!overallOk) corrected = true; // the overall parity bit itself flipped
  } else if (overallOk) {
    return { data: null, corrected: false }; // double error: detected, rejected
  } else {
    if (syndrome > mInner) return { data: null, corrected: false };
    word ^= 1 << (syndrome - 1);
    corrected = true;
  }
  let data = 0;
  let bit = 0;
  for (let pos = 1; pos <= mInner; pos++) {
    if (isPow2(pos)) continue;
    if ((word >> (pos - 1)) & 1) data |= 1 << bit;
    bit++;
  }
  return { data, corrected };
}
