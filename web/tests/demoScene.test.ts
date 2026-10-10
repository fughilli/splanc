import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { installFakeDom } from "./fakeDom";
import { effectStore, type StoredEffect } from "../src/store/effectStore";
import { mapStore, type StoredMapSummary } from "../src/store/mapStore";
import { prepareTutorialScene } from "../src/demo/tutorialScene";
import { seedBuiltinEffects } from "../src/store/seedEffects";
import { MAXA_DEMO_ID, MAXA_TUTORIAL_ID, MAXA_DEMO_SCENE } from "../src/demo/maxaScene";
import { SHOWCASE_SCENES } from "../src/demo/showcaseScenes";

installFakeDom();

test("tutorial creates an editable Maxa scene, restores a deleted fixture, and preserves subsequent edits", async () => {
  const effects = new Map<string, StoredEffect>();
  const maps: StoredMapSummary[] = [];
  let creates = 0;
  mock.method(effectStore, "get", async (id: string) => effects.get(id));
  mock.method(effectStore, "createWithId", async (effect: StoredEffect) => { effects.set(effect.id, effect); });
  mock.method(mapStore, "list", async () => maps);
  mock.method(mapStore, "create", async () => {
    creates++;
    maps.push({ id: "local-maxa", deviceMapId: "sample-maxa" } as StoredMapSummary);
    return "local-maxa";
  });
  try {
    await prepareTutorialScene();
    assert.equal(creates, 1);
    const effect = effects.get(MAXA_TUTORIAL_ID)!;
    assert.deepEqual(effect.scene, MAXA_DEMO_SCENE);
    effect.source = "user's next experiment";
    await prepareTutorialScene();
    assert.equal(creates, 1);
    assert.equal(effects.get(MAXA_TUTORIAL_ID)!.source, "user's next experiment");
  } finally { mock.restoreAll(); }
});

test("an installation with Maxa already seeded receives the other two scenes", async () => {
  localStorage.clear();
  localStorage.setItem("ledmapper.seededEffects.v6", "1");
  localStorage.setItem("ledmapper.seededEffects.maxa.v1", "1");
  const created: StoredEffect[] = [];
  mock.method(effectStore, "get", async () => undefined);
  mock.method(effectStore, "createWithId", async (effect: StoredEffect) => { created.push(effect); });
  try {
    await seedBuiltinEffects();
    assert.deepEqual(created.map(effect => effect.scene?.mapId), ["sample-tenere", "sample-primitive-obsession"]);
    assert.equal(SHOWCASE_SCENES[2]!.scene.uniforms.floodTint!.every(channel => channel === 0), true);
  } finally { mock.restoreAll(); localStorage.clear(); }
});

test("existing installs get the canned scene once, and deletion stays respected", async () => {
  localStorage.clear();
  localStorage.setItem("ledmapper.seededEffects.v6", "1");
  const effects = new Map<string, StoredEffect>();
  let creates = 0;
  mock.method(effectStore, "get", async (id: string) => effects.get(id));
  mock.method(effectStore, "createWithId", async (effect: StoredEffect) => {
    creates++; effects.set(effect.id, effect);
  });
  try {
    await seedBuiltinEffects();
    assert.equal(creates, 3);
    assert.deepEqual(effects.get(MAXA_DEMO_ID)!.scene, MAXA_DEMO_SCENE);
    effects.delete(MAXA_DEMO_ID);
    await seedBuiltinEffects();
    assert.equal(creates, 3);
  } finally { mock.restoreAll(); localStorage.clear(); }
});
