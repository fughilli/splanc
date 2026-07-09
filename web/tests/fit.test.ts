/** Similarity fit: recover a known scale/rotation/translation; planar sets. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Vec3 } from "@ledmapper/protocol";
import { applySimilarity, fitSimilarity } from "../src/geom/fit";
import { quatToRotMat } from "../src/geom/pinhole";

function transform(points: Vec3[], c: number, q: [number, number, number, number], d: Vec3): Vec3[] {
  const r = quatToRotMat(q);
  return points.map((p) => [
    c * (r[0] * p[0] + r[1] * p[1] + r[2] * p[2]) + d[0],
    c * (r[3] * p[0] + r[4] * p[1] + r[5] * p[2]) + d[1],
    c * (r[6] * p[0] + r[7] * p[1] + r[8] * p[2]) + d[2],
  ]);
}

const norm = (v: number[]): [number, number, number, number] => {
  const l = Math.hypot(...v);
  return [v[0]! / l, v[1]! / l, v[2]! / l, v[3]! / l];
};

test("recovers a known similarity exactly (3D cloud)", () => {
  const src: Vec3[] = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.4, -0.7, 0.2], [-0.3, 0.5, -0.8],
  ];
  const q = norm([0.2, -0.4, 0.1, 0.88]);
  const dst = transform(src, 0.043, q, [1.2, -0.4, 2.5]);
  const fit = fitSimilarity(src, dst);
  assert.ok(fit !== null);
  assert.ok(Math.abs(fit.c - 0.043) < 1e-9, `scale ${fit.c}`);
  for (let i = 0; i < src.length; i++) {
    const p = applySimilarity(fit, src[i]!);
    const err = Math.hypot(p[0] - dst[i]![0], p[1] - dst[i]![1], p[2] - dst[i]![2]);
    assert.ok(err < 1e-9, `point ${i}: ${err}`);
  }
});

test("planar grid (the wall's ground-truth shape) aligns", () => {
  // Pitch-normalized wall layout: z = 0, row-major grid — the actual use case.
  const src: Vec3[] = [];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) src.push([c, r, 0]);
  const q = norm([0.05, 0.7, -0.1, 0.7]);
  const dst = transform(src, 0.021, q, [-0.5, 1.2, -0.3]);
  const fit = fitSimilarity(src, dst)!;
  for (let i = 0; i < src.length; i++) {
    const p = applySimilarity(fit, src[i]!);
    const err = Math.hypot(p[0] - dst[i]![0], p[1] - dst[i]![1], p[2] - dst[i]![2]);
    assert.ok(err < 1e-9, `point ${i}: ${err}`);
  }
});

test("tolerates noise: residuals stay near the injected noise level", () => {
  const src: Vec3[] = [];
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) src.push([c, r, 0]);
  const q = norm([-0.3, 0.2, 0.5, 0.79]);
  const clean = transform(src, 0.05, q, [0.3, 1.0, -0.8]);
  let s = 41;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 0.004;
  const noisy = clean.map((p): Vec3 => [p[0] + rand(), p[1] + rand(), p[2] + rand()]);
  const fit = fitSimilarity(src, noisy)!;
  for (let i = 0; i < src.length; i++) {
    const p = applySimilarity(fit, src[i]!);
    const err = Math.hypot(p[0] - noisy[i]![0], p[1] - noisy[i]![1], p[2] - noisy[i]![2]);
    assert.ok(err < 0.01, `point ${i}: ${err}`);
  }
});

test("rejects degenerate input", () => {
  assert.equal(fitSimilarity([[0, 0, 0], [1, 1, 1]], [[0, 0, 0], [2, 2, 2]]), null);
  const same: Vec3[] = [[1, 1, 1], [1, 1, 1], [1, 1, 1], [1, 1, 1]];
  assert.equal(fitSimilarity(same, same), null);
});
