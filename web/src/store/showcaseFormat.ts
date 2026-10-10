import type { OutputMap, Topology, Vec3 } from "@ledmapper/protocol";
import type { MeshOverlay } from "../geom/mesh";

/** Synthetic samples share confidence metadata. Store just positions rather
 * than repeating those fields for thousands of LEDs in the shipped assets. */
export interface PackedSample {
  name: string;
  map: Omit<OutputMap, "leds"> & { leds: Vec3[] };
  topology: Topology;
  mesh: MeshOverlay;
}

export function unpackSample(sample: PackedSample): {
  name: string; map: OutputMap; topology: Topology; mesh: MeshOverlay;
} {
  return {
    ...sample,
    map: {
      ...sample.map,
      leds: sample.map.leds.map((xyz, id) => ({
        id, xyz, confidence: 1, nViews: 8, rmsReprojPx: 0, parallaxDeg: 35,
      })),
    },
  };
}
