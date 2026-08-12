/** FUG-112 — fusing a supplemental scan into an existing map. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { applySimilarity, type Similarity } from "../src/geom/fit";
import { fuseMaps } from "../src/geom/fuseMaps";

function led(id: number, xyz: Vec3, confidence = 0.8, nViews = 6): LedEntry {
  return { id, xyz, confidence, nViews, rmsReprojPx: 1.5, parallaxDeg: 20 };
}

function mapOf(leds: LedEntry[], ledCount = 32): OutputMap {
  return {
    mapId: "m",
    createdAt: "",
    units: "meters",
    frame: "gravity_leveled",
    ledCount,
    leds,
    unmapped: [],
    stats: { rmsReprojPxGlobal: 2, medianParallaxDeg: 18 },
  };
}

/** LED position on a 4-column grid with slight depth relief (a genuine 2D+
 * patch, so overlapping blocks are not collinear/degenerate). */
function pos(id: number): Vec3 {
  return [(id % 4) * 0.1, Math.floor(id / 4) * 0.1, ((id * 7) % 5) * 0.012];
}
function grid(ids: number[], conf = 0.8): LedEntry[] {
  return ids.map((id) => led(id, pos(id), conf));
}
function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** A non-trivial similarity to disguise the addition's frame. */
const DISGUISE: Similarity = {
  c: 1.7,
  // ~35° about Z.
  R: [0.819, -0.573, 0, 0.573, 0.819, 0, 0, 0, 1],
  d: [3, -2, 1],
};

function transformMap(m: OutputMap, t: Similarity): OutputMap {
  return { ...m, leds: m.leds.map((l) => ({ ...l, xyz: applySimilarity(t, l.xyz) })) };
}

test("registers an overlapping scan and adds the new LEDs", () => {
  const prior = mapOf(grid(range(0, 11))); // 3 rows × 4 cols
  // Addition sees the lower two rows (4..11) plus a fresh row (12..15), in a
  // disguised frame.
  const addition = transformMap(mapOf(grid(range(4, 15))), DISGUISE);

  const { map, report } = fuseMaps(prior, addition);
  assert.ok(report.registered, report.summary);
  assert.equal(report.common, 8);
  assert.ok(report.rmsM < 1e-3, `residual ${report.rmsM}`);
  assert.equal(report.added, 4);
  assert.deepEqual(map.leds.map((l) => l.id), range(0, 15));
  // The newly-added LED 12 lands back on the prior grid.
  const l12 = map.leds.find((l) => l.id === 12)!;
  const p12 = pos(12);
  assert.ok(
    Math.hypot(l12.xyz[0] - p12[0], l12.xyz[1] - p12[1], l12.xyz[2] - p12[2]) < 1e-3,
    `id12 at ${l12.xyz}`,
  );
});

test("corroboration raises confidence on re-seen LEDs", () => {
  const prior = mapOf(grid(range(0, 11), 0.5));
  const addition = transformMap(mapOf(grid(range(0, 11), 0.5)), DISGUISE);
  const { map, report } = fuseMaps(prior, addition);
  assert.ok(report.registered);
  assert.ok(report.improved >= 10);
  const l0 = map.leds.find((l) => l.id === 0)!;
  // Noisy-or of two 0.5 observations -> 0.75.
  assert.ok(Math.abs(l0.confidence - 0.75) < 1e-6, `conf ${l0.confidence}`);
  assert.equal(l0.nViews, 12);
});

test("refuses to register when too few LEDs overlap", () => {
  const prior = mapOf(grid(range(0, 11)));
  const addition = transformMap(mapOf(grid(range(10, 17))), DISGUISE); // only 10,11 common
  const { map, report } = fuseMaps(prior, addition);
  assert.equal(report.registered, false);
  assert.match(report.summary, /need 4 to register/);
  assert.equal(map, prior); // prior returned unchanged
});

test("refuses when the fixture moved (no consistent registration)", () => {
  const prior = mapOf(grid(range(0, 11)));
  // Keep ids but scatter most common LEDs by large, inconsistent offsets so no
  // similarity lines them up.
  const scattered = grid(range(0, 11)).map((l) => {
    const k = l.id;
    if (k % 2 === 0) return l; // leave a few in place
    return { ...l, xyz: [l.xyz[0] + 0.2 * (k % 3), l.xyz[1] - 0.15 * (k % 4), l.xyz[2] + 0.1] as Vec3 };
  });
  const { report } = fuseMaps(prior, transformMap(mapOf(scattered), DISGUISE));
  assert.equal(report.registered, false);
  assert.match(report.summary, /may have moved/);
});

test("conflicting re-seen LED defers to the stronger observation without a boost", () => {
  const prior = mapOf(grid(range(0, 11), 0.6));
  // Addition agrees on every anchor but places LED 5 ~50 mm off (a local error
  // past the agreement tolerance, but not enough to sink the whole fit).
  const addLeds = grid(range(0, 11), 0.9);
  const bad = addLeds.find((l) => l.id === 5)!;
  bad.xyz = [bad.xyz[0] + 0.05, bad.xyz[1], bad.xyz[2]];
  const addition = transformMap(mapOf(addLeds), DISGUISE);
  const { map, report } = fuseMaps(prior, addition);
  assert.ok(report.registered, report.summary);
  assert.ok(report.conflicts >= 1);
  const l5 = map.leds.find((l) => l.id === 5)!;
  // No corroboration boost on the conflicted LED.
  assert.ok(l5.confidence < 0.9, `conf ${l5.confidence}`);
});
