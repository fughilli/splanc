/**
 * SEC-DED codeword logic (code/fec.ts) vs the Python driver golden, plus the
 * distance-4 guarantees the decoder relies on: every single bit-frame error
 * is corrected, every double is detected — NEVER miscorrected into a valid
 * wrong id.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import { secdedDecode, secdedEncode, secdedParityBits, secdedTotalBits } from "../src/code/fec";
import { codewordForId, decodeCycle, decodeCycleEx, gray, ledLitInFrame } from "../src/code/gray";
import golden from "./golden_secded16.json";

const params: CodeParams = {
  ledCount: golden.ledCount,
  bits: golden.bits,
  encoding: "gray",
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: golden.cycleFrames,
  fec: "secded",
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

test("frame plan matches the Python driver golden, frame for frame", () => {
  for (let frame = 0; frame < golden.cycleFrames; frame++) {
    const lit = [];
    for (let id = 0; id < golden.ledCount; id++) {
      if (ledLitInFrame(id, frame, params)) lit.push(id);
    }
    assert.deepEqual(lit, golden.framePlan[frame], `frame ${frame}`);
  }
});

function framesFor(id: number): boolean[] {
  return Array.from({ length: params.cycleFrames }, (_, k) => ledLitInFrame(id, k, params));
}

test("clean cycles decode without correction", () => {
  for (let id = 0; id < params.ledCount; id++) {
    const dec = decodeCycleEx(framesFor(id), params);
    assert.equal(dec.id, id);
    assert.equal(dec.corrected, false);
    assert.equal(dec.uncorrectable, false);
  }
});

test("EVERY single bit-frame error is corrected to the right id", () => {
  for (let id = 0; id < params.ledCount; id++) {
    for (let b = 0; b < params.bits; b++) {
      const frames = framesFor(id);
      frames[2 + b] = !frames[2 + b];
      const dec = decodeCycleEx(frames, params);
      assert.equal(dec.id, id, `id ${id} flip ${b}`);
      assert.equal(dec.corrected, true);
    }
  }
});

test("EVERY double bit-frame error is detected, never miscorrected", () => {
  for (let id = 0; id < params.ledCount; id++) {
    for (let b1 = 0; b1 < params.bits; b1++) {
      for (let b2 = b1 + 1; b2 < params.bits; b2++) {
        const frames = framesFor(id);
        frames[2 + b1] = !frames[2 + b1];
        frames[2 + b2] = !frames[2 + b2];
        const dec = decodeCycleEx(frames, params);
        assert.equal(dec.id, null, `id ${id} flips ${b1},${b2} -> ${dec.id}`);
        assert.equal(dec.uncorrectable, true);
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

test("decodeCycle back-compat wrapper returns the bare id", () => {
  assert.equal(decodeCycle(framesFor(7), params), 7);
});

test("a legacy fec-less code-book still uses the raw Gray word", () => {
  const legacy: CodeParams = {
    ledCount: 16,
    bits: 5,
    encoding: "gray",
    bitPeriodMs: 100,
    syncPattern: "on_off",
    cycleFrames: 7,
    // fec omitted = "none"
  };
  for (let id = 0; id < legacy.ledCount; id++) {
    const frames = Array.from({ length: legacy.cycleFrames }, (_, k) =>
      ledLitInFrame(id, k, legacy),
    );
    assert.equal(decodeCycle(frames, legacy), id);
  }
});
