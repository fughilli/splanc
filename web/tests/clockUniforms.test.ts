/** The wall-clock uniforms in the preview (fx/clockUniforms.ts): the same
 * values the firmware's uniform pool writes, the by-name binding, and the
 * "Preview time" pick that keeps running from the picked minute. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyClockUniforms, clockBindings, clockValues, formatMinute, PreviewTime } from "../src/fx/clockUniforms";

test("clock values match the firmware's pool layout (local time)", () => {
  // Wednesday 2026-11-25 06:30:15.250 in the test runner's own zone.
  const d = new Date(2026, 10, 25, 6, 30, 15, 250);
  const v = clockValues(d);
  assert.deepEqual(v["clock"], [6, 30, 15.25, 3]);
  assert.ok(Math.abs(v["clock_day"]![0]! - (6 * 3600 + 30 * 60 + 15.25) / 86400) < 1e-12);
  assert.deepEqual(v["clock_date"], [2026, 11, 25]);
  assert.deepEqual(v["clock_valid"], [1]);
});

test("only uniforms named like a clock entry bind, at min(width)", () => {
  const manifest = [
    { name: "clock_day", slot: 4, width: 1 },
    { name: "speed", slot: 5, width: 1 },
    { name: "clock", slot: 0, width: 2 },
    { name: "clock_valid", slot: 6, width: 1 },
  ];
  const bound = clockBindings(manifest);
  assert.deepEqual(bound.map((u) => u.name), ["clock_day", "clock", "clock_valid"]);
  const got = new Map<number, number[]>();
  applyClockUniforms(bound, new Date(2026, 0, 4, 18, 0, 0), (slot, v) => got.set(slot, v));
  assert.deepEqual(got.get(0), [18, 0]);
  assert.deepEqual(got.get(4), [0.75]);
  assert.deepEqual(got.get(6), [1]);
  assert.equal(got.has(5), false);
});

test("a picked preview time runs on from the picked minute", () => {
  const t = new PreviewTime();
  const now = new Date(2026, 10, 25, 14, 2, 0).getTime();
  assert.equal(t.following, true);
  assert.equal(t.at(now).getTime(), now);
  t.pick(6 * 60 + 30, now);
  assert.equal(t.following, false);
  const later = t.at(now + 90_000);
  assert.deepEqual([later.getHours(), later.getMinutes(), later.getSeconds()], [6, 31, 30]);
  assert.equal(later.getDate(), 25);
  t.pick(5000, now); // clamped to 23:59
  assert.equal(t.at(now).getHours(), 23);
  t.follow();
  assert.equal(t.at(now).getTime(), now);
  assert.equal(formatMinute(6 * 60 + 5), "06:05");
  assert.equal(formatMinute(1440), "00:00");
});
