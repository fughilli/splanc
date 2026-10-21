/**
 * The Splanc cloud relay: a Cloudflare Worker + two Durable Object classes
 * (docs/design/cloud-relay.md).
 *
 *   /mcp                         the remote MCP endpoint (Streamable HTTP), per
 *                                bridge: the bearer token names the bridge
 *   /.well-known/oauth-*         RFC 9728 + RFC 8414 metadata
 *   /register /authorize /token /revoke   the OAuth 2.1 authorization server
 *                                (the "login" is the pairing code on the bridge)
 *   /pair                        pairing code -> personal bearer token, by hand
 *   /bridge/register             a bridge registers its Ed25519 key -> bridge id
 *   /bridge/connect?id=          the bridge's outbound WebSocket (signed)
 *
 * The Worker itself is a thin router (the free plan gives it 10 ms CPU per
 * request); signatures, tokens and the tunnel live in the Durable Objects.
 */

import { BridgeObject, parseToken, rpcError, wwwAuthenticate } from "./bridgeObject";
import { BRIDGE_ID_RE, ed25519Verify, normalizePairingCode, randomBridgeId } from "./crypto";
import { Directory } from "./directory";
import { SCOPES_SUPPORTED, checkClientSecret, dir, redirectAllowed, register, resolveClient, type OAuthClient } from "./oauth";
import { consent, landing, oauthErrorPage, pairForm, tokenPage } from "./pages";
import { now, type Env } from "./platform";
import { SIGNATURE_WINDOW_S, registerMessage } from "./protocol";

export { BridgeObject, Directory };

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id",
  "access-control-expose-headers": "mcp-session-id, mcp-protocol-version, www-authenticate",
  "access-control-max-age": "86400",
};

const json = (obj: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS, ...extra },
  });

export function originOf(req: Request, env: Env): string {
  return (env.PUBLIC_URL ?? new URL(req.url).origin).replace(/\/+$/, "");
}

const clientIp = (req: Request) => req.headers.get("cf-connecting-ip") ?? "unknown";

const bridgeStub = (env: Env, bid: string) => env.BRIDGE.get(env.BRIDGE.idFromName(bid));

function toBridge(env: Env, bid: string, origin: string, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-bridge-id", bid);
  headers.set("x-relay-origin", origin);
  return bridgeStub(env, bid).fetch(`https://bridge${path}`, { ...init, headers });
}

async function formOrJson(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, String(v)]));
  }
  const text = await req.text();
  return Object.fromEntries(new URLSearchParams(text));
}

/** Browser Origin check for /mcp (spec: 403 on an invalid Origin). Bearer tokens are
 * not ambient credentials, so any https origin (and local dev) may call. */
function originOk(req: Request): boolean {
  const o = req.headers.get("origin");
  if (!o) return true;
  try {
    const u = new URL(o);
    return u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const origin = originOf(req, env);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      switch (path) {
        case "/":
          return landing(origin);
        case "/healthz":
          return json({ ok: true });
        case "/mcp":
          return mcp(req, env, origin);
        case "/.well-known/oauth-protected-resource":
        case "/.well-known/oauth-protected-resource/mcp":
          return json(
            {
              resource: `${origin}/mcp`,
              authorization_servers: [origin],
              bearer_methods_supported: ["header"],
              scopes_supported: SCOPES_SUPPORTED,
              resource_name: "Splanc lights",
              resource_documentation: "https://github.com/fughilli/splanc/blob/main/docs/guides/cloud-agent.md",
            },
            200,
            { "cache-control": "public, max-age=3600" },
          );
        case "/.well-known/oauth-authorization-server":
        case "/.well-known/openid-configuration":
          return json(
            {
              issuer: origin,
              authorization_endpoint: `${origin}/authorize`,
              token_endpoint: `${origin}/token`,
              registration_endpoint: `${origin}/register`,
              revocation_endpoint: `${origin}/revoke`,
              response_types_supported: ["code"],
              response_modes_supported: ["query"],
              grant_types_supported: ["authorization_code", "refresh_token"],
              code_challenge_methods_supported: ["S256"],
              token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
              revocation_endpoint_auth_methods_supported: ["none"],
              scopes_supported: SCOPES_SUPPORTED,
              client_id_metadata_document_supported: true,
              authorization_response_iss_parameter_supported: true,
            },
            200,
            { "cache-control": "public, max-age=3600" },
          );
        case "/register":
          return dcr(req, env);
        case "/authorize":
          return req.method === "POST" ? authorizePost(req, env, origin) : authorizeGet(req, env);
        case "/token":
          return token(req, env, origin);
        case "/revoke":
          return revoke(req, env, origin);
        case "/pair":
          return pair(req, env, origin);
        case "/bridge/register":
          return registerBridge(req, env, origin);
        case "/bridge/connect": {
          const bid = url.searchParams.get("id") ?? "";
          if (!BRIDGE_ID_RE.test(bid)) return json({ error: "bad bridge id" }, 400);
          return toBridge(env, bid, origin, "/connect", { method: "GET", headers: req.headers });
        }
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: "relay error", detail: (e as Error).message }, 500);
    }
  },
};

