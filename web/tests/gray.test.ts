/** Hue-code logic vs. the Python driver's golden fixtures + inverses. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import {
  colorForFrame,
  dataFrames,
  decodeCycleSymbols,
  decodeGray,
  gray,
  symbolAt,
  type Rgb,
} from "../src/code/gray";
import golden2 from "./golden_secded16.json";
import golden4 from "./golden_secded16_sym4.json";

function paramsOf(g: typeof golden2): CodeParams {
  return {
    ledCount: g.ledCount,
    bits: g.bits,
    encoding: "hue",
    symbols: g.symbols,
    bitPeriodMs: 100,
    syncPattern: "on_off",
    cycleFrames: g.cycleFrames,
    fec: "secded",
  };
}

/** The golden's palette-letter encoding of a normalized color. */
function letterOf(c: Rgb): string {
  const key = c.join(",");
  const table: Record<string, string> = {
    "1,1,1": "W",
    "0,1,0": "G",
    "1,0,0": "R",
    "0,0,1": "B",
    "1,0,1": "M",
    "1,1,0": "Y",
  };
  const letter = table[key];
  assert.ok(letter !== undefined, `unknown palette color ${key}`);
  return letter;
}

test("gray matches the Python driver golden", () => {
  assert.deepEqual(
    golden2.gray,
    Array.from({ length: golden2.ledCount }, (_, i) => gray(i)),
  );
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

for (const [name, golden] of [
  ["symbols=2", golden2],
  ["symbols=4", golden4],
] as const) {
  const params = paramsOf(golden);

  test(`${name}: symbol values match the Python driver golden`, () => {
    for (let id = 0; id < golden.ledCount; id++) {
      for (let f = 0; f < dataFrames(params); f++) {
        assert.equal(symbolAt(id, f, params), golden.symbolValues[id]![f], `id ${id} frame ${f}`);
      }
    }
  });

  test(`${name}: color plan matches the Python driver golden, frame for frame`, () => {
    for (let frame = 0; frame < golden.cycleFrames; frame++) {
      let row = "";
      for (let id = 0; id < golden.ledCount; id++) {
        row += letterOf(colorForFrame(id, frame, params));
      }
      assert.equal(row, golden.colorPlan[frame], `frame ${frame}`);
    }
  });

  test(`${name}: decodeCycleSymbols round-trips every LED id`, () => {
    for (let id = 0; id < params.ledCount; id++) {
      const symbols = Array.from({ length: dataFrames(params) }, (_, f) =>
        symbolAt(id, f, params),
      );
      const dec = decodeCycleSymbols(symbols, params);
      assert.equal(dec.id, id);
      assert.equal(dec.corrected, false);
    }
  });
}

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
