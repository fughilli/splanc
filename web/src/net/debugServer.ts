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
  let u = (localStorage.getItem(URL_KEY) ?? "").replace(/\/+$/, "");
  // Tolerate a scheme-less URL (a QR/entry that dropped "https://") — otherwise
  // fetch treats it as a path relative to the app origin and never reaches the
  // debug server.
  if (u && !/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

/** Fire-and-forget a LIVE debug event to the connected debug server's /dbg ring
 * (no-op when no debug server is configured). DEBUG-SESSION instrumentation —
 * also mirrors to console.error, which the Vite dev server forwards to the
 * container log. Never throws. */
export function shipDbg(ev: Record<string, unknown>): void {
  const base = debugServerUrl();
  try {
    // eslint-disable-next-line no-console
    console.error("[DBG] " + JSON.stringify({ ...ev, _base: base || "(none)" }));
  } catch {
    /* ignore */
  }
  if (!base) return;
  try {
    void postJson(base, "/dbg", ev).catch(() => undefined);
  } catch {
    // ignore — best-effort telemetry
  }
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
