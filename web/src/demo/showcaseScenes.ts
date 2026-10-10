import { MAXA_DEMO_ID, MAXA_DEMO_NAME, MAXA_DEMO_SOURCE, MAXA_DEMO_SCENE } from "./maxaScene";
import type { EffectScene } from "../effects/scene";

export interface ShowcaseScene {
  id: string;
  name: string;
  label: string;
  source: string;
  scene: EffectScene;
  tags: string[];
}

export const SHOWCASE_SCENES: ShowcaseScene[] = [
  {
    id: MAXA_DEMO_ID, name: MAXA_DEMO_NAME, label: "Maxa Art Car",
    source: MAXA_DEMO_SOURCE, scene: MAXA_DEMO_SCENE, tags: ["demo", "topology", "spatial"],
  },
  {
    id: "builtin-tenere-acid", name: "Tree of Tenere: spatial bands + topology flood",
    label: "Tree of Tenere", source: MAXA_DEMO_SOURCE,
    scene: { mapId: "sample-tenere", uniforms: structuredClone(MAXA_DEMO_SCENE.uniforms) },
    tags: ["demo", "topology", "spatial"],
  },
  {
    id: "builtin-primitive-spatial", name: "Primitive Obsession: spatial bands",
    label: "Primitive Obsession", source: MAXA_DEMO_SOURCE,
    // A volume has no graph. Keep the captured spatial effect, and disable the
    // graph flood rather than inventing connectivity through neighboring LEDs.
    scene: { mapId: "sample-primitive-obsession", uniforms: {
      ...structuredClone(MAXA_DEMO_SCENE.uniforms), floodTint: [0, 0, 0],
    } },
    tags: ["demo", "volumetric", "spatial"],
  },
];
