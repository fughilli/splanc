/**
 * #450: the unified diagnostics export (src/store/diagnosticExport.ts) and its
 * Settings ▸ Debugging section (src/ui/screens/diagnosticsSection.ts).
 *
 * The regression fixture is the issue's: eight capture bundles (mapping and
 * room-localization, failed and successful, one with camera frames) plus an
 * effects library and AI chat sessions. A fake debug server mirrors
 * tools/browser_server.py's acks (SHA-256 of each capture-bundle body; ids for
 * /effects and /chatlogs), so the tests can check that Share/Save and server
 * upload of one snapshot carry the same items with the same checksums, and
 * that partial failures, cancels, retries and unreadable storage are reported
 * as such.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeEach, test } from "node:test";
import { installFakeDom } from "./fakeDom";

const dom = installFakeDom();

import { readBackup } from "../src/store/backup";
import { backupCounts, decodeValue, type BackupRecord } from "../src/store/backupFormat";
import type { CaptureBundleMeta, StoredBundle } from "../src/store/captureBundleStore";
import {
  buildArchive,
  describeReport,
  failedKeys,
  takeSnapshot,
  uploadSnapshot,
  type DiagSources,
  type Poster,
} from "../src/store/diagnosticExport";
import type { HttpResult } from "../src/net/nativeHttp";
import { diagnosticsGroup, mergeReports, openSnapshotSheet } from "../src/ui/screens/diagnosticsSection";

// -- fixture ------------------------------------------------------------------------

function bundle(i: number): StoredBundle {
  const localize = i % 3 === 2;
  return {
    format: localize ? "splanc-localize-bundle" : "splanc-capture-bundle",
    version: 1,
    id: `bundle-${i}`,
    createdAt: `2026-11-04T19:${String(10 + i).padStart(2, "0")}:00.000Z`,
    outcome: i % 2 === 0 ? "failed" : "ok",
    summary: `run ${i}`,
    capture: { ledCount: 40 + i },
    problem: { detections: [{ ledId: i, u: 1.25 * i, v: 2 }], imu: [], rms: Number.NaN },
    frames: i === 5 ? [{ tMs: 0, jpeg: "data:image/jpeg;base64,AAAA" }] : [],
    optional: undefined,
  } as unknown as StoredBundle;
}

interface Fixture {
  effects: { id: string; name: string; source: string; updatedAt: string }[];
  chats: { id: string; turns: { role: string; text: string }[] }[];
  bundles: Map<string, StoredBundle>;
  failList?: boolean;
  vanish?: Set<string>;
}

function fixture(): Fixture {
  const bundles = new Map<string, StoredBundle>();
  for (let i = 0; i < 8; i++) bundles.set(`bundle-${i}`, bundle(i));
  return {
    effects: [1, 2, 3].map((i) => ({ id: `fx-${i}`, name: `Effect ${i}`, source: `fn main() { ${i} }`, updatedAt: "2026-11-01" })),
    chats: [1, 2].map((i) => ({ id: `chat-${i}`, turns: [{ role: "user", text: `make ${i}` }] })),
    bundles,
  };
}

function sources(f: Fixture): DiagSources {
  return {
    effects: async () => f.effects,
    chatlogs: async () => f.chats,
    captureList: async () => {
      if (f.failList) throw new Error("IndexedDB unavailable");
      return [...f.bundles.values()].map(
        (b): CaptureBundleMeta => ({
          id: b.id,
          createdAt: b.createdAt,
          outcome: b.outcome,
          summary: b.summary,
          ledCount: b.capture.ledCount,
          bytes: JSON.stringify(b).length,
          frames: b.frames.length,
        }),
      );
    },
    captureGet: async (id) => (f.vanish?.has(id) ? undefined : f.bundles.get(id)),
  };
}

const ALL = ["effects", "chatlogs", "captures"] as const;
const prob = (b: StoredBundle): unknown => (b as unknown as { problem: unknown }).problem;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// -- fake debug server (tools/browser_server.py semantics) ----------------------------

interface FakeServer {
  post: Poster;
  bundles: Map<string, { sha256: string; body: string }>;
  effects: unknown[] | null;
  chats: Map<string, unknown>;
  manifests: Map<string, unknown>;
  bodies: { path: string; body: string }[];
  /** Fail matching requests (path substring or bundle id) with this status. */
  failWhen: ((path: string, body: string) => number | null) | null;
  statuses: string[];
}

