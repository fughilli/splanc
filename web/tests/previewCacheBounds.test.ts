/**
 * Storage bound of the effect-preview clip cache (FUG-80; src/store/
 * previewCache.ts). Rendered 64×64 preview clips persist in their own IndexedDB
 * database so tiles replay instead of re-rendering — and the cache must not grow
 * without bound or serve stale clips. The existing previewCache suite pins the
 * pure policy helpers; this one drives the REAL `previewCache` store over a
 * minimal in-memory IndexedDB (below) and pins the enforcement:
 *
 *   - the first access of a session sweeps the store: expired clips (7-day TTL)
 *     and everything beyond the newest 60 are deleted, reading only keys (via
 *     the createdAt index) — never the clip bytes;
 *   - a clip is stored as raw bytes (an ArrayBuffer, which survives WebKit's
 *     IndexedDB) under a key tagged with the render-pipeline version, and served
 *     back only for the same source, the same pipeline, and within the TTL.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  previewCache,
  cacheKey,
  hashSource,
  MAX_ENTRIES,
  PREVIEW_TTL_MS,
  RENDER_VERSION,
  type PreviewRecord,
} from "../src/store/previewCache";

// -- a minimal IndexedDB: one database, object stores with a keyPath, key cursors ---

type Rec = Record<string, unknown>;
interface StoreData {
  keyPath: string;
  indexes: Map<string, string>;
  records: Map<string, Rec>;
}

class FakeRequest<T> {
  result!: T;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

const idb = {
  stores: new Map<string, StoreData>(),
  opened: [] as string[],
  /** Record VALUES read (get / value cursors). Key cursors don't count. */
  valueReads: 0,
};

class FakeTransaction {
  private pending = 0;
  private done = false;
  oncomplete: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  error: unknown = null;
  constructor() {
    this.settleLater(); // a transaction with no requests still completes
  }
  objectStore(name: string): FakeStore {
    return new FakeStore(this, idb.stores.get(name)!);
  }
  /** Run `work` as one async request step (re-using `req`, like a cursor does). */
  step<T>(req: FakeRequest<T>, work: () => T): FakeRequest<T> {
    this.pending++;
    setImmediate(() => {
      req.result = work();
      this.pending--;
      req.onsuccess?.();
      this.settleLater();
    });
    return req;
  }
  private settleLater(): void {
    setImmediate(() => {
      if (this.pending === 0 && !this.done) {
        this.done = true;
        this.oncomplete?.();
      }
    });
  }
}

type FakeCursor = { key: unknown; primaryKey: unknown; value?: Rec; continue(): void } | null;

class FakeStore {
  constructor(
    private readonly tx: FakeTransaction,
    private readonly data: StoreData,
  ) {}
  get(key: string): FakeRequest<Rec | undefined> {
    return this.tx.step(new FakeRequest<Rec | undefined>(), () => {
      const r = this.data.records.get(key);
      if (r) idb.valueReads++;
      return r ? structuredClone(r) : undefined;
    });
  }
  put(value: Rec): FakeRequest<unknown> {
    return this.tx.step(new FakeRequest<unknown>(), () => {
      this.data.records.set(String(value[this.data.keyPath]), structuredClone(value));
      return value[this.data.keyPath];
    });
  }
  delete(key: string): FakeRequest<undefined> {
    return this.tx.step(new FakeRequest<undefined>(), () => void this.data.records.delete(key));
  }
  index(name: string): { openKeyCursor(): FakeRequest<FakeCursor>; openCursor(): FakeRequest<FakeCursor> } {
    const keyPath = this.data.indexes.get(name)!;
    const cursor = (withValues: boolean): FakeRequest<FakeCursor> => {
      const rows = [...this.data.records.values()].sort((a, b) => Number(a[keyPath]) - Number(b[keyPath]));
      const req = new FakeRequest<FakeCursor>();
      let i = 0;
      const next = (): void => {
        this.tx.step(req, () => {
          const row = rows[i];
          if (!row) return null;
          if (withValues) idb.valueReads++;
          return {
            key: row[keyPath],
            primaryKey: row[this.data.keyPath],
            ...(withValues ? { value: structuredClone(row) } : {}),
            continue: () => {
              i++;
              next();
            },
          };
        });
      };
      next();
      return req;
    };
    return { openKeyCursor: () => cursor(false), openCursor: () => cursor(true) };
  }
}

const fakeDb = {
  objectStoreNames: { contains: (n: string) => idb.stores.has(n) },
  createObjectStore(name: string, opts: { keyPath: string }) {
    const data: StoreData = { keyPath: opts.keyPath, indexes: new Map(), records: new Map() };
    idb.stores.set(name, data);
    return { createIndex: (index: string, keyPath: string) => void data.indexes.set(index, keyPath) };
  },
  transaction: () => new FakeTransaction(),
};

