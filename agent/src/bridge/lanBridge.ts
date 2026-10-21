/**
 * `splanc-agent bridge`: the LAN half of the cloud relay
 * (docs/design/cloud-relay.md). It runs the hub (every player on this LAN, TLS +
 * cert pins stay here) and serves MCP to cloud agents through the relay:
 *
 *   cloud agent --HTTPS--> relay --(the bridge's outbound WebSocket)--> here
 *
 * Each tunnelled HTTP request is handed to the MCP SDK's Streamable HTTP server
 * transport, one transport + McpServer per MCP session, all sharing one Hub.
 *
 * For the display (and anything else local) it keeps the fixed contract:
 * an atomically written status file and a unix-socket control channel
 * (newline-delimited JSON): new_pairing_code, revoke_all, identify, status.
 */

import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { Pairing, RelayFrame, ReqFrame, ResFrame } from "../../relay/src/protocol";
import type { Hub } from "../hub";
import type { ProgressSink } from "../progress";
import { createServer } from "../server";
import { RelayLink } from "./relayLink";

export const DEFAULT_STATUS_PATH = "/run/splanc-bridge/status.json";
export const DEFAULT_CONTROL_PATH = "/run/splanc-bridge/control.sock";

export type BridgeState = "starting" | "offline" | "unpaired" | "pairing" | "paired" | "error";

/** The status file (contract v1; docs/design/cloud-relay.md "Display contract"). */
export interface BridgeStatus {
  v: 1;
  state: BridgeState;
  relay: string;
  bridge_id: string;
  pairing: Pairing | null;
  clients: number;
  players: { name: string; host: string; ok: boolean }[];
  lan_ip: string;
  error: string | null;
  updated_at: number;
}

export interface LanBridgeOptions {
  link: RelayLink;
  hub: Hub;
  /** Bundle root (passed to createServer). */
  root?: string;
  statusPath?: string;
  controlPath?: string;
  log?: (...a: unknown[]) => void;
  /** Status heartbeat (default 30 s): updated_at never goes staler than this. */
  heartbeatMs?: number;
  /** Re-discover players this often (default 5 min; 0 = never). */
  refreshMs?: number;
  /** Ask for pairing codes by itself while unpaired, for this long after start (default 1 h). */
  autoPairMs?: number;
  /** At most one automatic code request this often (default 30 s). */
  autoPairIntervalMs?: number;
  /** A session idle this long is closed (default 30 min). */
  sessionIdleMs?: number;
  /** Also print each tool's progress here (the service log). */
  echo?: ProgressSink;
}

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  last: number;
}

/** A session counts as a connected cloud client while active this recently. */
const CLIENT_WINDOW_MS = 10 * 60_000;
const CHUNK = 256 * 1024;
/** Replies that finish within this go to the relay as one message. */
const COALESCE_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function lanIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return "";
}

