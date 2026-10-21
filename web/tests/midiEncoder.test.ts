/**
 * Relative MIDI encoder support (src/midi/encoder.ts): decoding the three
 * relative CC encodings (incl. accelerated multi-tick values), the absolute
 * delta tracker, the ticks→steps accumulator, and learn-time mode detection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EncoderTracker,
  StepAccumulator,
  decodeRelative,
  detectEncoderMode,
  isEncoderMode,
} from "../src/midi/encoder";

test("binary offset (3F/41): 64±n, accelerated values pass through", () => {
  assert.equal(decodeRelative(65, "binOffset"), 1);
  assert.equal(decodeRelative(63, "binOffset"), -1);
  assert.equal(decodeRelative(64, "binOffset"), 0);
  // Twister velocity-sensitive output: 64 + n*mult.
  assert.equal(decodeRelative(72, "binOffset"), 8);
  assert.equal(decodeRelative(48, "binOffset"), -16);
  assert.equal(decodeRelative(127, "binOffset"), 63);
  assert.equal(decodeRelative(0, "binOffset"), -64);
});

test("two's complement (7F/01): 1..63 = +n, 127..65 = −n", () => {
  assert.equal(decodeRelative(1, "twos"), 1);
  assert.equal(decodeRelative(127, "twos"), -1);
  assert.equal(decodeRelative(5, "twos"), 5);
  assert.equal(decodeRelative(123, "twos"), -5);
  assert.equal(decodeRelative(63, "twos"), 63);
  assert.equal(decodeRelative(65, "twos"), -63);
  assert.equal(decodeRelative(0, "twos"), 0);
});

test("signed bit: bit 6 is the sign", () => {
  assert.equal(decodeRelative(1, "signMag"), 1);
  assert.equal(decodeRelative(65, "signMag"), -1);
  assert.equal(decodeRelative(10, "signMag"), 10);
  assert.equal(decodeRelative(74, "signMag"), -10);
});

test("absolute has no per-message delta; the tracker diffs successive values", () => {
  assert.equal(decodeRelative(90, "absolute"), 0);
  const t = new EncoderTracker();
  assert.equal(t.delta("k", 40, "absolute"), 0, "first value only primes");
  assert.equal(t.delta("k", 43, "absolute"), 3);
  assert.equal(t.delta("k", 41, undefined), -2, "unset mode = absolute");
  // Relative modes ignore history.
  assert.equal(t.delta("r", 65, "binOffset"), 1);
  assert.equal(t.delta("r", 65, "binOffset"), 1);
  // Separate keys are separate knobs.
  assert.equal(t.delta("other", 10, "absolute"), 0);
  t.reset("k");
  assert.equal(t.delta("k", 100, "absolute"), 0);
});

test("step accumulator: 1:1 by default, divides with carry, keeps acceleration", () => {
  const a = new StepAccumulator();
  assert.equal(a.push(1), 1);
  assert.equal(a.push(-7), -7);
  const slow = new StepAccumulator(4);
  assert.deepEqual([1, 1, 1, 1].map((d) => slow.push(d)), [0, 0, 0, 1]);
  assert.equal(slow.push(9), 2, "a fast tick burst moves several rows");
  // Remainder 1 left; a reversal drops it instead of eating the first −ticks.
  assert.deepEqual([-1, -1, -1, -1].map((d) => slow.push(d)), [0, 0, 0, -1]);
});

test("detect: Twister-style 63/65 → binary offset (high)", () => {
  const g = detectEncoderMode([65, 65, 65, 63, 63]);
  assert.equal(g?.mode, "binOffset");
  assert.equal(g?.confidence, "high");
  // One direction only still repeats.
  assert.equal(detectEncoderMode([65, 65, 66, 65])?.mode, "binOffset");
  // Accelerated spin after a slow start.
  assert.equal(detectEncoderMode([65, 65, 67, 72, 70, 65])?.mode, "binOffset");
});

test("detect: 1/127 → two's complement; 1/65 → signed bit", () => {
  const t = detectEncoderMode([1, 1, 127, 127, 126]);
  assert.equal(t?.mode, "twos");
  assert.equal(t?.confidence, "high");
  const s = detectEncoderMode([1, 1, 65, 65, 66]);
  // 65/66 also fit binary offset, but 1 can't — so signed bit.
  assert.equal(s?.mode, "signMag");
  // Only +1s: ambiguous between twos and signed bit → low-confidence twos.
  const amb = detectEncoderMode([1, 1, 1]);
  assert.equal(amb?.mode, "twos");
  assert.equal(amb?.confidence, "low");
});

test("detect: walking positions → absolute; too few samples → null", () => {
  assert.equal(detectEncoderMode([30, 31, 32, 33, 34])?.mode, "absolute");
  assert.equal(detectEncoderMode([30, 31, 32, 33, 34])?.confidence, "high");
  // Crossing 64 rules out binary offset even near the middle.
  assert.equal(detectEncoderMode([62, 63, 64, 65, 66])?.mode, "absolute");
  // Near-middle walk that never hits 64 still reads as absolute (no repeats).
  assert.equal(detectEncoderMode([58, 59, 60, 61, 62])?.mode, "absolute");
  // A fader at rest at 0.
  assert.equal(detectEncoderMode([0, 0, 0])?.mode, "absolute");
  assert.equal(detectEncoderMode([65, 65]), null);
});

test("isEncoderMode guards stored values", () => {
  assert.ok(isEncoderMode("binOffset"));
  assert.ok(isEncoderMode("absolute"));
  assert.ok(!isEncoderMode("relative"));
  assert.ok(!isEncoderMode(undefined));
});
