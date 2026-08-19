/**
 * Native cert-trusting HTTP, via the SAME bridge that opens device WebSockets
 * (net/nativeSocket.ts / the WssBridge plugin). A LAN debug server presents a
 * self-signed cert; in the browser PWA a `fetch()` to it is rejected until the
 * user opens the URL in a tab and accepts the cert, but inside the iOS wrapper
 * the WKWebView's fetch can't be taught to trust it at all. The WssBridge
 * plugin's URLSession delegate already trusts self-signed certs for the sockets
 * it opens (docs/design/ios-support.md §4.3); this exposes its one-shot
 * `httpRequest` so the same trust applies to an HTTPS POST.
 *
 * Only valid on-native — callers gate on {@link nativeHttpAvailable}.
 */

import { isNativePlatform, registerNativePlugin } from "./native";

interface WssBridgeHttp {
  httpRequest(opts: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }>;
}

let plugin: WssBridgeHttp | null = null;
function bridge(): WssBridgeHttp {
  if (plugin === null) plugin = registerNativePlugin<WssBridgeHttp>("WssBridge");
  return plugin;
}

/** A minimal fetch-Response-like shape so callers can treat native + web alike. */
export interface HttpResult {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** True when the native cert-trusting HTTP path is available (iOS wrapper). */
export function nativeHttpAvailable(): boolean {
  return isNativePlatform();
}

/** Request via the native WssBridge — trusts the server's self-signed cert, so
 * no manual browser cert-accept is needed. Rejects only on a transport error. */
export async function nativeRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResult> {
  const res = await bridge().httpRequest({ url, method, headers, ...(body !== undefined ? { body } : {}) });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    text: async () => res.body,
  };
}
