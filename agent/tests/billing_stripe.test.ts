/**
 * Stripe web checkout for Splanc AI credits (docs/design/ai-billing.md §Web
 * checkout), offline: a fake api.stripe.com, and webhook events signed the way
 * Stripe signs them (`Stripe-Signature: t=…,v1=HMAC-SHA256(t.body)`).
 *
 * - form encoding and the Checkout Session parameters;
 * - signature verification: good, tampered, wrong secret, stale, rotated;
 * - POST /billing/checkout: 18+ required, unknown / unpriced packs, the
 *   request to Stripe (our test key, the pack's price, the account ref,
 *   automatic tax, return URLs);
 * - the webhook: credit once per session (event replays, completed +
 *   async_succeeded), unpaid sessions wait, partial + full refunds, disputes,
 *   unknown payment intents, wrong account, live events in the sandbox;
 * - a live key in sandbox mode turns the feature off;
 * - no Stripe secret in any response or log.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BillingAccount } from "../relay/src/billing/account";
import { billingEndpoint, billingReady, safeReturnUrl, type BillingContext } from "../relay/src/billing/endpoint";
import { Ledger, lotConsumption } from "../relay/src/billing/ledger";
import { DEFAULT_PRICING, MICRO, validatePricing, type PricingConfig } from "../relay/src/billing/pricing";
import { accountRefFor } from "../relay/src/billing/purchases";
import { checkoutSessionParams, stripeAction, stripeForm, stripeSignatureHeader, verifyStripeSignature } from "../relay/src/billing/stripe";
import { Directory } from "../relay/src/directory";
import type { Env } from "../relay/src/platform";
import { MemStorage, namespace } from "./billingFakes";
import sandboxPricing from "../relay/billing.sandbox.pricing.json";

const SK = "sk_test_51CANARYcanaryCANARYcanary0123456789";
const WHSEC = "whsec_CANARYwebhookSECRET0123456789abcdef";
const SECRET = "dGVzdC1zZXNzaW9uLXNlY3JldC0zMi1ieXRlcy1sb25nISE";
const NOW_S = 1_800_000_000;

function pricing(): PricingConfig {
  const p = structuredClone(DEFAULT_PRICING);
  for (const pk of p.packs) if (pk.channel === "web") pk.stripe_price_id = pk.sku === "web.credits.10" ? "price_TEST10aaaaaaaa" : undefined;
  return p;
}

async function stripeEnv(patch: Partial<Env> = {}): Promise<Env> {
  const env = {} as Env;
  Object.assign(env, {
    AI_BILLING: "sandbox",
    AI_PRICING: JSON.stringify(pricing()),
    ANTHROPIC_API_KEY: "sk-ant-api03-relaykeyrelaykeyrelaykey00",
    BILLING_TOKEN_SECRET: SECRET,
    STRIPE_SECRET_KEY: SK,
    STRIPE_WEBHOOK_SECRET: WHSEC,
    BILLING: namespace((s) => new BillingAccount(s, env)),
    DIRECTORY: namespace((s) => new Directory(s, env)),
    BRIDGE: namespace(() => ({ fetch: async () => new Response("no", { status: 404 }) })),
    HOST: { upgrade: () => { throw new Error("no"); }, autoResponse: () => undefined, now: () => NOW_S * 1000 },
    ...patch,
  });
  return env;
}

interface StripeCall {
  url: string;
  headers: Record<string, string>;
  form: URLSearchParams;
}

function fakeStripe(reply?: (c: StripeCall) => Response) {
  const calls: StripeCall[] = [];
  let n = 0;
  const fn = (async (url: string, init: RequestInit) => {
    const c = { url, headers: init.headers as Record<string, string>, form: new URLSearchParams(String(init.body)) };
    calls.push(c);
    if (reply) return reply(c);
    const id = `cs_test_${String(++n).padStart(10, "0")}`;
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function ctxFor(logs: string[], stripeFetch?: typeof fetch): BillingContext {
  return {
    json: (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } }),
    clientIp: "198.51.100.9",
    upstream: async () => new Response("unused", { status: 500 }),
    log: (e) => logs.push(JSON.stringify(e)),
    stripeFetch,
  };
}

const call = async (env: Env, ctx: BillingContext, path: string, init: RequestInit = {}) => {
  const r = await billingEndpoint(new Request(`https://relay${path}`, init), env, ctx, new URL(`https://relay${path}`).pathname);
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
};

/** A Stripe event, signed for the relay's webhook. */
async function signed(event: Record<string, unknown>, opts: { secret?: string; t?: number } = {}) {
  const body = JSON.stringify({ object: "event", api_version: "2026-06-24.dahlia", livemode: false, ...event });
  return { body, sig: await stripeSignatureHeader(opts.secret ?? WHSEC, body, opts.t ?? NOW_S) };
}

