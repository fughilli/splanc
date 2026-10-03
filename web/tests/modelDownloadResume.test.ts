/**
 * Resumable, checkpointed on-device model downloads (FUG-87 follow-up;
 * src/effects/ai/resumableDownload.ts, docs/design/on-device-models.md
 * "Downloads are resumable/checkpointed"). Model weights are hundreds of MB to a
 * few GB; on a phone, locking the screen or backgrounding the app kills the
 * fetch. The documented contract, pinned here through the REAL OPFS runtime on an
 * in-memory file system (onDeviceFakes.ts) and a fake server:
 *
 *   - the bytes on disk are the checkpoint: a dropped transfer resumes with an
 *     HTTP `Range` from there, guarded by `If-Range` on the stored ETag, and is
 *     retried automatically after a backoff (mocked timers — no real waits);
 *   - a file that changed on the server (200 to a Range request) restarts
 *     cleanly; a finished download is reused with no network; a file whose last
 *     bytes landed before the connection dropped completes on a 416;
 *   - the CPU (wllama) provider downloads through this store and loads those
 *     bytes (bypassing wllama's non-resumable downloader), falling back to
 *     wllama's own downloader for split GGUFs and browsers without OPFS.
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { flushAsync, installOpfs, restoreNavigator, setNavigator, wllamaFake } from "./onDeviceFakes";
import { installFakeDom } from "./fakeDom";

installFakeDom();

import {
  cachedBytes,
  cachedModelFile,
  deleteCachedModel,
  downloadModelResumable,
  isModelCached,
  type DownloadProgress,
} from "../src/effects/ai/resumableDownload";
import {
  deleteWllamaModel,
  downloadWllamaModel,
  isWllamaModelDownloaded,
  isWllamaModelLoaded,
  loadWllamaModel,
  unloadWllamaModel,
  type WllamaProgress,
} from "../src/effects/ai/providers/wllama";

const MODEL = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf";
const SPLIT = "https://huggingface.co/someone/Big-GGUF/resolve/main/big-q4_k_m-00001-of-00003.gguf";

interface Req {
  url: string;
  headers: Record<string, string>;
}
const realFetch = globalThis.fetch;
let reqs: Req[] = [];
let respond: (req: Req, n: number) => Response = () => {
  throw new Error("no server configured");
};

beforeEach(async () => {
  reqs = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = { url: String(input), headers: { ...((init?.headers ?? {}) as Record<string, string>) } };
    reqs.push(req);
    return respond(req, reqs.length);
  }) as typeof fetch;
  await unloadWllamaModel();
  wllamaFake.reset();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreNavigator();
  mock.timers.reset();
});

const bytes = (n: number, seed = 0): Uint8Array<ArrayBuffer> => Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

/** A body that delivers `data` in `chunk`-byte reads, then (optionally) dies the
 * way a fetch does when the phone locks / the network drops. */
function body(data: Uint8Array, chunk: number, dieAfter?: number): ReadableStream<Uint8Array> {
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      const stop = dieAfter ?? data.length;
      if (pos >= stop) {
        if (dieAfter !== undefined) c.error(new TypeError("network connection was lost"));
        else c.close();
        return;
      }
      const end = Math.min(stop, pos + chunk);
      c.enqueue(data.slice(pos, end));
      pos = end;
    },
  });
}

