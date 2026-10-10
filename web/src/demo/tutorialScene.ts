import { effectStore } from "../store/effectStore";
import { mapStore } from "../store/mapStore";
import { MAXA_DEMO_NAME, MAXA_DEMO_SOURCE, MAXA_DEMO_SCENE, MAXA_TUTORIAL_ID } from "./maxaScene";

/** Explicitly starting the tutorial makes an editable demo, without replacing
 * any previous tutorial edits or the user's selected map. */
export async function prepareTutorialScene(): Promise<void> {
  if (!(await mapStore.list()).some(map => map.deviceMapId === MAXA_DEMO_SCENE.mapId)) {
    const [{ SAMPLE }, { unpackSample }] = await Promise.all([
      import("../store/showcaseMaxa"), import("../store/showcaseFormat"),
    ]);
    await mapStore.create({ ...unpackSample(SAMPLE), source: "import", deviceMapId: SAMPLE.map.mapId });
  }
  if (await effectStore.get(MAXA_TUTORIAL_ID)) return;
  const now = new Date().toISOString();
  await effectStore.createWithId({
    id: MAXA_TUTORIAL_ID, name: `${MAXA_DEMO_NAME} (tutorial)`,
    source: MAXA_DEMO_SOURCE, scene: structuredClone(MAXA_DEMO_SCENE),
    tags: ["demo", "tutorial"], createdAt: now, updatedAt: now,
  });
}
