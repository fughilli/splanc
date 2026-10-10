/**
 * One-time seeding of built-in sample maps into the library, so a fresh install
 * (e.g. opening the deployed page) has something to explore without capturing
 * or importing. The bytes are embedded (seedMapData.ts) rather than fetched so
 * they ship in the bundle with no asset-pipeline wiring.
 *
 * Idempotent AND deletion-respecting: a localStorage flag records that we've
 * seeded, so a sample the user deletes is not resurrected on the next load.
 */
import { mapStore } from "./mapStore";
import { SYNTHETIC_Y_JUNCTION_B64 } from "./seedMapData";

const SEED_FLAG = "ledmapper.seededBuiltins.v1";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import the built-in sample map(s) once. Cheap no-op after the first run
 * (localStorage check happens before any IndexedDB work). */
async function seedOriginalMap(): Promise<void> {
  try {
    if (localStorage.getItem(SEED_FLAG)) return;
    const id = await mapStore.importBundle(b64ToBytes(SYNTHETIC_Y_JUNCTION_B64), {
      source: "import",
    });
    try {
      await mapStore.rename(id, "Sample: Y-junction");
      await mapStore.setTags(id, ["sample"]);
    } catch {
      /* naming is best-effort — the map is already in the library */
    }
    localStorage.setItem(SEED_FLAG, "1");
  } catch (e) {
    // Never let seeding block app startup.
    console.warn("seedBuiltinMaps failed", e);
  }
}

/** Per-sample flags let existing installations receive new examples without
 * resurrecting deleted samples. Commit a flag only after the full import. */
export async function seedBuiltinMaps(): Promise<void> {
  await seedOriginalMap();
  const ids = ["sample-tenere", "sample-primitive-obsession", "sample-maxa"];
  try {
    if (ids.every(id => localStorage.getItem(`ledmapper.seededBuiltins.${id}.v1`))) return;
  } catch { return; }
  const { SHOWCASE_SAMPLES } = await import("./showcaseData");
  for (const sample of SHOWCASE_SAMPLES) {
    const flag = `ledmapper.seededBuiltins.${sample.map.mapId}.v1`;
    try {
      if (localStorage.getItem(flag)) continue;
      // A deterministic deviceMapId also makes retries safe after partial seeding.
      let id = (await mapStore.list()).find(m => m.deviceMapId === sample.map.mapId)?.id;
      if (!id) id = await mapStore.create({ ...sample, source: "import", deviceMapId: sample.map.mapId });
      await mapStore.setTags(id, ["sample", sample.map.mapId.includes("primitive") ? "volumetric" : "topology"]);
      const description = sample.map.mapId.includes("primitive")
        ? "Inspired by Wake and Make’s Primitive Obsession: a 20 × 20 × 20 LED volume in a 10-foot open frame. Explore spatial waves, shells and noise. Deliberately no topology. https://wakenmake.shop/projects/primitive_obsession/"
        : sample.map.mapId.includes("maxa")
          ? "A procedural interpretation of the Maxa Art Car: a crouching deer with edge-lit triangular facets. Compare spatial sweeps with pulses that follow the edges. Topology extracted offline; tune it in the topology editor."
          : "A procedural interpretation inspired by Studio DRIFT’s Tree of Tenere: luminous leaves and a branching canopy above an unlit trunk. A gray digital twin gives the lights their context. Topology extracted offline; tune it in the topology editor. https://studiodrift.com/";
      await mapStore.setDescription(id, description);
      localStorage.setItem(flag, "1");
    } catch (e) { console.warn(`Could not seed ${sample.name}`, e); }
  }
}
