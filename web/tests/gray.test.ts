/**
 * The hue-code wrappers (src/code/gray.ts) over the wasm kernel: the binding
 * (constants + palette pinned to the kernel's, marshalling of every call) and
 * the behaviour the decoder relies on. The code itself is pinned by the
 * kernel's own goldens (//firmware/pattern:golden_pattern_test).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import {
  CODE_OFFSET,
  colorForFrame,
  COLOR_GREEN,
  COLOR_WHITE,
  colorOfIndex,
  DATA_FRAME_OFFSET,
  dataBits,
  dataFrames,
  decodeCycleSymbols,
  decodeGray,
  expectedBits,
  FRAME_ALL_OFF,
  FRAME_ALL_ON,
  gray,
  SYMBOL_COLORS,
  symbolAt,
} from "../src/code/gray";
import { codeKernelReady, kernel } from "../src/code/kernel";

function book(ledCount: number, symbols: 2 | 4): CodeParams {
  const p: CodeParams = {
    ledCount,
    bits: 0,
    encoding: "hue",
    symbols,
    bitPeriodMs: 100,
    syncPattern: "on_off",
    cycleFrames: 0,
    fec: "secded",
  };
  p.bits = expectedBits(p);
  p.cycleFrames = DATA_FRAME_OFFSET + dataFrames(p);
  return p;
}

test("the kernel loads synchronously under node", async () => {
  await codeKernelReady;
  assert.ok(kernel());
});

test("protocol constants and the palette are the kernel's", () => {
  const k = kernel();
  assert.equal(CODE_OFFSET, k.pk_code_offset());
  assert.equal(FRAME_ALL_ON, k.pk_frame_all_on());
  assert.equal(FRAME_ALL_OFF, k.pk_frame_all_off());
  assert.equal(DATA_FRAME_OFFSET, k.pk_data_frame_offset());
  for (const symbols of [2, 4]) {
    SYMBOL_COLORS[symbols]!.forEach((c, v) => {
      assert.equal(colorOfIndex(k.pk_symbol_color(symbols, v)), c, `symbols=${symbols} value ${v}`);
    });
  }
});

test("code-book sizing (16 LEDs: 5 data bits, 10 coded, 12/7 cycle frames)", () => {
  assert.equal(dataBits(16), 5);
  assert.equal(book(16, 2).bits, 10);
  assert.equal(book(16, 2).cycleFrames, 12);
  assert.equal(book(16, 4).cycleFrames, 7);
  assert.equal(dataBits(4094), 12);
  assert.equal(book(4094, 2).bits, 18);
});

test("decodeGray inverts gray for all 10-bit values", () => {
  for (let i = 0; i < 1024; i++) assert.equal(decodeGray(gray(i)), i);
});

test("adjacent ids differ in exactly one gray bit", () => {
  for (let i = 0; i + 1 < 1024; i++) {
    const diff = gray(i) ^ gray(i + 1);
    assert.equal(diff & (diff - 1), 0, `ids ${i},${i + 1}`);
  }
});

for (const symbols of [2, 4] as const) {
  const params = book(100, symbols);

  test(`symbols=${symbols}: the cycle is white, green, then the palette colour of each symbol`, () => {
    for (let id = 0; id < params.ledCount; id++) {
      assert.equal(colorForFrame(id, FRAME_ALL_ON, params), COLOR_WHITE);
      assert.equal(colorForFrame(id, FRAME_ALL_OFF, params), COLOR_GREEN);
      for (let f = 0; f < dataFrames(params); f++) {
        const want = SYMBOL_COLORS[symbols]![symbolAt(id, f, params)];
        assert.equal(colorForFrame(id, DATA_FRAME_OFFSET + f, params), want, `id ${id} frame ${f}`);
      }
    }
  });

  test(`symbols=${symbols}: decodeCycleSymbols round-trips every LED id`, () => {
    for (let id = 0; id < params.ledCount; id++) {
      const syms = Array.from({ length: dataFrames(params) }, (_, f) => symbolAt(id, f, params));
      const dec = decodeCycleSymbols(syms, params);
      assert.equal(dec.id, id);
      assert.equal(dec.corrected, false);
    }
  });
}

test("argument validation stays at the TS edge", () => {
  const p = book(16, 2);
  assert.throws(() => colorForFrame(0, p.cycleFrames, p), RangeError);
  assert.throws(() => colorForFrame(0, -1, p), RangeError);
  assert.throws(() => dataFrames({ ...p, symbols: 3 }), RangeError);
  assert.throws(() => symbolAt(40, 0, p), RangeError, "id past the code-book");
  // A wrong frame count is not a decode.
  assert.equal(decodeCycleSymbols([0, 1], p).id, null);
});

test("out-of-range ids decode to null", () => {
  // A FEC-less book keeps the code width constant across ledCounts with the
  // same data-bit width, so id 15's word survives re-decode against the
  // smaller fixture and fails ONLY the range check.
  const params: CodeParams = {
    ledCount: 16,
    bits: 5,
    encoding: "hue",
    symbols: 2,
    bitPeriodMs: 100,
    syncPattern: "on_off",
    cycleFrames: 7,
    // fec omitted = "none"
  };
  const small: CodeParams = { ...params, ledCount: 10 }; // codewords for 10..15 invalid
  const symbols = Array.from({ length: dataFrames(params) }, (_, f) => symbolAt(15, f, params));
  assert.equal(decodeCycleSymbols(symbols, small).id, null);
});
