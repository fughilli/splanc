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
import { migrateSampleMapNames, SAMPLE_DESCRIPTIONS } from "./sampleNames";

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
  await migrateSampleMapNames();
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
      await mapStore.setDescription(id, SAMPLE_DESCRIPTIONS[sample.map.mapId] ?? "");
      localStorage.setItem(flag, "1");
    } catch (e) { console.warn(`Could not seed ${sample.name}`, e); }
  }
}
