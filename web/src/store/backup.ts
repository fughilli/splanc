/**
 * Back up and restore the whole app as one file: the effect and map libraries,
 * measured device profiles, AI chat logs, settings and known fixtures, plus
 * (optionally) capture recordings and API keys. It's how a library moves to
 * another phone or browser until there's a cloud account.
 *
 * Import merges: records are added, and where both sides have a record (same
 * id) the newer one (updatedAt) wins; a map's or capture's payload follows its
 * index entry. Settings in the file overwrite this app's. The app reloads after
 * an import so every store re-reads its data.
 *
 * Caches (firmware downloads, effect preview thumbnails) are left out: they
 * rebuild themselves. The file format and merge rules are in backupFormat.ts.
 */

import { appBuildInfo } from "../buildInfo";
import { captureBundleStore } from "./captureBundleStore";
import { chatLogStore } from "./chatLogStore";
import { costTableStore } from "./costTableStore";
import { effectStore } from "./effectStore";
import { mapStore } from "./mapStore";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  decodeValue,
  encodeValue,
  exportLocalStorage,
  importLocalStorage,
  keepLocal,
  parseBackup,
  type BackupFile,
  type BackupRecord,
} from "./backupFormat";

interface DbSpec {
  name: string;
  /** Stores in import order; `follows` stores take their index store's verdict. */
  stores: { name: string; follows?: string }[];
  captures?: boolean;
  /** Open the DB through its own store module (creates/upgrades its schema). */
  ensure: () => Promise<unknown>;
}

const DBS: DbSpec[] = [
  {
    name: "ledmapper",
    stores: [{ name: "effects" }, { name: "maps_index" }, { name: "maps_payload", follows: "maps_index" }],
    ensure: () => Promise.all([effectStore.list(), mapStore.list()]),
  },
  { name: "ledmapper-perf", stores: [{ name: "cost_tables" }], ensure: () => costTableStore.list() },
  { name: "ledmapper-chatlog", stores: [{ name: "sessions" }], ensure: () => chatLogStore.list() },
  {
    name: "ledmapper-capturebundles",
    stores: [{ name: "meta" }, { name: "bundles", follows: "meta" }],
    captures: true,
    ensure: () => captureBundleStore.list(),
  },
];

export interface ExportOptions {
  /** Include API keys and bridge/kiosk credentials. */
  secrets: boolean;
  /** Include capture recordings (can be large). */
  captures: boolean;
}

export interface BuiltBackup {
  bytes: Uint8Array;
  name: string;
  mime: string;
  counts: Record<string, number>;
}

/** Open an existing DB at its current version; null when it doesn't exist. */
function openExisting(name: string): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(name);
    req.onupgradeneeded = () => {
      // No such DB: don't leave an empty one behind for its store to trip on.
      req.transaction?.abort();
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function dumpStore(db: IDBDatabase, store: string): Promise<BackupRecord[]> {
  if (!db.objectStoreNames.contains(store)) return [];
  const tx = db.transaction(store, "readonly");
  const s = tx.objectStore(store);
  const [values, keys] = await Promise.all([reqP(s.getAll()), s.keyPath === null ? reqP(s.getAllKeys()) : null]);
  const out: BackupRecord[] = [];
  for (let i = 0; i < values.length; i++) {
    const rec: BackupRecord = { value: await encodeValue(values[i]) };
    if (keys) rec.key = await encodeValue(keys[i]);
    out.push(rec);
  }
  return out;
}

/** Build the backup file. */
export async function buildBackup(opts: ExportOptions): Promise<BuiltBackup> {
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    app: { ...appInfo(), origin: location.origin },
    includes: { secrets: opts.secrets, captures: opts.captures },
    localStorage: exportLocalStorage(localStorageEntries(), opts.secrets),
    idb: {},
  };
  const counts: Record<string, number> = {};
  for (const spec of DBS) {
    if (spec.captures && !opts.captures) continue;
    const db = await openExisting(spec.name);
    if (!db) continue;
    try {
      const stores: Record<string, BackupRecord[]> = {};
      for (const { name } of spec.stores) {
        stores[name] = await dumpStore(db, name);
        counts[name] = stores[name].length;
      }
      file.idb[spec.name] = stores;
    } finally {
      db.close();
    }
  }
  const json = new TextEncoder().encode(JSON.stringify(file));
  const day = file.createdAt.slice(0, 10);
  const gz = await gzip(json);
  return gz
    ? { bytes: gz, name: `splanc-backup-${day}.json.gz`, mime: "application/gzip", counts }
    : { bytes: json, name: `splanc-backup-${day}.json`, mime: "application/json", counts };
}