/** Write `data` to `path` atomically (temp file in the same directory + rename). */
export function writeAtomic(path: string, data: string, mode = 0o644): void {
  const tmp = join(dirname(path), `.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, data, { mode });
  renameSync(tmp, path);
}

export class LanBridge {
  readonly statusPath: string;
  readonly controlPath: string;
  private readonly sessions = new Map<string, Session>();
  private readonly inflight = new Map<number, AbortController>();
  private control: net.Server | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private pairTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStatus = "";
  private lastWrite = 0;
  private fatal: string | null = null;
  private stopping = false;
  private readonly started = Date.now();
  private readonly waiters: ((f: RelayFrame) => void)[] = [];
  private readonly log: (...a: unknown[]) => void;
  private readonly link: RelayLink;

  constructor(private readonly opts: LanBridgeOptions) {
    this.link = opts.link;
    this.log = opts.log ?? (() => undefined);
    this.statusPath = writablePath(opts.statusPath ?? process.env["SPLANC_BRIDGE_STATUS"], DEFAULT_STATUS_PATH, "status.json", this.log);
    this.controlPath = writablePath(opts.controlPath ?? process.env["SPLANC_BRIDGE_CONTROL"], DEFAULT_CONTROL_PATH, "control.sock", this.log);
  }

  /** Start serving; `connect: false` keeps the link down (no relay configured:
   * the status file and control socket still work, and say why). */
  async start(opts: { connect?: boolean } = {}): Promise<void> {
    this.stopping = false;
    this.writeStatus(true);
    await this.listenControl();
    if (opts.connect === false) return;
    this.link.onChange = () => {
      this.maybeAutoPair();
      this.writeStatus();
    };
    this.link.onFrame = (f) => this.onFrame(f);
    this.link.start();
    const hb = this.opts.heartbeatMs ?? 30_000;
    this.timers.push(setInterval(() => this.writeStatus(), Math.max(1000, Math.min(hb, 5000))));
    this.timers.push(setInterval(() => this.sweepSessions(), 60_000));
    const refresh = this.opts.refreshMs ?? 5 * 60_000;
    if (refresh > 0) {
      this.timers.push(
        setInterval(
          () =>
            void this.opts.hub
              .refresh({ sweep: "off" })
              .then(() => this.writeStatus())
              .catch(() => undefined),
          refresh,
        ),
      );
    }
    for (const t of this.timers) t.unref?.();
    // Discover, then open every player's session, in the background (the display
    // shows players as they appear; a cloud agent's first call finds them open).
    this.opts.hub.ready().then(
      async () => {
        this.writeStatus();
        await this.opts.hub.warm();
        this.writeStatus();
      },
      (e: Error) => this.log(`discovery: ${e.message}`),
    );
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.pairTimer) clearTimeout(this.pairTimer);
    this.link.stop();
    for (const s of this.sessions.values()) await s.transport.close().catch(() => undefined);
    this.sessions.clear();
    // Leave a truthful last word for the display.
    this.stopping = true;
    this.writeStatus(true);
    await new Promise<void>((r) => (this.control ? this.control.close(() => r()) : r()));
    try {
      unlinkSync(this.controlPath);
    } catch {
      // gone
    }
  }

  // -- status --------------------------------------------------------------------------

  status(): BridgeStatus {
    const nowMs = Date.now();
    const l = this.link;
    // A code is only shown while connected: offline, the display can't promise it works.
    const pairing = !this.stopping && l.online && l.pairing && l.pairing.expires_at * 1000 > nowMs ? l.pairing : null;
    let state: BridgeState;
    if (this.fatal) state = "error";
    else if (this.stopping) state = "offline";
    else if (l.phase === "starting") state = "starting";
    else if (!l.online) state = "offline";
    else if (pairing) state = "pairing";
    else if (l.credentials > 0) state = "paired";
    else state = "unpaired";
    return {
      v: 1,
      state,
      relay: l.relay,
      bridge_id: l.bridgeId ?? "",
      pairing,
      clients: [...this.sessions.values()].filter((s) => nowMs - s.last < CLIENT_WINDOW_MS).length,
      players: this.opts.hub.registry.list().map((p) => ({
        name: p.name,
        host: p.host,
        ok: this.opts.hub.isConnected(p.id) || (p.lastSeen > 0 && nowMs - p.lastSeen < 15 * 60_000),
      })),
      lan_ip: lanIp(),
      error: this.fatal ?? (this.stopping ? "bridge stopped" : state === "offline" ? l.lastError : null),
      updated_at: Math.floor(nowMs / 1000),
    };
  }

  /** Write the status file when it changed (or the heartbeat is due). */
  writeStatus(force = false): void {
    const s = this.status();
    const { updated_at: _, ...rest } = s;
    const key = JSON.stringify(rest);
    const hb = this.opts.heartbeatMs ?? 30_000;
    if (!force && key === this.lastStatus && Date.now() - this.lastWrite < hb) return;
    this.lastStatus = key;
    this.lastWrite = Date.now();
    try {
      mkdirSync(dirname(this.statusPath), { recursive: true, mode: 0o755 });
      writeAtomic(this.statusPath, `${JSON.stringify(s)}\n`);
    } catch (e) {
      this.log(`status: can't write ${this.statusPath}: ${(e as Error).message}`);
    }
  }

  setFatal(message: string): void {
    this.fatal = message;
    this.writeStatus(true);
  }

  // -- pairing -------------------------------------------------------------------------

  private autoRequested: number | null = null;
  /** The live code last seen, to tell a redeemed code from an expired one. */
  private shownCode: Pairing | null = null;
  /** A code was redeemed: someone is pairing, so stop making codes by ourselves. */
  private redeemed = false;

  private maybeAutoPair(): void {
    const l = this.link;
    const pairing = l.pairing && l.pairing.expires_at * 1000 > Date.now();
    if (this.pairTimer) clearTimeout(this.pairTimer);
    this.pairTimer = null;
    if (l.online && !pairing && this.shownCode && this.shownCode.expires_at * 1000 > Date.now() + 1000) {
      // The code vanished before it expired: it was redeemed. Its credential is
      // issued a moment later (credentials are still 0 in between), and a fresh code
      // requested in that gap would leave a paired bridge showing a code.
      this.redeemed = true;
    }
    if (l.online) this.shownCode = pairing ? l.pairing : null;
    if (pairing) {
      // Repaint (state pairing -> unpaired/paired) right when the code expires.
      this.pairTimer = setTimeout(() => {
        this.maybeAutoPair();
        this.writeStatus();
      }, l.pairing!.expires_at * 1000 - Date.now() + 250);
      this.pairTimer.unref?.();
      return;
    }
    const window = this.opts.autoPairMs ?? 60 * 60_000;
    if (!l.online || l.credentials > 0 || this.redeemed || Date.now() - this.started > window) return;
    // At most one automatic request per 30 s (a refused request must not loop).
    const every = this.opts.autoPairIntervalMs ?? 30_000;
    if (this.autoRequested && Date.now() - this.autoRequested < every) return;
    this.autoRequested = Date.now();
    l.send({ t: "new_code" });
  }

  private waitFor(pred: (f: RelayFrame) => boolean, ms: number): Promise<RelayFrame | null> {
    return new Promise((resolve) => {
      const w = (f: RelayFrame) => {
        if (!pred(f)) return;
        clearTimeout(t);
        this.waiters.splice(this.waiters.indexOf(w), 1);
        resolve(f);
      };
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null);
      }, ms);
      this.waiters.push(w);
    });
  }

  async newPairingCode(): Promise<Record<string, unknown>> {
    const wait = this.waitFor(
      (f) => (f.t === "state" && f.pairing !== null) || (f.t === "error" && f.for === "new_code"),
      10_000,
    );
    if (!this.link.send({ t: "new_code" })) return { ok: false, error: `relay offline: ${this.link.lastError ?? "not connected"}` };
    const f = await wait;
    if (!f) return { ok: false, error: "the relay didn't answer" };
    if (f.t === "error") return { ok: false, error: f.message };
    return { ok: true, pairing: (f as { pairing: Pairing }).pairing };
  }

  async revokeAll(): Promise<Record<string, unknown>> {
    const before = this.link.credentials;
    const wait = this.waitFor((f) => f.t === "state" && f.credentials === 0, 10_000);
    if (!this.link.send({ t: "revoke_all" })) return { ok: false, error: `relay offline: ${this.link.lastError ?? "not connected"}` };
    const f = await wait;
    // Drop live sessions too: a revoked client must start over (and will be refused).
    for (const s of this.sessions.values()) await s.transport.close().catch(() => undefined);
    this.sessions.clear();
    this.writeStatus(true);
    return f ? { ok: true, revoked: before } : { ok: false, error: "the relay didn't confirm" };
  }

  async identify(): Promise<Record<string, unknown>> {
    const players = this.opts.hub.registry.list();
    if (players.length === 0) return { ok: true, players: 0, note: "no players found yet" };
    const r = await this.opts.hub.each("all", (s) => s.identify());
    return { ok: true, players: r.length, results: r.map((x) => ({ name: x.player.name, ok: x.ok, ...(x.error ? { error: x.error } : {}) })) };
  }

  // -- control socket -------------------------------------------------------------------

  async command(line: string): Promise<Record<string, unknown>> {
    let cmd: { cmd?: string };
    try {
      cmd = JSON.parse(line) as { cmd?: string };
    } catch {
      return { ok: false, error: "expected a JSON object per line" };
    }
    switch (cmd.cmd) {
      case "new_pairing_code":
        return this.newPairingCode();
      case "revoke_all":
        return this.revokeAll();
      case "identify":
        return this.identify();
      case "status":
        return { ok: true, status: this.status() };
      default:
        return { ok: false, error: `unknown cmd ${JSON.stringify(cmd.cmd)} (new_pairing_code, revoke_all, identify, status)` };
    }
  }

  private async listenControl(): Promise<void> {
    const path = this.controlPath;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
      if (statSync(path, { throwIfNoEntry: false })?.isSocket()) unlinkSync(path);
    } catch (e) {
      this.log(`control: ${(e as Error).message}`);
    }
    this.control = net.createServer((conn) => {
      let buf = "";
      conn.setEncoding("utf8");
      conn.on("data", (d: string) => {
        buf += d;
        if (buf.length > 64 * 1024) {
          conn.destroy();
          return;
        }
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          void this.command(line).then(
            (r) => conn.writable && conn.write(`${JSON.stringify(r)}\n`),
            (e: Error) => conn.writable && conn.write(`${JSON.stringify({ ok: false, error: e.message })}\n`),
          );
        }
      });
      conn.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => {
      this.control!.once("error", (e) => {
        this.log(`control: can't listen on ${path}: ${e.message}`);
        resolve();
      });
      this.control!.listen(path, () => {
        try {
          // Owner + group: put the display service in this user's group.
          chmodSync(path, 0o660);
        } catch {
          // best effort
        }
        resolve();
      });
    });
  }

  // -- the MCP tunnel -------------------------------------------------------------------

  private onFrame(f: RelayFrame): void {
    for (const w of [...this.waiters]) w(f);
    if (f.t === "req") void this.onReq(f);
    else if (f.t === "cancel") this.inflight.get(f.id)?.abort();
    else if (f.t === "error") this.log(`relay: ${f.message}`);
    else if (f.t === "state" && f.reason) this.log(`relay: ${f.reason} (${f.credentials} credential(s))`);
  }

  /** One frame for a whole reply up to CHUNK; a bigger one (a preview's or
   * plot's images) goes as res + chunks + end, so no single WebSocket message to
   * the relay outgrows what a Worker accepts. */
  private reply(f: ResFrame): void {
    if (f.end && f.body !== undefined && f.body.length > CHUNK) {
      this.link.send({ t: "res", id: f.id, status: f.status, headers: f.headers });
      this.sendChunks(f.id, f.body);
      this.link.send({ t: "end", id: f.id });
      return;
    }
    this.link.send(f);
  }

  private jsonReply(id: number, status: number, body: unknown): void {
    this.reply({ t: "res", id, status, headers: { "content-type": "application/json" }, body: JSON.stringify(body), end: true });
  }

  private async onReq(f: ReqFrame): Promise<void> {
    const ac = new AbortController();
    this.inflight.set(f.id, ac);
    try {
      const sid = f.headers["mcp-session-id"];
      let session = sid ? this.sessions.get(sid) : undefined;
      if (sid && !session) {
        // Unknown (expired, or this bridge restarted): the client re-initializes on 404.
        this.jsonReply(f.id, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
        return;
      }
      if (!session) {
        let parsed: unknown;
        try {
          parsed = f.body ? JSON.parse(f.body) : undefined;
        } catch {
          parsed = undefined;
        }
        const init = Array.isArray(parsed) ? parsed.some((m) => isInitializeRequest(m)) : isInitializeRequest(parsed);
        if (f.method !== "POST" || !init) {
          this.jsonReply(f.id, 400, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32000, message: "Bad Request: no session; send initialize first" },
          });
          return;
        }
        session = await this.newSession();
      }
      session.last = Date.now();
      const req = new Request("http://splanc-bridge.invalid/mcp", {
        method: f.method,
        headers: f.headers,
        ...(f.method === "POST" ? { body: f.body } : {}),
        signal: ac.signal,
      });
      const res = await session.transport.handleRequest(req);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      if (!(headers["content-type"] ?? "").startsWith("text/event-stream") || !res.body) {
        this.reply({ t: "res", id: f.id, status: res.status, headers, body: res.body ? await res.text() : "", end: true });
        return;
      }
      // An SSE reply: progress notifications, then the response. Most requests finish
      // fast, so collect for COALESCE_MS and, if the stream is done by then, send it
      // as ONE frame (the relay is billed per incoming message). A slow tool's stream
      // is forwarded as it comes, so the cloud client sees its progress.
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      ac.signal.addEventListener("abort", () => void reader.cancel().catch(() => undefined), { once: true });
      let buf = "";
      let streaming = false;
      const deadline = Date.now() + COALESCE_MS;
      for (;;) {
        const left = deadline - Date.now();
        const next = reader.read();
        const r = streaming || left <= 0 ? await next : await Promise.race([next, sleep(left).then(() => null)]);
        if (r === null) {
          // Still going after the window: switch to streaming (the pending read is reused).
          streaming = true;
          this.reply({ t: "res", id: f.id, status: res.status, headers });
          if (buf) this.link.send({ t: "chunk", id: f.id, data: buf });
          buf = "";
          const { done, value } = await next;
          if (done) break;
          this.sendChunks(f.id, dec.decode(value, { stream: true }));
          continue;
        }
        if (r.done) break;
        const text = dec.decode(r.value, { stream: true });
        if (streaming) this.sendChunks(f.id, text);
        else buf += text;
      }
      if (!streaming) {
        this.reply({ t: "res", id: f.id, status: res.status, headers, body: buf, end: true });
        return;
      }
      this.link.send({ t: "end", id: f.id });
    } catch (e) {
      if (!ac.signal.aborted) {
        this.jsonReply(f.id, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: `bridge: ${(e as Error).message}` } });
      }
    } finally {
      this.inflight.delete(f.id);
    }
  }

  private sendChunks(id: number, text: string): void {
    for (let i = 0; i < text.length; i += CHUNK) this.link.send({ t: "chunk", id, data: text.slice(i, i + CHUNK) });
  }

  private async newSession(): Promise<Session> {
    const session: Session = { transport: null as unknown as WebStandardStreamableHTTPServerTransport, last: Date.now() };
    session.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // SSE replies, so progress notifications and log messages from long tools reach
      // the cloud client; onReq coalesces quick replies into one relay message.
      onsessioninitialized: (id) => {
        this.sessions.set(id, session);
        this.log(`cloud session ${id.slice(0, 8)} started`);
        this.writeStatus();
      },
      onsessionclosed: (id) => {
        this.sessions.delete(id);
        this.writeStatus();
      },
    });
    const server = createServer(this.opts.hub, {
      ...(this.opts.root !== undefined ? { root: this.opts.root } : {}),
      ...(this.opts.echo ? { echo: this.opts.echo } : {}),
    });
    await server.connect(session.transport);
    return session;
  }

  private sweepSessions(): void {
    const idle = this.opts.sessionIdleMs ?? 30 * 60_000;
    for (const [id, s] of this.sessions) {
      if (Date.now() - s.last > idle) {
        this.sessions.delete(id);
        void s.transport.close().catch(() => undefined);
      }
    }
    this.writeStatus();
  }
}

/** Where a bridge's control socket may be, most specific first (for bridge-ctl). */
export function controlSocketCandidates(): string[] {
  const env = process.env["SPLANC_BRIDGE_CONTROL"];
  return [...(env ? [env] : []), DEFAULT_CONTROL_PATH, join(process.env["XDG_RUNTIME_DIR"] || tmpdir(), "splanc-bridge", "control.sock")];
}

/** The configured path, or the default; when the default's directory can't be
 * made (no /run access off a Pi), fall back to $XDG_RUNTIME_DIR (or the tmp dir). */
function writablePath(given: string | undefined, def: string, name: string, log: (...a: unknown[]) => void): string {
  if (given) return given;
  try {
    mkdirSync(dirname(def), { recursive: true, mode: 0o755 });
    accessSync(dirname(def), constants.W_OK);
    return def;
  } catch {
    const base = join(process.env["XDG_RUNTIME_DIR"] || tmpdir(), "splanc-bridge");
    const p = join(base, name);
    log(`can't use ${def}; using ${p} (set SPLANC_BRIDGE_${name === "status.json" ? "STATUS" : "CONTROL"} to choose)`);
    return p;
  }
}