const completed = (id: string, session: Record<string, unknown>, type = "checkout.session.completed") =>
  signed({ id, type, data: { object: { object: "checkout.session", payment_status: "paid", created: NOW_S, ...session } } });

const hook = (env: Env, ctx: BillingContext, s: { body: string; sig: string }) =>
  call(env, ctx, "/billing/notify/web", { method: "POST", headers: { "stripe-signature": s.sig }, body: s.body });

async function adultAccount(env: Env, ctx: BillingContext) {
  const made = await call(env, ctx, "/billing/account", { method: "POST" });
  const auth = { authorization: `Bearer ${String(made.body["token"])}` };
  await call(env, ctx, "/billing/age", { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) });
  const id = String(made.body["account_id"]);
  return { id, auth, ref: await accountRefFor(id) };
}

const balance = async (env: Env, ctx: BillingContext, auth: Record<string, string>) =>
  Number((await call(env, ctx, "/billing/balance", { headers: auth })).body["balance_credits"]);

// -- pure pieces -----------------------------------------------------------------------

describe("stripe pieces", () => {
  test("form encoding: nested objects and arrays", () => {
    assert.equal(stripeForm({ a: 1, line_items: [{ price: "p", quantity: 1 }], m: { k: "v w" }, skip: undefined }), "a=1&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1&m%5Bk%5D=v%20w");
  });

  test("checkout session parameters", () => {
    const pk = { ...pricing().packs.find((p) => p.sku === "web.credits.10")!, stripe_price_id: "price_TEST10aaaaaaaa" };
    const p = checkoutSessionParams({ pack: pk, accountId: "acct_x", accountRef: "ref-uuid", returnUrl: "https://splanc.io/app/#/settings/ai" });
    assert.equal(p["mode"], "payment");
    assert.deepEqual(p["line_items"], [{ price: "price_TEST10aaaaaaaa", quantity: 1 }]);
    assert.equal(p["client_reference_id"], "ref-uuid");
    assert.deepEqual(p["automatic_tax"], { enabled: true });
    assert.deepEqual((p["payment_intent_data"] as { metadata: unknown }).metadata, { account_id: "acct_x", sku: "web.credits.10", channel: "web" });
    // The account is shared with another business: Splanc charges say so on the statement.
    assert.equal((p["payment_intent_data"] as { statement_descriptor_suffix: unknown }).statement_descriptor_suffix, "SPLANC");
    assert.equal(p["success_url"], "https://splanc.io/app/?checkout=success&session_id={CHECKOUT_SESSION_ID}#/settings/ai");
    assert.equal(p["cancel_url"], "https://splanc.io/app/?checkout=cancel#/settings/ai");
    assert.equal(p["payment_method_types"], undefined, "dynamic payment methods: cards, Apple Pay, Google Pay from the Dashboard");
  });

  test("signature verification", async () => {
    const body = '{"id":"evt_1"}';
    const h = await stripeSignatureHeader(WHSEC, body, NOW_S);
    assert.deepEqual(await verifyStripeSignature(WHSEC, h, body, NOW_S + 10), { ok: true });
    assert.equal((await verifyStripeSignature(WHSEC, h, body + " ", NOW_S)).ok, false);
    assert.equal((await verifyStripeSignature("whsec_other", h, body, NOW_S)).ok, false);
    assert.equal((await verifyStripeSignature(WHSEC, h, body, NOW_S + 301)).ok, false);
    assert.equal((await verifyStripeSignature(WHSEC, null, body, NOW_S)).ok, false);
    assert.equal((await verifyStripeSignature(WHSEC, "garbage", body, NOW_S)).ok, false);
    // During a secret roll Stripe sends one v1 per secret.
    const old = await stripeSignatureHeader("whsec_old", body, NOW_S);
    assert.equal((await verifyStripeSignature(WHSEC, `${h},v1=${old.split("v1=")[1]}`, body, NOW_S)).ok, true);
  });

  test("event mapping", () => {
    const ev = (type: string, object: Record<string, unknown>, livemode = false) => JSON.stringify({ id: "evt_x", type, livemode, data: { object } });
    assert.equal(stripeAction(ev("checkout.session.completed", { payment_status: "unpaid", id: "cs_1" })).kind, "ignore");
    assert.equal(stripeAction(ev("customer.created", {})).kind, "ignore");
    const p = stripeAction(ev("checkout.session.completed", { payment_status: "paid", id: "cs_1", client_reference_id: "r", payment_intent: "pi_1", metadata: { account_id: "acct_a", sku: "web.credits.10" } }, true));
    assert.ok(p.kind === "purchase" && p.purchase.environment === "production" && p.paymentIntent === "pi_1");
    const r = stripeAction(ev("charge.refunded", { payment_intent: "pi_1", amount: 1000, amount_refunded: 400 }));
    assert.ok(r.kind === "refund" && r.fraction === 0.4 && r.reason === "refund");
    const d = stripeAction(ev("charge.dispute.created", { payment_intent: "pi_1", amount: 1000 }));
    assert.ok(d.kind === "refund" && d.fraction === 1 && d.reason === "chargeback");
  });

  test("return URLs: the app or local dev only", () => {
    assert.equal(safeReturnUrl("https://splanc.io/app/#/settings/ai", undefined), "https://splanc.io/app/#/settings/ai");
    assert.equal(safeReturnUrl("http://localhost:5173/#/settings/ai", undefined), "http://localhost:5173/#/settings/ai");
    assert.equal(safeReturnUrl("https://evil.example/phish", undefined), "https://splanc.io/app/#/settings/ai");
    assert.equal(safeReturnUrl(42, "https://splanc.io/app/"), "https://splanc.io/app/");
  });

  test("pricing: stripe_price_id is web-only and price_-shaped", () => {
    const p = pricing();
    assert.equal(validatePricing(p).ok, true);
    p.packs.find((x) => x.channel === "apple")!.stripe_price_id = "price_TEST10aaaaaaaa";
    assert.equal(validatePricing(p).ok, false);
    const q = pricing();
    q.packs.find((x) => x.sku === "web.credits.10")!.stripe_price_id = "prod_nope";
    assert.equal(validatePricing(q).ok, false);
  });

  test("the committed sandbox pricing file validates (price ids are added at deploy)", () => {
    const v = validatePricing(sandboxPricing);
    assert.equal(v.ok, true, v.ok ? "" : v.errors.join("\n"));
    const withIds = structuredClone(sandboxPricing) as unknown as PricingConfig;
    for (const p of withIds.packs) if (p.channel === "web") p.stripe_price_id = "price_1TESTtesttesttest";
    assert.equal(validatePricing(withIds).ok, true);
  });

  test("partial then full refunds claw back proportionally, once", async () => {
    const l = new Ledger(new MemStorage());
    await l.open("acct_t", 0);
    await l.credit("purchase", "web:cs_1", 833 * MICRO);
    assert.equal((await l.clawbackFraction("web:cs_1", 0.4)).entry!.amount, -Math.round(833 * MICRO * 0.4));
    assert.equal((await l.clawbackFraction("web:cs_1", 0.4)).replay, true);
    const full = await l.clawbackFraction("web:cs_1", 1);
    assert.equal(full.entry!.amount, -(833 * MICRO - Math.round(833 * MICRO * 0.4)));
    assert.equal((await l.clawback("web:cs_1")).replay, true);
    assert.equal((await l.getAccount())!.balance, 0);
    assert.equal(lotConsumption(await l.statement(), "web:cs_1")!.refunded, true);
  });
});

