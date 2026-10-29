/**
 * The curtain + rope layout generator (halloween/layout.ts): strip index → grid
 * cell for every origin / run direction / wiring, the channel split, counts, and
 * the coordinate conventions effects rely on (z band, uv = curtain grid).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  channelCounts,
  curtainCell,
  generateCurtainRopeMap,
  layoutPositions,
  ROPE_Z_THRESHOLD,
  suggestGrid,
  type CurtainRopeSpec,
  type CurtainSpec,
} from "../src/halloween/layout";

const base: CurtainSpec = {
  cols: 4,
  rows: 3,
  origin: "top-left",
  runs: "columns",
  wiring: "serpentine",
  colSpacing: 0.1,
  rowSpacing: 0.2,
};

const cells = (c: CurtainSpec): string[] =>
  Array.from({ length: c.cols * c.rows }, (_, i) => {
    const { col, row } = curtainCell(c, i);
    return `${col},${row}`;
  });

test("vertical serpentine from the top left zig-zags down then up", () => {
  assert.deepEqual(cells(base), [
    "0,0", "0,1", "0,2", // down column 0
    "1,2", "1,1", "1,0", // up column 1
    "2,0", "2,1", "2,2",
    "3,2", "3,1", "3,0",
  ]);
});

test("vertical linear (column-major) restarts every strand at the top", () => {
  assert.deepEqual(cells({ ...base, wiring: "linear" }).slice(0, 6), [
    "0,0", "0,1", "0,2", "1,0", "1,1", "1,2",
  ]);
});

test("horizontal row-major from the top left reads like text", () => {
  assert.deepEqual(cells({ ...base, runs: "rows", wiring: "linear" }).slice(0, 6), [
    "0,0", "1,0", "2,0", "3,0", "0,1", "1,1",
  ]);
});

test("horizontal serpentine from the bottom right starts bottom right, goes left, then back", () => {
  const c = { ...base, runs: "rows" as const, origin: "bottom-right" as const };
  assert.deepEqual(cells(c).slice(0, 8), [
    "3,2", "2,2", "1,2", "0,2", // bottom row, right to left
    "0,1", "1,1", "2,1", "3,1", // next row up, left to right
  ]);
});

test("every origin/run/wiring visits each cell exactly once", () => {
  for (const origin of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
    for (const runs of ["columns", "rows"] as const) {
      for (const wiring of ["serpentine", "linear"] as const) {
        const c = { ...base, origin, runs, wiring };
        const seen = new Set(cells(c));
        assert.equal(seen.size, c.cols * c.rows, `${origin}/${runs}/${wiring}`);
        // LED 0 sits in the named corner.
        const first = curtainCell(c, 0);
        assert.equal(first.col, origin.endsWith("left") ? 0 : c.cols - 1);
        assert.equal(first.row, origin.startsWith("top") ? 0 : c.rows - 1);
      }
    }
  }
});

test("serpentine neighbours in index order are physically adjacent", () => {
  for (const runs of ["columns", "rows"] as const) {
    const c = { ...base, cols: 7, rows: 5, runs };
    for (let i = 1; i < c.cols * c.rows; i++) {
      const a = curtainCell(c, i - 1);
      const b = curtainCell(c, i);
      assert.equal(Math.abs(a.col - b.col) + Math.abs(a.row - b.row), 1, `${runs} ${i}`);
    }
  }
});

const spec: CurtainRopeSpec = { curtain: base, rope: { count: 5, shape: "arc" } };

test("channel split: CH0 = the curtain's W×H, CH1 = the rope, ids contiguous", () => {
  assert.deepEqual(channelCounts(spec), { ch0: 12, ch1: 5 });
  const map = generateCurtainRopeMap(spec, new Date(0));
  assert.equal(map.ledCount, 17);
  assert.equal(map.leds.length, 17);
  assert.deepEqual(map.unmapped, []);
  map.leds.forEach((l, i) => assert.equal(l.id, i));
  assert.ok(map.mapId.length <= 64, "fits the firmware's map_id string");
});

test("z band tells curtain (z = 0) from rope (z > threshold)", () => {
  const pts = layoutPositions(spec);
  pts.slice(0, 12).forEach((p) => assert.equal(p[2], 0));
  pts.slice(12).forEach((p) => assert.ok(p[2] > ROPE_Z_THRESHOLD));
});

test("curtain positions follow the grid: y up, row 0 on top, metres", () => {
  const pts = layoutPositions(spec);
  assert.deepEqual(pts[0], [0, 0.4, 0]); // top-left (row 0 → highest y)
  assert.deepEqual(pts[2], [0, 0, 0]); // bottom of column 0
  const p3 = pts[3]!;
  assert.ok(Math.abs(p3[0] - 0.1) < 1e-9 && p3[1] === 0); // bottom of column 1 (serpentine)
});

test("the rope stays inside the curtain's x/y box so led.uv is the curtain grid", () => {
  for (const shape of ["line", "arc"] as const) {
    const pts = layoutPositions({ ...spec, rope: { count: 9, shape } });
    const curtain = pts.slice(0, 12);
    const rope = pts.slice(12);
    const maxX = Math.max(...curtain.map((p) => p[0]));
    for (const p of rope) {
      assert.ok(p[0] >= 0 && p[0] <= maxX + 1e-9);
      assert.equal(p[1], 0);
    }
    // Rope runs left to right in index order.
    for (let i = 1; i < rope.length; i++) assert.ok(rope[i]![0] > rope[i - 1]![0]);
  }
});

test("no rope → only the curtain; degenerate inputs are clamped", () => {
  const m = generateCurtainRopeMap({ curtain: base, rope: { count: 0, shape: "line" } });
  assert.equal(m.ledCount, 12);
  const one = generateCurtainRopeMap({ curtain: { ...base, cols: 1, rows: 1 }, rope: { count: 3, shape: "line" } });
  assert.equal(one.ledCount, 4);
  for (const l of one.leds) for (const v of l.xyz) assert.ok(Number.isFinite(v));
});

test("suggestGrid picks a wide factor pair", () => {
  assert.deepEqual(suggestGrid(300), { cols: 20, rows: 15 });
  assert.deepEqual(suggestGrid(400), { cols: 20, rows: 20 });
  assert.deepEqual(suggestGrid(7), { cols: 7, rows: 1 });
  assert.equal(suggestGrid(0), null);
});
