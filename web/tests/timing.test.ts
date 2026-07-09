/** Pattern-clock mapping (§8.2). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CodeParams } from "@ledmapper/protocol";
import { cycleIndexAt, cycleMs, frameFractionAt, frameIndexAt } from "../src/code/timing";

const params: CodeParams = {
  ledCount: 64,
  bits: 6,
  encoding: "gray",
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 8,
};

test("cycleMs", () => {
  assert.equal(cycleMs(params), 800);
});

test("frameIndexAt walks the cycle and wraps", () => {
  const epoch = 5000;
  for (let k = 0; k < 8; k++) {
    assert.equal(frameIndexAt(epoch + k * 100 + 50, epoch, params), k);
    assert.equal(frameIndexAt(epoch + 800 + k * 100 + 50, epoch, params), k, "next cycle");
  }
});

test("frameIndexAt is correct before the epoch (negative phase)", () => {
  const epoch = 5000;
  // 50 ms before the epoch is the last frame of the previous cycle.
  assert.equal(frameIndexAt(epoch - 50, epoch, params), 7);
  assert.equal(cycleIndexAt(epoch - 50, epoch, params), -1);
});

test("cycleIndexAt increments once per cycle", () => {
  const epoch = 1234.5;
  assert.equal(cycleIndexAt(epoch + 10, epoch, params), 0);
  assert.equal(cycleIndexAt(epoch + 799.9, epoch, params), 0);
  assert.equal(cycleIndexAt(epoch + 800.1, epoch, params), 1);
  assert.equal(cycleIndexAt(epoch + 8000, epoch, params), 10);
});

test("frameFractionAt spans [0,1) within a window", () => {
  const epoch = 0;
  assert.equal(frameFractionAt(25, epoch, params), 0.25);
  assert.equal(frameFractionAt(175, epoch, params), 0.75);
  assert.ok(frameFractionAt(99.99, epoch, params) < 1);
});
