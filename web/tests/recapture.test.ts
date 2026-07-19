/**
 * Map recapture helpers (xr/recapture.ts): mask building, anchor selection,
 * and the rigid-align merge of a re-mapped subset into the original solve.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { buildLedMask, mergeRecapture, pickAnchors } from "../src/xr/recapture";

function led(id: number, xyz: Vec3, confidence = 1): LedEntry {
  return { id, xyz, confidence, nViews: 3, rmsReprojPx: 0.4, parallaxDeg: 20 };
}

function map(leds: LedEntry[], unmapped: number[] = []): OutputMap {
  return {
    mapId: "m",
    createdAt: "2026-07-19T00:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: leds.length + unmapped.length,
    leds,
    unmapped,
    stats: { rmsReprojPxGlobal: 0.4, medianParallaxDeg: 20 },
  };
}

test("buildLedMask sets the right bits (base64 bitmask)", () => {
  // LEDs 0,2,5 → byte 0 bits 0,2,5 = 0x25 → base64 "JQ==".
  assert.equal(buildLedMask([0, 2, 5], 8), "JQ==");
  // Two bytes: LED 0 and LED 8 → [0x01, 0x01].
  assert.equal(buildLedMask([0, 8], 16), btoa("\x01\x01"));
  // Out-of-range ids are ignored.
  assert.equal(buildLedMask([99], 8), btoa("\x00"));
});

test("pickAnchors chooses confident, spread, non-target LEDs", () => {
  const leds = [
    led(0, [0, 0, 0], 0.9),
    led(1, [1, 0, 0], 0.9),
    led(2, [0, 1, 0], 0.9),
    led(3, [0.1, 0.1, 0], 0.9), // close to 0 → farthest-point should skip early
    led(4, [5, 5, 5], 0.2), // low confidence → excluded
  ];
  const anchors = pickAnchors(map(leds), new Set([2]), 2);
  assert.equal(anchors.length, 2);
  assert.ok(!anchors.includes(2), "targets are never anchors");
  assert.ok(!anchors.includes(4), "low-confidence LEDs are excluded");
  // The two anchors should be spatially separated (not 0 and its neighbour 3).
  assert.ok(!(anchors.includes(0) && anchors.includes(3)), "farthest-point spread");
});

test("mergeRecapture rigidly aligns a re-map via anchors and refreshes targets", () => {
  // Base: anchors 0,1,2 good; target 3 has a BAD position.
  const base = map([
    led(0, [0, 0, 0]),
    led(1, [1, 0, 0]),
    led(2, [0, 1, 0]),
    led(3, [9, 9, 9], 0.1),
  ]);
  // Recapture solved in a frame translated by (10,10,10); target 3's TRUE
  // position is (1,1,0), so it lands at (11,11,10) in the recapture frame.
  const recap = map([
    led(0, [10, 10, 10]),
    led(1, [11, 10, 10]),
    led(2, [10, 11, 10]),
    led(3, [11, 11, 10], 0.95),
  ]);
  const { map: merged, updated, anchorsUsed } = mergeRecapture(base, recap, new Set([0, 1, 2]));
  assert.equal(anchorsUsed, 3);
  assert.equal(updated, 1);
  const byId = new Map(merged.leds.map((l) => [l.id, l]));
  // Anchors keep their original base positions.
  assert.deepEqual(byId.get(0)!.xyz, [0, 0, 0]);
  // Target 3 is refreshed to its aligned true position ≈ (1,1,0).
  const t = byId.get(3)!.xyz;
  assert.ok(Math.hypot(t[0] - 1, t[1] - 1, t[2] - 0) < 1e-6, `target aligned: ${t}`);
  assert.ok(byId.get(3)!.confidence > 0.9, "target confidence refreshed");
});
