/**
 * #454: the debug-server connect sheet must not re-attempt (and re-toast) the
 * same failed QR on every 150 ms scan tick. Drives the real
 * openDebugServerConnect() against the fake DOM with an injected camera,
 * decoder and connect call; and probeDebugServer()'s failure classification
 * against a stubbed fetch.
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import { installFakeDom } from "./fakeDom";

const dom = installFakeDom();
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import {
  connectDebugServerDiagnosed,
  debugServerConnected,
  debugServerUrl,
  normalizeDebugServerUrl,
  probeDebugServer,
  setDebugServerUrl,
  type DebugServerProbe,
} from "../src/net/debugServer";
import {
  describeConnectFailure,
  openDebugServerConnect,
  type DebugServerConnectDeps,
  type DebugServerConnectHandle,
} from "../src/ui/screens/debugServerConnect";

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
}

const SCAN_MS = 150;
const GOOD = "https://192.168.1.20:8093";
const OTHER = "https://192.168.1.21:8093";

interface Harness {
  h: DebugServerConnectHandle;
  calls: string[];
  /** What the decoder "sees" this tick (null = no QR in frame). */
  setVisible(payload: string | null): void;
  /** Resolve or reject the currently pending connect. */
  resolveNext(r: DebugServerProbe | Error): void;
  pendingCount(): number;
  stopped: () => boolean;
  signals: AbortSignal[];
}

function toasts(): string[] {
  return dom.document.querySelectorAll(".k-toast").map((t) => t.textContent ?? "");
}

function q(h: DebugServerConnectHandle, sel: string): HTMLElement {
  const el = (h.overlay as unknown as { querySelector(s: string): HTMLElement | null }).querySelector(sel);
  assert.ok(el, `missing ${sel}`);
  return el;
}

async function open(extra: Partial<DebugServerConnectDeps> = {}): Promise<Harness> {
  let visible: string | null = null;
  const calls: string[] = [];
  const signals: AbortSignal[] = [];
  const waiters: Array<(r: DebugServerProbe | Error) => void> = [];
  let trackStopped = false;
  const stream = { getTracks: () => [{ stop: () => (trackStopped = true) }] } as unknown as MediaStream;
  const h = openDebugServerConnect({
    native: false,
    scanMs: SCAN_MS,
    getUserMedia: async () => stream,
    loadDecoder: async () => () => (visible === null ? null : { data: visible }),
    connect: (url, opts) => {
      calls.push(url);
      if (opts?.signal) signals.push(opts.signal);
      return new Promise<DebugServerProbe>((res, rej) => {
        waiters.push((r) => (r instanceof Error ? rej(r) : res(r)));
      });
    },
    ...extra,
  });
  const video = q(h, ".qrscan-video") as unknown as Record<string, unknown>;
  video["readyState"] = 4;
  video["videoWidth"] = 8;
  video["videoHeight"] = 8;
  video["play"] = async () => undefined;
  await settle();
  return {
    h,
    calls,
    signals,
    setVisible: (p) => (visible = p),
    resolveNext: (r) => {
      const w = waiters.shift();
      assert.ok(w, "no pending connect");
      w(r);
    },
    pendingCount: () => waiters.length,
    stopped: () => trackStopped,
  };
}

async function ticks(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    mock.timers.tick(SCAN_MS);
    await settle();
  }
}

const netFail = (url: string): DebugServerProbe => ({ ok: false, url, kind: "network", detail: "Failed to fetch" });

beforeEach(() => {
  dom.document.body.replaceChildren();
  localStorage.clear();
});
afterEach(() => {
  for (const o of dom.document.querySelectorAll(".qrscan")) o.remove();
});

test("a failed QR that stays in frame is attempted once, with one stable panel and no toast flood", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  assert.deepEqual(t.calls, [GOOD]);
  assert.match(q(t.h, ".qrscan-hint").textContent ?? "", /Connecting/);
  // While pending, further ticks don't start another attempt.
  await ticks(3);
  assert.equal(t.calls.length, 1);
  t.resolveNext(netFail(GOOD));
  await settle();
  // Seven more scan ticks with the same QR in view (the issue's repro).
  await ticks(7);
  assert.equal(t.calls.length, 1, "same failed payload must not be re-attempted");
  assert.equal(toasts().length, 0, "failure is shown in the panel, not a toast per tick");
  const fail = q(t.h, ".dbgconn-fail");
  assert.equal(fail.hidden, false);
  assert.match(fail.textContent ?? "", /Couldn't reach 192\.168\.1\.20:8093/);
  assert.match(q(t.h, ".qrscan-hint").textContent ?? "", /Retry, change the URL/);
  t.h.close();
});

