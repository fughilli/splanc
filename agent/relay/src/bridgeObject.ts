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
 * - the live pairing code mirror (`pairing`; the code itself lives in the
 *   Directory, which maps code -> bridge);
 * - the tunnel: each MCP HTTP request becomes a `req` frame; `res`/`chunk`/`end`
 *   frames become the HTTP response. Requests in flight keep the object awake;
 *   nothing about them is stored.
 *
 * Only the Worker calls fetch() here; every call carries `x-bridge-id` (this
 * object's name) and `x-relay-origin` (the public origin).
 */

import { b64url, ed25519Verify, randomSecret, sha256b64url, sha256hex } from "./crypto";
import { now, upgrade, autoResponse, type DOState, type Env, type HSocket } from "./platform";
import {
  BRIDGE_AUTH_HEADER,
  CLOSE_PROTOCOL,
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
}

interface CodeRec {
  client: string;
  redirect: string;
  challenge: string;
  resource: string;
  scope: string;
  exp: number;
}

interface Pending {
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
  stream?: ReadableStreamDefaultController<Uint8Array>;
  /** JSON-RPC request ids in the tunnelled body (answered if the stream breaks). */
  ids: (string | number)[];
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

/** End a streamed (SSE) reply the bridge can no longer finish: answer each request
 * in it with a JSON-RPC error, so the client fails the call now with the reason
 * instead of waiting out its own timeout on a stream that ended with no response. */
function breakStream(p: Pending, why: string): void {
  const c = p.stream!;
  try {
    for (const id of p.ids) {
      const msg = { jsonrpc: "2.0", id, error: { code: -32000, message: `Splanc relay: ${why}; retry the request` } };
      c.enqueue(enc.encode(`event: message\ndata: ${JSON.stringify(msg)}\n\n`));
    }
    if (p.ids.length) c.close();
    else c.error(new Error(why));
  } catch {
    // cancelled already
  }
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

export function wwwAuthenticate(origin: string, error?: string): string {
  return (
    `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` +
    (error ? `, error="${error}"` : "")
  );
}

export class BridgeObject {
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  /** token hash -> record (null = known bad), for this wake period. */
  private readonly tokCache = new Map<string, TokRec | null>();

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
      case "/oauth/code":
        return this.issueCode(await body(), bid);
      case "/oauth/token":
        return this.token(await body(), bid, origin);
      case "/oauth/revoke":
        await this.revokeToken((await body())["token"] ?? "");
        return json({ ok: true });
      case "/pair/token":
        return this.personalToken((await body())["label"] ?? "", bid, origin);
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
    const hello: RelayFrame = {
      t: "hello",
      v: WIRE_VERSION,
      bridge_id: bid,
      relay: origin,
      mcp_url: `${origin}/mcp`,
      credentials: await this.credentialCount(),
      pairing: await this.pairing(),
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

  private async pushState(reason: string): Promise<void> {
    this.send({ t: "state", credentials: await this.credentialCount(), pairing: await this.pairing(), reason });
  }

  async webSocketMessage(ws: HSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    if (message === PING) {
      // Normally auto-answered; a host without auto-response lands here.
      ws.send(PONG);
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
      default:
        return;
    }
  }

  async webSocketClose(ws: HSocket, code: number, reason: string): Promise<void> {
    // A replaced (older) socket closing must not fail the new one's requests.
    const cur = this.bridge();
    if (!cur || cur === ws) this.failAll(502, "the bridge disconnected");
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
      else p.resolve(rpcError(status, `Splanc relay: ${why}; retry the request`));
    }
  }

  // -- the MCP tunnel ------------------------------------------------------------------

  private async authorize(req: Request, bid: string, origin: string): Promise<Response | null> {
    const h = req.headers.get("authorization") ?? "";
    const tok = parseToken(h.startsWith("Bearer ") ? h.slice(7) : null);
    const deny = () =>
      json({ error: "invalid_token" }, 401, { "www-authenticate": wwwAuthenticate(origin, "invalid_token") });
    if (!tok || tok.bridge !== bid || (tok.kind !== "at" && tok.kind !== "pt")) return deny();
    const rec = await this.lookup(tok.secret);
    if (!rec || rec.k !== tok.kind || (rec.exp !== null && rec.exp <= this.nowS())) return deny();
    if (rec.resource && rec.resource !== `${origin}/mcp`) return deny();
    return null;
  }

  private async lookup(secret: string): Promise<TokRec | null> {
    const h = await sha256hex(secret);
    if (this.tokCache.has(h)) return this.tokCache.get(h)!;
    const rec = (await this.state.storage.get<TokRec>(`tok:${h}`)) ?? null;
    this.tokCache.set(h, rec);
    return rec;
  }

  private async mcp(req: Request, bid: string, origin: string): Promise<Response> {
    const denied = await this.authorize(req, bid, origin);
    if (denied) return denied;
    // No standalone GET stream: it would keep this object awake (billed) for as long
    // as a client holds it. The spec lets a server decline it with 405.
    if (req.method !== "POST" && req.method !== "DELETE") {
      return json({ error: "method not allowed" }, 405, { allow: "POST, DELETE" });
    }
    const ws = this.bridge();
    if (!ws) {
      return rpcError(
        503,
        "The Splanc bridge for this connector is offline. Check that the bridge (e.g. the Raspberry Pi " +
          "running `splanc-agent bridge`) is powered and online; its screen or status file shows why.",
        { "retry-after": "30" },
      );
    }
    if (this.pending.size >= MAX_INFLIGHT) return rpcError(429, "too many requests in flight", { "retry-after": "5" });
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_BODY) return rpcError(413, "request body too large");
    const body = req.method === "POST" ? await req.text() : "";
    if (body.length > MAX_BODY) return rpcError(413, "request body too large");
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
        else resolve(rpcError(504, "the bridge did not answer in time"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer, ids: req.method === "POST" ? requestIds(body) : [] });
      try {
        ws.send(JSON.stringify({ t: "req", id, method: req.method, headers, body } satisfies RelayFrame));
      } catch {
        this.finish(id);
        resolve(rpcError(503, "the bridge connection dropped; retry"));
      }
    });
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
    await this.pushState("new pairing code");
  }

  private async clearPairing(reason: string): Promise<void> {
    if (await this.state.storage.get("pairing")) {
      await this.state.storage.delete("pairing");
      await this.pushState(reason);
    }
  }

  // -- credentials -----------------------------------------------------------------------

  /** Live grants (OAuth families with a refresh token + personal tokens); purges the expired. */
  private async credentialCount(): Promise<number> {
    const t = this.nowS();
    const fams = new Set<string>();
    const dead: string[] = [];
    for (const [k, v] of await this.state.storage.list<TokRec>({ prefix: "tok:" })) {
      if (v.exp !== null && v.exp <= t) dead.push(k);
      else if (v.k !== "at") fams.add(v.fam);
    }
    for (const [k, v] of await this.state.storage.list<{ exp: number }>({ prefix: "used:" })) if (v.exp <= t) dead.push(k);
    for (const [k, v] of await this.state.storage.list<CodeRec>({ prefix: "ac:" })) if (v.exp <= t) dead.push(k);
    for (let i = 0; i < dead.length; i += 128) await this.state.storage.delete(dead.slice(i, i + 128));
    return fams.size;
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
      scope: b["scope"] ?? "",
      exp: this.nowS() + AUTH_CODE_TTL_S,
    });
    await this.clearPairing("pairing code redeemed");
    return json({ code: `spl_ac_${bid}_${secret}` });
  }

  private async grant(bid: string, fam: string, client: string, resource: string, scope: string): Promise<Response> {
    const t = this.nowS();
    const access = await this.mint("at", bid, { exp: t + ACCESS_TTL_S, fam, client, resource });
    const refresh = await this.mint("rt", bid, { exp: t + REFRESH_TTL_S, fam, client, resource });
    return json({
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scope || "splanc",
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
      const r = await this.grant(bid, b64url(crypto.getRandomValues(new Uint8Array(12))), rec.client, resource, rec.scope);
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
      await this.state.storage.delete(`tok:${h}`);
      this.tokCache.delete(h);
      await this.state.storage.put(`used:${h}`, { fam: rec.fam, exp: rec.exp ?? this.nowS() + REFRESH_TTL_S });
      return this.grant(bid, rec.fam, rec.client, resource, b["scope"] ?? "");
    }
    return oauthError("unsupported_grant_type", "authorization_code or refresh_token");
  }

  private async personalToken(label: string, bid: string, origin: string): Promise<Response> {
    const fam = b64url(crypto.getRandomValues(new Uint8Array(12)));
    const token = await this.mint("pt", bid, {
      exp: null,
      fam,
      client: "personal",
      resource: `${origin}/mcp`,
      label: label.slice(0, 80),
    });
    await this.clearPairing("pairing code redeemed");
    await this.pushState("personal token issued");
    return json({ token });
  }

  private async revokeFamily(fam: string): Promise<number> {
    const dead: string[] = [];
    for (const [k, v] of await this.state.storage.list<TokRec>({ prefix: "tok:" })) if (v.fam === fam) dead.push(k);
    for (let i = 0; i < dead.length; i += 128) await this.state.storage.delete(dead.slice(i, i + 128));
    this.tokCache.clear();
    return dead.length;
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
    for (const prefix of ["tok:", "used:", "ac:"]) {
      for (const k of (await this.state.storage.list({ prefix })).keys()) keys.push(k);
    }
    for (let i = 0; i < keys.length; i += 128) await this.state.storage.delete(keys.slice(i, i + 128));
    this.tokCache.clear();
    await this.pushState("all credentials revoked");
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
