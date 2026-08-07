/**
 * treeGeometry (src/fx/treeGeometry.ts) — the virtual tree topology-aware
 * previews run on. Pins the emitted shape and checks it round-trips through the
 * real deriveLedTopology(), so the VM sees seg/dist just like on a strand tree.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildVirtualTree } from "../src/fx/treeGeometry";
import { deriveLedTopology } from "../src/fx/preview";

test("buildVirtualTree emits consistent, in-bounds geometry", () => {
  const t = buildVirtualTree({ size: 64 });
  const n = t.ledIds.length;
  assert.ok(n > 0);
  assert.equal(t.positions.length, n * 3);
  assert.equal(t.coords2d.length, n * 2);
  assert.equal(t.map.leds.length, n);
  assert.equal(t.topology.associations.length, n);

  // Coords normalized to 0..1; positions z is always 0.
  for (let i = 0; i < n; i++) {
    assert.ok(t.coords2d[i * 2]! >= 0 && t.coords2d[i * 2]! <= 1);
    assert.ok(t.coords2d[i * 2 + 1]! >= 0 && t.coords2d[i * 2 + 1]! <= 1);
    assert.equal(t.positions[i * 3 + 2], 0);
  }
});

test("a full binary tree of depth D has 2^(D+1)-1 segments, one trunk base", () => {
  const depth = 4;
  const t = buildVirtualTree({ depth, size: 64 });
  assert.equal(t.topology.segments.length, 2 ** (depth + 1) - 1); // 31
  // Exactly one free end at the base (trunk a = -1); leaves are the free b ends.
  const trunk = t.topology.segments.filter((s) => s.a === -1);
  assert.equal(trunk.length, 1);
  const leaves = t.topology.segments.filter((s) => s.b === -1);
  assert.equal(leaves.length, 2 ** depth); // 16
  // Internal fork nodes: 2^D - 1.
  assert.equal(t.topology.branchPoints.length, 2 ** depth - 1); // 15
});

test("associations stay within their segment and every LED maps to a segment", () => {
  const t = buildVirtualTree({ size: 64 });
  const segLen = new Map(t.topology.segments.map((s) => [s.id, s.length]));
  for (const a of t.topology.associations) {
    assert.ok(segLen.has(a.segmentId));
    assert.ok(a.footArclength >= 0 && a.footArclength <= segLen.get(a.segmentId)! + 1e-6);
  }
});

test("geometry round-trips through deriveLedTopology into a real seg/dist field", () => {
  const t = buildVirtualTree({ size: 64 });
  const topo = deriveLedTopology(t.map, t.topology);
  // Every LED lands on a segment (none default to -1), and the geodesic field
  // spans 0..1 (so flood/pulse have a real wavefront to ride).
  assert.equal(topo.seg.length, t.ledIds.length);
  assert.ok([...topo.seg].every((s) => s >= 0), "all LEDs associated");
  let maxDist = 0;
  for (const d of topo.dist) {
    assert.ok(d >= 0 && d <= 1);
    maxDist = Math.max(maxDist, d);
  }
  assert.ok(maxDist > 0.5, "geodesic field reaches across the tree");
});
