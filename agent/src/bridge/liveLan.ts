/**
 * The bridge's direct LAN endpoint for live sessions (docs/design/live-vj-relay.md,
 * "Direct LAN path"): `wss://<bridge LAN IP>:8443/live`, the same live protocol as
 * through the relay, without the relay's round trip (or its billing).
 *
 * - TLS: the bridge's own self-signed certificate (lanCert.ts). The app learns its
 *   SHA-256 over the relay before dialing; a browser needs the user to open
 *   `https://<ip>:8443/` once and accept it (the same TOFU step the players need).
 * - Auth: a LAN ticket (`spl_lt_…`), minted by the bridge for a client that is
 *   connected via the relay (so: paired with a code, and not revoked). Only its
 *   SHA-256 is stored, in `<state dir>/live-clients.json`; tickets last 30 days,
 *   are re-minted on every relay hello, and die with their grant (relay revoke,
 *   or the bridge's revoke-all).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import https from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { join } from "node:path";

import { WebSocketServer, type WebSocket } from "ws";

import { LIVE_BEARER_PREFIX, LIVE_SUBPROTOCOL, type LanInfo } from "../../../web/src/net/liveProtocol";
import type { LanCert } from "./lanCert";
import type { LiveConn, LiveMux, TicketMinter } from "./live";

export const DEFAULT_LIVE_PORT = 8443;
export const TICKET_TTL_MS = 30 * 86_400_000;
const TICKET_RE = /^spl_lt_([A-Za-z0-9_-]{43})$/;

interface Ticket {
  hash: string;
  label: string;
  grant: string;
  created: number;
  exp: number;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** LAN tickets: client id -> the hash of its current ticket. */
export class LanTickets implements TicketMinter {
  private readonly file: string;
  private data: { v: 1; tickets: Record<string, Ticket> };

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = join(stateDir, "live-clients.json");
    try {
      this.data = JSON.parse(readFileSync(this.file, "utf8")) as { v: 1; tickets: Record<string, Ticket> };
      if (!this.data.tickets) throw new Error("bad file");
    } catch {
      this.data = { v: 1, tickets: {} };
    }
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  }

  mint(clientId: string, label: string, grant: string): string {
    const secret = randomBytes(32).toString("base64url");
    const t = this.now();
    this.data.tickets[clientId] = { hash: sha(secret), label: label.slice(0, 80), grant, created: t, exp: t + TICKET_TTL_MS };
    this.prune();
    this.save();
    return `spl_lt_${secret}`;
  }

  /** The client a ticket belongs to, or null (unknown, expired, revoked). */
  verify(token: string | null): { clientId: string; label: string; grant: string } | null {
    const m = token ? TICKET_RE.exec(token) : null;
    if (!m) return null;
    const h = Buffer.from(sha(m[1]!), "hex");
    for (const [clientId, t] of Object.entries(this.data.tickets)) {
      const want = Buffer.from(t.hash, "hex");
      if (want.length === h.length && timingSafeEqual(want, h) && t.exp > this.now()) {
        return { clientId, label: t.label, grant: t.grant };
      }
    }
    return null;
  }

  revokeGrants(grants: string[]): void {
    const all = grants.includes("*");
    let n = 0;
    for (const [id, t] of Object.entries(this.data.tickets)) {
      if (all || grants.includes(t.grant)) {
        delete this.data.tickets[id];
        n++;
      }
    }
    if (n) this.save();
  }

  get count(): number {
    return Object.keys(this.data.tickets).length;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, x] of Object.entries(this.data.tickets)) if (x.exp <= t) delete this.data.tickets[id];
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}

/** The bearer token in a `Sec-WebSocket-Protocol` list, when it offers ours. */
export function bearerFromProtocols(header: string | undefined): string | null {
  const list = (header ?? "").split(",").map((p) => p.trim());
  if (!list.includes(LIVE_SUBPROTOCOL)) return null;
  const b = list.find((p) => p.startsWith(LIVE_BEARER_PREFIX));
  return b ? b.slice(LIVE_BEARER_PREFIX.length) : null;
}

