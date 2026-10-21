/** Degenerate-solve detection + the final-vs-preview decision (solver/degeneracy). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import {
  assessMap,
  better,
  compareToPreview,
  decideFinal,
  geometry,
  observableLeds,
  verdict,
} from "../src/solver/degeneracy";

/** A 60-LED coil (7 cm radius, 16 cm tall) like the solver's synthetic tests. */
function coil(scale = 1): Vec3[] {
  return Array.from({ length: 60 }, (_, i) => {
    const f = i / 59;
    const th = f * 2.5 * 2 * Math.PI;
    return [0.07 * scale * Math.cos(th), scale * (-0.08 + 0.16 * f), 0.07 * scale * Math.sin(th)] as Vec3;
  });
}

function mapOf(pts: Vec3[], opts: { rms?: number; cam?: number; nViews?: number; se?: number } = {}): OutputMap {
  const leds: LedEntry[] = pts.map((xyz, id) => ({
    id,
    xyz,
    confidence: 0.9,
    nViews: opts.nViews ?? 8,
    rmsReprojPx: 1,
    parallaxDeg: 20,
  }));
  const cam = opts.cam ?? 0.75;
  return {
    mapId: "m",
    createdAt: "",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: 60,
    leds,
    unmapped: [],
    trajectory: [
      [cam, 0, 0],
      [0, 0, cam],
      [-cam, 0, 0],
    ],
    stats: { rmsReprojPxGlobal: opts.rms ?? 1, medianParallaxDeg: 20, ...(opts.se !== undefined ? { scaleRelStdErr: opts.se } : {}) },
  };
}

test("a healthy map is not degenerate", () => {
  const a = assessMap(mapOf(coil()), 60);
  assert.equal(a.degenerate, false, a.reasons.join());
  assert.equal(a.measured, 60);
  assert.ok(Math.abs((a.medianCameraDistM ?? 0) - 0.75) < 0.01);
});

test("each degeneracy is named (mirrors solver/src/diag.rs)", () => {
  const geo = geometry(coil(), [[0.75, 0, 0]]);
  const r = (m: number, o: number, rms: number, fin: boolean, g = geo) => verdict(m, o, rms, fin, null, g).reasons;
  assert.deepEqual(r(60, 60, 1, false), ["non-finite"]);
  assert.deepEqual(r(3, 60, 1, true), ["too-few-leds"]);
  assert.deepEqual(r(10, 60, 1, true), ["too-few-leds"]);
  assert.deepEqual(r(15, 60, 1, true), []);
  assert.deepEqual(r(60, 60, 50, true), ["huge-residual"]);
  assert.deepEqual(r(60, 60, 1, true, geometry(coil(0.1), [[0.09, 0, 0]])), ["scale-collapse"]);
  assert.deepEqual(r(60, 60, 1, true, geometry(coil(100), [[40, 0, 0]])), ["scale-blowup"]);
  const unc = verdict(60, 60, 1, true, 0.8, geo);
  assert.equal(unc.degenerate, false);
  assert.deepEqual(unc.warnings, ["scale-uncertain"]);
});

test("a NaN anywhere is non-finite; behind-camera residual is huge-residual", () => {
  const pts = coil();
  pts[3] = [Number.NaN, 0, 0];
  assert.ok(assessMap(mapOf(pts)).reasons.includes("non-finite"));
  assert.deepEqual(assessMap(mapOf(coil(), { rms: 50 })).reasons, ["huge-residual"]);
});

test("strip-prior placements (nViews 0) don't count as measured", () => {
  const m = mapOf(coil());
  m.leds = m.leds.map((l, i) => (i >= 4 ? { ...l, nViews: 0 } : l));
  assert.equal(assessMap(m, 60).measured, 4);
  assert.ok(assessMap(m, 60).reasons.includes("too-few-leds"));
});

test("observable LEDs need two distinct frames", () => {
  const d = [
    { ledId: 1, tCaptureMs: 0 },
    { ledId: 1, tCaptureMs: 0 },
    { ledId: 2, tCaptureMs: 0 },
    { ledId: 2, tCaptureMs: 33 },
  ];
  assert.equal(observableLeds(d), 1);
});