test("explicit Retry re-attempts the failed URL; success closes the sheet", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  t.resolveNext(netFail(GOOD));
  await settle();
  const retry = q(t.h, ".dbgconn-retry") as HTMLButtonElement;
  retry.click();
  retry.click(); // repeated clicks while pending are ignored
  assert.equal(t.calls.length, 2);
  assert.equal(retry.disabled, true);
  t.resolveNext({ ok: true, url: GOOD });
  await settle();
  assert.equal(t.h.closed, true);
  assert.equal(t.stopped(), true, "camera stopped on success");
  assert.deepEqual(toasts(), ["Connected to 192.168.1.20:8093"]);
});

test("a different QR is still usable after a failure", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  t.resolveNext(netFail(GOOD));
  await settle();
  t.setVisible(OTHER);
  await ticks(1);
  assert.deepEqual(t.calls, [GOOD, OTHER]);
  t.resolveNext({ ok: true, url: OTHER });
  await settle();
  assert.equal(t.h.closed, true);
});

test("moving away and back to the failed QR does not auto-retry (Retry is explicit)", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  t.resolveNext(netFail(GOOD));
  await settle();
  t.setVisible(null);
  await ticks(10);
  t.setVisible(GOOD);
  await ticks(5);
  assert.equal(t.calls.length, 1);
  t.h.close();
});

test("an unrecognised QR is reported as such and never connected to", async () => {
  const t = await open();
  t.setVisible("WIFI:S:home;T:WPA;P:secret;;");
  await ticks(5);
  assert.equal(t.calls.length, 0);
  assert.match(q(t.h, ".qrscan-hint").textContent ?? "", /isn't a debug-server URL/);
  assert.equal(q(t.h, ".dbgconn-fail").hidden, true, "decoded-but-unreachable panel is not shown");
  t.h.close();
});

test("Change URL opens the drawer prefilled with the failed URL", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  t.resolveNext(netFail(GOOD));
  await settle();
  q(t.h, ".dbgconn-change").click();
  assert.ok(q(t.h, ".dbgconn-drawer").classList.contains("open"));
  assert.equal((q(t.h, ".dbgconn-input") as HTMLInputElement).value, GOOD);
  t.h.close();
});

test("cancel during a pending attempt aborts it; a late result changes nothing", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  assert.equal(t.signals[0]?.aborted, false);
  q(t.h, ".dbgconn-cancel").click();
  assert.equal(t.h.closed, true);
  assert.equal(t.signals[0]?.aborted, true, "pending connect is aborted");
  assert.equal(t.stopped(), true);
  // The connect resolves late (both outcomes): no toasts, no further scanning.
  t.resolveNext(netFail(GOOD));
  await ticks(5);
  assert.equal(toasts().length, 0);
  assert.equal(t.calls.length, 1);
  assert.equal(dom.document.querySelectorAll(".qrscan").length, 0);
});

test("a late success after close does not toast", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  t.h.close();
  t.resolveNext({ ok: true, url: GOOD });
  await settle();
  assert.equal(toasts().length, 0);
});

test("a thrown connect is handled like a network failure", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  t.resolveNext(new Error("boom"));
  await settle();
  assert.equal(q(t.h, ".dbgconn-fail").hidden, false);
  await ticks(3);
  assert.equal(t.calls.length, 1);
  t.h.close();
});

test("close and reopen starts fresh (the failed-URL suppression is per sheet)", async () => {
  const a = await open();
  a.setVisible(GOOD);
  await ticks(1);
  a.resolveNext(netFail(GOOD));
  await settle();
  a.h.close();
  const b = await open();
  b.setVisible(GOOD);
  await ticks(1);
  assert.deepEqual(b.calls, [GOOD]);
  b.h.close();
});

test("manual URL Connect failure shows the panel; Enter while pending is ignored", async () => {
  const t = await open({ getUserMedia: null });
  assert.ok(q(t.h, ".dbgconn-drawer").classList.contains("open"), "no camera → drawer");
  const input = q(t.h, ".dbgconn-input") as HTMLInputElement;
  input.value = GOOD + "/";
  q(t.h, ".dbgconn-go").click();
  q(t.h, ".dbgconn-go").click();
  assert.deepEqual(t.calls, [GOOD + "/"]);
  t.resolveNext({ ok: false, url: GOOD, kind: "timeout" });
  await settle();
  assert.match(q(t.h, ".dbgconn-fail").textContent ?? "", /No answer from/);
  t.h.close();
});

// -- failure descriptions ------------------------------------------------------

