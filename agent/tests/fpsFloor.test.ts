// The agent's budget verdict uses the same strip-scaled abort floor as the
// firmware autoscaler (firmware/fps `the_abort_floor_scales_down_with_the_strip`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fpsFloorFor } from "../src/session";

test("the abort floor scales down past 512 LEDs", () => {
  assert.equal(fpsFloorFor(0), 25);
  assert.equal(fpsFloorFor(512), 25);
  assert.equal(fpsFloorFor(600), 20);
  assert.equal(fpsFloorFor(1024), 10);
  assert.equal(fpsFloorFor(2048), 5);
  assert.equal(fpsFloorFor(100_000), 5);
});
