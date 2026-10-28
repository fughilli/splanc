/**
 * BridgeObject: one Durable Object per paired bridge (named by its bridge id).
 *
 * It owns
 * - the bridge's Ed25519 public key (`meta`), checked on every connect;
 * - the bridge's one WebSocket, accepted with the Hibernation API so an idle
 *   bridge costs nothing (the bridge's "ping" is auto-answered without waking us);
 * - the credentials for this bridge: OAuth authorization codes (`ac:`), access
 *   and refresh tokens and personal tokens (`tok:`), all stored as SHA-256
 *   hashes of their secret, plus rotated-out refresh tokens (`used:`) for reuse
 *   detection;
 * - per-grant metadata (`grant:<id>`: kind, label, created, last used), the
 *   bridge's paired-client list (docs/design/cloud-relay.md, "Paired clients");
 * - the live pairing code mirror (`pairing`; the code itself lives in the
 *   Directory, which maps code -> bridge);
 * - the tunnel: each MCP HTTP request becomes a `req` frame; `res`/`chunk`/`end`
 *   frames become the HTTP response. Requests in flight keep the object awake;
 *   nothing about them is stored.
 * - live sessions (docs/design/live-vj-relay.md): the app's WebSockets, accepted
 *   with the Hibernation API too (tag "app"; attachment {app, fam, label}); their
 *   text messages pass through to the bridge as `live` frames and back, verbatim.
 *   Nothing about them is stored either: the routing is in the tags/attachments,
 *   so it survives hibernation.
 *
 * Only the Worker calls fetch() here; every call carries `x-bridge-id` (this
 * object's name) and `x-relay-origin` (the public origin).
 */

import { grantedScope } from "./oauth";
import { b64url, ed25519Verify, fromB64url, randomSecret, sha256b64url, sha256hex } from "./crypto";
import { EffectLibrary, LIBRARY_TOOL_NAMES, callLibraryTool, deployNoteText, slugEffectId, type EffectMeta, type LibraryStore } from "./library";
import { BUG_TOOL_NAME } from "../../../web/src/bugs/bugReport";
import { relayFileBug } from "./bugs";
import {
  RELAY_SESSION_PREFIX,
  bridgeHasFileBug,
  deployPerf,
  deploySucceeded,
  mergeTools,
  parseSingle,
  relayInitializeResult,
  rewriteReply,
  rpcErrorFor,
  rpcResult,
  sessionGone,
  stripDeployArgs,
  toolResultJson,
  toolCalls,
  toolFailure,
  withLibraryInstructions,
  type RpcRequest,
} from "./mcpLibrary";
import { now, upgrade, autoResponse, type DOState, type DOStorage, type Env, type HSocket } from "./platform";
import {
  BRIDGE_AUTH_HEADER,
  BUG_AUTH_HEADER,
  bugReportMessage,
  CLOSE_PROTOCOL,
  LIVE_BEARER_PREFIX,
  LIVE_CLOSE_BRIDGE,
  LIVE_CLOSE_REVOKED,
  LIVE_MAX_RATE_HZ,
  LIVE_SUBPROTOCOL,
  MAX_LIVE_CLIENTS,
  MAX_LIVE_MESSAGE,
  CLOSE_REPLACED,
  FORWARD_REQUEST_HEADERS,
  FORWARD_REQUEST_PREFIX,
  FORWARD_RESPONSE_HEADERS,
  PING,
  PONG,
  SIGNATURE_WINDOW_S,
  WIRE_VERSION,
  connectMessage,
  type BridgeFrame,
  type GrantInfo,
  type GrantKind,
  type Pairing,
  type RelayFrame,
} from "./protocol";

export const ACCESS_TTL_S = 24 * 3600;
export const REFRESH_TTL_S = 90 * 24 * 3600;
export const AUTH_CODE_TTL_S = 300;
/** Longest a tunnelled request may take end to end. */
export const REQUEST_TIMEOUT_MS = 10 * 60_000;
export const MAX_INFLIGHT = 32;
export const MAX_BODY = 4 * 1024 * 1024;
/** A grant's last_used_at is written at most this often (Durable Object writes
 * are a free-tier budget: 100 k rows/day across every bridge). */
export const LAST_USED_WRITE_S = 60;

export type TokenKind = "at" | "rt" | "pt" | "ac";

export const TOKEN_RE = /^spl_(at|rt|pt|ac)_([a-z2-7]{20})_([A-Za-z0-9_-]{43})$/;

export function parseToken(t: string | null | undefined): { kind: TokenKind; bridge: string; secret: string } | null {
  const m = t ? TOKEN_RE.exec(t.trim()) : null;
  return m ? { kind: m[1] as TokenKind, bridge: m[2]!, secret: m[3]! } : null;
}

interface Meta {
  pub: string;
  created: number;
  /** This object's bridge id (its name), for work that starts on a socket message. */
  bid: string;
  origin?: string;
}

interface TokRec {
  k: "at" | "rt" | "pt";
  /** Unix seconds, null = no expiry (personal tokens). */
  exp: number | null;
  /** The grant this token belongs to: revoked together. */
  fam: string;
  client: string;
  resource: string;
  created: number;
  label?: string;
  /** The granted scope (OAuth tokens; absent on older records = "splanc"). */
  scope?: string;
}

interface CodeRec {
  client: string;
  redirect: string;
  challenge: string;
  resource: string;
  scope: string;
  exp: number;
  /** The client's name from its registration (absent on codes from an older relay). */
  name?: string;
}

/** `grant:<id>`: what the bridge's client list shows about one grant. Grants paired
 * before the relay kept these have none until first used (then one is made from
 * their tokens); `grantList` makes the same from the tokens meanwhile. */
interface GrantRec {
  kind: GrantKind;
  label: string;
  created: number;
  last_used: number | null;
}

/** A readable name for an OAuth client id: a dynamic registration's own name (its
 * id carries it; the HMAC was checked when the code was issued), a metadata
 * document's host. */
export function clientLabel(client: string): string {
  if (client === "personal") return "Personal token";
  if (client.startsWith("dcr.")) {
    try {
      const n = (JSON.parse(new TextDecoder().decode(fromB64url(client.split(".")[1] ?? ""))) as { n?: unknown }).n;
      if (typeof n === "string" && n.trim()) return n.trim().slice(0, 80);
    } catch {
      // not ours
    }
  }
  try {
    return new URL(client).host || "Connector";
  } catch {
    return "Connector";
  }
}

