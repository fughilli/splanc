/**
 * deriveLedTopology (fx/preview.ts): the BROWSER MIRROR of the device's per-LED
 * topology cache (firmware/player_app/ffi.rs `fx_rebuild_topo`). This locks the
 * two to the same led.seg / led.s / led.branch so the offline preview matches
 * the hardware. The numbers below mirror the firmware ffi end-to-end test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { deriveLedTopology } from "../src/fx/preview";

// Minimal map: four LEDs with ids 0..3 (positions don't matter here).
const map = {
  leds: [0, 1, 2, 3].map((id) => ({ id })),
} as unknown as OutputMap;

// Y-junction: branch point 0 (degree 3 -> a junction) roots segments 10/11/12.
const topology: Topology = {
  mapId: "m1",
  branchPoints: [0, 1, 2, 3].map((id) => ({ id, xyz: [0, 0, 0] as [number, number, number] })),
  segments: [
    { id: 10, a: 0, b: 1, length: 1, polyline: [] },
    { id: 11, a: 0, b: 2, length: 1, polyline: [] },
    { id: 12, a: 0, b: 3, length: 1, polyline: [] },
  ],
  associations: [
    { ledId: 0, segmentId: 10, footArclength: 0.02, dPerp: 0 }, // near junction
    { ledId: 1, segmentId: 10, footArclength: 0.5, dPerp: 0 }, // mid-segment
    { ledId: 2, segmentId: 11, footArclength: 0.99, dPerp: 0 }, // near terminal
    // LED 3 has no association.
  ],
};

test("deriveLedTopology matches the device cache", () => {
  const t = deriveLedTopology(map, topology);
  // Segment INDEX (position in segments), -1 for the unassociated LED.
  assert.deepEqual([...t.seg], [0, 0, 1, -1]);
  // Normalized arclength.
  assert.ok(Math.abs(t.s[0]! - 0.02) < 1e-6);
  assert.ok(Math.abs(t.s[1]! - 0.5) < 1e-6);
  assert.ok(Math.abs(t.s[2]! - 0.99) < 1e-6);
  assert.equal(t.s[3], 0);
  // Only LED 0 sits at the junction (degree-3 branch point 0); the terminal
  // ends (degree 1) are not junctions.
  assert.deepEqual([...t.branch], [1, 0, 0, 0]);
});

test("deriveLedTopology returns all-default topology without a topology", () => {
  const t = deriveLedTopology(map, undefined);
  assert.deepEqual([...t.seg], [-1, -1, -1, -1]);
  assert.deepEqual([...t.branch], [0, 0, 0, 0]);
});
