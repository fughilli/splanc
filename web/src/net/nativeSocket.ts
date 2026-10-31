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
 * The plugin is bound through the injected Capacitor global (registerNativePlugin,
 * no @capacitor/core import), so the browser PWA bundle pulls in none of this;
 * `nativeSocketFactory` returns undefined off-native, and `LedMapperClient` falls
 * back to `WebSocket`.
 */

import { isNativePlatform, registerNativePlugin } from "./native";
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

// Bind to the native plugin via the injected Capacitor global (see
// registerNativePlugin) — synchronously, and cached. registerPlugin returns a
// proxy that only dispatches to native when a method is actually called, so this
// is cheap. (Reached only on-native: nativeSocketFactory gates on
// isNativePlatform.)
let bridge: WssBridgePlugin | null = null;
function wssBridge(): WssBridgePlugin {
  if (!bridge) bridge = registerNativePlugin<WssBridgePlugin>("WssBridge");
  return bridge;
}

// One shared event listener dispatches `wssEvent`s by socket id. Events can arrive
// before connect() resolves and we map the id, so buffer any for unknown ids and
// drain them on registration.
const sockets = new Map<string, NativeSocket>();
const buffered = new Map<string, WssEvent[]>();
let listenP: Promise<void> | null = null;
function ensureListener(): Promise<void> {
  if (!listenP) {
    listenP = wssBridge()
      .addListener("wssEvent", (e) => {
        const s = sockets.get(e.id);
        if (s) s.handle(e);
        else {
          const q = buffered.get(e.id) ?? [];
          q.push(e);
          buffered.set(e.id, q);
        }
      })
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
  // Bytes handed to the native bridge whose send hasn't completed yet — the
  // WebSocket.bufferedAmount equivalent. URLSessionWebSocketTask queues sends
  // without bound, so the live-control channel reads this to stay off the queue
  // while bulk traffic (an upload, a texture stream) is still leaving.
  private inFlightBytes = 0;

  get bufferedAmount(): number {
    return this.inFlightBytes;
  }

  constructor(url: string) {
    void (async () => {
      try {
        // URLSession's webSocketTask throws an Objective-C exception (an app
        // abort, not a JS error) for any scheme but ws/wss, so reject here. After
        // a tick: the caller attaches onerror/onclose once this constructor returns.
        if (!/^wss?:\/\//i.test(url)) {
          await Promise.resolve();
          throw new Error(`not a WebSocket URL: ${url}`);
        }
        const b = wssBridge();
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
    // The client only sends after onopen, so id is set.
    if (this.id == null) return;
    const b = wssBridge();
    const n = typeof data === "string" ? data.length : data.byteLength;
    this.inFlightBytes += n;
    const sent =
      typeof data === "string"
        ? b.send({ id: this.id, data, binary: false })
        : b.send({ id: this.id, data: bytesToB64(data), binary: true });
    const settle = (): void => {
      this.inFlightBytes = Math.max(0, this.inFlightBytes - n);
    };
    void sent.then(settle, settle);
  }

  close(): void {
    this.closed = true;
    this.readyState = SOCK_CLOSED;
    if (this.id) {
      const id = this.id;
      sockets.delete(id);
      void wssBridge().close({ id });
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