/** A grant record made from one of its tokens (a grant from before grant records). */
function grantFromToken(rec: TokRec): GrantRec {
  const personal = rec.client === "personal";
  return {
    kind: personal ? "token" : "connector",
    label: (rec.label || clientLabel(rec.client)).slice(0, 80),
    created: rec.created,
    last_used: null,
  };
}

interface Pending {
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  /** JSON-RPC request ids in the tunnelled body (answered if the stream breaks). */
  ids: (string | number)[];
  /** The tools/call requests among them: id -> tool name. */
  tools?: Map<string | number, string>;
}

const enc = new TextEncoder();

/** The ids of the JSON-RPC requests (not notifications) in a POST body. */
export function requestIds(body: string): (string | number)[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const ids: (string | number)[] = [];
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    const r = m as { method?: unknown; id?: unknown } | null;
    if (r && typeof r.method === "string" && (typeof r.id === "string" || typeof r.id === "number")) ids.push(r.id);
  }
  return ids;
}

/** The reply for a request the tunnel failed: a tool result when it was one tool
 * call, else the transport-level JSON-RPC error. */
function failedReply(p: Pick<Pending, "ids" | "tools">, status: number, why: string, headers: Record<string, string> = {}): Response {
  const id = p.ids.length === 1 ? p.ids[0]! : undefined;
  const tool = id !== undefined ? p.tools?.get(id) : undefined;
  if (id !== undefined && tool !== undefined) return json(toolFailure(id, tool, why));
  return rpcError(status, why, headers);
}

/** End a streamed (SSE) reply the bridge can no longer finish: answer each request
 * in it with a JSON-RPC error, so the client fails the call now with the reason
 * instead of waiting out its own timeout on a stream that ended with no response. */
function breakStream(p: Pending, why: string): void {
  const c = p.stream!;
  try {
    for (const id of p.ids) {
      const tool = p.tools?.get(id);
      const msg = tool
        ? toolFailure(id, tool, `Splanc relay: ${why}; retry the request`)
        : { jsonrpc: "2.0", id, error: { code: -32000, message: `Splanc relay: ${why}; retry the request` } };
      c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
    }
    if (p.ids.length) c.close();
    else c.error(new Error(why));
  } catch {
    // cancelled already
  }
}

/** The message of a JSON-RPC error body (else the body itself, trimmed). */
function errorText(body: string | undefined): string {
  try {
    const m = JSON.parse(body ?? "") as { error?: { message?: string } };
    if (m.error?.message) return m.error.message;
  } catch {
    // not JSON
  }
  return (body ?? "").slice(0, 300) || "no details";
}

