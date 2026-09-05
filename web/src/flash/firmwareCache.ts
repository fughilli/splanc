/**
 * Persistent (IndexedDB) cache of downloaded firmware flashbundles, so a released
 * firmware image can be flashed OFFLINE — the GitHub-releases source otherwise needs
 * the network for BOTH the release listing and the `.tar` download. On a fresh online
 * launch prefetchLatestFirmware() (firmwareRepo.ts) warms the latest release into this
 * cache; the flash dialog's "Manage versions" drawer lets the user download or remove
 * any other version.
 *
 * Own IndexedDB database ("ledmapper-firmware") so it never entangles the shared app
 * DB's version dance (same isolation rationale as store/previewCache.ts). Two stores:
 *   - "bundles": key = entry id ("<tag>::<variant>") → the `.tar` bytes (stored as an
 *     ArrayBuffer, NOT a Blob — some WebKit/Safari builds read a Blob back empty from
 *     IndexedDB, per previewCache) plus the FirmwareEntry metadata, a `pinned` flag,
 *     and a timestamp.
 *   - "meta": the last-fetched release FirmwareIndex, so the version list still renders
 *     offline (marking which entries are actually cached = flashable).
 *
 * Eviction keeps every PINNED bundle (a version the user explicitly downloaded) plus
 * the most-recent UNPINNED_CAP auto-prefetched ones; older auto-prefetched bundles are
 * LRU-evicted so the cache can't grow unbounded. selectEvictions is pure + unit-tested.
 *
 * Every browser call degrades gracefully (no-op / null) if IndexedDB is unavailable or
 * errors, so a caching failure can never break flashing.
 */

import type { FirmwareEntry, FirmwareIndex } from "./manifest";

const DB_NAME = "ledmapper-firmware";
const DB_VERSION = 1;
const BUNDLES = "bundles";
const META = "meta";
const INDEX_KEY = "release-index";

/** Keep the newest this-many auto-prefetched (unpinned) bundles; evict older ones. */
export const UNPINNED_CAP = 6;

/** A cached flashbundle: the `.tar` bytes plus the metadata needed to flash + list it. */
export interface CachedBundle {
  /** entry.id — "<tag>::<variant>". */
  id: string;
  /** The full FirmwareEntry (label / version / commit / chip / family / manifest / tarUrl). */
  entry: FirmwareEntry;
  /** The raw `.tar` asset bytes. */
  bytes: ArrayBuffer;
  size: number;
  /** true = user explicitly downloaded it (never auto-evicted); false = auto-prefetched. */
  pinned: boolean;
  cachedAt: number; // epoch ms
}

/** Listing view of a cached bundle — everything but the (large) bytes. */
export type CachedBundleMeta = Omit<CachedBundle, "bytes">;

// --- pure policy (unit-tested) ---------------------------------------------

/**
 * Given the cached bundles, return the ids to EVICT: keep every pinned bundle and the
 * newest `cap` unpinned ones (by cachedAt); the remaining (oldest unpinned) are evicted.
 */
export function selectEvictions(
  records: readonly { id: string; pinned: boolean; cachedAt: number }[],
  cap: number = UNPINNED_CAP,
): string[] {
  const unpinned = records.filter((r) => !r.pinned).slice().sort((a, b) => b.cachedAt - a.cachedAt);
  return unpinned.slice(cap).map((r) => r.id);
}

/** The release tag embedded in an entry id ("firmware-v1.2.0::netstack" → "firmware-v1.2.0"). */
export function tagOfId(id: string): string {
  const i = id.indexOf("::");
  return i >= 0 ? id.slice(0, i) : id;
}

// --- IndexedDB wrapper (browser only) --------------------------------------

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("no IndexedDB"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(BUNDLES)) db.createObjectStore(BUNDLES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `fn` against a store in a transaction, resolving with its request result. */
function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        let result: T;
        const req = fn(t.objectStore(store));
        req.onsuccess = () => {
          result = req.result;
        };
        req.onerror = () => reject(req.error);
        t.oncomplete = () => {
          db.close();
          resolve(result);
        };
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

/** Store a bundle (overwrites an existing id), then sweep old auto-prefetched ones. */
export async function putBundle(bundle: CachedBundle): Promise<void> {
  try {
    await run(BUNDLES, "readwrite", (s) => s.put(bundle));
    await evictOld();
  } catch {
    /* caching is best-effort — a failure here must never break flashing */
  }
}

/** The cached `.tar` bytes for an entry id, or null if not cached / unavailable. */
export async function getBundleBytes(id: string): Promise<Uint8Array | null> {
  try {
    const rec = (await run<CachedBundle | undefined>(BUNDLES, "readonly", (s) => s.get(id))) ?? null;
    return rec ? new Uint8Array(rec.bytes) : null;
  } catch {
    return null;
  }
}

/** All cached bundles' metadata (no bytes), newest-first. */
export async function listBundles(): Promise<CachedBundleMeta[]> {
  try {
    const all = (await run<CachedBundle[]>(BUNDLES, "readonly", (s) => s.getAll())) ?? [];
    return all
      .map((b): CachedBundleMeta => ({ id: b.id, entry: b.entry, size: b.size, pinned: b.pinned, cachedAt: b.cachedAt }))
      .sort((a, b) => b.cachedAt - a.cachedAt);
  } catch {
    return [];
  }
}

/** The set of entry ids currently cached (for marking the picker / drawer). */
export async function cachedIds(): Promise<Set<string>> {
  try {
    const keys = (await run<IDBValidKey[]>(BUNDLES, "readonly", (s) => s.getAllKeys())) ?? [];
    return new Set(keys.map((k) => String(k)));
  } catch {
    return new Set();
  }
}

/** Remove a cached bundle (drawer "Remove"). */
export async function deleteBundle(id: string): Promise<void> {
  try {
    await run(BUNDLES, "readwrite", (s) => s.delete(id));
  } catch {
    /* best-effort */
  }
}

/** Sweep old auto-prefetched bundles past the cap (keeps pinned + newest unpinned). */
async function evictOld(): Promise<void> {
  try {
    const all = (await run<CachedBundle[]>(BUNDLES, "readonly", (s) => s.getAll())) ?? [];
    for (const id of selectEvictions(all)) await deleteBundle(id);
  } catch {
    /* best-effort */
  }
}

/** Persist the last-fetched release index so the version list renders offline. */
export async function putReleaseIndex(index: FirmwareIndex): Promise<void> {
  try {
    await run(META, "readwrite", (s) => s.put({ index, fetchedAt: Date.now() }, INDEX_KEY));
  } catch {
    /* best-effort */
  }
}

/** The last-cached release index (offline fallback), or null. */
export async function getReleaseIndex(): Promise<FirmwareIndex | null> {
  try {
    const rec = (await run<{ index: FirmwareIndex } | undefined>(META, "readonly", (s) => s.get(INDEX_KEY))) ?? null;
    return rec?.index ?? null;
  } catch {
    return null;
  }
}