function res(status: number, obj: unknown): HttpResult {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) };
}

function fakeServer(): FakeServer {
  const s: FakeServer = {
    bundles: new Map(),
    effects: null,
    chats: new Map(),
    manifests: new Map(),
    bodies: [],
    failWhen: null,
    statuses: [],
    post: async (path, body) => {
      s.bodies.push({ path, body });
      const fail = s.failWhen?.(path, body);
      if (fail) return res(fail, { error: "boom" });
      const route = path.split("?")[0];
      const j = JSON.parse(body) as Record<string, unknown>;
      if (route === "/diagnostics") {
        s.manifests.set(String(j["snapshotId"]), j);
        return res(200, { stored: true, snapshotId: j["snapshotId"] });
      }
      if (route === "/capturebundles") {
        const id = String(j["id"]);
        const h = sha(body);
        const status = s.bundles.get(id)?.sha256 === h ? "duplicate" : s.bundles.has(id) ? "replaced" : "stored";
        s.statuses.push(status);
        s.bundles.set(id, { sha256: h, body });
        return res(200, { stored: true, status, id, sha256: h });
      }
      if (route === "/effects") {
        s.effects = j["effects"] as unknown[];
        return res(200, { stored: true, ids: s.effects.map((e) => String((e as { id: string }).id)) });
      }
      if (route === "/chatlogs") {
        const ids: string[] = [];
        for (const x of j["sessions"] as { id: string }[]) {
          s.chats.set(x.id, x);
          ids.push(x.id);
        }
        return res(200, { stored: true, ids });
      }
      return res(404, { error: "no such endpoint" });
    },
  };
  return s;
}

beforeEach(() => {
  dom.document.body.replaceChildren();
});

// -- snapshot -----------------------------------------------------------------------

test("everything export: every category, each retained item exactly once, failed + localization bundles included", async () => {
  const f = fixture();
  const snap = await takeSnapshot({ categories: ALL, includeFrames: false }, sources(f));
  const m = snap.manifest;
  assert.equal(m.kind, "splanc-diagnostics");
  assert.equal(m.version, 1);
  assert.deepEqual(m.categories.effects?.items.map((i) => i.id), ["fx-1", "fx-2", "fx-3"]);
  assert.deepEqual(m.categories.chatlogs?.items.map((i) => i.id), ["chat-1", "chat-2"]);
  const caps = m.categories.captures!.items;
  assert.equal(caps.length, 8);
  assert.equal(new Set(caps.map((c) => c.id)).size, 8);
  assert.equal(caps.filter((c) => c.kind === "localization").length, 2);
  assert.equal(caps.filter((c) => c.outcome === "failed").length, 4);
  assert.equal(snap.items.length, 13);
  for (const it of snap.items) assert.equal(it.sha256, sha(await it.blob.text()), it.id);
  assert.deepEqual(m.unavailable, []);
});

test("a category export holds only that category", async () => {
  const snap = await takeSnapshot({ categories: ["captures"], includeFrames: false }, sources(fixture()));
  assert.deepEqual(Object.keys(snap.manifest.categories), ["captures"]);
  assert.ok(snap.items.every((i) => i.category === "captures"));
});

test("camera frames are left out unless explicitly included; replay inputs are kept exactly", async () => {
  const f = fixture();
  const without = await takeSnapshot({ categories: ["captures"], includeFrames: false }, sources(f));
  const b5 = without.items.find((i) => i.id === "bundle-5")!;
  const decoded = decodeValue(JSON.parse(await b5.blob.text())) as StoredBundle;
  assert.deepEqual(decoded.frames, []);
  assert.deepEqual(prob(decoded), prob(f.bundles.get("bundle-5")!), "solver input preserved (NaN included)");
  assert.ok(Number.isNaN((prob(decoded) as { rms: number }).rms));
  const withFrames = await takeSnapshot({ categories: ["captures"], includeFrames: true }, sources(f));
  const b5f = withFrames.items.find((i) => i.id === "bundle-5")!;
  assert.equal((decodeValue(JSON.parse(await b5f.blob.text())) as StoredBundle).frames.length, 1);
  assert.equal(withFrames.manifest.includeFrames, true);
});

