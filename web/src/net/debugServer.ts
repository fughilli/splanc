/**
 * The developer's debug server (tools/browser_server.py) — where the app ships
 * data to be pulled and analysed off-device: the effects library (`/effects`)
 * and the FX-agent chat logs (`/chatlogs`). One remembered URL, one POST path
 * that transparently picks the right transport:
 *
 *   - iOS native  → the WssBridge cert bridge (trusts the server's self-signed
 *                   cert automatically, exactly like a device socket — no manual
 *                   "open in a tab and accept the cert" dance).
 *   - browser PWA → plain `fetch`, which still needs that one-time cert accept.
 *
 * The URL is filled by scanning the server's QR (same flow for both payloads)
 * or typed in the "Connect debug server" sheet, and remembered in localStorage.
 */

import { nativeHttpAvailable, nativeRequest, type HttpResult } from "./nativeHttp";

const URL_KEY = "ledmapper.debugServer";

/** The remembered debug-server base URL (trailing slashes stripped), or "". */
export function debugServerUrl(): string {
  return (localStorage.getItem(URL_KEY) ?? "").replace(/\/+$/, "");
}

/** Remember a debug-server base URL (trailing slashes stripped). */
export function setDebugServerUrl(url: string): void {
  localStorage.setItem(URL_KEY, url.replace(/\/+$/, ""));
}

/** POST JSON to `<base><path>`. On iOS-native this trusts a self-signed cert via
 * the WssBridge; on the browser it's a plain fetch. Throws on a transport
 * failure (untrusted cert / mixed content / unreachable) so callers can show the
 * cert-accept hint. */
export function postJson(base: string, path: string, payload: unknown): Promise<HttpResult> {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (nativeHttpAvailable()) return nativeRequest(base + path, "POST", headers, body);
  return fetch(base + path, { method: "POST", headers, body }).then((res) => ({
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  }));
}

/** POST an already-serialized JSON body to `<base><path>` — for uploads whose
 * exact bytes matter (the server checksums them). Same transports and errors
 * as {@link postJson}. */
export function postJsonText(base: string, path: string, body: string): Promise<HttpResult> {
  const headers = { "Content-Type": "application/json" };
  if (nativeHttpAvailable()) return nativeRequest(base + path, "POST", headers, body);
  return fetch(base + path, { method: "POST", headers, body }).then((res) => ({
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  }));
}

/** GET `<base><path>` (native cert bridge or fetch). Used to poll the remote
 * chat-drive queue. Throws on a transport failure. */
export function getJson(base: string, path: string): Promise<HttpResult> {
  if (nativeHttpAvailable()) return nativeRequest(base + path, "GET", {});
  return fetch(base + path).then((res) => ({
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
  }));
}

// -- Connection status -------------------------------------------------------
// "Connected" means the last /ping succeeded. It's runtime state (reachability
// changes), so it lives in memory with a subscribe seam the UI observes; the URL
// itself is what persists.
type Listener = () => void;
let connected = false;
const listeners = new Set<Listener>();

export function debugServerConnected(): boolean {
  return connected;
}