test("better(): non-degenerate, then coverage, then residual", () => {
  const g = geometry(coil(), [[0.75, 0, 0]]);
  const ok = verdict(50, 60, 2, true, null, g);
  const more = verdict(55, 60, 3, true, null, g);
  const bad = verdict(60, 60, 50, true, null, g);
  assert.ok(better(ok, bad) && !better(bad, ok));
  assert.ok(better(more, ok));
  assert.ok(better(verdict(50, 60, 1, true, null, g), ok));
});

test("compareToPreview flags collapse and disagreement", () => {
  const preview = mapOf(coil());
  const pa = assessMap(preview, 60);
  // A final whose LEDs all collapsed onto a line.
  const line = mapOf(coil().map(([x]) => [x, 0, 0] as Vec3));
  const c1 = compareToPreview(line, assessMap(line, 60), preview, pa);
  assert.ok(c1.regressions.includes("collapsed-to-line"), c1.regressions.join());
  // Same shape at half the size: only a size disagreement (not a fallback).
  const half = mapOf(coil(0.4));
  const c2 = compareToPreview(half, assessMap(half, 60), preview, pa);
  assert.deepEqual(c2.regressions, ["size-differs-from-preview"]);
  assert.ok(c2.shapeRms !== null && c2.shapeRms < 1e-6);
  // Scrambled LED ids: shape disagreement.
  const pts = coil();
  const scrambled = mapOf(pts.map((_, i) => pts[(i * 7) % 60]!));
  const c3 = compareToPreview(scrambled, assessMap(scrambled, 60), preview, pa);
  assert.ok(c3.regressions.includes("shape-differs-from-preview"), c3.regressions.join());
});

test("decideFinal keeps the final unless it is broken where the preview was not", () => {
  const good = mapOf(coil());
  const ga = assessMap(good, 60);
  const preview = { map: mapOf(coil()), assessment: ga };

  const ok = decideFinal({ map: good, assessment: ga, error: null }, preview);
  assert.equal(ok.use, "final");
  assert.equal(ok.outcome, "ok");

  // The reported failure: the preview rendered the fixture, the final is
  // empty / behind the cameras.
  const empty = mapOf([], { rms: 50 });
  const fb = decideFinal({ map: empty, assessment: assessMap(empty, 60), error: null }, preview);
  assert.equal(fb.use, "preview");
  assert.equal(fb.outcome, "fallback-degenerate");
  assert.ok(fb.reasons.includes("final:huge-residual") && fb.reasons.includes("degenerate"), fb.reasons.join());

  const thrown = decideFinal({ map: null, assessment: null, error: "too few IMU samples" }, preview);
  assert.equal(thrown.use, "preview");
  assert.equal(thrown.outcome, "fallback-failed");

  assert.equal(decideFinal({ map: null, assessment: null, error: "x" }, null).outcome, "failed");
  assert.equal(decideFinal({ map: empty, assessment: assessMap(empty, 60), error: null }, null).outcome, "degenerate");

  // A degenerate preview is no fallback.
  const badPreview = { map: empty, assessment: assessMap(empty, 60) };
  const nf = decideFinal({ map: empty, assessment: assessMap(empty, 60), error: null }, badPreview);
  assert.equal(nf.outcome, "degenerate");

  // Fewer than 60 % of the preview's LEDs: regression → fallback.
  const few = mapOf(coil().slice(0, 30));
  const fw = decideFinal({ map: few, assessment: assessMap(few, 60), error: null }, preview);
  assert.equal(fw.use, "preview");
  assert.ok(fw.reasons.includes("fewer-leds-than-preview"));

  // Size disagreement alone: keep the final, but flag the run.
  const big = mapOf(coil(3), { cam: 2.25 });
  const fl = decideFinal({ map: big, assessment: assessMap(big, 60), error: null }, preview);
  assert.equal(fl.use, "final");
  assert.equal(fl.outcome, "flagged");
});
