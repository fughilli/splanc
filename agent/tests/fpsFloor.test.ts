// The agent's budget verdict uses the same strip-scaled floor as the firmware
// autoscaler's lowest rung (firmware/fps `the_floor_scales_down_with_the_strip`);
// an effect below it lags (keeps playing), it is never parked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fpsFloorFor } from "../src/session";

test("the autoscaler floor scales down past 512 LEDs", () => {
  assert.equal(fpsFloorFor(0), 25);
  assert.equal(fpsFloorFor(512), 25);
  assert.equal(fpsFloorFor(600), 20);
  assert.equal(fpsFloorFor(1024), 10);
  assert.equal(fpsFloorFor(2048), 5);
  assert.equal(fpsFloorFor(100_000), 5);
});
