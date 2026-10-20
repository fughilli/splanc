/** Map export: TouchDesigner CSV + Chromatik .lxf serializers (geom/mapExport). */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedEntry, OutputMap, Topology, Vec3 } from "@ledmapper/protocol";
import {
  CSV_COLUMNS,
  LXF_DEFAULT_SCALE,
  channelLayoutFor,
  exportFileName,
  exportRows,
  idRanges,
  mapToCsv,
  mapToLxf,
} from "../src/geom/mapExport";

function led(id: number, xyz: Vec3, confidence = 0.9): LedEntry {
  return { id, xyz, confidence, nViews: 4, rmsReprojPx: 1, parallaxDeg: 10 };
}

function mapOf(leds: LedEntry[], ledCount: number, unmapped: number[] = []): OutputMap {
  return {
    mapId: "m1",
    createdAt: "2026-10-20T00:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount,
    leds,
    unmapped,
    stats: { rmsReprojPxGlobal: 1, medianParallaxDeg: 10 },
  };
}

function parseCsv(csv: string): { header: string[]; rows: string[][] } {
  const [h, ...rest] = csv.split("\n");
  return { header: h!.split(","), rows: rest.map((l) => l.split(",")) };
}

test("CSV: TouchDesigner Points DAT header, one row per LED in output order", () => {
  const map = mapOf([led(1, [0.1, 0.2, 0.3]), led(0, [0, 0, 0], 0.5), led(2, [1.23456789, -2, 0])], 3);
  const csv = mapToCsv(map);
  const { header, rows } = parseCsv(csv);
  assert.deepEqual(header, [...CSV_COLUMNS]);
  assert.deepEqual(header.slice(0, 4), ["index", "P(0)", "P(1)", "P(2)"]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], ["0", "0", "0", "0", "1", "0.5", "0", "0", "-1", "0"]);
  assert.deepEqual(rows[1], ["1", "0.1", "0.2", "0.3", "1", "0.9", "0", "1", "-1", "0"]);
  assert.deepEqual(rows[2]!.slice(0, 4), ["2", "1.23457", "-2", "0"]);
  // No trailing newline (a Table DAT would load an empty row) and no comments.
  assert.ok(!csv.endsWith("\n"));
  assert.ok(!csv.includes("#"));
});

test("sparse / unmapped LEDs get a row, mapped=0, interpolated by index and clamped at the ends", () => {
  // ledCount 8: ids 2 and 6 solved; 4 is listed in unmapped even though present
  // (unmapped wins); 0,1 (head), 3..5 (gap), 7 (tail) are absent.
  const map = mapOf([led(2, [0, 0, 0]), led(4, [9, 9, 9]), led(6, [4, 8, -4])], 8, [4]);
  const rows = exportRows(map);
  assert.equal(rows.length, 8);
  assert.deepEqual(
    rows.map((r) => r.mapped),
    [false, false, true, false, false, false, true, false],
  );
  assert.deepEqual(rows[0]!.xyz, [0, 0, 0]); // clamped to id 2
  assert.deepEqual(rows[1]!.xyz, [0, 0, 0]);
  assert.deepEqual(rows[3]!.xyz, [1, 2, -1]); // 1/4 of the way 2 → 6
  assert.deepEqual(rows[4]!.xyz, [2, 4, -2]);
  assert.deepEqual(rows[5]!.xyz, [3, 6, -3]);
  assert.deepEqual(rows[7]!.xyz, [4, 8, -4]); // clamped to id 6
  assert.equal(rows[4]!.confidence, 0);
  const csvRows = parseCsv(mapToCsv(map)).rows;
  assert.deepEqual(
    csvRows.map((r) => r[4]),
    ["0", "0", "1", "0", "0", "0", "1", "0"],
  );
});

test("an id beyond ledCount widens the export; a map with nothing solved sits at the origin", () => {
  assert.equal(exportRows(mapOf([led(5, [1, 1, 1])], 3)).length, 6);
  const none = exportRows(mapOf([], 3, [0, 1, 2]));
  assert.equal(none.length, 3);
  assert.ok(none.every((r) => !r.mapped && r.xyz.every((v) => v === 0)));
});

