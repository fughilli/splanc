// Share-with-fallback for the diagnostics archive (src/ui/shareFallback.ts):
// Chrome's file-share allowlist refuses .json.gz / application/gzip at share().

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chromiumShareable,
  describeShareError,
  describeShareOutcome,
  isChromium,
  shareCandidates,
  shareWithFallback,
  type ShareFile,
} from "../src/ui/shareFallback";

const gz: ShareFile = { blob: new Blob([new Uint8Array([0x1f, 0x8b, 1])]), name: "splanc-diagnostics-x.json.gz", mime: "application/gzip" };
const plain = new Blob(['{"format":"x"}'], { type: "application/json" });

const SAMSUNG_CHROME =
  "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36";
const IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IOS_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1";

/** Chrome's share(): refuses names/types off its allowlist with NotAllowedError. */
function chromeShare(log: string[]) {
  return async (d: ShareData): Promise<void> => {
    const f = d.files![0]!;
    log.push(`${f.name}|${f.type}`);
    if (!chromiumShareable(f.name) || !/^(text\/plain|text\/csv|application\/pdf|image\/)/.test(f.type)) {
      throw new DOMException("Permission denied", "NotAllowedError");
    }
  };
}

test("browser sniffing: Chrome on Android is Chromium; every iOS browser is WebKit", () => {
  assert.equal(isChromium(SAMSUNG_CHROME), true);
  assert.equal(isChromium("Mozilla/5.0 (Linux; Android 10) SamsungBrowser/27.0 Chrome/125.0 Mobile Safari/537.36"), true);
  assert.equal(isChromium(IOS_SAFARI), false);
  assert.equal(isChromium(IOS_CHROME), false);
  assert.equal(isChromium("x", [{ brand: "Chromium" }]), true);
});

test("Chromium's allowlist has no .gz / .json; .txt is on it", () => {
  assert.equal(chromiumShareable("a.json.gz"), false);
  assert.equal(chromiumShareable("a.json"), false);
  assert.equal(chromiumShareable("a.json.txt"), true);
  assert.equal(chromiumShareable("A.TXT"), true);
});

test("candidate order: a plain-text copy first on Chromium, the original first on WebKit", () => {
  const c = shareCandidates(gz, { chromium: true, plain });
  assert.deepEqual(
    c.map((f) => [f.name, f.mime]),
    [
      ["splanc-diagnostics-x.json.txt", "text/plain"],
      ["splanc-diagnostics-x.json.gz", "application/gzip"],
    ],
  );
  assert.equal(c[0]!.blob, plain);
  const w = shareCandidates(gz, { chromium: false, plain });
  assert.equal(w[0], gz);
  // No uncompressed copy: the same bytes under a .txt name.
  assert.equal(shareCandidates(gz, { chromium: true })[0]!.name, "splanc-diagnostics-x.json.gz.txt");
});

test("Chrome Android (the reported case): the .txt copy is shared, no title is passed", async () => {
  const log: string[] = [];
  const saved: string[] = [];
  const passed: ShareData[] = [];
  const share = chromeShare(log);
  const out = await shareWithFallback(gz, shareCandidates(gz, { chromium: true, plain }), {
    share: async (d) => {
      passed.push(d);
      await share(d);
    },
    canShare: () => true,
    save: async (f) => void saved.push(f.name),
  });
  assert.equal(out.kind, "shared");
  assert.equal(out.kind === "shared" && out.file.name, "splanc-diagnostics-x.json.txt");
  assert.deepEqual(log, ["splanc-diagnostics-x.json.txt|text/plain"]);
  assert.equal(passed[0]!.title, undefined);
  assert.deepEqual(saved, []);
  assert.match(describeShareOutcome(out, "to your Downloads"), /plain-text copy/);
});

test("the original refused with NotAllowedError → retried as .txt; the error is reported", async () => {
  const log: string[] = [];
  const errors: string[] = [];
  // canShare said yes, as in the bug report; the browser was not sniffed as Chromium.
  const out = await shareWithFallback(gz, shareCandidates(gz, { chromium: false, plain }), {
    share: chromeShare(log),
    canShare: () => true,
    save: async () => assert.fail("should not save"),
    onError: (d) => errors.push(d),
  });
  assert.equal(out.kind, "shared");
  assert.deepEqual(log, ["splanc-diagnostics-x.json.gz|application/gzip", "splanc-diagnostics-x.json.txt|text/plain"]);
  assert.deepEqual(errors, ["NotAllowedError: Permission denied"]);
  assert.match(describeShareOutcome(out, ""), /NotAllowedError: Permission denied/);
});

test("nothing shares → the original is saved and the status says where and why", async () => {
  const saved: string[] = [];
  const out = await shareWithFallback(gz, shareCandidates(gz, { chromium: true, plain }), {
    share: async () => {
      throw new DOMException("Must be handling a user gesture to perform a share request.", "NotAllowedError");
    },
    canShare: () => true,
    save: async (f) => void saved.push(f.name),
  });
  assert.equal(out.kind, "saved");
  assert.deepEqual(saved, ["splanc-diagnostics-x.json.gz"]);
  const text = describeShareOutcome(out, "to your Downloads");
  assert.match(text, /saved splanc-diagnostics-x\.json\.gz to your Downloads instead/);
  assert.match(text, /NotAllowedError: Must be handling a user gesture/);
});

test("a non-retryable error saves straight away; cancelling stops quietly; no share API saves", async () => {
  const tries: string[] = [];
  const saved: string[] = [];
  const out = await shareWithFallback(gz, shareCandidates(gz, { chromium: false, plain }), {
    share: async (d) => {
      tries.push(d.files![0]!.name);
      throw new DOMException("boom", "InvalidStateError");
    },
    canShare: () => true,
    save: async (f) => void saved.push(f.name),
  });
  assert.equal(out.kind, "saved");
  assert.equal(tries.length, 1);
  assert.deepEqual(saved, [gz.name]);

  const cancelled = await shareWithFallback(gz, [gz], {
    share: async () => {
      throw new DOMException("Share canceled", "AbortError");
    },
    canShare: () => true,
    save: async () => assert.fail("no save on cancel"),
  });
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(describeShareOutcome(cancelled, ""), "");

  const none: string[] = [];
  const noApi = await shareWithFallback(gz, [gz], { share: null, canShare: null, save: async (f) => void none.push(f.name) });
  assert.equal(noApi.kind, "saved");
  assert.deepEqual(none, [gz.name]);
});

test("canShare() saying no skips that candidate without calling share()", async () => {
  const tries: string[] = [];
  const out = await shareWithFallback(gz, shareCandidates(gz, { chromium: false, plain }), {
    share: async (d) => void tries.push(d.files![0]!.name),
    canShare: (d) => d.files![0]!.name.endsWith(".txt"),
    save: async () => assert.fail("no save"),
  });
  assert.equal(out.kind, "shared");
  assert.deepEqual(tries, ["splanc-diagnostics-x.json.txt"]);
  assert.equal(describeShareError(new TypeError("x")), "TypeError: x");
});
