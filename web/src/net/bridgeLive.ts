/**
 * The app's side of live VJ through a Splanc bridge (docs/design/live-vj-relay.md).
 *
 * One {@link BridgeLiveClient} holds ONE live socket to the bridge, either
 *   - through the relay: `wss://<relay>/live` (works from anywhere), or
 *   - directly: `wss://<bridge LAN IP>:8443/live` (same network; ~one LAN hop,
 *     no relay round trip and no relay billing),
 * and drives every fixture the bridge holds. It prefers the direct path when the
 * bridge advertises one and it answers, and falls back to the relay otherwise.
 *
 * Controls (sliders, faders) go through {@link control}: coalesced per tick
 * (leading edge, then at most one frame per `tick_ms`: ~30 Hz via the relay,
 * ~60 Hz direct), carrying every control that changed — so a fast two-finger
 * drag is still ≤ 30 relay messages/s. Queries are request/reply.
 *
 * Pure TS, no DOM: the socket is injectable (tests drive it with `ws` in Node).
 */

import {
  LIVE_BEARER_PREFIX,
  LIVE_SUBPROTOCOL,
  LIVE_VERSION,
  TICK_LAN_MS,
  TICK_RELAY_MS,
  type BridgeMsg,
  type ControlMsg,
  type FpsMsg,
  type LanInfo,
  type LivePlayer,
  type QueryOp,
  type ReplyMsg,
  type Selector,
  type UniformInput,
  type WelcomeMsg,
} from "./liveProtocol";

/** The subset of WebSocket this uses. */
export interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev?: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  /** WebSocket.bufferedAmount: bytes not yet on the wire (absent: unknown). */
  readonly bufferedAmount?: number;
}

/** Hold coalesced controls while the relay socket still has this much queued:
 * on a slow uplink, sending more only grows the backlog — the pending patch keeps
 * merging (latest wins) and goes out once the socket drains. */
const MAX_BUFFERED = 8 * 1024;

export type LiveSocketFactory = (url: string, protocols: string[]) => LiveSocket;

/** What pairing leaves behind (persisted by the screen). */
export interface BridgeCreds {
  /** The relay origin, e.g. https://splanc.pages.dev */
  relay: string;
  /** The relay credential (`spl_pt_…`), from /pair with the bridge's code. */
  token: string;
  /** Stable per install: owns Show Mode locks across reconnects. */
  clientId: string;
  /** Shown to other performers ("Kevin's iPhone"). */
  name: string;
  /** Direct LAN endpoint + ticket, learned over the relay. */
  lan?: LanInfo;
  lanToken?: string;
}

export type LiveState = "idle" | "connecting" | "live" | "bridge-offline" | "offline" | "revoked";

export interface ControlPatch {
  deck?: number;
  u?: Record<string, UniformInput>;
  commit?: boolean;
  xf?: { pos: number; mode?: number };
  bri?: number;
  kb?: { w: Record<string, number>; seconds?: number; deck?: number };
}

export interface LiveClientEvents {
  onState?: (s: LiveState, detail?: string) => void;
  onWelcome?: (w: WelcomeMsg) => void;
  onPlayers?: (players: LivePlayer[], rooms: Record<string, string[]>) => void;
  /** An asynchronous failure from the bridge (a control it couldn't apply). */
  onError?: (code: string, message: string, player?: string) => void;
  /** A player's effect started/stopped lagging below its target fps (FUG-82; advisory). */
  onFps?: (m: FpsMsg) => void;
  /** New LAN ticket/endpoint: persist them. */
  onLan?: (lan: LanInfo | null, lanToken: string | undefined) => void;
}

export interface LiveClientOptions {
  factory?: LiveSocketFactory;
  /** Try the direct LAN path when the bridge advertises one (default true). */
  preferLan?: boolean;
  lanTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  backoffMs?: number[];
}

const OPEN = 1;

export function relayLiveUrl(relay: string): string {
  return `${relay.replace(/\/+$/, "").replace(/^http/, "ws")}/live`;
}

/** The protocols list carrying the bearer credential (browsers can't set headers). */
export const liveProtocols = (token: string) => [LIVE_SUBPROTOCOL, `${LIVE_BEARER_PREFIX}${token}`];

interface Waiter {
  resolve: (m: ReplyMsg) => void;
  reject: (e: Error) => void;
}

interface PendingCtl {
  to: Selector;
  deck: number;
  u: Record<string, UniformInput>;
  commit: boolean;
  xf?: { pos: number; mode?: number };
  bri?: number;
  kb?: ControlPatch["kb"];
}