test("failure copy is honest about what is known", () => {
  const net = describeConnectFailure({ ok: false, url: GOOD, kind: "network" }, false);
  assert.match(net.detail, /certificate isn't trusted yet, or the phone can't reach/);
  assert.equal(net.healthCheck, true);
  const nativeNet = describeConnectFailure({ ok: false, url: GOOD, kind: "network" }, true);
  assert.doesNotMatch(nativeNet.detail, /certificate/, "native trusts the cert itself");
  assert.equal(nativeNet.healthCheck, false);
  const http = describeConnectFailure({ ok: false, url: GOOD, kind: "http", status: 404 }, false);
  assert.match(http.title, /HTTP 404/);
  assert.doesNotMatch(http.detail, /certificate/);
  const timeout = describeConnectFailure({ ok: false, url: GOOD, kind: "timeout" }, false);
  assert.doesNotMatch(timeout.detail, /certificate/);
  const mixed = describeConnectFailure({ ok: false, url: "http://x:1", kind: "mixed-content" }, false);
  assert.match(mixed.detail, /https/);
});

test("the health-check link points at the same-browser /ping (no TLS bypass)", async () => {
  const t = await open();
  t.setVisible(GOOD);
  await ticks(1);
  t.resolveNext(netFail(GOOD));
  await settle();
  const link = q(t.h, ".dbgconn-health") as HTMLAnchorElement;
  assert.equal(link.hidden, false);
  assert.equal(link.getAttribute("href"), GOOD + "/ping");
  assert.equal(link.getAttribute("target"), "_blank");
  t.h.close();
});

// -- probeDebugServer classification ------------------------------------------

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("normalizeDebugServerUrl accepts only http(s) URLs", () => {
  assert.equal(normalizeDebugServerUrl(" https://h:1/// "), "https://h:1");
  assert.equal(normalizeDebugServerUrl("WIFI:S:x;;"), null);
  assert.equal(normalizeDebugServerUrl("ftp://h"), null);
  assert.equal(normalizeDebugServerUrl(""), null);
});

test("probe: immediate rejection → network; HTTP error → http; success → ok", async () => {
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  assert.deepEqual(await probeDebugServer(GOOD), { ok: false, url: GOOD, kind: "network", detail: "Failed to fetch" });
  globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
  const r = await probeDebugServer(GOOD);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.kind, "http");
  assert.equal(!r.ok && r.status, 404);
  let hit = "";
  globalThis.fetch = (async (u: string) => {
    hit = u;
    return new Response("pong");
  }) as unknown as typeof fetch;
  assert.deepEqual(await probeDebugServer(GOOD + "/"), { ok: true, url: GOOD });
  assert.equal(hit, GOOD + "/ping");
});

test("probe: a hung request times out (and the fetch is aborted)", async () => {
  let signal: AbortSignal | undefined;
  globalThis.fetch = ((_u: string, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise(() => undefined);
  }) as unknown as typeof fetch;
  const p = probeDebugServer(GOOD, { timeoutMs: 1000 });
  mock.timers.tick(1000);
  const r = await p;
  assert.equal(!r.ok && r.kind, "timeout");
  assert.equal(signal?.aborted, true);
});

test("probe: caller abort → cancelled", async () => {
  globalThis.fetch = (() => new Promise(() => undefined)) as unknown as typeof fetch;
  const ctl = new AbortController();
  const p = probeDebugServer(GOOD, { signal: ctl.signal });
  ctl.abort();
  const r = await p;
  assert.equal(!r.ok && r.kind, "cancelled");
});

test("probe: invalid URL and mixed content are known up front (no request)", async () => {
  let n = 0;
  globalThis.fetch = (async () => {
    n++;
    return new Response("");
  }) as typeof fetch;
  const bad = await probeDebugServer("hello");
  assert.equal(!bad.ok && bad.kind, "invalid-url");
  const loc = (globalThis as { location?: { protocol?: string } }).location;
  const prev = loc?.protocol;
  if (loc) loc.protocol = "https:";
  const mixed = await probeDebugServer("http://192.168.1.20:8093");
  if (loc) loc.protocol = prev ?? "https:";
  assert.equal(!mixed.ok && mixed.kind, "mixed-content");
  assert.equal(n, 0);
});

test("diagnosed connect remembers the URL only on success", async () => {
  setDebugServerUrl(OTHER);
  globalThis.fetch = (async () => {
    throw new TypeError("Failed to fetch");
  }) as typeof fetch;
  await connectDebugServerDiagnosed(GOOD);
  assert.equal(debugServerUrl(), OTHER, "a failed QR doesn't clobber a working URL");
  globalThis.fetch = (async () => new Response("pong")) as typeof fetch;
  await connectDebugServerDiagnosed(GOOD);
  assert.equal(debugServerUrl(), GOOD);
  assert.equal(debugServerConnected(), true);
});