const json = (obj: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

/** A JSON-RPC error with no id (the transport-level failures). */
export const rpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  json({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }, status, headers);

const oauthError = (error: string, description: string, status = 400) =>
  json({ error, error_description: description }, status);

/** The bearer token from a live socket's subprotocol list (`splanc-live.v1, bearer.<tok>`). */
export function liveToken(protocols: string | null): string | null {
  if (!protocols) return null;
  const list = protocols.split(",").map((p) => p.trim());
  if (!list.includes(LIVE_SUBPROTOCOL)) return null;
  const b = list.find((p) => p.startsWith(LIVE_BEARER_PREFIX));
  return b ? b.slice(LIVE_BEARER_PREFIX.length) : null;
}

/** A live (app) socket's attachment. */
interface AppAttachment {
  app: string;
  fam: string;
  label: string;
  at: number;
}

export function wwwAuthenticate(origin: string, error?: string): string {
  return (
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="splanc offline_access"` +
    (error ? `, error="${error}"` : "")
  );
}

export class BridgeObject {
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  /** token hash -> record (null = known bad), for this wake period. */
  private readonly tokCache = new Map<string, TokRec | null>();
  /** Live socket rate windows (in memory: a hibernation resets them, which is fine). */
  private readonly liveRate = new Map<string, { t0: number; n: number; told: boolean }>();

  constructor(
    private readonly state: DOState,
    private readonly env: Env,
  ) {}

  private nowS(): number {
    return Math.floor(now(this.env) / 1000);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const bid = req.headers.get("x-bridge-id") ?? "";
    const origin = req.headers.get("x-relay-origin") ?? url.origin;
    const body = async () => (await req.json().catch(() => ({}))) as Record<string, string>;
    switch (url.pathname) {
      case "/init":
        return this.init((await body())["pub"] ?? "", bid);
      case "/connect":
        return this.connect(req, bid, origin);
      case "/mcp":
        return this.mcp(req, bid, origin);
      case "/live":
        return this.live(req, bid, origin);
      case "/oauth/code":
        return this.issueCode(await body(), bid);
      case "/oauth/token":
        return this.token(await body(), bid, origin);
      case "/oauth/revoke":
        await this.revokeToken((await body())["token"] ?? "");
        return json({ ok: true });
      case "/pair/token": {
        const b = await body();
        return this.personalToken(b["label"] ?? "", b["client"] ?? "", bid, origin);
      }
      case "/bugs/verify":
        return json({ ok: await this.verifyBugCaller(req, bid, origin) });
      default:
        return json({ error: "not found" }, 404);
    }
  }

  // -- registration + the bridge socket ------------------------------------------------

  private async init(pub: string, bid: string): Promise<Response> {
    if (await this.state.storage.get<Meta>("meta")) return json({ error: "exists" }, 409);
    await this.state.storage.put<Meta>("meta", { pub, bid, created: this.nowS() });
    return json({ ok: true });
  }

  private async connect(req: Request, bid: string, origin: string): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a WebSocket" }, 426);
    const meta = await this.state.storage.get<Meta>("meta");
    if (!meta) return json({ error: "unknown bridge: register again" }, 404);
    const [ts, sig] = (req.headers.get(BRIDGE_AUTH_HEADER) ?? "").split(".");
    const t = Number(ts);
    if (!Number.isFinite(t) || Math.abs(this.nowS() - t) > SIGNATURE_WINDOW_S) {
      return json({ error: "stale or missing signature (check the bridge's clock)" }, 401);
    }
    if (!(await ed25519Verify(meta.pub, connectMessage(bid, t), sig ?? ""))) return json({ error: "bad signature" }, 401);
    if (meta.origin !== origin || meta.bid !== bid) await this.state.storage.put<Meta>("meta", { ...meta, bid, origin });
    for (const old of this.state.getWebSockets("bridge")) {
      try {
        old.close(CLOSE_REPLACED, "replaced by a newer connection");
      } catch {
        // already closing
      }
    }
    this.failAll(502, "the bridge reconnected");
    const { response, socket } = upgrade(this.env, this.state, ["bridge"]);
    socket.serializeAttachment({ at: now(this.env), n: Math.random() });
    autoResponse(this.env, this.state, PING, PONG);
    const grants = await this.grantList();
    const hello: RelayFrame = {
      t: "hello",
      v: WIRE_VERSION,
      bridge_id: bid,
      relay: origin,
      mcp_url: `${origin}/mcp`,
      credentials: grants.length,
      pairing: await this.pairing(),
      grants,
    };
    socket.send(JSON.stringify(hello));
    return response;
  }

  /** The current bridge socket: the newest accepted one. */
  private bridge(): HSocket | undefined {
    let best: HSocket | undefined;
    let bestAt = -1;
    for (const ws of this.state.getWebSockets("bridge")) {
      const a = ws.deserializeAttachment() as { at?: number } | null;
      const at = a?.at ?? 0;
      if (at > bestAt) {
        best = ws;
        bestAt = at;
      }
    }
    return best;
  }

  private send(frame: RelayFrame): void {
    try {
      this.bridge()?.send(JSON.stringify(frame));
    } catch {
      // closed under us: the bridge will reconnect and get a hello
    }
  }

  /** Tell the bridge its credentials or pairing changed; `grants`: the client list
   * changed too (sent only to a bridge that keeps one: its `caps` said so). */
  private async pushState(reason: string, grants = true): Promise<void> {
    const list = await this.grantList();
    this.send({ t: "state", credentials: list.length, pairing: await this.pairing(), reason });
    if (grants && this.wantsGrants()) this.send({ t: "grants", grants: list, reason });
  }

  /** Whether the current bridge socket asked for `grants` frames (its caps). */
  private wantsGrants(): boolean {
    const a = this.bridge()?.deserializeAttachment() as { grants?: number } | null | undefined;
    return !!a?.grants;
  }

  async webSocketMessage(ws: HSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message === PING) {
      // Normally auto-answered; a host without auto-response lands here.
      ws.send(PONG);
      return;
    }
    const app = appOf(ws);
    if (app) {
      this.fromApp(ws, app, message);
      return;
    }
    let f: BridgeFrame;
    try {
      f = JSON.parse(message) as BridgeFrame;
    } catch {
      ws.close(CLOSE_PROTOCOL, "bad frame");
      return;
    }
    switch (f.t) {
      case "res": {
        const p = this.pending.get(f.id);
        if (!p) return;
        const headers = pick(f.headers, FORWARD_RESPONSE_HEADERS);
        if (f.end) {
          this.finish(f.id);
          if (f.status >= 500 && p.ids.length === 1 && p.tools?.has(p.ids[0]!)) {
            // An (older) bridge's internal error for a tool call: keep its message.
            p.resolve(failedReply(p, f.status, `Splanc relay: the bridge answered HTTP ${f.status}: ${errorText(f.body)}`));
            return;
          }
          p.resolve(new Response(nullBody(f.status) ? null : (f.body ?? ""), { status: f.status, headers }));
          return;
        }
        const id = f.id;
        const stream = new ReadableStream<Uint8Array>({
          start: (c) => {
            p.stream = c;
          },
          cancel: () => {
            // The cloud agent went away: tell the bridge to stop.
            this.finish(id);
            this.send({ t: "cancel", id });
          },
        });
        if (headers["content-type"]?.startsWith("text/event-stream")) headers["x-accel-buffering"] = "no";
        p.resolve(new Response(stream, { status: f.status, headers }));
        return;
      }
      case "chunk":
        try {
          this.pending.get(f.id)?.stream?.enqueue(enc.encode(f.data));
        } catch {
          this.finish(f.id);
        }
        return;
      case "end": {
        const p = this.pending.get(f.id);
        this.finish(f.id);
        try {
          p?.stream?.close();
        } catch {
          // cancelled already
        }
        return;
      }
      case "new_code":
        await this.newCode();
        return;
      case "revoke_all":
        await this.revokeAll();
        return;
      case "list_grants":
        this.send({ t: "grants", grants: await this.grantList() });
        return;
      case "revoke_grant":
        await this.revokeGrant(typeof f.grant === "string" ? f.grant : "");
        return;
      case "caps": {
        const a = (ws.deserializeAttachment() ?? {}) as Record<string, unknown>;
        ws.serializeAttachment({ ...a, live: f.live ?? 0, grants: f.grants ?? 0 });
        if (f.grants) this.send({ t: "grants", grants: await this.grantList() });
        // The bridge (re)connected: hand it every live session still open here.
        for (const s of this.state.getWebSockets("app")) {
          const x = appOf(s);
          if (!x) continue;
          this.send({ t: "live_open", c: x.app, label: x.label, grant: x.fam });
          trySend(s, JSON.stringify({ t: "relay", bridge: "online" }));
        }
        return;
      }
      case "live": {
        const s = this.state.getWebSockets(`app:${f.c}`)[0];
        if (s) trySend(s, f.d);
        else this.send({ t: "live_close", c: f.c, reason: "gone" });
        return;
      }
      case "live_close":
        for (const s of this.state.getWebSockets(`app:${f.c}`)) {
          try {
            s.close(f.code ?? LIVE_CLOSE_BRIDGE, (f.reason ?? "closed by the bridge").slice(0, 120));
          } catch {
            // closed
          }
        }
        return;
      default:
        return;
    }
  }

  async webSocketClose(ws: HSocket, code: number, reason: string): Promise<void> {
    const app = appOf(ws);
    if (app) {
      this.liveRate.delete(app.app);
      this.send({ t: "live_close", c: app.app });
      try {
        ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
      } catch {
        // closed
      }
      return;
    }
    // A replaced (older) socket closing must not fail the new one's requests.
    const cur = this.bridge();
    if (!cur || cur === ws) {
      this.failAll(502, "the bridge disconnected");
      // Live sessions stay open: the app shows "bridge offline" and carries on
      // when the bridge is back (its caps frame re-opens them there).
      for (const s of this.state.getWebSockets("app")) trySend(s, JSON.stringify({ t: "relay", bridge: "offline" }));
    }
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // closed
    }
  }

  async webSocketError(ws: HSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }

  private finish(id: number): void {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(id);
  }

  private failAll(status: number, why: string): void {
    for (const [id, p] of [...this.pending]) {
      this.finish(id);
      if (p.stream) breakStream(p, why);
      else p.resolve(failedReply(p, status, `Splanc relay: ${why}; retry the request`));
    }
  }

  // -- bug reports (POST /bugs: relay/src/bugs.ts) -------------------------------------

  /** Is this credential this bridge's: one of its relay tokens (the MCP resource's),
   * or its Ed25519 signature over the report (BUG_AUTH_HEADER)? */
  private async verifyBugCaller(req: Request, bid: string, origin: string): Promise<boolean> {
    if (req.headers.get("authorization")) return !((await this.authorize(req, bid, origin)) instanceof Response);
    const [sigBid, ts, sig] = (req.headers.get(BUG_AUTH_HEADER) ?? "").split(".");
    const t = Number(ts);
    if (sigBid !== bid || !Number.isFinite(t) || Math.abs(this.nowS() - t) > SIGNATURE_WINDOW_S) return false;
    const meta = await this.state.storage.get<Meta>("meta");
    if (!meta) return false;
    return ed25519Verify(meta.pub, bugReportMessage(bid, t, req.headers.get("x-bug-body-sha256") ?? ""), sig ?? "");
  }

  // -- the MCP tunnel ------------------------------------------------------------------

  /** The caller's token record, or the 401 to answer. */
  private async authorize(req: Request, bid: string, origin: string): Promise<Response | TokRec> {
    const h = req.headers.get("authorization") ?? "";
    const tok = parseToken(h.startsWith("Bearer ") ? h.slice(7) : null);
    const deny = () =>
      json({ error: "invalid_token" }, 401, { "www-authenticate": wwwAuthenticate(origin, "invalid_token") });
    if (!tok || tok.bridge !== bid || (tok.kind !== "at" && tok.kind !== "pt")) return deny();
    const rec = await this.lookup(tok.secret);
    if (!rec || rec.k !== tok.kind || (rec.exp !== null && rec.exp <= this.nowS())) return deny();
    if (rec.resource && rec.resource !== `${origin}/mcp`) return deny();
    return rec;
  }

  private async lookup(secret: string): Promise<TokRec | null> {
    const h = await sha256hex(secret);
    if (this.tokCache.has(h)) return this.tokCache.get(h)!;
    const rec = (await this.state.storage.get<TokRec>(`tok:${h}`)) ?? null;
    this.tokCache.set(h, rec);
    return rec;
  }

  private async mcp(req: Request, bid: string, origin: string): Promise<Response> {
    const auth = await this.authorize(req, bid, origin);
    if (auth instanceof Response) return auth;
    await this.touch(auth);
    // No standalone GET stream: it would keep this object awake (billed) for as long
    // as a client holds it. The spec lets a server decline it with 405.
    if (req.method !== "POST" && req.method !== "DELETE") {
      return json({ error: "method not allowed" }, 405, { allow: "POST, DELETE" });
    }
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) return rpcError(413, "request body too large");
    let body = req.method === "POST" ? await req.text() : "";
    if (body.length > MAX_BODY) return rpcError(413, "request body too large");
    const sid = req.headers.get("mcp-session-id") ?? "";
    const relaySession = sid.startsWith(RELAY_SESSION_PREFIX);
    const ws = this.bridge();
    // The effects library is served here (docs/design/cloud-relay.md, "Effects library").
    const msg = req.method === "POST" ? parseSingle(body) : null;
    if (relaySession && req.method === "DELETE") return new Response(null, { status: 204 });
    if (msg) {
      const name = msg.method === "tools/call" ? msg.params?.["name"] : undefined;
      if (typeof name === "string" && LIBRARY_TOOL_NAMES.has(name) && msg.id !== undefined) {
        return rpcResult(msg.id, await callLibraryTool(await this.library(), name, msg.params?.["arguments"]));
      }
      // file_bug: the bridge's own (it adds device diagnostics) when it has one and
      // is online; else the relay's (relay/src/bugs.ts).
      if (name === BUG_TOOL_NAME && msg.id !== undefined && (!ws || relaySession || !(await this.bridgeFileBug()))) {
        return rpcResult(
          msg.id,
          await relayFileBug(this.env, bid, msg.params?.["arguments"], { bridgeOnline: !!ws, version: String(WIRE_VERSION) }),
        );
      }
      if (relaySession && ws) return sessionGone(); // the bridge is back: initialize again
      if (relaySession || !ws) {
        const offline = this.offlineMcp(msg, relaySession);
        if (offline) return offline;
      }
      if (ws && name === "deploy_effect" && msg.id !== undefined) {
        const prepared = await this.prepareDeploy(msg);
        if (prepared instanceof Response) return prepared;
        body = prepared.body;
        return this.afterDeploy(await this.forward(ws, req, body), msg.id, prepared);
      }
      if (ws && name === "crossfade_to" && msg.id !== undefined) {
        const prepared = await this.prepareCrossfade(msg);
        if (prepared instanceof Response) return prepared;
        return this.forward(ws, req, prepared);
      }
      if (ws && name === "measure_effect" && msg.id !== undefined) {
        return rewriteReply(await this.forward(ws, req, body), msg.id, async (m) => {
          if (m.result && m.result["isError"] !== true) await (await this.library()).noteMeasure(toolResultJson(m.result));
          return m;
        });
      }
      if (ws && msg.id !== undefined && (msg.method === "tools/list" || msg.method === "initialize")) {
        const method = msg.method;
        const first = !msg.params?.["cursor"];
        return rewriteReply(await this.forward(ws, req, body), msg.id, async (m) => {
          if (!m.result) return m;
          if (method === "initialize") return { ...m, result: { ...m.result, instructions: withLibraryInstructions(m.result["instructions"]) } };
          if (!first) return m;
          await this.setBridgeFileBug(bridgeHasFileBug(m.result["tools"]));
          return { ...m, result: { ...m.result, tools: mergeTools(m.result["tools"]) } };
        });
      }
    } else if (relaySession && req.method === "POST") {
      return ws ? sessionGone() : rpcErrorFor(null, -32600, "the relay's offline session takes one JSON-RPC message per request", 400);
    }
    if (!ws) {
      return failedReply(
        msg ? { ids: msg.id !== undefined ? [msg.id] : [], tools: toolCalls(body) } : { ids: [] },
        503,
        "The Splanc bridge for this connector is offline. Check that the bridge (e.g. the Raspberry Pi " +
          "running `splanc-agent bridge`) is powered and online; its screen or status file shows why.",
        { "retry-after": "30" },
      );
    }
    return this.forward(ws, req, body);
  }

  /** What the relay answers by itself while the bridge is offline (or on its own
   * offline session); null = the usual 503. */
  private offlineMcp(msg: RpcRequest, relaySession: boolean): Response | null {
    if (msg.id === undefined) return relaySession ? new Response(null, { status: 202 }) : null;
    switch (msg.method) {
      case "initialize": {
        const session = `${RELAY_SESSION_PREFIX}${b64url(crypto.getRandomValues(new Uint8Array(16)))}`;
        return rpcResult(msg.id, relayInitializeResult(msg.params, String(WIRE_VERSION)), { "mcp-session-id": session });
      }
      case "tools/list":
        return rpcResult(msg.id, { tools: mergeTools([]) });
      case "ping":
        return relaySession ? rpcResult(msg.id, {}) : null;
      default: {
        if (!relaySession) return null;
        const why = "The Splanc bridge is offline: only the effects library tools work until it is back (then reconnect).";
        const tool = msg.method === "tools/call" && typeof msg.params?.["name"] === "string" ? (msg.params["name"] as string) : null;
        // A tool call gets a tool result with the reason (MCP clients show a JSON-RPC
        // error only as a generic failure).
        return tool ? json(toolFailure(msg.id, tool, why)) : rpcErrorFor(msg.id, -32000, why);
      }
    }
  }

  /** Whether the bridge's last tools/list offered file_bug (kept in storage:
   * hibernation drops memory). Unknown = no: the relay's file_bug still works. */
  private fileBugFlag: boolean | undefined;

  private async bridgeFileBug(): Promise<boolean> {
    this.fileBugFlag ??= (await this.state.storage.get<boolean>("bridgeFileBug")) ?? false;
    return this.fileBugFlag;
  }

  private async setBridgeFileBug(v: boolean): Promise<void> {
    if ((await this.bridgeFileBug()) === v) return;
    this.fileBugFlag = v;
    await this.state.storage.put("bridgeFileBug", v);
  }

  private lib: EffectLibrary | null = null;

  private async library(): Promise<EffectLibrary> {
    this.lib ??= new EffectLibrary(new DOLibraryStore(this.state.storage), { now: () => now(this.env) });
    return this.lib;
  }

  /** deploy_effect: resolve library_id to its source here, and strip the library's
   * arguments (the bridge, perhaps an older one, knows nothing of them). */
  private async prepareDeploy(msg: RpcRequest): Promise<Response | PreparedDeploy> {
    const params = msg.params ?? {};
    const args = { ...((params["arguments"] as Record<string, unknown>) ?? {}) };
    const meta: PreparedDeploy = {
      body: "",
      source: typeof args["source"] === "string" ? (args["source"] as string) : "",
      library_id: typeof args["library_id"] === "string" ? (args["library_id"] as string) : undefined,
      effect_id: typeof args["effect_id"] === "string" ? (args["effect_id"] as string) : undefined,
      name: typeof args["name"] === "string" ? (args["name"] as string) : undefined,
      description: typeof args["description"] === "string" ? (args["description"] as string) : undefined,
      tags: Array.isArray(args["tags"]) ? (args["tags"] as string[]).filter((t) => typeof t === "string") : undefined,
    };
    if (meta.library_id) {
      try {
        const { entry, effectId } = await (await this.library()).forDeploy(meta.library_id, meta.effect_id);
        if (!meta.source) meta.source = entry.source;
        args["source"] = meta.source;
        args["effect_id"] = effectId;
        meta.effect_id = effectId;
      } catch (e) {
        return rpcResult(msg.id!, { isError: true, content: [{ type: "text", text: (e as Error).message }] });
      }
    } else if (!args["effect_id"] && meta.source) {
      args["effect_id"] = slugEffectId(meta.name ?? "", "effect");
      meta.effect_id = args["effect_id"] as string;
    }
    meta.body = JSON.stringify({ ...msg, params: { ...params, arguments: stripDeployArgs(args) } });
    return meta;
  }

  /** crossfade_to {library_id}: resolve the entry's source (and an effect id)
   * here, like deploy_effect; the bridge sees plain source. */
  private async prepareCrossfade(msg: RpcRequest): Promise<Response | string> {
    const params = msg.params ?? {};
    const args = { ...((params["arguments"] as Record<string, unknown>) ?? {}) };
    if (typeof args["library_id"] === "string") {
      try {
        const eid = typeof args["effect_id"] === "string" ? (args["effect_id"] as string) : undefined;
        const { entry, effectId } = await (await this.library()).forDeploy(args["library_id"], eid);
        if (typeof args["source"] !== "string") args["source"] = entry.source;
        args["effect_id"] = effectId;
      } catch (e) {
        return rpcResult(msg.id!, { isError: true, content: [{ type: "text", text: (e as Error).message }] });
      }
      delete args["library_id"];
    }
    return JSON.stringify({ ...msg, params: { ...params, arguments: args } });
  }

  /** A successful deploy goes into the library (or counts a use); the library's
   * note is added to the result as a second text block. */
  private afterDeploy(res: Response, id: string | number, d: PreparedDeploy): Response {
    if (!d.source) return res;
    return rewriteReply(res, id, async (m) => {
      if (!m.result || !deploySucceeded(m.result)) return m;
      const note = await (await this.library()).noteDeploy({ ...d, perf: deployPerf(m.result) });
      const content = Array.isArray(m.result["content"]) ? (m.result["content"] as unknown[]) : [];
      return { ...m, result: { ...m.result, content: [...content, { type: "text", text: deployNoteText(note) }] } };
    });
  }

  /** Tunnel one HTTP request to the bridge; resolves with its reply. */
  private forward(ws: HSocket, req: Request, body: string): Promise<Response> {
    if (this.pending.size >= MAX_INFLIGHT) return Promise.resolve(rpcError(429, "too many requests in flight", { "retry-after": "5" }));
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      if (FORWARD_REQUEST_HEADERS.includes(k) || k.startsWith(FORWARD_REQUEST_PREFIX)) headers[k] = v;
    });
    const id = ++this.seq;
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        this.finish(id);
        this.send({ t: "cancel", id });
        if (p?.stream) breakStream(p, "the bridge did not finish in time");
        else resolve(failedReply(pend, 504, `Splanc relay: the bridge did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`));
      }, REQUEST_TIMEOUT_MS);
      const pend: Pending = {
        resolve,
        timer,
        ids: req.method === "POST" ? requestIds(body) : [],
        tools: req.method === "POST" ? toolCalls(body) : new Map(),
      };
      this.pending.set(id, pend);
      try {
        ws.send(JSON.stringify({ t: "req", id, method: req.method, headers, body } satisfies RelayFrame));
      } catch (e) {
        this.finish(id);
        resolve(failedReply(pend, 503, `Splanc relay: the bridge connection dropped (${(e as Error).message}); retry`));
      }
    });
  }

  // -- live sessions (docs/design/live-vj-relay.md) ------------------------------------

  private async live(req: Request, bid: string, origin: string): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ error: "expected a WebSocket" }, 426);
    const tok = parseToken(liveToken(req.headers.get("sec-websocket-protocol")));
    const deny = () => json({ error: "invalid_token" }, 401);
    if (!tok || tok.bridge !== bid || (tok.kind !== "at" && tok.kind !== "pt")) return deny();
    const rec = await this.lookup(tok.secret);
    if (!rec || rec.k !== tok.kind || (rec.exp !== null && rec.exp <= this.nowS())) return deny();
    if (rec.resource && rec.resource !== `${origin}/mcp`) return deny();
    const b = this.bridge();
    if (!b) return json({ error: "bridge_offline", error_description: "the bridge is offline" }, 503, { "retry-after": "30" });
    const caps = (b.deserializeAttachment() ?? {}) as { live?: number };
    if (!caps.live) {
      return json({ error: "bridge_outdated", error_description: "this bridge doesn't do live sessions yet: update it" }, 501);
    }
    if (this.state.getWebSockets("app").length >= MAX_LIVE_CLIENTS) {
      return json({ error: "too_many_sessions", error_description: `at most ${MAX_LIVE_CLIENTS} live sessions per bridge` }, 429);
    }
    const c = b64url(crypto.getRandomValues(new Uint8Array(9)));
    const label = (rec.label || (rec.client === "personal" ? "app" : "connector")).slice(0, 80);
    await this.touch(rec, rec.k === "pt"); // a personal token that opens a live session is the app's
    const { response, socket } = upgrade(this.env, this.state, ["app", `app:${c}`], { "sec-websocket-protocol": LIVE_SUBPROTOCOL });
    socket.serializeAttachment({ app: c, fam: rec.fam, label, at: now(this.env) } satisfies AppAttachment);
    autoResponse(this.env, this.state, PING, PONG);
    this.send({ t: "live_open", c, label, grant: rec.fam });
    return response;
  }

  private fromApp(ws: HSocket, app: AppAttachment, message: string): void {
    if (message.length > MAX_LIVE_MESSAGE) {
      trySend(ws, JSON.stringify({ t: "relay", error: "message too large" }));
      return;
    }
    // A sliding 1 s window: the app coalesces to <= 30 Hz, so this only trips on a
    // runaway client, which must not spend the free tier's daily budget.
    const t = now(this.env);
    let w = this.liveRate.get(app.app);
    if (!w || t - w.t0 >= 1000) {
      w = { t0: t, n: 0, told: false };
      this.liveRate.set(app.app, w);
    }
    if (++w.n > LIVE_MAX_RATE_HZ) {
      if (!w.told) trySend(ws, JSON.stringify({ t: "relay", error: `rate limited (> ${LIVE_MAX_RATE_HZ} messages/s): dropped` }));
      w.told = true;
      return;
    }
    const b = this.bridge();
    if (!b) {
      trySend(ws, JSON.stringify({ t: "relay", bridge: "offline" }));
      return;
    }
    trySend(b, JSON.stringify({ t: "live", c: app.app, d: message } satisfies RelayFrame));
  }

  /** Close the live sessions of these grants ("*" = all) and tell the bridge. */
  private endLive(grants: string[]): void {
    const all = grants.includes("*");
    for (const s of this.state.getWebSockets("app")) {
      const a = appOf(s);
      if (!a || !(all || grants.includes(a.fam))) continue;
      try {
        s.close(LIVE_CLOSE_REVOKED, "credential revoked");
      } catch {
        // closed
      }
    }
    this.send({ t: "revoked", grants });
  }

  // -- pairing ---------------------------------------------------------------------------

  private async pairing(): Promise<Pairing | null> {
    const p = await this.state.storage.get<Pairing>("pairing");
    return p && p.expires_at > this.nowS() ? p : null;
  }

  private async newCode(): Promise<void> {
    const meta = await this.state.storage.get<Meta>("meta");
    const bid = meta?.bid;
    if (!meta || !bid) return;
    const r = await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global")).fetch("https://directory/code/new", {
      method: "POST",
      body: JSON.stringify({ bridge: bid }),
    });
    const j = (await r.json()) as { code?: string; expires_at?: number; error?: string };
    if (!r.ok || !j.code) {
      this.send({ t: "error", for: "new_code", message: j.error ?? `pairing code failed (${r.status})` });
      return;
    }
    const origin = meta.origin ?? "";
    await this.state.storage.put<Pairing>("pairing", {
      code: j.code,
      expires_at: j.expires_at!,
      url: `${origin}/pair?code=${encodeURIComponent(j.code)}`,
    });
    await this.pushState("new pairing code", false);
  }

  private async clearPairing(reason: string): Promise<void> {
    if (await this.state.storage.get("pairing")) {
      await this.state.storage.delete("pairing");
      await this.pushState(reason, false);
    }
  }

  // -- credentials -----------------------------------------------------------------------

  /** Live grants (OAuth families with a refresh token + personal tokens), oldest
   * first, with their metadata; purges the expired (and grant records whose tokens
   * are all gone). Its length is the bridge's credential count. */
  private async grantList(): Promise<GrantInfo[]> {
    const t = this.nowS();
    const fams = new Map<string, TokRec>();
    const dead: string[] = [];
    for (const [k, v] of await this.state.storage.list<TokRec>({ prefix: "tok:" })) {
      if (v.exp !== null && v.exp <= t) dead.push(k);
      else if (v.k !== "at") {
        const had = fams.get(v.fam);
        if (!had || v.created < had.created) fams.set(v.fam, v);
      }
    }
    for (const [k, v] of await this.state.storage.list<{ exp: number }>({ prefix: "used:" })) if (v.exp <= t) dead.push(k);
    for (const [k, v] of await this.state.storage.list<CodeRec>({ prefix: "ac:" })) if (v.exp <= t) dead.push(k);
    const recs = await this.state.storage.list<GrantRec>({ prefix: "grant:" });
    for (const k of recs.keys()) if (!fams.has(k.slice(6))) dead.push(k);
    for (let i = 0; i < dead.length; i += 128) await this.state.storage.delete(dead.slice(i, i + 128));
    const out: GrantInfo[] = [];
    for (const [fam, tok] of fams) {
      const g = recs.get(`grant:${fam}`) ?? grantFromToken(tok);
      out.push({ id: fam, label: g.label, kind: g.kind, created_at: g.created, last_used_at: g.last_used });
    }
    return out.sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
  }

  /** grant id -> unix s of the last last_used write this wake period (throttle). */
  private readonly touched = new Map<string, number>();

  /** A grant was used (an MCP call, a live session, a refresh): record when, at most
   * once per LAST_USED_WRITE_S per grant (one row read per grant per wake period,
   * one row write per minute of use), and tell the bridge. `app`: it opened a live
   * session, which only the app does (a personal token's kind becomes `app`). */
  private async touch(rec: TokRec, app = false): Promise<void> {
    const t = this.nowS();
    const last = this.touched.get(rec.fam);
    if (!app && last !== undefined && t - last < LAST_USED_WRITE_S) return;
    const key = `grant:${rec.fam}`;
    const g = await this.state.storage.get<GrantRec>(key);
    const promote = app && (g?.kind ?? grantFromToken(rec).kind) === "token";
    if (!promote && g?.last_used != null && t - g.last_used < LAST_USED_WRITE_S) {
      this.touched.set(rec.fam, g.last_used);
      return;
    }
    const next: GrantRec = { ...(g ?? grantFromToken(rec)), last_used: t, ...(promote ? { kind: "app" as const } : {}) };
    await this.state.storage.put<GrantRec>(key, next);
    this.touched.set(rec.fam, t);
    if (this.wantsGrants()) this.send({ t: "grants", grants: await this.grantList(), reason: "client used" });
  }

  private async mint(kind: "at" | "rt" | "pt", bid: string, rec: Omit<TokRec, "k" | "created">): Promise<string> {
    const secret = randomSecret();
    const full: TokRec = { ...rec, k: kind, created: this.nowS() };
    const h = await sha256hex(secret);
    await this.state.storage.put(`tok:${h}`, full);
    this.tokCache.set(h, full);
    return `spl_${kind}_${bid}_${secret}`;
  }

  private async issueCode(b: Record<string, string>, bid: string): Promise<Response> {
    const secret = randomSecret();
    await this.state.storage.put<CodeRec>(`ac:${await sha256hex(secret)}`, {
      client: b["client_id"]!,
      redirect: b["redirect_uri"]!,
      challenge: b["code_challenge"]!,
      resource: b["resource"]!,
      scope: grantedScope(b["scope"]),
      exp: this.nowS() + AUTH_CODE_TTL_S,
      ...(b["client_name"] ? { name: String(b["client_name"]).slice(0, 80) } : {}),
    });
    await this.clearPairing("pairing code redeemed");
    return json({ code: `spl_ac_${bid}_${secret}` });
  }

  private async grant(bid: string, fam: string, client: string, resource: string, scope: string): Promise<Response> {
    const t = this.nowS();
    const access = await this.mint("at", bid, { exp: t + ACCESS_TTL_S, fam, client, resource, scope });
    const refresh = await this.mint("rt", bid, { exp: t + REFRESH_TTL_S, fam, client, resource, scope });
    return json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope,
    });
  }

  private async token(b: Record<string, string>, bid: string, origin: string): Promise<Response> {
    const resource = `${origin}/mcp`;
    if (b["resource"] && !sameResource(b["resource"], origin)) return oauthError("invalid_target", "unknown resource");
    if (b["grant_type"] === "authorization_code") {
      const tok = parseToken(b["code"]);
      if (!tok || tok.kind !== "ac" || tok.bridge !== bid) return oauthError("invalid_grant", "bad code");
      const key = `ac:${await sha256hex(tok.secret)}`;
      const rec = await this.state.storage.get<CodeRec>(key);
      if (!rec) return oauthError("invalid_grant", "unknown or used code");
      await this.state.storage.delete(key); // single use, whatever happens next
      if (rec.exp <= this.nowS()) return oauthError("invalid_grant", "code expired");
      if (rec.client !== b["client_id"]) return oauthError("invalid_grant", "client mismatch");
      if (rec.redirect !== b["redirect_uri"]) return oauthError("invalid_grant", "redirect_uri mismatch");
      const verifier = b["code_verifier"] ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || (await sha256b64url(verifier)) !== rec.challenge) {
        return oauthError("invalid_grant", "PKCE verification failed");
      }
      const fam = b64url(crypto.getRandomValues(new Uint8Array(12)));
      const r = await this.grant(bid, fam, rec.client, resource, grantedScope(rec.scope));
      await this.state.storage.put<GrantRec>(`grant:${fam}`, {
        kind: "connector",
        label: (rec.name?.trim() || clientLabel(rec.client)).slice(0, 80),
        created: this.nowS(),
        last_used: null,
      });
      await this.pushState("connector authorized");
      return r;
    }
    if (b["grant_type"] === "refresh_token") {
      const tok = parseToken(b["refresh_token"]);
      if (!tok || tok.kind !== "rt" || tok.bridge !== bid) return oauthError("invalid_grant", "bad refresh token");
      const h = await sha256hex(tok.secret);
      const rec = await this.state.storage.get<TokRec>(`tok:${h}`);
      if (!rec) {
        // A rotated-out refresh token came back: someone holds a copy. Revoke its grant.
        const used = await this.state.storage.get<{ fam: string }>(`used:${h}`);
        if (used) {
          await this.revokeFamily(used.fam);
          await this.pushState("refresh token reuse: grant revoked");
        }
        return oauthError("invalid_grant", "unknown or revoked refresh token");
      }
      if (rec.exp !== null && rec.exp <= this.nowS()) return oauthError("invalid_grant", "refresh token expired");
      if (rec.client !== b["client_id"]) return oauthError("invalid_grant", "client mismatch");
      await this.touch(rec);
      await this.state.storage.delete(`tok:${h}`);
      this.tokCache.delete(h);
      await this.state.storage.put(`used:${h}`, { fam: rec.fam, exp: rec.exp ?? this.nowS() + REFRESH_TTL_S });
      // A refresh keeps the grant's scope (RFC 6749 §6: never more than granted).
      return this.grant(bid, rec.fam, rec.client, resource, rec.scope ?? "splanc");
    }
    return oauthError("unsupported_grant_type", "authorization_code or refresh_token");
  }

  /** `/pair`: a personal token. `kind`: "app" when the Splanc app asked (it says
   * so; an older app is recognised when it opens its first live session). */
  private async personalToken(label: string, kind: string, bid: string, origin: string): Promise<Response> {
    const fam = b64url(crypto.getRandomValues(new Uint8Array(12)));
    const app = kind === "app";
    const token = await this.mint("pt", bid, {
      exp: null,
      fam,
      client: "personal",
      resource: `${origin}/mcp`,
      label: label.slice(0, 80),
    });
    await this.state.storage.put<GrantRec>(`grant:${fam}`, {
      kind: app ? "app" : "token",
      label: (label.trim() || (app ? "Splanc app" : "Personal token")).slice(0, 80),
      created: this.nowS(),
      last_used: null,
    });
    await this.clearPairing("pairing code redeemed");
    await this.pushState("personal token issued");
    return json({ token });
  }

  private async revokeFamily(fam: string): Promise<number> {
    const dead: string[] = [];
    for (const [k, v] of await this.state.storage.list<TokRec>({ prefix: "tok:" })) if (v.fam === fam) dead.push(k);
    if (await this.state.storage.get(`grant:${fam}`)) dead.push(`grant:${fam}`);
    for (let i = 0; i < dead.length; i += 128) await this.state.storage.delete(dead.slice(i, i + 128));
    this.tokCache.clear();
    this.touched.delete(fam);
    this.endLive([fam]);
    return dead.length;
  }

  /** The bridge's `revoke_grant`: one paired client, as `POST /revoke` with one of
   * its tokens would (its tokens, its live sessions; the `revoked` frame ends its
   * LAN tickets on the bridge). Only this bridge's own socket gets here. */
  private async revokeGrant(fam: string): Promise<void> {
    const known = fam !== "" && (await this.grantList()).some((g) => g.id === fam);
    if (!known) {
      this.send({ t: "error", for: "revoke_grant", grant: fam, message: "no paired client with that id" });
      return;
    }
    await this.revokeFamily(fam);
    await this.pushState("client revoked");
  }

  private async revokeToken(token: string): Promise<void> {
    const tok = parseToken(token);
    if (!tok || tok.kind === "ac") return;
    const rec = await this.state.storage.get<TokRec>(`tok:${await sha256hex(tok.secret)}`);
    if (!rec) return;
    await this.revokeFamily(rec.fam);
    await this.pushState("token revoked");
  }

  /** Revoke every credential for this bridge (the bridge's "revoke all" button). */
  private async revokeAll(): Promise<void> {
    const keys: string[] = [];
    for (const prefix of ["tok:", "used:", "ac:", "grant:"]) {
      for (const k of (await this.state.storage.list({ prefix })).keys()) keys.push(k);
    }
    for (let i = 0; i < keys.length; i += 128) await this.state.storage.delete(keys.slice(i, i + 128));
    this.tokCache.clear();
    this.touched.clear();
    this.endLive(["*"]);
    await this.pushState("all credentials revoked");
  }
}

function appOf(ws: HSocket): AppAttachment | null {
  const a = ws.deserializeAttachment() as Partial<AppAttachment> | null;
  return a && typeof a.app === "string" ? (a as AppAttachment) : null;
}

function trySend(ws: HSocket, data: string): void {
  try {
    ws.send(data);
  } catch {
    // closing: its close handler cleans up
  }
}

function pick(h: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) if (names.includes(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}

const nullBody = (status: number) => status === 204 || status === 205 || status === 304 || status === 202;

/** RFC 8707 resource: our MCP endpoint (or the bare origin), scheme/host case-insensitive. */
export function sameResource(r: string, origin: string): boolean {
  try {
    const u = new URL(r);
    const o = new URL(origin);
    const path = u.pathname.replace(/\/+$/, "");
    return u.protocol === o.protocol && u.host.toLowerCase() === o.host.toLowerCase() && (path === "/mcp" || path === "");
  } catch {
    return false;
  }
}

interface PreparedDeploy {
  /** The JSON-RPC body forwarded to the bridge. */
  body: string;
  source: string;
  library_id: string | undefined;
  effect_id: string | undefined;
  name: string | undefined;
  description: string | undefined;
  tags: string[] | undefined;
}

/**
 * The effects library in this object's storage (SQLite-backed; the KV API keeps
 * it on the Node host too): `fx:<id>` = an entry's metadata (the search index,
 * read once per wake), `fxs:<id>` = its source (read by id only), `fxk:<name>` =
 * library flags. New keys in the existing class: no Durable Object migration.
 */
export class DOLibraryStore implements LibraryStore {
  constructor(private readonly s: DOStorage) {}

  async loadAll(): Promise<EffectMeta[]> {
    return [...(await this.s.list<EffectMeta>({ prefix: "fx:" })).values()];
  }

  getSource(id: string): Promise<string | undefined> {
    return this.s.get<string>(`fxs:${id}`);
  }

  async put(meta: EffectMeta, source?: string): Promise<void> {
    if (source === undefined) await this.s.put(`fx:${meta.id}`, meta);
    else await this.s.put<unknown>({ [`fx:${meta.id}`]: meta, [`fxs:${meta.id}`]: source });
  }

  async remove(ids: string[]): Promise<void> {
    const keys = ids.flatMap((id) => [`fx:${id}`, `fxs:${id}`]);
    for (let i = 0; i < keys.length; i += 128) await this.s.delete(keys.slice(i, i + 128));
  }

  getFlag<T>(key: string): Promise<T | undefined> {
    return this.s.get<T>(`fxk:${key}`);
  }

  async setFlag<T>(key: string, value: T): Promise<void> {
    await this.s.put(`fxk:${key}`, value);
  }
}
