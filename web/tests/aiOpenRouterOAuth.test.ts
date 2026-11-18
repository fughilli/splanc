/**
 * "Connect OpenRouter" — OAuth PKCE (docs/design/ai-tiers.md) with a fake
 * OpenRouter: verifier/challenge (RFC 7636 vector), the authorize URL for the
 * redirect (PWA) and headless-code (iOS app) modes, callback parsing, the key
 * exchange request, state checking, expiry, and the human errors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  authorizeUrl,
  base64Url,
  beginOAuth,
  callbackUrlFor,
  cleanedUrl,
  codeChallengeS256,
  completeOAuthCode,
  completeOAuthRedirect,
  exchangeCode,
  makeCodeVerifier,
  parseCallback,
  readPendingOAuth,
  PENDING_TTL_MS,
  type KVStore,
} from "../src/effects/ai/openrouterOAuth";

function memStore(): KVStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

/** A fake POST /api/v1/auth/keys that records what it was sent. */
function fakeKeys(reply: { status: number; body: unknown }): { fetch: typeof fetch; sent: unknown[]; urls: string[] } {
  const sent: unknown[] = [];
  const urls: string[] = [];
  return {
    sent,
    urls,
    fetch: async (url, init) => {
      urls.push(String(url));
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(reply.body), { status: reply.status });
    },
  };
}

