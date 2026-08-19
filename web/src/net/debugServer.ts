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
