/** Connected components + sub-pixel centroids (M6 detect, CPU half). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectedComponents } from "../src/cv/ccl";

function buffer(w: number, h: number, points: Array<[number, number, number]>): Uint8Array {
  const data = new Uint8Array(w * h);
  for (const [x, y, v] of points) data[y * w + x] = v;
  return data;
}

test("finds separate components with correct areas", () => {
  const data = buffer(10, 6, [
    [1, 1, 200],
    [2, 1, 200],
    [1, 2, 200], // L-triomino blob
    [7, 4, 255], // single pixel
  ]);
  const blobs = connectedComponents(data, 10, 6);
  assert.equal(blobs.length, 2);
  const areas = blobs.map((b) => b.area).sort();
  assert.deepEqual(areas, [1, 3]);
});

test("centroid is intensity-weighted with (x+0.5, y+0.5) pixel centers", () => {
  // Two pixels: (2,3) weight 100 and (3,3) weight 200 -> x̄ = 2.5/3 + 3.5*2/3.
  const data = buffer(6, 6, [
    [2, 3, 100],
    [3, 3, 200],
  ]);
  const [b] = connectedComponents(data, 6, 6);
  assert.ok(b);
  assert.ok(Math.abs(b.x - (2.5 * (1 / 3) + 3.5 * (2 / 3))) < 1e-9, `x̄=${b.x}`);
  assert.ok(Math.abs(b.y - 3.5) < 1e-9);
});

test("diagonal pixels are separate components (4-connectivity)", () => {
  const data = buffer(4, 4, [
    [1, 1, 255],
    [2, 2, 255],
  ]);
  assert.equal(connectedComponents(data, 4, 4).length, 2);
});

test("minArea / maxArea filtering", () => {
  const data = buffer(8, 8, [
    [0, 0, 255], // area 1
    [4, 4, 255],
    [5, 4, 255],
    [4, 5, 255],
    [5, 5, 255], // area 4
  ]);
  const blobs = connectedComponents(data, 8, 8, 1, 0, { minArea: 2, maxArea: 10 });
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0]!.area, 4);
});

test("stride/offset scans RGBA readbacks without a copy", () => {
  // 3x1 RGBA image, middle pixel bright in the R channel.
  const rgba = new Uint8Array([0, 9, 9, 9, 200, 9, 9, 9, 0, 9, 9, 9]);
  const blobs = connectedComponents(rgba, 3, 1, 4, 0);
  assert.equal(blobs.length, 1);
  assert.ok(Math.abs(blobs[0]!.x - 1.5) < 1e-9);
});

test("bounding boxes: a horizontal band reports its elongation", () => {
  // 8x4 buffer: a 6x1 band on row 0 and a 2x2 square at bottom-right
  // (row 1 left empty so 4-connectivity keeps them separate).
  const data = new Uint8Array(8 * 4);
  for (let x = 1; x <= 6; x++) data[0 * 8 + x] = 200;
  data[2 * 8 + 6] = 200;
  data[2 * 8 + 7] = 200;
  data[3 * 8 + 6] = 200;
  data[3 * 8 + 7] = 200;
  const blobs = connectedComponents(data, 8, 4);
  const band = blobs.find((b) => b.area === 6)!;
  const square = blobs.find((b) => b.area === 4)!;
  assert.deepEqual([band.w, band.h], [6, 1]);
  assert.deepEqual([square.w, square.h], [2, 2]);
});

test("colorBase: per-blob mean color from RGBA buffers (weight in alpha)", () => {
  // 4x2 RGBA: a red 2px blob (left) and a cyan 2px blob (right).
  const data = new Uint8Array(4 * 2 * 4);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const i = (y * 4 + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  };
  put(0, 0, 255, 0, 0, 200);
  put(0, 1, 255, 0, 0, 200);
  put(3, 0, 0, 255, 255, 200);
  put(3, 1, 0, 255, 255, 200);
  const blobs = connectedComponents(data, 4, 2, 4, 3, { colorBase: 0 });
  assert.equal(blobs.length, 2);
  const red = blobs.find((b) => b.x < 2)!;
  const cyan = blobs.find((b) => b.x > 2)!;
  assert.ok(red.r! > 0.99 && red.g! < 0.01 && red.b! < 0.01);
  assert.ok(cyan.r! < 0.01 && cyan.g! > 0.99 && cyan.b! > 0.99);
});

test("stats: blooming diagnostics separate the white core from the halo hue", () => {
  // A 4x4 RGBA blob simulating a bloomed blue LED: a 2x2 saturated white
  // core (chroma 0) ringed by blue halo pixels (weight in alpha).
  const data = new Uint8Array(4 * 4 * 4);
  const put = (x: number, y: number, r: number, g: number, b: number, a: number) => {
    const i = (y * 4 + x) * 4;
    data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
  };
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const core = x >= 1 && x <= 2 && y >= 1 && y <= 2;
      if (core) put(x, y, 255, 255, 255, 255); // clipped white core
      else put(x, y, 20, 40, 220, 180); // blue halo
    }
  }
  const [blob] = connectedComponents(data, 4, 4, 4, 3, { colorBase: 0, stats: true });
  // Plain mean is dragged toward white/gray by the core...
  assert.ok(blob!.r! > 0.25 && blob!.g! > 0.3, "mean color washed toward gray");
  // ...peak clipped, a chunk saturated...
  assert.ok(blob!.peak! >= 0.99);
  assert.ok(blob!.satFrac! > 0.2 && blob!.satFrac! < 0.5);
  // ...but the CHROMA-WEIGHTED color recovers the blue halo (b dominant,
  // r small), which is the hue the decoder needs.
  assert.ok(blob!.cb! > blob!.cr! && blob!.cb! > blob!.cg!, "halo reads blue");
  assert.ok(blob!.cr! < 0.2, "chroma-weighting suppresses the white core");
});

test("stats: an all-gray blob has zero chroma and safe defaults", () => {
  const data = new Uint8Array(2 * 2 * 4);
  for (let i = 0; i < 4; i++) {
    data[i * 4] = 200; data[i * 4 + 1] = 200; data[i * 4 + 2] = 200; data[i * 4 + 3] = 200;
  }
  const [blob] = connectedComponents(data, 2, 2, 4, 3, { colorBase: 0, stats: true });
  assert.equal(blob!.cr, 0);
  assert.equal(blob!.cg, 0);
  assert.equal(blob!.cb, 0);
  assert.equal(blob!.satFrac, 0);
});