test("multi-channel: channel + channel_index from a covering layout; mismatched layouts are ignored", () => {
  const leds = Array.from({ length: 5 }, (_, i) => led(i, [i, 0, 0]));
  const map = mapOf(leds, 5);
  const rows = exportRows(map, { channels: [3, 2] });
  assert.deepEqual(
    rows.map((r) => [r.index, r.channel, r.channelIndex]),
    [
      [0, 0, 0],
      [1, 0, 1],
      [2, 0, 2],
      [3, 1, 0],
      [4, 1, 1],
    ],
  );
  // Doesn't sum to the LED count → one channel.
  assert.ok(exportRows(map, { channels: [3, 3] }).every((r) => r.channel === 0));
  assert.deepEqual(channelLayoutFor(5, [3, 2, 0, 0]), [3, 2]);
  assert.equal(channelLayoutFor(5, [5, 1]), null);
  assert.equal(channelLayoutFor(5, []), null);
  assert.deepEqual(channelLayoutFor(5, [0, 5]), [0, 5]);
});

test("topology associations fill segment + arclength", () => {
  const map = mapOf([led(0, [0, 0, 0]), led(1, [1, 0, 0])], 2);
  const topology: Topology = {
    mapId: "m1",
    branchPoints: [],
    segments: [],
    associations: [{ ledId: 1, segmentId: 7, footArclength: 0.25, dPerp: 0.01 }],
  };
  const { rows } = parseCsv(mapToCsv(map, { topology }));
  assert.deepEqual(rows[0]!.slice(8), ["-1", "0"]);
  assert.deepEqual(rows[1]!.slice(8), ["7", "0.25"]);
});

test("up axis: default keeps Splanc's +Y up; z rewrites (x, y, z) → (x, -z, y)", () => {
  const map = mapOf([led(0, [1, 2, 3])], 1);
  assert.deepEqual(exportRows(map)[0]!.xyz, [1, 2, 3]);
  assert.deepEqual(exportRows(map, { up: "z" })[0]!.xyz, [1, -3, 2]);
});

test("lxf: Chromatik points components per channel, scale parameter, meta", () => {
  const leds = [led(0, [0, 1, 0]), led(1, [0.5, 1, 0]), led(3, [1, 1, 0.123456789])];
  const map = mapOf(leds, 4, [2]);
  const fx = JSON.parse(mapToLxf(map, { name: "Coil $lamp", channels: [2, 2], up: "z" }));
  assert.equal(fx.label, "Coil lamp");
  assert.deepEqual(fx.tags, ["splanc"]);
  assert.equal(fx.parameters.scale.type, "float");
  assert.equal(fx.parameters.scale.default, LXF_DEFAULT_SCALE);
  assert.match(fx.parameters.scale.label, /^[a-zA-Z0-9 _-]+$/); // Chromatik's label rule
  assert.deepEqual(fx.transforms, [{ scale: "$scale" }]);
  assert.equal(fx.components.length, 2);
  assert.deepEqual(
    fx.components.map((c: { type: string; id: string }) => [c.type, c.id]),
    [
      ["points", "channel0"],
      ["points", "channel1"],
    ],
  );
  // Output order inside each channel; unmapped id 2 interpolated; +Y up kept
  // (lxf ignores `up`).
  assert.deepEqual(fx.components[0].coords, [
    { x: 0, y: 1, z: 0 },
    { x: 0.5, y: 1, z: 0 },
  ]);
  assert.deepEqual(fx.components[1].coords[0], { x: 0.75, y: 1, z: 0.06173 });
  assert.deepEqual(fx.components[1].coords[1], { x: 1, y: 1, z: 0.12346 });
  assert.equal(fx.meta.unmapped, "2");
  assert.equal(fx.meta.ledCount, "4");
  assert.equal(fx.meta.channels, "2,2");
  for (const v of Object.values(fx.meta)) assert.equal(typeof v, "string");
});

test("lxf without a channel layout: one unnamed points component", () => {
  const fx = JSON.parse(mapToLxf(mapOf([led(0, [0, 0, 0]), led(1, [1, 0, 0])], 2)));
  assert.equal(fx.label, "Splanc fixture");
  assert.equal(fx.components.length, 1);
  assert.equal(fx.components[0].id, undefined);
  assert.equal(fx.components[0].coords.length, 2);
  assert.equal(fx.meta.channels, undefined);
  assert.equal(fx.meta.unmapped, "");
});

test("idRanges + exportFileName", () => {
  assert.equal(idRanges([10, 9, 1, 2, 3, 7, 3]), "1-3,7,9-10");
  assert.equal(idRanges([]), "");
  const d = new Date(2026, 9, 5);
  assert.equal(exportFileName("Coil lamp / v2", "csv", d), "Coil_lamp_v2-2026-10-05.csv");
  assert.equal(exportFileName("  ", "lxf", d), "map-2026-10-05.lxf");
});
