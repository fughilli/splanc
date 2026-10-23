/**
 * Run the relay Worker (agent/relay/src) on Node: `splanc-agent relay`, for people
 * who host their own relay (e.g. on the bridge itself, published with
 * `tailscale funnel`), and the tests' in-process relay.
 *
 * It supplies what Cloudflare would: Durable Object namespaces (one instance per
 * name, in this process), their storage (in memory, optionally persisted to a
 * JSON file), alarms, and hibernatable WebSockets (here: plain `ws` sockets that
 * never hibernate). The Worker code is the same code Cloudflare runs.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import { WebSocketServer, type WebSocket } from "ws";

import worker, { BridgeObject, Directory } from "../relay/src/index";
import type { DONamespace, DOState, DOStorage, DOStub, Env, HSocket, HostHooks, Upgraded } from "../relay/src/platform";

const UPGRADE_HEADER = "x-splanc-host-upgrade";

/** DO storage: a sorted in-memory map, optionally written through to a JSON file. */
class HostStorage implements DOStorage {
  readonly map = new Map<string, unknown>();
  private alarmAt: number | null = null;
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;
  onAlarm: (() => Promise<void>) | null = null;

  constructor(
    private readonly save: () => void,
    private readonly clock: () => number,
  ) {}

  get<T>(key: string): Promise<T | undefined>;
  get<T>(keys: string[]): Promise<Map<string, T>>;
  async get<T>(k: string | string[]): Promise<T | undefined | Map<string, T>> {
    if (Array.isArray(k)) {
      const out = new Map<string, T>();
      for (const x of k) if (this.map.has(x)) out.set(x, clone(this.map.get(x)) as T);
      return out;
    }
    return clone(this.map.get(k)) as T | undefined;
  }

  put<T>(key: string, value: T): Promise<void>;
  put<T>(entries: Record<string, T>): Promise<void>;
  async put<T>(k: string | Record<string, T>, v?: T): Promise<void> {
    if (typeof k === "string") this.map.set(k, clone(v));
    else for (const [kk, vv] of Object.entries(k)) this.map.set(kk, clone(vv));
    this.save();
  }

  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  async delete(k: string | string[]): Promise<boolean | number> {
    if (Array.isArray(k)) {
      let n = 0;
      for (const x of k) if (this.map.delete(x)) n++;
      this.save();
      return n;
    }
    const had = this.map.delete(k);
    this.save();
    return had;
  }

  async list<T>(opts: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const k of [...this.map.keys()].sort()) {
      if (opts.prefix && !k.startsWith(opts.prefix)) continue;
      out.set(k, clone(this.map.get(k)) as T);
      if (opts.limit && out.size >= opts.limit) break;
    }
    return out;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = setTimeout(
      () => {
        this.alarmAt = null;
        void this.onAlarm?.();
      },
      Math.max(0, at - this.clock()),
    );
    this.alarmTimer.unref?.();
  }

  close(): void {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
  }
}

const clone = <T>(v: T): T => (v === undefined ? v : (structuredClone(v) as T));

interface Instance {
  obj: BridgeObject | Directory;
  state: HostState;
}

/** A WebSocket accepted into an object; buffers sends until the HTTP upgrade completes. */
class HostSocket implements HSocket {
  ws: WebSocket | null = null;
  closed = false;
  private queue: string[] = [];
  private attachment: unknown = null;

  constructor(
    readonly tags: string[],
    private readonly owner: HostState,
  ) {}

  bind(ws: WebSocket): void {
    this.ws = ws;
    for (const m of this.queue) ws.send(m);
    this.queue = [];
  }

  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    if (this.ws) this.ws.send(data);
    else this.queue.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.owner.sockets.delete(this);
    try {
      this.ws?.close(code, reason);
    } catch {
      this.ws?.terminate();
    }
  }

  serializeAttachment(v: unknown): void {
    this.attachment = clone(v);
  }

  deserializeAttachment(): unknown {
    return clone(this.attachment);
  }
}

class HostState implements DOState {
  readonly sockets = new Set<HostSocket>();
  readonly auto = new Map<string, string>();
  constructor(readonly storage: HostStorage) {}

  acceptWebSocket(ws: HSocket): void {
    this.sockets.add(ws as HostSocket);
  }

