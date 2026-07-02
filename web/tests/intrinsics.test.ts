/** projectionMatrixToIntrinsics against known matrices (design doc §5, M5 acceptance). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Intrinsics } from "@ledmapper/protocol";
import { intrinsicsToProjectionMatrix, projectionMatrixToIntrinsics } from "../src/xr/intrinsics";

function assertClose(a: readonly number[], b: readonly number[], tol = 1e-9) {
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Math.abs(a[i]! - b[i]!) < tol, `[${i}] ${a[i]} vs ${b[i]}`);
  }
}

test("symmetric frustum: principal point at image center", () => {
  // Hand-built symmetric perspective matrix: fov such that 2n/(r-l) = 1.5.
  const m = new Float32Array(16);
  m[0] = 1.5;
  m[5] = 2.0;
  m[10] = -1.001;
  m[11] = -1;
  m[14] = -0.2;
  const k = projectionMatrixToIntrinsics(m, 1920, 1080);
  assertClose(k, [1.5 * 960, 2.0 * 540, 960, 540]);
});

test("round-trips arbitrary (asymmetric) intrinsics", () => {
  const cases: Array<{ k: Intrinsics; w: number; h: number }> = [
    { k: [1450.2, 1451.0, 959.5, 539.7], w: 1920, h: 1080 }, // §7.4 example
    { k: [800, 820, 660, 350], w: 1280, h: 720 }, // off-center principal point
    { k: [500, 500, 320, 240], w: 640, h: 480 },
  ];
  for (const { k, w, h } of cases) {
    const m = intrinsicsToProjectionMatrix(k, w, h);
    assertClose(Array.from(projectionMatrixToIntrinsics(m, w, h)), k, 1e-3);
  }
});

test("rejects garbage", () => {
  assert.throws(() => projectionMatrixToIntrinsics(new Float32Array(9), 100, 100));
  assert.throws(() => projectionMatrixToIntrinsics(new Float32Array(16), 100, 100)); // m0=0
  const m = intrinsicsToProjectionMatrix([100, 100, 50, 50], 100, 100);
  assert.throws(() => projectionMatrixToIntrinsics(m, 0, 100));
});
