/**
 * Splanc AI credits in the iOS app: Apple In-App Purchase (effects/ai/iap.ts,
 * net/storeKit.ts, the iOS path of effects/ai/creditsFlow.ts), with a fake
 * StoreKit plugin and a fake relay.
 *
 * - the flow: the Apple refund-request consent is asked once, before the first
 *   purchase; no Stripe hand-off; purchased / pending (Ask to Buy) / cancelled /
 *   failed / paid-but-not-credited; Back can't pull the user out of the sheet;
 * - packs: the relay's apple packs joined with the App Store's products;
 * - a purchase sends the signed transaction with the account's appAccountToken
 *   and finishes it only once the relay credited it;
 * - finishing rules: credited / replay / already claimed / revoked finish;
 *   signed out / wrong account / relay down keep it for later;
 * - background delivery: Transaction.updates and unfinished transactions at
 *   start, de-duplicated, announced once;
 * - the web checkout is never reachable in the iOS app.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { buyPhases, progress, reduce, startFlow, type FlowContext, type FlowEvent, type FlowState } from "../src/effects/ai/creditsFlow";
import {
  buyCreditPack,
  checkForPurchases,
  deliverTransaction,
  deliverUnfinished,
  loadIapPacks,
  onIapCredited,
  resetIapForTests,
  startIapDelivery,
} from "../src/effects/ai/iap";
import { CreditsApiError, creditsVisible, mayShowWebCheckout, purchaseChannel, setCreditsSession, startWebCheckout } from "../src/effects/ai/providers/credits";
import { setStoreKitPluginForTests, storeKitAvailable, StoreKitError, type PurchaseOutcome, type StoreKitPlugin, type StoreProduct, type StoreTransaction } from "../src/net/storeKit";

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
const REF = "6f1c2a9e-1b2c-5d3e-8f40-0123456789ab";

beforeEach(() => {
  g.localStorage = new MemStore();
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios", isPluginAvailable: (n: string) => n === "StoreKitBridge" };
  setStoreKitPluginForTests(null);
  resetIapForTests();
  setCreditsSession({ account_id: "acct_aaaaaaaaaaaaaaaaaaaa", token: "sess" });
});

// -- fakes ----------------------------------------------------------------------------

const PRODUCTS: StoreProduct[] = [
  { id: "dev.splanc.app.credits.small", displayName: "356 credits", description: "", displayPrice: "$4.99", price: 4.99, currencyCode: "USD" },
  { id: "dev.splanc.app.credits.large", displayName: "1,427 credits", description: "", displayPrice: "$19.99", price: 19.99, currencyCode: "USD" },
];

function tx(n: number, productId = "dev.splanc.app.credits.small"): StoreTransaction {
  return { transactionId: String(n), originalTransactionId: String(n), productId, jws: `jws.${n}.sig` };
}

class FakeStoreKit implements StoreKitPlugin {
  finished: string[] = [];
  purchases: { productId: string; appAccountToken: string }[] = [];
  next: PurchaseOutcome | Error = { status: "purchased", transaction: tx(1) };
  pending: StoreTransaction[] = [];
  listener: ((t: StoreTransaction) => void) | null = null;
  synced = 0;
  async products(o: { ids: string[] }) {
    return { products: PRODUCTS.filter((p) => o.ids.includes(p.id)) };
  }
  async purchase(o: { productId: string; appAccountToken: string }) {
    this.purchases.push(o);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
  async finish(o: { transactionId: string }) {
    this.finished.push(o.transactionId);
    this.pending = this.pending.filter((t) => t.transactionId !== o.transactionId);
    return { finished: true };
  }
  async unfinished() {
    return { transactions: [...this.pending] };
  }
  async sync() {
    this.synced++;
  }
  async canMakePayments() {
    return { allowed: true };
  }
  async addListener(_e: "transaction", cb: (t: StoreTransaction) => void) {
    this.listener = cb;
    return { remove: async () => void (this.listener = null) };
  }
}

/** A fake relay for /billing/purchase/apple: answers by transaction. */
function fakeRelay(answer: (jws: string, n: number) => Response | Promise<Response>) {
  const calls: { url: string; auth: string | null; body: { jws: string } }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { jws: string };
    calls.push({ url, auth: (init.headers as Record<string, string>)["authorization"] ?? null, body });
    return answer(body.jws, calls.length);
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const credited = (credits = 356, balance = 356, replay = false) =>
  new Response(JSON.stringify({ credited_credits: credits, balance_credits: balance, replay }), { status: replay ? 200 : 201 });
const refused = (status: number, error: string) => new Response(JSON.stringify({ error, message: error }), { status });
const tick = () => new Promise((r) => setTimeout(r, 0));

// -- the flow -------------------------------------------------------------------------------

const ios: FlowContext = {
  enabled: true,
  ios: true,
  iap: true,
  consentAsked: false,
  hasSession: false,
  adult: false,
  emailVerified: false,
  emailDeclined: false,
};
const run = (s: FlowState, ...evs: FlowEvent[]): FlowState => evs.reduce(reduce, s);

test("iOS buy: account -> email -> Apple consent (once) -> packs -> the App Store sheet -> success", () => {
  assert.deepEqual(buyPhases(ios), ["account", "email", "consent", "pack", "payment"]);
  let s = run(startFlow("buy", ios), { type: "next" }, { type: "accountReady" }, { type: "skipEmail" }, { type: "confirmAnon" });
  assert.equal(s.step, "appleConsent");
  assert.deepEqual(progress(s), { index: 3, total: 5, phase: "consent" });
  s = reduce(s, { type: "consentAnswered" });
  assert.equal(s.step, "packs");
  assert.equal(s.ctx.consentAsked, true);
  // No Stripe hand-off on iOS.
  s = reduce(s, { type: "selectPack", sku: "dev.splanc.app.credits.small" });
  assert.equal(reduce(s, { type: "continueToPayment" }).step, "packs");
  s = reduce(s, { type: "purchaseStarted" });
  assert.equal(s.step, "purchasing");
  assert.deepEqual(progress(s), { index: 5, total: 5, phase: "payment" });
  assert.equal(reduce(s, { type: "back" }).step, "purchasing", "the App Store sheet owns the outcome");
  s = reduce(s, { type: "purchased", balance: 356 });
  assert.equal(s.step, "returnSuccess");
  assert.equal(s.balance, 356);
  assert.ok(reduce(s, { type: "back" }).exit, "Back after success leaves the flow");
});

test("iOS buy: the consent isn't asked again; a verified e-mail goes on to it", () => {
  const known = { ...ios, hasSession: true, adult: true, emailDeclined: true, consentAsked: true };
  assert.deepEqual(buyPhases(known), ["pack", "payment"]);
  assert.equal(run(startFlow("buy", known), { type: "next" }).step, "packs");
  const s = run(startFlow("buy", { ...ios, hasSession: true, adult: true }), { type: "next" }, { type: "chooseEmail" }, { type: "codeSent", email: "a@b.co" }, { type: "emailVerified" });
  assert.equal(s.step, "appleConsent");
  // The web flow never asks it.
  assert.ok(!buyPhases({ ...ios, ios: false }).includes("consent"));
});

test("iOS buy outcomes: cancelled -> packs, failed -> packs with the reason, pending, paid-not-credited", () => {
  const atPacks = run(startFlow("buy", { ...ios, hasSession: true, adult: true, emailVerified: true, consentAsked: true }), { type: "next" }, { type: "selectPack", sku: "x" });
  const buying = reduce(atPacks, { type: "purchaseStarted" });
  const cancelled = reduce(buying, { type: "purchaseCancelled" });
  assert.equal(cancelled.step, "packs");
  assert.equal(cancelled.error, undefined);
  const failed = reduce(buying, { type: "fail", message: "Can't reach the App Store" });
  assert.equal(failed.step, "packs");
  assert.equal(failed.error, "Can't reach the App Store");
  const pending = reduce(buying, { type: "purchasePending" });
  assert.equal(pending.step, "purchasePending");
  assert.equal(reduce(pending, { type: "balanceArrived", balance: 356 }).step, "returnSuccess", "Ask to Buy approved while open");
  assert.ok(reduce(pending, { type: "done" }).exit);
  const paid = reduce(buying, { type: "paidNotCredited" });
  assert.equal(paid.step, "returnPending");
  assert.equal(run(paid, { type: "checkAgain" }, { type: "balanceArrived", balance: 356 }).step, "returnSuccess");
});

test("the iOS app never reaches the web checkout", async () => {
  assert.equal(purchaseChannel(), "apple");
  assert.equal(mayShowWebCheckout(), false);
  assert.equal(creditsVisible(), true);
  assert.equal(storeKitAvailable(), true);
  await assert.rejects(startWebCheckout("web.credits.10", (async () => new Response("{}")) as unknown as typeof fetch), /App Store/);
});

// -- StoreKit + relay -------------------------------------------------------------------

test("packs: the relay's apple packs that the App Store sells, in the relay's order, with Apple's price", async () => {
  setStoreKitPluginForTests(new FakeStoreKit());
  const packs = await loadIapPacks([
    { sku: "dev.splanc.app.credits.large", credits: 1427 },
    { sku: "dev.splanc.app.credits.medium", credits: 713 }, // not approved in App Store Connect yet
    { sku: "dev.splanc.app.credits.small", credits: 356 },
  ]);
  assert.deepEqual(
    packs.map((p) => [p.sku, p.credits, p.product.displayPrice]),
    [
      ["dev.splanc.app.credits.large", 1427, "$19.99"],
      ["dev.splanc.app.credits.small", 356, "$4.99"],
    ],
  );
  assert.deepEqual(await loadIapPacks([]), []);
});

test("buying: the account's appAccountToken, the signed transaction to the relay, finished after the credit", async () => {
  const sk = new FakeStoreKit();
  setStoreKitPluginForTests(sk);
  const relay = fakeRelay(() => credited());
  const r = await buyCreditPack("dev.splanc.app.credits.small", REF, relay.fn);
  assert.deepEqual(r, { status: "credited", credited: 356, balance: 356 });
  assert.deepEqual(sk.purchases, [{ productId: "dev.splanc.app.credits.small", appAccountToken: REF }]);
  assert.equal(relay.calls[0]!.url, "https://splanc.pages.dev/billing/purchase/apple");
  assert.equal(relay.calls[0]!.auth, "Bearer sess");
  assert.deepEqual(relay.calls[0]!.body, { jws: "jws.1.sig" });
  assert.deepEqual(sk.finished, ["1"]);

  sk.next = { status: "cancelled" };
  assert.deepEqual(await buyCreditPack("dev.splanc.app.credits.small", REF, relay.fn), { status: "cancelled" });
  sk.next = { status: "pending" };
  assert.deepEqual(await buyCreditPack("dev.splanc.app.credits.small", REF, relay.fn), { status: "pending" });
  sk.next = Object.assign(new Error("offline"), { code: "network" });
  await assert.rejects(buyCreditPack("dev.splanc.app.credits.small", REF, relay.fn), (e: unknown) => e instanceof StoreKitError && e.code === "network" && /connection/.test(e.message));
  assert.equal(relay.calls.length, 1, "nothing reached the relay without a purchase");
  // No account ref (an old relay): refused before the sheet opens.
  await assert.rejects(buyCreditPack("dev.splanc.app.credits.small", "", relay.fn), (e: unknown) => e instanceof CreditsApiError && e.code === "no_account_ref");
  assert.equal(sk.purchases.length, 4);
});

test("paid but the relay is down: the transaction stays unfinished and is sent again later", async () => {
  const sk = new FakeStoreKit();
  setStoreKitPluginForTests(sk);
  sk.pending = [tx(1)];
  await assert.rejects(buyCreditPack("dev.splanc.app.credits.small", REF, fakeRelay(() => refused(500, "billing_error")).fn), CreditsApiError);
  assert.deepEqual(sk.finished, []);
  // Next start / "Check for App Store purchases": credited now, finished.
  const again = await checkForPurchases(fakeRelay(() => credited()).fn);
  assert.equal(sk.synced, 1);
  assert.deepEqual(again, { credited: 356, balance: 356, failed: 0 });
  assert.deepEqual(sk.finished, ["1"]);
});

test("finishing rules", async () => {
  const cases: [Response, boolean][] = [
    [credited(), true],
    [credited(356, 356, true), true], // replay: the relay already had it
    [refused(409, "already_claimed"), true], // another account got it: nothing owed here
    [refused(400, "revoked"), true], // refunded already
    [refused(401, "unauthorized"), false], // signed out: keep for after the restore
    [refused(403, "wrong_account"), false], // bought for another account: keep
    [refused(503, "not_configured"), false],
  ];
  let n = 100;
  for (const [answer, finishes] of cases) {
    const sk = new FakeStoreKit();
    setStoreKitPluginForTests(sk);
    const t = tx(++n);
    const res = deliverTransaction(t, fakeRelay(() => answer.clone()).fn);
    if (finishes) await res;
    else await assert.rejects(res);
    assert.deepEqual(sk.finished, finishes ? [t.transactionId] : [], `${answer.status}`);
  }
  // The relay unreachable at all: kept.
  const sk = new FakeStoreKit();
  setStoreKitPluginForTests(sk);
  await assert.rejects(deliverTransaction(tx(999), (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch), (e: unknown) => e instanceof CreditsApiError && e.code === "network");
  assert.deepEqual(sk.finished, []);
});

test("background delivery: unfinished at start + Transaction.updates, once each, announced once", async () => {
  const sk = new FakeStoreKit();
  setStoreKitPluginForTests(sk);
  sk.pending = [tx(7)];
  let slow: (() => void) | null = null;
  const relay = fakeRelay((jws) =>
    jws === "jws.8.sig" ? new Promise<Response>((r) => (slow = () => r(credited(713, 1069)))) : credited(),
  );
  const seen: number[] = [];
  const toast: number[] = [];
  const off = onIapCredited((r) => seen.push(r.credited));
  assert.equal(startIapDelivery((r) => toast.push(r.credited), relay.fn), true);
  assert.equal(startIapDelivery(undefined, relay.fn), false, "idempotent");
  await tick();
  await tick();
  assert.deepEqual(sk.finished, ["7"]);
  // Ask to Buy approved: the update arrives (twice, as StoreKit may), credited once.
  sk.listener!(tx(8, "dev.splanc.app.credits.medium"));
  sk.listener!(tx(8, "dev.splanc.app.credits.medium"));
  await tick();
  assert.equal(relay.calls.filter((c) => c.body.jws === "jws.8.sig").length, 1, "in-flight de-duplicated");
  slow!();
  await tick();
  await tick();
  assert.deepEqual(sk.finished, ["7", "8"]);
  assert.deepEqual(seen, [356, 713]);
  assert.deepEqual(toast, [356, 713]);
  off();
});

test("background delivery waits for an account, and is off without the flag or StoreKit", async () => {
  const sk = new FakeStoreKit();
  setStoreKitPluginForTests(sk);
  setCreditsSession(null);
  sk.pending = [tx(3)];
  const relay = fakeRelay(() => credited());
  assert.equal(startIapDelivery(undefined, relay.fn), true);
  sk.listener!(tx(4));
  await tick();
  assert.equal(relay.calls.length, 0, "no account: kept unfinished");
  assert.deepEqual(sk.finished, []);
  // Later, with an account, the unfinished one is delivered by deliverUnfinished.
  setCreditsSession({ account_id: "acct_aaaaaaaaaaaaaaaaaaaa", token: "sess" });
  assert.deepEqual(await deliverUnfinished(relay.fn), { credited: 356, balance: 356, failed: 0 });

  resetIapForTests();
  g.localStorage.setItem("splanc.flags.aiCredits", "0");
  assert.equal(startIapDelivery(undefined, relay.fn), false);
  g.localStorage.setItem("splanc.flags.aiCredits", "1");
  setStoreKitPluginForTests(null);
  g.Capacitor = { isNativePlatform: () => true, getPlatform: () => "ios" };
  assert.equal(startIapDelivery(undefined, relay.fn), false, "an old build without the plugin");
});
