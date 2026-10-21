/**
 * A minimal in-memory IndexedDB for the map library (src/store/mapStore.ts):
 * open (+ upgrade), object stores keyed by keyPath, get / getAll / put / delete,
 * and transactions that complete once their requests have drained. Requests
 * settle on setImmediate, which node:test's mock.timers leaves alone. Indexes
 * are accepted but not queried (mapStore sorts in memory).
 */

type Rec = Record<string, unknown>;

class FakeRequest<T> {
  result: T | undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

export interface FakeIdb {
  stores: Map<string, { keyPath: string; records: Map<string, Rec> }>;
  /** Drop every record (the DB itself stays open in the store singletons). */
  clear(): void;
}

export function installFakeIndexedDb(): FakeIdb {
  const idb: FakeIdb = {
    stores: new Map(),
    clear: () => {
      for (const s of idb.stores.values()) s.records.clear();
    },
  };

  function transaction(): unknown {
    let pending = 0;
    const tx = {
      error: null as unknown,
      oncomplete: null as (() => void) | null,
      onerror: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore(name: string) {
        const data = idb.stores.get(name);
        if (!data) throw new Error(`no object store ${name}`);
        const issue = <T>(fn: () => T): FakeRequest<T> => {
          const req = new FakeRequest<T>();
          pending++;
          setImmediate(() => {
            pending--;
            req.result = fn();
            req.onsuccess?.();
          });
          return req;
        };
        return {
          get: (key: string) => issue(() => structuredClone(data.records.get(key))),
          getAll: () => issue(() => [...data.records.values()].map((r) => structuredClone(r))),
          put: (v: Rec) => issue(() => void data.records.set(String(v[data.keyPath]), structuredClone(v))),
          delete: (key: string) => issue(() => void data.records.delete(key)),
        };
      },
    };
    // Auto-commit once nothing has been pending for a few turns (a real
    // transaction commits when its request queue drains).
    let idle = 0;
    const check = (): void => {
      if (pending > 0) idle = 0;
      else if (++idle >= 3) {
        tx.oncomplete?.();
        return;
      }
      setImmediate(check);
    };
    setImmediate(check);
    return tx;
  }

  const db = {
    objectStoreNames: { contains: (n: string) => idb.stores.has(n) },
    createObjectStore(name: string, opts: { keyPath: string }) {
      idb.stores.set(name, { keyPath: opts.keyPath, records: new Map() });
      return { createIndex: () => undefined };
    },
    transaction,
  };

  (globalThis as Record<string, unknown>)["indexedDB"] = {
    open(): FakeRequest<typeof db> {
      const req = new FakeRequest<typeof db>();
      setImmediate(() => {
        req.result = db;
        req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
  };
  return idb;
}
