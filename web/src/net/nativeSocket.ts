/**
 * Native WebSocket transport (docs/design/ios-support.md §4.3).
 *
 * On iOS the device's self-signed `wss://` cert can't be accepted from JS in a
 * WKWebView, so the control socket is opened natively by the `@splanc/wss-bridge`
 * Capacitor plugin (its URLSession delegate trusts the cert). This module adapts
 * that plugin to the `SocketLike` seam `LedMapperClient` already injects via
 * `SocketFactory`, so the whole client state machine runs unchanged — only the
 * transport underneath changes, exactly like the BLE Improv path.
 *
 * `@capacitor/core` and the plugin are loaded lazily (dynamic import inside the
 * factory), so the browser PWA bundle pulls in none of this; `nativeSocketFactory`
 * returns undefined off-native, and `LedMapperClient` falls back to `WebSocket`.
 */

import { isNativePlatform } from "./native";
import type { SocketFactory, SocketLike } from "./client";

interface WssEvent {
  id: string;
  type: "open" | "message" | "close" | "error";
  data?: string; // base64 (binary) or the raw string (text)
  binary?: boolean;
  code?: number;
  message?: string;
}

interface WssBridgePlugin {
  connect(opts: { url: string }): Promise<{ id: string }>;
  send(opts: { id: string; data: string; binary: boolean }): Promise<void>;
  close(opts: { id: string }): Promise<void>;
  addListener(event: "wssEvent", cb: (e: WssEvent) => void): Promise<{ remove(): Promise<void> }>;
}

// Bind to the native plugin lazily. `@capacitor/core` is dynamically imported so
// it never enters the PWA bundle (this file is reached only when the factory is
// used on-native); registerPlugin returns a proxy backed by the global Capacitor
// bridge that only dispatches to native when a method is actually called. The
// proxy is cached in `bridge` once resolved, so the synchronous send()/close()
// paths (only reached after a socket has connected) can use it directly.
let bridgeP: Promise<WssBridgePlugin> | null = null;
let bridge: WssBridgePlugin | null = null;
function getBridge(): Promise<WssBridgePlugin> {
  if (!bridgeP) {
    bridgeP = import("@capacitor/core").then(({ registerPlugin }) => {
      bridge = registerPlugin<WssBridgePlugin>("WssBridge");
      return bridge;
    });
  }
  return bridgeP;
}

// One shared event listener dispatches `wssEvent`s by socket id. Events can arrive
// before connect() resolves and we map the id, so buffer any for unknown ids and
// drain them on registration.
const sockets = new Map<string, NativeSocket>();
const buffered = new Map<string, WssEvent[]>();
let listenP: Promise<void> | null = null;
function ensureListener(): Promise<void> {
  if (!listenP) {
    listenP = getBridge()
      .then((b) =>
        b.addListener("wssEvent", (e) => {
          const s = sockets.get(e.id);
          if (s) s.handle(e);
          else {
            const q = buffered.get(e.id) ?? [];
            q.push(e);
            buffered.set(e.id, q);
          }
        }),
      )
      .then(() => undefined);
  }
  return listenP;
}
function registerSocket(id: string, s: NativeSocket): void {
  sockets.set(id, s);
  const q = buffered.get(id);
  if (q) {
    buffered.delete(id);
    for (const e of q) s.handle(e);
  }
}

const SOCK_CONNECTING = 0;
const SOCK_OPEN = 1;
const SOCK_CLOSED = 3;

class NativeSocket implements SocketLike {
  readyState = SOCK_CONNECTING;
  binaryType = "arraybuffer";
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  private id: string | null = null;
  private closed = false;

  constructor(url: string) {
    void (async () => {
      try {
        const b = await getBridge();
        await ensureListener();
        const { id } = await b.connect({ url });
        this.id = id;
        if (this.closed) {
          // close() was called while connecting — tear the native socket down.
          void b.close({ id });
          return;
        }
        registerSocket(id, this);
      } catch (e) {
        this.readyState = SOCK_CLOSED;
        this.onerror?.({ message: e instanceof Error ? e.message : String(e) });
        this.onclose?.({});
      }
    })();
  }

  /** Dispatch a native event onto the WebSocket-shaped callbacks. */
  handle(e: WssEvent): void {
    switch (e.type) {
      case "open":
        this.readyState = SOCK_OPEN;
        this.onopen?.({});
        break;
      case "message":
        this.onmessage?.({ data: e.binary ? b64ToBytes(e.data ?? "") : (e.data ?? "") });
        break;
      case "error":
        this.onerror?.({ message: e.message });
        break;
      case "close":
        if (this.closed) break;
        this.closed = true;
        this.readyState = SOCK_CLOSED;
        if (this.id) sockets.delete(this.id);
        this.onclose?.({ code: e.code });
        break;
    }
  }

  send(data: string | Uint8Array): void {
    // The client only sends after onopen, so id (and thus the bridge) is set.
    if (this.id == null || !bridge) return;
    if (typeof data === "string") void bridge.send({ id: this.id, data, binary: false });
    else void bridge.send({ id: this.id, data: bytesToB64(data), binary: true });
  }

  close(): void {
    this.closed = true;
    this.readyState = SOCK_CLOSED;
    if (this.id && bridge) {
      const id = this.id;
      sockets.delete(id);
      void bridge.close({ id });
    }
  }
}

/** SocketFactory backed by the native bridge — or undefined off-native, so the
 * client uses the browser `WebSocket`. Inject into ClientOptions.socketFactory. */
export function nativeSocketFactory(): SocketFactory | undefined {
  if (!isNativePlatform()) return undefined;
  return (url: string) => new NativeSocket(url);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(u8: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]!);
  return btoa(s);
}
