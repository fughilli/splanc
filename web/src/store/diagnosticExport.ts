/**
 * Diagnostics export (#450): one snapshot of the debug data — the effects
 * library, the FX-agent chat sessions and the mapping / room-localization
 * capture bundles — that every transport sends identically:
 *
 *   - Send to the debug server (tools/browser_server.py): the manifest to
 *     `/diagnostics`, then effects to `/effects`, chat sessions to `/chatlogs`
 *     and each capture bundle to `/capturebundles` (one request per bundle, so
 *     a large set never has to sit in one request body);
 *   - Share / Save file: the same snapshot as one file.
 *
 * The file IS an app backup (store/backupFormat.ts, `splanc-backup` v1) holding
 * just those stores plus a `manifest` — so "Import a backup" on another phone
 * restores the bundles for replay, and no second export format exists. Every
 * item's text is JSON.stringify of its backup-encoded value, both inside the
 * file and as the upload body; the manifest carries its SHA-256, which the
 * server echoes back for capture bundles. Share and upload of one snapshot are
 * therefore byte-identical per item.
 *
 * Snapshot semantics: the item set and contents are fixed when the snapshot is
 * taken; records added later are not in it. Each item's text is held in a Blob
 * (not one big string), so a large bundle set needn't be live JS heap.
 * Exporting never deletes or changes local records.
 */

import { BUNDLE_FORMAT, bundleBytes } from "../solver/captureBundle";
import { LOCALIZE_BUNDLE_FORMAT } from "../solver/localizeBundle";
import type { HttpResult } from "../net/nativeHttp";
import { appInfo, gzipBlob } from "./backup";
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  DIAG_CATEGORIES,
  DIAG_MANIFEST_KIND,
  DIAG_MANIFEST_VERSION,
  decodeValue,
  encodeValue,
  type DiagCategory,
  type DiagCategoryManifest,
  type DiagItem,
  type DiagnosticManifest,
} from "./backupFormat";
import { captureBundleStore, type CaptureBundleMeta, type StoredBundle } from "./captureBundleStore";
import { chatLogStore } from "./chatLogStore";
import { effectStore } from "./effectStore";

export { DIAG_CATEGORIES, type DiagCategory } from "./backupFormat";

/** Where each category lives in the backup file's `idb` section (the stores
 * store/backup.ts exports and imports). */
const IDB_HOME: Record<DiagCategory, { db: string; store: string; meta?: string }> = {
  effects: { db: "ledmapper", store: "effects" },
  chatlogs: { db: "ledmapper-chatlog", store: "sessions" },
  captures: { db: "ledmapper-capturebundles", store: "bundles", meta: "meta" },
};

export const CATEGORY_LABEL: Record<DiagCategory, string> = {
  effects: "Effects library",
  chatlogs: "AI chat sessions",
  captures: "Mapping & localization bundles",
};

/** Largest single item the server upload sends (the server refuses bodies
 * over 256 MB); bigger ones are reported and left to Share / Save file. */
export const MAX_UPLOAD_ITEM_BYTES = 200 * 1024 * 1024;

// -- sources -----------------------------------------------------------------------

/** Where the records come from (the app's stores; a seam for tests). */
export interface DiagSources {
  effects(): Promise<readonly unknown[]>;
  chatlogs(): Promise<readonly unknown[]>;
  captureList(): Promise<readonly CaptureBundleMeta[]>;
  captureGet(id: string): Promise<StoredBundle | undefined>;
}

export const storeSources: DiagSources = {
  effects: () => effectStore.list(),
  chatlogs: () => chatLogStore.list(),
  captureList: () => captureBundleStore.list(),
  captureGet: (id) => captureBundleStore.get(id),
};

export interface CategorySummary {
  /** null when the store couldn't be read. */
  count: number | null;
  /** Estimated bytes (capture bundles: as stored, frames included). */
  bytes: number | null;
  error?: string;
}

/** Counts and size estimates per category, for the selection UI. Cheap: bundle
 * sizes come from their index rows, not the bundles. */
