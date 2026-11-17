/**
 * App event log — the browser side (store/appLog.ts is the pure core).
 *
 * Records, into a bounded ring buffer persisted to its own IndexedDB database
 * (`ledmapper-applog`, so it never joins the shared `ledmapper` DB's version
 * coordination — like chatLogStore):
 *   - uncaught errors (window "error") and unhandled promise rejections;
 *   - every toast (kit toast() calls {@link logToast});
 *   - connection / session state transitions (ui/app/state.ts), with the device
 *     as an opaque id — never its name, MAC or address;
 *   - failed fetches (a rejection, or a non-2xx/3xx status): URL origin + path
 *     only, and the status / error.
 * Settings ▸ Debugging's diagnostics export ships it as the "applog" category.
 *
 * Logging never throws and never changes behaviour: the fetch wrapper returns
 * the original response / rethrows the original error.
 */

import { AppLogBuffer, errorText, logUrl, type AppLogEntry, type AppLogKind } from "./appLog";

const DB_NAME = "ledmapper-applog";
const DB_VERSION = 1;
const STORE = "log";
/** The single record holding the buffer. */
export const APPLOG_RECORD_ID = "applog";
const PERSIST_DEBOUNCE_MS = 2000;

/** The persisted record (also the diagnostics item). */
export interface AppLogRecord {
  id: typeof APPLOG_RECORD_ID;
  updatedAt: string;
  userAgent: string;
  entries: AppLogEntry[];
}

const buffer = new AppLogBuffer();
let dbp: Promise<IDBDatabase> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let installed = false;
let restored: Promise<void> | null = null;

function db(): Promise<IDBDatabase> {
  if (dbp === null) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => (dbp = null));
  }
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = d.transaction([STORE], mode);
        let r: IDBRequest<T> | void;
        t.oncomplete = () => resolve(r ? r.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
        r = fn(t.objectStore(STORE));
      }),
  );
}

function record(): AppLogRecord {
  return {
    id: APPLOG_RECORD_ID,
    updatedAt: new Date().toISOString(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    entries: buffer.list(),
  };
}

async function persistNow(): Promise<void> {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    if (restored) await restored;
    const rec = record();
    await tx("readwrite", (s) => void s.put(rec));
  } catch {
    /* best effort */
  }
}

function schedulePersist(): void {
  if (typeof indexedDB === "undefined" || persistTimer !== null) return;
  persistTimer = setTimeout(() => void persistNow(), PERSIST_DEBOUNCE_MS);
  // Never keep a (test) process alive just to persist the log.
  (persistTimer as { unref?: () => void }).unref?.();
}

let knownSource: (() => Readonly<Record<string, string>>) | null = null;

/** Register where the strings to mask come from (ui/app/state.ts: every known
 * device's name, host and URL → its opaque id), applied to every entry —
 * toasts and errors name devices too. */
export function setAppLogRedaction(src: () => Readonly<Record<string, string>>): void {
  knownSource = src;
}

/** Record one event. `known` adds strings to mask (→ their replacement). Never throws. */
export function logEvent(
  kind: AppLogKind,
  msg: unknown,
  data?: Record<string, unknown>,
  known?: Readonly<Record<string, string>>,
): void {
  try {
    let k: Record<string, string> = {};
    try {
      k = { ...(knownSource?.() ?? {}) };
    } catch {
      /* no masks */
    }
    if (known) Object.assign(k, known);
    if (buffer.add(kind, msg, data, { known: k })) schedulePersist();
  } catch {
    /* never */
  }
}

/** kit toast() → the log. */
export function logToast(message: string, error: boolean): void {
  logEvent("toast", message, error ? { error: true } : undefined);
}

/** Wrap window.fetch so failures are logged; behaviour is unchanged. */
function patchFetch(): void {
  const orig = globalThis.fetch;
  if (typeof orig !== "function") return;
  const base = typeof location !== "undefined" ? location.href : undefined;
  const urlOf = (input: RequestInfo | URL): string => {
    try {
      return typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    } catch {
      return "";
    }
  };
  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const p = orig.call(this ?? globalThis, input, init) as Promise<Response>;
    try {
      const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")) || "GET";
      p.then(
        (res) => {
          if (!res.ok && res.type !== "opaque" && res.status !== 0) {
            logEvent("fetch", `${method} ${logUrl(urlOf(input), base)} → ${res.status}`, { status: res.status });
          }
        },
        (e: unknown) => {
          if (e instanceof DOMException && e.name === "AbortError") return; // a cancel, not a failure
          logEvent("fetch", `${method} ${logUrl(urlOf(input), base)} failed: ${errorText(e)}`);
        },
      );
    } catch {
      /* never change behaviour */
    }
    return p;
  };
  globalThis.fetch = wrapped as typeof fetch;
}

/** Start logging (call once, early in boot): window error hooks, the fetch
 * wrapper, and the restore of the persisted log. */
export function installAppLog(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  try {
    window.addEventListener("error", (ev: ErrorEvent) => {
      const where = ev.filename ? ` (${logUrl(ev.filename)}:${ev.lineno}:${ev.colno})` : "";
      logEvent("error", `${ev.error ? errorText(ev.error) : ev.message}${where}`);
    });
    window.addEventListener("unhandledrejection", (ev: PromiseRejectionEvent) => {
      logEvent("rejection", errorText(ev.reason));
    });
    // Flush when the page goes away (a debounce would lose the last events).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void persistNow();
    });
    window.addEventListener("pagehide", () => void persistNow());
    patchFetch();
    if (typeof indexedDB !== "undefined") {
      restored = tx<AppLogRecord | undefined>("readonly", (s) => s.get(APPLOG_RECORD_ID) as IDBRequest<AppLogRecord | undefined>)
        .then((rec) => {
          if (rec && Array.isArray(rec.entries)) buffer.restore(rec.entries);
        })
        .catch(() => undefined);
    }
    logEvent("info", "app started", { visibility: document.visibilityState });
  } catch {
    /* never */
  }
}

/** The log for the diagnostics export: one record (empty list when nothing was
 * logged). Includes the live, not-yet-persisted entries. */
export async function appLogRecords(): Promise<AppLogRecord[]> {
  if (restored) await restored;
  return buffer.size > 0 ? [record()] : [];
}

export async function clearAppLog(): Promise<void> {
  buffer.clear();
  try {
    await tx("readwrite", (s) => void s.clear());
  } catch {
    /* best effort */
  }
}
