/**
 * The app backup file (store/backupFormat.ts): IndexedDB values survive JSON,
 * secrets stay out unless asked for (and a secret-less import never blanks a
 * key this app has), the newer record wins, and bad files are refused.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BACKUP_FORMAT,
  backupCounts,
  decodeValue,
  encodeValue,
  exportLocalStorage,
  importLocalStorage,
  keepLocal,
  parseBackup,
} from "../src/store/backupFormat";

async function roundTrip(v: unknown): Promise<unknown> {
  return decodeValue(JSON.parse(JSON.stringify(await encodeValue(v))));
}

test("structured-clone values survive the JSON round trip", async () => {
  const rec = {
    id: "map-1",
    updatedAt: "2026-11-04T10:00:00.000Z",
    xyz: new Float32Array([1.5, -2, 3.25]),
    bytes: new Uint8Array([0, 255, 7]),
    view: new Uint16Array(new Uint8Array([1, 0, 2, 0, 3, 0]).buffer, 2, 2),
    raw: new Uint8Array([9, 8]).buffer,
    when: new Date("2026-10-31T20:00:00.000Z"),
    odd: [NaN, Infinity, -Infinity, undefined],
    big: 12345678901234567890n,
    lookup: new Map<string, number>([["a", 1]]),
    tags: new Set(["x", "y"]),
    tricky: { $b: "not a tag", n: 1 },
    nested: [{ deep: new Int32Array([-1, 2]) }],
  };
  const back = (await roundTrip(rec)) as typeof rec;
  assert.deepEqual(Array.from(back.xyz), [1.5, -2, 3.25]);
  assert.ok(back.xyz instanceof Float32Array);
  assert.deepEqual(Array.from(back.bytes), [0, 255, 7]);
  assert.ok(back.view instanceof Uint16Array);
  assert.deepEqual(Array.from(back.view), [2, 3]);
  assert.deepEqual(Array.from(new Uint8Array(back.raw)), [9, 8]);
  assert.equal(back.when.toISOString(), "2026-10-31T20:00:00.000Z");
  assert.ok(Number.isNaN(back.odd[0]));
  assert.deepEqual(back.odd.slice(1), [Infinity, -Infinity, undefined]);
  assert.equal(back.big, 12345678901234567890n);
  assert.equal(back.lookup.get("a"), 1);
  assert.deepEqual([...back.tags], ["x", "y"]);
  assert.deepEqual(back.tricky, { $b: "not a tag", n: 1 });
  assert.deepEqual(Array.from(back.nested[0]!.deep), [-1, 2]);
});

test("Blobs keep their bytes and type", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const back = (await roundTrip({ thumb: blob })) as { thumb: Blob };
  assert.equal(back.thumb.type, "image/png");
  assert.deepEqual(Array.from(new Uint8Array(await back.thumb.arrayBuffer())), [1, 2, 3]);
});

test("large binary payloads encode", async () => {
  const big = new Uint8Array(300_000).map((_, i) => i & 255);
  const back = (await roundTrip(big)) as Uint8Array;
  assert.equal(back.length, big.length);
  assert.equal(back[299_999], 299_999 & 255);
});

const AI = JSON.stringify({
  kind: "cloud",
  cloud: { vendor: "anthropic", vendors: { anthropic: { key: "sk-ant-secret", model: "m" }, openai: { key: "" } } },
  local: { baseUrl: "http://x", key: "local-secret", model: "" },
});

test("secrets stay out unless asked for", () => {
  const entries: [string, string][] = [
    ["ledmapper.ai.config", AI],
    ["splanc.bridge.v1", "{\"pw\":1}"],
    ["ledmapper.anthropicKey", "sk-old"],
    ["ledmapper.devices", "[]"],
  ];
  const out = exportLocalStorage(entries, false);
  assert.deepEqual(Object.keys(out).sort(), ["ledmapper.ai.config", "ledmapper.devices"]);
  assert.ok(!out["ledmapper.ai.config"]!.includes("secret"));
  const cfg = JSON.parse(out["ledmapper.ai.config"]!);
  assert.equal(cfg.cloud.vendors.anthropic.model, "m");
  assert.equal(cfg.cloud.vendors.anthropic.key, "");
  const all = exportLocalStorage(entries, true);
  assert.equal(all["ledmapper.ai.config"], AI);
  assert.equal(all["splanc.bridge.v1"], "{\"pw\":1}");
});

test("a secret-less import keeps this app's keys", () => {
  const stripped = exportLocalStorage([["ledmapper.ai.config", AI]], false);
  const mine = JSON.stringify({
    kind: "local",
    cloud: { vendor: "anthropic", vendors: { anthropic: { key: "sk-ant-mine", model: "old" } } },
  });
  const writes = new Map(importLocalStorage(stripped, () => mine));
  const cfg = JSON.parse(writes.get("ledmapper.ai.config")!);
  assert.equal(cfg.cloud.vendors.anthropic.key, "sk-ant-mine");
  assert.equal(cfg.cloud.vendors.anthropic.model, "m"); // the rest comes from the backup
  assert.equal(cfg.kind, "cloud");
  // With keys in the file, they're imported.
  const withKeys = new Map(importLocalStorage({ "ledmapper.ai.config": AI }, () => mine));
  assert.equal(JSON.parse(withKeys.get("ledmapper.ai.config")!).cloud.vendors.anthropic.key, "sk-ant-secret");
});

test("the newer record wins", () => {
  const old = { updatedAt: "2026-10-01T00:00:00.000Z" };
  const fresh = { updatedAt: "2026-11-01T00:00:00.000Z" };
  assert.equal(keepLocal(fresh, old), true);
  assert.equal(keepLocal(old, fresh), false);
  assert.equal(keepLocal(old, old), false);
  assert.equal(keepLocal({}, fresh), false); // no timestamp: the backup's copy
});

test("bad files are refused", () => {
  assert.throws(() => parseBackup("not json"), /isn't a Splanc backup/);
  assert.throws(() => parseBackup("{\"format\":\"other\"}"), /isn't a Splanc backup/);
  assert.throws(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99 })), /newer version/);
  const f = parseBackup(
    JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      idb: { ledmapper: { effects: [{ value: {} }, { value: {} }], maps_index: [{ value: {} }] } },
    }),
  );
  assert.deepEqual(backupCounts(f), { effects: 2, maps_index: 1 });
  assert.deepEqual(f.includes, { secrets: false, captures: false });
});