test("records added after the snapshot are not in it; exporting changes nothing locally", async () => {
  const f = fixture();
  const snap = await takeSnapshot({ categories: ALL, includeFrames: false }, sources(f));
  f.effects.push({ id: "fx-late", name: "late", source: "", updatedAt: "" });
  f.bundles.set("bundle-late", bundle(9));
  const server = fakeServer();
  await uploadSnapshot(snap, server.post);
  await buildArchive(snap);
  assert.equal(server.bundles.size, 8);
  assert.ok(!(server.effects ?? []).some((e) => (e as { id: string }).id === "fx-late"));
  assert.equal(f.bundles.size, 9, "nothing deleted locally");
  assert.equal(f.effects.length, 4);
});

// -- parity -------------------------------------------------------------------------

test("Share/Save file and server upload of one snapshot carry the same ids and checksums; the file is an importable backup", async () => {
  const f = fixture();
  const snap = await takeSnapshot({ categories: ALL, includeFrames: false }, sources(f));
  const archive = await buildArchive(snap);
  assert.match(archive.name, /^splanc-diagnostics-.*\.json(\.gz)?$/);
  const file = await readBackup(new Uint8Array(await archive.blob.arrayBuffer()));
  assert.deepEqual(file.manifest, snap.manifest);
  assert.equal(file.includes.secrets, false);
  assert.deepEqual(file.localStorage, {});
  assert.deepEqual(backupCounts(file), { effects: 3, sessions: 2, bundles: 8, meta: 8 });

  // Every record in the file hashes to its manifest checksum.
  const fileSha = new Map<string, string>();
  const recs = (db: string, store: string): BackupRecord[] => file.idb[db]?.[store] ?? [];
  for (const [cat, db, store] of [
    ["effects", "ledmapper", "effects"],
    ["chatlogs", "ledmapper-chatlog", "sessions"],
    ["captures", "ledmapper-capturebundles", "bundles"],
  ] as const) {
    for (const r of recs(db, store)) {
      const text = JSON.stringify(r.value);
      fileSha.set(`${cat}/${(r.value as { id: string }).id}`, sha(text));
    }
  }
  for (const c of ALL) {
    for (const it of snap.manifest.categories[c]!.items) assert.equal(fileSha.get(`${c}/${it.id}`), it.sha256, `${c}/${it.id}`);
  }

  // The server receives byte-identical capture bundles, and the same effect / chat ids.
  const server = fakeServer();
  const report = await uploadSnapshot(snap, server.post);
  assert.equal(report.complete, true, describeReport(report, snap.manifest).join("; "));
  for (const it of snap.manifest.categories.captures!.items) assert.equal(server.bundles.get(it.id)?.sha256, it.sha256);
  assert.deepEqual((server.effects ?? []).map((e) => (e as { id: string }).id), ["fx-1", "fx-2", "fx-3"]);
  assert.deepEqual([...server.chats.keys()], ["chat-1", "chat-2"]);
  assert.ok(server.manifests.has(snap.manifest.snapshotId));

  // Received bundles stay replayable: decoding the upload body gives the original bundle.
  const sent = decodeValue(JSON.parse(server.bundles.get("bundle-2")!.body)) as StoredBundle;
  const orig = f.bundles.get("bundle-2")!;
  assert.equal(sent.format, "splanc-localize-bundle");
  assert.deepEqual(prob(sent), prob(orig));
  assert.deepEqual(sent.capture, orig.capture);
  // The meta rows in the file let "Import a backup" list the bundles again.
  const meta = recs("ledmapper-capturebundles", "meta").map((r) => r.value as CaptureBundleMeta);
  assert.deepEqual(meta.map((x) => x.id).sort(), [...f.bundles.keys()].sort());
});

