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

/** 1 when the code book carries SEC-DED (the kernel ABI's flag). */
export const secded = (params: CodeParams): number => ((params.fec ?? "none") === "secded" ? 1 : 0);

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
  if (isPruned(params)) {
    return kernel().pk_symbol_at_coded(
      codedIndex(ledId, params),
      frame,
      params.ledCount,
      params.bits,
      params.symbols,
      secded(params),
      syncCode(params),
    );
  }
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

// -- hue code v2 phase 2: staggered cycles with a pilot ---------------------
//
// Under `syncPattern: "stagger_pilot"` LED `id` (the CODED id: LED +
// codeOffset) runs its cycle rotated by `staggerPhase(id)` =
// (id * S + h(id div C)) mod C (C = cycleFrames; h the kernel's keyed
// per-block offset, which makes the map non-linear across blocks of C ids so
// the decoder's phase check passes a wrong id at the ~1/C chance rate), and
// its sync position shows the PALETTE PILOT: a
// short fixed run of the active alphabet's own colours (2 symbols: blue, blue,
// red, red, blue; 4 symbols: blue, yellow, magenta), so no hue is reserved
// (docs/design/hue-code-v2.md). The pilot is unique by code-book PRUNING: ids
// map, in order, to the coded indices whose whole cycle contains the pilot
// only at its sync position — a wider data word, so `bits` / `cycleFrames`
// come from the kernel's pruned derivation (codeBookFor). All of it — the
// rotation, the pilot, the pruning and the id <-> index map — is the kernel's;
// callers keep passing the GLOBAL cycle frame. "stagger_white" (v1's
// white/green) and "stagger_gm" (green/magenta, the first draft) are NOT wire
// values: the link simulator's comparators, over the unpruned v1 book.

/** The staggered-pilot wire value of `CodeParams.syncPattern`. */
export const SYNC_STAGGER_PILOT = "stagger_pilot";
/** Simulation-only comparator (not on the wire): v1's white/green, staggered. */
export const SYNC_STAGGER_WHITE = "stagger_white";
/** Simulation-only comparator (not on the wire): green/magenta, staggered. */
export const SYNC_STAGGER_GM = "stagger_gm";

/** The kernel's sync-pattern code (kernel_abi.rs `SyncPattern::from_code`). */
export function syncCode(params: CodeParams): number {
  const s = params.syncPattern as string;
  if (s === SYNC_STAGGER_PILOT) return 1;
  if (s === SYNC_STAGGER_WHITE) return 2;
  if (s === SYNC_STAGGER_GM) return 3;
  return 0; // "on_off" (v1), and anything unknown
}

/** True when the code-book's sync positions are staggered per LED. */
export function isStaggered(params: CodeParams): boolean {
  return syncCode(params) !== 0;
}

/** True when the code book is pruned for pilot uniqueness (stagger_pilot). */
export function isPruned(params: CodeParams): boolean {
  return syncCode(params) === 1;
}

/** The stagger step S for a cycle of `cycleFrames` frames. */
export function staggerStep(cycleFrames: number): number {
  return kernel().pk_stagger_step(cycleFrames);
}

/** Coded id `ledId`'s phase rotation: its sync position starts at global
 * cycle frame `staggerPhase` (0 under v1). */
export function staggerPhase(ledId: number, params: CodeParams): number {
  return kernel().pk_stagger_phase(ledId, params.ledCount, params.bits, params.symbols, secded(params), syncCode(params));
}

/** Frames of the sync position: the palette pilot's length under
 * stagger_pilot (5 at 2 symbols, 3 at 4), else 2. */
export function syncFrames(params: CodeParams): number {
  return kernel().pk_sync_frames(params.symbols, syncCode(params));
}

/** The sync-position colours in order: v1 / stagger_white white → green,
 * stagger_gm green → magenta, stagger_pilot the palette pilot. */
export function syncColors(params: CodeParams): readonly Rgb[] {
  const k = kernel();
  const sync = syncCode(params);
  const out: Rgb[] = [];
  for (let j = 0; j < syncFrames(params); j++) out.push(colorOfIndex(k.pk_sync_color(sync, params.symbols, j)));
  return out;
}

/** The code book (bits, cycleFrames) a fixture gets under `sync`: the v1 one
 * for every unpruned pattern, the kernel's pruned derivation for
 * stagger_pilot (it counts the book once: call per capture, not per frame). */
export function codeBookFor(
  ledCount: number,
  symbols: number,
  fec: string,
  sync: string,
): { bits: number; cycleFrames: number } {
  const k = kernel();
  const sd = fec === "secded" ? 1 : 0;
  const code = syncCode({ syncPattern: sync } as unknown as CodeParams);
  if (code === 0) return { bits: k.pk_expected_bits(ledCount, sd), cycleFrames: k.pk_cycle_frames(ledCount, symbols, sd) };
  return {
    bits: k.pk_expected_bits_sync(ledCount, symbols, sd, code),
    cycleFrames: k.pk_cycle_frames_sync(ledCount, symbols, sd, code),
  };
}

/**
 * A `?sync=` query value as a sync-pattern request/override (test pages: the
 * capture screen requests it, the wall forces its rendering). Null when absent
 * or unknown ("v1" is accepted for "on_off"); the comparators are accepted for
 * simulation only.
 */
