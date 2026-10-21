/**
 * Recognizing the device's map in the library (src/store/mapStore.ts
 * findByMapId + importBundleObject dedupe). The Maps tab's "On <device>" card
 * says "Saved on this phone" when the library already holds the map the device
 * reports, and Save / Calibrate IMU must open that copy instead of adding a
 * second one. A map keeps its map_id through a push, so the id the device
 * reports in its stored-map header matches:
 *
 *   - a map pulled earlier (summary.deviceMapId),
 *   - a map captured or imported on this phone and pushed (summary.mapId),
 *   - a map saved before summary.mapId existed (backfilled from the payload,
 *     without reordering the library).
 *
 * Runs the real store over an in-memory IndexedDB (tests/fakeIdb.ts).
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { OutputMap, Topology } from "@ledmapper/protocol";
import { installFakeIndexedDb } from "./fakeIdb";

const idb = installFakeIndexedDb();

import { mapStore } from "../src/store/mapStore";

function map(mapId: string, leds = 4): OutputMap {
  return {
    mapId,
    createdAt: "2026-10-01T12:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: leds,
    leds: Array.from({ length: leds }, (_, i) => ({
      id: i,
      xyz: [i * 0.1, 0, 0],
      confidence: 1,
      nViews: 3,
      rmsReprojPx: 0.5,
      parallaxDeg: 10,
    })),
    unmapped: [],
    trajectory: [],
    stats: { rmsReprojPxGlobal: 0.5, medianParallaxDeg: 10, warnings: [] },
  } as unknown as OutputMap;
}

const topo = (mapId: string): Topology => ({ mapId, branchPoints: [], segments: [], associations: [] });

beforeEach(() => idb.clear());

test("a map captured here and pushed is found by the id the device reports", async () => {
  const id = await mapStore.create({ map: map("cap-1"), source: "capture" });
  const hit = await mapStore.findByMapId("cap-1");
  assert.equal(hit?.id, id);
  assert.equal(await mapStore.findByMapId("other"), undefined);
  assert.equal(await mapStore.findByMapId(""), undefined, "an empty id never matches");
});

test("pulling the same device map twice keeps one library entry", async () => {
  const bundle = { map: map("dev-7"), topology: topo("dev-7") };
  const first = await mapStore.importBundleObject(bundle, { source: "pull" });
  const second = await mapStore.importBundleObject(bundle, { source: "pull" });
  assert.equal(second, first);
  assert.equal((await mapStore.list()).length, 1);
  assert.equal((await mapStore.findByMapId("dev-7"))?.deviceMapId, "dev-7");
});

test("pulling a map this phone captured opens the captured copy, not a duplicate", async () => {
  const captured = await mapStore.create({ map: map("cap-2"), source: "capture" });
  const pulled = await mapStore.importBundleObject({ map: map("cap-2"), topology: topo("cap-2") }, { source: "pull" });
  assert.equal(pulled, captured);
  assert.equal((await mapStore.list()).length, 1);
});

test("a summary saved before mapId was stamped is matched from its payload and backfilled quietly", async () => {
  const id = await mapStore.create({ map: map("legacy-1"), source: "capture" });
  // Rewrite the summary as an older build left it: no mapId field.
  const rec = idb.stores.get("maps_index")!.records.get(id)!;
  delete rec["mapId"];
  const before = String(rec["updatedAt"]);

  const hit = await mapStore.findByMapId("legacy-1");
  assert.equal(hit?.id, id);
  const after = idb.stores.get("maps_index")!.records.get(id)!;
  assert.equal(after["mapId"], "legacy-1", "backfilled");
  assert.equal(after["updatedAt"], before, "no updatedAt bump, so the library order is unchanged");
});

test("a transform saved over a map keeps it recognizable (setMap restamps the same id)", async () => {
  const id = await mapStore.create({ map: map("cap-3"), source: "capture" });
  await mapStore.setMap(id, map("cap-3", 6));
  assert.equal((await mapStore.findByMapId("cap-3"))?.id, id);
});