/** Read a backup file (gzipped or plain JSON). */
export async function readBackup(bytes: Uint8Array): Promise<BackupFile> {
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const text = new TextDecoder().decode(isGzip ? await gunzip(bytes) : bytes);
  return parseBackup(text);
}

export interface ImportResult {
  added: number;
  updated: number;
  kept: number;
  settings: number;
}

/** Merge a backup into this app. The caller reloads the app afterwards. */
export async function importBackup(file: BackupFile): Promise<ImportResult> {
  const result: ImportResult = { added: 0, updated: 0, kept: 0, settings: 0 };
  for (const spec of DBS) {
    const stores = file.idb[spec.name];
    if (!stores) continue;
    await spec.ensure();
    const db = await openExisting(spec.name);
    if (!db) continue;
    try {
      // Ids whose local copy was kept, per index store, for its payload store.
      const keptIds = new Map<string, Set<string>>();
      for (const { name, follows } of spec.stores) {
        const recs = stores[name];
        if (!recs || !db.objectStoreNames.contains(name)) continue;
        const kept = new Set<string>();
        keptIds.set(name, kept);
        const skip = follows ? keptIds.get(follows) : undefined;
        const tx = db.transaction(name, "readwrite");
        const s = tx.objectStore(name);
        const done = new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        });
        for (const rec of recs) {
          const value = decodeValue(rec.value);
          const key = rec.key === undefined ? undefined : (decodeValue(rec.key) as IDBValidKey);
          const id = key ?? keyOf(s, value);
          if (id === undefined) continue;
          const local = (await reqP(s.get(id))) as unknown;
          if (skip?.has(String(id)) || (local !== undefined && keepLocal(local, value))) {
            kept.add(String(id));
            if (!follows) result.kept++;
            continue;
          }
          await reqP(key === undefined ? s.put(value) : s.put(value, key));
          if (!follows) {
            if (local === undefined) result.added++;
            else result.updated++;
          }
        }
        await done;
      }
    } finally {
      db.close();
    }
  }
  for (const [k, v] of importLocalStorage(file.localStorage, (k) => localStorage.getItem(k))) {
    try {
      localStorage.setItem(k, v);
      result.settings++;
    } catch {
      // Storage full: the libraries are in; a setting is skipped.
    }
  }
  return result;
}

function keyOf(s: IDBObjectStore, value: unknown): IDBValidKey | undefined {
  const kp = s.keyPath;
  if (typeof kp !== "string" || !value || typeof value !== "object") return undefined;
  const v = (value as Record<string, unknown>)[kp];
  return typeof v === "string" || typeof v === "number" ? v : undefined;
}

function localStorageEntries(): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k === null) continue;
    const v = localStorage.getItem(k);
    if (v !== null) out.push([k, v]);
  }
  return out;
}

export function appInfo(): { version?: string; commit?: string } {
  const out: { version?: string; commit?: string } = {};
  if (appBuildInfo.version) out.version = appBuildInfo.version;
  if (appBuildInfo.gitCommit) out.commit = appBuildInfo.gitCommit;
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  const out = await gzipBlob(new Blob([bytes as unknown as BlobPart]));
  return out ? new Uint8Array(await out.arrayBuffer()) : null;
}

/** Gzip a Blob by streaming it (its parts are never joined into one string),
 * or null when the browser can't compress. */
export async function gzipBlob(blob: Blob, type = "application/gzip"): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined") return null;
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).arrayBuffer()], { type });
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser can't open compressed backups. Try Chrome or Safari.");
  }
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
