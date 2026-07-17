/**
 * Skeleton topology extraction (topology/extract.ts): recover the graph from
 * the point cloud ALONE — no wiring/id-order assumption. k-NN → MST forest →
 * segments + branch points → per-LED association.
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

// A line of points; IDs are assigned in the given (possibly scrambled) order.
function line(count: number, order?: number[]): LedEntry[] {
  const ids = order ?? Array.from({ length: count }, (_, i) => i);
  return ids.map((id, i) => led(id, [i, 0, 0]));
}

test("a straight strip → one segment, regardless of LED id order", () => {
  const inOrder = extractTopology(map(line(8)));
  assert.equal(inOrder.segments.length, 1);
  assert.equal(inOrder.branchPoints.length, 0);
  assert.equal(inOrder.associations.length, 8);

  // Same POINTS, scrambled ids — geometry-only, so the same topology.
  const scrambled = extractTopology(map(line(8, [4, 0, 7, 2, 5, 1, 6, 3])));
  assert.equal(scrambled.segments.length, 1);
  assert.ok(Math.abs(scrambled.segments[0]!.length - inOrder.segments[0]!.length) < 1e-9);
  assert.equal(scrambled.associations.length, 8);
});

test("every LED gets an association with small perp on a clean strip", () => {
  const t = extractTopology(map(line(10)));
  assert.equal(t.associations.length, 10);
  for (const a of t.associations) {
    assert.equal(a.segmentId, 0);
    assert.ok(a.dPerp < 1e-6, `on-strip LED perp≈0, got ${a.dPerp}`);
    assert.ok(a.footArclength >= -1e-9 && a.footArclength <= t.segments[0]!.length + 1e-9);
  }
});

test("a Y junction → one branch point and three segments", () => {
  // trunk to a centre at (2,0,0), then two arms.
  const pts: Vec3[] = [
    [0, 0, 0], [1, 0, 0], [2, 0, 0], // trunk + centre
    [3, 1, 0], [4, 2, 0], // arm A
    [3, -1, 0], [4, -2, 0], // arm B
  ];
  const t = extractTopology(map(pts.map((p, i) => led(i, p))));
  assert.equal(t.branchPoints.length, 1, "the centre is a junction");
  assert.equal(t.segments.length, 3, "three arms");
  // Every arm references the branch point at one end.
  const bp = t.branchPoints[0]!.id;
  assert.ok(t.segments.every((s) => s.a === bp || s.b === bp));
  assert.equal(t.associations.length, pts.length);
});

test("two separated strips → two segments, no junction", () => {
  const a = [0, 1, 2, 3].map((i) => led(i, [i, 0, 0]));
  const b = [4, 5, 6, 7].map((i) => led(i, [i - 4, 10, 0])); // 10 m away
  const t = extractTopology(map([...a, ...b]));
  assert.equal(t.segments.length, 2);
  assert.equal(t.branchPoints.length, 0);
});

test("radiusFactor controls whether a gap splits the strip", () => {
  // A strip with one 4× gap in the middle.
  const pts: Vec3[] = [[0, 0, 0], [1, 0, 0], [5, 0, 0], [6, 0, 0]];
  const leds = pts.map((p, i) => led(i, p));
  // Tight radius → the gap (dist 4, spacing 1) breaks it into two.
  assert.equal(extractTopology(map(leds), { radiusFactor: 2 }).segments.length, 2);
  // Loose radius → bridges the gap into one.
  assert.equal(extractTopology(map(leds), { radiusFactor: 6 }).segments.length, 1);
});

test("fewer than two LEDs → empty topology", () => {
  assert.deepEqual(extractTopology(map([led(0, [0, 0, 0])])).segments, []);
  assert.deepEqual(extractTopology(map([])).associations, []);
});
