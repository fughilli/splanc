/**
 * New-fixture onboarding (D-259): name handling, which connection takes a
 * pending name, when setup is offered, the flow's steps, the hardware probes, and
 * the Improv Identify packet the picker's Blink sends.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_NAME_BYTES,
  PENDING_TTL_MS,
  normalizeFixtureName,
  pendingMatches,
  setupSteps,
  shouldOfferSetup,
} from "../src/store/newFixture";
import { clampLedCount, countProbeBlocks, orderProbeBlocks } from "../src/hardware/setupProbe";
import { buildIdentify } from "../src/net/improv";

test("names are trimmed, collapsed and cut to the firmware's 32 bytes on a whole character", () => {
  assert.equal(normalizeFixtureName("  Desk   lamp "), "Desk lamp");
  assert.equal(normalizeFixtureName(""), "");
  const long = "x".repeat(40);
  assert.equal(normalizeFixtureName(long).length, MAX_NAME_BYTES);
  const emoji = "🎃".repeat(10); // 4 bytes each
  const cut = normalizeFixtureName(emoji);
  assert.equal(new TextEncoder().encode(cut).length, 32);
  assert.equal(cut, "🎃".repeat(8));
});

test("a pending name goes to the flashed board by MAC, or to the next fixture", () => {
  const now = 1_000_000;
  const pinned = { name: "Desk lamp", mac: "AA:BB:CC:00:11:22", at: now - 1000 };
  assert.equal(pendingMatches(pinned, "aa:bb:cc:00:11:22", now), true);
  assert.equal(pendingMatches(pinned, "AA-BB-CC-00-11-22", now), true);
  assert.equal(pendingMatches(pinned, "AA:BB:CC:00:11:23", now), false);
  assert.equal(pendingMatches(pinned, undefined, now), false);
  const loose = { name: "Porch", at: now - 1000 };
  assert.equal(pendingMatches(loose, "11:22:33:44:55:66", now), true);
  assert.equal(pendingMatches({ ...loose, at: now - PENDING_TTL_MS - 1 }, "x", now), false);
  assert.equal(pendingMatches(null, "x", now), false);
});

test("setup is offered once, only for a fixture known to have no map, from calm screens", () => {
  const base = { deviceId: "dev1", hasMap: false, seen: false, route: "/effects" };
  assert.equal(shouldOfferSetup(base), true);
  assert.equal(shouldOfferSetup({ ...base, route: "" }), true);
  assert.equal(shouldOfferSetup({ ...base, route: "/onboard" }), true);
  assert.equal(shouldOfferSetup({ ...base, seen: true }), false);
  assert.equal(shouldOfferSetup({ ...base, hasMap: true }), false);
  assert.equal(shouldOfferSetup({ ...base, hasMap: null }), false); // can't tell: don't nag
  assert.equal(shouldOfferSetup({ ...base, deviceId: null }), false);
  assert.equal(shouldOfferSetup({ ...base, route: "/capture" }), false);
  assert.equal(shouldOfferSetup({ ...base, route: "/effects/edit/x" }), false);
});

test("steps: name, LEDs, one colour check per used output, done", () => {
  assert.deepEqual(
    setupSteps([0]).map((s) => `${s.step}:${s.port}`),
    ["name:0", "leds:0", "order:0", "done:0"],
  );
  assert.deepEqual(
    setupSteps([0, 1]).map((s) => `${s.step}:${s.port}`),
    ["name:0", "leds:0", "order:0", "order:1", "done:0"],
  );
  // Nothing counted yet: still check output 0.
  assert.equal(setupSteps([]).filter((s) => s.step === "order").length, 1);
});

test("count probe: dim white up to a green last LED", () => {
  assert.deepEqual(countProbeBlocks(60), [
    { start: 0, count: 59, rgb: [0.12, 0.12, 0.12] },
    { start: 59, count: 1, rgb: [0, 0.8, 0] },
  ]);
  assert.deepEqual(countProbeBlocks(1), [{ start: 0, count: 1, rgb: [0, 0.8, 0] }]);
  assert.deepEqual(countProbeBlocks(0), [{ start: 0, count: 1, rgb: [0, 0.8, 0] }]);
});

test("order probe: three runs of red, green, blue from the strip start", () => {
  const b = orderProbeBlocks(3);
  assert.deepEqual(
    b.map((x) => [x.start, x.count, x.rgb.join(",")]),
    [
      [0, 3, "1,0,0"],
      [3, 3, "0,1,0"],
      [6, 3, "0,0,1"],
    ],
  );
});

test("LED counts clamp to the board's per-output limit", () => {
  assert.equal(clampLedCount(120, 1024), 120);
  assert.equal(clampLedCount(5000, 1024), 1024);
  assert.equal(clampLedCount(-3, 1024), 0);
  assert.equal(clampLedCount(Number.NaN, 1024), 0);
  assert.equal(clampLedCount(77.9, 0), 77);
});

test("Improv Identify packet: command 0x02, no data, checksum", () => {
  assert.deepEqual([...buildIdentify()], [0x02, 0x00, 0x02]);
});