export function subscribeDebugServer(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function setConnected(v: boolean): void {
  if (v === connected) return;
  connected = v;
  for (const fn of listeners) fn();
}

/** Health-check the configured server (`GET /ping`) and update connected state.
 * Never throws. */
export async function pingDebugServer(): Promise<boolean> {
  const base = debugServerUrl();
  if (!base) {
    setConnected(false);
    return false;
  }
  try {
    const res = await getJson(base, "/ping");
    setConnected(res.ok);
    return res.ok;
  } catch {
    setConnected(false);
    return false;
  }
}

/** Point at a server URL and verify it (ping). Returns whether it connected. */
export async function connectDebugServer(url: string): Promise<boolean> {
  setDebugServerUrl(url);
  return pingDebugServer();
}

// -- Diagnosed connect (the connect sheet) -------------------------------------
// The connect sheet needs to say *why* a connect failed, honestly: a browser
// `fetch` TypeError can mean an untrusted self-signed certificate, a blocked
// mixed-content request, or simply an unreachable host, and JS can't tell
// those apart. So the outcome distinguishes only what is actually knowable.

/** Why a debug-server connect failed.
 *  - `invalid-url`   the text isn't an http(s) URL (e.g. some other QR)
 *  - `mixed-content` an https page can't fetch an http:// server (known up front)
 *  - `timeout`       no answer within the timeout
 *  - `http`          the server answered /ping with a non-2xx status
 *  - `network`       a transport failure the platform doesn't explain further
 *                    (browser: cert not trusted / host unreachable / blocked)
 *  - `cancelled`     the caller aborted the attempt */
export type DebugServerFailureKind = "invalid-url" | "mixed-content" | "timeout" | "http" | "network" | "cancelled";

export type DebugServerProbe =
  | { ok: true; url: string }
  | { ok: false; url: string; kind: DebugServerFailureKind; status?: number; detail?: string };

/** Normalise a scanned/typed debug-server URL: trimmed, trailing slashes
 * stripped. Returns null when it isn't an absolute http(s) URL. */
export function normalizeDebugServerUrl(raw: string): string | null {
  const u = raw.trim().replace(/\/+$/, "");
  if (!u) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    if (!parsed.host) return null;
  } catch {
    return null;
  }
  return u;
}

/** Default /ping timeout for the connect sheet (a LAN server answers in ms). */
export const DEBUG_SERVER_PING_TIMEOUT_MS = 6000;

/** Probe `<url>/ping` and classify the result, without touching the remembered
 * URL or the connected state. Never throws. `timeoutMs` bounds the wait on
 * both transports; `signal` lets the caller cancel (the result is then
 * `cancelled`, and the caller should ignore it). */
export async function probeDebugServer(
  rawUrl: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DebugServerProbe> {
  const url = normalizeDebugServerUrl(rawUrl);
  if (url === null) return { ok: false, url: rawUrl.trim(), kind: "invalid-url" };
  const native = nativeHttpAvailable();
  const pageProto = (globalThis as { location?: { protocol?: string } }).location?.protocol;
  if (!native && pageProto === "https:" && url.startsWith("http:")) {
    return { ok: false, url, kind: "mixed-content" };
  }
  if (opts.signal?.aborted) return { ok: false, url, kind: "cancelled" };

  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  // Settles on whichever comes first: the request, the timeout, or the caller's
  // abort. The native bridge can't be aborted, so the race is what bounds it.
  const guard = new Promise<"timeout" | "cancelled">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      ctl?.abort();
      resolve("timeout");
    }, opts.timeoutMs ?? DEBUG_SERVER_PING_TIMEOUT_MS);
    onAbort = () => {
      cancelled = true;
      ctl?.abort();
      resolve("cancelled");
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const request: Promise<HttpResult> = native
    ? nativeRequest(url + "/ping", "GET", {})
    : fetch(url + "/ping", ctl ? { signal: ctl.signal } : {}).then((res) => ({
        ok: res.ok,
        status: res.status,
        text: () => res.text(),
      }));
  try {
    const res = await Promise.race([request, guard]);
    if (res === "timeout") return { ok: false, url, kind: "timeout" };
    if (res === "cancelled") return { ok: false, url, kind: "cancelled" };
    if (res.ok) return { ok: true, url };
    return { ok: false, url, kind: "http", status: res.status };
  } catch (e) {
    if (cancelled) return { ok: false, url, kind: "cancelled" };
    if (timedOut) return { ok: false, url, kind: "timeout" };
    return { ok: false, url, kind: "network", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (onAbort !== null) opts.signal?.removeEventListener("abort", onAbort);
    request.catch(() => undefined); // a late rejection after the race is not unhandled
  }
}

/** Connect-sheet connect: probe the URL and, only on success, remember it and
 * mark the server connected. A failed or cancelled attempt leaves the
 * remembered URL and connected state alone (so a stray QR can't clobber a
 * working configuration). */
export async function connectDebugServerDiagnosed(
  rawUrl: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DebugServerProbe> {
  const r = await probeDebugServer(rawUrl, opts);
  if (r.ok && !opts.signal?.aborted) {
    setDebugServerUrl(r.url);
    setConnected(true);
  }
  return r;
}
