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
  // A ring has NO junction, so the degree-2 dissolve reduces it to a single
  // closed self-loop segment anchored at one seam point (not two degree-2
  // pass-through anchors).
  assert.equal(t.branchPoints.length, 1, "one seam anchor, no degree-2 pass-throughs");
  assert.equal(t.segments.length, 1, "one closed self-loop segment");
  assert.ok(t.segments[0]!.a === t.segments[0]!.b, "the segment loops back on itself");
  assert.ok(hasCycle(t), "the self-loop is a cycle");
  assert.equal(t.associations.length, 16, "every LED associated");

  // Geometry-only: scrambling ids yields the same cyclic topology.
  const scrambled = await extractTopology(map(ring(16, [9, 2, 14, 5, 0, 11, 7, 3, 15, 1, 8, 12, 4, 10, 6, 13])));
  assert.ok(hasCycle(scrambled), "still a cycle with scrambled ids");
  assert.equal(scrambled.associations.length, 16);
});

test("a lollipop keeps its loop even though the loop breaks at a non-end node", async () => {
  // A stem leading into a ring (a "lollipop"/"P"). The ring is a cycle whose
  // nodes are NOT degree-1 after the MST opens it (the break points keep two
  // neighbours), so the old degree-1-only loop closure could not re-close it.
  // The direction-based closure must: the seam continues the ring smoothly.
  const pts: Vec3[] = [];
  let id = 0;
  const add = (x: number, y: number): void => {
    pts.push([x, y, 0]);
    id++;
  };
  for (let x = -4; x < 0; x++) add(x, 0); // stem, ending just before the ring
  const N = 16;
  const R = 1 / (2 * Math.sin(Math.PI / N)); // unit chord spacing
  // Ring centred at (R,0) so it passes through the origin (θ=π), where the stem
  // meets it. θ=π is the shared node (added once here); the stem stops at x=-1.
  for (let kk = 0; kk < N; kk++) {
    const th = Math.PI + (2 * Math.PI * kk) / N;
    add(R + R * Math.cos(th), R * Math.sin(th));
  }
  const t = await extractTopology(map(pts.map((p, i) => led(i, p))));
  assert.ok(hasCycle(t), "the lollipop's loop survives the MST + re-closure");
  assert.equal(t.associations.length, pts.length, "every LED associated");
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

test("fewer than two LEDs → empty topology", async () => {
  assert.deepEqual((await extractTopology(map([led(0, [0, 0, 0])]))).segments, []);
  assert.deepEqual((await extractTopology(map([]))).associations, []);
});

test("a short spur off mid-strand is pruned AND its junction collapses", async () => {
  // A straight strip with one k-NN-noise stub hanging off the middle. The old
  // extractor pruned the stub chain but left the mid-strand node a branch point
  // with two segments meeting at it (a spurious junction). The re-trace over the
  // pruned graph must collapse it: one clean segment, no branch point.
  const pts: LedEntry[] = [];
  for (let i = 0; i < 10; i++) pts.push(led(i, [i, 0, 0]));
  pts.push(led(10, [5, 0.4, 0])); // short perpendicular stub off LED 5
  const t = await extractTopology(map(pts));
  assert.equal(t.branchPoints.length, 0, "pruned-spur junction must be collapsed away");
  assert.equal(t.segments.length, 1, "one clean segment through the former junction");
});

test("a junction over-split into two nearby branch points merges into one", async () => {
  // A horizontal strand with an up-arm branching at (2,0) and a down-arm at
  // (2.5,0): two genuine degree-3 nodes only 0.5 apart, joined by a short
  // connector segment. That is one physical junction the extractor split in two;
  // mergeFactor must contract the short connector into a single branch point.
  // (Arms are 4 long so none is pruned as a spur — pruneFactor·spacing = 3.)
  const pts: LedEntry[] = [
    [-2, 0, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0],
    [2, 0, 0], // up-arm root
    [2.5, 0, 0], // down-arm root
    [3.5, 0, 0], [4.5, 0, 0], [5.5, 0, 0], [6.5, 0, 0],
    [2, 1, 0], [2, 2, 0], [2, 3, 0], [2, 4, 0], // up arm
    [2.5, -1, 0], [2.5, -2, 0], [2.5, -3, 0], [2.5, -4, 0], // down arm
  ].map((p, i) => led(i, p as Vec3));

  // Off: the split is visible — two branch points a hair apart.
  const raw = await extractTopology(map(pts), { mergeFactor: 0 });
  assert.equal(raw.branchPoints.length, 2, "without merge, the junction stays split");

  // On (default): the short connector contracts to a single junction.
  const t = await extractTopology(map(pts));
  assert.equal(t.branchPoints.length, 1, "the near-coincident junctions merge");
  assert.ok(
    t.segments.every((sg) => sg.a !== sg.b),
    "no zero-ish self-loop left by the contraction",
  );
  assert.equal(t.associations.length, pts.length, "every LED still associated");
});

// Every segment must physically reach the branch point it references: its
// polyline endpoint coincides with that junction's position. (The old merge
// moved junctions to a centroid but left the segments at their old positions,
// visibly disconnecting them.)
function segmentsReachJunctions(t: Awaited<ReturnType<typeof extractTopology>>): boolean {
  const bp = new Map(t.branchPoints.map((b) => [b.id, b.xyz]));
  const near = (p: Vec3, q: Vec3): boolean => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-6;
  for (const sg of t.segments) {
    if (sg.a >= 0 && !near(sg.polyline[0]!, bp.get(sg.a)!)) return false;
    if (sg.b >= 0 && !near(sg.polyline[sg.polyline.length - 1]!, bp.get(sg.b)!)) return false;
  }
  return true;
}

test("merged junctions stay connected — segments reach the merged branch point", async () => {
  // The over-split junction (two degree-3 nodes 0.5 apart) merges into one; every
  // segment that touched either must physically reach the surviving junction.
  const pts: LedEntry[] = [
    [-2, 0, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0], [2, 0, 0], [2.5, 0, 0],
    [3.5, 0, 0], [4.5, 0, 0], [5.5, 0, 0], [6.5, 0, 0],
    [2, 1, 0], [2, 2, 0], [2, 3, 0], [2, 4, 0],
    [2.5, -1, 0], [2.5, -2, 0], [2.5, -3, 0], [2.5, -4, 0],
  ].map((p, i) => led(i, p as Vec3));
  const t = await extractTopology(map(pts));
  assert.equal(t.branchPoints.length, 1, "merged to one junction");
  assert.ok(segmentsReachJunctions(t), "every segment reaches the merged junction (no gap)");
  // And the invariant holds on the crossing-heavy double figure-8 too.
  assert.ok(segmentsReachJunctions(await extractTopology(map(doubleFigureEight()))), "double-8: connected");
});

test("mergeFactor keeps a genuine loop (long parallel arc survives as a self-loop)", async () => {
  // A ring's two anchors are joined by two LONG arcs, not a short connector, so
  // the merge must NOT fuse them away — the cycle has to stay a cycle.
  const t = await extractTopology(map(ring(16)));
  assert.ok(hasCycle(t), "the ring's loop is preserved through the merge pass");
  assert.equal(t.associations.length, 16);
});

test("debug report flags coincident LEDs (solve degeneracy)", async () => {
  // LED 5 is solved coincident with LED 2 — a zero-length graph shortcut that
  // would bridge distant parts of a strand. The debug report must surface it.
  const pts: LedEntry[] = [];
  for (let i = 0; i < 8; i++) pts.push(led(i, [i, 0, 0]));
  pts[5] = led(5, [2, 0, 0]); // coincident with LED 2
  const t = await extractTopology(map(pts), { debug: true });
  assert.ok(t.debug, "debug present when requested");
  assert.ok(
    t.debug!.coincident.some((c) => c.dist < 1e-6),
    "the coincident pair is flagged (dist ~0)",
  );
  assert.ok(t.debug!.edges.length > 0, "graph edges are reported for the overlay");
  // Without debug, no report (and existing callers keep the plain Topology).
  const plain = await extractTopology(map(pts));
  assert.equal((plain as { debug?: unknown }).debug, undefined);
});

test("a folded strand gets NO false mid-loop chord (only strand ends can close)", async () => {
  // A hairpin whose two arms run ~1.6 apart (interior points pass near each
  // other) but whose free ends are far apart. The old rule bridged the interior
  // approaches (false mid-loop chords → geodesic shortcuts); the fix rejects
  // them because both endpoints are degree-2, and the ends are too far to close.
  const pts: LedEntry[] = [];
  let id = 0;
  for (let x = 0; x <= 4; x++) pts.push(led(id++, [x, 0, 0])); // arm A, end at x=0
  pts.push(led(id++, [5, 0.8, 0])); // turn
  for (let x = 4; x >= 2; x--) pts.push(led(id++, [x, 1.6, 0])); // arm B near arm A
  pts.push(led(id++, [1, 2.6, 0]));
  pts.push(led(id++, [0, 3.6, 0])); // arm B end, far from arm A's end
  const t = await extractTopology(map(pts), { debug: true });
  assert.equal(t.debug!.edges.filter((e) => e.chord).length, 0, "interior fold must not be chorded");
  assert.equal(t.branchPoints.length, 0, "still one open strand");
});

test("a real ring still closes at its strand ends (exactly one loop-chord)", async () => {
  const N = 16;
  const R = 2.5;
  const pts: LedEntry[] = [];
  for (let k = 0; k < N; k++) {
    pts.push(led(k, [R * Math.cos((2 * Math.PI * k) / N), R * Math.sin((2 * Math.PI * k) / N), 0]));
  }
  const t = await extractTopology(map(pts), { debug: true });
  assert.equal(t.debug!.edges.filter((e) => e.chord).length, 1, "the ring closes with one chord at its seam");
});

// A closed "double figure-8": a single strand that crosses ITSELF at two points
// — (2,0) and (4,0) — rather than the figure-8's single crossing. Arm A sweeps
// y = amp·sin(πx/2) left→right across x∈[0,6] (an up/down/up weave); arm B is its
// mirror (y negated) returning right→left. The arms coincide exactly at x=2 and
// x=4 (where sin=0 — the crossings) and bow ±amp apart between them, forming
// three lobes joined at two degree-4 nodes. This is the hard degeneracy case:
// distinct parts of one strand are solved coincident (at each crossing) AND two
// arcs run in parallel between the same pair of junctions (a double edge).
function doubleFigureEight(amp = 2, step = 0.5): LedEntry[] {
  const yA = (x: number): number => amp * Math.sin((Math.PI * x) / 2);
  const pts: Vec3[] = [];
  for (let x = 0; x <= 6 + 1e-9; x += step) pts.push([x, yA(x), 0]); // arm A  →
  for (let x = 6 - step; x > 1e-9; x -= step) pts.push([x, -yA(x), 0]); // arm B  ←
  return pts.map((p, i) => led(i, p));
}

// The extractor now yields TWO junctions with the lobes kept as loops
// (coincidence-merge + degree-2 dissolve took it from a 6-branch-point spray to
// a clean 2-junction cycle). What is NOT yet solved is LOCALISING those junctions
// onto the crossings: the spanning tree keeps only a subset of each merged
// crossing node's edges, so the junctions land off to the side rather than at
// (2,0)/(4,0). That needs MST re-routing around merged nodes — a deeper change.
// Kept `todo` (asserting the ideal) to document that remaining gap; drop the flag
// once the junctions localise to the crossings.
test("a double figure-8 resolves its two self-crossings as junctions", { todo: true }, async () => {
  const t = await extractTopology(map(doubleFigureEight()), { debug: true });
  const nearCrossing = (xy: Vec3): boolean =>
    t.branchPoints.some((b) => Math.hypot(b.xyz[0] - xy[0], b.xyz[1] - xy[1]) < 0.6);
  assert.equal(t.branchPoints.length, 2, "one junction per self-crossing");
  assert.ok(nearCrossing([2, 0, 0]), "a junction sits at the first crossing (2,0)");
  assert.ok(nearCrossing([4, 0, 0]), "a junction sits at the second crossing (4,0)");
  assert.ok(hasCycle(t), "the lobes remain closed loops");
  assert.equal(t.associations.length, 24, "every LED associated");
});

// The invariant the solver must uphold: NO degree-2 pass-through junction ever
// survives — a branch point where two DISTINCT segments meet is spliced into one.
// (A self-loop anchor, both ends of ONE segment, is allowed: a ring needs a seam.)
function noDegree2PassThrough(t: Awaited<ReturnType<typeof extractTopology>>): boolean {
  const ends = new Map<number, number[]>(); // branch id → incident segment ids
  for (const sg of t.segments) {
    for (const e of [sg.a, sg.b]) {
      if (e < 0) continue;
      let arr = ends.get(e);
      if (!arr) ends.set(e, (arr = []));
      arr.push(sg.id);
    }
  }
  for (const segs of ends.values()) {
    if (segs.length === 2 && segs[0] !== segs[1]) return false; // two distinct segments → pass-through
  }
  return true;
}

test("no degree-2 pass-through junctions survive in the output", async () => {
  // The double figure-8 previously left several degree-2 branch points (loop
  // anchors that were really pass-throughs); the dissolve pass must remove them.
  assert.ok(noDegree2PassThrough(await extractTopology(map(doubleFigureEight()))), "double-8: none");
  assert.ok(noDegree2PassThrough(await extractTopology(map(ring(16)))), "ring: none (self-loop is exempt)");
  // A Y and a plain strip must stay clean too.
  const y = await extractTopology(
    map([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 1, 0], [4, 2, 0], [3, -1, 0], [4, -2, 0]].map((p, i) => led(i, p as Vec3))),
  );
  assert.ok(noDegree2PassThrough(y), "Y: none");
});
