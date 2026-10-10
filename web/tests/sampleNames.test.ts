import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { installFakeDom } from "./fakeDom";
import { mapStore, type StoredMapSummary } from "../src/store/mapStore";
import { effectStore, type StoredEffect } from "../src/store/effectStore";
import { migrateSampleMapNames, migrateSampleEffectNames } from "../src/store/sampleNames";
installFakeDom();
test("name migration preserves custom names and edited tutorial source, and runs once", async () => {
  localStorage.clear();
  const renamed: string[] = [], written: StoredEffect[] = [];
  mock.method(mapStore, "list", async () => [
    { id: "deer", deviceMapId: "sample-maxa", name: "Sample: Maxa Art Car" },
    { id: "tree", deviceMapId: "sample-tenere", name: "My edited tree" },
  ] as StoredMapSummary[]);
  mock.method(mapStore, "get", async () => undefined);
  mock.method(mapStore, "rename", async (_id: string, name: string) => { renamed.push(name); });
  mock.method(effectStore, "get", async (id: string) => id === "tutorial-maxa-acid"
    ? { id, name: "Maxa: spatial bands + topology flood (tutorial)", source: "edited source", scene: { mapId: "sample-maxa", uniforms: {} } } as StoredEffect
    : undefined);
  mock.method(effectStore, "createWithId", async (record: StoredEffect) => { written.push(record); });
  try {
    await migrateSampleMapNames(); await migrateSampleEffectNames();
    await migrateSampleMapNames(); await migrateSampleEffectNames();
    assert.deepEqual(renamed, ["Sample: Resting Deer"]);
    assert.equal(written.length, 1);
    assert.equal(written[0]!.source, "edited source");
    assert.equal(written[0]!.name, "Resting Deer: spatial bands + topology flood (tutorial)");
    assert.equal(written[0]!.scene!.mapId, "sample-maxa");
  } finally { mock.restoreAll(); localStorage.clear(); }
});
