/**
 * Bounded, TTL'd cache of rendered effect-preview clips (FUG-80), in its own
 * IndexedDB database so it never entangles the shared `ledmapper` DB's version
 * dance (mapStore + effectStore both own that one). A record holds the .webm
 * Blob plus the id, a hash of the source it was rendered from, and a timestamp.
 *
 * Invalidation is threefold so the cache can't grow unbounded or go stale:
 *   - source hash: editing an effect re-renders (the cached clip no longer maps
 *     to the current source);
 *   - TTL: clips older than PREVIEW_TTL_MS are swept on open;
 *   - LRU cap: at most MAX_ENTRIES clips are kept, oldest evicted first.
 *
 * The policy helpers (hashSource / isExpired / selectEvictions) are pure and
 * unit-tested; the IndexedDB wrapper around them is browser-only.
 */

/** Clips expire after a week — long enough to stay warm, bounded over time. */
export const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard cap on cached clips; oldest are evicted past this. */
export const MAX_ENTRIES = 60;
/**
 * Bump when the render PIPELINE changes (not the effect source) — e.g. adding
 * the virtual-tree path — so already-cached clips rendered by the old pipeline
 * are invalidated even though their source (and thus source hash) is unchanged.
 *   v1: flat 64×64 grid only.
 *   v2: topology-aware effects render on a virtual tree.
 */
export const RENDER_VERSION = 2;

export interface PreviewRecord {
  id: string;
  hash: string;
  /**
   * The .webm as raw bytes, NOT a Blob. Some WebKit/Safari versions fail to
   * round-trip a Blob stored in IndexedDB (it reads back empty after a reload),
   * which silently defeats persistence; an ArrayBuffer always survives.
   */
  bytes: ArrayBuffer;
  createdAt: number; // epoch ms
}

/** Stable, order-independent-of-length hash of an effect's source (FNV-1a). */
export function hashSource(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

export function isExpired(createdAt: number, now: number, ttlMs = PREVIEW_TTL_MS): boolean {
  return now - createdAt >= ttlMs;
}

/**
 * The stored cache key: the source hash tagged with the render-pipeline version.
 * A clip is only reused when BOTH the source AND the pipeline that produced it
 * match, so bumping {@link RENDER_VERSION} re-renders every effect.
 */
export function cacheKey(source: string): string {
  return `${RENDER_VERSION}:${hashSource(source)}`;
}

/**
 * Given the current records (any order) and a cap, return the ids to evict:
 * everything expired, plus the oldest beyond `maxEntries` of what remains. Pure.
 */
export function selectEvictions(
  records: { id: string; createdAt: number }[],
  now: number,
  maxEntries = MAX_ENTRIES,
  ttlMs = PREVIEW_TTL_MS,
): string[] {
  const evict: string[] = [];
  const live: { id: string; createdAt: number }[] = [];
  for (const r of records) {
    if (isExpired(r.createdAt, now, ttlMs)) evict.push(r.id);
    else live.push(r);
  }
  if (live.length > maxEntries) {
    live.sort((a, b) => a.createdAt - b.createdAt); // oldest first
    for (const r of live.slice(0, live.length - maxEntries)) evict.push(r.id);
  }
  return evict;
}

const DB_NAME = "ledmapper_fxpreview";
const DB_VERSION = 1;
const STORE = "previews";

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (dbp === null) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const s = d.createObjectStore(STORE, { keyPath: "id" });
          s.createIndex("createdAt", "createdAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T> | T): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction([STORE], mode);
        let result: T;
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        Promise.resolve(fn(t.objectStore(STORE)))
          .then((r) => (result = r))
          .catch(reject);
      }),
  );
}

class PreviewCache {
  private swept = false;

  /** Delete expired + over-cap records once per session (best effort). */
  private async sweep(): Promise<void> {
    if (this.swept) return;
    this.swept = true;
    try {
      // Read only (id, createdAt) via a key cursor on the createdAt index — never
      // loads the (large) webm bytes, so the sweep stays cheap even when full.
      const meta = await tx("readonly", (s) => {
        return new Promise<{ id: string; createdAt: number }[]>((resolve, reject) => {
          const out: { id: string; createdAt: number }[] = [];
          const cur = s.index("createdAt").openKeyCursor();
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c) return resolve(out);
            out.push({ id: String(c.primaryKey), createdAt: Number(c.key) });
            c.continue();
          };
          cur.onerror = () => reject(cur.error);
        });
      });
      const evict = selectEvictions(meta, Date.now());
      if (evict.length > 0) {
        await tx("readwrite", (s) => {
          for (const id of evict) s.delete(id);
        });
      }
    } catch {
      // Cache is best-effort; a sweep failure must not break the UI.
    }
  }

  /** Cached clip for `id` iff it matches `source` and isn't expired, else null. */
  async get(id: string, source: string): Promise<Blob | null> {
    void this.sweep();
    try {
      const rec = await tx("readonly", (s) =>
        reqP(s.get(id) as IDBRequest<PreviewRecord | undefined>),
      );
      if (!rec) return null;
      if (rec.hash !== cacheKey(source)) return null; // source or pipeline changed
      if (isExpired(rec.createdAt, Date.now())) return null;
      return new Blob([rec.bytes], { type: "video/webm" });
    } catch {
      return null;
    }
  }

  async put(id: string, source: string, blob: Blob): Promise<void> {
    try {
      const bytes = await blob.arrayBuffer();
      const rec: PreviewRecord = { id, hash: cacheKey(source), bytes, createdAt: Date.now() };
      await tx("readwrite", (s) => s.put(rec));
    } catch {
      // Non-fatal: the clip is still shown this session, just not persisted.
    }
  }
}

export const previewCache = new PreviewCache();
