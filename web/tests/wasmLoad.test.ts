// The retrying wasm-bundle loader (src/fx/wasmLoad.ts): a transient download
// failure of the effect compiler must not poison every later compile.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compilerStatusText,
  compilerUnavailableToolResult,
  createRetryingLoader,
  retryUrl,
  WasmDownloadError,
  type WasmLoadStatus,
} from "../src/fx/wasmLoad";

const URL_JS = "https://splanc.io/app/fx-compiler/fx_compiler_wasm_pkg.js";
const FETCH_FAIL = `Failed to fetch dynamically imported module: ${URL_JS}`;

/** A fake `import()`: models Chrome's module map, where a URL that failed once
 * keeps failing (instantly, no network) for the document's lifetime. */
function fakeImporter(networkUpAfter: number) {
  const failedUrls = new Set<string>();
  const requested: string[] = [];
  let calls = 0;
  return {
    requested,
    load: async (attempt: number): Promise<string> => {
      const url = retryUrl(URL_JS, attempt);
      requested.push(url);
      if (failedUrls.has(url)) throw new TypeError(FETCH_FAIL);
      if (calls++ < networkUpAfter) {
        failedUrls.add(url);
        throw new TypeError(FETCH_FAIL);
      }
      return `module@${url}`;
    },
  };
}

function manualTimers() {
  const timers: { fn: () => void; ms: number }[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ fn, ms });
      return timers.length - 1;
    },
    clearTimer: (h: unknown) => {
      const t = timers[h as number];
      if (t) t.fn = () => undefined;
    },
  };
}

const noSleep = (): Promise<void> => Promise.resolve();

test("retryUrl: attempt 0 is the plain URL; later attempts get a fresh cache-busting key", () => {
  assert.equal(retryUrl(URL_JS, 0), URL_JS);
  assert.equal(retryUrl(URL_JS, 2), `${URL_JS}?retry=2`);
  assert.equal(retryUrl(`${URL_JS}?v=1`, 1), `${URL_JS}?v=1&retry=1`);
});

test("a transient first failure is retried with a new URL and recovers in the same call", async () => {
  const imp = fakeImporter(1);
  const statuses: WasmLoadStatus[] = [];
  const loader = createRetryingLoader({ load: imp.load, sleep: noSleep, onStatus: (s) => statuses.push(s) });
  assert.equal(await loader.get(), `module@${URL_JS}?retry=1`);
  assert.deepEqual(imp.requested, [URL_JS, `${URL_JS}?retry=1`]);
  assert.deepEqual(
    statuses.map((s) => s.phase),
    ["downloading", "retrying", "ready"],
  );
  assert.equal(statuses[2]!.recovered, true);
  assert.equal(loader.ready, true);
  // Cached once loaded: no more imports.
  await loader.get();
  assert.equal(imp.requested.length, 2);
});

test("a failed round rejects with WasmDownloadError, is not cached, and the next call retries fresh URLs", async () => {
  const imp = fakeImporter(4); // the whole first round (4 attempts) fails
  const t = manualTimers();
  const statuses: WasmLoadStatus[] = [];
  const loader = createRetryingLoader({
    load: imp.load,
    sleep: noSleep,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    onStatus: (s) => statuses.push(s),
  });
  await assert.rejects(loader.get(), (e: unknown) => e instanceof WasmDownloadError && e.message === FETCH_FAIL);
  const failed = statuses.at(-1)!;
  assert.equal(failed.phase, "failed");
  assert.equal(failed.nextRetryMs, 10_000);
  assert.equal(t.timers.length, 1, "a background retry is scheduled");

  // The old bug: every later compile failed instantly with the same cached error.
  const mod = await loader.get();
  assert.equal(mod, `module@${URL_JS}?retry=4`);
  assert.equal(new Set(imp.requested).size, imp.requested.length, "no URL is ever re-imported");
});

test("the background retry recovers without a caller, and later failed rounds back off", async () => {
  const imp = fakeImporter(8); // two full rounds fail
  const t = manualTimers();
  const statuses: WasmLoadStatus[] = [];
  const loader = createRetryingLoader({
    load: imp.load,
    sleep: noSleep,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    onStatus: (s) => statuses.push(s),
  });
  loader.warm(); // prefetch at screen open; never rejects
  await new Promise((r) => setImmediate(r));
  assert.equal(t.timers.at(-1)!.ms, 10_000);
  t.timers.at(-1)!.fn(); // background round 2 — fails too
  await new Promise((r) => setImmediate(r));
  assert.equal(t.timers.at(-1)!.ms, 30_000);
  t.timers.at(-1)!.fn(); // round 3 succeeds
  await new Promise((r) => setImmediate(r));
  assert.equal(loader.ready, true);
  const last = statuses.at(-1)!;
  assert.equal(last.phase, "ready");
  assert.equal(last.recovered, true);
});

test("concurrent callers share one in-flight load", async () => {
  const imp = fakeImporter(0);
  const loader = createRetryingLoader({ load: imp.load, sleep: noSleep });
  const [a, b] = await Promise.all([loader.get(), loader.get()]);
  assert.equal(a, b);
  assert.equal(imp.requested.length, 1);
});

test("dispose cancels a pending background retry", async () => {
  const imp = fakeImporter(100);
  const t = manualTimers();
  const loader = createRetryingLoader({ load: imp.load, sleep: noSleep, setTimer: t.setTimer, clearTimer: t.clearTimer });
  await assert.rejects(loader.get());
  const n = imp.requested.length;
  loader.dispose();
  t.timers.at(-1)!.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(imp.requested.length, n);
});

test("user-facing text says it's a download being retried, not a compile error", () => {
  assert.equal(compilerStatusText({ phase: "downloading", attempt: 0 }), "Downloading the effect compiler…");
  assert.match(compilerStatusText({ phase: "retrying", attempt: 1 })!, /Couldn't download the effect compiler — retrying/);
  assert.match(compilerStatusText({ phase: "failed", attempt: 3, error: "x", nextRetryMs: 10_000 })!, /retrying in 10 s/);
  assert.equal(compilerStatusText({ phase: "ready", attempt: 0 }), null);
  assert.equal(compilerStatusText({ phase: "ready", attempt: 2, recovered: true }), "Effect compiler downloaded.");
  const tool = compilerUnavailableToolResult(FETCH_FAIL);
  assert.match(tool, /^NOT a compile error/);
  assert.match(tool, /could not be downloaded/);
  assert.match(tool, /retrying/);
  assert.doesNotMatch(tool, /^Compiled OK/);
});
