/**
 * Splanc AI credits: the billing MODE (AI_BILLING=sandbox|production,
 * docs/ops/billing-go-live.md), offline. One relay, one set of Durable
 * Objects, switched between modes the way the go-live switches it:
 *
 * - which Stripe keys each mode accepts (secret and restricted, test and
 *   live), and what production additionally requires;
 * - production never uses the fake store, even with its key set;
 * - a live-mode event credits / claws back only in production, a test-mode
 *   event only in the sandbox;
 * - sessions are per mode: a sandbox token (test-money credits) opens
 *   nothing in production, and the other way round;
 * - accounts are tagged with their mode, the liability counter is per mode,
 *   and /billing/pricing says which mode the relay is in.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BillingAccount, DoLedger } from "../relay/src/billing/account";
import { billingEndpoint, billingMode, billingReady, stripeKeyMode, type BillingContext } from "../relay/src/billing/endpoint";
import { DEFAULT_PRICING, type PricingConfig } from "../relay/src/billing/pricing";
import { accountRefFor } from "../relay/src/billing/purchases";
import { stripeSignatureHeader } from "../relay/src/billing/stripe";
import { Directory } from "../relay/src/directory";
import type { Env } from "../relay/src/platform";
import { namespace } from "./billingFakes";

const TEST = { STRIPE_SECRET_KEY: "sk_test_51CANARYcanaryCANARYcanary0123456789", STRIPE_WEBHOOK_SECRET: "whsec_CANARYtestWEBHOOKsecret0123456789ab" };
// Built at runtime so secret scanners don't mistake the canary for a real key.
const LIVE = { STRIPE_SECRET_KEY: ["sk", "live", "51CANARYcanaryCANARYcanary0123456789"].join("_"), STRIPE_WEBHOOK_SECRET: "whsec_CANARYliveWEBHOOKsecret0123456789ab" };
const SECRET = "dGVzdC1zZXNzaW9uLXNlY3JldC0zMi1ieXRlcy1sb25nISE";
const ADMIN = "admin-test-token-0001";
const NOW_S = 1_800_000_000;

/** Env fields to set, or to remove (undefined). */
type Patch = { [K in keyof Env]?: Env[K] | undefined };

function pricing(): PricingConfig {
  const p = structuredClone(DEFAULT_PRICING);
  for (const pk of p.packs) if (pk.channel === "web") pk.stripe_price_id = pk.sku === "web.credits.10" ? "price_TEN0aaaaaaaaaa" : undefined;
  return p;
}

/** A relay in `mode`; `patch` changes it (and can be re-applied to switch modes). */
async function relayEnv(mode: "sandbox" | "production", patch: Patch = {}): Promise<Env> {
  const env = {} as Env;
  Object.assign(env, {
    AI_BILLING: mode,
    AI_PRICING: JSON.stringify(pricing()),
    ANTHROPIC_API_KEY: "sk-ant-api03-relaykeyrelaykeyrelaykey00",
    BILLING_TOKEN_SECRET: SECRET,
    BILLING_ADMIN_TOKEN: ADMIN,
    ...(mode === "production" ? LIVE : TEST),
    BILLING: namespace((s) => new BillingAccount(s, env)),
    DIRECTORY: namespace((s) => new Directory(s, env)),
    BRIDGE: namespace(() => ({ fetch: async () => new Response("no", { status: 404 }) })),
    HOST: { upgrade: () => { throw new Error("no"); }, autoResponse: () => undefined, now: () => NOW_S * 1000 },
    ...patch,
  });
  return env;
}

/** Switch a relay's mode in place (same Durable Objects), like `--apply` / `--rollback`. */
function switchTo(env: Env, mode: "sandbox" | "production") {
  Object.assign(env, { AI_BILLING: mode, ...(mode === "production" ? LIVE : TEST) });
}

