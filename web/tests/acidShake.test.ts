/**
 * Shake-to-enter detector core (src/ui/acid/shake.ts) — the pure, DOM-free
 * contract: a vigorous back-and-forth shake fires exactly once, a single bump or
 * gentle motion does not, and the cooldown suppresses an immediate re-fire.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ShakeDetector, type Accel } from "../src/ui/acid/shake";

/** Feed an x-axis series (y=z=0) at a fixed cadence; return the fire timeline. */
function run(xs: number[], stepMs = 50, det = new ShakeDetector()): boolean[] {
  const out: boolean[] = [];
  xs.forEach((x, i) => {
    const a: Accel = { x, y: 0, z: 0 };
    out.push(det.update(a, i * stepMs));
  });
  return out;
}

test("a vigorous side-to-side shake fires exactly once", () => {
  // Alternating ±20 → per-sample deltas of ~40 flip the dominant-axis sign each
  // step, accruing the required reversals.
  const fires = run([0, 20, -20, 20, -20, 20, -20]);
  assert.equal(
    fires.filter(Boolean).length,
    1,
    "should fire once for a sustained shake",
  );
});

test("gentle motion never fires (below the jolt threshold)", () => {
  const fires = run([0, 5, -5, 5, -5, 5, -5, 5]);
  assert.equal(fires.some(Boolean), false);
});

test("a single sharp bump does not fire (no direction reversals)", () => {
  const fires = run([0, 30, 30, 30, 30]);
  assert.equal(fires.some(Boolean), false);
});

test("cooldown suppresses an immediate second shake", () => {
  // Keep shaking well past the first trigger; the 2.5s cooldown means a run of
  // contiguous samples (12 × 50ms = 550ms < cooldown) fires only once.
  const fires = run([0, 20, -20, 20, -20, 20, -20, 20, -20, 20, -20, 20]);
  assert.equal(fires.filter(Boolean).length, 1);
});

test("custom thresholds are honoured", () => {
  // A low reversal requirement fires sooner.
  const det = new ShakeDetector({ minReversals: 2, joltThreshold: 10 });
  const fires: boolean[] = [];
  [0, 15, -15, 15].forEach((x, i) => fires.push(det.update({ x, y: 0, z: 0 }, i * 50)));
  assert.equal(fires.some(Boolean), true);
});
