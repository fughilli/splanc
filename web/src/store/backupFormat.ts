/**
 * The app backup file (store/backup.ts): its JSON shape, the value encoding that
 * carries IndexedDB records (Blobs, typed arrays, Dates…) through JSON, and the
 * pure merge rules. No DOM or IndexedDB here, so tests drive it directly.
 *
 * File (gzipped JSON when the browser can compress):
 *   { format: "splanc-backup", version: 1, createdAt, app, includes,
 *     localStorage: { key: value },
 *     idb: { db: { store: [ { key?, value } ] } } }
 * `key` is present only for stores with out-of-line keys.
 */

export const BACKUP_FORMAT = "splanc-backup";
export const BACKUP_VERSION = 1;

export interface BackupRecord {
  key?: unknown;
  value: unknown;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  app: { version?: string; commit?: string; origin?: string };
  includes: { secrets: boolean; captures: boolean };
  localStorage: Record<string, string>;
  idb: Record<string, Record<string, BackupRecord[]>>;
}

// -- secrets -------------------------------------------------------------------

/** localStorage keys that hold only credentials: left out unless asked for. */
export const SECRET_KEYS = new Set([
  "ledmapper.anthropicKey", // legacy single AI key
  "splanc.bridge.v1", // bridge live-control credentials
  "splanc.kioskSecrets.v1", // kiosk owner secrets
]);

/** localStorage keys whose JSON value carries API keys in `key` fields. */
export const KEYED_CONFIGS = new Set(["ledmapper.ai.config"]);

/** Blank every string `key` field (the AI provider config's API keys). */
export function stripKeys(json: string): string {
  try {
    return JSON.stringify(walkKeys(JSON.parse(json), () => ""));
  } catch {
    return json;
  }
}

/** Merge an imported keyed config over the local one: a blank imported key never
 * replaces a key this app already has (a backup made without secrets). */
export function mergeKeyed(imported: string, local: string | null): string {
  if (!local) return imported;
  try {
    const mine = JSON.parse(local) as unknown;
    return JSON.stringify(
      walkKeys(JSON.parse(imported), (v, path) => (v === "" ? (lookup(mine, path) ?? "") : v)),
    );
  } catch {
    return imported;
  }
}

function walkKeys(v: unknown, f: (v: string, path: string[]) => string, path: string[] = []): unknown {
  if (Array.isArray(v)) return v.map((x, i) => walkKeys(x, f, [...path, String(i)]));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = k === "key" && typeof x === "string" ? f(x, [...path, k]) : walkKeys(x, f, [...path, k]);
    }
    return out;
  }
  return v;
}

function lookup(v: unknown, path: string[]): string | undefined {
  let cur = v;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === "string" && cur !== "" ? cur : undefined;
}

/** The localStorage entries to export. */
export function exportLocalStorage(entries: Iterable<[string, string]>, secrets: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!secrets && SECRET_KEYS.has(k)) continue;
    out[k] = !secrets && KEYED_CONFIGS.has(k) ? stripKeys(v) : v;
  }
  return out;
}

/** The localStorage writes an import makes, given the current values. */
export function importLocalStorage(
  imported: Record<string, string>,
  current: (k: string) => string | null,
): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(imported)) {
    if (typeof v !== "string") continue;
    out.push([k, KEYED_CONFIGS.has(k) ? mergeKeyed(v, current(k)) : v]);
  }
  return out;
}

// -- records -------------------------------------------------------------------

/** Keep the local copy of a record when it is strictly newer (by updatedAt). */
export function keepLocal(local: unknown, imported: unknown): boolean {
  const at = (r: unknown): string | undefined => {
    const v = r && typeof r === "object" ? (r as { updatedAt?: unknown }).updatedAt : undefined;
    return typeof v === "string" ? v : undefined;
  };
  const a = at(local);
  const b = at(imported);
  return a !== undefined && b !== undefined && a > b;
}

// -- value encoding ------------------------------------------------------------

const TAG = "$b";