(globalThis as Record<string, unknown>)["indexedDB"] = {
  open(name: string): FakeRequest<typeof fakeDb> {
    idb.opened.push(name);
    const req = new FakeRequest<typeof fakeDb>();
    setImmediate(() => {
      req.result = fakeDb;
      if (!idb.stores.has("previews")) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

/** Seed the store as a previous session left it (bypassing the cache API). */
function seed(records: PreviewRecord[]): void {
  fakeDb.createObjectStore("previews", { keyPath: "id" }).createIndex("createdAt", "createdAt");
  const data = idb.stores.get("previews")!;
  for (const r of records) data.records.set(r.id, r as unknown as Rec);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 400; i++) await new Promise<void>((r) => setImmediate(r));
}

const HOUR = 60 * 60 * 1000;
const clip = (n: number): ArrayBuffer => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, n]).buffer;

test("the first access of a session sweeps expired clips and caps the cache at the newest 60 [rr:PR-33]", async () => {
  // Start a fresh "session" whatever ran before: re-arm the store's one-time
  // sweep (a private flag on the singleton) and zero the read counter, so the
  // case does not depend on running first.
  (previewCache as unknown as { swept: boolean }).swept = false;
  idb.valueReads = 0;
  const now = Date.now();
  const records: PreviewRecord[] = [];
  // 5 clips past the 7-day TTL, then 65 fresh ones (an hour apart, oldest first).
  for (let i = 0; i < 5; i++) records.push({ id: `stale-${i}`, hash: "x", bytes: clip(i), createdAt: now - PREVIEW_TTL_MS - (i + 1) * HOUR });
  for (let i = 0; i < 65; i++) records.push({ id: `fx-${i}`, hash: "x", bytes: clip(i), createdAt: now - (65 - i) * HOUR });
  seed(records);

  assert.equal(await previewCache.get("fx-64", "any source"), null);
  await settle();

  assert.deepEqual(idb.opened, ["ledmapper_fxpreview"], "its own database, not the shared app DB");
  const kept = [...idb.stores.get("previews")!.records.keys()].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  assert.equal(kept.length, MAX_ENTRIES);
  assert.ok(kept.every((id) => id.startsWith("fx-")), "every expired clip evicted");
  assert.deepEqual(kept.slice(0, 2), ["fx-5", "fx-6"], "the 5 oldest fresh clips evicted first");
  assert.equal(kept.at(-1), "fx-64");
  // The sweep walked keys only: the single record value read was the lookup itself.
  assert.equal(idb.valueReads, 1);
});

test("a clip is stored as raw bytes and served only for the same source, pipeline and TTL [rr:PR-33]", async () => {
  const SRC = "vec3 shade(Led l) { return vec3(l.uv, 0.0); }";
  const blob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 7, 7])], { type: "video/webm" });
  await previewCache.put("fx-new", SRC, blob);
  await settle();

  const stored = idb.stores.get("previews")!.records.get("fx-new") as unknown as PreviewRecord;
  assert.ok(stored.bytes instanceof ArrayBuffer, "bytes, not a Blob (WebKit drops Blobs from IndexedDB)");
  assert.deepEqual([...new Uint8Array(stored.bytes)], [0x1a, 0x45, 0xdf, 0xa3, 7, 7]);
  assert.equal(stored.hash, `${RENDER_VERSION}:${hashSource(SRC)}`);
  assert.ok(Math.abs(stored.createdAt - Date.now()) < HOUR);

  // Same source + pipeline: replayed (no re-render).
  const hit = await previewCache.get("fx-new", SRC);
  assert.ok(hit);
  assert.equal(hit.type, "video/webm");
  assert.deepEqual([...new Uint8Array(await hit.arrayBuffer())], [0x1a, 0x45, 0xdf, 0xa3, 7, 7]);
  // Edited source: stale → re-render.
  assert.equal(await previewCache.get("fx-new", `${SRC} // tweaked`), null);

  // A clip from an older render pipeline (same source) is not reused.
  const data = idb.stores.get("previews")!.records;
  data.set("fx-old", { id: "fx-old", hash: `${RENDER_VERSION - 1}:${hashSource(SRC)}`, bytes: clip(1), createdAt: Date.now() });
  assert.equal(await previewCache.get("fx-old", SRC), null);
  // Past the TTL: not served, even between sweeps.
  data.set("fx-expired", { id: "fx-expired", hash: cacheKey(SRC), bytes: clip(2), createdAt: Date.now() - PREVIEW_TTL_MS - HOUR });
  assert.equal(await previewCache.get("fx-expired", SRC), null);
  // Fresh and current: served.
  data.set("fx-ok", { id: "fx-ok", hash: cacheKey(SRC), bytes: clip(3), createdAt: Date.now() - HOUR });
  assert.ok(await previewCache.get("fx-ok", SRC));
});
