import { mapStore } from "./mapStore";
import { effectStore } from "./effectStore";
import { MAXA_DEMO_NAME, MAXA_TUTORIAL_ID } from "../demo/maxaScene";
import { SHOWCASE_SCENES } from "../demo/showcaseScenes";

export const SAMPLE_DESCRIPTIONS: Record<string, string> = {
  "sample-maxa": "Resting Deer: a crouching deer with edge-lit triangular facets. Compare spatial sweeps with pulses that follow the edges. Topology extracted offline; tune it in the topology editor.",
  "sample-tenere": "Tree of Light: luminous leaves and a branching canopy above an unlit trunk. A gray digital twin gives the lights their context. Topology extracted offline; tune it in the topology editor.",
  "sample-primitive-obsession": "Inspired by Wake and Make’s Primitive Obsession: a 20 × 20 × 20 LED volume in a 10-foot open frame. Explore spatial waves, shells and noise. Deliberately no topology. https://wakenmake.shop/projects/primitive_obsession/",
};

const LEGACY_MAPS = [
  {
    mapId: "sample-maxa", oldName: "Sample: Maxa Art Car", name: "Sample: Resting Deer",
    oldMesh: "Maxa-inspired crouching low-poly deer", mesh: "Resting Deer low-poly mesh",
    description: "A procedural interpretation of the Maxa Art Car: a crouching deer with edge-lit triangular facets. Compare spatial sweeps with pulses that follow the edges. Topology extracted offline; tune it in the topology editor.",
  },
  {
    mapId: "sample-tenere", oldName: "Sample: Tree of Tenere", name: "Sample: Tree of Light",
    oldMesh: "Tenere-inspired trunk, branches and leaves", mesh: "Tree of Light trunk, branches and leaves",
    description: "A procedural interpretation inspired by Studio DRIFT’s Tree of Tenere: luminous leaves and a branching canopy above an unlit trunk. A gray digital twin gives the lights their context. Topology extracted offline; tune it in the topology editor. https://studiodrift.com/",
  },
];

/** Upgrade default labels on existing installs; IDs and user edits remain intact. */
export async function migrateSampleMapNames(): Promise<void> {
  const flag = "ledmapper.sampleNames.maps.v1";
  try {
    if (localStorage.getItem(flag)) return;
    for (const summary of await mapStore.list()) {
      const legacy = LEGACY_MAPS.find(sample => sample.mapId === summary.deviceMapId);
      if (!legacy) continue;
      if (summary.name === legacy.oldName) await mapStore.rename(summary.id, legacy.name);
      if (summary.description === legacy.description) {
        await mapStore.setDescription(summary.id, SAMPLE_DESCRIPTIONS[legacy.mapId]!);
      }
      const record = await mapStore.get(summary.id);
      if (record?.mesh?.name === legacy.oldMesh) {
        await mapStore.setMesh(summary.id, { ...record.mesh, name: legacy.mesh });
      }
    }
    localStorage.setItem(flag, "1");
  } catch (error) { console.warn("Could not update sample map names", error); }
}

export async function migrateSampleEffectNames(): Promise<void> {
  const flag = "ledmapper.sampleNames.effects.v1";
  try {
    if (localStorage.getItem(flag)) return;
    const renames = [
      { id: SHOWCASE_SCENES[0]!.id, oldName: "Maxa: spatial bands + topology flood", name: SHOWCASE_SCENES[0]!.name },
      { id: SHOWCASE_SCENES[1]!.id, oldName: "Tree of Tenere: spatial bands + topology flood", name: SHOWCASE_SCENES[1]!.name },
      { id: MAXA_TUTORIAL_ID, oldName: "Maxa: spatial bands + topology flood (tutorial)", name: `${MAXA_DEMO_NAME} (tutorial)` },
    ];
    for (const rename of renames) {
      const record = await effectStore.get(rename.id);
      if (record?.name === rename.oldName) {
        // Built-ins cannot be renamed via the editing API; preserve every
        // other field, including captured values and tutorial source edits.
        await effectStore.createWithId({ ...record, name: rename.name });
      }
    }
    localStorage.setItem(flag, "1");
  } catch (error) { console.warn("Could not update sample effect names", error); }
}