function ctxFor(logs: string[] = []): BillingContext {
  return {
    json: (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } }),
    clientIp: "198.51.100.9",
    upstream: async () => new Response("unused", { status: 500 }),
    log: (e) => logs.push(JSON.stringify(e)),
    stripeFetch: (async () => new Response(JSON.stringify({ id: "cs_x", url: "https://checkout.stripe.com/c/pay/cs_x" }), { status: 200 })) as unknown as typeof fetch,
  };
}

const call = async (env: Env, ctx: BillingContext, path: string, init: RequestInit = {}) => {
  const r = await billingEndpoint(new Request(`https://relay${path}`, init), env, ctx, new URL(`https://relay${path}`).pathname);
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
};

async function account(env: Env, ctx: BillingContext) {
  const made = await call(env, ctx, "/billing/account", { method: "POST" });
  assert.equal(made.status, 201);
  const auth = { authorization: `Bearer ${String(made.body["token"])}` };
  assert.equal((await call(env, ctx, "/billing/age", { method: "POST", headers: auth, body: JSON.stringify({ confirm: true }) })).status, 200);
  const id = String(made.body["account_id"]);
  return { id, auth, ref: await accountRefFor(id) };
}

/** A Stripe event signed with the CURRENT mode's webhook secret. */
async function hook(env: Env, ctx: BillingContext, event: Record<string, unknown>) {
  const body = JSON.stringify({ object: "event", api_version: "2026-06-24.dahlia", ...event });
  const sig = await stripeSignatureHeader(env.STRIPE_WEBHOOK_SECRET!, body, NOW_S);
  return call(env, ctx, "/billing/notify/web", { method: "POST", headers: { "stripe-signature": sig }, body });
}

const paid = (id: string, livemode: boolean, a: { id: string; ref: string }, pi: string) => ({
  id,
  type: "checkout.session.completed",
  livemode,
  data: { object: { object: "checkout.session", id: `cs_${id}`, payment_status: "paid", created: NOW_S, client_reference_id: a.ref, payment_intent: pi, metadata: { account_id: a.id, sku: "web.credits.10", channel: "web" } } },
});
const refunded = (id: string, livemode: boolean, pi: string) => ({ id, type: "charge.refunded", livemode, data: { object: { object: "charge", payment_intent: pi, amount: 1000, amount_refunded: 1000 } } });

const balance = async (env: Env, ctx: BillingContext, auth: Record<string, string>) => {
  const r = await call(env, ctx, "/billing/balance", { headers: auth });
  return r.status === 200 ? Number(r.body["balance_credits"]) : r.status;
};

