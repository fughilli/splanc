/**
 * Skeleton topology extraction (topology/extract.ts): recover the graph from
 * the point cloud ALONE — no wiring/id-order assumption. k-NN → MST forest →
 * segments + branch points → per-LED association.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { edgeKey, extractTopology } from "../src/topology/extract";

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

test("a straight strip → one segment, regardless of LED id order", async () => {
  const inOrder = await extractTopology(map(line(8)));
  assert.equal(inOrder.segments.length, 1);
  assert.equal(inOrder.branchPoints.length, 0);
  assert.equal(inOrder.associations.length, 8);

  // Same POINTS, scrambled ids — geometry-only, so the same topology.
  const scrambled = await extractTopology(map(line(8, [4, 0, 7, 2, 5, 1, 6, 3])));
  assert.equal(scrambled.segments.length, 1);
  assert.ok(Math.abs(scrambled.segments[0]!.length - inOrder.segments[0]!.length) < 1e-9);
  assert.equal(scrambled.associations.length, 8);
});

test("every LED gets an association with small perp on a clean strip", async () => {
  const t = await extractTopology(map(line(10)));
  assert.equal(t.associations.length, 10);
  for (const a of t.associations) {
    assert.equal(a.segmentId, 0);
    assert.ok(a.dPerp < 1e-6, `on-strip LED perp≈0, got ${a.dPerp}`);
    assert.ok(a.footArclength >= -1e-9 && a.footArclength <= t.segments[0]!.length + 1e-9);
  }
});

test("a Y junction → one branch point and three segments", async () => {
  // trunk to a centre at (2,0,0), then two arms.
  const pts: Vec3[] = [
    [0, 0, 0], [1, 0, 0], [2, 0, 0], // trunk + centre
    [3, 1, 0], [4, 2, 0], // arm A
    [3, -1, 0], [4, -2, 0], // arm B
  ];
  const t = await extractTopology(map(pts.map((p, i) => led(i, p))));
  assert.equal(t.branchPoints.length, 1, "the centre is a junction");
  assert.equal(t.segments.length, 3, "three arms");
  // Every arm references the branch point at one end.
  const bp = t.branchPoints[0]!.id;
  assert.ok(t.segments.every((s) => s.a === bp || s.b === bp));
  assert.equal(t.associations.length, pts.length);
});

test("two separated strips → two segments, no junction", async () => {
  const a = [0, 1, 2, 3].map((i) => led(i, [i, 0, 0]));
  const b = [4, 5, 6, 7].map((i) => led(i, [i - 4, 10, 0])); // 10 m away
  const t = await extractTopology(map([...a, ...b]));
  assert.equal(t.segments.length, 2);
  assert.equal(t.branchPoints.length, 0);
});

test("radiusFactor controls whether a gap splits the strip", async () => {
  // A strip with one 4× gap in the middle.
  const pts: Vec3[] = [[0, 0, 0], [1, 0, 0], [5, 0, 0], [6, 0, 0]];
  const leds = pts.map((p, i) => led(i, p));
  // Tight radius → the gap (dist 4, spacing 1) breaks it into two.
  assert.equal((await extractTopology(map(leds), { radiusFactor: 2 })).segments.length, 2);
  // Loose radius → bridges the gap into one.
  assert.equal((await extractTopology(map(leds), { radiusFactor: 6 })).segments.length, 1);
});

// A closed ring of `count` points, unit spacing, in the XY plane.
function ring(count: number, order?: number[]): LedEntry[] {
  const R = 1 / (2 * Math.sin(Math.PI / count)); // chord spacing ≈ 1
  const pts: Vec3[] = Array.from({ length: count }, (_, i) => {
    const th = (2 * Math.PI * i) / count;
    return [R * Math.cos(th), R * Math.sin(th), 0];
  });
  const ids = order ?? Array.from({ length: count }, (_, i) => i);
  return ids.map((id, i) => led(id, pts[i]!));
}

// The two segments of a graph share the same unordered endpoint pair → a cycle.
function hasCycle(t: Awaited<ReturnType<typeof extractTopology>>): boolean {
  const key = (s: { a: number; b: number }): string =>
    s.a === s.b ? `self${s.a}` : [s.a, s.b].sort((x, y) => x - y).join("-");
  const seen = new Set<string>();
  for (const s of t.segments) {
    if (s.a < 0 || s.b < 0) continue; // an open end can't be part of a cycle
    const k = key(s);
    if (s.a === s.b || seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

test("a closed ring keeps its loop (flood can swirl); id-order-independent", async () => {
  const t = await extractTopology(map(ring(16)));
  assert.equal(t.branchPoints.length, 2, "the ring anchors at the chord's ends");
  assert.equal(t.segments.length, 2, "two arcs between the anchors");
  assert.ok(hasCycle(t), "the two arcs form a cycle");
  assert.equal(t.associations.length, 16, "every LED associated");

  // Geometry-only: scrambling ids yields the same cyclic topology.
  const scrambled = await extractTopology(map(ring(16, [9, 2, 14, 5, 0, 11, 7, 3, 15, 1, 8, 12, 4, 10, 6, 13])));
  assert.ok(hasCycle(scrambled), "still a cycle with scrambled ids");
  assert.equal(scrambled.associations.length, 16);
});

test("loopFactor 0 breaks the ring into an open path (pure forest)", async () => {
  const t = await extractTopology(map(ring(16)), { loopFactor: 0 });
  assert.equal(t.branchPoints.length, 0, "no anchors without loop closure");
  assert.equal(t.segments.length, 1, "the ring opens into a single strip");
  assert.ok(!hasCycle(t));
});

test("simplify with a 0 tolerance still terminates (no infinite loop)", async () => {
  // A long strip decimated to a tight vertex budget with simplifyFrac=0: the
  // tolerance-relaxation loop must not spin forever (regression).
  const t = await extractTopology(map(line(40)), { simplifyFrac: 0, maxPolyline: 4 });
  assert.equal(t.segments.length, 1);
  assert.ok(t.segments[0]!.polyline.length <= 4, "decimated to the vertex budget");
  assert.ok(t.segments[0]!.polyline.length >= 2, "endpoints kept");
});

test("an AbortSignal cancels a running extraction", async () => {
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => extractTopology(map(line(300)), {}, { signal: ac.signal }),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
});

test("reports progress on a large map", async () => {
  const fracs: number[] = [];
  const t = await extractTopology(map(line(300)), {}, { onProgress: (f) => fracs.push(f) });
  assert.equal(t.segments.length, 1);
  assert.ok(fracs.length > 0, "progress was reported");
  assert.ok(
    fracs.every((f) => f >= 0 && f <= 1) && Math.max(...fracs) === 1,
    "progress runs within [0,1] and reaches 1",
  );
});

test("manual edits: cutEdges splits a strip, forceEdges bridges strips", async () => {
  // Cut the 3–4 edge of a straight strip → two segments.
  const cut = await extractTopology(map(line(8)), { cutEdges: [edgeKey(3, 4)] });
  assert.equal(cut.segments.length, 2, "the cut splits the strip");

  // Two separate strips 10 m apart; force an edge between their near ends →
  // one connected fixture (endpoints 3 & 4 become junction anchors).
  const a = [0, 1, 2, 3].map((i) => led(i, [i, 0, 0]));
  const b = [4, 5, 6, 7].map((i) => led(i, [i - 4, 10, 0]));
  const bridged = await extractTopology(map([...a, ...b]), { forceEdges: [edgeKey(3, 4)] });
  assert.equal(bridged.branchPoints.length, 2, "forced endpoints anchor the join");
  assert.equal(bridged.segments.length, 3, "two arms + the forced link");
  // Edits survive re-extraction with different slider values.
  const again = await extractTopology(map([...a, ...b]), {
    forceEdges: [edgeKey(3, 4)],
    radiusFactor: 4,
    simplifyFrac: 0.2,
  });
  assert.equal(again.segments.length, 3, "edit persists across a re-extract");
});

test("fewer than two LEDs → empty topology", async () => {
  assert.deepEqual((await extractTopology(map([led(0, [0, 0, 0])]))).segments, []);
  assert.deepEqual((await extractTopology(map([]))).associations, []);
});
