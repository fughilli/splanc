/** FUG-112 — the per-LED σ proxy and the variance tiers the overlay draws. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedEntry, Vec3 } from "@ledmapper/protocol";
import {
  DEFAULT_DEPTH_M,
  ledSigmaM,
  ledSpacingM,
  mapSigmaContext,
  varianceTier,
} from "../src/geom/ledVariance";

const CTX = { depthM: 2, focalPx: 1000 };
const stats = (nViews: number, rmsReprojPx: number, parallaxDeg: number) => ({ nViews, rmsReprojPx, parallaxDeg });

test("σ matches the first-order triangulation model", () => {
  // 2 m · 1 px / (1000 px · √4) = 1 mm lateral; / sin 30° = 2 mm.
  const s = ledSigmaM(stats(4, 1, 30), CTX);
  assert.ok(Math.abs(s - 0.002) < 1e-9, `σ ${s}`);
});

test("σ shrinks with more views, more parallax, less reprojection error", () => {
  const base = ledSigmaM(stats(4, 1, 10), CTX);
  assert.ok(ledSigmaM(stats(16, 1, 10), CTX) < base);
  assert.ok(ledSigmaM(stats(4, 1, 40), CTX) < base);
  assert.ok(ledSigmaM(stats(4, 3, 10), CTX) > base);
});

test("σ floors: rms≈0 is not exact, ~0° parallax is huge but finite", () => {
  assert.equal(ledSigmaM(stats(4, 0, 30), CTX), ledSigmaM(stats(4, 0.5, 30), CTX));
  const flat = ledSigmaM(stats(4, 1, 0), CTX);
  assert.ok(Number.isFinite(flat) && flat > 0.1, `σ ${flat}`);
  // Degenerate stats don't produce NaN.
  assert.ok(Number.isFinite(ledSigmaM(stats(0, NaN, NaN), CTX)));
});

test("mapSigmaContext takes the capture depth from the trajectory", () => {
  const leds: LedEntry[] = [
    { id: 0, xyz: [-0.1, 0, 0], confidence: 1, nViews: 4, rmsReprojPx: 1, parallaxDeg: 20 },
    { id: 1, xyz: [0.1, 0, 0], confidence: 1, nViews: 4, rmsReprojPx: 1, parallaxDeg: 20 },
  ];
  const trajectory: Vec3[] = [
    [0, 0, 2.5],
    [1.5, 0, 2],
    [-1.5, 0, 2],
  ];
  const ctx = mapSigmaContext({ leds, trajectory }, 900);
  assert.ok(Math.abs(ctx.depthM - 2.5) < 1e-9, `depth ${ctx.depthM}`);
  assert.equal(ctx.focalPx, 900);
  assert.equal(mapSigmaContext({ leds }).depthM, DEFAULT_DEPTH_M);
});

test("ledSpacingM is the median nearest-neighbour distance", () => {
  const pts: Vec3[] = [
    [0, 0, 0],
    [0.05, 0, 0],
    [0.1, 0, 0],
    [0.15, 0, 0],
  ];
  assert.ok(Math.abs(ledSpacingM(pts)! - 0.05) < 1e-12);
  assert.equal(ledSpacingM([[0, 0, 0]]), null);
});

test("variance tiers are relative to the LED pitch", () => {
  assert.equal(varianceTier(0.004, 0.05), "tight"); // < ¼ pitch
  assert.equal(varianceTier(0.02, 0.05), "moderate"); // < ¾ pitch
  assert.equal(varianceTier(0.05, 0.05), "loose");
  assert.equal(varianceTier(Infinity, 0.05), "loose");
  assert.equal(varianceTier(NaN, 0.05), "loose");
  // The same σ is loose on a dense strip and tight on a sparse wall.
  assert.equal(varianceTier(0.01, 0.016), "moderate");
  assert.equal(varianceTier(0.01, 0.2), "tight");
});
