/**
 * SEC-DED codeword logic (code/fec.ts) vs the Python driver golden, plus the
 * distance-4 guarantees the decoder relies on: every single bit error is
 * corrected, every double is detected — NEVER miscorrected into a valid
 * wrong id. The symbols=4 alphabet adds one more guarantee: misreading a
 * symbol as its NEAREST hue neighbor flips exactly one bit (Gray-ordered
 * palette), so the dominant confusion stays correctable.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import { secdedDecode, secdedEncode, secdedParityBits, secdedTotalBits } from "../src/code/fec";
import {
  bitsPerSymbol,
  codewordForId,
  COLOR_BLUE,
  COLOR_MAGENTA,
  COLOR_RED,
  COLOR_YELLOW,
  dataFrames,
  decodeCycleSymbols,
  gray,
  SYMBOL_COLORS,
  symbolAt,
} from "../src/code/gray";
import golden from "./golden_secded16.json";
import golden4 from "./golden_secded16_sym4.json";

const params: CodeParams = {
  ledCount: golden.ledCount,
  bits: golden.bits,
  encoding: "hue",
  symbols: 2,
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: golden.cycleFrames,
  fec: "secded",
};

const params4: CodeParams = {
  ...params,
  symbols: 4,
  cycleFrames: golden4.cycleFrames,
};

test("code sizes match the Python driver golden", () => {
  assert.equal(secdedTotalBits(golden.dataBits), golden.bits);
  assert.equal(secdedParityBits(6), 4); // 63 LEDs -> 11 total
  assert.equal(secdedTotalBits(11), 16); // 2047 LEDs -> 16 total
});

test("codewords match the Python driver golden, id for id", () => {
  for (let id = 0; id < golden.ledCount; id++) {
    assert.equal(codewordForId(id, params), golden.codewords[id], `id ${id}`);
    assert.equal(secdedEncode(gray(id + 1), golden.dataBits), golden.codewords[id]);
  }
});

function symbolsFor(id: number, p: CodeParams): number[] {
  return Array.from({ length: dataFrames(p) }, (_, f) => symbolAt(id, f, p));
}

test("clean cycles decode without correction (both alphabets)", () => {
  for (const p of [params, params4]) {
    for (let id = 0; id < p.ledCount; id++) {
      const dec = decodeCycleSymbols(symbolsFor(id, p), p);
      assert.equal(dec.id, id);
      assert.equal(dec.corrected, false);
      assert.equal(dec.uncorrectable, false);
    }
  }
});

test("EVERY single bit error is corrected to the right id", () => {
  for (const p of [params, params4]) {
    const bps = bitsPerSymbol(p);
    for (let id = 0; id < p.ledCount; id++) {
      for (let b = 0; b < p.bits; b++) {
        const symbols = symbolsFor(id, p);
        const frame = Math.floor(b / bps);
        symbols[frame]! ^= 1 << (b % bps);
        const dec = decodeCycleSymbols(symbols, p);
        assert.equal(dec.id, id, `symbols=${p.symbols} id ${id} flip ${b}`);
        assert.equal(dec.corrected, true);
      }
    }
  }
});

test("EVERY double bit error is detected, never miscorrected", () => {
  const bps = bitsPerSymbol(params);
  for (let id = 0; id < params.ledCount; id++) {
    for (let b1 = 0; b1 < params.bits; b1++) {
      for (let b2 = b1 + 1; b2 < params.bits; b2++) {
        const symbols = symbolsFor(id, params);
        symbols[Math.floor(b1 / bps)]! ^= 1 << (b1 % bps);
        symbols[Math.floor(b2 / bps)]! ^= 1 << (b2 % bps);
        const dec = decodeCycleSymbols(symbols, params);
        assert.equal(dec.id, null, `id ${id} flips ${b1},${b2} -> ${dec.id}`);
        assert.equal(dec.uncorrectable, true);
      }
    }
  }
});

test("symbols=4: adjacent-hue misreads are single-bit errors and correct", () => {
  // The Gray-ordered palette's whole point: the hue path blue → magenta →
  // red → yellow carries 00 → 01 → 11 → 10, so confusing NEIGHBORING hues
  // flips one bit and SEC-DED recovers the true id.
  const path = [COLOR_BLUE, COLOR_MAGENTA, COLOR_RED, COLOR_YELLOW];
  const palette = SYMBOL_COLORS[4]!;
  const valueOf = (c: (typeof path)[number]): number => palette.indexOf(c);
  for (let id = 0; id < params4.ledCount; id++) {
    for (let f = 0; f < dataFrames(params4); f++) {
      const trueValue = symbolAt(id, f, params4);
      const pos = path.indexOf(palette[trueValue]!);
      for (const n of [pos - 1, pos + 1]) {
        if (n < 0 || n >= path.length) continue;
        const symbols = symbolsFor(id, params4);
        symbols[f] = valueOf(path[n]!);
        const dec = decodeCycleSymbols(symbols, params4);
        assert.equal(dec.id, id, `id ${id} frame ${f}: ${pos} misread as ${n}`);
      }
    }
  }
});

test("exhaustive encode/decode roundtrip + corruption for all used widths", () => {
  for (let k = 1; k <= 11; k++) {
    const total = secdedTotalBits(k);
    const step = Math.max(1, (1 << k) >> 6);
    for (let data = 0; data < 1 << k; data += step) {
      const word = secdedEncode(data, k);
      assert.deepEqual(secdedDecode(word, k), { data, corrected: false });
      for (let i = 0; i < total; i++) {
        const single = secdedDecode(word ^ (1 << i), k);
        assert.equal(single.data, data);
        assert.equal(single.corrected, true);
        for (let j = i + 1; j < total; j++) {
          assert.equal(secdedDecode(word ^ (1 << i) ^ (1 << j), k).data, null);
        }
      }
    }
  }
});

test("a legacy fec-less code-book still uses the raw Gray word", () => {
  const legacy: CodeParams = {
    ledCount: 16,
    bits: 5,
    encoding: "hue",
    symbols: 2,
    bitPeriodMs: 100,
    syncPattern: "on_off",
    cycleFrames: 7,
    // fec omitted = "none"
  };
  for (let id = 0; id < legacy.ledCount; id++) {
    const dec = decodeCycleSymbols(symbolsFor(id, legacy), legacy);
    assert.equal(dec.id, id);
  }
});
