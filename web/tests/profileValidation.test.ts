/**
 * Cost-model validation tests (FUG-11): predicted-vs-measured scoring against
 * held-out hardware samples.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  measuredErrorFrom,
  validateCostModel,
  type HeldoutSample,
} from "../src/effects/profileValidation";
import { estimateFrameTime } from "../src/effects/costModel";
import { defaultCostTable } from "../src/store/costTableStore";

/** A trivial `.fxb`: shade() returns vec3(led.pos.x). */
function trivialFxb(): Uint8Array {
  const code = [6, 3, 23, 3, 3, 0, 0, 0, 33, 3];
  const h: number[] = [0x46, 0x58, 0x42, 0x31, 1, 0, 0, 0];
  const p16 = (v: number): void => {
    h.push(v & 0xff, (v >> 8) & 0xff);
  };
  p16(0); // manifest
  p16(0); // consts
  p16(code.length); // code_len
  p16(0xffff); // update entry absent
  p16(0); // shade entry
  return new Uint8Array([...h, ...code]);
}

test("a perfectly-predicting model scores ~0 error and passes", () => {
  const table = defaultCostTable();
  const fxb = trivialFxb();
  // Build held-out samples whose measured == the model's own prediction, so the
  // model is "perfect" by construction.
  const samples: HeldoutSample[] = [64, 128, 256].map((ledCount) => {
    const predicted = estimateFrameTime({ bytecode: fxb, ledCount, table }).totalMs;
    return { label: `leds${ledCount}`, bytecode: fxb, ledCount, measuredMs: predicted };
  });
  const v = validateCostModel(table, samples);
  assert.ok(v.rmsError < 1e-9, `rms ~0, got ${v.rmsError}`);
  assert.ok(v.maxAbsError < 1e-9);
  assert.ok(v.r2 > 0.999, `R² ~1, got ${v.r2}`);
  assert.ok(v.passed);
  assert.equal(measuredErrorFrom(v), v.rmsError <= 1 ? v.rmsError : 1);
});

test("a biased model reports the error and can fail the tolerance", () => {
  const table = defaultCostTable();
  const fxb = trivialFxb();
  // measured is 25% higher than the model predicts everywhere → ~0.2 rms.
  const samples: HeldoutSample[] = [64, 128, 256].map((ledCount) => {
    const predicted = estimateFrameTime({ bytecode: fxb, ledCount, table }).totalMs;
    return { label: `leds${ledCount}`, bytecode: fxb, ledCount, measuredMs: predicted * 1.25 };
  });
  const v = validateCostModel(table, samples, 0.15);
  // predicted is 1/1.25 = 0.8 of measured → relError ≈ -0.2.
  assert.ok(v.meanAbsError > 0.15 && v.meanAbsError < 0.25, `meanAbs ~0.2, got ${v.meanAbsError}`);
  assert.equal(v.passed, false, "0.2 rms > 0.15 tolerance → fails");
  // every sample under-predicts (negative signed error).
  for (const s of v.samples) assert.ok(s.relError < 0);
});

test("empty sample set does not throw and does not pass", () => {
  const v = validateCostModel(defaultCostTable(), []);
  assert.equal(v.passed, false);
  assert.equal(v.rmsError, 0);
});
