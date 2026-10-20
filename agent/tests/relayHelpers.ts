/**
 * Test helpers for the cloud relay: a temp-dir bridge identity, waiting on a
 * condition, PKCE, and the OAuth dance a cloud agent's connector does
 * (dynamic registration -> consent page -> pairing code -> token).
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BridgeIdentity } from "../src/bridge/identity";

export function tempIdentity(): { identity: BridgeIdentity; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "splanc-bridge-"));
  return { identity: new BridgeIdentity(dir), dir };
}

export async function until<T>(f: () => T | Promise<T>, what: string, ms = 10_000): Promise<NonNullable<T>> {
  const t0 = Date.now();
  for (;;) {
    const v = await f();
    if (v) return v as NonNullable<T>;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export const REDIRECT = "https://agent.example/oauth/callback";

export async function registerClient(relay: string, extra: Record<string, unknown> = {}): Promise<Record<string, string>> {
  const r = await fetch(`${relay}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test Agent", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...extra }),
  });
  if (r.status !== 201) throw new Error(`register: ${r.status} ${await r.text()}`);
  return (await r.json()) as Record<string, string>;
}

export interface AuthorizeResult {
  status: number;
  location: string | null;
  body: string;
}

export async function authorize(
  relay: string,
  clientId: string,
  challenge: string,
  pairingCode: string,
  opts: { ip?: string; state?: string } = {},
): Promise<AuthorizeResult> {
  const form = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: opts.state ?? "st8",
    scope: "splanc",
    resource: `${relay}/mcp`,
    pairing_code: pairingCode,
  });
  const r = await fetch(`${relay}/authorize`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}) },
    body: form,
    redirect: "manual",
  });
  return { status: r.status, location: r.headers.get("location"), body: await r.text() };
}

export async function tokenRequest(relay: string, fields: Record<string, string>): Promise<{ status: number; json: Record<string, string> }> {
  const r = await fetch(`${relay}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { status: r.status, json: (await r.json()) as Record<string, string> };
}

/** The whole connector flow: register, consent with the pairing code, exchange. */
export async function connectorFlow(relay: string, pairingCode: string): Promise<{ client: Record<string, string>; tokens: Record<string, string> }> {
  const client = await registerClient(relay);
  const { verifier, challenge } = pkce();
  const a = await authorize(relay, client["client_id"]!, challenge, pairingCode);
  if (a.status !== 302 || !a.location) throw new Error(`authorize: ${a.status} ${a.body.slice(0, 300)}`);
  const code = new URL(a.location).searchParams.get("code")!;
  const t = await tokenRequest(relay, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client["client_id"]!,
    code_verifier: verifier,
    resource: `${relay}/mcp`,
  });
  if (t.status !== 200) throw new Error(`token: ${t.status} ${JSON.stringify(t.json)}`);
  return { client, tokens: t.json };
}

export async function mcpPost(relay: string, token: string | null, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${relay}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
