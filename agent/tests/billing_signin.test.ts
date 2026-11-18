/**
 * Sign in with Apple / Google for Splanc AI credit accounts
 * (agent/relay/src/billing/signin.ts), offline: fake Apple and Google with
 * TEST keys generated per run (RSA for their ID tokens, a P-256 .p8 for our
 * Apple client secret), so nothing reaches a real provider.
 *
 * - token verification: signature, issuer, audience (per client), expiry,
 *   algorithm, key rotation (an unknown kid refetches the JWKS), the JWKS
 *   being down;
 * - nonces: ours (MAC + expiry), hashed into the token, single use;
 * - Apple's client secret is a valid ES256 JWT; the code exchange's user
 *   must match; the refresh token is stored encrypted only;
 * - the account model: link keeps the balance, recovery on a new device,
 *   a new device with a new identity, CONFLICTS are never merged (switch
 *   needs the ticket), one identity per provider, unlink (with the
 *   last-way-back guard and Apple revocation), deletion revokes Apple and
 *   frees the identity, Apple's server notifications;
 * - no secret (the .p8, the token key, Apple's refresh token) and no email
 *   in any response, log line or stored record.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BillingAccount, DoLedger, mintSession } from "../relay/src/billing/account";
import { billingEndpoint, type BillingContext } from "../relay/src/billing/endpoint";
import { JwksCache, JwtError, parseJwt, verifyJwt, type Jwk } from "../relay/src/billing/jwt";
import { DEFAULT_PRICING, MICRO } from "../relay/src/billing/pricing";
import {
  APPLE_ISSUER,
  APPLE_JWKS,
  APPLE_REVOKE_URL,
  APPLE_TOKEN_URL,
  GOOGLE_JWKS,
  GOOGLE_TOKEN_URL,
  appleClientSecret,
  checkNonce,
  googleIosRedirect,
  mintNonce,
  openToken,
  signinConfig,
} from "../relay/src/billing/signin";
import { b64url, sha256hex } from "../relay/src/crypto";
import { Directory } from "../relay/src/directory";
import type { Env } from "../relay/src/platform";
import { namespace, type MemStorage } from "./billingFakes";

const SECRET = "dGVzdC1zZXNzaW9uLXNlY3JldC0zMi1ieXRlcy1sb25nISE";
const TOKEN_KEY = b64url(new Uint8Array(32).fill(7));
const NOW_S = 1_800_000_000;
const BUNDLE = "dev.splanc.app";
const SERVICES = "dev.splanc.signin";
const APPLE_REDIRECT = "https://splanc.io/app/";
const G_WEB = "111-web.apps.googleusercontent.com";
const G_IOS = "222-ios.apps.googleusercontent.com";
const enc = new TextEncoder();

// -- test keys + a fake provider -------------------------------------------------------

async function rsaKey(kid: string) {
  const k = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", k.publicKey)) as Jwk;
  return { kid, priv: k.privateKey, jwk: { kty: "RSA", n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" } as Jwk };
}

const json64 = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

async function signRs256(key: { kid: string; priv: CryptoKey }, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const input = `${json64({ alg: "RS256", kid: key.kid, ...header })}.${json64(claims)}`;
  return `${input}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.priv, enc.encode(input)))}`;
}

async function p8(): Promise<{ pem: string; pub: CryptoKey }> {
  const k = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey));
  const b64 = btoa(String.fromCharCode(...der));
  return { pem: `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`, pub: k.publicKey };
}

interface Call {
  url: string;
  form: URLSearchParams;
}

class FakeProviders {
  appleKeys: Awaited<ReturnType<typeof rsaKey>>[] = [];
  googleKeys: Awaited<ReturnType<typeof rsaKey>>[] = [];
  calls: Call[] = [];
  jwksFetches = 0;
  jwksDown = false;
  revokeFails = 0;
  /** The `sub` the next Apple code exchange returns (default: the code's). */
  exchangeSub: string | null = null;
  private n = 0;

  static async make() {
    const f = new FakeProviders();
    f.appleKeys = [await rsaKey("apple-1")];
    f.googleKeys = [await rsaKey("google-1")];
    return f;
  }

  fetch = (async (url: string, init?: RequestInit) => {
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    this.calls.push({ url, form });
    if (url === APPLE_JWKS || url === GOOGLE_JWKS) {
      this.jwksFetches++;
      if (this.jwksDown) return new Response("down", { status: 503 });
      return Response.json({ keys: (url === APPLE_JWKS ? this.appleKeys : this.googleKeys).map((k) => k.jwk) });
    }
    if (url === APPLE_TOKEN_URL) {
      // code "c:<sub>" -> that user's tokens; anything else is a bad grant.
      const code = form.get("code") ?? "";
      if (!code.startsWith("c:")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const sub = this.exchangeSub ?? code.slice(2);
      const id = await signRs256(this.appleKeys[0]!, { iss: APPLE_ISSUER, aud: form.get("client_id"), sub, iat: NOW_S, exp: NOW_S + 600 });
      return Response.json({ access_token: "at", refresh_token: `rt-SECRET-${sub}-${++this.n}`, id_token: id, token_type: "Bearer" });
    }
    if (url === APPLE_REVOKE_URL) {
      if (this.revokeFails > 0) {
        this.revokeFails--;
        return new Response("", { status: 503 });
      }
      return new Response("", { status: 200 });
    }
    if (url === GOOGLE_TOKEN_URL) {
      const code = form.get("code") ?? "";
      if (!code.startsWith("g:") || !form.get("code_verifier")) return Response.json({ error: "invalid_grant" }, { status: 400 });
      const [, sub, nonce] = code.split(":");
      const id = await signRs256(this.googleKeys[0]!, { iss: "https://accounts.google.com", aud: form.get("client_id"), sub, nonce, iat: NOW_S, exp: NOW_S + 600, email: "person@example.com" });
      return Response.json({ id_token: id });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as (url: string, init?: RequestInit) => Promise<Response>;

  appleIdToken(sub: string, nonceHash: string, o: { aud?: string; exp?: number; iss?: string; key?: number } = {}) {
    return signRs256(this.appleKeys[o.key ?? 0]!, {
      iss: o.iss ?? APPLE_ISSUER,
      aud: o.aud ?? BUNDLE,
      sub,
      nonce: nonceHash,
      iat: NOW_S,
      exp: o.exp ?? NOW_S + 600,
      email: "relay@privaterelay.appleid.com",
      email_verified: true,
    });
  }

  googleIdToken(sub: string, nonceHash: string, o: { aud?: string; exp?: number } = {}) {
    return signRs256(this.googleKeys[0]!, {
      iss: "https://accounts.google.com",
      aud: o.aud ?? G_WEB,
      azp: o.aud ?? G_WEB,
      sub,
      nonce: nonceHash,
      iat: NOW_S,
      exp: o.exp ?? NOW_S + 600,
      email: "person@example.com",
      email_verified: true,
    });
  }

  revokes() {
    return this.calls.filter((c) => c.url === APPLE_REVOKE_URL);
  }
}

// -- a sandbox relay -------------------------------------------------------------------

async function world(patch: Partial<Env> = {}) {
  const fake = await FakeProviders.make();
  const key = await p8();
  const env = {} as Env;
  Object.assign(env, {
    AI_BILLING: "sandbox",
    AI_PRICING: JSON.stringify(DEFAULT_PRICING),
    ANTHROPIC_API_KEY: "sk-ant-api03-relaykeyrelaykeyrelaykey00",
    BILLING_TOKEN_SECRET: SECRET,
    APPLE_SIGNIN_TEAM_ID: "TEAM123456",
    APPLE_SIGNIN_KEY_ID: "KEY1234567",
    APPLE_SIGNIN_PRIVATE_KEY: key.pem,
    APPLE_SIGNIN_TOKEN_KEY: TOKEN_KEY,
    APPLE_SIGNIN_BUNDLE_ID: BUNDLE,
    APPLE_SIGNIN_SERVICES_ID: SERVICES,
    APPLE_SIGNIN_REDIRECT_URI: APPLE_REDIRECT,
    GOOGLE_SIGNIN_WEB_CLIENT_ID: G_WEB,
    GOOGLE_SIGNIN_IOS_CLIENT_ID: G_IOS,
    BILLING: namespace((s) => new BillingAccount(s, env)),
    DIRECTORY: namespace((s) => new Directory(s, env)),
    BRIDGE: namespace(() => ({ fetch: async () => new Response("no", { status: 404 }) })),
    HOST: { upgrade: () => { throw new Error("no"); }, autoResponse: () => undefined, now: () => NOW_S * 1000 },
    ...patch,
  });
  const logs: string[] = [];
  const texts: string[] = [];
  const ctx: BillingContext = {
    json: (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } }),
    clientIp: "198.51.100.7",
    upstream: async () => new Response("unused", { status: 500 }),
    log: (e) => logs.push(JSON.stringify(e)),
    signin: { fetch: fake.fetch, jwks: new JwksCache(fake.fetch, () => NOW_S * 1000) },
  };
  const call = async (path: string, init: RequestInit = {}) => {
    const r = await billingEndpoint(new Request(`https://relay${path}`, init), env, ctx, new URL(`https://relay${path}`).pathname);
    const text = await r.text();
    texts.push(text);
    return { status: r.status, text, body: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
  };
  const post = (path: string, body: unknown, auth?: Record<string, string>) =>
    call(path, { method: "POST", headers: { "content-type": "application/json", ...(auth ?? {}) }, body: JSON.stringify(body) });
  const nonce = async () => {
    const n = (await post("/billing/signin/nonce", {})).body as { nonce: string; provider_nonce: string };
    return n;
  };
  const anon = async (credits = 0) => {
    const made = await call("/billing/account", { method: "POST" });
    const id = String(made.body["account_id"]);
    if (credits) await new DoLedger(env.BILLING!, id).credit("adjust", `seed-${id}`, credits * MICRO);
    return { id, auth: { authorization: `Bearer ${String(made.body["token"])}` } };
  };
  /** Sign in with Apple from the iOS app (id_token + code). */
  const apple = async (sub: string, auth?: Record<string, string>, o: { client?: "ios" | "web"; code?: string } = {}) => {
    const n = await nonce();
    const client = o.client ?? "ios";
    return post(
      "/billing/signin",
      { provider: "apple", client, nonce: n.nonce, id_token: await fake.appleIdToken(sub, n.provider_nonce, { aud: client === "ios" ? BUNDLE : SERVICES }), code: o.code ?? `c:${sub}` },
      auth,
    );
  };
  const google = async (sub: string, auth?: Record<string, string>) => {
    const n = await nonce();
    return post("/billing/signin", { provider: "google", client: "web", nonce: n.nonce, id_token: await fake.googleIdToken(sub, n.provider_nonce) }, auth);
  };
  const balance = async (auth: Record<string, string>) => (await call("/billing/balance", { headers: auth })).body;
  const stored = () => {
    const out: string[] = [];
    for (const ns of [env.BILLING, env.DIRECTORY] as unknown as { objects: Map<string, { state: { storage: MemStorage } }> }[]) {
      for (const o of ns.objects.values()) out.push(JSON.stringify([...o.state.storage.map]));
    }
    return out.join("\n");
  };
  return { env, ctx, fake, key, logs, texts, call, post, nonce, anon, apple, google, balance, stored };
}

const bearer = (t: unknown) => ({ authorization: `Bearer ${String(t)}` });

// -- tokens ----------------------------------------------------------------------------

describe("token verification", () => {
  const opts = (o: Partial<Parameters<typeof verifyJwt>[1]> = {}) => ({ jwksUrl: APPLE_JWKS, issuers: [APPLE_ISSUER], audiences: [BUNDLE], nowS: NOW_S, ...o });

  test("a good token verifies; tampering, audience, issuer, expiry and alg fail", async () => {
    const f = await FakeProviders.make();
    const jwks = new JwksCache(f.fetch, () => NOW_S * 1000);
    const good = await f.appleIdToken("001.abc", "n");
    assert.equal((await verifyJwt(good, opts(), jwks))["sub"], "001.abc");

    const [h, , sig] = good.split(".");
    const forged = `${h}.${json64({ ...parseJwt(good).claims, sub: "001.attacker" })}.${sig}`;
    const reasons = async (t: string, o = opts()) => verifyJwt(t, o, jwks).then(() => "ok", (e: JwtError) => e.reason);
    assert.equal(await reasons(forged), "bad_signature");
    assert.equal(await reasons(good, opts({ audiences: [SERVICES] })), "bad_audience"); // an app token used on the web
    assert.equal(await reasons(await f.appleIdToken("x", "n", { iss: "https://evil.example" })), "bad_issuer");
    assert.equal(await reasons(await f.appleIdToken("x", "n", { exp: NOW_S - 120 })), "expired");
    assert.equal(await reasons(`${json64({ alg: "none" })}.${json64({ sub: "x" })}.`), "bad_alg");
    assert.equal(await reasons(await signRs256(f.appleKeys[0]!, { sub: "x" }, { alg: "HS256" })), "bad_alg");
    assert.equal(await reasons("not.a.jwt!"), "malformed");
    // A Google token is not an Apple token (different keys + issuer).
    assert.equal(await reasons(await f.googleIdToken("x", "n", { aud: BUNDLE })), "unknown_key");
  });

  test("key rotation: an unknown kid refetches the JWKS (rate-limited); JWKS down is reported", async () => {
    const f = await FakeProviders.make();
    let t = NOW_S * 1000;
    const jwks = new JwksCache(f.fetch, () => t);
    await verifyJwt(await f.appleIdToken("a", "n"), opts(), jwks);
    assert.equal(f.jwksFetches, 1);
    await verifyJwt(await f.appleIdToken("a", "n"), opts(), jwks);
    assert.equal(f.jwksFetches, 1, "cached");
    f.appleKeys.push(await rsaKey("apple-2"));
    const rotated = await f.appleIdToken("a", "n", { key: 1 });
    // Too soon after the last fetch: no refetch storm from junk kids.
    await assert.rejects(verifyJwt(rotated, opts(), jwks), (e: JwtError) => e.reason === "unknown_key");
    t += 61_000;
    assert.equal((await verifyJwt(rotated, opts(), jwks))["sub"], "a");
    assert.equal(f.jwksFetches, 2);
    f.jwksDown = true;
    await assert.rejects(verifyJwt(rotated, opts(), new JwksCache(f.fetch, () => t)), (e: JwtError) => e.reason === "jwks_unavailable");
  });

  test("Apple's client secret is an ES256 JWT our .p8 signed", async () => {
    const key = await p8();
    const cfg = signinConfig({ APPLE_SIGNIN_TEAM_ID: "TEAM123456", APPLE_SIGNIN_KEY_ID: "KEY1234567", APPLE_SIGNIN_PRIVATE_KEY: key.pem, APPLE_SIGNIN_TOKEN_KEY: TOKEN_KEY, APPLE_SIGNIN_BUNDLE_ID: BUNDLE } as Env);
    const jwt = await appleClientSecret(cfg.apple!, BUNDLE, NOW_S);
    const p = parseJwt(jwt);
    assert.deepEqual(p.header, { alg: "ES256", kid: "KEY1234567", typ: "JWT" });
    assert.deepEqual(p.claims, { iss: "TEAM123456", iat: NOW_S, exp: NOW_S + 300, aud: APPLE_ISSUER, sub: BUNDLE });
    assert.equal(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key.pub, p.signature as BufferSource, enc.encode(p.signingInput)), true);
  });

  test("nonces: ours, unexpired, and the token must carry their hash", async () => {
    const n = await mintNonce(SECRET, NOW_S);
    assert.equal(n.provider_nonce, await sha256hex(n.nonce));
    assert.equal((await checkNonce(SECRET, n.nonce, n.provider_nonce, NOW_S + 1)).ok, true);
    assert.equal((await checkNonce(SECRET, n.nonce, n.nonce, NOW_S + 1)).ok, false, "the raw nonce is not the claim");
    assert.equal((await checkNonce(SECRET, n.nonce, n.provider_nonce, NOW_S + 601)).ok, false, "expired");
    assert.equal((await checkNonce("b3RoZXItc2VjcmV0LW90aGVyLXNlY3JldC1vdGhlci0", n.nonce, n.provider_nonce, NOW_S)).ok, false, "not ours");
    const tampered = n.nonce.replace(/^sn1\.\d+/, `sn1.${NOW_S + 99999}`);
    assert.equal((await checkNonce(SECRET, tampered, await sha256hex(tampered), NOW_S)).ok, false);
  });
});

// -- the account model -----------------------------------------------------------------

describe("sign-in routes", () => {
  test("config: off without settings; public client ids only", async () => {
    const off = await world({
      APPLE_SIGNIN_TEAM_ID: undefined,
      GOOGLE_SIGNIN_WEB_CLIENT_ID: undefined,
      GOOGLE_SIGNIN_IOS_CLIENT_ID: undefined,
    } as unknown as Partial<Env>);
    assert.deepEqual((await off.call("/billing/signin/config")).body, { apple: null, google: null });
    assert.equal((await off.post("/billing/signin/nonce", {})).status, 503);
    const w = await world();
    const c = await w.call("/billing/signin/config");
    assert.deepEqual(c.body, {
      apple: { ios: true, web: { client_id: SERVICES, redirect_uri: APPLE_REDIRECT } },
      google: { web: { client_id: G_WEB }, ios: { client_id: G_IOS, redirect_uri: googleIosRedirect(G_IOS) } },
    });
    assert.equal(googleIosRedirect(G_IOS), "com.googleusercontent.apps.222-ios:/oauth2redirect");
    assert.ok(!c.text.includes("PRIVATE") && !c.text.includes(TOKEN_KEY) && !c.text.includes("KEY1234567"));
  });

  test("modes: a sandbox account is never signed into in production, and the sandbox link survives", async () => {
    const w = await world();
    const a = await w.anon(250);
    assert.equal((await w.apple("001.modes", a.auth)).body["result"], "linked");
    // The owner goes live (billing_go_live.mjs --apply): same relay, same Durable Objects.
    const live = {
      AI_BILLING: "production",
      STRIPE_SECRET_KEY: ["sk", "live", "51CANARYcanaryCANARYcanary0123456789"].join("_"),
      STRIPE_WEBHOOK_SECRET: "whsec_CANARYliveWEBHOOKsecret0123456789ab",
      BILLING_ADMIN_TOKEN: "admin-test-token-0001",
    };
    Object.assign(w.env, live);
    const prod = await w.apple("001.modes");
    assert.equal(prod.status, 201, prod.text);
    assert.equal(prod.body["result"], "created", "a fresh production account, not the sandbox one");
    assert.notEqual(prod.body["account_id"], a.id);
    assert.notEqual(prod.body["balance_credits"], 250, "test-money credits stay in the sandbox");
    assert.equal((await w.balance(a.auth))["error"], "unauthorized", "the sandbox session doesn't open here");
    // Rolled back: the Apple ID still signs in to its sandbox account.
    Object.assign(w.env, { AI_BILLING: "sandbox", STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined });
    const back = await w.apple("001.modes");
    assert.equal(back.body["result"], "signed_in", back.text);
    assert.equal(back.body["account_id"], a.id);
  });

  test("link: an anonymous account links Apple and keeps its credits; a new device recovers it", async () => {
    const w = await world();
    const a = await w.anon(250);
    const linked = await w.apple("001.alice", a.auth);
    assert.equal(linked.status, 200, linked.text);
    assert.equal(linked.body["result"], "linked");
    assert.equal(linked.body["account_id"], a.id);
    assert.equal(linked.body["token"], undefined, "the device keeps its session");
    assert.equal(linked.body["balance_credits"], 250);
    const b = await w.balance(a.auth);
    assert.deepEqual(b["identities"], [{ provider: "apple", linked_at: new Date(NOW_S * 1000).toISOString() }]);

    // Linking again is a no-op.
    assert.equal((await w.apple("001.alice", a.auth)).body["result"], "already_linked");

    // A new device (no session): the same Apple ID signs in to the same account.
    const again = await w.apple("001.alice");
    assert.equal(again.status, 200);
    assert.equal(again.body["result"], "signed_in");
    assert.equal(again.body["account_id"], a.id);
    assert.equal(again.body["balance_credits"], 250);
    assert.equal((await w.balance(bearer(again.body["token"])))["balance_credits"], 250);

    // ...and from a browser (Apple JS, the Services ID): same user, same account.
    const web = await w.apple("001.alice", undefined, { client: "web" });
    assert.equal(web.body["account_id"], a.id);
    const exch = w.fake.calls.filter((c) => c.url === APPLE_TOKEN_URL);
    assert.equal(exch.at(-1)!.form.get("client_id"), SERVICES);
    assert.equal(exch.at(-1)!.form.get("redirect_uri"), APPLE_REDIRECT);
    assert.equal(exch[0]!.form.get("client_id"), BUNDLE);
    assert.equal(exch[0]!.form.get("redirect_uri"), null, "native codes have no redirect");
  });

  test("a new device with a new identity opens a new linked account (rate-limited like any account)", async () => {
    const w = await world();
    // "Restore" asks not to create: an unknown identity is a plain 404.
    const n = await w.nonce();
    const restore = await w.post("/billing/signin", { provider: "google", client: "web", nonce: n.nonce, id_token: await w.fake.googleIdToken("g-100", n.provider_nonce), create: false });
    assert.equal(restore.status, 404);
    assert.equal(restore.body["error"], "no_account");
    const r = await w.google("g-100");
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body["result"], "created");
    assert.equal(r.body["balance_credits"], 0);
    const auth = bearer(r.body["token"]);
    assert.deepEqual(((await w.balance(auth))["identities"] as { provider: string }[]).map((x) => x.provider), ["google"]);
    // Then the same account links Apple too: both lead back to it.
    assert.equal((await w.apple("001.bob", auth)).body["result"], "linked");
    assert.equal((await w.apple("001.bob")).body["account_id"], r.body["account_id"]);
    assert.equal((await w.google("g-100")).body["account_id"], r.body["account_id"]);
  });

  test("conflict: never merged; the user picks, and only the ticket switches", async () => {
    const w = await world();
    const a = await w.anon(300);
    await w.apple("001.carol", a.auth);
    const b = await w.anon(40); // the same person on a second device, made before signing in
    const r = await w.apple("001.carol", b.auth);
    assert.equal(r.status, 409);
    assert.equal(r.body["error"], "identity_in_use");
    assert.deepEqual(r.body["current"], { balance_credits: 40, identities: [] });
    assert.deepEqual(r.body["other"], { balance_credits: 300, identities: [{ provider: "apple", linked_at: new Date(NOW_S * 1000).toISOString() }] });
    assert.equal(r.body["token"], undefined, "no session without the user's choice");
    // Nothing moved.
    assert.equal((await w.balance(a.auth))["balance_credits"], 300);
    assert.equal((await w.balance(b.auth))["balance_credits"], 40);
    assert.deepEqual((await w.balance(b.auth))["identities"], []);

    assert.equal((await w.post("/billing/signin/switch", { ticket: "sw1.nope" })).status, 400);
    const forged = String(r.body["switch_ticket"]).replace(a.id, b.id);
    assert.equal((await w.post("/billing/signin/switch", { ticket: forged })).status, 400);
    const sw = await w.post("/billing/signin/switch", { ticket: r.body["switch_ticket"] });
    assert.equal(sw.status, 200);
    assert.equal(sw.body["account_id"], a.id);
    assert.equal((await w.balance(bearer(sw.body["token"])))["balance_credits"], 300);
    // Still nothing merged; B is untouched (its own session still works).
    assert.equal((await w.balance(b.auth))["balance_credits"], 40);
    assert.ok(w.logs.some((l) => l.includes('"ai_signin_switched"')));
  });

  test("one identity per provider per account", async () => {
    const w = await world();
    const a = await w.anon();
    await w.apple("001.dan", a.auth);
    const other = await w.apple("001.dan-second-apple-id", a.auth);
    assert.equal(other.status, 409);
    assert.equal(other.body["error"], "provider_linked");
    // The second Apple ID stayed free: on a fresh device it opens its own account.
    const fresh = await w.apple("001.dan-second-apple-id");
    assert.equal(fresh.body["result"], "created");
    assert.notEqual(fresh.body["account_id"], a.id);
  });

  test("bad tokens: replayed nonce, foreign nonce, wrong client, code for another user, bad grant", async () => {
    const w = await world();
    const n = await w.nonce();
    const tok = await w.fake.appleIdToken("001.eve", n.provider_nonce);
    const body = { provider: "apple", client: "ios", nonce: n.nonce, id_token: tok, code: "c:001.eve" };
    assert.equal((await w.post("/billing/signin", body)).status, 201);
    const replay = await w.post("/billing/signin", body);
    assert.equal(replay.status, 401, "a nonce is accepted once");
    assert.equal(replay.body["error"], "invalid_token");

    const n2 = await w.nonce();
    const wrongNonce = await w.fake.appleIdToken("001.eve", await sha256hex("attacker-chosen"));
    assert.equal((await w.post("/billing/signin", { ...body, nonce: n2.nonce, id_token: wrongNonce })).status, 401);
    // An app token presented as a web sign-in (audience = the bundle id).
    const n3 = await w.nonce();
    assert.equal((await w.post("/billing/signin", { ...body, client: "web", nonce: n3.nonce, id_token: await w.fake.appleIdToken("001.eve", n3.provider_nonce) })).status, 401);
    // The code exchange returns someone else.
    w.fake.exchangeSub = "001.mallory";
    assert.equal((await w.apple("001.eve")).status, 401);
    w.fake.exchangeSub = null;
    assert.equal((await w.apple("001.eve", undefined, { code: "expired" })).status, 401);
    assert.equal((await w.post("/billing/signin", { provider: "github", client: "ios", nonce: "x" })).status, 400);
    // A Google token on the iOS path needs the code + verifier.
    const n4 = await w.nonce();
    assert.equal((await w.post("/billing/signin", { provider: "google", client: "ios", nonce: n4.nonce, id_token: "x" })).status, 400);
    // A revoked / garbage session is refused outright (not treated as "no session").
    assert.equal((await w.apple("001.eve", { authorization: "Bearer sst1.garbage" })).status, 401);
  });

  test("Google on iOS: PKCE code exchange with the iOS client, our nonce", async () => {
    const w = await world();
    const n = await w.nonce();
    const r = await w.post("/billing/signin", { provider: "google", client: "ios", nonce: n.nonce, code: `g:g-ios-1:${n.provider_nonce}`, code_verifier: "v".repeat(43) });
    assert.equal(r.status, 201, r.text);
    const ex = w.fake.calls.find((c) => c.url === GOOGLE_TOKEN_URL)!;
    assert.equal(ex.form.get("client_id"), G_IOS);
    assert.equal(ex.form.get("redirect_uri"), googleIosRedirect(G_IOS));
    assert.equal(ex.form.get("code_verifier"), "v".repeat(43));
    assert.equal(ex.form.get("client_secret"), null, "iOS clients have no secret");
    const n2 = await w.nonce();
    const bad = await w.post("/billing/signin", { provider: "google", client: "ios", nonce: n2.nonce, code: "g:g-ios-1:wrongnonce", code_verifier: "v".repeat(43) });
    assert.equal(bad.status, 401);
  });

  test("unlink: the last way back needs confirming; Apple's token is revoked", async () => {
    const w = await world();
    const a = await w.anon(80);
    await w.apple("001.fay", a.auth);
    const guarded = await w.post("/billing/signin/unlink", { provider: "apple" }, a.auth);
    assert.equal(guarded.status, 409);
    assert.equal(guarded.body["error"], "unrecoverable");
    assert.equal(w.fake.revokes().length, 0);
    const ok = await w.post("/billing/signin/unlink", { provider: "apple", confirm_unrecoverable: true }, a.auth);
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.body["identities"], []);
    const rv = w.fake.revokes();
    assert.equal(rv.length, 1);
    assert.equal(rv[0]!.form.get("client_id"), BUNDLE);
    assert.equal(rv[0]!.form.get("token_type_hint"), "refresh_token");
    assert.match(rv[0]!.form.get("token") ?? "", /^rt-SECRET-001\.fay-/);
    // The Apple ID is free again: a fresh device gets a NEW account.
    assert.notEqual((await w.apple("001.fay")).body["account_id"], a.id);
    // With another sign-in linked, no confirmation is needed.
    const b = await w.anon(10);
    await w.apple("001.gus", b.auth);
    await w.google("g-gus", b.auth);
    assert.equal((await w.post("/billing/signin/unlink", { provider: "google" }, b.auth)).status, 200);
    assert.equal((await w.post("/billing/signin/unlink", { provider: "apple" }, { authorization: "Bearer x" })).status, 401);
  });

  test("deletion revokes Apple first, frees the identities, forfeits; Apple down = nothing changed", async () => {
    const w = await world();
    const a = await w.anon(120);
    await w.apple("001.hal", a.auth);
    await w.google("g-hal", a.auth);

    w.fake.revokeFails = 2; // both tries fail
    const blocked = await w.call("/billing/account", { method: "DELETE", headers: a.auth });
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body["error"], "provider_unavailable");
    assert.equal((await w.balance(a.auth))["balance_credits"], 120, "still open");
    assert.equal(((await w.balance(a.auth))["identities"] as unknown[]).length, 2);

    w.fake.revokeFails = 1; // one retry succeeds
    const del = await w.call("/billing/account", { method: "DELETE", headers: a.auth });
    assert.equal(del.status, 200, del.text);
    assert.equal(w.fake.revokes().length, 4); // 2 failed, then 1 failed + 1 ok
    assert.match(w.fake.revokes().at(-1)!.form.get("token") ?? "", /^rt-SECRET-001\.hal-/);
    // The identities are free: signing in again starts a fresh, empty account.
    const back = await w.apple("001.hal");
    assert.equal(back.body["result"], "created");
    assert.notEqual(back.body["account_id"], a.id);
    assert.equal(back.body["balance_credits"], 0);
    assert.equal((await w.google("g-hal")).body["result"], "created");
    // The closed account keeps no identity.
    const closed = (await new DoLedger(w.env.BILLING!, a.id).account()).account!;
    assert.equal(closed.status, "closed");
    assert.equal(closed.identities, undefined);
    assert.ok(w.logs.some((l) => l.includes('"ai_apple_revoke_failed"')));
  });

  test("Apple server notifications: consent revoked unlinks Apple, keeps the credits; forged ones are refused", async () => {
    const w = await world();
    const a = await w.anon(55);
    await w.apple("001.ivy", a.auth);
    const notify = (events: Record<string, unknown>, key = w.fake.appleKeys[0]!) =>
      signRs256(key, { iss: APPLE_ISSUER, aud: BUNDLE, iat: NOW_S - 30, jti: "j1", events: JSON.stringify(events) });
    const forgedKey = await rsaKey("apple-1");
    assert.equal((await w.post("/billing/signin/apple/notify", { payload: await notify({ type: "consent-revoked", sub: "001.ivy" }, forgedKey) })).status, 400);
    assert.equal(((await w.balance(a.auth))["identities"] as unknown[]).length, 1);
    const r = await w.post("/billing/signin/apple/notify", { payload: await notify({ type: "consent-revoked", sub: "001.ivy", event_time: NOW_S }) });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual((await w.balance(a.auth))["identities"], []);
    assert.equal((await w.balance(a.auth))["balance_credits"], 55);
    assert.equal((await w.post("/billing/signin/apple/notify", { payload: await notify({ type: "email-disabled", sub: "001.ivy" }) })).status, 200);
  });

  test("what is stored: subject ids + an encrypted Apple token; no email, no secret anywhere", async () => {
    const w = await world();
    const a = await w.anon(5);
    await w.apple("001.jay", a.auth);
    await w.google("g-jay", a.auth);
    const acct = (await new DoLedger(w.env.BILLING!, a.id).account()).account!;
    assert.deepEqual(Object.keys(acct.identities!.apple!).sort(), ["apple_rt", "aud", "linked_at", "sub"]);
    assert.deepEqual(Object.keys(acct.identities!.google!).sort(), ["aud", "linked_at", "sub"]);
    assert.match(await openToken(TOKEN_KEY, acct.identities!.apple!.apple_rt!), /^rt-SECRET-001\.jay-/);
    const everything = [w.stored(), ...w.texts, ...w.logs].join("\n");
    for (const needle of ["rt-SECRET", "@", "PRIVATE KEY", TOKEN_KEY, w.key.pem.split("\n")[1]!]) {
      assert.ok(!everything.includes(needle), `found ${needle.slice(0, 20)}`);
    }
    // ...and the sub never goes to the logs.
    assert.ok(!w.logs.join("\n").includes("001.jay"));
  });

  test("after an email recovery (a new session generation) sign-in still works; the old token is signed out", async () => {
    const w = await world();
    const a = await w.anon(40);
    assert.equal((await w.apple("001.rae", a.auth)).body["result"], "linked");
    // What /billing/recover/verify does to the other devices (billing_email.test.ts).
    const gen = await new DoLedger(w.env.BILLING!, a.id).bumpSessionGen();
    assert.equal(gen, 1);
    const again = await w.apple("001.rae");
    assert.equal(again.body["result"], "signed_in");
    const tok = String(again.body["token"]);
    assert.equal(tok, await mintSession(SECRET, a.id, NOW_S, "sandbox", gen), "minted at the current generation");
    assert.equal((await w.balance(bearer(tok)))["balance_credits"], 40);
    // The pre-recovery token is refused by sign-in too, as by every other route.
    assert.equal((await w.apple("001.rae", a.auth)).status, 401);
    assert.equal((await w.call("/billing/balance", { headers: a.auth })).status, 401);
  });

  test("sessions minted by sign-in are ordinary billing sessions", async () => {
    const w = await world();
    const r = await w.google("g-kim");
    assert.equal(r.body["token"], await mintSession(SECRET, String(r.body["account_id"]), NOW_S));
  });
});