export class BridgeLiveClient {
  state: LiveState = "idle";
  via: "relay" | "lan" | null = null;
  welcome: WelcomeMsg | null = null;
  players: LivePlayer[] = [];
  rooms: Record<string, string[]> = {};
  /** Why the direct path isn't in use (null when it is, or none is advertised). */
  lanNote: string | null = null;
  events: LiveClientEvents = {};
  /** Frames sent / controls coalesced (the screen shows the relay message rate). */
  readonly stats = { frames: 0, controls: 0, coalesced: 0 };

  private sock: LiveSocket | null = null;
  private closed = false;
  private seq = 0;
  private readonly waiters = new Map<number, Waiter>();
  private readonly pending = new Map<string, PendingCtl>();
  private lastFlush = -Infinity;
  private flushArmed = false;
  private backoffIdx = 0;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private readonly factory: LiveSocketFactory;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;

  constructor(
    readonly creds: BridgeCreds,
    private readonly opts: LiveClientOptions = {},
  ) {
    this.factory = opts.factory ?? ((u, p) => new WebSocket(u, p) as unknown as LiveSocket);
    this.now = opts.now ?? (() => performance.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  get tickMs(): number {
    return this.welcome?.tick_ms ?? (this.via === "lan" ? TICK_LAN_MS : TICK_RELAY_MS);
  }

  get connected(): boolean {
    return this.state === "live" && this.sock?.readyState === OPEN;
  }

  private setState(s: LiveState, detail?: string): void {
    this.state = s;
    this.events.onState?.(s, detail);
  }

  /** Connect (direct first when a LAN ticket is known), then keep connected. */
  async connect(): Promise<WelcomeMsg> {
    this.closed = false;
    this.setState("connecting");
    const lanFirst = this.opts.preferLan !== false && this.creds.lan && this.creds.lanToken;
    if (lanFirst) {
      const w = await this.open("lan").catch(() => null);
      if (w) return w;
    }
    const w = await this.open("relay");
    if (this.opts.preferLan !== false) void this.upgradeToLan();
    return w;
  }

  close(): void {
    this.closed = true;
    this.stopPinger();
    this.sock?.close(1000, "bye");
    this.sock = null;
    this.failWaiters(new Error("closed"));
    this.setState("idle");
  }

  /** Open one path; resolves on the bridge's welcome. The socket becomes current. */
  private open(via: "relay" | "lan"): Promise<WelcomeMsg> {
    const lan = via === "lan";
    const url = lan ? this.creds.lan!.url : relayLiveUrl(this.creds.relay);
    const token = lan ? this.creds.lanToken! : this.creds.token;
    return new Promise<WelcomeMsg>((resolve, reject) => {
      let welcomed = false;
      let s: LiveSocket;
      try {
        s = this.factory(url, liveProtocols(token));
      } catch (e) {
        reject(e as Error);
        return;
      }
      const timer = this.schedule(() => {
        if (welcomed) return;
        s.onclose = null;
        s.close();
        reject(new Error(lan ? "direct connection timed out" : "relay connection timed out"));
      }, lan ? (this.opts.lanTimeoutMs ?? 3000) : 10_000);
      void timer;
      s.onopen = () => this.sendOn(s, { t: "hello", v: LIVE_VERSION, client_id: this.creds.clientId, name: this.creds.name, app: "splanc-pwa" });
      s.onerror = () => undefined;
      s.onmessage = (ev) => {
        const m = parse(ev.data);
        if (!m) return;
        if (m.t === "welcome" && !welcomed) {
          welcomed = true;
          // This socket is now the one: retire the other path.
          const old = this.sock;
          this.sock = s;
          this.via = via;
          if (old && old !== s) {
            old.onclose = null;
            old.close(1000, "switched path");
          }
          this.backoffIdx = 0;
          this.onWelcome(m);
          this.startPinger();
          resolve(m);
          return;
        }
        if (s === this.sock) this.onMessage(m);
      };
      s.onclose = (ev) => {
        if (!welcomed) {
          reject(new Error(ev.code === 4003 ? "revoked" : `closed (${ev.code ?? "?"})`));
          return;
        }
        if (s !== this.sock) return;
        this.sock = null;
        this.stopPinger();
        this.failWaiters(new Error("connection lost"));
        if (ev.code === 4003) {
          this.setState("revoked", "This app's access to the bridge was revoked. Pair again.");
          return;
        }
        if (this.closed) return;
        this.setState("offline", ev.reason || undefined);
        this.reconnectSoon();
      };
    });
  }

  private reconnectSoon(): void {
    const b = this.opts.backoffMs ?? [500, 1000, 2000, 4000, 8000, 15000];
    const d = b[Math.min(this.backoffIdx++, b.length - 1)]!;
    this.schedule(() => {
      if (this.closed || this.sock) return;
      this.setState("connecting");
      void this.connect().catch((e: Error) => {
        if (e.message === "revoked") this.setState("revoked", "This app's access to the bridge was revoked. Pair again.");
        else {
          this.setState("offline", e.message);
          this.reconnectSoon();
        }
      });
    }, d);
  }

  /** Try the direct path in the background; switch to it if it answers. */
  async upgradeToLan(): Promise<boolean> {
    if (this.via === "lan" || !this.creds.lan || !this.creds.lanToken) return this.via === "lan";
    try {
      await this.open("lan");
      this.lanNote = null;
      return true;
    } catch (e) {
      this.lanNote =
        (e as Error).message === "revoked"
          ? "the direct ticket was refused"
          : "not reachable directly (another network, or this browser doesn't trust the bridge's certificate yet)";
      return false;
    }
  }

  private onWelcome(w: WelcomeMsg): void {
    this.welcome = w;
    this.players = w.players;
    this.rooms = w.rooms;
    if (w.lan_token || w.lan) {
      if (w.lan) this.creds.lan = w.lan;
      if (w.lan_token) this.creds.lanToken = w.lan_token;
      this.events.onLan?.(w.lan, w.lan_token);
    }
    this.setState("live");
    this.events.onWelcome?.(w);
    this.events.onPlayers?.(w.players, w.rooms);
  }

  private onMessage(m: BridgeMsg): void {
    switch (m.t) {
      case "welcome":
        // A re-welcome (we said hello again after the bridge came back to the relay).
        this.onWelcome(m);
        return;
      case "players":
        this.players = m.players;
        this.rooms = m.rooms;
        this.events.onPlayers?.(m.players, m.rooms);
        return;
      case "r": {
        const w = this.waiters.get(m.id);
        if (w) {
          this.waiters.delete(m.id);
          w.resolve(m);
        }
        return;
      }
      case "pong": {
        const w = this.waiters.get(m.id);
        if (w) {
          this.waiters.delete(m.id);
          w.resolve({ t: "r", id: m.id, ok: true });
        }
        return;
      }
      case "err":
        this.events.onError?.(m.code, m.message, m.player);
        return;
      case "fps":
        this.events.onFps?.(m);
        return;
      case "relay":
        if (m.bridge === "offline") this.setState("bridge-offline", "The bridge is offline (the relay is waiting for it).");
        else if (m.bridge === "online" && this.sock) {
          // The bridge reconnected to the relay: introduce ourselves again.
          this.sendOn(this.sock, { t: "hello", v: LIVE_VERSION, client_id: this.creds.clientId, name: this.creds.name, app: "splanc-pwa" });
        } else if (m.error) this.events.onError?.("relay", m.error);
        return;
      default:
        return;
    }
  }

  private sendOn(s: LiveSocket, msg: unknown): boolean {
    if (s.readyState !== OPEN) return false;
    try {
      s.send(JSON.stringify(msg));
      this.stats.frames++;
      return true;
    } catch {
      return false;
    }
  }

  // -- controls ----------------------------------------------------------------------

  /** Queue a continuous control for `to`; coalesced (last value wins per control). */
  control(to: Selector, patch: ControlPatch): void {
    this.stats.controls++;
    const deck = patch.deck === 1 ? 1 : 0;
    const key = `${deck}|${to.join("\u0000")}`;
    let p = this.pending.get(key);
    if (p) this.stats.coalesced++;
    else {
      p = { to: [...to], deck, u: {}, commit: false };
      this.pending.set(key, p);
    }
    if (patch.u) Object.assign(p.u, patch.u);
    if (patch.commit) p.commit = true;
    if (patch.xf) p.xf = patch.xf;
    if (patch.bri !== undefined) p.bri = patch.bri;
    if (patch.kb) p.kb = patch.kb;
    this.kick();
  }

  private kick(): void {
    if (this.flushArmed) return;
    const wait = this.lastFlush + this.tickMs - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.flushArmed = true;
    this.schedule(() => {
      this.flushArmed = false;
      this.flush();
    }, wait);
  }

  /** Send everything pending now (also: a slider's release, so the final value isn't held a tick). */
  flush(): void {
    if (this.pending.size === 0) return;
    const s = this.sock;
    if (!s || s.readyState !== OPEN) return; // kept: sent once connected
    if ((s.bufferedAmount ?? 0) > MAX_BUFFERED) {
      // Backpressure: keep merging, retry next tick.
      this.lastFlush = this.now();
      this.kick();
      return;
    }
    for (const p of this.pending.values()) {
      const msg: ControlMsg = { t: "c", to: p.to };
      if (Object.keys(p.u).length) {
        msg.u = p.u;
        if (p.deck) msg.deck = p.deck;
        if (p.commit) msg.commit = true;
      }
      if (p.xf) msg.xf = p.xf;
      if (p.bri !== undefined) msg.bri = p.bri;
      if (p.kb) msg.kb = p.kb;
      this.sendOn(s, msg);
    }
    this.pending.clear();
    this.lastFlush = this.now();
  }

  // -- queries -----------------------------------------------------------------------

  query(op: QueryOp, args: Record<string, unknown> = {}, to?: Selector): Promise<ReplyMsg> {
    const id = ++this.seq;
    return new Promise<ReplyMsg>((resolve, reject) => {
      const s = this.sock;
      if (!s || !this.sendOn(s, { t: "q", id, op, ...(to ? { to } : {}), ...args })) {
        reject(new Error("not connected to the bridge"));
        return;
      }
      this.waiters.set(id, { resolve, reject });
      this.schedule(() => {
        const w = this.waiters.get(id);
        if (!w) return;
        this.waiters.delete(id);
        w.reject(new Error(`the bridge didn't answer (${op})`));
      }, op === "deploy" ? 120_000 : (this.opts.requestTimeoutMs ?? 20_000));
    });
  }

  /** Round trip app -> bridge -> app, ms (via the relay this crosses it twice). */
  async ping(): Promise<number> {
    const id = ++this.seq;
    const t0 = this.now();
    await new Promise<ReplyMsg>((resolve, reject) => {
      const s = this.sock;
      if (!s || !this.sendOn(s, { t: "ping", id })) {
        reject(new Error("not connected to the bridge"));
        return;
      }
      this.waiters.set(id, { resolve, reject });
      this.schedule(() => {
        const w = this.waiters.get(id);
        if (w) {
          this.waiters.delete(id);
          w.reject(new Error("ping timed out"));
        }
      }, 10_000);
    });
    return this.now() - t0;
  }

  private failWaiters(e: Error): void {
    for (const w of this.waiters.values()) w.reject(e);
    this.waiters.clear();
  }

  // Keepalive: the relay auto-answers "ping" (free, the Durable Object stays
  // asleep); on the LAN the bridge answers it. Mobile networks drop idle sockets.
  private startPinger(): void {
    this.stopPinger();
    this.pinger = setInterval(() => {
      const s = this.sock;
      if (s && s.readyState === OPEN) s.send("ping");
    }, 25_000);
    (this.pinger as { unref?: () => void }).unref?.();
  }

  private stopPinger(): void {
    if (this.pinger) clearInterval(this.pinger);
    this.pinger = null;
  }
}

function parse(data: unknown): BridgeMsg | null {
  if (typeof data !== "string") return null;
  if (data === "pong") return null;
  try {
    const m = JSON.parse(data) as BridgeMsg;
    return m && typeof m === "object" && typeof m.t === "string" ? m : null;
  } catch {
    return null;
  }
}

// -- pairing -----------------------------------------------------------------------------

/** Redeem a bridge's pairing code at the relay for this app's credential. */
export async function pairWithCode(relay: string, code: string, label: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const r = await fetchFn(`${relay.replace(/\/+$/, "")}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ pairing_code: code, label }),
  });
  const j = (await r.json().catch(() => ({}))) as { token?: string; error_description?: string; error?: string };
  if (!r.ok || !j.token) throw new Error(j.error_description ?? j.error ?? `pairing failed (HTTP ${r.status})`);
  return j.token;
}

/** Revoke this app's credential (and so its live sessions and LAN ticket). */
export async function forgetBridge(relay: string, token: string, fetchFn: typeof fetch = fetch): Promise<void> {
  await fetchFn(`${relay.replace(/\/+$/, "")}/revoke`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
}

/** Uniforms every selected player's active effect has (by name), for one shared slider set. */
export function commonUniforms<T extends { name: string }>(perPlayer: T[][]): T[] {
  if (perPlayer.length === 0) return [];
  const [first, ...rest] = perPlayer;
  return first!.filter((u) => rest.every((l) => l.some((x) => x.name === u.name)));
}
