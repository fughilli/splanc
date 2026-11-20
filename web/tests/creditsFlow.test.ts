/**
 * The Splanc AI credits flow (effects/ai/creditsFlow.ts): a pure state machine
 * for the dedicated purchase / account flow, plus the client calls it drives
 * (recovery e-mail, restore, statement, pricing; providers/credits.ts).
 *
 * - steps in order, skipping what's done; Back pops visited steps; cancel exits;
 * - the optional recovery e-mail (add / continue anonymously with an honest
 *   confirmation);
 * - Stripe's return: success (balance lands), pending (webhook slow), cancel;
 * - restore on a fresh device; delete; errors; an iOS build without the
 *   StoreKit plugin never shows credits (iap.test.ts covers the iOS path).
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  buyPhases,
  progress,
  purchaseLanded,
  reduce,
  resendCooldownLeft,
  startFlow,
  type FlowContext,
  type FlowEvent,
  type FlowState,
} from "../src/effects/ai/creditsFlow";
import {
  CreditsApiError,
  acknowledgeAnonymous,
  checkoutReturnUrl,
  isSignedOut,
  loadCreditsBalance,
  removeRecoveryEmail,
  creditsEmail,
  creditsVisible,
  emailDeclined,
  fetchCreditsPricing,
  fetchCreditsStatement,
  getCreditsSession,
  isOutOfCredits,
  isValidEmail,
  makeCreditsProvider,
  maskEmail,
  promptsFor,
  setCreditsSession,
  startEmailLink,
  startRecovery,
  statementLabel,
  takeLowBalanceWarning,
  verifyEmailLink,
  verifyRecovery,
} from "../src/effects/ai/providers/credits";

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
const g = globalThis as unknown as { localStorage: MemStore; Capacitor?: unknown };

beforeEach(() => {
  g.localStorage = new MemStore();
  delete g.Capacitor;
});

const fresh: FlowContext = {
  enabled: true,
  ios: false,
  iap: false,
  consentAsked: false,
  hasSession: false,
  adult: false,
  emailVerified: false,
  emailDeclined: false,
};
const run = (s: FlowState, ...evs: FlowEvent[]): FlowState => evs.reduce(reduce, s);

// -- buy ---------------------------------------------------------------------------

test("buy, new user: intro -> account -> email choice -> email -> code -> packs -> hand-off", () => {
  let s = startFlow("buy", fresh);
  assert.equal(s.step, "intro");
  assert.equal(progress(s), null, "the intro is not a numbered step");
  s = reduce(s, { type: "next" });
  assert.equal(s.step, "account");
  assert.deepEqual(progress(s), { index: 1, total: 4, phase: "account" });
  s = reduce(s, { type: "accountReady" });
  assert.equal(s.step, "emailChoice");
  assert.deepEqual(progress(s), { index: 2, total: 4, phase: "email" });
  s = run(s, { type: "chooseEmail" }, { type: "codeSent", email: "kim@example.com" });
  assert.equal(s.step, "emailCode");
  assert.equal(s.email, "kim@example.com");
  s = reduce(s, { type: "emailVerified" });
  assert.equal(s.step, "packs");
  assert.deepEqual(progress(s), { index: 3, total: 4, phase: "pack" });
  // Continue needs a pack.
  assert.equal(reduce(s, { type: "continueToPayment" }).step, "packs");
  s = run(s, { type: "selectPack", sku: "web.credits.25" }, { type: "continueToPayment" });
  assert.equal(s.step, "handoff");
  assert.equal(s.packSku, "web.credits.25");
  assert.deepEqual(progress(s), { index: 4, total: 4, phase: "payment" });
  s = reduce(s, { type: "checkoutOpening" });
  assert.equal(s.step, "redirecting");
});

test("buy, returning adult with an e-mail: intro goes straight to packs (2 phases)", () => {
  const ctx = { ...fresh, hasSession: true, adult: true, emailVerified: true };
  assert.deepEqual(buyPhases(ctx), ["pack", "payment"]);
  const s = run(startFlow("buy", ctx), { type: "next" });
  assert.equal(s.step, "packs");
  assert.deepEqual(progress(s), { index: 1, total: 2, phase: "pack" });
});

test("buy, account without 18+ confirmation still asks for it", () => {
  const s = run(startFlow("buy", { ...fresh, hasSession: true }), { type: "next" });
  assert.equal(s.step, "account");
});

test("email is optional: skipping shows an honest confirmation; going back adds the email", () => {
  let s = run(startFlow("buy", fresh), { type: "next" }, { type: "accountReady" }, { type: "skipEmail" });
  assert.equal(s.step, "anonConfirm");
  // "Go back and add email"
  assert.equal(reduce(s, { type: "chooseEmail" }).step, "emailEntry");
  // "Continue anonymously"
  s = reduce(s, { type: "confirmAnon" });
  assert.equal(s.step, "packs");
  assert.equal(s.ctx.emailDeclined, true);
  // Once declined, the flow doesn't ask again.
  assert.deepEqual(buyPhases({ ...fresh, hasSession: true, adult: true, emailDeclined: true }), ["pack", "payment"]);
});

test("Back pops visited steps (skipped steps aren't revisited); Back on the first step exits", () => {
  let s = run(startFlow("buy", fresh), { type: "next" }, { type: "accountReady" }, { type: "chooseEmail" });
  assert.equal(s.step, "emailEntry");
  s = reduce(s, { type: "back" });
  assert.equal(s.step, "emailChoice");
  s = run(s, { type: "back" }, { type: "back" });
  assert.equal(s.step, "intro");
  s = reduce(s, { type: "back" });
  assert.ok(s.exit, "back from the intro leaves the flow");
  // Use a different e-mail from the code screen = back to the e-mail entry.
  const c = run(startFlow("email", { ...fresh, hasSession: true }), { type: "codeSent", email: "a@b.co" }, { type: "changeEmail" });
  assert.equal(c.step, "emailEntry");
});

test("cancel exits from any step; nothing reduces after exit", () => {
  const s = run(startFlow("buy", fresh), { type: "next" }, { type: "cancel" });
  assert.ok(s.exit);
  assert.equal(reduce(s, { type: "accountReady" }), s);
});

test("errors show inline on the step and clear on the next transition; a failed redirect returns to the hand-off", () => {
  let s = run(startFlow("buy", fresh), { type: "next" }, { type: "fail", message: "Can't reach Splanc right now." });
  assert.equal(s.step, "account");
  assert.equal(s.error, "Can't reach Splanc right now.");
  s = reduce(s, { type: "accountReady" });
  assert.equal(s.error, undefined);
  const h = run(
    startFlow("buy", { ...fresh, hasSession: true, adult: true, emailVerified: true }),
    { type: "next" },
    { type: "selectPack", sku: "web.credits.10" },
    { type: "continueToPayment" },
    { type: "checkoutOpening" },
    { type: "fail", message: "Checkout is unavailable." },
  );
  assert.equal(h.step, "handoff");
  assert.equal(h.error, "Checkout is unavailable.");
});

// -- Stripe return -----------------------------------------------------------------

test("return success: confirming until the credit lands, then success with the balance", () => {
  let s = startFlow("return", fresh, "success");
  assert.equal(s.step, "confirming");
  s = reduce(s, { type: "balanceArrived", balance: 833 });
  assert.equal(s.step, "returnSuccess");
  assert.equal(s.balance, 833);
  assert.ok(reduce(s, { type: "back" }).exit, "Back from the result leaves (never back to Stripe)");
});

test("return pending: the webhook is slow -> pending -> check again -> success", () => {
  let s = run(startFlow("return", fresh, "success"), { type: "pollTimedOut" });
  assert.equal(s.step, "returnPending");
  s = reduce(s, { type: "checkAgain" });
  assert.equal(s.step, "confirming");
  s = run(s, { type: "pollTimedOut" }, { type: "balanceArrived", balance: 10 });
  assert.equal(s.step, "returnSuccess");
});

test("return cancelled: nothing charged; Choose a pack restarts at the packs", () => {
  let s = startFlow("return", fresh, "cancel");
  assert.equal(s.step, "returnCancelled");
  s = reduce(s, { type: "choosePack" });
  assert.equal(s.step, "packs");
  assert.equal(s.mode, "buy");
  // No checkout parameter (reload / bookmark): check the balance anyway.
  assert.equal(startFlow("return", fresh, null).step, "confirming");
});

test("purchaseLanded compares with the balance before checkout", () => {
  assert.equal(purchaseLanded(120, 120), false);
  assert.equal(purchaseLanded(953, 120), true);
  assert.equal(purchaseLanded(5, null), true);
  assert.equal(purchaseLanded(0, null), false);
});

// -- restore / e-mail / delete / availability --------------------------------------------

test("restore on a fresh device: e-mail -> code -> restored (balance)", () => {
  let s = startFlow("restore", fresh);
  assert.equal(s.step, "restoreEmail");
  s = reduce(s, { type: "codeSent", email: "kim@example.com" });
  assert.equal(s.step, "restoreCode");
  s = reduce(s, { type: "codeSent", email: "kim@example.com" }); // resend keeps the step
  assert.equal(s.step, "restoreCode");
  s = reduce(s, { type: "restored", balance: 412.5 });
  assert.equal(s.step, "restored");
  assert.equal(s.balance, 412.5);
});

test("email mode (from the credits page) exits with a notice once verified", () => {
  const s = run(startFlow("email", { ...fresh, hasSession: true, adult: true }), { type: "codeSent", email: "k@x.io" }, { type: "emailVerified" });
  assert.deepEqual(s.exit, { notice: "Recovery email saved." });
  // Without an account the e-mail entry point starts the buy flow instead.
  assert.equal(startFlow("email", fresh).step, "intro");
});

test("delete: a confirmation step, then deleted; not offered without an account", () => {
  const s = startFlow("delete", { ...fresh, hasSession: true });
  assert.equal(s.step, "deleteConfirm");
  assert.equal(reduce(s, { type: "deleted" }).step, "deleted");
  assert.ok(reduce(s, { type: "cancel" }).exit, "Keep my account leaves");
  assert.equal(startFlow("delete", fresh).step, "unavailable");
});

test("an iOS build without StoreKit (and flag off) never shows credits: every entry point is unavailable", () => {
  for (const mode of ["buy", "return", "restore", "email", "delete"] as const) {
    assert.equal(startFlow(mode, { ...fresh, ios: true, hasSession: true }).step, "unavailable", mode);
    assert.equal(startFlow(mode, { ...fresh, enabled: false }).step, "unavailable", mode);
  }
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  assert.equal(creditsVisible(), true);
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
  assert.equal(creditsVisible(), false, "no StoreKit plugin in this build");
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", isPluginAvailable: (n: string) => n === "StoreKitBridge" };
  assert.equal(creditsVisible(), true, "a build with the StoreKit plugin sells credits");
});

test("resend cooldown counts down whole seconds", () => {
  assert.equal(resendCooldownLeft(1000, 30, 1000), 30);
  assert.equal(resendCooldownLeft(1000, 30, 1000 + 29_100), 1);
  assert.equal(resendCooldownLeft(1000, 30, 1000 + 30_000), 0);
});

// -- client calls ------------------------------------------------------------------------

function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const h = routes[`${init.method ?? "GET"} ${path}`];
    if (!h) return new Response("{}", { status: 404 });
    const [status, body] = h(init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("recovery e-mail: send code (auth) -> verify; wrong / expired / too many tries read plainly", async () => {
  setCreditsSession({ account_id: "a1", token: "tok" });
  let tries = 0;
  const f = fakeFetch({
    "POST /billing/account/email": () => [202, { ok: true, message: "sent", resend_after_s: 45 }],
    "POST /billing/account/email/verify": (b) => {
      tries++;
      const code = (b as { code: string }).code;
      if (code === "000000") return [400, { error: "invalid_code", message: "bad" }];
      if (code === "111111") return [400, { error: "expired_code", message: "old" }];
      if (code === "222222") return [429, { error: "too_many_attempts", message: "slow down", retry_after_s: 300 }];
      return [200, { ok: true }];
    },
  });
  assert.deepEqual(await startEmailLink("kim@example.com", f.fn), { resendAfterS: 45 });
  assert.equal((f.calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer tok");
  await assert.rejects(startEmailLink("not-an-email", f.fn), /doesn't look like an e-mail/);
  // Every code failure reads the same (the server doesn't say which, nor how
  // many tries are left).
  await assert.rejects(verifyEmailLink("kim@example.com", "000000", f.fn), /That code didn't work\. Check the latest email or request a new code\./);
  await assert.rejects(verifyEmailLink("kim@example.com", "111111", f.fn), /That code didn't work/);
  const e = await verifyEmailLink("kim@example.com", "222222", f.fn).catch((x: unknown) => x);
  assert.ok(e instanceof CreditsApiError && e.status === 429 && e.retryAfterS === 300 && /That code didn't work/.test(e.message));
  assert.equal(creditsEmail(), null);
  await verifyEmailLink("kim@example.com", "123456", f.fn);
  assert.equal(tries, 4);
  assert.equal(creditsEmail(), "k•••@example.com");
  assert.equal(emailDeclined(), false);
});

test("restore: same answer whether or not the e-mail exists; verify stores the session", async () => {
  const f = fakeFetch({
    "POST /billing/recover/start": () => [202, { ok: true, message: "If an account uses this address, we sent a code." }],
    "POST /billing/recover/verify": () => [200, { token: "t2", account_ref: "SPL-7", balance_credits: 412.5 }],
  });
  assert.deepEqual(await startRecovery("kim@example.com", f.fn), { resendAfterS: 30 });
  assert.equal(f.calls[0]!.init.headers && (f.calls[0]!.init.headers as Record<string, string>)["authorization"], undefined, "no session needed");
  assert.deepEqual(await verifyRecovery("kim@example.com", "123456", f.fn), { balanceCredits: 412.5 });
  assert.deepEqual(getCreditsSession(), { account_id: "SPL-7", token: "t2" });
  const offline = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;
  await assert.rejects(startRecovery("kim@example.com", offline), /Can't reach Splanc/);
});

test("statement + pricing + helpers", async () => {
  setCreditsSession({ account_id: "a1", token: "tok" });
  const f = fakeFetch({
    "GET /billing/statement": () => [200, { entries: [{ at: "2026-11-18T10:00:00Z", kind: "purchase", credits: 833, balance_credits: 833 }] }],
    "GET /billing/pricing": () => [200, { credits_per_usd: 100, low_balance_credits: 50, packs: [{ sku: "web.credits.10", credits: 833, reference_price_usd: 10 }] }],
  });
  const st = await fetchCreditsStatement(f.fn);
  assert.equal(statementLabel(st[0]!), "Credits bought");
  const pr = await fetchCreditsPricing(f.fn);
  assert.equal(pr?.packs[0]?.credits, 833);
  assert.deepEqual(promptsFor(833), { min: 70, max: 280 });
  assert.equal(maskEmail("kim@example.com"), "k•••@example.com");
  assert.equal(isValidEmail("kim@example"), false);
  assert.equal(checkoutReturnUrl({ origin: "https://splanc.io", pathname: "/app/" }), "https://splanc.io/app/#/credits/return");
});

test("out of credits (402) is a typed error; the low-balance heads-up shows once", async () => {
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  setCreditsSession({ account_id: "a1", token: "tok" });
  const f = fakeFetch({ "POST /ai/v1/messages": () => [402, { error: "insufficient_balance", message: "Not enough credit." }] });
  const e = await makeCreditsProvider({ model: "", fetchImpl: f.fn })
    .send([{ role: "user", content: "hi" }], { system: "s", tools: [] } as never)
    .catch((x: unknown) => x);
  assert.equal(isOutOfCredits(e), true);
  assert.equal(takeLowBalanceWarning(), null, "no balance seen yet");
});

test("email in use (409), anonymous acknowledgement, remove email, balance hint, signed out (401)", async () => {
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  setCreditsSession({ account_id: "a1", token: "tok" });
  const seen: string[] = [];
  let balanceStatus = 200;
  const f = fakeFetch({
    "POST /billing/account/email/verify": () => [409, { error: "email_in_use", message: "in use" }],
    "POST /billing/account/anonymous": (b) => (seen.push(JSON.stringify(b)), [200, { ok: true, anonymous_ack_at: "2026-11-18T10:00:00Z" }]),
    "DELETE /billing/account/email": () => (seen.push("delete-email"), [200, { ok: true }]),
    "GET /billing/balance": () =>
      balanceStatus === 401
        ? [401, { error: "unauthorized", message: "no" }]
        : [200, { balance_credits: 5, available_credits: 5, held_credits: 0, low: true, status: "active", adult: true, email_hint: "k•••@gmail.com", email_verified: true, anonymous_ack_at: null }],
  });
  const e = await verifyEmailLink("kim@gmail.com", "123456", f.fn).catch((x: unknown) => x);
  assert.ok(e instanceof CreditsApiError && e.code === "email_in_use" && /restore that account instead/.test(e.message));
  await acknowledgeAnonymous(f.fn);
  assert.deepEqual(seen, ['{"acknowledge":true}']);
  assert.equal(emailDeclined(), true);
  const r = await loadCreditsBalance(f.fn);
  assert.ok("balance" in r);
  assert.equal(creditsEmail(r.balance), "k•••@gmail.com", "the server's hint is shown as is");
  assert.equal(emailDeclined({ ...r.balance, anonymous_ack_at: "2026-11-18T10:00:00Z" }), true);
  await removeRecoveryEmail(f.fn);
  assert.equal(seen[1], "delete-email");
  assert.equal(creditsEmail({ ...r.balance, email_hint: null, email_verified: false }), null);
  balanceStatus = 401;
  assert.deepEqual(await loadCreditsBalance(f.fn), { signedOut: true });
  assert.equal(isSignedOut(new CreditsApiError(401, "unauthorized", "x")), true);
});

test("remove email: a warning step, then exit with a notice; no e-mail -> a plain note, no dead end", () => {
  const ctx = { ...fresh, hasSession: true, adult: true, emailVerified: true };
  const s = startFlow("removeEmail", ctx);
  assert.equal(s.step, "removeEmailConfirm");
  assert.deepEqual(reduce(s, { type: "emailRemoved" }).exit, { notice: "Recovery email removed." });
  assert.ok(reduce(s, { type: "cancel" }).exit);
  assert.deepEqual(startFlow("removeEmail", { ...ctx, emailVerified: false }).exit, { notice: "This account has no recovery email." });
  assert.equal(startFlow("removeEmail", { ...ctx, hasSession: false }).step, "unavailable");
});
