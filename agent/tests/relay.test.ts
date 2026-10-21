/**
 * The cloud relay Worker (agent/relay/src) under the Node host (src/relayHost.ts):
 * OAuth/RFC 9728/8414 metadata, bridge registration + signed connect, pairing
 * codes (format, single use, expiry, per-IP + global rate limits), the OAuth
 * connector flow (DCR, consent, PKCE, refresh rotation + reuse detection),
 * personal tokens, revocation (one token, revoke-all) and the MCP tunnel
 * (auth, offline bridge, 405 GET, no token passthrough).
 */

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import WebSocket from "ws";

import { parseToken, sameResource } from "../relay/src/bridgeObject";
import { normalizePairingCode, randomPairingCode } from "../relay/src/crypto";
import { LIMITS } from "../relay/src/directory";
import { grantedScope, redirectAllowed, validRedirect } from "../relay/src/oauth";
import { connectMessage, registerMessage, type RelayFrame, type StateFrame } from "../relay/src/protocol";
import { RelayLink, backoffDelay } from "../src/bridge/relayLink";
import { RelayHost } from "../src/relayHost";
import {
  REDIRECT,
  authorize,
  connectorFlow,
  mcpPost,
  pkce,
  registerClient,
  tempIdentity,
  tokenRequest,
  until,
} from "./relayHelpers";

let offsetMs = 0;
const host = new RelayHost({ trustProxy: true, now: () => Date.now() + offsetMs });
let relay = "";

/** Every test bridge registers from 127.0.0.1: forget those registrations
 * (LIMITS.registerIp) so the suite doesn't trip its own limit. */
function resetRegistrationLimit(): void {
  const dir = host.storageOf("directory", "global");
  for (const k of [...(dir?.keys() ?? [])]) if (k.startsWith("rl:register")) dir!.delete(k);
}

/** A bridge on the real RelayLink that echoes every tunnelled request. */
async function echoBridge(): Promise<{ link: RelayLink; frames: RelayFrame[] }> {
  resetRegistrationLimit();
  const { identity } = tempIdentity();
  const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
  const frames: RelayFrame[] = [];
  link.onFrame = (f) => {
    frames.push(f);
    if (f.t === "req") {
      link.send({
        t: "res",
        id: f.id,
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "s1", "x-not-forwarded": "1" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { echo: JSON.parse(f.body || "null"), headers: f.headers } }),
        end: true,
      });
    }
  };
  link.start();
  await until(() => link.online, "bridge online");
  return { link, frames };
}

async function codeFor(link: RelayLink, frames: RelayFrame[]): Promise<string> {
  const n = frames.length;
  assert.ok(link.send({ t: "new_code" }));
  const f = await until(() => frames.slice(n).find((x): x is StateFrame => x.t === "state" && x.pairing !== null), "pairing code");
  return f.pairing!.code;
}

before(async () => {
  relay = await host.listen();
});
after(async () => {
  await host.close();
});

