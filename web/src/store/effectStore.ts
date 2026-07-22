/**
 * EffectStore — the user's shader-effect library, IndexedDB-backed. Mirrors
 * mapStore's style/observable pattern so the effect-browser and editor screens
 * depend on this interface, never on IndexedDB directly.
 *
 * One object store (`effects`) in the shared `ledmapper` DB (bumped DB_VERSION).
 * A record is small (just the GLSL-ish source + metadata), so there's no
 * summary/payload split like maps — the whole record is the list row.
 *
 * Built-in STARTER effects are seeded once (localStorage-flag guarded, and
 * deletion-respecting like store/seedMaps.ts) so the library is never empty.
 */

export interface StoredEffect {
  id: string;
  name: string;
  /** GLSL-ish effect source (the same string the fx_compiler compiles). */
  source: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EffectListQuery {
  search?: string;
  tags?: string[];
  sort?: "updated" | "name";
}

export interface CreateEffectInput {
  name?: string;
  source?: string;
  tags?: string[];
}

const DB_NAME = "ledmapper";
// mapStore opened this DB at version 1 with stores maps_index/maps_payload.
// Bump to 2 and add the effects store in onupgradeneeded (additive — existing
// stores are untouched). Both stores tolerate the other opening at v2.
const DB_VERSION = 2;
const STORE = "effects";

type Listener = () => void;

function uuid(): string {
  return crypto.randomUUID();
}

function normTags(tags: string[]): string[] {
  return Array.from(
    new Set(tags.map((t) => t.trim().toLowerCase().replace(/^#/, "")).filter(Boolean)),
  );
}

/** Default effect source for a blank new effect (a valid, minimal shader). */
export const BLANK_EFFECT_SOURCE = `uniform float speed : 0.0 .. 5.0 = 1.0;
uniform float width : 0.02 .. 0.5 = 0.12;
uniform vec3 tint : color = 0.2, 0.6, 1.0;

void update() {}

vec3 shade(Led led) {
  float phase = fract(led.s - time * speed);
  float band = smoothstep(width, 0.0, abs(phase - 0.5));
  return tint * band;
}
`;

function defaultName(now: string): string {
  const when = new Date(now).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Effect · ${when}`;
}

class EffectStore {
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
          if (!db.objectStoreNames.contains(STORE)) {
            const store = db.createObjectStore(STORE, { keyPath: "id" });
            store.createIndex("updatedAt", "updatedAt");
            store.createIndex("tags", "tags", { multiEntry: true });
            store.createIndex("name", "name");
          }
          // NB: the maps stores are created by mapStore's own upgrade path when
          // it opens the DB. IndexedDB runs every registered upgrade for the
          // target version, so opening from either module reaches v2 safely.
          if (!db.objectStoreNames.contains("maps_index")) {
            const s = db.createObjectStore("maps_index", { keyPath: "id" });
            s.createIndex("updatedAt", "updatedAt");
            s.createIndex("tags", "tags", { multiEntry: true });
            s.createIndex("name", "name");
          }
          if (!db.objectStoreNames.contains("maps_payload")) {
            db.createObjectStore("maps_payload", { keyPath: "id" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbp;
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => Promise<T> | T,
  ): Promise<T> {
    const db = await this.db();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction([STORE], mode);
      let result: T;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      Promise.resolve(fn(tx.objectStore(STORE)))
        .then((r) => (result = r))
        .catch(reject);
    });
  }

  private static req<T>(r: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async list(query: EffectListQuery = {}): Promise<StoredEffect[]> {
    const all = await this.tx("readonly", (s) =>
      EffectStore.req(s.getAll() as IDBRequest<StoredEffect[]>),
    );
    let out = all;
    const search = query.search?.trim().toLowerCase();
    if (search) {
      out = out.filter(
        (e) =>
          e.name.toLowerCase().includes(search) ||
          e.tags.some((t) => t.includes(search.replace(/^#/, ""))),
      );
    }
    if (query.tags && query.tags.length > 0) {
      const want = normTags(query.tags);
      out = out.filter((e) => want.every((t) => e.tags.includes(t)));
    }
    const sort = query.sort ?? "updated";
    return [...out].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      return b.updatedAt.localeCompare(a.updatedAt);
    });
  }

  async get(id: string): Promise<StoredEffect | undefined> {
    return this.tx("readonly", (s) =>
      EffectStore.req(s.get(id) as IDBRequest<StoredEffect | undefined>),
    );
  }

  async create(input: CreateEffectInput = {}): Promise<string> {
    const id = uuid();
    const now = new Date().toISOString();
    const rec: StoredEffect = {
      id,
      name: input.name?.trim() || defaultName(now),
      source: input.source ?? BLANK_EFFECT_SOURCE,
      tags: normTags(input.tags ?? []),
      createdAt: now,
      updatedAt: now,
    };
    await this.tx("readwrite", (s) => s.put(rec));
    this.emit();
    return id;
  }

  /** Create with an explicit id (used by seeding so a built-in is stable). */
  async createWithId(rec: StoredEffect): Promise<void> {
    await this.tx("readwrite", (s) => s.put(rec));
    this.emit();
  }

  private async patch(id: string, patch: Partial<StoredEffect>): Promise<void> {
    await this.tx("readwrite", async (s) => {
      const cur = await EffectStore.req(s.get(id) as IDBRequest<StoredEffect | undefined>);
      if (!cur) return;
      s.put({ ...cur, ...patch, updatedAt: new Date().toISOString() });
    });
    this.emit();
  }

  async save(id: string, source: string): Promise<void> {
    await this.patch(id, { source });
  }

  async rename(id: string, name: string): Promise<void> {
    await this.patch(id, { name });
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await this.patch(id, { tags: normTags(tags) });
  }

  async duplicate(id: string): Promise<string | undefined> {
    const rec = await this.get(id);
    if (!rec) return undefined;
    return this.create({ name: `${rec.name} (copy)`, source: rec.source, tags: rec.tags });
  }

  async delete(id: string): Promise<void> {
    await this.tx("readwrite", (s) => s.delete(id));
    this.emit();
  }
}

export const effectStore = new EffectStore();