const PAGE = (sha256: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Splanc bridge</title><style>body{font:16px system-ui;margin:2em;max-width:36em}code{word-break:break-all}</style>
<h1>Splanc bridge</h1><p>This browser now trusts your Splanc bridge's certificate, so the Splanc app can
connect to it directly on this network (lower latency for live control).</p>
<p>Certificate SHA-256: <code>${sha256.replace(/(..)(?!$)/g, "$1:")}</code><br>
It should match the fingerprint the app shows. You can close this tab and go back to the app.</p>`;

export interface LiveLanOptions {
  mux: LiveMux;
  tickets: LanTickets;
  cert: LanCert;
  port?: number;
  host?: string;
  /** The address to advertise (default: the first non-loopback IPv4). */
  advertise?: () => string;
  log?: (...a: unknown[]) => void;
}

let seq = 0;

export class LiveLan {
  private server: https.Server | null = null;
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(LIVE_SUBPROTOCOL) ? LIVE_SUBPROTOCOL : false),
  });
  port = 0;
  private readonly log: (...a: unknown[]) => void;

  constructor(private readonly opts: LiveLanOptions) {
    this.log = opts.log ?? (() => undefined);
  }

  async listen(): Promise<number> {
    const { cert } = this.opts;
    const server = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/healthz") {
        // The app probes this (fetch) to learn whether the browser trusts the cert yet.
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, live: 1, sha256: cert.sha256 }));
        return;
      }
      if (path === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(PAGE(cert.sha256));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    server.on("upgrade", (req, socket: Socket, head) => {
      const path = (req.url ?? "/").split("?")[0];
      const who = this.opts.tickets.verify(bearerFromProtocols(req.headers["sec-websocket-protocol"]));
      if (path !== "/live" || !who) {
        const status = path !== "/live" ? "404 Not Found" : "401 Unauthorized";
        socket.end(`HTTP/1.1 ${status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, who));
    });
    server.on("clientError", (_e, socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.opts.port ?? DEFAULT_LIVE_PORT, this.opts.host ?? "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.port;
  }

  private accept(ws: WebSocket, who: { clientId: string; label: string; grant: string }): void {
    const id = `lan${++seq}.${randomBytes(4).toString("hex")}`;
    const conn: LiveConn = {
      id,
      via: "lan",
      label: who.label,
      grant: who.grant,
      clientId: who.clientId,
      send: (t) => {
        if (ws.readyState === ws.OPEN) ws.send(t);
      },
      close: (code, reason) => ws.close(code ?? 1000, reason ?? ""),
    };
    this.opts.mux.attach(conn);
    // Liveness: protocol pings every 20 s; a socket silent for 60 s is dropped.
    let last = Date.now();
    const ping = setInterval(() => {
      if (Date.now() - last > 60_000) ws.terminate();
      else if (ws.readyState === ws.OPEN) ws.ping();
    }, 20_000);
    ping.unref?.();
    ws.on("pong", () => (last = Date.now()));
    ws.on("message", (data, isBinary) => {
      last = Date.now();
      if (isBinary) return;
      const text = data.toString();
      if (text === "ping") {
        ws.send("pong"); // the same keepalive text the relay auto-answers
        return;
      }
      void this.opts.mux.message(id, text).catch((e: Error) => this.log(`live: ${e.message}`));
    });
    ws.on("close", () => {
      clearInterval(ping);
      this.opts.mux.detach(id);
    });
    ws.on("error", () => undefined);
  }

  info(): LanInfo | null {
    if (!this.server) return null;
    const ip = this.opts.advertise?.() ?? "";
    if (!ip) return null;
    const host = ip.includes(":") ? `[${ip}]` : ip;
    return { url: `wss://${host}:${this.port}/live`, page: `https://${host}:${this.port}/`, sha256: this.opts.cert.sha256 };
  }

  async close(): Promise<void> {
    for (const c of this.wss.clients) c.terminate();
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}
