/**
 * CaptureBundleStore — mapping-run reproduction bundles (solver/captureBundle)
 * kept on the device until a developer exports or shares them.
 *
 * A DEDICATED IndexedDB database (`ledmapper-capturebundles`), like the chat
 * log store, so it never touches the shared `ledmapper` DB's version/upgrade
 * coordination. Two object stores: `meta` (small rows for the list UI) and
 * `bundles` (the full JSON, often a few MB — never loaded just to list).
 *
 * Bounded: the oldest bundles are pruned beyond MAX_BUNDLES or MAX_TOTAL_BYTES.
 * Everything is best-effort — a debug log must never break a capture.
 */

import { bundleBytes, type CaptureBundle } from "../solver/captureBundle";
import type { LocalizeBundle } from "../solver/localizeBundle";

/** Mapping capture bundles and room-localization bundles share the store. */
export type StoredBundle = CaptureBundle | LocalizeBundle;

const DB_NAME = "ledmapper-capturebundles";
const DB_VERSION = 1;
const META = "meta";
const BUNDLES = "bundles";
export const MAX_BUNDLES = 20;
export const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

export interface CaptureBundleMeta {
  id: string;
  createdAt: string;
  /** The run's outcome (capture bundles: RunOutcome; localization bundles: LocalizeOutcome). */
  outcome: string;
  summary: string;
  ledCount: number;
  bytes: number;
  frames: number;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

class CaptureBundleStore {
  private dbp: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (this.dbp === null) {
      this.dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains(META)) {
            db.createObjectStore(META, { keyPath: "id" }).createIndex("createdAt", "createdAt");
          }
          if (!db.objectStoreNames.contains(BUNDLES)) db.createObjectStore(BUNDLES, { keyPath: "id" });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return this.dbp;
  }

  private tx<T>(mode: IDBTransactionMode, fn: (meta: IDBObjectStore, bundles: IDBObjectStore) => Promise<T> | T): Promise<T> {
    return this.db().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction([META, BUNDLES], mode);
          let result: T;
          tx.oncomplete = () => resolve(result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
          Promise.resolve(fn(tx.objectStore(META), tx.objectStore(BUNDLES)))
            .then((r) => (result = r))
            .catch(reject);
        }),
    );
  }

  /** Persist a bundle (then prune). Returns its metadata, or null on failure. */
  async save(bundle: StoredBundle): Promise<CaptureBundleMeta | null> {
    try {
      const meta: CaptureBundleMeta = {
        id: bundle.id,
        createdAt: bundle.createdAt,
        outcome: bundle.outcome,
        summary: bundle.summary,
        ledCount: bundle.capture.ledCount,
        bytes: bundleBytes(bundle),
        frames: bundle.frames.length,
      };
      await this.tx("readwrite", (m, b) => {
        m.put(meta);
        b.put(bundle);
      });
      await this.prune();
      return meta;
    } catch (e) {
      console.warn("capture bundle not saved", e);
      return null;
    }
  }

  /** All bundles' metadata, newest first. */
  async list(): Promise<CaptureBundleMeta[]> {
    const all = await this.tx("readonly", (m) => req(m.getAll() as IDBRequest<CaptureBundleMeta[]>));
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<StoredBundle | undefined> {
    return this.tx("readonly", (_m, b) => req(b.get(id) as IDBRequest<StoredBundle | undefined>));
  }

  async delete(id: string): Promise<void> {
    await this.tx("readwrite", (m, b) => {
      m.delete(id);
      b.delete(id);
    });
  }

  async clear(): Promise<void> {
    await this.tx("readwrite", (m, b) => {
      m.clear();
      b.clear();
    });
  }

  private async prune(): Promise<void> {
    const metas = await this.list();
    const drop = pruneList(metas, MAX_BUNDLES, MAX_TOTAL_BYTES);
    if (drop.length === 0) return;
    await this.tx("readwrite", (m, b) => {
      for (const id of drop) {
        m.delete(id);
        b.delete(id);
      }
    });
  }
}

/** Ids to drop (oldest first) so at most `maxCount` bundles totalling at most
 * `maxBytes` remain. `metas` newest first; the newest is always kept. */
export function pruneList(metas: readonly CaptureBundleMeta[], maxCount: number, maxBytes: number): string[] {
  const drop: string[] = [];
  let total = 0;
  metas.forEach((m, i) => {
    total += m.bytes;
    if (i > 0 && (i >= maxCount || total > maxBytes)) drop.push(m.id);
  });
  return drop;
}

export const captureBundleStore = new CaptureBundleStore();

// Debugging-tab toggles (only consulted while debug mode is on).
const KEEP_SUCCESSFUL_KEY = "ledmapper.captureBundles.keepSuccessful";
const INCLUDE_FRAMES_KEY = "ledmapper.captureBundles.includeFrames";

function flag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function setFlag(key: string, on: boolean): void {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    /* non-fatal */
  }
}

/** Also log runs that ended fine (for comparison with failed ones). */
export const bundleKeepSuccessful = (): boolean => flag(KEEP_SUCCESSFUL_KEY);
export const setBundleKeepSuccessful = (on: boolean): void => setFlag(KEEP_SUCCESSFUL_KEY, on);
/** Include downsampled camera frames (big; the solver doesn't need them). */
export const bundleIncludeFrames = (): boolean => flag(INCLUDE_FRAMES_KEY);
export const setBundleIncludeFrames = (on: boolean): void => setFlag(INCLUDE_FRAMES_KEY, on);
