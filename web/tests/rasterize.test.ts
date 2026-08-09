/**
 * rasterize (src/fx/rasterize.ts) — additive glow splatting for the virtual-tree
 * preview. Checks the kernel shape and that LEDs land at the right pixels, dark
 * LEDs contribute nothing, and overlaps saturate rather than wrap.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { makeGlowKernel, rasterizeLeds } from "../src/fx/rasterize";

test("makeGlowKernel is centered with a unit peak", () => {
  const k = makeGlowKernel(1.5);
  const center = k.taps.find((t) => t.dx === 0 && t.dy === 0);
  assert.ok(center);
  assert.equal(center!.w, 1);
  for (const t of k.taps) assert.ok(t.w <= 1 && t.w > 0);
});

test("a bright LED lights its pixel and leaves the corners dark", () => {
  const size = 8;
  const accum = new Float32Array(size * size * 3);
  const out = new Uint8Array(size * size * 4);
  // Single white LED at the center of the frame.
  rasterizeLeds(
    size,
    new Float32Array([0.5, 0.5]),
    new Uint8Array([255, 255, 255]),
    makeGlowKernel(1.2),
    accum,
    out,
  );
  const px = (x: number, y: number, c: number): number => out[(y * size + x) * 4 + c]!;
  assert.ok(px(4, 4, 0) > 0 && px(4, 4, 3) === 255, "center lit + opaque");
  assert.equal(px(0, 0, 0), 0, "corner dark");
});

test("dark LEDs contribute nothing; overlapping bright LEDs saturate", () => {
  const size = 4;
  const accum = new Float32Array(size * size * 3);
  const out = new Uint8Array(size * size * 4);

  // Two coincident bright-red LEDs → the shared pixel clamps to 255, not wrap.
  rasterizeLeds(
    size,
    new Float32Array([0.5, 0.5, 0.5, 0.5]),
    new Uint8Array([200, 0, 0, 200, 0, 0]),
    makeGlowKernel(1),
    accum,
    out,
  );
  let maxR = 0;
  for (let p = 0; p < size * size; p++) maxR = Math.max(maxR, out[p * 4]!);
  assert.equal(maxR, 255);

  // An all-black LED leaves the frame black.
  const accum2 = new Float32Array(size * size * 3);
  const out2 = new Uint8Array(size * size * 4);
  rasterizeLeds(size, new Float32Array([0.5, 0.5]), new Uint8Array([0, 0, 0]), makeGlowKernel(1), accum2, out2);
  for (let p = 0; p < size * size; p++) {
    assert.equal(out2[p * 4], 0);
    assert.equal(out2[p * 4 + 3], 255);
  }
});