// -- the relay routes ------------------------------------------------------------------

describe("checkout + webhook", () => {
  test("a live key in sandbox mode turns billing off", async () => {
    const env = await stripeEnv({ STRIPE_SECRET_KEY: "sk_live_51realrealrealreal" });
    assert.deepEqual(billingReady(env), { off: "live_stripe_key_in_sandbox" });
    assert.equal((await call(env, ctxFor([]), "/billing/pricing")).status, 503);
  });

  test("POST /billing/checkout: 18+, packs, the Stripe request", async () => {
    const env = await stripeEnv();
    const logs: string[] = [];
    const stripe = fakeStripe();
    const ctx = ctxFor(logs, stripe.fn);
    const made = await call(env, ctx, "/billing/account", { method: "POST" });
    const auth = { authorization: `Bearer ${String(made.body["token"])}` };
    const buy = (sku: string, extra: Record<string, unknown> = {}) =>
      call(env, ctx, "/billing/checkout", { method: "POST", headers: auth, body: JSON.stringify({ sku, ...extra }) });

    assert.equal((await call(env, ctx, "/billing/checkout", { method: "POST", body: "{}" })).status, 401);
    const minor = await buy("web.credits.10");
    assert.equal(minor.status, 403);
    assert.equal(minor.body["error"], "age_required");
    assert.equal(stripe.calls.length, 0);

    await call(env, ctx, "/billing/age", { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) });
    assert.equal((await buy("dev.splanc.app.credits.small")).status, 400, "an Apple pack is not sold on the web");
    assert.equal((await buy("web.credits.25")).status, 503, "no Stripe price configured yet");
    const ok = await buy("web.credits.10", { return_url: "https://splanc.io/app/#/settings/ai" });
    assert.equal(ok.status, 201);
    assert.match(String(ok.body["url"]), /^https:\/\/checkout\.stripe\.com\//);

    const c = stripe.calls.at(-1)!;
    assert.equal(c.url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(c.headers["authorization"], `Bearer ${SK}`);
    assert.equal(c.headers["stripe-version"], "2026-06-24.dahlia");
    assert.equal(c.form.get("line_items[0][price]"), "price_TEST10aaaaaaaa");
    assert.equal(c.form.get("client_reference_id"), await accountRefFor(String(made.body["account_id"])));
    assert.equal(c.form.get("automatic_tax[enabled]"), "true");
    assert.equal(c.form.get("metadata[account_id]"), String(made.body["account_id"]));
    assert.ok(c.form.get("success_url")!.includes("{CHECKOUT_SESSION_ID}"));
    for (const l of logs) assert.ok(!l.includes(SK) && !l.includes(WHSEC), l);
  });

  test("Stripe failures are a 503 without Stripe's message, and alert", async () => {
    const env = await stripeEnv();
    const logs: string[] = [];
    const stripe = fakeStripe(() => new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing", message: `No such price; key ${SK}` } }), { status: 400 }));
    const ctx = ctxFor(logs, stripe.fn);
    const { auth } = await adultAccount(env, ctx);
    const r = await call(env, ctx, "/billing/checkout", { method: "POST", headers: auth, body: JSON.stringify({ sku: "web.credits.10" }) });
    assert.equal(r.status, 503);
    assert.ok(!r.text.includes(SK) && !r.text.includes("No such price"));
    assert.ok(logs.some((l) => l.includes('"ai_checkout_failed"') && l.includes("resource_missing")));
    for (const l of logs) assert.ok(!l.includes(SK), l);
  });

  test("webhook: credit once per session; refunds and disputes claw back", async () => {
    const env = await stripeEnv();
    const logs: string[] = [];
    const ctx = ctxFor(logs, fakeStripe().fn);
    const a = await adultAccount(env, ctx);
    const session = { id: "cs_test_A", client_reference_id: a.ref, payment_intent: "pi_A", metadata: { account_id: a.id, sku: "web.credits.10", channel: "web" } };

    // Bad signatures never credit.
    const forged = await completed("evt_forged", session);
    assert.equal((await hook(env, ctx, { body: forged.body, sig: await stripeSignatureHeader("whsec_wrong", forged.body, NOW_S) })).status, 400);
    assert.equal((await hook(env, ctx, { body: forged.body, sig: await stripeSignatureHeader(WHSEC, forged.body, NOW_S - 3600) })).status, 400);
    assert.equal(await balance(env, ctx, a.auth), 0);

    // An unpaid session waits for async_payment_succeeded.
    assert.equal((await hook(env, ctx, await completed("evt_unpaid", { ...session, payment_status: "unpaid" }))).status, 200);
    assert.equal(await balance(env, ctx, a.auth), 0);

    const ev = await completed("evt_paid", session);
    assert.equal((await hook(env, ctx, ev)).status, 200);
    assert.equal(await balance(env, ctx, a.auth), 833);
    // Stripe retries the same event; and async_payment_succeeded for the same session.
    assert.equal((await hook(env, ctx, ev)).body["replay"], true);
    assert.equal((await hook(env, ctx, await completed("evt_async", session, "checkout.session.async_payment_succeeded"))).status, 200);
    assert.equal(await balance(env, ctx, a.auth), 833);

    // A 40 % refund, then the rest.
    const refund = (id: string, refunded: number) =>
      signed({ id, type: "charge.refunded", data: { object: { object: "charge", payment_intent: "pi_A", amount: 1000, amount_refunded: refunded } } });
    await hook(env, ctx, await refund("evt_r1", 400));
    assert.ok(Math.abs((await balance(env, ctx, a.auth)) - (833 - 333.2)) < 1e-9);
    await hook(env, ctx, await refund("evt_r2", 1000));
    assert.equal(await balance(env, ctx, a.auth), 0);

    // A second purchase, then a dispute: all of it comes back, flagged chargeback.
    const s2 = { ...session, id: "cs_test_B", payment_intent: "pi_B" };
    await hook(env, ctx, await completed("evt_paid2", s2));
    assert.equal(await balance(env, ctx, a.auth), 833);
    await hook(env, ctx, await signed({ id: "evt_d1", type: "charge.dispute.created", data: { object: { object: "dispute", payment_intent: "pi_B", amount: 1000 } } }));
    assert.equal(await balance(env, ctx, a.auth), 0);
    assert.ok(logs.some((l) => l.includes('"ai_refund"') && l.includes('"chargeback"')));

    // A refund for a payment we never credited (the shared account's other business)
    // is acknowledged and ignored, and is not an ai_refund (the refund-spike alert).
    const before = logs.filter((l) => l.includes('"ai_refund"')).length;
    assert.equal((await hook(env, ctx, await signed({ id: "evt_r9", type: "charge.refunded", data: { object: { payment_intent: "pi_other", amount: 500, amount_refunded: 500 } } }))).status, 200);
    assert.equal((await hook(env, ctx, await signed({ id: "evt_d9", type: "charge.dispute.created", data: { object: { payment_intent: "pi_other", amount: 500 } } }))).status, 200);
    assert.equal(logs.filter((l) => l.includes('"ai_refund"')).length, before);
    assert.equal(logs.filter((l) => l.includes('"stripe_event_ignored"')).length >= 2, true);
    // Its checkouts (no Splanc metadata) are ignored the same way, crediting nothing.
    const other = { id: "cs_other", payment_intent: "pi_other2", client_reference_id: null, metadata: {} };
    assert.equal((await hook(env, ctx, await completed("evt_other", other))).status, 200);
    assert.ok(logs.some((l) => l.includes('"stripe_event_ignored"') && l.includes("not a Splanc credits session")));
    for (const l of logs) assert.ok(!l.includes(SK) && !l.includes(WHSEC), l);
  });

  test("webhook: a session for another account, or a live event, is refused (200 + alert, no credit)", async () => {
    const env = await stripeEnv();
    const logs: string[] = [];
    const ctx = ctxFor(logs, fakeStripe().fn);
    const a = await adultAccount(env, ctx);
    const b = await adultAccount(env, ctx);
    // Session metadata names A, but the client_reference_id is B's: not credited.
    const mixed = { id: "cs_test_M", client_reference_id: b.ref, payment_intent: "pi_M", metadata: { account_id: a.id, sku: "web.credits.10" } };
    assert.equal((await hook(env, ctx, await completed("evt_mixed", mixed))).status, 200);
    assert.equal(await balance(env, ctx, a.auth), 0);
    assert.ok(logs.some((l) => l.includes('"ai_purchase_rejected"') && l.includes("wrong_account") && l.includes('"alert":true')));
    // A live-mode event can't credit a sandbox relay.
    const live = await signed({ id: "evt_live", type: "checkout.session.completed", livemode: true, data: { object: { payment_status: "paid", id: "cs_live_1", client_reference_id: a.ref, metadata: { account_id: a.id, sku: "web.credits.10" } } } });
    assert.equal((await hook(env, ctx, live)).status, 200);
    assert.equal(await balance(env, ctx, a.auth), 0);
    assert.ok(logs.some((l) => l.includes("wrong_environment")));
  });

  test("with Stripe configured the fake web purchase route is closed", async () => {
    const env = await stripeEnv({ AI_BILLING_FAKE_STORE_KEY: "fake-store-test-key" });
    const ctx = ctxFor([]);
    const { auth } = await adultAccount(env, ctx);
    assert.equal((await call(env, ctx, "/billing/purchase/web", { method: "POST", headers: auth, body: "{}" })).status, 404);
  });
});
