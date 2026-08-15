/**
 * Tubiform point-cloud relaxation (topology/relax.ts) + its use by the topology
 * extractor: a TUBE (LEDs wrapped over a cylinder surface) contracts onto its
 * centreline and extracts as a single clean segment, WITHOUT retracting its
 * endpoints — while thin fixtures (a straight strip, a ring) are left untouched.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { relaxTubiform } from "../src/topology/relax";
import { extractTopology } from "../src/topology/extract";

function led(id: number, xyz: Vec3): LedEntry {
  return { id, xyz, confidence: 1, nViews: 3, rmsReprojPx: 0.5, parallaxDeg: 20 };
}
function map(pts: Vec3[]): OutputMap {
  return {
    mapId: "tube",
    createdAt: "2026-08-15T00:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: pts.length,
    leds: pts.map((p, i) => led(i, p)),
    unmapped: [],
    stats: { rmsReprojPxGlobal: 0.5, medianParallaxDeg: 20 },
  };
}

/** A tube of `rings` cross-sections (unit axial pitch) of `per` points each,
 * radius `R`, whose centreline follows `centre(x)` with a local frame. A plain
 * straight tube runs along +x; pass a `centre` to bend it. */
function tube(rings: number, per: number, R: number, centre?: (t: number) => Vec3): Vec3[] {
  const pts: Vec3[] = [];
  for (let r = 0; r < rings; r++) {
    const c = centre ? centre(r) : ([r, 0, 0] as Vec3);
    // Local tangent (finite difference) → an orthonormal cross-section frame.
    const cNext = centre ? centre(r + 0.01) : ([r + 0.01, 0, 0] as Vec3);
    let tx = cNext[0] - c[0];
    let ty = cNext[1] - c[1];
    let tz = cNext[2] - c[2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    // Any vector not parallel to the tangent, orthonormalised → u, v.
    const ref: Vec3 = Math.abs(tx) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    let ux = ref[1] * tz - ref[2] * ty;
    let uy = ref[2] * tx - ref[0] * tz;
    let uz = ref[0] * ty - ref[1] * tx;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;
    const vx = ty * uz - tz * uy;
    const vy = tz * ux - tx * uz;
    const vz = tx * uy - ty * ux;
    for (let a = 0; a < per; a++) {
      const th = (2 * Math.PI * a) / per + r * 0.3;
      const cos = R * Math.cos(th);
      const sin = R * Math.sin(th);
      pts.push([c[0] + cos * ux + sin * vx, c[1] + cos * uy + sin * vy, c[2] + cos * uz + sin * vz]);
    }
  }
  return pts;
}

/** Perpendicular distance of `p` from the x-axis (a straight tube's centreline). */
const radial = (p: Vec3): number => Math.hypot(p[1], p[2]);

test("relaxTubiform collapses a cylinder onto its axis, preserving its length", () => {
  const pts = tube(20, 9, 1.5); // straight tube along +x, radius 1.5, pitch 1
  const before = pts.reduce((m, p) => Math.max(m, radial(p)), 0);
  assert.ok(before > 1.4, "starts fat");
  const out = relaxTubiform(pts, { iterations: 18, radius: 3, rate: 0.6, spacing: 1 });
  // Cross-section collapses toward the centreline.
  const after = out.reduce((m, p) => Math.max(m, radial(p)), 0);
  assert.ok(after < 0.3, `cross-section contracts (max radius ${after.toFixed(3)} < 0.3)`);
  // Axial extent (length) is preserved — endpoints do NOT retract inward, the
  // property naïve mean-shift/Laplacian contraction violates.
  const xs = pts.map((p) => p[0]);
  const oxs = out.map((p) => p[0]);
  const span = Math.max(...xs) - Math.min(...xs);
  const ospan = Math.max(...oxs) - Math.min(...oxs);
  // Axial length is preserved to within ~1 pitch — the endpoints barely creep
  // in, unlike naïve mean-shift, which would retract each end by ~a full radius.
  assert.ok(ospan > span - 1.2, `length preserved (${ospan.toFixed(2)} vs ${span.toFixed(2)})`);
  assert.ok(Math.min(...oxs) < 0.8 && Math.max(...oxs) > span - 0.8, "both end rings stay near the ends");
});

test("relaxTubiform is a no-op on an already-thin cloud (a straight strip)", () => {
  const line: Vec3[] = Array.from({ length: 12 }, (_, i) => [i, 0, 0]);
  const out = relaxTubiform(line, { iterations: 10, radius: 3, rate: 0.5, spacing: 1 });
  for (let i = 0; i < line.length; i++) {
    assert.ok(Math.hypot(out[i]![0] - line[i]![0], out[i]![1] - line[i]![1], out[i]![2] - line[i]![2]) < 1e-9,
      "a collinear point does not move");
  }
});

test("relaxTubiform barely perturbs a thin ring (curved but 1-D)", () => {
  const N = 40;
  const R = 5;
  const ring: Vec3[] = Array.from({ length: N }, (_, i) => {
    const th = (2 * Math.PI * i) / N;
    return [R * Math.cos(th), R * Math.sin(th), 0];
  });
  const out = relaxTubiform(ring, { iterations: 8, radius: 2, rate: 0.5, spacing: 1 });
  const rr = out.reduce((m, p) => Math.max(m, Math.abs(Math.hypot(p[0], p[1]) - R)), 0);
  assert.ok(rr < 0.15 * R, `the ring keeps its radius (drift ${rr.toFixed(3)} < ${0.15 * R})`);
});

test("iterations:0 returns an unchanged copy (disabled)", () => {
  const pts = tube(6, 9, 1.5);
  const out = relaxTubiform(pts, { iterations: 0, radius: 3, rate: 0.5, spacing: 1 });
  assert.notEqual(out, pts, "a fresh array");
  assert.deepEqual(out, pts, "identical positions when disabled");
});

test("a straight tube extracts as one clean centreline segment with relax on", async () => {
  const pts = tube(20, 9, 1.5);
  const m = map(pts);

  // Without relaxation the surface mesh does NOT reduce to a single strand.
  const raw = await extractTopology(m);
  assert.ok(
    raw.segments.length > 1 || raw.branchPoints.length > 0,
    "the raw tube mis-extracts (surface mesh, not a centreline)",
  );

  // With relaxation it collapses to one segment, no junctions.
  const t = await extractTopology(m, { relaxIterations: 12 });
  assert.equal(t.branchPoints.length, 0, "no false junctions");
  assert.equal(t.segments.length, 1, "one centreline segment");
  assert.equal(t.associations.length, pts.length, "every LED associated");

  // Endpoint preservation: the recovered centreline spans ~the tube's length
  // (19 pitches), not a retracted stub.
  assert.ok(t.segments[0]!.length > 17, `centreline keeps its length (${t.segments[0]!.length.toFixed(1)} > 17)`);

  // Each LED's perpendicular distance ≈ the tube radius (measured from the LED's
  // ORIGINAL surface position, not the collapsed one).
  const meanPerp = t.associations.reduce((s, a) => s + a.dPerp, 0) / t.associations.length;
  assert.ok(meanPerp > 1.0 && meanPerp < 2.0, `dPerp reflects the true tube radius (~1.5, got ${meanPerp.toFixed(2)})`);
});

test("a BENT tube still extracts as a single centreline segment", async () => {
  // A quarter-circle centreline of radius 12, ~19 rings along the arc.
  const bendR = 12;
  const rings = 20;
  const centre = (t: number): Vec3 => {
    const ang = (Math.PI / 2) * (t / (rings - 1));
    return [bendR * Math.sin(ang), bendR * (1 - Math.cos(ang)), 0];
  };
  const pts = tube(rings, 9, 1.5, centre);
  const t = await extractTopology(map(pts), { relaxIterations: 14 });
  assert.equal(t.branchPoints.length, 0, "no false junctions on the bend");
  assert.equal(t.segments.length, 1, "one segment following the arc");
  assert.equal(t.associations.length, pts.length, "every LED associated");
});
