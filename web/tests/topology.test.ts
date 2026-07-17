/**
 * Graph-topology extraction (topology/extract.ts): wire-path segmentation,
 * polyline decimation, and per-LED (segment, arclength, perp) association.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { extractTopology } from "../src/topology/extract";

function led(id: number, xyz: Vec3): LedEntry {
  return { id, xyz, confidence: 1, nViews: 3, rmsReprojPx: 0.5, parallaxDeg: 20 };
}

function map(leds: LedEntry[]): OutputMap {
  return {
    mapId: "m1",
    createdAt: "2026-07-17T00:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: leds.length,
    leds,
    unmapped: [],
    stats: { rmsReprojPxGlobal: 0.5, medianParallaxDeg: 20 },
  };
}

test("a straight strip → one free-ended segment, decimated to its endpoints", () => {
  const t = extractTopology(map([0, 1, 2, 3, 4].map((i) => led(i, [i, 0, 0]))));
  assert.equal(t.mapId, "m1");
  assert.equal(t.segments.length, 1);
  const seg = t.segments[0]!;
  assert.equal(seg.a, -1);
  assert.equal(seg.b, -1);
  assert.deepEqual(seg.polyline, [[0, 0, 0], [4, 0, 0]], "a straight line decimates to 2 vertices");
  assert.ok(Math.abs(seg.length - 4) < 1e-9);
});

test("associations give monotonic arclength and ~zero perp on the wire", () => {
  const t = extractTopology(map([0, 1, 2, 3, 4].map((i) => led(i, [i, 0, 0]))));
  const a = t.associations;
  assert.equal(a.length, 5);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i]!.ledId, i);
    assert.equal(a[i]!.segmentId, 0);
    assert.ok(Math.abs(a[i]!.footArclength - i) < 1e-9, `arclength ${i}`);
    assert.ok(a[i]!.dPerp < 1e-9);
  }
});

test("an L-bend keeps the corner and arclength follows the path", () => {
  // right angle at (2,0,0); the bend must survive decimation.
  const pts: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 1, 0], [2, 2, 0]];
  const t = extractTopology(map(pts.map((p, i) => led(i, p))));
  assert.equal(t.segments.length, 1);
  assert.deepEqual(t.segments[0]!.polyline, [[0, 0, 0], [2, 0, 0], [2, 2, 0]]);
  assert.ok(Math.abs(t.segments[0]!.length - 4) < 1e-9);
  // LED 3 at (2,1,0) sits at arclength 2 (to the corner) + 1 = 3.
  const a3 = t.associations.find((a) => a.ledId === 3)!;
  assert.ok(Math.abs(a3.footArclength - 3) < 1e-9, `got ${a3.footArclength}`);
  assert.ok(a3.dPerp < 1e-9);
});

test("a large gap splits into two segments (separate strips)", () => {
  const near = [0, 1, 2].map((i) => led(i, [i, 0, 0]));
  const far = [3, 4].map((i) => led(i, [20 + (i - 3), 0, 0]));
  const t = extractTopology(map([...near, ...far]));
  assert.equal(t.segments.length, 2);
  assert.equal(t.associations.filter((a) => a.segmentId === 0).length, 3);
  assert.equal(t.associations.filter((a) => a.segmentId === 1).length, 2);
});

test("decimation respects the polyline vertex cap", () => {
  // A zig-zag that resists simplification, capped to 5 vertices.
  const pts: Vec3[] = Array.from({ length: 40 }, (_, i) => [i, i % 2 === 0 ? 0 : 1, 0] as Vec3);
  const t = extractTopology(map(pts.map((p, i) => led(i, p))), { maxPolyline: 5 });
  assert.ok(t.segments[0]!.polyline.length <= 5, `got ${t.segments[0]!.polyline.length}`);
  // Every LED still gets an association.
  assert.equal(t.associations.length, 40);
});

test("fewer than two LEDs → empty topology", () => {
  assert.deepEqual(extractTopology(map([led(0, [0, 0, 0])])).segments, []);
  assert.deepEqual(extractTopology(map([])).associations, []);
});
