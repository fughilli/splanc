/**
 * Sign in with Apple / Google on the app side (effects/ai/providers/
 * creditsSignin.ts + the credits flow's sign-in steps):
 *
 * - which providers each platform offers (iOS app: native Apple + Google in
 *   the system sheet; browser / Android: Apple JS + Google's button);
 * - the relay's answers: linked (same session), signed in / created (new
 *   session, the old one forgotten), a conflict (NOTHING changes until the
 *   user switches), restore with no account;
 * - the provider legs: Apple JS (state + nonce hash), Google PKCE on iOS
 *   (state checked, openid only, the relay's nonce hash);
 * - the flow: the buy flow's "keep your credits safe" step, restore, the
 *   conflict choice, sign out and unlink.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { buyPhases, progress, reduce, startFlow, type FlowContext, type FlowEvent, type FlowState } from "../src/effects/ai/creditsFlow";
import { getCreditsSession, setCreditsSession } from "../src/effects/ai/providers/credits";
import {
  appleWebProof,
  availableProviders,
  conflictIsHarmless,
  fetchSigninConfig,
  googleAuthorizeUrl,
  googleIosProof,
  resetSigninConfigCache,
  submitSignin,
  switchAccount,
  unlinkSignin,
  type PublicSigninConfig,
} from "../src/effects/ai/providers/creditsSignin";

class MemStore {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
const g = globalThis as unknown as { localStorage: MemStore; AppleID?: unknown };

beforeEach(() => {
  g.localStorage = new MemStore();
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  delete g.AppleID;
  resetSigninConfigCache();
});

const CFG: PublicSigninConfig = {
  apple: { ios: true, web: { client_id: "dev.splanc.signin", redirect_uri: "https://splanc.io/app/" } },
  google: { web: { client_id: "111-web.apps.googleusercontent.com" }, ios: { client_id: "222-ios.apps.googleusercontent.com", redirect_uri: "com.googleusercontent.apps.222-ios:/oauth2redirect" } },
};

function fakeFetch(reply: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const r = reply(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const proof = { provider: "apple" as const, client: "web" as const, nonce: "sn1.x", id_token: "t", code: "c" };

// -- platforms -------------------------------------------------------------------------

test("providers per platform: the iOS app needs the native plugin; browsers need the web clients", () => {
  assert.deepEqual(availableProviders(CFG, { ios: false, webAuth: false }), ["apple", "google"]);
  assert.deepEqual(availableProviders(CFG, { ios: true, webAuth: true }), ["apple", "google"]);
  assert.deepEqual(availableProviders(CFG, { ios: true, webAuth: false }), [], "an old app build without the plugin");
  assert.deepEqual(availableProviders({ apple: { ios: true, web: null }, google: { web: { client_id: "w" }, ios: null } }, { ios: false, webAuth: false }), ["google"]);
  assert.deepEqual(availableProviders({ apple: { ios: true, web: null }, google: { web: { client_id: "w" }, ios: null } }, { ios: true, webAuth: true }), ["apple"]);
  assert.deepEqual(availableProviders(null), []);
});

test("config is fetched once and cached", async () => {
  const { f, calls } = fakeFetch(() => ({ status: 200, body: CFG }));
  assert.deepEqual(await fetchSigninConfig(f, 1000), CFG);
  await fetchSigninConfig(f, 2000);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.url.endsWith("/billing/signin/config"));
});

// -- relay answers ---------------------------------------------------------------------

test("linking keeps this device's session and sends it", async () => {
  setCreditsSession({ account_id: "acct_a", token: "tok_a" });
  const { f, calls } = fakeFetch(() => ({ status: 200, body: { result: "linked", account_id: "acct_a", balance_credits: 12, identities: [{ provider: "apple", linked_at: "2026-11-20T00:00:00Z" }] } }));
  const r = await submitSignin(proof, {}, f);
  assert.equal(r.kind, "linked");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer tok_a");
  assert.deepEqual(getCreditsSession(), { account_id: "acct_a", token: "tok_a" });
});

test("signing in on a new device stores the account's session; another account replaces ours", async () => {
  const { f, calls } = fakeFetch(() => ({ status: 200, body: { result: "signed_in", account_id: "acct_b", token: "tok_b", balance_credits: 300, identities: [] } }));
  const r = await submitSignin(proof, { create: false }, f);
  assert.equal(r.kind, "signed_in");
  assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], undefined, "no session to send");
  assert.equal(JSON.parse(String(calls[0]!.init.body))["create"], false);
  assert.deepEqual(getCreditsSession(), { account_id: "acct_b", token: "tok_b" });
});

test("a conflict changes nothing until the user switches", async () => {
  setCreditsSession({ account_id: "acct_a", token: "tok_a" });
  g.localStorage.setItem("splanc.aiCredits.email", "a@example.com");
  const conflict = { error: "identity_in_use", current: { balance_credits: 40, identities: [] }, other: { balance_credits: 300, identities: [{ provider: "apple", linked_at: "x" }] }, switch_ticket: "sw1.t" };
  const { f } = fakeFetch((url) => (url.endsWith("/switch") ? { status: 200, body: { result: "switched", account_id: "acct_b", token: "tok_b", balance_credits: 300, identities: [] } } : { status: 409, body: conflict }));
  const r = await submitSignin(proof, {}, f);
  assert.equal(r.kind, "conflict");
  if (r.kind !== "conflict") return;
  assert.equal(r.current?.balance_credits, 40);
  assert.equal(r.other.balance_credits, 300);
  assert.deepEqual(getCreditsSession(), { account_id: "acct_a", token: "tok_a" }, "still this device's account");
  assert.equal(conflictIsHarmless(r), false, "40 credits would be left behind");
  assert.equal(conflictIsHarmless({ ...r, current: { balance_credits: 0, identities: [] } }), true);
  assert.equal(conflictIsHarmless({ ...r, current: { balance_credits: 0, identities: [] } }, true), false, "an email leads back to it");
  const sw = await switchAccount(r.ticket, "apple", f);
  assert.equal(sw.kind, "switched");
  assert.deepEqual(getCreditsSession(), { account_id: "acct_b", token: "tok_b" });
  assert.equal(g.localStorage.getItem("splanc.aiCredits.email"), null, "the old account's local email copy is dropped");
});

test("restore with no account; refusals carry the server's code", async () => {
  const { f } = fakeFetch(() => ({ status: 404, body: { error: "no_account" } }));
  assert.deepEqual(await submitSignin(proof, { create: false }, f), { kind: "no_account", provider: "apple" });
  const { f: f2 } = fakeFetch(() => ({ status: 409, body: { error: "provider_linked", message: "This account is already linked to a different Apple ID." } }));
  await assert.rejects(submitSignin(proof, {}, f2), (e: Error & { code?: string }) => e.code === "provider_linked" && /different Apple ID/.test(e.message));
  setCreditsSession({ account_id: "acct_a", token: "tok_a" });
  const { f: f3, calls } = fakeFetch(() => ({ status: 409, body: { error: "unrecoverable", message: "only way" } }));
  await assert.rejects(unlinkSignin("apple", false, f3), (e: Error & { code?: string }) => e.code === "unrecoverable");
  await assert.rejects(unlinkSignin("apple", true, f3));
  assert.equal(JSON.parse(String(calls[1]!.init.body))["confirm_unrecoverable"], true);
});

// -- provider legs ---------------------------------------------------------------------

test("Apple JS: popup with our nonce hash and a state; no scopes asked", async () => {
  let init: Record<string, unknown> = {};
  g.AppleID = {
    auth: {
      init: (o: Record<string, unknown>) => (init = o),
      signIn: async () => ({ authorization: { code: "c1", id_token: "t1", state: init["state"] } }),
    },
  };
  const loads: string[] = [];
  const p = await appleWebProof(CFG, { nonce: "sn1.raw", provider_nonce: "hash" }, async (src) => void loads.push(src));
  assert.deepEqual(p, { provider: "apple", client: "web", nonce: "sn1.raw", id_token: "t1", code: "c1" });
  assert.equal(init["nonce"], "hash");
  assert.equal(init["clientId"], "dev.splanc.signin");
  assert.equal(init["usePopup"], true);
  assert.equal(init["scope"], undefined, "no name, no email");
  assert.match(loads[0]!, /^https:\/\/appleid\.cdn-apple\.com\//);
  // A mismatched state is refused; closing the popup is a quiet cancel.
  g.AppleID = { auth: { init: () => undefined, signIn: async () => ({ authorization: { code: "c", id_token: "t", state: "other" } }) } };
  await assert.rejects(appleWebProof(CFG, { nonce: "n", provider_nonce: "h" }, async () => undefined));
  g.AppleID = { auth: { init: () => undefined, signIn: async () => Promise.reject({ error: "popup_closed_by_user" }) } };
  await assert.rejects(appleWebProof(CFG, { nonce: "n", provider_nonce: "h" }, async () => undefined), (e: Error) => e.name === "SigninCancelled");
});

test("Google on iOS: code + PKCE in the system sheet, state checked", async () => {
  const u = new URL(googleAuthorizeUrl({ clientId: "cid", redirectUri: "com.googleusercontent.apps.x:/oauth2redirect", challenge: "ch", state: "st", nonce: "nh" }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("scope"), "openid");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("nonce"), "nh");
  let opened = "";
  let scheme = "";
  const p = await googleIosProof(CFG, { nonce: "sn1.raw", provider_nonce: "hash" }, async (url, sch) => {
    opened = url;
    scheme = sch;
    const st = new URL(url).searchParams.get("state");
    return `com.googleusercontent.apps.222-ios:/oauth2redirect?code=abc&state=${st}`;
  });
  assert.equal(scheme, "com.googleusercontent.apps.222-ios");
  assert.equal(new URL(opened).searchParams.get("nonce"), "hash");
  assert.equal(p.code, "abc");
  assert.equal(p.client, "ios");
  assert.ok((p.code_verifier ?? "").length >= 43);
  await assert.rejects(googleIosProof(CFG, { nonce: "n", provider_nonce: "h" }, async () => "com.googleusercontent.apps.222-ios:/oauth2redirect?code=abc&state=forged"));
});

// -- the flow --------------------------------------------------------------------------

const fresh: FlowContext = { enabled: true, ios: false, hasSession: false, adult: false, emailVerified: false, emailDeclined: false, signinAvailable: true };
const run = (s: FlowState, ...evs: FlowEvent[]): FlowState => evs.reduce(reduce, s);
const signed = (adult: boolean, kind: "linked" | "signed_in" | "switched" | "created" = "linked"): FlowEvent => ({ type: "signedIn", kind, provider: "apple", balance: 12, adult });

test("buy: the safety step offers sign-in; linking goes straight to the packs", () => {
  let s = startFlow("buy", fresh);
  assert.deepEqual(s.phases, ["account", "signin", "pack", "payment"]);
  s = run(s, { type: "next" }, { type: "accountReady" });
  assert.equal(s.step, "signInChoice");
  assert.equal(progress(s)?.phase, "signin");
  assert.equal(run(s, signed(true)).step, "packs");
  // An email instead, or nothing (with the honest warning).
  assert.equal(run(s, { type: "chooseEmail" }).step, "emailEntry");
  assert.equal(run(s, { type: "skipEmail" }).step, "anonConfirm");
  // Signed in to an existing account that never confirmed 18+: ask first.
  const other = run(s, signed(false, "switched"));
  assert.equal(other.step, "account");
  assert.equal(run(other, { type: "accountReady" }).step, "packs", "signed in: no safety step again");
  // Without sign-in configured, the e-mail step stays.
  assert.equal(run(startFlow("buy", { ...fresh, signinAvailable: false }), { type: "next" }, { type: "accountReady" }).step, "emailChoice");
  // Already signed in: no safety phase at all.
  assert.deepEqual(buyPhases({ ...fresh, hasSession: true, adult: true, signedIn: true }), ["pack", "payment"]);
});

test("conflict: keep this device's account (back to the choice) or switch", () => {
  const s = run(startFlow("buy", fresh), { type: "next" }, { type: "accountReady" }, { type: "signinConflict", provider: "apple" });
  assert.equal(s.step, "signInConflict");
  assert.equal(run(s, { type: "keepCurrent" }).step, "signInChoice");
  assert.equal(run(s, signed(true, "switched")).step, "packs");
  const plain = run(startFlow("signin", { ...fresh, hasSession: true }), { type: "signinConflict", provider: "google" });
  assert.equal(plain.step, "signInConflict");
  assert.equal(run(plain, { type: "keepCurrent" }).exit?.notice, "Kept this device's account.");
});

test("restore: sign in, or no account -> email / another sign-in", () => {
  const s = startFlow("restore", fresh);
  assert.equal(s.step, "signInChoice");
  const done = run(s, signed(true, "signed_in"));
  assert.equal(done.step, "restored");
  assert.equal(done.balance, 12);
  const none = run(s, { type: "noAccount", provider: "google" });
  assert.equal(none.step, "signInNoAccount");
  assert.equal(run(none, { type: "chooseEmail" }).step, "restoreEmail");
  assert.equal(run(none, { type: "back" }).step, "signInChoice");
  assert.equal(run(s, { type: "chooseEmail" }).step, "restoreEmail");
  assert.equal(startFlow("restore", { ...fresh, signinAvailable: false }).step, "restoreEmail");
});

test("sign in from Settings, sign out, unlink", () => {
  const s = startFlow("signin", { ...fresh, hasSession: true });
  const done = run(s, signed(true, "linked"));
  assert.equal(done.step, "signInDone");
  assert.equal(done.signinKind, "linked");
  assert.ok(run(done, { type: "back" }).exit, "Back leaves a finished sign-in");
  assert.equal(startFlow("signin", { ...fresh, signinAvailable: false }).step, "unavailable");
  const out = startFlow("signout", { ...fresh, hasSession: true });
  assert.equal(out.step, "signOutConfirm");
  assert.equal(run(out, { type: "signedOut" }).exit?.notice, "Signed out of Splanc AI on this device.");
  assert.equal(startFlow("signout", fresh).step, "unavailable");
  const un = startFlow("unlinkGoogle", { ...fresh, hasSession: true });
  assert.equal(un.step, "unlinkConfirm");
  assert.equal(un.provider, "google");
  assert.equal(run(un, { type: "unlinked" }).exit?.notice, "Google sign-in removed.");
  assert.ok(run(un, { type: "cancel" }).exit);
});