// -- MCP -----------------------------------------------------------------------------------

async function mcp(req: Request, env: Env, origin: string): Promise<Response> {
  if (!originOk(req)) return rpcError(403, "origin not allowed");
  const h = req.headers.get("authorization") ?? "";
  const tok = parseToken(h.startsWith("Bearer ") ? h.slice(7) : null);
  if (!tok || (tok.kind !== "at" && tok.kind !== "pt")) {
    // Answered here, without waking a Durable Object.
    return json({ error: h ? "invalid_token" : "unauthorized" }, 401, {
      "www-authenticate": wwwAuthenticate(origin, h ? "invalid_token" : undefined),
    });
  }
  const r = await toBridge(env, tok.bridge, origin, "/mcp", {
    method: req.method,
    headers: req.headers,
    ...(req.method === "POST" ? { body: req.body } : {}),
    // Request bodies are streamed; the DO reads them in full (capped).
    ...({ duplex: "half" } as object),
  });
  const headers = new Headers(r.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(r.body, { status: r.status, headers });
}

// -- OAuth ---------------------------------------------------------------------------------

async function dcr(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const lim = await dir(env, "/limit", { name: "dcrIp", key: clientIp(req) });
  if (lim.status === 429) return json({ error: "slow_down", error_description: "too many registrations" }, 429);
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return json({ error: "invalid_client_metadata" }, 400);
  const r = await register(env, body as Record<string, unknown>, Math.floor(now(env) / 1000));
  return json(r.body, r.status);
}

interface AuthzParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string;
  scope: string;
  resource: string;
}

const AUTHZ_KEYS: (keyof AuthzParams)[] = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
];

function authzParams(src: { get(k: string): string | null }): AuthzParams {
  const p = {} as AuthzParams;
  for (const k of AUTHZ_KEYS) p[k] = src.get(k) ?? "";
  return p;
}

/** Validate the request; {client} when it may proceed, else the response to send. */
async function checkAuthz(
  req: Request,
  env: Env,
  p: AuthzParams,
): Promise<{ client: OAuthClient; redirectError?: undefined } | { response: Response }> {
  const client = await resolveClient(env, p.client_id, now(env));
  // Until the redirect URI is known-good, errors are shown here, never redirected.
  if (!client) return { response: oauthErrorPage("Unknown client: the app connecting didn't register (client_id).") };
  if (!p.redirect_uri || !redirectAllowed(client, p.redirect_uri)) {
    return { response: oauthErrorPage("This redirect address isn't registered for the client.") };
  }
  // RFC 9207: `iss` on every authorization response, errors included (ChatGPT
  // keys its stable redirect URI + CIMD client id on this).
  const fail = (error: string, description: string) => ({
    response: redirectTo(p.redirect_uri, { error, error_description: description, state: p.state }, env, originOf(req, env)),
  });
  if (p.response_type !== "code") return fail("unsupported_response_type", "only response_type=code");
  if (p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge)) {
    return fail("invalid_request", "PKCE with S256 is required");
  }
  return { client };
}

function redirectTo(uri: string, params: Record<string, string>, env: Env, origin?: string): Response {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  if (origin) u.searchParams.set("iss", origin);
  void env;
  return new Response(null, { status: 302, headers: { location: u.href, "cache-control": "no-store" } });
}

async function authorizeGet(req: Request, env: Env): Promise<Response> {
  const p = authzParams(new URL(req.url).searchParams);
  const c = await checkAuthz(req, env, p);
  if ("response" in c) return c.response;
  return consent({
    clientName: c.client.name,
    clientId: c.client.id,
    source: c.client.source,
    redirectUri: p.redirect_uri,
    hidden: { ...p },
  });
}

async function authorizePost(req: Request, env: Env, origin: string): Promise<Response> {
  const form = await formOrJson(req);
  const p = authzParams({ get: (k) => form[k] ?? null });
  const c = await checkAuthz(req, env, p);
  if ("response" in c) return c.response;
  const again = (error: string, status: number) =>
    consent(
      { clientName: c.client.name, clientId: c.client.id, source: c.client.source, redirectUri: p.redirect_uri, hidden: { ...p }, error },
      status,
    );
  const code = normalizePairingCode(form["pairing_code"] ?? "");
  if (!code) return again("A pairing code is 8 letters and digits, like ABCD-EFGH.", 400);
  const r = await dir<{ bridge?: string; error?: string }>(env, "/code/redeem", { code, ip: clientIp(req) });
  if (r.status === 429) return again("Too many wrong codes. Wait a few minutes, then try again.", 429);
  if (!r.body.bridge) return again("That code isn't valid or has expired. Get a new one on the bridge.", 400);
  const issued = await toBridge(env, r.body.bridge, origin, "/oauth/code", {
    method: "POST",
    body: JSON.stringify({
      client_id: c.client.id,
      redirect_uri: p.redirect_uri,
      code_challenge: p.code_challenge,
      resource: p.resource,
      scope: p.scope,
    }),
  });
  const { code: authCode } = (await issued.json()) as { code: string };
  return redirectTo(p.redirect_uri, { code: authCode, state: p.state }, env, origin);
}