describe("billing mode selection", () => {
  test("AI_BILLING and Stripe key prefixes", () => {
    assert.equal(billingMode({ AI_BILLING: "sandbox" }), "sandbox");
    assert.equal(billingMode({ AI_BILLING: "production" }), "production");
    for (const v of [undefined, "", "live", "Production", "sandbox ", "1"]) assert.equal(billingMode({ AI_BILLING: v }), null, String(v));
    assert.equal(stripeKeyMode("sk_test_abc"), "sandbox");
    assert.equal(stripeKeyMode("rk_test_abc"), "sandbox");
    assert.equal(stripeKeyMode("sk_live_abc"), "production");
    assert.equal(stripeKeyMode("rk_live_abc"), "production");
    for (const k of ["pk_live_abc", "pk_test_abc", "whsec_abc", "sk_abc", ""]) assert.equal(stripeKeyMode(k), null, k);
  });

  test("sandbox: test keys only (secret or restricted); the fake store allowed", async () => {
    for (const k of ["sk_test_x", "rk_test_x"]) {
      const r = billingReady(await relayEnv("sandbox", { STRIPE_SECRET_KEY: k, AI_BILLING_FAKE_STORE_KEY: "fake-key" }));
      assert.ok(!("off" in r) && r.environment === "sandbox" && r.stripe?.secretKey === k && r.storeKey === "fake-key", k);
    }
    for (const k of ["sk_live_x", "rk_live_x", "garbage"]) assert.deepEqual(billingReady(await relayEnv("sandbox", { STRIPE_SECRET_KEY: k })), { off: "live_stripe_key_in_sandbox" }, k);
    // Stripe stays optional in the sandbox (the fake web store covers it).
    const bare = billingReady(await relayEnv("sandbox", { STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined }));
    assert.ok(!("off" in bare) && bare.stripe === null);
  });

  test("production: live keys, a webhook secret and the admin token required; never the fake store", async () => {
    for (const k of ["sk_live_x", "rk_live_x"]) {
      const r = billingReady(await relayEnv("production", { STRIPE_SECRET_KEY: k, AI_BILLING_FAKE_STORE_KEY: "fake-key" }));
      assert.ok(!("off" in r), k);
      assert.equal(r.environment, "production");
      assert.equal(r.stripe?.secretKey, k);
      assert.equal(r.storeKey, null, "the fake store can mint credits: never in production");
    }
    const cases: [Patch, string][] = [
      [{ STRIPE_SECRET_KEY: "sk_test_x" }, "test_stripe_key_in_production"],
      [{ STRIPE_SECRET_KEY: "rk_test_x" }, "test_stripe_key_in_production"],
      [{ STRIPE_SECRET_KEY: "whsec_x" }, "test_stripe_key_in_production"],
      [{ STRIPE_SECRET_KEY: undefined }, "incomplete"],
      [{ STRIPE_WEBHOOK_SECRET: undefined }, "incomplete"],
      [{ BILLING_ADMIN_TOKEN: undefined }, "incomplete"],
      [{ ANTHROPIC_API_KEY: undefined }, "incomplete"],
      [{ AI_PRICING: undefined }, "bad_pricing"],
    ];
    const ctx = ctxFor();
    for (const [patch, off] of cases) {
      const env = await relayEnv("production", patch);
      const r = billingReady(env);
      assert.ok("off" in r && r.off === off, `${JSON.stringify(Object.keys(patch))}: ${JSON.stringify(r)}`);
      for (const p of ["/billing/pricing", "/billing/account", "/ai/v1/messages", "/billing/notify/web"]) {
        assert.equal((await call(env, ctx, p, { method: p === "/billing/pricing" ? "GET" : "POST" })).status, 503, p);
      }
    }
  });

  test("/billing/pricing names the mode", async () => {
    for (const mode of ["sandbox", "production"] as const) {
      const r = await call(await relayEnv(mode), ctxFor(), "/billing/pricing?channel=web");
      assert.equal(r.status, 200);
      assert.equal(r.body["environment"], mode);
    }
  });
});

describe("production relay", () => {
  test("live events credit and claw back; test-mode events don't", async () => {
    const env = await relayEnv("production");
    const logs: string[] = [];
    const ctx = ctxFor(logs);
    const a = await account(env, ctx);
    assert.equal(await balance(env, ctx, a.auth), 0);

    // A test-mode purchase (even correctly signed) can't credit a production relay.
    assert.equal((await hook(env, ctx, paid("evt_t1", false, a, "pi_t1"))).status, 200);
    assert.equal(await balance(env, ctx, a.auth), 0);
    assert.ok(logs.some((l) => l.includes('"ai_purchase_rejected"') && l.includes("wrong_environment") && l.includes('"alert":true')));

    // A live purchase does.
    assert.equal((await hook(env, ctx, paid("evt_l1", true, a, "pi_l1"))).status, 200);
    const credited = await balance(env, ctx, a.auth);
    assert.ok(typeof credited === "number" && credited > 0, String(credited));

    // A test-mode refund naming the live payment intent is ignored...
    logs.length = 0;
    assert.equal((await hook(env, ctx, refunded("evt_t2", false, "pi_l1"))).status, 200);
    assert.equal(await balance(env, ctx, a.auth), credited);
    assert.ok(logs.some((l) => l.includes('"ai_purchase_rejected"') && l.includes("wrong_environment")));
    // ...a live one claws back.
    assert.equal((await hook(env, ctx, refunded("evt_l2", true, "pi_l1"))).status, 200);
    assert.equal(await balance(env, ctx, a.auth), 0);
    assert.ok(logs.some((l) => l.includes('"ai_refund"') && l.includes('"matched":true')));
  });

  test("the fake store routes are closed, even with its key set", async () => {
    const env = await relayEnv("production", { AI_BILLING_FAKE_STORE_KEY: "fake-store-test-key" });
    const ctx = ctxFor();
    const a = await account(env, ctx);
    assert.equal((await call(env, ctx, "/billing/purchase/web", { method: "POST", headers: a.auth, body: "{}" })).status, 404);
    // Apple's route is the real StoreKit 2 verifier (#587): it takes only a signed
    // transaction ({jws}), never a fake-store receipt.
    const apple = await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: a.auth, body: JSON.stringify({ payload: "{}", sig: "x" }) });
    assert.equal(apple.status, 400);
    assert.equal(apple.body["error"], "bad_receipt");
    assert.equal((await call(env, ctx, "/billing/notify/apple", { method: "POST", body: "{}" })).status, 503);
  });

  test("checkout works with the live key", async () => {
    const env = await relayEnv("production");
    const ctx = ctxFor();
    const a = await account(env, ctx);
    const r = await call(env, ctx, "/billing/checkout", { method: "POST", headers: a.auth, body: JSON.stringify({ sku: "web.credits.10" }) });
    assert.equal(r.status, 201);
  });
});

