// The app's wire-rate hint must agree with the firmware autoscaler's ceiling
// (firmware/fps/src/lib.rs `ceiling_is_the_fastest_rung_one_wire_frame_fits`).
import assert from "node:assert/strict";
import { test } from "node:test";
import { wireFpsCeiling } from "../src/net/ledWire";

test("wire ceiling matches the firmware ladder table", () => {
  const table: Array<[number, number]> = [
    [150, 80],
    [300, 80],
    [400, 80],
    [450, 70],
    [512, 60],
    [600, 50],
    [768, 40],
    [900, 35],
    [1024, 30],
  ];
  for (const [leds, fps] of table) assert.equal(wireFpsCeiling(leds), fps, `${leds} LEDs`);
});

test("the ladder bottoms out at 5 fps", () => {
  assert.equal(wireFpsCeiling(1400), 20);
  assert.equal(wireFpsCeiling(100_000), 5);
});