function basicAuth(req: Request): { id?: string; secret?: string } {
  const h = req.headers.get("authorization") ?? "";
  if (!h.startsWith("Basic ")) return {};
  try {
    const [id, secret] = atob(h.slice(6)).split(":");
    return { id: decodeURIComponent(id ?? ""), secret: decodeURIComponent(secret ?? "") };
  } catch {
    return {};
  }
}

async function token(req: Request, env: Env, origin: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = await formOrJson(req);
  const basic = basicAuth(req);
  const clientId = b["client_id"] ?? basic.id;
  const client = await resolveClient(env, clientId, now(env));
  if (!client) return json({ error: "invalid_client", error_description: "unknown client_id" }, 401);
  if (!(await checkClientSecret(env, client, b["client_secret"] ?? basic.secret))) {
    return json({ error: "invalid_client", error_description: "bad client secret" }, 401);
  }
  const t = parseToken(b["grant_type"] === "refresh_token" ? b["refresh_token"] : b["code"]);
  if (!t) return json({ error: "invalid_grant", error_description: "malformed code or token" }, 400);
  const r = await toBridge(env, t.bridge, origin, "/oauth/token", {
    method: "POST",
    body: JSON.stringify({ ...b, client_id: client.id }),
  });
  return json(await r.json(), r.status);
}

async function revoke(req: Request, env: Env, origin: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = await formOrJson(req);
  const t = parseToken(b["token"]);
  if (t) await toBridge(env, t.bridge, origin, "/oauth/revoke", { method: "POST", body: JSON.stringify({ token: b["token"] }) });
  return json({}, 200); // RFC 7009: 200 whether or not it existed
}

// -- manual pairing ------------------------------------------------------------------------

async function pair(req: Request, env: Env, origin: string): Promise<Response> {
  if (req.method !== "POST") return pairForm(origin, new URL(req.url).searchParams.get("code") ?? "");
  const form = await formOrJson(req);
  // A script (Accept: application/json) gets JSON back, errors included.
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  const fail = (code: string, error: string, message: string, status: number) =>
    wantsJson ? json({ error, error_description: message }, status) : pairForm(origin, code, message, status);
  const code = normalizePairingCode(form["pairing_code"] ?? "");
  if (!code) return fail(form["pairing_code"] ?? "", "invalid_request", "A pairing code is 8 letters and digits, like ABCD-EFGH.", 400);
  const r = await dir<{ bridge?: string }>(env, "/code/redeem", { code, ip: clientIp(req) });
  if (r.status === 429) return fail("", "slow_down", "Too many wrong codes. Wait a few minutes, then try again.", 429);
  if (!r.body.bridge) return fail("", "invalid_grant", "That code isn't valid or has expired. Get a new one on the bridge.", 400);
  const t = await toBridge(env, r.body.bridge, origin, "/pair/token", {
    method: "POST",
    body: JSON.stringify({ label: form["label"] ?? "" }),
  });
  const { token: tok } = (await t.json()) as { token: string };
  if (wantsJson) return json({ token: tok, mcp_url: `${origin}/mcp` });
  return tokenPage(origin, tok);
}

// -- bridges -------------------------------------------------------------------------------

async function registerBridge(req: Request, env: Env, origin: string): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const b = (await req.json().catch(() => ({}))) as { public_key?: string; ts?: number; sig?: string };
  const t = Number(b.ts);
  if (!b.public_key || !b.sig || !Number.isFinite(t)) return json({ error: "public_key, ts, sig required" }, 400);
  if (Math.abs(Math.floor(now(env) / 1000) - t) > SIGNATURE_WINDOW_S) {
    return json({ error: "stale timestamp (check the bridge's clock)" }, 401);
  }
  if (!(await ed25519Verify(b.public_key, registerMessage(b.public_key, t), b.sig))) {
    return json({ error: "bad signature" }, 401);
  }
  const lim = await dir(env, "/limit", { name: "registerIp", key: clientIp(req), global: "registerGlobal" });
  if (lim.status === 429) return json({ error: "too many registrations; try later" }, 429, { "retry-after": "3600" });
  for (let i = 0; i < 3; i++) {
    const bid = randomBridgeId();
    const r = await toBridge(env, bid, origin, "/init", { method: "POST", body: JSON.stringify({ pub: b.public_key }) });
    if (r.ok) return json({ bridge_id: bid, relay: origin, mcp_url: `${origin}/mcp` });
  }
  return json({ error: "could not allocate a bridge id" }, 503);
}
