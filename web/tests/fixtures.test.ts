/**
 * Synthetic effect fixtures (effects/fixtures.ts): deterministic point clouds
 * that the REAL topology extractor turns into sane skeletons — the same path
 * real captured data takes into the effects-simulator workspace.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractTopology } from "../src/topology/extract";
import { generateFixture } from "../src/effects/fixtures";

const opts = { seed: 7, jitterFrac: 0.05 };

test("a strip generates the requested LED count and one segment", async () => {
  const map = generateFixture("strip", { count: 24, ...opts });
  assert.equal(map.leds.length, 24);
  assert.equal(map.units, "meters");
  const topo = await extractTopology(map);
  assert.equal(topo.segments.length, 1);
  assert.equal(topo.branchPoints.length, 0);
});

test("a ring extracts as a loop (a closed cycle, no degree-2 anchors)", async () => {
  const map = generateFixture("ring", { count: 40, ...opts });
  const topo = await extractTopology(map); // default loopFactor closes the ring
  // The ring has no junction, so the degree-2 dissolve reduces it to a single
  // closed self-loop (a === b) — or, with jitter, two arcs sharing one pair.
  // Either way it must remain a cycle.
  const selfLoop = topo.segments.some((s) => s.a >= 0 && s.a === s.b);
  const seen = new Set<string>();
  let sharedPair = false;
  for (const s of topo.segments) {
    if (s.a < 0 || s.b < 0) continue;
    const key = [s.a, s.b].sort((x, y) => x - y).join("-");
    if (seen.has(key)) sharedPair = true;
    seen.add(key);
  }
  assert.ok(selfLoop || sharedPair, "the ring stays a cycle");
});

test("a star extracts a junction", async () => {
  const map = generateFixture("star", { count: 60, ...opts });
  const topo = await extractTopology(map);
  assert.ok(topo.branchPoints.length >= 1, "the shared centre is a junction");
  assert.ok(topo.segments.length >= 3, "arms are separate segments");
});

test("generation is deterministic for a given seed", async () => {
  const a = generateFixture("squiggle", { count: 30, ...opts });
  const b = generateFixture("squiggle", { count: 30, ...opts });
  assert.deepEqual(a.leds.map((l) => l.xyz), b.leds.map((l) => l.xyz));
  const c = generateFixture("squiggle", { count: 30, seed: 8, jitterFrac: 0.05 });
  assert.notDeepEqual(a.leds.map((l) => l.xyz), c.leds.map((l) => l.xyz));
});

test("every LED gets an effect-ready association", async () => {
  for (const kind of ["strip", "ring", "helix", "grid", "tree"] as const) {
    const map = generateFixture(kind, { count: 50, ...opts });
    const topo = await extractTopology(map);
    assert.equal(topo.associations.length, map.leds.length, `${kind}: all LEDs associated`);
  }
});
