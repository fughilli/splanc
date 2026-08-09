/**
 * previewVideo (src/fx/previewVideo.ts) — the pure grid + pixel helpers behind
 * the 64×64 effect preview tiles. The compile/encode path is browser-only; here
 * we pin the grid geometry (which becomes led.uv) and the RGB→RGBA expansion.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildGridPositions, rgbToRgba } from "../src/fx/previewGrid";

test("buildGridPositions lays a flat XY unit grid, row-major, z=0", () => {
  const size = 4;
  const p = buildGridPositions(size);
  assert.equal(p.length, size * size * 3);

  // Top-left pixel → (0,0), bottom-right → (1,1); z is always 0.
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * size + x) * 3;
    return [p[i]!, p[i + 1]!, p[i + 2]!];
  };
  assert.deepEqual(at(0, 0), [0, 0, 0]);
  assert.deepEqual(at(size - 1, 0), [1, 0, 0]);
  assert.deepEqual(at(0, size - 1), [0, 1, 0]);
  assert.deepEqual(at(size - 1, size - 1), [1, 1, 0]);
  for (let i = 2; i < p.length; i += 3) assert.equal(p[i], 0, "z=0");
});

test("buildGridPositions handles the degenerate 1×1 grid without dividing by zero", () => {
  const p = buildGridPositions(1);
  assert.deepEqual([...p], [0, 0, 0]);
});

test("rgbToRgba expands to opaque RGBA in place", () => {
  const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]);
  const out = new Uint8Array(8);
  rgbToRgba(rgb, out);
  assert.deepEqual([...out], [10, 20, 30, 255, 40, 50, 60, 255]);
});