describe("switching modes on one relay", () => {
  test("sessions, accounts and the liability are per mode", async () => {
    const env = await relayEnv("sandbox");
    const logs: string[] = [];
    const ctx = ctxFor(logs);

    // Sandbox: an account with test-money credits.
    const s = await account(env, ctx);
    assert.equal((await hook(env, ctx, paid("evt_s1", false, s, "pi_s1"))).status, 200);
    const sandboxCredits = await balance(env, ctx, s.auth);
    assert.ok(typeof sandboxCredits === "number" && sandboxCredits > 0);
    assert.equal((await new DoLedger(env.BILLING!, s.id).account()).account?.environment, "sandbox");

    // Go live (same objects, same session secret): the sandbox token opens nothing.
    switchTo(env, "production");
    assert.equal(await balance(env, ctx, s.auth), 401);
    assert.equal((await call(env, ctx, "/ai/v1/messages", { method: "POST", headers: s.auth, body: "{}" })).status, 401);
    assert.equal((await call(env, ctx, "/billing/checkout", { method: "POST", headers: s.auth, body: JSON.stringify({ sku: "web.credits.10" }) })).status, 401);

    // A production account and purchase: the liability starts from zero.
    logs.length = 0;
    const p = await account(env, ctx);
    assert.equal((await new DoLedger(env.BILLING!, p.id).account()).account?.environment, "production");
    assert.equal((await hook(env, ctx, paid("evt_p1", true, p, "pi_p1"))).status, 200);
    const liveCredits = await balance(env, ctx, p.auth);
    const liab = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e["ev"] === "ai_liability");
    assert.equal(liab.at(-1)?.["liability_credits"], liveCredits, "production liability excludes the sandbox's test credits");

    // Roll back: the production token is refused, the sandbox one works again.
    switchTo(env, "sandbox");
    assert.equal(await balance(env, ctx, p.auth), 401);
    assert.equal(await balance(env, ctx, s.auth), sandboxCredits);
    // And the sandbox liability still holds only the sandbox credits.
    logs.length = 0;
    const s2 = await account(env, ctx);
    assert.equal((await hook(env, ctx, paid("evt_s2", false, s2, "pi_s2"))).status, 200);
    const liab2 = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e["ev"] === "ai_liability");
    assert.equal(liab2.at(-1)?.["liability_credits"], sandboxCredits * 2);

    // No secret of either mode in any log line.
    for (const l of logs) for (const k of [TEST.STRIPE_SECRET_KEY, LIVE.STRIPE_SECRET_KEY, TEST.STRIPE_WEBHOOK_SECRET, LIVE.STRIPE_WEBHOOK_SECRET]) assert.ok(!l.includes(k), l);
  });
});