test("Send everything: one request per capture bundle (never one huge body)", async () => {
  const server = fakeServer();
  const snap = await takeSnapshot({ categories: ALL, includeFrames: false }, sources(fixture()));
  await uploadSnapshot(snap, server.post);
  const paths = server.bodies.map((b) => b.path.split("?")[0]);
  assert.deepEqual(paths.filter((p) => p === "/capturebundles").length, 8);
  assert.equal(paths[0], "/diagnostics", "the manifest goes first");
});

// -- outcomes -------------------------------------------------------------------------

test("a failed bundle upload is a partial failure, never complete; Retry failed sends only that and completes", async () => {
  const snap = await takeSnapshot({ categories: ALL, includeFrames: false }, sources(fixture()));
  const server = fakeServer();
  server.failWhen = (path, body) => (path.startsWith("/capturebundles") && body.includes('"bundle-3"') ? 500 : null);
  const r1 = await uploadSnapshot(snap, server.post);
  assert.equal(r1.complete, false);
  assert.deepEqual(r1.categories.captures!.failed.map((x) => x.id), ["bundle-3"]);
  assert.match(r1.categories.captures!.failed[0]!.error, /server 500: boom/);
  assert.equal(r1.categories.captures!.acked.length, 7);
  assert.ok(describeReport(r1, snap.manifest).some((l) => /7\/8 sent — 1 failed/.test(l)));

  server.failWhen = null;
  server.bodies = [];
  const r2 = await uploadSnapshot(snap, server.post, { only: failedKeys(r1) });
  const bundlePosts = server.bodies.filter((b) => b.path.startsWith("/capturebundles"));
  assert.equal(bundlePosts.length, 1, "only the failed bundle is re-sent");
  const merged = mergeReports(r1, r2, snap.manifest.unavailable.length);
  assert.equal(merged.complete, true);
  assert.equal(merged.categories.captures!.acked.length, 8);
});

test("duplicate sends are idempotent: the server dedupes by checksum and acks again", async () => {
  const snap = await takeSnapshot({ categories: ["captures"], includeFrames: false }, sources(fixture()));
  const server = fakeServer();
  await uploadSnapshot(snap, server.post);
  const again = await uploadSnapshot(snap, server.post);
  assert.equal(again.complete, true);
  assert.equal(server.statuses.filter((s) => s === "duplicate").length, 8);
  assert.equal(server.bundles.size, 8);
});

test("a checksum the server doesn't confirm is a failure", async () => {
  const snap = await takeSnapshot({ categories: ["captures"], includeFrames: false }, sources(fixture()));
  const bad: Poster = async (path, body) =>
    path.startsWith("/capturebundles")
      ? res(200, { id: (JSON.parse(body) as { id: string }).id, sha256: "0".repeat(64) })
      : res(200, { stored: true });
  const r = await uploadSnapshot(snap, bad);
  assert.equal(r.complete, false);
  assert.equal(r.categories.captures!.failed.length, 8);
  assert.match(r.categories.captures!.failed[0]!.error, /checksum/);
});

test("an interrupted upload (cancel) reports what wasn't sent; retry finishes it", async () => {
  const snap = await takeSnapshot({ categories: ["captures"], includeFrames: false }, sources(fixture()));
  const server = fakeServer();
  const ctl = new AbortController();
  let n = 0;
  const post: Poster = async (path, body) => {
    const r = await server.post(path, body);
    if (path.startsWith("/capturebundles") && ++n === 3) ctl.abort();
    return r;
  };
  const r1 = await uploadSnapshot(snap, post, { signal: ctl.signal });
  assert.equal(r1.cancelled, true);
  assert.equal(r1.complete, false);
  assert.equal(r1.categories.captures!.acked.length, 3);
  assert.equal(r1.categories.captures!.failed.length, 5);
  assert.ok(r1.categories.captures!.failed.every((x) => x.error === "not sent (cancelled)"));
  const r2 = await uploadSnapshot(snap, server.post, { only: failedKeys(r1) });
  assert.equal(mergeReports(r1, r2, 0).complete, true);
});