export async function summarizeCategories(src: DiagSources = storeSources): Promise<Record<DiagCategory, CategorySummary>> {
  const one = async (f: () => Promise<CategorySummary>): Promise<CategorySummary> => {
    try {
      return await f();
    } catch (e) {
      return { count: null, bytes: null, error: errText(e) };
    }
  };
  const records = async (list: () => Promise<readonly unknown[]>): Promise<CategorySummary> => {
    const r = await list();
    return { count: r.length, bytes: JSON.stringify(r).length };
  };
  const [effects, chatlogs, captures] = await Promise.all([
    one(() => records(src.effects)),
    one(() => records(src.chatlogs)),
    one(async () => {
      const m = await src.captureList();
      return { count: m.length, bytes: m.reduce((a, x) => a + x.bytes, 0) };
    }),
  ]);
  return { effects, chatlogs, captures };
}

// -- snapshot ----------------------------------------------------------------------

export interface SnapshotItem extends DiagItem {
  category: DiagCategory;
  /** The item's exact text (JSON of its backup-encoded value). */
  blob: Blob;
  /** captures: the index row the backup's `meta` store needs (encoded JSON). */
  metaText?: string;
}

export interface DiagnosticSnapshot {
  manifest: DiagnosticManifest;
  items: SnapshotItem[];
}

export interface SnapshotOptions {
  categories: readonly DiagCategory[];
  /** Keep capture bundles' optional camera frames (otherwise stripped). */
  includeFrames: boolean;
}

/** Take a snapshot of the selected categories. Never throws for a store that
 * can't be read or a bundle that vanished meanwhile: those are listed in
 * `manifest.unavailable`. Throws only when cancelled. */
