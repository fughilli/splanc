import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { mapStore, type CreateInput, type StoredMapSummary } from "../src/store/mapStore";
import { seedBuiltinMaps } from "../src/store/seedMaps";
import { asFake, installFakeDom } from "./fakeDom";
import { recordCanvas } from "./canvasRecorder";
import { MapView } from "../src/ui/mapview";
import { SHOWCASE_SAMPLES } from "../src/store/showcaseData";

const dom = installFakeDom();
test("samples seed once on existing installs and deleted samples are not resurrected", async () => {
  localStorage.clear();
  localStorage.setItem("ledmapper.seededBuiltins.v1", "1"); // Original Y already seeded.
  const summaries: StoredMapSummary[] = [];
  let creates = 0;
  mock.method(mapStore, "list", async () => summaries);
  mock.method(mapStore, "create", async (input: CreateInput) => {
    const id = `sample-${creates++}`;
    summaries.push({ id, deviceMapId: input.deviceMapId } as StoredMapSummary);
    return id;
  });
  mock.method(mapStore, "setTags", async () => undefined);
  mock.method(mapStore, "setDescription", async () => undefined);
  try {
    await seedBuiltinMaps(); assert.equal(creates, 3);
    summaries.pop(); // Simulate user deleting one sample.
    await seedBuiltinMaps(); assert.equal(creates, 3);
  } finally { mock.restoreAll(); localStorage.clear(); }
});
test("failed seeding retries metadata without creating a duplicate map", async () => {
  localStorage.clear(); localStorage.setItem("ledmapper.seededBuiltins.v1", "1");
  const summaries: StoredMapSummary[] = [];
  let creates = 0, fail = true;
  mock.method(mapStore, "list", async () => summaries);
  mock.method(mapStore, "create", async (input: CreateInput) => {
    const id = `sample-${creates++}`;
    summaries.push({ id, deviceMapId: input.deviceMapId } as StoredMapSummary); return id;
  });
  mock.method(mapStore, "setTags", async () => undefined);
  mock.method(mapStore, "setDescription", async () => { if (fail) throw new Error("disk full"); });
  mock.method(console, "warn", () => undefined);
  try {
    await seedBuiltinMaps(); assert.equal(creates, 3);
    fail = false; await seedBuiltinMaps(); assert.equal(creates, 3);
  } finally { mock.restoreAll(); localStorage.clear(); }
});
test("digital twins render as gray translucent faces and hide without changing LEDs", () => {
  const sample = SHOWCASE_SAMPLES[0]!;
  const canvas = asFake(document.createElement("canvas"));
  canvas.rect = { x: 0, y: 0, width: 640, height: 420 };
  const rec = recordCanvas(canvas);
  const view = new MapView(canvas as unknown as HTMLCanvasElement, sample.map);
  view.setMesh(sample.mesh); view.start();
  try {
    assert.ok(rec.of("fill").some(c => c.fillStyle === "rgb(150 150 150 / 0.09)"));
    assert.equal(rec.of("arc").length, sample.map.ledCount);
    rec.clear(); view.setMesh({ ...sample.mesh, visible: false }); dom.flushAnimationFrames();
    assert.ok(!rec.of("fill").some(c => c.fillStyle === "rgb(150 150 150 / 0.09)"));
    assert.equal(rec.of("arc").length, sample.map.ledCount);
  } finally { view.stop(); }
});