  getWebSockets(tag?: string): HSocket[] {
    return [...this.sockets].filter((s) => !s.closed && (!tag || s.tags.includes(tag)));
  }
}

export interface RelayHostOptions {
  port?: number;
  host?: string;
  /** Canonical public origin (e.g. https://pi.tailnet.ts.net) when behind a proxy. */
  publicUrl?: string;
  /** Persist Durable Object storage here (JSON). In memory when absent. */
  dataFile?: string;
  /** Take the client IP from X-Forwarded-For (behind a trusted proxy). */
  trustProxy?: boolean;
  /** Direct bug filing (POST /bugs): the Worker secret + overrides
   * (`splanc-agent relay` reads GITHUB_ISSUES_TOKEN from its environment). */
  bugs?: Pick<Env, "GITHUB_ISSUES_TOKEN" | "GITHUB_ISSUES_REPO" | "GITHUB_API_URL">;
  /** Clock override (tests). */
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

export class RelayHost {
  readonly server: http.Server;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  private readonly instances = new Map<string, Instance>();
  private readonly pendingUpgrades = new Map<string, { sock: HostSocket; inst: Instance }>();
  private readonly env: Env;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly clock: () => number;
  private upgradeSeq = 0;

  constructor(private readonly opts: RelayHostOptions = {}) {
    this.clock = opts.now ?? Date.now;
    const hooks: HostHooks = {
      upgrade: (state, tags) => this.upgrade(state as HostState, tags),
      autoResponse: (state, req, res) => (state as HostState).auto.set(req, res),
      now: this.clock,
    };
    this.env = {
      BRIDGE: this.namespace("bridge"),
      DIRECTORY: this.namespace("directory"),
      HOST: hooks,
      ...(opts.publicUrl ? { PUBLIC_URL: opts.publicUrl.replace(/\/+$/, "") } : {}),
      ...(opts.bugs ?? {}),
    };
    this.load();
    this.server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server.on("upgrade", (req, socket, head) => void this.onUpgrade(req, socket as import("node:net").Socket, head));
  }

  async listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.opts.port ?? 0, this.opts.host ?? "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const a = this.server.address() as AddressInfo;
    return `http://${a.address.includes(":") ? `[${a.address}]` : a.address}:${a.port}`;
  }

  async close(): Promise<void> {
    for (const i of this.instances.values()) {
      for (const s of i.state.sockets) s.ws?.terminate();
      i.state.storage.close();
    }
    this.flush();
    await new Promise<void>((r) => this.server.close(() => r()));
    this.server.closeAllConnections?.();
  }

  /** Every instance's storage (tests inspect it). */
  storageOf(kind: "bridge" | "directory", name: string): Map<string, unknown> | undefined {
    return this.instances.get(`${kind}:${name}`)?.state.storage.map;
  }

  /** Drop every bridge socket (tests: simulate a relay outage). */
  dropBridgeSockets(): void {
    for (const i of this.instances.values()) for (const s of i.state.sockets) if (s.tags.includes("bridge")) s.ws?.terminate();
  }

  // -- Durable Objects --------------------------------------------------------------------

  private instance(kind: "bridge" | "directory", name: string): Instance {
    const key = `${kind}:${name}`;
    let inst = this.instances.get(key);
    if (!inst) {
      const storage = new HostStorage(() => this.scheduleSave(), this.clock);
      const state = new HostState(storage);
      const obj = kind === "bridge" ? new BridgeObject(state, this.env) : new Directory(state, this.env);
      inst = { obj, state };
      if (obj instanceof Directory) storage.onAlarm = () => obj.alarm();
      this.instances.set(key, inst);
    }
    return inst;
  }

  private namespace(kind: "bridge" | "directory"): DONamespace {
    return {
      idFromName: (name: string) => name,
      get: (id: unknown): DOStub => ({
        fetch: async (input: Request | string, init?: RequestInit) => {
          const req = typeof input === "string" ? new Request(input, init) : input;
          return this.instance(kind, String(id)).obj.fetch(req);
        },
      }),
    };
  }