export async function takeSnapshot(
  opts: SnapshotOptions,
  src: DiagSources = storeSources,
  hooks: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<DiagnosticSnapshot> {
  const createdAt = new Date().toISOString();
  const manifest: DiagnosticManifest = {
    kind: DIAG_MANIFEST_KIND,
    version: DIAG_MANIFEST_VERSION,
    snapshotId: newSnapshotId(createdAt),
    createdAt,
    app: appInfo(),
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
    includeFrames: opts.includeFrames,
    categories: {},
    unavailable: [],
  };
  const items: SnapshotItem[] = [];
  const wanted = DIAG_CATEGORIES.filter((c) => opts.categories.includes(c));
  const abortCheck = (): void => {
    if (hooks.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
  };

  const add = async (category: DiagCategory, value: unknown, extra: Partial<DiagItem> = {}, metaText?: string) => {
    const text = JSON.stringify(await encodeValue(value));
    const item: SnapshotItem = {
      category,
      id: String((value as { id?: unknown }).id),
      sha256: await sha256Hex(text),
      bytes: utf8Length(text),
      ...extra,
      blob: new Blob([text], { type: "application/json" }),
      ...(metaText !== undefined ? { metaText } : {}),
    };
    items.push(item);
    return item;
  };

  for (const category of wanted) {
    abortCheck();
    const cat: DiagCategoryManifest = { count: 0, bytes: 0, items: [] };
    const seen = new Set<string>();
    const keep = (it: SnapshotItem): void => {
      cat.items.push(diagItem(it));
      cat.count++;
      cat.bytes += it.bytes;
    };
    try {
      if (category === "captures") {
        const metas = await src.captureList();
        let done = 0;
        for (const m of metas) {
          abortCheck();
          hooks.onProgress?.(done++, metas.length);
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          let b: StoredBundle | undefined;
          try {
            b = await src.captureGet(m.id);
          } catch (e) {
            manifest.unavailable.push({ category, id: m.id, reason: errText(e) });
            continue;
          }
          if (!b) {
            manifest.unavailable.push({ category, id: m.id, reason: "deleted before it could be read" });
            continue;
          }
          const bundle = opts.includeFrames ? b : ({ ...b, frames: [] } as StoredBundle);
          const meta: CaptureBundleMeta = {
            id: bundle.id,
            createdAt: bundle.createdAt,
            outcome: bundle.outcome,
            summary: bundle.summary,
            ledCount: bundle.capture.ledCount,
            bytes: bundleBytes(bundle),
            frames: bundle.frames.length,
          };
          const kind = bundle.format === LOCALIZE_BUNDLE_FORMAT ? "localization" : bundle.format === BUNDLE_FORMAT ? "mapping" : String((bundle as { format?: unknown }).format);
          keep(await add(category, bundle, { kind, outcome: bundle.outcome }, JSON.stringify(await encodeValue(meta))));
        }
        hooks.onProgress?.(metas.length, metas.length);
      } else {
        const records = await (category === "effects" ? src.effects() : src.chatlogs());
        for (const r of records) {
          abortCheck();
          const id = (r as { id?: unknown } | null)?.id;
          if (typeof id !== "string" && typeof id !== "number") {
            manifest.unavailable.push({ category, reason: "a record without an id was skipped" });
            continue;
          }
          if (seen.has(String(id))) continue;
          seen.add(String(id));
          keep(await add(category, r));
        }
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      manifest.unavailable.push({ category, reason: `couldn't read: ${errText(e)}` });
    }
    manifest.categories[category] = cat;
  }
  return { manifest, items };
}

function diagItem(it: SnapshotItem): DiagItem {
  const out: DiagItem = { id: it.id, sha256: it.sha256, bytes: it.bytes };
  if (it.kind !== undefined) out.kind = it.kind;
  if (it.outcome !== undefined) out.outcome = it.outcome;
  return out;
}

// -- the file (Share / Save) ---------------------------------------------------------

export interface DiagnosticArchive {
  blob: Blob;
  name: string;
  mime: string;
}

/** The snapshot as one backup-format file (gzipped when the browser can). The
 * item Blobs are spliced in as parts, never concatenated into one string. */
export async function buildArchive(snap: DiagnosticSnapshot): Promise<DiagnosticArchive> {
  const m = snap.manifest;
  const head = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: m.createdAt,
    app: m.app,
    includes: { secrets: false, captures: m.categories.captures !== undefined },
    manifest: m,
    localStorage: {},
  };
  const parts: BlobPart[] = [JSON.stringify(head).slice(0, -1), ',"idb":{'];
  const byDb = new Map<string, Map<string, BlobPart[][]>>();
  const push = (db: string, store: string, rec: BlobPart[]): void => {
    const stores = byDb.get(db) ?? new Map<string, BlobPart[][]>();
    byDb.set(db, stores);
    const list = stores.get(store) ?? [];
    stores.set(store, list);
    list.push(rec);
  };
  for (const c of DIAG_CATEGORIES) {
    if (m.categories[c] === undefined) continue;
    const home = IDB_HOME[c];
    // Present (possibly empty) for every selected category.
    push(home.db, home.store, []);
    if (home.meta) push(home.db, home.meta, []);
  }
  for (const it of snap.items) {
    const home = IDB_HOME[it.category];
    if (home.meta && it.metaText !== undefined) push(home.db, home.meta, ['{"value":', it.metaText, "}"]);
    push(home.db, home.store, ['{"value":', it.blob, "}"]);
  }
  let firstDb = true;
  for (const [db, stores] of byDb) {
    parts.push(`${firstDb ? "" : ","}${JSON.stringify(db)}:{`);
    firstDb = false;
    let firstStore = true;
    for (const [store, recs] of stores) {
      parts.push(`${firstStore ? "" : ","}${JSON.stringify(store)}:[`);
      firstStore = false;
      let first = true;
      for (const rec of recs) {
        if (rec.length === 0) continue; // the "present" marker
        if (!first) parts.push(",");
        first = false;
        parts.push(...rec);
      }
      parts.push("]");
    }
    parts.push("}");
  }
  parts.push("}}");
  const json = new Blob(parts, { type: "application/json" });
  const stamp = m.createdAt.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
  const gz = await gzipBlob(json).catch(() => null);
  return gz
    ? { blob: gz, name: `splanc-diagnostics-${stamp}.json.gz`, mime: "application/gzip" }
    : { blob: json, name: `splanc-diagnostics-${stamp}.json`, mime: "application/json" };
}

// -- server upload ------------------------------------------------------------------

/** POST an exact JSON body to the debug server (net/debugServer postJsonText). */
export type Poster = (path: string, body: string) => Promise<HttpResult>;

export interface CategoryOutcome {
  /** Items this send attempted. */
  expected: number;
  /** Ids the server acknowledged (for capture bundles: with a matching checksum). */
  acked: string[];
  failed: { id: string; error: string }[];
}

export interface UploadReport {
  snapshotId: string;
  manifest: { ok: boolean; error?: string };
  categories: Partial<Record<DiagCategory, CategoryOutcome>>;
  cancelled: boolean;
  /** True only when the manifest and every attempted item were acknowledged
   * and nothing in the snapshot was unavailable. */
  complete: boolean;
}

/** The `category/id` keys an upload should retry. */
export const itemKey = (category: DiagCategory, id: string): string => `${category}/${id}`;

export function failedKeys(r: UploadReport): Set<string> {
  const out = new Set<string>();
  for (const c of DIAG_CATEGORIES) for (const f of r.categories[c]?.failed ?? []) out.add(itemKey(c, f.id));
  return out;
}

export interface UploadOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Retry: send only these items (`itemKey`s). Effects go as a whole
   * category, since the server's /effects keeps the last library sent. */
  only?: ReadonlySet<string>;
  maxItemBytes?: number;
}

/** Send a snapshot to the debug server. Never throws; every outcome is in the
 * report, per category and item. Re-sending is safe (the server dedupes). */
export async function uploadSnapshot(snap: DiagnosticSnapshot, post: Poster, opts: UploadOptions = {}): Promise<UploadReport> {
  const m = snap.manifest;
  const report: UploadReport = { snapshotId: m.snapshotId, manifest: { ok: false }, categories: {}, cancelled: false, complete: false };
  const maxBytes = opts.maxItemBytes ?? MAX_UPLOAD_ITEM_BYTES;
  const only = opts.only;
  const pick = (c: DiagCategory): SnapshotItem[] => {
    const all = snap.items.filter((it) => it.category === c);
    if (!only) return all;
    if (c === "effects") return all.some((it) => only.has(itemKey(c, it.id))) ? all : [];
    return all.filter((it) => only.has(itemKey(c, it.id)));
  };
  const plan = DIAG_CATEGORIES.filter((c) => m.categories[c] !== undefined).map((c) => [c, pick(c)] as const);
  const total = plan.reduce((a, [c, list]) => a + (c === "captures" ? list.length : list.length > 0 ? 1 : 0), 0) + 1;
  let done = 0;
  const progress = (label: string): void => opts.onProgress?.(done, total, label);
  const cancelled = (): boolean => opts.signal?.aborted === true;
  const outcome = (c: DiagCategory, expected: number): CategoryOutcome => {
    const o: CategoryOutcome = { expected, acked: [], failed: [] };
    report.categories[c] = o;
    return o;
  };

  progress("manifest");
  try {
    const res = await post(`/diagnostics?snapshot=${encodeURIComponent(m.snapshotId)}`, JSON.stringify(m));
    report.manifest = res.ok ? { ok: true } : { ok: false, error: await httpError(res) };
  } catch (e) {
    report.manifest = { ok: false, error: errText(e) };
  }
  done++;

  for (const [c, list] of plan) {
    const o = outcome(c, list.length);
    if (list.length === 0) continue;
    if (cancelled()) {
      for (const it of list) o.failed.push({ id: it.id, error: "not sent (cancelled)" });
      continue;
    }
    if (c === "captures") {
      for (const it of list) {
        if (cancelled()) {
          o.failed.push({ id: it.id, error: "not sent (cancelled)" });
          continue;
        }
        progress(`capture bundle ${it.id}`);
        if (it.bytes > maxBytes) {
          o.failed.push({ id: it.id, error: `too large to upload (${(it.bytes / 1048576).toFixed(0)} MB) — use Save file` });
          done++;
          continue;
        }
        try {
          const res = await post(`/capturebundles?snapshot=${encodeURIComponent(m.snapshotId)}`, await it.blob.text());
          if (!res.ok) o.failed.push({ id: it.id, error: await httpError(res) });
          else {
            const ack = parseJson(await res.text());
            if (ack?.["sha256"] === it.sha256 && ack["id"] === it.id) o.acked.push(it.id);
            else o.failed.push({ id: it.id, error: "the server's checksum didn't match" });
          }
        } catch (e) {
          o.failed.push({ id: it.id, error: errText(e) });
        }
        done++;
      }
      continue;
    }
    // Effects / chat sessions: one request for the category, acknowledged by id.
    progress(CATEGORY_LABEL[c]);
    try {
      const values: unknown[] = [];
      for (const it of list) values.push(decodeValue(JSON.parse(await it.blob.text())));
      const body = {
        snapshotId: m.snapshotId,
        exportedAt: m.createdAt,
        count: values.length,
        userAgent: m.userAgent,
        ...(c === "effects" ? { effects: values } : { sessions: values }),
      };
      const res = await post(c === "effects" ? "/effects" : "/chatlogs", JSON.stringify(body));
      if (!res.ok) {
        const err = await httpError(res);
        for (const it of list) o.failed.push({ id: it.id, error: err });
      } else {
        const ack = parseJson(await res.text());
        const ids = new Set(Array.isArray(ack?.["ids"]) ? (ack["ids"] as unknown[]).map(String) : []);
        for (const it of list) {
          if (ids.has(it.id)) o.acked.push(it.id);
          else o.failed.push({ id: it.id, error: "not acknowledged by the server" });
        }
      }
    } catch (e) {
      const err = errText(e);
      for (const it of list) o.failed.push({ id: it.id, error: err });
    }
    done++;
  }
  progress("done");
  report.cancelled = cancelled();
  report.complete =
    report.manifest.ok &&
    !report.cancelled &&
    m.unavailable.length === 0 &&
    DIAG_CATEGORIES.every((c) => (report.categories[c]?.failed.length ?? 0) === 0);
  return report;
}

/** One line per category, e.g. "Effects library: 12/12 sent". Honest about
 * partial outcomes. */
export function describeReport(r: UploadReport, m: DiagnosticManifest): string[] {
  const lines: string[] = [];
  if (!r.manifest.ok) lines.push(`Manifest not stored: ${r.manifest.error ?? "unknown error"}`);
  for (const c of DIAG_CATEGORIES) {
    const o = r.categories[c];
    if (!o) continue;
    const inSnap = m.categories[c]?.count ?? 0;
    if (inSnap === 0) {
      lines.push(`${CATEGORY_LABEL[c]}: none to send`);
      continue;
    }
    if (o.expected === 0) continue; // a retry that didn't include this category
    const head = `${CATEGORY_LABEL[c]}: ${o.acked.length}/${o.expected} sent`;
    lines.push(o.failed.length === 0 ? head : `${head} — ${o.failed.length} failed (${o.failed[0]!.error})`);
  }
  for (const u of m.unavailable) lines.push(`${CATEGORY_LABEL[u.category]}: ${u.id ? `${u.id} ` : ""}${u.reason}`);
  if (r.cancelled) lines.push("Cancelled — the rest was not sent.");
  return lines;
}

// -- helpers ------------------------------------------------------------------------

function newSnapshotId(createdAt: string): string {
  const rnd =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10);
  return `${createdAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${rnd}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

function parseJson(t: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function httpError(res: HttpResult): Promise<string> {
  let detail = "";
  try {
    const j = parseJson(await res.text());
    detail = typeof j?.["error"] === "string" ? `: ${j["error"]}` : "";
  } catch {
    /* no body */
  }
  return `server ${res.status}${detail}`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
