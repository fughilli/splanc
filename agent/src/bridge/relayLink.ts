/**
 * The bridge's OUTBOUND WebSocket to the relay (no inbound ports: works behind
 * NAT). Registers the bridge's key on first use, connects with a signed
 * timestamp, reconnects with capped exponential backoff + jitter, and watches
 * liveness (protocol pings, with the relay's auto-answered "ping" text as a
 * fallback) so a half-open connection is noticed within ~90 s.
 */

import WebSocket from "ws";

import {
  BRIDGE_AUTH_HEADER,
  CLOSE_REPLACED,
  CONNECT_BAD_SIGNATURE,
  CONNECT_UNKNOWN_BRIDGE,
  PING,
  PONG,
  connectMessage,
  registerMessage,
  type BridgeFrame,
  type HelloFrame,
  type Pairing,
  type RelayFrame,
} from "../../relay/src/protocol";
import type { BridgeIdentity } from "./identity";

/**
 * The relay a bridge uses when neither --relay nor SPLANC_RELAY names one: the
 * deployed Splanc relay Worker (agent/relay/deploy.sh prints its workers.dev URL).
 */
export const DEFAULT_RELAY_URL = "https://splanc-relay.kbalke.workers.dev";

/** --relay, else $SPLANC_RELAY (the Pi appliance's bridge.env), else the default. */
export function relayUrl(flagValue: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  return (flagValue || env["SPLANC_RELAY"] || env["SPLANC_RELAY_URL"] || DEFAULT_RELAY_URL).replace(/\/+$/, "");
}

export type LinkPhase = "starting" | "connecting" | "online" | "offline" | "error";

export interface Backoff {
  baseMs: number;
  maxMs: number;
}

export interface RelayLinkOptions {
  relay: string;
  identity: BridgeIdentity;
  log?: (...a: unknown[]) => void;
  backoff?: Backoff;
  /** Backoff after another bridge with this identity took the connection over
   * (close 4001): default 5 min doubling to 1 h, so two copies of one bridge.json
   * don't evict each other every second (each connect is a billed relay request). */
  replacedBackoff?: Backoff;
  /** Liveness check interval (default 30 s). */
  pingMs?: number;
  /** Seconds since the epoch (tests). */
  nowS?: () => number;
}

/** Delay before reconnect attempt `n` (0-based): base * 2^n, capped, ±20 % jitter. */
export function backoffDelay(n: number, b: Backoff, rand = Math.random): number {
  const d = Math.min(b.maxMs, b.baseMs * 2 ** Math.min(n, 20));
  return Math.round(d * (0.8 + 0.4 * rand()));
}

export class RelayLink {
  phase: LinkPhase = "starting";
  lastError: string | null = null;
  hello: HelloFrame | null = null;
  credentials = 0;
  pairing: Pairing | null = null;
  /** Reconnect attempts since the last good connection. */
  attempts = 0;
  /** Successful connections so far (tests). */
  connects = 0;
  /** Times another connection for this bridge id replaced ours. */
  replaced = 0;
  onFrame: (f: RelayFrame) => void = () => undefined;
  onChange: () => void = () => undefined;

  readonly relay: string;
  private ws: WebSocket | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private lastRx = 0;
  private readonly log: (...a: unknown[]) => void;
  private readonly backoff: Backoff;
  private readonly replacedBackoff: Backoff;
  private readonly pingMs: number;
  private readonly nowS: () => number;

  constructor(private readonly opts: RelayLinkOptions) {
    this.relay = opts.relay.replace(/\/+$/, "");
    this.log = opts.log ?? (() => undefined);
    this.backoff = opts.backoff ?? { baseMs: 1000, maxMs: 60_000 };
    this.replacedBackoff = opts.replacedBackoff ?? { baseMs: 5 * 60_000, maxMs: 60 * 60_000 };
    this.pingMs = opts.pingMs ?? 30_000;
    this.nowS = opts.nowS ?? (() => Math.floor(Date.now() / 1000));
  }

  get bridgeId(): string | undefined {
    return this.opts.identity.bridgeId(this.relay);
  }