/** Run a download to completion, advancing the (mocked) retry backoff as needed. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.finally(() => (done = true)).catch(() => undefined);
  for (let i = 0; i < 100 && !done; i++) {
    await flushAsync(2);
    mock.timers.tick(500);
  }
  return p;
}

const fileBytes = async (f: File | Blob): Promise<number[]> => [...new Uint8Array(await f.arrayBuffer())];

test("a model download that drops mid-stream resumes from the on-disk checkpoint [rr:PR-8]", async () => {
  installOpfs();
  mock.timers.enable({ apis: ["setTimeout"] });
  const weights = bytes(100);
  respond = (req, n) =>
    n === 1
      ? new Response(body(weights, 20, 40), { status: 200, headers: { "content-length": "100", etag: '"v1"' } })
      : new Response(body(weights.slice(40), 30), { status: 206, headers: { "content-range": "bytes 40-99/100", etag: '"v1"' } });

  const progress: DownloadProgress[] = [];
  const file = await drive(downloadModelResumable(MODEL, { onProgress: (p) => progress.push(p) }));

  assert.deepEqual(await fileBytes(file), [...weights], "the resumed file is byte-identical");
  // Fresh start, then a Range from the 40 bytes already on disk, pinned to the ETag.
  assert.deepEqual(
    reqs.map((r) => r.headers),
    [{}, { Range: "bytes=40-", "If-Range": '"v1"' }],
  );
  // Progress is absolute (the resumed transfer continues from 40, not 0).
  assert.deepEqual(progress, [
    { loaded: 20, total: 100 },
    { loaded: 40, total: 100 },
    { loaded: 70, total: 100 },
    { loaded: 100, total: 100 },
  ]);
  assert.equal(await isModelCached(MODEL), true);
  assert.equal(await cachedBytes(MODEL), 100);
});

test("a changed model restarts cleanly, a finished one is reused offline, and a fully-written one completes on 416 [rr:PR-8]", async () => {
  installOpfs();
  mock.timers.enable({ apis: ["setTimeout"] });

  // v1 drops at 40 bytes; meanwhile the server's file became v2 (ETag mismatch →
  // it ignores the Range and sends the whole new file): start over, no splicing.
  const v1 = bytes(100, 1);
  const v2 = bytes(120, 2);
  respond = (_req, n) =>
    n === 1
      ? new Response(body(v1, 40, 40), { status: 200, headers: { "content-length": "100", etag: '"v1"' } })
      : new Response(body(v2, 50), { status: 200, headers: { "content-length": "120", etag: '"v2"' } });
  const file = await drive(downloadModelResumable(MODEL));
  assert.deepEqual(reqs[1]!.headers, { Range: "bytes=40-", "If-Range": '"v1"' });
  assert.deepEqual(await fileBytes(file), [...v2]);

  // Finished: later requests are served from the browser cache, no network.
  const before = reqs.length;
  assert.deepEqual(await fileBytes(await downloadModelResumable(MODEL)), [...v2]);
  assert.deepEqual(await fileBytes((await cachedModelFile(MODEL))!), [...v2]);
  assert.equal(reqs.length, before);

  // Every byte landed but the connection died before EOF: the resume Range is
  // past the end (416) — complete, nothing re-fetched.
  const other = MODEL.replace("0.5b", "1.5b");
  const w = bytes(50, 3);
  respond = (_req, n) =>
    n === before + 1
      ? new Response(body(w, 25, 50), { status: 200, headers: { "content-length": "50", etag: '"w"' } })
      : new Response(null, { status: 416 });
  assert.deepEqual(await fileBytes(await drive(downloadModelResumable(other))), [...w]);
  assert.deepEqual(reqs.at(-1)!.headers, { Range: "bytes=50-", "If-Range": '"w"' });
  assert.equal(await isModelCached(other), true);

  // Deleting frees the bytes and the checkpoint.
  await deleteCachedModel(MODEL);
  assert.equal(await isModelCached(MODEL), false);
  assert.equal(await cachedBytes(MODEL), 0);
  assert.equal(await cachedModelFile(MODEL), null);
});

test("the CPU provider downloads weights resumably and loads those bytes; split GGUFs and no-OPFS browsers use wllama's own downloader [rr:PR-8]", async () => {
  installOpfs();
  const weights = bytes(64, 4);
  respond = () => new Response(body(weights, 16), { status: 200, headers: { "content-length": "64", etag: '"q"' } });

  // Download only (from the model manager's ↓): resumable store + progress.
  const progress: WllamaProgress[] = [];
  assert.equal(await isWllamaModelDownloaded(MODEL), false);
  await downloadWllamaModel(MODEL, (p) => progress.push(p));
  assert.deepEqual(progress.map((p) => [p.progress, p.text]), [
    [0.25, "Downloading…"],
    [0.5, "Downloading…"],
    [0.75, "Downloading…"],
    [1, "Downloading…"],
  ]);
  assert.equal(await isWllamaModelDownloaded(MODEL), true);
  assert.equal(wllamaFake.engines.length, 0, "downloading doesn't load the model");

  // Load: the engine gets the downloaded bytes — no second download.
  const loadProgress: WllamaProgress[] = [];
  await loadWllamaModel(MODEL, 4096, 0, (p) => loadProgress.push(p));
  const load = wllamaFake.last.loads[0]!;
  assert.equal(load.method, "loadModel");
  assert.equal(load.blobs.length, 1);
  assert.deepEqual(await fileBytes(load.blobs[0]!), [...weights]);
  assert.equal(reqs.length, 1);
  assert.deepEqual(loadProgress, [{ progress: 1, text: "Loading…" }]);
  assert.equal(isWllamaModelLoaded(MODEL), true);

  // Delete: unloads the active model and drops its cached bytes.
  await deleteWllamaModel(MODEL);
  assert.equal(isWllamaModelLoaded(MODEL), false);
  assert.equal(await isWllamaModelDownloaded(MODEL), false);

  // Split (multi-part) GGUFs go through wllama's own downloader + URL loader.
  await downloadWllamaModel(SPLIT, (p) => progress.push(p));
  assert.deepEqual(progress.at(-1), { progress: 0.5, text: "Downloading…" });
  assert.equal(await isWllamaModelDownloaded(SPLIT), true);
  assert.ok(wllamaFake.managerCache.has(SPLIT));
  await loadWllamaModel(SPLIT, 4096, 0);
  assert.equal(wllamaFake.last.loads[0]!.method, "loadModelFromUrl");
  assert.equal(wllamaFake.last.loads[0]!.url, SPLIT);
  assert.equal(reqs.length, 1, "nothing fetched through the resumable store");

  // A browser without OPFS falls back to wllama's downloader for any model.
  await unloadWllamaModel();
  setNavigator();
  await downloadWllamaModel(MODEL);
  assert.ok(wllamaFake.managerCache.has(MODEL));
  await loadWllamaModel(MODEL, 4096, 0);
  assert.equal(wllamaFake.last.loads[0]!.method, "loadModelFromUrl");
  assert.equal(reqs.length, 1);
});