  private upgrade(state: HostState, tags: string[]): Upgraded {
    const inst = [...this.instances.values()].find((i) => i.state === state)!;
    const sock = new HostSocket(tags, state);
    state.acceptWebSocket(sock);
    const ticket = `u${++this.upgradeSeq}`;
    this.pendingUpgrades.set(ticket, { sock, inst });
    return { response: new Response(null, { status: 200, headers: { [UPGRADE_HEADER]: ticket } }), socket: sock };
  }

  // -- persistence -----------------------------------------------------------------------

  private load(): void {
    if (!this.opts.dataFile) return;
    let data: Record<string, Record<string, unknown>>;
    try {
      data = JSON.parse(readFileSync(this.opts.dataFile, "utf8")) as Record<string, Record<string, unknown>>;
    } catch {
      return;
    }
    for (const [key, entries] of Object.entries(data)) {
      const [kind, name] = key.split(/:(.*)/s) as ["bridge" | "directory", string];
      const inst = this.instance(kind, name);
      for (const [k, v] of Object.entries(entries)) inst.state.storage.map.set(k, v);
      if (inst.obj instanceof Directory) void inst.state.storage.setAlarm(this.clock() + 60_000);
    }
  }

  private scheduleSave(): void {
    if (!this.opts.dataFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 200);
    this.saveTimer.unref?.();
  }

  private flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const file = this.opts.dataFile;
    if (!file) return;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [key, inst] of this.instances) out[key] = Object.fromEntries(inst.state.storage.map);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(`${file}.tmp`, JSON.stringify(out), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  // -- HTTP ------------------------------------------------------------------------------

  private toRequest(req: IncomingMessage, withBody: boolean): Request {
    const base = this.env.PUBLIC_URL ?? `http://${req.headers.host ?? "localhost"}`;
    const url = new URL(req.url ?? "/", base);
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
    const fwd = this.opts.trustProxy ? req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() : undefined;
    headers.set("cf-connecting-ip", fwd || req.socket.remoteAddress || "unknown");
    const hasBody = withBody && req.method !== "GET" && req.method !== "HEAD";
    return new Request(url, {
      method: req.method ?? "GET",
      headers,
      ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" } : {}),
    } as RequestInit);
  }

  private async onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let r: Response;
    try {
      r = await worker.fetch(this.toRequest(req, true), this.env);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" }).end(`relay host error: ${(e as Error).message}`);
      return;
    }
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    res.writeHead(r.status, headers);
    if (!r.body) {
      res.end();
      return;
    }
    const reader = r.body.getReader();
    res.on("close", () => void reader.cancel().catch(() => undefined));
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // stream errored (bridge dropped mid-reply)
    }
    res.end();
  }

  private async onUpgrade(req: IncomingMessage, socket: import("node:net").Socket, head: Buffer): Promise<void> {
    let r: Response;
    try {
      r = await worker.fetch(this.toRequest(req, false), this.env);
    } catch (e) {
      socket.end(`HTTP/1.1 500 Internal Server Error\r\n\r\n${(e as Error).message}`);
      return;
    }
    const ticket = r.headers.get(UPGRADE_HEADER);
    const up = ticket ? this.pendingUpgrades.get(ticket) : undefined;
    if (!up) {
      const body = await r.text();
      socket.end(
        `HTTP/1.1 ${r.status} ${http.STATUS_CODES[r.status] ?? ""}\r\ncontent-type: ${r.headers.get("content-type") ?? "text/plain"}\r\n` +
          `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
      return;
    }
    this.pendingUpgrades.delete(ticket!);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const { sock, inst } = up;
      if (sock.closed) {
        ws.close(1000);
        return;
      }
      sock.bind(ws);
      const obj = inst.obj as BridgeObject;
      ws.on("message", (data, isBinary) => {
        const text = isBinary ? null : data.toString();
        if (text === null) return;
        const auto = inst.state.auto.get(text);
        if (auto !== undefined) {
          ws.send(auto);
          return;
        }
        void obj.webSocketMessage(sock, text).catch((e: Error) => this.opts.log?.(`webSocketMessage: ${e.message}`));
      });
      ws.on("close", (code, reason) => {
        sock.closed = true;
        inst.state.sockets.delete(sock);
        void obj.webSocketClose(sock, code, reason.toString()).catch(() => undefined);
      });
      ws.on("error", () => undefined);
    });
  }
}
