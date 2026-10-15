/** FUG-112 — fusing a supplemental scan into an existing map. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { applySimilarity, type Similarity } from "../src/geom/fit";
import { concatObservations, fuseMaps, spreadRatio } from "../src/geom/fuseMaps";

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

// ---------------------------------------------------------------------------
// Low-confidence re-solve: anchors stay, weak base LEDs get new solutions.
// ---------------------------------------------------------------------------

/** A prior whose LEDs ≥ `weakFrom` are low-confidence AND displaced by `err`
 * (the base capture triangulated them badly). */
function weakPrior(weakFrom: number, err: number): OutputMap {
  return mapOf(
    range(0, 11).map((id) =>
      id >= weakFrom
        ? { ...led(id, [pos(id)[0] + err, pos(id)[1] - err, pos(id)[2]], 0.3, 3), parallaxDeg: 3 }
        : led(id, pos(id), 0.95, 20),
    ),
  );
}

test("well-solved base LEDs stay anchored; weak ones are re-solved toward the better estimate", () => {
  const prior = weakPrior(8, 0.008);
  // The supplement saw everything well (many views, wide parallax).
  const addition = transformMap(
    mapOf(range(0, 11).map((id) => ({ ...led(id, pos(id), 0.95, 24), parallaxDeg: 35 }))),
    DISGUISE,
  );
  const { map, report, provenance } = fuseMaps(prior, addition);
  assert.ok(report.registered, report.summary);
  assert.equal(report.method, "registered");
  assert.equal(report.anchors, 8); // fitted on the well-solved LEDs only
  assert.equal(report.resolved, 4);
  for (const id of range(0, 7)) {
    const l = map.leds.find((x) => x.id === id)!;
    assert.deepEqual(l.xyz, pos(id)); // anchored: bit-identical base position
    assert.equal(provenance.get(id), "base");
  }
  for (const id of range(8, 11)) {
    const l = map.leds.find((x) => x.id === id)!;
    assert.equal(provenance.get(id), "updated");
    // Inverse-variance fusion pulls it most of the way to the (much tighter)
    // supplemental estimate: < 1 mm from truth vs 11 mm before.
    const e = Math.hypot(l.xyz[0] - pos(id)[0], l.xyz[1] - pos(id)[1], l.xyz[2] - pos(id)[2]);
    assert.ok(e < 0.001, `id ${id} still ${(e * 1000).toFixed(2)} mm off`);
    assert.ok(l.confidence > 0.3);
    assert.equal(l.nViews, 3 + 24); // measurements accumulated
  }
});

test("a weak base LED re-observed weakly is fused by inverse variance (between the two)", () => {
  const prior = weakPrior(8, 0.006);
  // The supplement saw LED 8 just as weakly, at its true position.
  const addLeds = range(0, 11).map((id) => led(id, pos(id), 0.95, 20));
  addLeds[8] = { ...led(8, pos(8), 0.3, 3), parallaxDeg: 3 };
  const { map } = fuseMaps(prior, transformMap(mapOf(addLeds), DISGUISE));
  const l8 = map.leds.find((x) => x.id === 8)!;
  // Comparable σ -> lands between the base estimate and truth, on neither.
  const e = Math.hypot(l8.xyz[0] - pos(8)[0], l8.xyz[1] - pos(8)[1]);
  const before = Math.hypot(0.006, 0.006);
  assert.ok(e > 0.0005 && e < before - 0.0005, `error ${e} vs ${before}`);
});

test("joint re-solve: weak base LEDs take the joint solution, anchors stay", () => {
  const prior = weakPrior(8, 0.01);
  const supp = transformMap(mapOf(range(4, 15).map((id) => led(id, pos(id), 0.9))), DISGUISE);
  // The joint solve (base + supplemental rays) has every LED, in its own gauge.
  const joint = transformMap(mapOf(range(0, 15).map((id) => led(id, pos(id), 0.97, 30))), {
    c: 0.8,
    R: [1, 0, 0, 0, 0, -1, 0, 1, 0],
    d: [0, 1, 2],
  });
  const { map, report, provenance } = fuseMaps(prior, supp, { joint });
  assert.equal(report.method, "joint", report.jointRejected ?? "");
  assert.equal(report.jointRejected, null);
  assert.equal(report.resolved, 4);
  assert.equal(report.added, 4);
  for (const id of range(0, 7)) assert.deepEqual(map.leds.find((x) => x.id === id)!.xyz, pos(id));
  for (const id of range(8, 11)) {
    const l = map.leds.find((x) => x.id === id)!;
    assert.equal(provenance.get(id), "updated");
    assert.ok(Math.hypot(l.xyz[0] - pos(id)[0], l.xyz[1] - pos(id)[1], l.xyz[2] - pos(id)[2]) < 1e-3);
    assert.equal(l.nViews, 30); // joint statistics, not double-counted
  }
  for (const id of range(12, 15)) assert.equal(provenance.get(id), "scan");
});