export function forcedSyncPattern(value: string | null): CodeParams["syncPattern"] | null {
  if (value === null) return null;
  const v = value.trim().toLowerCase().replace(/-/g, "_");
  if (v === "on_off" || v === "v1") return "on_off";
  if (v === SYNC_STAGGER_PILOT || v === "stagger" || v === "pilot") return SYNC_STAGGER_PILOT;
  if (v === SYNC_STAGGER_WHITE || v === SYNC_STAGGER_GM) return v as CodeParams["syncPattern"];
  return null;
}

/** The welcome feature of a player that runs the hue code v2 staggered pilot
 * (firmware/player FEATURE_STAGGER_PILOT). */
export const FEATURE_STAGGER_PILOT = "hue_stagger_pilot";

/**
 * The sync pattern a capture asks a player for: the staggered pilot when the
 * player advertises it, otherwise nothing (older firmware runs v1). A `?sync=`
 * override (debug only) wins. The phone decodes whatever codeParams.syncPattern
 * the player answers with, so the request is never a promise.
 */
export function requestedSyncPattern(
  forced: CodeParams["syncPattern"] | null,
  features: readonly string[] | undefined,
): CodeParams["syncPattern"] | null {
  if (forced !== null) return forced;
  return features?.includes(FEATURE_STAGGER_PILOT) ? (SYNC_STAGGER_PILOT as CodeParams["syncPattern"]) : null;
}

/** `params` under another sync pattern (null = unchanged): the code book is
 * re-derived (a pruned book is wider). */
export function withSyncPattern(params: CodeParams, sync: CodeParams["syncPattern"] | null): CodeParams {
  if (sync === null || sync === params.syncPattern) return params;
  const book = codeBookFor(params.ledCount, params.symbols, params.fec ?? "none", sync);
  return { ...params, syncPattern: sync, ...book };
}

/** id -> coded index tables of pruned books, from the kernel's walk
 * (pk_stagger_fill), keyed by the code book. */
const codedTables = new Map<string, { idToN: Uint32Array; nToId: Map<number, number> }>();

function codedTable(params: CodeParams): { idToN: Uint32Array; nToId: Map<number, number> } {
  const key = `${params.ledCount}|${params.bits}|${params.symbols}|${params.fec ?? "none"}|${params.syncPattern}`;
  let t = codedTables.get(key);
  if (t === undefined) {
    const k = kernel();
    const n = params.ledCount;
    const sync = syncCode(params);
    if (k.pk_stagger_fill(n, params.ledCount, params.bits, params.symbols, secded(params), sync) !== n) {
      throw new RangeError(`code book of ${params.bits} bits holds fewer than ${n} ids`);
    }
    const idToN = new Uint32Array(k.memory.buffer, k.pk_stagger_ids_buf(), n).slice();
    const nToId = new Map<number, number>();
    idToN.forEach((v, i) => nToId.set(v, i));
    t = { idToN, nToId };
    codedTables.set(key, t);
  }
  return t;
}

/** The coded index id `ledId` transmits as gray(n): `ledId + 1`, or its entry
 * in a pruned book. */
export function codedIndex(ledId: number, params: CodeParams): number {
  if (!isPruned(params)) return ledId + CODE_OFFSET;
  const n = codedTable(params).idToN[ledId];
  if (n === undefined) throw new RangeError(`id ${ledId} outside the code book of ${params.ledCount}`);
  return n;
}

/** The color `ledId` shows in cycle frame `frameIndex` (0-based within one
 * cycle; the GLOBAL frame under a staggered pattern). */
export function colorForFrame(ledId: number, frameIndex: number, params: CodeParams): Rgb {
  if (frameIndex < 0 || frameIndex >= params.cycleFrames) {
    throw new RangeError(`frameIndex ${frameIndex} outside cycle of ${params.cycleFrames}`);
  }
  const sync = syncCode(params);
  if (sync !== 0) {
    bitsPerSymbol(params);
    if (sync !== 1) checkEncodable(ledId, params);
    const n = codedIndex(ledId, params);
    return colorOfIndex(
      kernel().pk_color_index_coded(ledId, n, frameIndex, params.ledCount, params.bits, params.symbols, secded(params), sync),
    );
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
  const sync = syncCode(params);
  if (isPruned(params)) {
    // The kernel ranks a pruned book's coded index by walking the book (O(n)
    // validity checks, ~0.2 ms at 2000 LEDs, once per track per cycle); the
    // id <-> index table this side already holds maps it in O(1). Same ids:
    // the table is the kernel's own walk (pk_stagger_fill), and an index it
    // lacks is excluded by the book or ranks past ledCount.
    const c = k.pk_decode_cycle_coded(symbols.length, params.ledCount, params.bits, params.symbols, secded(params), sync);
    const n = (c & FLAG_VALUE) !== 0 ? c & VALUE_MASK : null;
    return {
      id: n === null ? null : (codedTable(params).nToId.get(n) ?? null),
      corrected: (c & FLAG_CORRECTED) !== 0,
      uncorrectable: (c & FLAG_UNCORRECTABLE) !== 0,
    };
  }
  const r =
    sync === 0
      ? k.pk_decode_cycle(symbols.length, params.ledCount, params.bits, params.symbols, secded(params))
      : k.pk_decode_cycle_sync(symbols.length, params.ledCount, params.bits, params.symbols, secded(params), sync);
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
