/**
 * OAuth 2.1 client handling for the relay's authorization server (MCP
 * authorization spec 2025-06-18 / 2025-11-25 / 2026-07-28):
 *
 * - Client ID Metadata Documents: a `client_id` that is an https URL is fetched
 *   (small, cached per isolate) and must name itself and list the redirect URI.
 * - Dynamic Client Registration (RFC 7591), stateless: the client id is
 *   `dcr.<b64url(JSON{r: redirect_uris, n: name, a: auth method})>.<HMAC>`, signed
 *   with the Directory's key; a confidential client's secret is an HMAC of its
 *   id. Nothing is stored per client, so registration spam costs no storage.
 *
 * Every grant is public-client style: PKCE S256 is mandatory.
 *
 * Scopes: `splanc` (drive the lights) and `offline_access` (advertised so hosts
 * such as ChatGPT know to keep the refresh token; every grant gets one anyway).
 * Any other requested scope (e.g. `openid`) is dropped from the grant, not
 * refused: the granted `scope` says what was given.
 */

import { b64url, fromB64url } from "./crypto";
import type { Env } from "./platform";

export interface OAuthClient {
  id: string;
  name: string;
  redirects: string[];
  /** Token endpoint auth method: "none" (public, PKCE only) or a client secret one. */
  auth: "none" | "client_secret_post" | "client_secret_basic";
  /** Where the client's metadata came from (shown on the consent page). */
  source: "metadata document" | "dynamic registration";
}

export const SCOPES_SUPPORTED = ["splanc", "offline_access"];

/** The scope granted for a requested one: the supported part, always with `splanc`. */
export function grantedScope(requested: string | null | undefined): string {
  const want = new Set((requested ?? "").split(/\s+/).filter(Boolean));
  return SCOPES_SUPPORTED.filter((s) => s === "splanc" || want.has(s)).join(" ");
}

const dec = new TextDecoder();
const enc = new TextEncoder();

const directory = (env: Env) => env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));

async function dirCall<T>(env: Env, path: string, body: unknown): Promise<{ status: number; body: T }> {
  const r = await directory(env).fetch(`https://directory${path}`, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as T };
}

export const dir = dirCall;

/** A redirect URI a client may register: https, or http on a loopback host (RFC 8252). */
export function validRedirect(u: string): boolean {
  if (u.length > 512) return false;
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && isLoopback(url.hostname);
  } catch {
    // Private-use schemes (RFC 8252 §7.1), e.g. com.example.app:/cb — allowed for native clients.
    return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+:\/[^\s]*$/i.test(u);
  }
}

const isLoopback = (h: string) => h === "127.0.0.1" || h === "localhost" || h === "[::1]";

/** Exact match, except a loopback redirect may use any port (RFC 8252 §7.3). */
export function redirectAllowed(client: OAuthClient, uri: string): boolean {
  if (client.redirects.includes(uri)) return true;
  try {
    const u = new URL(uri);
    if (u.protocol !== "http:" || !isLoopback(u.hostname)) return false;
    return client.redirects.some((r) => {
      try {
        const x = new URL(r);
        return x.protocol === "http:" && x.hostname === u.hostname && x.pathname === u.pathname && x.search === u.search;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export interface DcrRequest {
  redirect_uris?: unknown;
  client_name?: unknown;
  token_endpoint_auth_method?: unknown;
}

/** RFC 7591 registration: validate, sign, return the registration response. */
export async function register(env: Env, req: DcrRequest, nowS: number): Promise<{ status: number; body: unknown }> {
  const uris = req.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string" && validRedirect(u))) {
    return { status: 400, body: { error: "invalid_redirect_uri", error_description: "https or loopback redirect_uris (1-10)" } };
  }
  const m = req.token_endpoint_auth_method ?? "none";
  if (m !== "none" && m !== "client_secret_post" && m !== "client_secret_basic") {
    return { status: 400, body: { error: "invalid_client_metadata", error_description: `unsupported auth method ${String(m)}` } };
  }
  const name = typeof req.client_name === "string" ? req.client_name.slice(0, 100) : "MCP client";
  const payload = b64url(enc.encode(JSON.stringify({ r: uris, n: name, a: m })));
  const { body: s } = await dirCall<{ sig: string }>(env, "/hmac/sign", { msg: `client:${payload}` });
  const clientId = `dcr.${payload}.${s.sig}`;
  const out: Record<string, unknown> = {
    client_id: clientId,
    client_id_issued_at: nowS,
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: m,
  };
  if (m !== "none") {
    out["client_secret"] = (await dirCall<{ sig: string }>(env, "/hmac/sign", { msg: `secret:${clientId}` })).body.sig;
    out["client_secret_expires_at"] = 0;
  }
  return { status: 201, body: out };
}

export async function checkClientSecret(env: Env, client: OAuthClient, secret: string | undefined): Promise<boolean> {
  if (client.auth === "none") return true;
  if (!secret) return false;
  const r = await dirCall<{ ok: boolean }>(env, "/hmac/verify", { msg: `secret:${client.id}`, sig: secret });
  return r.body.ok === true;
}

const cimdCache = new Map<string, { at: number; client: OAuthClient | null }>();

/** Resolve a client_id to its metadata (null = unknown/invalid). */
export async function resolveClient(env: Env, id: string | null | undefined, nowMs: number): Promise<OAuthClient | null> {
  if (!id || id.length > 4096) return null;
  if (id.startsWith("dcr.")) {
    const [, payload, sig] = id.split(".");
    if (!payload || !sig) return null;
    const v = await dirCall<{ ok: boolean }>(env, "/hmac/verify", { msg: `client:${payload}`, sig });
    if (!v.body.ok) return null;
    try {
      const p = JSON.parse(dec.decode(fromB64url(payload))) as { r: string[]; n: string; a: OAuthClient["auth"] };
      return { id, name: p.n, redirects: p.r, auth: p.a, source: "dynamic registration" };
    } catch {
      return null;
    }
  }
  if (id.startsWith("https://")) {
    const hit = cimdCache.get(id);
    if (hit && nowMs - hit.at < 5 * 60_000) return hit.client;
    const client = await fetchMetadataDocument(id);
    if (cimdCache.size > 500) cimdCache.clear();
    cimdCache.set(id, { at: nowMs, client });
    return client;
  }
  return null;
}

async function fetchMetadataDocument(id: string): Promise<OAuthClient | null> {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash) return null;
  try {
    const r = await fetch(url.href, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(5000) });
    if (r.status !== 200) return null;
    const text = await r.text();
    if (text.length > 16 * 1024) return null;
    const doc = JSON.parse(text) as Record<string, unknown>;
    const uris = doc["redirect_uris"];
    if (doc["client_id"] !== id || !Array.isArray(uris) || !uris.every((u) => typeof u === "string" && validRedirect(u))) return null;
    // Public clients only (PKCE): the document must allow `none`. ChatGPT's lists
    // ["none", "private_key_jwt"] with private_key_jwt as its singular preference;
    // our metadata advertises only `none` for such clients, so it uses that.
    const listed = doc["token_endpoint_auth_methods_supported"];
    const methods = Array.isArray(listed) ? listed : [doc["token_endpoint_auth_method"] ?? "none"];
    if (!methods.includes("none")) return null;
    return {
      id,
      name: typeof doc["client_name"] === "string" ? doc["client_name"].slice(0, 100) : url.host,
      redirects: uris as string[],
      auth: "none",
      source: "metadata document",
    };
  } catch {
    return null;
  }
}
