/**
 * MapStore (design doc §5 / §7.5) — the map library, IndexedDB-backed.
 *
 * Two object stores in one DB (`ledmapper`):
 *   - `maps_index`   → StoredMapSummary (the browser list; no heavy payload)
 *   - `maps_payload` → { map, topology } keyed by id (lazy-loaded on open)
 *
 * Screens depend on this interface, never on IndexedDB directly, so the engine
 * can change later (OPFS/export sync) without touching the UI.
 */

import type { OutputMap, Topology } from "@ledmapper/protocol";
import { decodeMappingBundle, encodeMappingBundle } from "../net/proto";
import { MapView } from "../ui/mapview";

/** Denormalized summary for the browser list (design doc §5.2). */
export interface StoredMapSummary {
  id: string;
  name: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source: "capture" | "pull" | "import";
  ledCount: number;
  units: "meters";
  frame: OutputMap["frame"];
  rmsReprojPx: number;
  hasTopology: boolean;
  deviceMapId?: string;
  /** Optional folder for organizing the library; "" / absent = ungrouped. */
  folder?: string;
  /** dataURL — small MapView snapshot; may be "" until first browser view. */
  thumbnail: string;
}

/** Full record = summary + payload. */
export interface StoredMap extends StoredMapSummary {
  map: OutputMap;
  topology?: Topology;
}

export interface CreateInput {
  map: OutputMap;
  topology?: Topology;
  source?: StoredMapSummary["source"];
  name?: string;
  deviceMapId?: string;
}

export interface ListQuery {
  search?: string;
  tags?: string[];
  sort?: "updated" | "name" | "leds";
}

const DB_NAME = "ledmapper";
// Shared DB with effectStore (which added the `effects` store at v2). Both
// modules MUST open at the same version — an older version request throws
// VersionError once the DB has been upgraded. The upgrade below is additive.
const DB_VERSION = 2;
const IDX = "maps_index";
const PAYLOAD = "maps_payload";

type Listener = () => void;

function uuid(): string {
  return crypto.randomUUID();
}

function normTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((t) => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean)));
}