test("a joint solve that dropped a session (old dominant-arc solver) is rejected", () => {
  const prior = weakPrior(8, 0.01);
  const supp = transformMap(mapOf(range(4, 15).map((id) => led(id, pos(id), 0.9))), DISGUISE);
  // The old segment filter kept only the supplemental arc: base-only LEDs 0..3
  // are missing from the "joint" result.
  const dropped = transformMap(mapOf(range(4, 15).map((id) => led(id, pos(id), 0.97))), DISGUISE);
  const { report } = fuseMaps(prior, supp, { joint: dropped });
  assert.equal(report.method, "registered");
  assert.match(report.jointRejected ?? "", /lost 4 of the base map's 12 LEDs/);
  assert.ok(report.registered); // fell back to estimate fusion
  assert.equal(report.resolved, 4);
});

test("joint re-solve works without a usable standalone supplemental solve", () => {
  const prior = weakPrior(8, 0.01);
  const joint = transformMap(mapOf(range(0, 11).map((id) => led(id, pos(id), 0.97, 30))), DISGUISE);
  const { report, map } = fuseMaps(prior, null, { joint });
  assert.equal(report.method, "joint");
  assert.equal(report.resolved, 4);
  const l9 = map.leds.find((x) => x.id === 9)!;
  assert.ok(Math.hypot(l9.xyz[0] - pos(9)[0], l9.xyz[1] - pos(9)[1]) < 1e-3);
  // Neither source -> the prior, untouched.
  const none = fuseMaps(prior, null);
  assert.equal(none.report.registered, false);
  assert.equal(none.map, prior);
});

test("a joint solve that silently kept only the base arc is caught by the evidence check", () => {
  // The supplement only revisited the weak LEDs 8..11 (a subset of the base),
  // so coverage can't tell; but the "joint" result is the base solve again —
  // the weak LEDs gained no views.
  const prior = weakPrior(8, 0.01);
  const baseAgain = transformMap(
    mapOf(prior.leds.map((l) => ({ ...l }))),
    DISGUISE,
  );
  const { report } = fuseMaps(prior, null, { joint: baseAgain, observedIds: new Set([8, 9, 10, 11]) });
  assert.equal(report.method, "registered");
  assert.match(report.jointRejected ?? "", /gained no new views on 4 of the 4/);
});

test("spreadRatio: 0 for a line, high for a 2D patch", () => {
  const line: Vec3[] = [0, 1, 2, 3].map((i) => [0.3, i * 0.1, 0]);
  assert.ok(spreadRatio(line) < 1e-6);
  const patch: Vec3[] = range(0, 11).map(pos);
  assert.ok(spreadRatio(patch) > 0.5);
});

test("collinear anchors don't register alone — every common LED is used", () => {
  // A flat 4×4 wall; only column 2 is well-solved in the base (a vertical line
  // of anchors), the rest is weak and off by ~3 mm.
  const flat = (id: number): Vec3 => [(id % 4) * 0.1, Math.floor(id / 4) * 0.1, 0];
  const prior = mapOf(
    range(0, 15).map((id) =>
      id % 4 === 2
        ? led(id, flat(id), 0.95, 20)
        : { ...led(id, [flat(id)[0] + 0.002, flat(id)[1] - 0.002, 0.001], 0.3, 3), parallaxDeg: 3 },
    ),
  );
  // The supplement saw columns 1..3 well.
  const addition = transformMap(
    mapOf(range(0, 15).filter((id) => id % 4 !== 0).map((id) => ({ ...led(id, flat(id), 0.95, 24), parallaxDeg: 35 }))),
    DISGUISE,
  );
  const { map, report } = fuseMaps(prior, addition);
  assert.ok(report.registered, report.summary);
  assert.equal(report.anchors, 12, "fell back to all common LEDs");
  // Column 3 (off the anchor line) lands within a few mm — an unconstrained
  // rotation about the anchor line would put it centimetres off.
  for (const id of [3, 7, 11, 15]) {
    const l = map.leds.find((x) => x.id === id)!;
    const e = Math.hypot(l.xyz[0] - flat(id)[0], l.xyz[1] - flat(id)[1], l.xyz[2] - flat(id)[2]);
    assert.ok(e < 0.004, `id ${id} ${(e * 1000).toFixed(1)} mm off`);
  }
});

test("concatObservations puts the supplement after the base on one timeline", () => {
  const det = (t: number, ledId = 0) => ({
    ledId,
    tCaptureMs: t,
    u: 1,
    v: 2,
    imgW: 10,
    imgH: 10,
    K: [1, 1, 1, 1] as [number, number, number, number],
    pose: null,
    confidence: 1,
  });
  const imu = (t: number) => ({ t, gyro: [0, 0, 0] as Vec3, accel: [0, 9.8, 0] as Vec3 });
  const base = { detections: [det(1000), det(9000)], imu: [imu(900), imu(9100)], ledCount: 32 };
  // The supplement's clock restarted (app reload): it overlaps the base's.
  const add = { detections: [det(500, 1), det(2500, 1)], imu: [imu(400), imu(2600)] };
  const out = concatObservations(base, add);
  assert.equal(out.ledCount, 32);
  assert.equal(out.detections.length, 4);
  // Shifted so the supplement's first sample (imu @400) is 5 s after the
  // base's last (imu @9100); its internal timing is preserved.
  assert.deepEqual(
    out.detections.slice(2).map((d) => d.tCaptureMs),
    [9100 + 5000 + 100, 9100 + 5000 + 2100],
  );
  assert.deepEqual(
    out.imu.slice(2).map((s) => s.t),
    [14100, 16300],
  );
  // Inputs untouched.
  assert.equal(add.detections[0]!.tCaptureMs, 500);
});