test("a transport error (server unreachable) fails every item it covered", async () => {
  const snap = await takeSnapshot({ categories: ALL, includeFrames: false }, sources(fixture()));
  const r = await uploadSnapshot(snap, async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(r.complete, false);
  assert.equal(r.manifest.ok, false);
  assert.equal(r.categories.effects!.failed.length, 3);
  assert.equal(r.categories.captures!.failed.length, 8);
});

test("empty categories have an explicit outcome and don't fail the send", async () => {
  const f = fixture();
  f.chats = [];
  const snap = await takeSnapshot({ categories: ALL, includeFrames: false }, sources(f));
  assert.equal(snap.manifest.categories.chatlogs?.count, 0);
  const r = await uploadSnapshot(snap, fakeServer().post);
  assert.equal(r.complete, true);
  assert.ok(describeReport(r, snap.manifest).includes("AI chat sessions: none to send"));
});

test("unavailable storage and a bundle pruned mid-snapshot are reported, and the send is not complete", async () => {
  const f = fixture();
  f.failList = true;
  const snap = await takeSnapshot({ categories: ALL, includeFrames: false }, sources(f));
  assert.equal(snap.manifest.categories.captures?.count, 0);
  assert.match(snap.manifest.unavailable[0]!.reason, /IndexedDB unavailable/);
  const r = await uploadSnapshot(snap, fakeServer().post);
  assert.equal(r.categories.effects!.acked.length, 3, "the readable categories still go");
  assert.equal(r.complete, false);

  const g = fixture();
  g.vanish = new Set(["bundle-4"]);
  const s2 = await takeSnapshot({ categories: ["captures"], includeFrames: false }, sources(g));
  assert.equal(s2.manifest.categories.captures?.count, 7);
  assert.deepEqual(s2.manifest.unavailable, [{ category: "captures", id: "bundle-4", reason: "deleted before it could be read" }]);
});

test("an oversized record is refused for upload with a clear outcome (Save file still has it)", async () => {
  const snap = await takeSnapshot({ categories: ["captures"], includeFrames: false }, sources(fixture()));
  const r = await uploadSnapshot(snap, fakeServer().post, { maxItemBytes: 10 });
  assert.equal(r.complete, false);
  assert.match(r.categories.captures!.failed[0]!.error, /too large to upload.*Save file/);
  const file = await readBackup(new Uint8Array(await (await buildArchive(snap)).blob.arrayBuffer()));
  assert.equal(backupCounts(file)["bundles"], 8);
});

// -- the Settings section ---------------------------------------------------------------

/** Wait (real time: hashing / gzip are genuinely async) until `cond` holds. */
async function waitFor(what: string, cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) {
      const toasts = [...document.querySelectorAll(".k-toast")].map((t) => t.textContent).join(" | ");
      throw new Error(`timed out waiting for ${what}${toasts ? ` (toasts: ${toasts})` : ""}`);
    }
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

function stubBuilders() {
  const group = (legend: string): HTMLElement => {
    const g = document.createElement("section");
    g.dataset.legend = legend;
    return g;
  };
  const row = (name: string, hint: string, control: HTMLElement): HTMLElement => {
    const r = document.createElement("div");
    r.className = "settings-row";
    const n = document.createElement("div");
    n.className = "settings-row-name";
    n.textContent = name;
    const h = document.createElement("div");
    h.className = "settings-row-hint";
    h.textContent = hint;
    r.append(n, h, control);
    return r;
  };
  const segmented = <T extends string>(_o: [T, string][], _v: T, _p: (v: T) => void): HTMLElement => document.createElement("div");
  return { group, row, segmented };
}

test("the section shows counts, and Prepare → Send/Share/Save all use the same snapshot", async () => {
  const f = fixture();
  const server = fakeServer();
  const saved: { name: string; size: number }[] = [];
  const shared: ShareData[] = [];
  const b = stubBuilders();
  const g = diagnosticsGroup(b.group, b.row, b.segmented, {
    sources: sources(f),
    post: server.post,
    connected: () => true,
    serverUrl: () => "https://192.168.1.20:8093",
    save: async (blob, name) => void saved.push({ name, size: blob.size }),
    share: async (d) => void shared.push(d),
    canShare: () => true,
  });
  document.body.append(g);
  const hint = (c: string): string => g.querySelector(`[data-diag-category="${c}"] .settings-row-hint`)?.textContent ?? "";
  await waitFor("the counts", () => hint("captures") !== "…");
  assert.match(hint("captures"), /^8 items/);
  assert.match(hint("effects"), /^3 items/);

  (g.querySelector(".diag-prepare") as HTMLButtonElement).click();
  await waitFor("the snapshot sheet", () => document.querySelector(".diag-sheet") !== null);
  const sheet = document.querySelector(".diag-sheet")!;
  assert.match(sheet.querySelector(".diag-dest")?.textContent ?? "", /192\.168\.1\.20:8093/);
  (sheet.querySelector(".diag-send") as HTMLButtonElement).click();
  await waitFor("the send", () => /Sent|Not everything/.test(sheet.querySelector(".diag-status")?.textContent ?? ""));
  assert.match(sheet.querySelector(".diag-status")?.textContent ?? "", /Sent — everything acknowledged/);
  assert.equal(server.bundles.size, 8);

  (sheet.querySelector(".diag-share") as HTMLButtonElement).click();
  await waitFor("share", () => shared.length > 0);
  const file = (shared[0]!.files ?? [])[0]!;
  const parsed = await readBackup(new Uint8Array(await file.arrayBuffer()));
  assert.equal(parsed.manifest?.snapshotId, [...server.manifests.keys()][0], "Share hands over the snapshot the server got");

  (sheet.querySelector(".diag-save") as HTMLButtonElement).click();
  await waitFor("save", () => saved.length > 0);
  assert.equal(saved[0]!.name, file.name);
  assert.equal(saved[0]!.size, file.size);
});

test("not connected: Send is disabled; Share falls back to Save file where file sharing is unavailable", async () => {
  const snap = await takeSnapshot({ categories: ["effects"], includeFrames: false }, sources(fixture()));
  const archive = await buildArchive(snap);
  const saved: string[] = [];
  const h = openSnapshotSheet(snap, archive, {
    connected: () => false,
    serverUrl: () => "",
    post: null,
    save: async (_b, name) => void saved.push(name),
    share: null,
  });
  assert.equal((h.el.querySelector(".diag-send") as HTMLButtonElement).disabled, true);
  assert.match(h.el.querySelector(".diag-dest")?.textContent ?? "", /not connected/);
  (h.el.querySelector(".diag-share") as HTMLButtonElement).click();
  await waitFor("save fallback", () => saved.length > 0);
  assert.deepEqual(saved, [archive.name]);
  h.close();
});

test("a partial failure in the sheet says so and offers Retry failed", async () => {
  const snap = await takeSnapshot({ categories: ["captures"], includeFrames: false }, sources(fixture()));
  const server = fakeServer();
  server.failWhen = (path, body) => (path.startsWith("/capturebundles") && body.includes('"bundle-1"') ? 503 : null);
  const h = openSnapshotSheet(snap, await buildArchive(snap), {
    connected: () => true,
    serverUrl: () => "https://h:1",
    post: server.post,
  });
  (h.el.querySelector(".diag-send") as HTMLButtonElement).click();
  await waitFor("the send", () => /Sent|Not everything/.test(h.el.querySelector(".diag-status")?.textContent ?? ""));
  const status = h.el.querySelector(".diag-status")?.textContent ?? "";
  assert.match(status, /Not everything was sent/);
  assert.match(status, /7\/8 sent — 1 failed/);
  const retry = h.el.querySelector(".diag-retry") as HTMLButtonElement;
  assert.notEqual(retry.style.display, "none");
  server.failWhen = null;
  retry.click();
  await waitFor("the retry", () => /Sent —/.test(h.el.querySelector(".diag-status")?.textContent ?? ""));
  assert.match(h.el.querySelector(".diag-status")?.textContent ?? "", /Sent — everything acknowledged/);
  h.close();
});