  get online(): boolean {
    return this.phase === "online";
  }

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopPinger();
    this.ws?.terminate();
    this.ws = null;
  }

  /** Send a frame; false when not connected. */
  send(f: BridgeFrame): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.phase !== "online") return false;
    this.ws.send(JSON.stringify(f));
    return true;
  }

  private set(phase: LinkPhase, error: string | null = this.lastError): void {
    this.phase = phase;
    this.lastError = error;
    this.onChange();
  }

  private async register(): Promise<string> {
    const ts = this.nowS();
    const pub = this.opts.identity.publicKey;
    const r = await fetch(`${this.relay}/bridge/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_key: pub, ts, sig: this.opts.identity.sign(registerMessage(pub, ts)) }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json().catch(() => ({}))) as { bridge_id?: string; error?: string };
    if (!r.ok || !j.bridge_id) throw new Error(`registration refused (${r.status}): ${j.error ?? "no bridge id"}`);
    this.opts.identity.setBridgeId(this.relay, j.bridge_id);
    this.log(`registered with ${this.relay} as bridge ${j.bridge_id}`);
    return j.bridge_id;
  }

  private retry(why: string, delayMs?: number): void {
    this.stopPinger();
    this.ws = null;
    this.hello = null;
    if (this.stopped) return;
    const d = delayMs ?? backoffDelay(this.attempts++, this.backoff);
    this.set("offline", why);
    this.log(`relay: ${why}; retrying in ${d >= 60_000 ? `${(d / 60_000).toFixed(1)} min` : `${(d / 1000).toFixed(1)} s`}`);
    this.timer = setTimeout(() => void this.connect(), d);
    this.timer.unref?.();
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.timer = null;
    if (this.phase !== "starting") this.set("connecting");
    let bid = this.bridgeId;
    try {
      if (!bid) bid = await this.register();
    } catch (e) {
      this.retry((e as Error).message);
      return;
    }
    const ts = this.nowS();
    const url = `${this.relay.replace(/^http/, "ws")}/bridge/connect?id=${bid}`;
    const ws = new WebSocket(url, {
      headers: { [BRIDGE_AUTH_HEADER]: `${ts}.${this.opts.identity.sign(connectMessage(bid, ts))}` },
      handshakeTimeout: 15_000,
      maxPayload: 32 * 1024 * 1024,
    });
    this.ws = ws;
    let settled = false;
    ws.on("unexpected-response", (_req, res) => {
      settled = true;
      const status = res.statusCode ?? 0;
      res.resume();
      ws.terminate();
      if (status === CONNECT_UNKNOWN_BRIDGE) {
        // The relay forgot us (or this is a different relay): register again, now.
        this.opts.identity.forget(this.relay);
        this.log(`relay doesn't know bridge ${bid}: registering again`);
        this.ws = null;
        void this.connect();
        return;
      }
      this.retry(
        status === CONNECT_BAD_SIGNATURE
          ? "relay rejected the bridge signature (is this machine's clock right?)"
          : `relay refused the connection (HTTP ${status})`,
      );
    });
    ws.on("open", () => {
      this.lastRx = Date.now();
      this.startPinger(ws);
    });
    ws.on("pong", () => (this.lastRx = Date.now()));
    ws.on("message", (data, isBinary) => {
      this.lastRx = Date.now();
      if (isBinary) return;
      const text = data.toString();
      if (text === PONG) return;
      let f: RelayFrame;
      try {
        f = JSON.parse(text) as RelayFrame;
      } catch {
        return;
      }
      if (f.t === "hello") {
        this.hello = f;
        this.credentials = f.credentials;
        this.pairing = f.pairing;
        this.attempts = 0;
        this.connects++;
        this.set("online", null);
        this.log(`connected to ${f.relay} as bridge ${f.bridge_id} (${f.credentials} credential(s))`);
      } else if (f.t === "state") {
        this.credentials = f.credentials;
        this.pairing = f.pairing;
        this.onChange();
      }
      this.onFrame(f);
    });
    ws.on("close", (code, reason) => {
      if (this.ws !== ws || settled) return;
      settled = true;
      if (code === CLOSE_REPLACED) {
        // A live process connected as this bridge (a half-open old socket of ours
        // would never hear this close). Reconnecting right away would evict it, and
        // it us, about once a second, forever: back off for minutes instead.
        this.retry(
          "another bridge using this identity connected (is bridge.json copied to a second machine? stop one of them)",
          backoffDelay(this.replaced++, this.replacedBackoff),
        );
        return;
      }
      this.retry(`connection closed (${code}${reason.length ? ` ${reason.toString()}` : ""})`);
    });
    ws.on("error", (e) => {
      if (this.ws !== ws || settled) return;
      // A close follows an open socket's error; a failed handshake only errors.
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.CLOSED) {
        settled = true;
        ws.terminate();
        this.retry(`can't reach the relay: ${e.message}`);
      }
    });
  }

  private startPinger(ws: WebSocket): void {
    this.stopPinger();
    this.pinger = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const idle = Date.now() - this.lastRx;
      if (idle > 3 * this.pingMs) {
        this.log("relay: no traffic for a while, reconnecting");
        ws.terminate();
        return;
      }
      ws.ping();
      // Belt and braces where protocol pongs don't come back: the relay
      // auto-answers this text without waking (or billing) the Durable Object.
      if (idle > 2 * this.pingMs) ws.send(PING);
    }, this.pingMs);
    this.pinger.unref?.();
  }

  private stopPinger(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }
}
