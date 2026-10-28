// #397: the per-channel LED count the agent reports is the one the player
// renders: the configured count, or the stored map's count on channel 0 when no
// channel is configured (the firmware then drives exactly the map's LEDs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderedChannels } from "../src/channels";

const ch = (counts: number[]) => counts.map((ledCount, channel) => ({ channel, gpio: 20 + channel, ledCount }));
const view = (cs: { ledCount: number; configuredLedCount: number; ledCountSource: string }[]) =>
  cs.map((c) => [c.ledCount, c.configuredLedCount, c.ledCountSource]);

test("unconfigured channels report the map's LEDs on channel 0", () => {
  assert.deepEqual(view(renderedChannels(ch([0, 0]), 250)), [
    [250, 0, "map"],
    [0, 0, "unset"],
  ]);
  // Other fields pass through untouched.
  assert.equal(renderedChannels(ch([0, 0]), 250)[1]!.gpio, 21);
});

test("a configured count wins, even when it differs from the map", () => {
  assert.deepEqual(view(renderedChannels(ch([100, 150]), 250)), [
    [100, 100, "configured"],
    [150, 150, "configured"],
  ]);
  assert.deepEqual(view(renderedChannels(ch([0, 150]), 250)), [
    [0, 0, "unset"],
    [150, 150, "configured"],
  ]);
});

test("no map, or nothing at all, stays 0; the boot capacity caps the map count", () => {
  assert.deepEqual(view(renderedChannels(ch([0, 0]), 0)), [
    [0, 0, "unset"],
    [0, 0, "unset"],
  ]);
  assert.deepEqual(view(renderedChannels(ch([0]), null)), [[0, 0, "unset"]]);
  assert.deepEqual(view(renderedChannels(ch([0, 0]), 700, 512)), [
    [512, 0, "map"],
    [0, 0, "unset"],
  ]);
  assert.deepEqual(renderedChannels([], 250), []);
});