describe("pure helpers", () => {
  test("pairing codes: 8 symbols from the unambiguous alphabet, normalized input", () => {
    for (let i = 0; i < 200; i++) assert.match(randomPairingCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(normalizePairingCode(" abcd efgh "), "ABCD-EFGH");
    assert.equal(normalizePairingCode("ABCD-EFG"), null);
    assert.equal(normalizePairingCode("ABCD-EFG0"), null); // 0 is not in the alphabet
  });

  test("tokens parse only in their exact shape", () => {
    const t = parseToken(`spl_at_${"a".repeat(20)}_${"B".repeat(43)}`);
    assert.deepEqual(t, { kind: "at", bridge: "a".repeat(20), secret: "B".repeat(43) });
    assert.equal(parseToken(`spl_xx_${"a".repeat(20)}_${"B".repeat(43)}`), null);
    assert.equal(parseToken("Bearer nonsense"), null);
  });

  test("redirect URIs: https or loopback; loopback port may vary", () => {
    assert.ok(validRedirect("https://claude.ai/api/mcp/auth_callback"));
    assert.ok(validRedirect("http://127.0.0.1:3000/cb"));
    assert.ok(!validRedirect("http://evil.example/cb"));
    assert.ok(!validRedirect("https://x.example/cb#frag"));
    const c = { id: "x", name: "x", redirects: ["http://127.0.0.1:3000/cb", "https://a.example/cb"], auth: "none" as const, source: "dynamic registration" as const };
    assert.ok(redirectAllowed(c, "http://127.0.0.1:49152/cb"));
    assert.ok(redirectAllowed(c, "https://a.example/cb"));
    assert.ok(!redirectAllowed(c, "https://a.example/cb2"));
    assert.ok(!redirectAllowed(c, "http://127.0.0.1:3000/other"));
  });

  test("scopes: the supported part is granted, always with splanc; others dropped, not refused", () => {
    assert.equal(grantedScope(""), "splanc");
    assert.equal(grantedScope(undefined), "splanc");
    assert.equal(grantedScope("openid profile email offline_access"), "splanc offline_access");
    assert.equal(grantedScope("offline_access  splanc"), "splanc offline_access");
  });

  test("resource indicator: the MCP endpoint or the origin", () => {
    assert.ok(sameResource("https://R.example/mcp", "https://r.example"));
    assert.ok(sameResource("https://r.example", "https://r.example"));
    assert.ok(!sameResource("https://other.example/mcp", "https://r.example"));
  });

  test("backoff: doubles, caps, jitters within ±20 %", () => {
    const b = { baseMs: 1000, maxMs: 60_000 };
    assert.equal(backoffDelay(0, b, () => 0.5), 1000);
    assert.equal(backoffDelay(3, b, () => 0.5), 8000);
    assert.equal(backoffDelay(30, b, () => 0.5), 60_000);
    assert.equal(backoffDelay(0, b, () => 0), 800);
    assert.equal(backoffDelay(0, b, () => 1), 1200);
  });
});

describe("metadata + unauthenticated", () => {
  test("protected resource + authorization server metadata", async () => {
    const prm = (await (await fetch(`${relay}/.well-known/oauth-protected-resource/mcp`)).json()) as Record<string, unknown>;
    assert.equal(prm["resource"], `${relay}/mcp`);
    assert.deepEqual(prm["authorization_servers"], [relay]);
    const as = (await (await fetch(`${relay}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as["issuer"], relay);
    assert.deepEqual(as["code_challenge_methods_supported"], ["S256"]);
    assert.equal(as["client_id_metadata_document_supported"], true);
    assert.equal(as["registration_endpoint"], `${relay}/register`);
    // ChatGPT: offline_access advertised (keeps refresh tokens), the issuer
    // identification it keys its stable redirect URI + CIMD client id on, and
    // `none` (public client) among the token endpoint auth methods.
    assert.deepEqual(prm["scopes_supported"], ["splanc", "offline_access"]);
    assert.deepEqual(as["scopes_supported"], ["splanc", "offline_access"]);
    assert.equal(as["authorization_response_iss_parameter_supported"], true);
    assert.ok((as["token_endpoint_auth_methods_supported"] as string[]).includes("none"));
    assert.ok((as["grant_types_supported"] as string[]).includes("refresh_token"));
    const oidc = (await (await fetch(`${relay}/.well-known/openid-configuration`)).json()) as Record<string, unknown>;
    assert.equal(oidc["issuer"], relay);
  });

  test("/mcp without a token: 401 pointing at the resource metadata (no DO touched)", async () => {
    const r = await mcpPost(relay, null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const bad = await mcpPost(relay, `spl_at_${"a".repeat(20)}_${"B".repeat(43)}`, {});
    assert.equal(bad.status, 401);
    assert.match(bad.headers.get("www-authenticate") ?? "", /invalid_token/);
    assert.match(r.headers.get("www-authenticate") ?? "", /scope="splanc offline_access"/);
  });

  test("a hostile browser Origin is refused", async () => {
    const r = await mcpPost(relay, null, {}, { origin: "null" });
    assert.equal(r.status, 403);
  });
});

describe("bridge registration + connect", () => {
  test("registrations are rate limited per IP", async () => {
    resetRegistrationLimit();
    const [max] = LIMITS.registerIp;
    const statuses: number[] = [];
    for (let i = 0; i <= max; i++) {
      const { identity } = tempIdentity();
      const ts = Math.floor(Date.now() / 1000);
      const r = await fetch(`${relay}/bridge/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "10.7.7.7" },
        body: JSON.stringify({ public_key: identity.publicKey, ts, sig: identity.sign(registerMessage(identity.publicKey, ts)) }),
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses.slice(0, max), Array(max).fill(200));
    assert.equal(statuses[max], 429);
    // A registration whose signature doesn't match the key is refused outright.
    const { identity } = tempIdentity();
    const ts = Math.floor(Date.now() / 1000);
    const bad = await fetch(`${relay}/bridge/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "10.7.7.8" },
      body: JSON.stringify({ public_key: identity.publicKey, ts, sig: identity.sign("something else") }),
    });
    assert.equal(bad.status, 401);
  });

  test("register, connect, hello names the bridge and the MCP URL", async () => {
    const { link, frames } = await echoBridge();
    try {
      const hello = frames.find((f) => f.t === "hello");
      assert.ok(hello && hello.t === "hello");
      assert.equal(hello.bridge_id, link.bridgeId);
      assert.equal(hello.mcp_url, `${relay}/mcp`);
      assert.equal(hello.credentials, 0);
    } finally {
      link.stop();
    }
  });

  test("a bad signature is refused before the socket opens; an unknown bridge gets 404", async () => {
    const { link } = await echoBridge();
    link.stop();
    const status = (url: string, auth: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, { headers: { "x-splanc-bridge-auth": auth } });
        ws.on("unexpected-response", (_q, res) => {
          resolve(res.statusCode ?? 0);
          ws.terminate();
        });
        ws.on("open", () => {
          resolve(101);
          ws.close();
        });
        ws.on("error", () => undefined);
      });
    const ws = relay.replace("http", "ws");
    const ts = Math.floor(Date.now() / 1000);
    const { identity: other } = tempIdentity();
    assert.equal(await status(`${ws}/bridge/connect?id=${link.bridgeId}`, `${ts}.${other.sign(connectMessage(link.bridgeId!, ts))}`), 401);
    assert.equal(await status(`${ws}/bridge/connect?id=${link.bridgeId}`, `${ts - 3600}.x`), 401);
    assert.equal(await status(`${ws}/bridge/connect?id=${"q".repeat(20)}`, `${ts}.x`), 404);
  });

  test("a bridge the relay forgot registers again by itself", async () => {
    resetRegistrationLimit();
    const { identity } = tempIdentity();
    identity.setBridgeId(relay, "z".repeat(20));
    const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
    link.start();
    try {
      await until(() => link.online, "online after re-registering");
      assert.notEqual(link.bridgeId, "z".repeat(20));
    } finally {
      link.stop();
    }
  });
});

describe("pairing codes", () => {
  test("a new code replaces the old; codes are single use", async () => {
    const { link, frames } = await echoBridge();
    try {
      const first = await codeFor(link, frames);
      const second = await codeFor(link, frames);
      assert.notEqual(first, second);
      const { challenge } = pkce();
      const client = await registerClient(relay);
      const stale = await authorize(relay, client["client_id"]!, challenge, first, { ip: "10.0.0.1" });
      assert.equal(stale.status, 400);
      assert.match(stale.body, /isn&#39;t valid or has expired|isn't valid/);
      const ok = await authorize(relay, client["client_id"]!, challenge, second.toLowerCase().replace("-", " "), { ip: "10.0.0.1" });
      assert.equal(ok.status, 302);
      const again = await authorize(relay, client["client_id"]!, challenge, second, { ip: "10.0.0.1" });
      assert.equal(again.status, 400);
      // Redeeming cleared the bridge's pairing state.
      await until(() => link.pairing === null, "pairing cleared");
    } finally {
      link.stop();
    }
  });

  test("codes expire after 10 minutes", async () => {
    const { link, frames } = await echoBridge();
    try {
      const code = await codeFor(link, frames);
      offsetMs = 11 * 60_000;
      const { challenge } = pkce();
      const client = await registerClient(relay);
      const r = await authorize(relay, client["client_id"]!, challenge, code, { ip: "10.0.0.2" });
      assert.equal(r.status, 400);
    } finally {
      offsetMs = 0;
      link.stop();
    }
  });

  test("wrong codes are rate limited per IP (even the right code is refused once limited)", async () => {
    const { link, frames } = await echoBridge();
    try {
      const code = await codeFor(link, frames);
      const { challenge } = pkce();
      const client = await registerClient(relay);
      const [max] = LIMITS.redeemIp;
      for (let i = 0; i < max; i++) {
        const r = await authorize(relay, client["client_id"]!, challenge, "ZZZZ-ZZZZ", { ip: "10.9.9.9" });
        assert.equal(r.status, 400);
      }
      const limited = await authorize(relay, client["client_id"]!, challenge, code, { ip: "10.9.9.9" });
      assert.equal(limited.status, 429);
      // Another address isn't affected.
      const fine = await authorize(relay, client["client_id"]!, challenge, code, { ip: "10.9.9.10" });
      assert.equal(fine.status, 302);
      // The window rolls over.
      offsetMs = LIMITS.redeemIp[1] * 1000;
      const later = await authorize(relay, client["client_id"]!, challenge, "ZZZZ-ZZZZ", { ip: "10.9.9.9" });
      assert.equal(later.status, 400);
    } finally {
      offsetMs = 0;
      link.stop();
    }
  });

  test("the global failure ceiling stops a distributed guesser", async () => {
    const dir = host.storageOf("directory", "global")!;
    // Pretend the window is nearly spent (cheaper than LIMITS.redeemGlobal requests).
    const win = Math.floor(Date.now() / 1000 / LIMITS.redeemGlobal[1]);
    dir.set(`rl:redeemGlobal:${win}:*`, LIMITS.redeemGlobal[0]);
    try {
      const { challenge } = pkce();
      const client = await registerClient(relay);
      const r = await authorize(relay, client["client_id"]!, challenge, "ZZZZ-ZZZZ", { ip: "10.1.2.3" });
      assert.equal(r.status, 429);
    } finally {
      dir.delete(`rl:redeemGlobal:${win}:*`);
    }
  });
});

describe("OAuth connector flow", () => {
  test("consent page shows the client; PKCE is enforced; codes are single use", async () => {
    const { link, frames } = await echoBridge();
    try {
      const client = await registerClient(relay);
      const { verifier, challenge } = pkce();
      const q = new URLSearchParams({
        response_type: "code",
        client_id: client["client_id"]!,
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "abc",
      });
      const page = await fetch(`${relay}/authorize?${q}`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /Test Agent/);
      assert.match(html, /agent\.example/);
      assert.equal(page.headers.get("content-security-policy")?.includes("frame-ancestors 'none'"), true);
      // An unregistered redirect is an error page, never a redirect.
      const evil = await fetch(`${relay}/authorize?${q.toString().replace(encodeURIComponent(REDIRECT), encodeURIComponent("https://evil.example/cb"))}`, { redirect: "manual" });
      assert.equal(evil.status, 400);
      // No PKCE: redirected back with an error.
      const noPkce = await fetch(`${relay}/authorize?${q.toString().replace(/code_challenge_method=S256/, "code_challenge_method=plain")}`, { redirect: "manual" });
      assert.equal(noPkce.status, 302);
      assert.match(noPkce.headers.get("location")!, /error=invalid_request/);

      const code = await codeFor(link, frames);
      const a = await authorize(relay, client["client_id"]!, challenge, code, { state: "abc" });
      const loc = new URL(a.location!);
      assert.equal(loc.searchParams.get("state"), "abc");
      assert.equal(loc.searchParams.get("iss"), relay);
      const authCode = loc.searchParams.get("code")!;
      const base = { grant_type: "authorization_code", code: authCode, redirect_uri: REDIRECT, client_id: client["client_id"]! };
      const wrong = await tokenRequest(relay, { ...base, code_verifier: pkce().verifier });
      assert.equal(wrong.status, 400);
      assert.equal(wrong.json["error"], "invalid_grant");
      // The failed attempt burned the code (single use, whatever happens).
      const late = await tokenRequest(relay, { ...base, code_verifier: verifier });
      assert.equal(late.status, 400);
    } finally {
      link.stop();
    }
  });

  test("tokens reach the bridge; refresh rotates; a replayed refresh token revokes the grant", async () => {
    const { link, frames } = await echoBridge();
    try {
      const { client, tokens } = await connectorFlow(relay, await codeFor(link, frames));
      assert.equal(tokens["token_type"], "Bearer");
      assert.ok(Number(tokens["expires_in"]) > 0);
      await until(() => link.credentials === 1, "credential count 1");

      const r = await mcpPost(relay, tokens["access_token"]!, { jsonrpc: "2.0", id: 1, method: "ping" }, { "mcp-session-id": "s1", "mcp-protocol-version": "2025-11-25" });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("mcp-session-id"), "s1");
      assert.equal(r.headers.get("x-not-forwarded"), null);
      const echo = ((await r.json()) as { result: { echo: unknown; headers: Record<string, string> } }).result;
      assert.deepEqual(echo.echo, { jsonrpc: "2.0", id: 1, method: "ping" });
      // The relay's credential never reaches the bridge (no token passthrough).
      assert.equal(echo.headers["authorization"], undefined);
      assert.equal(echo.headers["mcp-session-id"], "s1");
      assert.equal(echo.headers["mcp-protocol-version"], "2025-11-25");

      // GET (standalone SSE stream) is declined: it would keep the object awake.
      const get = await fetch(`${relay}/mcp`, { headers: { authorization: `Bearer ${tokens["access_token"]}`, accept: "text/event-stream" } });
      assert.equal(get.status, 405);

      const refreshed = await tokenRequest(relay, { grant_type: "refresh_token", refresh_token: tokens["refresh_token"]!, client_id: client["client_id"]! });
      assert.equal(refreshed.status, 200);
      assert.notEqual(refreshed.json["refresh_token"], tokens["refresh_token"]);
      assert.equal((await mcpPost(relay, refreshed.json["access_token"]!, { jsonrpc: "2.0", id: 2, method: "ping" })).status, 200);
      // Replay of the rotated-out refresh token: the whole grant dies.
      const replay = await tokenRequest(relay, { grant_type: "refresh_token", refresh_token: tokens["refresh_token"]!, client_id: client["client_id"]! });
      assert.equal(replay.status, 400);
      assert.equal((await mcpPost(relay, refreshed.json["access_token"]!, { jsonrpc: "2.0", id: 3, method: "ping" })).status, 401);
      await until(() => link.credentials === 0, "grant revoked");
    } finally {
      link.stop();
    }
  });

  test("a confidential DCR client must present its secret", async () => {
    const { link, frames } = await echoBridge();
    try {
      const client = await registerClient(relay, { token_endpoint_auth_method: "client_secret_post" });
      assert.ok(client["client_secret"]);
      const { verifier, challenge } = pkce();
      const a = await authorize(relay, client["client_id"]!, challenge, await codeFor(link, frames));
      const code = new URL(a.location!).searchParams.get("code")!;
      const base = { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: client["client_id"]!, code_verifier: verifier };
      assert.equal((await tokenRequest(relay, base)).status, 401);
      assert.equal((await tokenRequest(relay, { ...base, client_secret: client["client_secret"]! })).status, 200);
    } finally {
      link.stop();
    }
  });

  test("a tampered DCR client id is unknown", async () => {
    const client = await registerClient(relay);
    const id = client["client_id"]!;
    const tampered = id.slice(0, -2) + (id.endsWith("A") ? "BB" : "AA");
    const { challenge } = pkce();
    const q = new URLSearchParams({ response_type: "code", client_id: tampered, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
    assert.equal((await fetch(`${relay}/authorize?${q}`)).status, 400);
  });

  test("Client ID Metadata Documents: fetched, must name themselves", async () => {
    const real = globalThis.fetch;
    const docs: Record<string, unknown> = {
      "https://cimd.example/client.json": { client_id: "https://cimd.example/client.json", client_name: "CIMD Agent", redirect_uris: [REDIRECT] },
      "https://liar.example/client.json": { client_id: "https://other.example/client.json", redirect_uris: [REDIRECT] },
    };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u in docs) return new Response(JSON.stringify(docs[u]), { status: 200, headers: { "content-type": "application/json" } });
      return real(input, init);
    }) as typeof fetch;
    try {
      const { challenge } = pkce();
      const q = (id: string) =>
        new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256" });
      const ok = await real(`${relay}/authorize?${q("https://cimd.example/client.json")}`);
      // The host's Worker code runs in this process, so the patched fetch serves the doc.
      assert.equal(ok.status, 200);
      assert.match(await ok.text(), /CIMD Agent/);
      assert.equal((await real(`${relay}/authorize?${q("https://liar.example/client.json")}`)).status, 400);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("ChatGPT", () => {
  // ChatGPT's own Client ID Metadata Document, as served at
  // https://chatgpt.com/oauth/client.json (2026-10): private_key_jwt preferred,
  // `none` also listed — our metadata offers only `none`, so it uses that.
  const CHATGPT_ID = "https://chatgpt.com/oauth/client.json";
  const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
  const chatgptDoc = {
    client_id: CHATGPT_ID,
    client_uri: "https://chatgpt.com/",
    redirect_uris: [CHATGPT_REDIRECT],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_name: "ChatGPT",
    token_endpoint_auth_signing_alg: "RS256",
    jwks_uri: "https://chatgpt.com/oauth/jwks.json",
  };
  const docs: Record<string, unknown> = {
    [CHATGPT_ID]: chatgptDoc,
    "https://jwt-only.example/client.json": {
      ...chatgptDoc,
      client_id: "https://jwt-only.example/client.json",
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
    },
  };
  const real = globalThis.fetch;
  before(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (u in docs) return new Response(JSON.stringify(docs[u]), { status: 200, headers: { "content-type": "application/json" } });
      return real(input, init);
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = real;
  });

  test("CIMD client (public, PKCE) with ChatGPT's redirect + scopes: tokens, refresh keeps offline_access", async () => {
    const { link, frames } = await echoBridge();
    try {
      const { verifier, challenge } = pkce();
      const a = await authorize(relay, CHATGPT_ID, challenge, await codeFor(link, frames), {
        redirect: CHATGPT_REDIRECT,
        scope: "openid email profile splanc offline_access",
        state: "cg",
      });
      assert.equal(a.status, 302, a.body.slice(0, 300));
      const loc = new URL(a.location!);
      assert.equal(`${loc.origin}${loc.pathname}`, CHATGPT_REDIRECT);
      assert.equal(loc.searchParams.get("iss"), relay);
      assert.equal(loc.searchParams.get("state"), "cg");
      // No client authentication (`none`): the code_verifier is the proof.
      const t = await tokenRequest(relay, {
        grant_type: "authorization_code",
        code: loc.searchParams.get("code")!,
        redirect_uri: CHATGPT_REDIRECT,
        client_id: CHATGPT_ID,
        code_verifier: verifier,
        resource: `${relay}/mcp`,
      });
      assert.equal(t.status, 200, JSON.stringify(t.json));
      assert.equal(t.json["scope"], "splanc offline_access");
      assert.match(t.json["refresh_token"] ?? "", /^spl_rt_/);
      assert.equal((await mcpPost(relay, t.json["access_token"]!, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 200);
      const r = await tokenRequest(relay, {
        grant_type: "refresh_token",
        refresh_token: t.json["refresh_token"]!,
        client_id: CHATGPT_ID,
        resource: `${relay}/mcp`,
      });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json["scope"], "splanc offline_access");
      assert.notEqual(r.json["refresh_token"], t.json["refresh_token"]);
    } finally {
      link.stop();
    }
  });

  test("a redirect the document doesn't list, or a document without `none`, is refused", async () => {
    const { challenge } = pkce();
    const q = (id: string, redirect: string) =>
      new URLSearchParams({ response_type: "code", client_id: id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256" });
    assert.equal((await real(`${relay}/authorize?${q(CHATGPT_ID, CHATGPT_REDIRECT)}`)).status, 200);
    assert.equal((await real(`${relay}/authorize?${q(CHATGPT_ID, "https://chatgpt.com/connector/oauth/abc")}`)).status, 400);
    assert.equal(
      (await real(`${relay}/authorize?${q("https://jwt-only.example/client.json", CHATGPT_REDIRECT)}`)).status,
      400,
    );
  });

  test("error redirects carry iss too (RFC 9207)", async () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: CHATGPT_ID,
      redirect_uri: CHATGPT_REDIRECT,
      code_challenge_method: "plain",
      code_challenge: "x",
      state: "s",
    });
    const r = await real(`${relay}/authorize?${q}`, { redirect: "manual" });
    assert.equal(r.status, 302);
    const loc = new URL(r.headers.get("location")!);
    assert.equal(loc.searchParams.get("error"), "invalid_request");
    assert.equal(loc.searchParams.get("iss"), relay);
  });

  test("DCR as ChatGPT sends it (redirect, grant types, scope) registers a public client", async () => {
    const c = await registerClient(relay, {
      client_name: "ChatGPT",
      redirect_uris: [CHATGPT_REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "splanc offline_access",
    });
    assert.match(c["client_id"]!, /^dcr\./);
    assert.deepEqual(c["redirect_uris"], [CHATGPT_REDIRECT] as unknown as string);
  });
});

describe("tunnel + revocation", () => {
  test("offline bridge: 503 with a hint; personal token via /pair works; revoke_all kills everything", async () => {
    const { link, frames } = await echoBridge();
    try {
      const r = await fetch(`${relay}/pair`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ pairing_code: await codeFor(link, frames), label: "laptop" }),
      });
      assert.equal(r.status, 200);
      const { token, mcp_url } = (await r.json()) as { token: string; mcp_url: string };
      assert.match(token, /^spl_pt_/);
      assert.equal(mcp_url, `${relay}/mcp`);
      assert.equal((await mcpPost(relay, token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 200);
      const { tokens } = await connectorFlow(relay, await codeFor(link, frames));
      await until(() => link.credentials === 2, "two credentials");

      link.stop();
      await until(async () => (await mcpPost(relay, token, { jsonrpc: "2.0", id: 2, method: "ping" })).status === 503, "503 while offline");
      const off = await mcpPost(relay, token, { jsonrpc: "2.0", id: 2, method: "ping" });
      assert.match(((await off.json()) as { error: { message: string } }).error.message, /bridge for this connector is offline/);

      link.start();
      await until(() => link.online, "back online");
      const n = frames.length;
      link.send({ t: "revoke_all" });
      await until(() => frames.slice(n).some((f) => f.t === "state" && f.credentials === 0), "revoked");
      assert.equal((await mcpPost(relay, token, { jsonrpc: "2.0", id: 3, method: "ping" })).status, 401);
      assert.equal((await mcpPost(relay, tokens["access_token"]!, { jsonrpc: "2.0", id: 3, method: "ping" })).status, 401);
    } finally {
      link.stop();
    }
  });

  test("RFC 7009 revocation of one token revokes its grant only", async () => {
    const { link, frames } = await echoBridge();
    try {
      const a = await connectorFlow(relay, await codeFor(link, frames));
      const b = await connectorFlow(relay, await codeFor(link, frames));
      const rv = await fetch(`${relay}/revoke`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: a.tokens["refresh_token"]! }) });
      assert.equal(rv.status, 200);
      assert.equal((await mcpPost(relay, a.tokens["access_token"]!, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
      assert.equal((await mcpPost(relay, b.tokens["access_token"]!, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 200);
    } finally {
      link.stop();
    }
  });

  test("a request in flight when the bridge drops fails fast (502), not after the timeout", async () => {
    resetRegistrationLimit();
    const { identity } = tempIdentity();
    const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
    const frames: RelayFrame[] = [];
    link.onFrame = (f) => frames.push(f); // never answers
    link.start();
    try {
      await until(() => link.online, "online");
      const { tokens } = await connectorFlow(relay, await codeFor(link, frames));
      const pending = mcpPost(relay, tokens["access_token"]!, { jsonrpc: "2.0", id: 1, method: "ping" });
      await until(() => frames.some((f) => f.t === "req"), "request reached the bridge");
      link.stop();
      assert.equal((await pending).status, 502);
    } finally {
      link.stop();
    }
  });

  test("a streamed (SSE) reply is forwarded chunk by chunk", async () => {
    resetRegistrationLimit();
    const { identity } = tempIdentity();
    const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
    const frames: RelayFrame[] = [];
    link.onFrame = (f) => {
      frames.push(f);
      if (f.t !== "req") return;
      link.send({ t: "res", id: f.id, status: 200, headers: { "content-type": "text/event-stream" } });
      link.send({ t: "chunk", id: f.id, data: 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' });
      setTimeout(() => {
        link.send({ t: "chunk", id: f.id, data: 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n' });
        link.send({ t: "end", id: f.id });
      }, 150);
    };
    link.start();
    try {
      await until(() => link.online, "online");
      const { tokens } = await connectorFlow(relay, await codeFor(link, frames));
      const r = await mcpPost(relay, tokens["access_token"]!, { jsonrpc: "2.0", id: 1, method: "tools/call" });
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "text/event-stream");
      assert.equal(r.headers.get("x-accel-buffering"), "no");
      const reader = r.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      // The progress notification arrives before the response exists.
      assert.match(first, /notifications\/progress/);
      assert.doesNotMatch(first, /"result"/);
      let rest = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest += new TextDecoder().decode(value);
      }
      assert.match(rest, /"result"/);
    } finally {
      link.stop();
    }
  });

  test("a streamed reply cut off by the bridge dropping ends with a tool error result for the call", async () => {
    resetRegistrationLimit();
    const { identity } = tempIdentity();
    const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
    const frames: RelayFrame[] = [];
    link.onFrame = (f) => {
      frames.push(f);
      if (f.t !== "req") return;
      // A slow tool: headers + a progress notification, then the bridge dies.
      link.send({ t: "res", id: f.id, status: 200, headers: { "content-type": "text/event-stream" } });
      link.send({ t: "chunk", id: f.id, data: 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n' });
      setTimeout(() => link.stop(), 100);
    };
    link.start();
    try {
      await until(() => link.online, "online");
      const { tokens } = await connectorFlow(relay, await codeFor(link, frames));
      const r = await mcpPost(relay, tokens["access_token"]!, { jsonrpc: "2.0", id: 42, method: "tools/call", params: { name: "deploy_effect" } });
      assert.equal(r.status, 200);
      const text = await r.text(); // ends (doesn't hang) once the bridge is gone
      const last = text.trim().split("\n\n").at(-1)!;
      const msg = JSON.parse(last.split("\n").find((l) => l.startsWith("data: "))!.slice(6)) as {
        id: number;
        result: { isError: boolean; content: { text: string }[] };
      };
      assert.equal(msg.id, 42);
      // A tool result naming the cause (a JSON-RPC error reads as a generic failure in MCP clients).
      assert.equal(msg.result.isError, true);
      assert.match(msg.result.content[0]!.text, /^deploy_effect failed: Splanc relay: the bridge disconnected/);
    } finally {
      link.stop();
    }
  });

  test("/pair answers a script (Accept: application/json) in JSON, errors too", async () => {
    const post = (code: string) =>
      fetch(`${relay}/pair`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "cf-connecting-ip": "198.51.100.77" },
        body: new URLSearchParams({ pairing_code: code }),
      });
    const bad = await post("ZZZZ-ZZZZ");
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get("content-type") ?? "", /application\/json/);
    assert.equal(((await bad.json()) as { error: string }).error, "invalid_grant");
    const malformed = await post("12");
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: string }).error, "invalid_request");
    // The page itself names the full connector URL.
    assert.ok((await (await fetch(`${relay}/pair`)).text()).includes(`<code>${relay}/mcp</code>`));
  });

  test("tokens are stored only as hashes", async () => {
    const { link, frames } = await echoBridge();
    try {
      const { tokens } = await connectorFlow(relay, await codeFor(link, frames));
      const store = host.storageOf("bridge", link.bridgeId!)!;
      const dump = JSON.stringify([...store]);
      const secret = parseToken(tokens["access_token"])!.secret;
      assert.ok(!dump.includes(secret));
      assert.ok([...store.keys()].some((k) => /^tok:[0-9a-f]{64}$/.test(k)));
    } finally {
      link.stop();
    }
  });
});