/** Default name e.g. "Ceiling · 12 Jul 14:03" (design doc §5.2). */
function defaultName(map: OutputMap): string {
  const d = map.createdAt ? new Date(map.createdAt) : new Date();
  const when = d.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Map · ${when}`;
}

function summaryFromMap(input: CreateInput, id: string, now: string): StoredMapSummary {
  const { map } = input;
  const s: StoredMapSummary = {
    id,
    name: input.name ?? defaultName(map),
    description: "",
    tags: [],
    createdAt: map.createdAt || now,
    updatedAt: now,
    source: input.source ?? "capture",
    ledCount: map.ledCount,
    units: map.units,
    frame: map.frame,
    rmsReprojPx: map.stats?.rmsReprojPxGlobal ?? 0,
    hasTopology: (input.topology?.segments.length ?? 0) > 0,
    thumbnail: "",
  };
  if (input.deviceMapId !== undefined) s.deviceMapId = input.deviceMapId;
  return s;
}

class MapStore {
  private dbp: Promise<IDBDatabase> | null = null;
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private db(): Promise<IDBDatabase> {
    if (this.dbp === null) {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(IDX)) {
            const store = db.createObjectStore(IDX, { keyPath: "id" });
            store.createIndex("updatedAt", "updatedAt");
            store.createIndex("tags", "tags", { multiEntry: true });
            store.createIndex("name", "name");
          }
          if (!db.objectStoreNames.contains(PAYLOAD)) {
            db.createObjectStore(PAYLOAD, { keyPath: "id" });
          }
          // effectStore's store (v2) — created here too so a fresh install that
          // opens the DB via mapStore first still reaches the v2 schema.
          if (!db.objectStoreNames.contains("effects")) {
            const e = db.createObjectStore("effects", { keyPath: "id" });
            e.createIndex("updatedAt", "updatedAt");
            e.createIndex("tags", "tags", { multiEntry: true });
            e.createIndex("name", "name");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbp;
  }

  private async tx<T>(
    stores: string[],
    mode: IDBTransactionMode,
    fn: (tx: IDBTransaction) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      Promise.resolve(fn(tx)).then((r) => (result = r)).catch(reject);
    });
  }

  private static req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  /** Request persistent storage so the library isn't evicted under pressure
   * (design doc §9.6). Best-effort; safe to call repeatedly. */
  async requestPersistence(): Promise<boolean> {
    try {
      if (navigator.storage?.persist) return await navigator.storage.persist();
    } catch {
      /* ignore */
    }
    return false;
  }

  /** Estimate storage usage (design doc §9.6 — near-capacity warning). */
  async storageEstimate(): Promise<{ usage: number; quota: number } | null> {
    try {
      if (navigator.storage?.estimate) {
        const e = await navigator.storage.estimate();
        return { usage: e.usage ?? 0, quota: e.quota ?? 0 };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  async list(query: ListQuery = {}): Promise<StoredMapSummary[]> {
    const all = await this.tx([IDX], "readonly", (tx) =>
      MapStore.req(tx.objectStore(IDX).getAll() as IDBRequest<StoredMapSummary[]>),
    );
    let out = all;
    const search = query.search?.trim().toLowerCase();
    if (search) {
      out = out.filter(
        (m) =>
          m.name.toLowerCase().includes(search) ||
          m.description.toLowerCase().includes(search) ||
          m.tags.some((t) => t.includes(search.replace(/^#/, ""))),
      );
    }
    if (query.tags && query.tags.length > 0) {
      const want = normTags(query.tags);
      out = out.filter((m) => want.every((t) => m.tags.includes(t)));
    }
    const sort = query.sort ?? "updated";
    out = [...out].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "leds") return b.ledCount - a.ledCount;
      return b.updatedAt.localeCompare(a.updatedAt);
    });
    return out;
  }

  async getSummary(id: string): Promise<StoredMapSummary | undefined> {
    return this.tx([IDX], "readonly", (tx) =>
      MapStore.req(tx.objectStore(IDX).get(id) as IDBRequest<StoredMapSummary | undefined>),
    );
  }

  /** Full record incl. lazily-loaded map/topology payload. */
  async get(id: string): Promise<StoredMap | undefined> {
    const summary = await this.getSummary(id);
    if (!summary) return undefined;
    const payload = await this.tx([PAYLOAD], "readonly", (tx) =>
      MapStore.req(
        tx.objectStore(PAYLOAD).get(id) as IDBRequest<
          { id: string; map: OutputMap; topology?: Topology } | undefined
        >,
      ),
    );
    if (!payload) return undefined;
    const rec: StoredMap = { ...summary, map: payload.map };
    if (payload.topology) rec.topology = payload.topology;
    return rec;
  }

  /** All known device map ids (dedup on pull). */
  private async deviceMapIds(): Promise<Set<string>> {
    const all = await this.list();
    return new Set(all.map((m) => m.deviceMapId).filter((x): x is string => !!x));
  }

  async create(input: CreateInput): Promise<string> {
    const id = uuid();
    const now = new Date().toISOString();
    const summary = summaryFromMap(input, id, now);
    // Off-screen thumbnail render (design doc §5.4). Best-effort — a WebGL
    // failure just leaves an empty thumbnail (regenerated lazily on view).
    summary.thumbnail = await renderThumbnail(input.map).catch(() => "");
    const payload: { id: string; map: OutputMap; topology?: Topology } = { id, map: input.map };
    if (input.topology) payload.topology = input.topology;
    await this.tx([IDX, PAYLOAD], "readwrite", (tx) => {
      tx.objectStore(IDX).put(summary);
      tx.objectStore(PAYLOAD).put(payload);
    });
    this.emit();
    return id;
  }

  private async patchSummary(id: string, patch: Partial<StoredMapSummary>): Promise<void> {
    await this.tx([IDX], "readwrite", async (tx) => {
      const store = tx.objectStore(IDX);
      const cur = await MapStore.req(store.get(id) as IDBRequest<StoredMapSummary | undefined>);
      if (!cur) return;
      const next: StoredMapSummary = { ...cur, ...patch, updatedAt: new Date().toISOString() };
      store.put(next);
    });
    this.emit();
  }

  async rename(id: string, name: string): Promise<void> {
    await this.patchSummary(id, { name });
  }

  async setDescription(id: string, text: string): Promise<void> {
    await this.patchSummary(id, { description: text });
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await this.patchSummary(id, { tags: normTags(tags) });
  }

  /** Assign a library folder (empty string = ungrouped). */
  async setFolder(id: string, folder: string): Promise<void> {
    await this.patchSummary(id, { folder: folder.trim() });
  }

  /** Distinct non-empty folder names in the library, sorted. */
  async folders(): Promise<string[]> {
    const set = new Set<string>();
    for (const m of await this.list()) if (m.folder) set.add(m.folder);
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  /** Persist an updated topology for an existing map (from the cleanup panel). */
  async setTopology(id: string, topology: Topology): Promise<void> {
    await this.tx([IDX, PAYLOAD], "readwrite", async (tx) => {
      const pStore = tx.objectStore(PAYLOAD);
      const cur = await MapStore.req(
        pStore.get(id) as IDBRequest<{ id: string; map: OutputMap; topology?: Topology } | undefined>,
      );
      if (!cur) return;
      pStore.put({ ...cur, topology });
      const iStore = tx.objectStore(IDX);
      const s = await MapStore.req(iStore.get(id) as IDBRequest<StoredMapSummary | undefined>);
      if (s) iStore.put({ ...s, hasTopology: topology.segments.length > 0, updatedAt: new Date().toISOString() });
    });
    this.emit();
  }

  /** Persist an edited map geometry (the editor's transform tools) — replaces
   * the stored map, and the topology when one is passed, then regenerates the
   * thumbnail from the new geometry. */
  async setMap(id: string, map: OutputMap, topology?: Topology): Promise<void> {
    const thumbnail = await renderThumbnail(map).catch(() => "");
    await this.tx([IDX, PAYLOAD], "readwrite", async (tx) => {
      const pStore = tx.objectStore(PAYLOAD);
      const cur = await MapStore.req(
        pStore.get(id) as IDBRequest<{ id: string; map: OutputMap; topology?: Topology } | undefined>,
      );
      if (!cur) return;
      const next: { id: string; map: OutputMap; topology?: Topology } = { ...cur, map };
      if (topology !== undefined) next.topology = topology;
      pStore.put(next);
      const iStore = tx.objectStore(IDX);
      const s = await MapStore.req(iStore.get(id) as IDBRequest<StoredMapSummary | undefined>);
      if (s) {
        const ns: StoredMapSummary = { ...s, updatedAt: new Date().toISOString() };
        if (thumbnail) ns.thumbnail = thumbnail;
        if (topology !== undefined) ns.hasTopology = topology.segments.length > 0;
        iStore.put(ns);
      }
    });
    this.emit();
  }

  /** Store a freshly-rendered thumbnail (lazy replacement on first view). */
  async setThumbnail(id: string, dataUrl: string): Promise<void> {
    await this.tx([IDX], "readwrite", async (tx) => {
      const store = tx.objectStore(IDX);
      const cur = await MapStore.req(store.get(id) as IDBRequest<StoredMapSummary | undefined>);
      if (cur) store.put({ ...cur, thumbnail: dataUrl });
    });
    this.emit();
  }

  async duplicate(id: string): Promise<string | undefined> {
    const rec = await this.get(id);
    if (!rec) return undefined;
    const input: CreateInput = {
      map: rec.map,
      source: "import",
      name: `${rec.name} (copy)`,
    };
    if (rec.topology) input.topology = rec.topology;
    const newId = await this.create(input);
    // Copy over metadata the create() default wouldn't carry.
    await this.patchSummary(newId, { description: rec.description, tags: rec.tags });
    return newId;
  }

  async delete(id: string): Promise<void> {
    await this.tx([IDX, PAYLOAD], "readwrite", (tx) => {
      tx.objectStore(IDX).delete(id);
      tx.objectStore(PAYLOAD).delete(id);
    });
    this.emit();
  }

  /** Import a .binpb MappingBundle as a new library entry. Dedups a pulled map
   * by its device-provided mapId. Returns the (existing or new) id. */
  async importBundle(
    bytes: Uint8Array,
    opts: { source?: StoredMapSummary["source"] } = {},
  ): Promise<string> {
    return this.importBundleObject(decodeMappingBundle(bytes), opts);
  }

  /** Import an already-decoded MappingBundle (e.g. pulled off a device via the
   * wss client). Same dedup-by-device-mapId behaviour as {@link importBundle}. */
  async importBundleObject(
    bundle: ReturnType<typeof decodeMappingBundle>,
    opts: { source?: StoredMapSummary["source"] } = {},
  ): Promise<string> {
    if (!bundle.map || bundle.map.leds.length === 0) {
      throw new Error("bundle has no LEDs");
    }
    const deviceMapId = bundle.map.mapId || undefined;
    if (deviceMapId) {
      const seen = await this.deviceMapIds();
      if (seen.has(deviceMapId)) {
        const existing = (await this.list()).find((m) => m.deviceMapId === deviceMapId);
        if (existing) return existing.id;
      }
    }
    const input: CreateInput = { map: bundle.map, source: opts.source ?? "import" };
    if (bundle.topology && bundle.topology.segments.length > 0) input.topology = bundle.topology;
    if (deviceMapId) input.deviceMapId = deviceMapId;
    return this.create(input);
  }

  /** Encode a stored map (+ its topology) as a .binpb MappingBundle. */
  async exportBundle(id: string): Promise<Uint8Array> {
    const rec = await this.get(id);
    if (!rec) throw new Error("no such map");
    const topology: Topology = rec.topology ?? {
      mapId: rec.map.mapId,
      branchPoints: [],
      segments: [],
      associations: [],
    };
    return encodeMappingBundle({ map: rec.map, topology });
  }
}

/** Off-screen MapView snapshot → dataURL (design doc §5.4). Fixed orbit, LEDs
 * on black. Renders a couple frames so the scene settles, then reads back. */
async function renderThumbnail(map: OutputMap, size = 128): Promise<string> {
  if (map.leds.length === 0) return "";
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const view = new MapView(canvas, map);
  view.setLedColors(new Uint8Array(map.leds.length * 3)); // emissive dots on black
  view.start();
  await new Promise((r) => setTimeout(r, 120));
  let url = "";
  try {
    url = canvas.toDataURL("image/webp", 0.7);
  } catch {
    url = "";
  }
  view.stop();
  return url;
}

export const mapStore = new MapStore();
export { renderThumbnail };