type ViewCtor = { new (buf: ArrayBuffer, off?: number, len?: number): ArrayBufferView };
const VIEWS: Record<string, ViewCtor> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView,
} as unknown as Record<string, ViewCtor>;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** A structured-clone value as plain JSON (Blobs are read, so it's async). */
export async function encodeValue(v: unknown): Promise<unknown> {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : { [TAG]: "num", v: String(v) };
  if (typeof v === "bigint") return { [TAG]: "bigint", v: v.toString() };
  if (typeof v === "undefined") return { [TAG]: "undef" };
  if (typeof Blob !== "undefined" && v instanceof Blob) {
    return { [TAG]: "blob", type: v.type, data: toBase64(new Uint8Array(await v.arrayBuffer())) };
  }
  if (v instanceof ArrayBuffer) return { [TAG]: "ab", data: toBase64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return { [TAG]: v.constructor.name, data: toBase64(bytes) };
  }
  if (v instanceof Date) return { [TAG]: "date", v: v.toISOString() };
  if (v instanceof Map) {
    const entries: unknown[] = [];
    for (const [k, x] of v) entries.push([await encodeValue(k), await encodeValue(x)]);
    return { [TAG]: "map", v: entries };
  }
  if (v instanceof Set) {
    const values: unknown[] = [];
    for (const x of v) values.push(await encodeValue(x));
    return { [TAG]: "set", v: values };
  }
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) out.push(await encodeValue(x));
    return out;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = await encodeValue(x);
    // An object that happens to have a "$b" field is wrapped so it isn't decoded.
    return TAG in out ? { [TAG]: "obj", v: out } : out;
  }
  return null;
}

/** The inverse of {@link encodeValue}. */
export function decodeValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(decodeValue);
  if (!v || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const tag = o[TAG];
  if (typeof tag !== "string") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = decodeValue(x);
    return out;
  }
  switch (tag) {
    case "num":
      return Number(o["v"]);
    case "bigint":
      return BigInt(String(o["v"]));
    case "undef":
      return undefined;
    case "blob":
      return new Blob([fromBase64(String(o["data"])) as unknown as BlobPart], { type: String(o["type"] ?? "") });
    case "ab": {
      const b = fromBase64(String(o["data"]));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    case "date":
      return new Date(String(o["v"]));
    case "map":
      return new Map((o["v"] as unknown[][]).map(([k, x]) => [decodeValue(k), decodeValue(x)]));
    case "set":
      return new Set((o["v"] as unknown[]).map(decodeValue));
    case "obj": {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o["v"] as Record<string, unknown>)) out[k] = decodeValue(x);
      return out;
    }
    default: {
      const Ctor = VIEWS[tag];
      if (!Ctor) throw new Error(`unknown value type "${tag}" in backup`);
      const b = fromBase64(String(o["data"]));
      const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
      return new Ctor(buf);
    }
  }
}

/** Parse and check a backup file's JSON text. */
export function parseBackup(text: string): BackupFile {
  let f: Partial<BackupFile>;
  try {
    f = JSON.parse(text) as Partial<BackupFile>;
  } catch {
    throw new Error("That file isn't a Splanc backup.");
  }
  if (!f || f.format !== BACKUP_FORMAT) throw new Error("That file isn't a Splanc backup.");
  if (typeof f.version !== "number" || f.version > BACKUP_VERSION) {
    throw new Error("This backup was made by a newer version of Splanc. Update the app, then import it.");
  }
  return {
    format: BACKUP_FORMAT,
    version: f.version,
    createdAt: String(f.createdAt ?? ""),
    app: f.app ?? {},
    includes: { secrets: f.includes?.secrets === true, captures: f.includes?.captures === true },
    localStorage: f.localStorage ?? {},
    idb: f.idb ?? {},
  };
}

/** Record counts per store, for the import summary. */
export function backupCounts(f: BackupFile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const stores of Object.values(f.idb)) {
    for (const [store, recs] of Object.entries(stores)) out[store] = (out[store] ?? 0) + recs.length;
  }
  return out;
}