test("S256 challenge matches the RFC 7636 appendix B vector", async () => {
  assert.equal(
    await codeChallengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("verifier: 43 unreserved chars from 32 random bytes; base64url has no padding", () => {
  const v = makeCodeVerifier();
  assert.equal(v.length, 43);
  assert.match(v, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(makeCodeVerifier(), v);
  assert.equal(base64Url(new Uint8Array([251, 255])), "-_8");
});

test("authorize URL: redirect mode carries callback_url; headless (iOS) mode omits it", () => {
  const withCb = new URL(authorizeUrl({ challenge: "CH", callbackUrl: "https://splanc.io/app/", state: "S", keyLabel: "Splanc" }));
  assert.equal(withCb.origin + withCb.pathname, "https://openrouter.ai/auth");
  assert.equal(withCb.searchParams.get("callback_url"), "https://splanc.io/app/");
  assert.equal(withCb.searchParams.get("code_challenge"), "CH");
  assert.equal(withCb.searchParams.get("code_challenge_method"), "S256");
  assert.equal(withCb.searchParams.get("state"), "S");
  const headless = new URL(authorizeUrl({ challenge: "CH" }));
  assert.equal(headless.searchParams.has("callback_url"), false);
  assert.equal(callbackUrlFor({ origin: "capacitor://localhost", pathname: "/" }), "capacitor://localhost/");
});

test("parseCallback: code+state in the query or after the hash, errors, nothing", () => {
  assert.deepEqual(parseCallback("https://a.b/app/?code=C1&state=S1"), { kind: "code", code: "C1", state: "S1" });
  assert.deepEqual(parseCallback("https://a.b/app/#/x?code=C2"), { kind: "code", code: "C2", state: null });
  assert.deepEqual(parseCallback("https://a.b/?error=access_denied"), { kind: "error", message: "access_denied" });
  assert.deepEqual(parseCallback("https://a.b/#/effects"), { kind: "none" });
  assert.deepEqual(parseCallback("not a url"), { kind: "none" });
  assert.equal(cleanedUrl("https://a.b/app/?demo=1&code=C&state=S", "#/effects/edit/e1"), "https://a.b/app/?demo=1#/effects/edit/e1");
});

test("redirect round trip: begin → OpenRouter → callback → key exchange with the verifier", async () => {
  const store = memStore();
  const { url, pending } = await beginOAuth({
    mode: "redirect",
    returnHash: "#/effects/edit/e1",
    model: "m:free",
    location: { origin: "https://splanc.io", pathname: "/app/" },
    storage: store,
    now: 1000,
  });
  const u = new URL(url);
  assert.equal(u.searchParams.get("callback_url"), "https://splanc.io/app/");
  assert.equal(u.searchParams.get("code_challenge"), await codeChallengeS256(pending.verifier));
  assert.equal(u.searchParams.get("state"), pending.state);

  const or = fakeKeys({ status: 200, body: { key: "sk-or-v1-user" } });
  const r = await completeOAuthRedirect(`https://splanc.io/app/?code=CODE1&state=${pending.state}`, {
    storage: store,
    fetchImpl: or.fetch,
    now: 2000,
  });
  assert.equal(r?.key, "sk-or-v1-user");
  assert.equal(r?.pending.returnHash, "#/effects/edit/e1");
  assert.equal(r?.pending.model, "m:free");
  assert.deepEqual(or.urls, ["https://openrouter.ai/api/v1/auth/keys"]);
  assert.deepEqual(or.sent, [{ code: "CODE1", code_verifier: pending.verifier, code_challenge_method: "S256" }]);
  // single use: the pending record is gone
  assert.equal(readPendingOAuth(store, 2000), null);
});

test("redirect: a code we didn't ask for (no pending / wrong state) is not exchanged", async () => {
  const or = fakeKeys({ status: 200, body: { key: "k" } });
  assert.equal(await completeOAuthRedirect("https://x.y/?code=C", { storage: memStore(), fetchImpl: or.fetch }), null);
  const store = memStore();
  await beginOAuth({ mode: "redirect", returnHash: "", model: "m:free", location: { origin: "https://x.y", pathname: "/" }, storage: store });
  await assert.rejects(
    completeOAuthRedirect("https://x.y/?code=C&state=forged", { storage: store, fetchImpl: or.fetch }),
    /didn't match/,
  );
  assert.equal(or.sent.length, 0);
});

test("redirect: user cancelled on OpenRouter → a clear error, nothing stored", async () => {
  const store = memStore();
  await beginOAuth({ mode: "redirect", returnHash: "", model: "m:free", location: { origin: "https://x.y", pathname: "/" }, storage: store });
  await assert.rejects(completeOAuthRedirect("https://x.y/?error=access_denied", { storage: store }), /cancelled/);
});

test("pending record expires", async () => {
  const store = memStore();
  await beginOAuth({ mode: "code", returnHash: "", model: "m:free", storage: store, now: 0 });
  assert.ok(readPendingOAuth(store, PENDING_TTL_MS - 1));
  assert.equal(readPendingOAuth(store, PENDING_TTL_MS + 1), null);
  await assert.rejects(completeOAuthCode("C", { storage: store, now: PENDING_TTL_MS + 2 }), /expired/);
});

test("headless code (iOS app): paste the code → key", async () => {
  const store = memStore();
  const { url, pending } = await beginOAuth({ mode: "code", returnHash: "#/effects", model: "m:free", storage: store });
  assert.equal(new URL(url).searchParams.has("callback_url"), false);
  const or = fakeKeys({ status: 200, body: { key: "sk-or-ios" } });
  const r = await completeOAuthCode("  PASTED  ", { storage: store, fetchImpl: or.fetch });
  assert.equal(r.key, "sk-or-ios");
  assert.deepEqual(or.sent, [{ code: "PASTED", code_verifier: pending.verifier, code_challenge_method: "S256" }]);
  // a code-mode record is never consumed by a page-load redirect check
  await beginOAuth({ mode: "code", returnHash: "", model: "m:free", storage: store });
  assert.equal(await completeOAuthRedirect("https://x.y/?code=Z", { storage: store, fetchImpl: or.fetch }), null);
});

test("exchange errors are human: expired code, rejected code, no key", async () => {
  await assert.rejects(
    exchangeCode("c", "v", fakeKeys({ status: 403, body: { error: { message: "Authorization code expired" } } }).fetch),
    /expired/,
  );
  await assert.rejects(
    exchangeCode("c", "v", fakeKeys({ status: 403, body: { error: { message: "Invalid code or code_verifier" } } }).fetch),
    /each code works once/,
  );
  await assert.rejects(exchangeCode("c", "v", fakeKeys({ status: 200, body: {} }).fetch), /no key/);
  await assert.rejects(
    exchangeCode("c", "v", async () => {
      throw new TypeError("offline");
    }),
    /Couldn't reach OpenRouter/,
  );
});
