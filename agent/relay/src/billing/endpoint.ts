/**
 * Splanc AI credits on the relay (docs/design/ai-billing.md §API): the router.
 *
 *   POST   /billing/account               a new device-bound account -> {account_id, token, account_ref}
 *   DELETE /billing/account               close it (in-app account deletion; the balance is forfeited)
 *   GET    /billing/balance               {balance_credits, held_credits, low, status, adult}
 *   POST   /billing/age                   {confirm: true}: the user confirmed 18+ (buying is 18+)
 *   POST   /billing/consent               {apple_consumption: bool}: share consumption data with Apple on refund requests
 *   POST   /billing/admin/status          admin (BILLING_ADMIN_TOKEN): {account, status: active|suspended}
 *   GET    /billing/pricing?channel=      models + credits per MTok + this channel's packs (public)
 *   GET    /billing/statement             the newest ledger entries (no content, just numbers)
 *   POST   /billing/purchase/<channel>    the app's proof of purchase -> credit (idempotent)
 *   POST   /billing/notify/<channel>      store / processor server notifications (refunds)
 *   POST   /ai/v1/messages                the metered AI proxy (proxy.ts)
 *
 * SANDBOX-ONLY SCAFFOLD. Everything answers 503 not_configured unless the
 * Worker has AI_BILLING=sandbox AND a valid AI_PRICING AND the secrets
 * ANTHROPIC_API_KEY, BILLING_TOKEN_SECRET and AI_BILLING_FAKE_STORE_KEY AND the
 * BILLING Durable Object binding. "production" is refused: purchases are only
 * verified by the fake store (purchases.ts) until the real verifiers land.
 */

import { dir } from "../oauth";
import { now, type Env } from "../platform";
import { DoLedger, mintSession, newAccountId, verifySession } from "./account";
import { MICRO, findPack, publicPricing, validatePricing, CHANNELS, type Channel, type PricingConfig } from "./pricing";
import { proxyMessages, redact, type OrgSpend } from "./proxy";
import { purchaseMoney, refundUsdEstimate } from "./metrics";
import { StripeError, createCheckoutSession, stripeAction, verifyStripeSignature, type StripeAction } from "./stripe";
import { safeEqual } from "../crypto";
import {
  FakeConsumptionSender,
  FakeStoreVerifier,
  PurchaseError,
  accountRefFor,
  applyPurchase,
  applyRefund,
  consumptionRequestFor,
  type ConsumptionSender,
  type PurchaseClaims,
} from "./purchases";

export interface BillingContext {
  json: (obj: unknown, status?: number, extra?: Record<string, string>) => Response;
  clientIp: string;
  /** fetch toward Anthropic (tests: a fake upstream). Defaults to fetch. */
  upstream?: ((url: string, init: RequestInit) => Promise<Response>) | undefined;
  waitUntil?: ((p: Promise<unknown>) => void) | undefined;
  log?: ((ev: Record<string, unknown>) => void) | undefined;
  /** Apple "Send Consumption Information" (sandbox default: the fake). */
  consumption?: ConsumptionSender | undefined;
  /** fetch toward api.stripe.com (tests: a fake Stripe). Defaults to fetch. */
  stripeFetch?: typeof fetch | undefined;
}

/** Return URLs Checkout may send the user back to: the app, or local dev. */
const RETURN_ORIGINS = /^(https:\/\/(www\.)?splanc\.io|https:\/\/splanc\.pages\.dev|https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/;
const DEFAULT_APP_URL = "https://splanc.io/app/#/settings/ai";

export function safeReturnUrl(asked: unknown, configured: string | undefined): string {
  const fallback = configured || DEFAULT_APP_URL;
  if (typeof asked !== "string") return fallback;
  try {
    const u = new URL(asked);
    return RETURN_ORIGINS.test(u.origin) ? u.href : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Stripe's webhook (`POST /billing/notify/web`): verify the signature on the
 * RAW body, skip event ids already processed, act, then mark the id. A
 * processing error answers 500 so Stripe retries; a permanent problem (not
 * ours, wrong account, unknown pack) answers 200 with an alerting log line,
 * since a retry can't fix it.
 */
async function stripeWebhook(
  req: Request,
  body: string,
  env: Env,
  ctx: BillingContext,
  ready: Ready,
  log: (ev: Record<string, unknown>) => void,
  nowS: number,
): Promise<Response> {
  const v = await verifyStripeSignature(ready.stripe!.webhookSecret, req.headers.get("stripe-signature"), body, nowS);
  if (!v.ok) {
    log({ ev: "ai_webhook_rejected", reason: v.reason.replace(/\s+/g, "_") });
    return ctx.json({ error: "bad_signature" }, 400);
  }
  let action: StripeAction;
  try {
    action = stripeAction(body);
  } catch {
    return ctx.json({ error: "bad_event" }, 400);
  }
  if ((await dir<{ seen: boolean }>(env, "/stripe/seen", { id: action.eventId })).body.seen) return ctx.json({ ok: true, replay: true });
  try {
    if (action.kind === "purchase") {
      const ledger = new DoLedger(ready.ns, action.accountId);
      try {
        const r = await applyPurchase({
          ledger,
          claims: directoryClaims(env),
          pricing: ready.pricing,
          accountId: action.accountId,
          purchase: action.purchase,
          environment: "sandbox",
        });
        if (action.paymentIntent) {
          await dir(env, "/pur/pi/set", { pi: action.paymentIntent, account: action.accountId, ref: `web:${action.purchase.transactionId}` });
        }
        log({
          ev: "ai_purchase",
          account: action.accountId,
          channel: "web",
          sku: action.purchase.sku,
          replay: r.replay,
          amount: r.entry.amount,
          ...(r.replay ? {} : { ...purchaseMoney(ready.pricing, "web", action.purchase.sku, r.entry.amount), first_purchase: r.first_purchase === true }),
        });
        if (!r.replay) await bumpLiability(env, log, r.entry.amount);
      } catch (e) {
        if (!(e instanceof PurchaseError)) throw e;
        log({ ev: "ai_purchase_rejected", alert: true, account: action.accountId, channel: "web", code: e.code });
      }
    } else if (action.kind === "refund") {
      const rec = (await dir<{ rec: { account: string; ref: string } | null }>(env, "/pur/pi/get", { pi: action.paymentIntent })).body.rec;
      if (rec) {
        const r = await new DoLedger(ready.ns, rec.account).clawbackFraction(rec.ref, action.fraction, action.reason);
        const amount = r.entry && !r.replay ? r.entry.amount : 0;
        log({
          ev: "ai_refund",
          channel: "web",
          kind: action.reason,
          account: rec.account,
          fraction: action.fraction,
          amount,
          matched: true,
          credits: Math.abs(amount) / MICRO,
          usd_est: refundUsdEstimate(ready.pricing, "web", amount),
        });
        await bumpLiability(env, log, amount);
      } else {
        log({ ev: "ai_refund", channel: "web", kind: action.reason, account: null, amount: 0, matched: false, credits: 0 });
      }
    }
    await dir(env, "/stripe/mark", { id: action.eventId });
    return ctx.json({ ok: true });
  } catch (e) {
    log({ ev: "ai_billing_error", path: "/billing/notify/web", detail: String(e) });
    return ctx.json({ error: "retry" }, 500);
  }
}

export const BILLING_PATHS = [
  "/ai/v1/messages",
  "/billing/account",
  "/billing/admin/status",
  "/billing/age",
  "/billing/balance",
  "/billing/checkout",
  "/billing/consent",
  "/billing/pricing",
  "/billing/statement",
];
export const isBillingPath = (p: string) =>
  BILLING_PATHS.includes(p) || /^\/billing\/(purchase|notify)\/[a-z]+$/.test(p);

type Ready = {
  pricing: PricingConfig;
  apiKey: string;
  secret: string;
  /** The fake store's key (sandbox Apple purchases; fake web purchases when Stripe isn't set). */
  storeKey: string | null;
  /** Stripe TEST keys (sandbox): web checkout + its webhook. */
  stripe: { secretKey: string; webhookSecret: string } | null;
  ns: NonNullable<Env["BILLING"]>;
};

export const NOT_CONFIGURED = "Splanc AI credits aren't enabled on this relay.";

/** Every precondition, or the reason it is off. Never says which secret is missing. */
export function billingReady(env: Env): Ready | { off: string; detail?: string[] } {
  if (env.AI_BILLING !== "sandbox") return { off: env.AI_BILLING === "production" ? "production_not_supported" : "disabled" };
  if (!env.ANTHROPIC_API_KEY || !env.BILLING_TOKEN_SECRET || !env.BILLING) return { off: "incomplete" };
  const v = validatePricing(env.AI_PRICING ?? "");
  if (!v.ok) return { off: "bad_pricing", detail: v.errors };
  // The sandbox only ever talks to Stripe in TEST mode: a live key is refused
  // (the whole feature stays off, so it can't half-work with real money).
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith("sk_test_")) return { off: "live_stripe_key_in_sandbox" };
  const stripe =
    env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET } : null;
  return {
    pricing: v.config,
    apiKey: env.ANTHROPIC_API_KEY,
    secret: env.BILLING_TOKEN_SECRET,
    storeKey: env.AI_BILLING_FAKE_STORE_KEY ?? null,
    stripe,
    ns: env.BILLING,
  };
}

function directoryClaims(env: Env): PurchaseClaims {
  return {
    async claim(channel, tx, account) {
      const r = await dir<{ ok: boolean; owner?: string }>(env, "/pur/claim", { channel, tx, account });
      return r.body.ok ? { ok: true } : { ok: false, owner: r.body.owner ?? "" };
    },
    async owner(channel, tx) {
      return (await dir<{ owner: string | null }>(env, "/pur/owner", { channel, tx })).body.owner ?? undefined;
    },
  };
}

function directoryOrgSpend(env: Env): OrgSpend {
  return {
    async get() {
      return (await dir<{ total: number }>(env, "/org/get", {})).body.total;
    },
    async add(microUsd) {
      return (await dir<{ total: number }>(env, "/org/add", { micro_usd: microUsd })).body.total;
    },
    liability: (delta) => liabilityAdd(env, delta),
  };
}

/** Ops: move the running credit liability by `deltaMicro`; returns the total (µcredits). */
async function liabilityAdd(env: Env, deltaMicro: number): Promise<number> {
  return (await dir<{ total: number }>(env, "/org/liability", { delta_micro: deltaMicro })).body.total;
}

/** Ops: move the liability and log its new total (`ai_liability`). Never throws. */
async function bumpLiability(env: Env, log: (ev: Record<string, unknown>) => void, deltaMicro: number): Promise<void> {
  if (!deltaMicro) return;
  try {
    log({ ev: "ai_liability", liability_credits: (await liabilityAdd(env, deltaMicro)) / MICRO, delta_credits: deltaMicro / MICRO });
  } catch {
    // ops only
  }
}

const bearer = (req: Request) => {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
};

export async function billingEndpoint(req: Request, env: Env, ctx: BillingContext, path: string): Promise<Response> {
  const ready = billingReady(env);
  if ("off" in ready) {
    // The pricing errors are config, not secrets; they go to the log only.
    if (ready.detail) ctx.log?.({ ev: "ai_billing_bad_pricing", errors: ready.detail });
    return ctx.json({ error: "not_configured", message: NOT_CONFIGURED }, 503);
  }
  const nowS = Math.floor(now(env) / 1000);
  const { pricing } = ready;
  const secrets = [ready.apiKey, ready.secret, ready.stripe?.secretKey, ready.stripe?.webhookSecret].filter((x): x is string => !!x);
  const log = (ev: Record<string, unknown>) =>
    ctx.log?.(JSON.parse(secrets.reduce((l, k) => redact(l, k), JSON.stringify(ev)).replace(/\b(sk|rk|whsec)_(test|live)?_?[A-Za-z0-9]{8,}/g, "$1_[redacted]")) as Record<string, unknown>);

  try {
    // -- unauthenticated --------------------------------------------------------------
    if (path === "/billing/pricing" && req.method === "GET") {
      const ch = new URL(req.url).searchParams.get("channel");
      const channel = (CHANNELS as readonly string[]).includes(ch ?? "") ? (ch as Channel) : null;
      return ctx.json(publicPricing(pricing, channel), 200, { "cache-control": "public, max-age=300" });
    }
    if (path === "/billing/account" && req.method === "POST") {
      const lim = await dir(env, "/limit", { name: "billingAccountIp", key: ctx.clientIp, global: "billingAccountGlobal" });
      if (lim.status === 429) return ctx.json({ error: "rate_limited", message: "Too many new accounts from here; try later." }, 429, { "retry-after": "3600" });
      const id = newAccountId();
      const a = await new DoLedger(ready.ns, id).open(Math.round(pricing.trial_credits * MICRO));
      log({ ev: "ai_account_opened", account: id, trial_credits: pricing.trial_credits });
      await bumpLiability(env, log, Math.round(pricing.trial_credits * MICRO));
      return ctx.json(
        { account_id: id, token: await mintSession(ready.secret, id, nowS), account_ref: await accountRefFor(id), balance_credits: a.balance / MICRO },
        201,
      );
    }
    const notify = /^\/billing\/notify\/([a-z]+)$/.exec(path);
    if (notify && req.method === "POST") {
      const channel = notify[1] as Channel;
      if (!(CHANNELS as readonly string[]).includes(channel)) return ctx.json({ error: "not_found" }, 404);
      const body = await req.text();
      if (channel === "web" && ready.stripe) return stripeWebhook(req, body, env, ctx, ready, log, nowS);
      if (!ready.storeKey) return ctx.json({ error: "not_configured", message: NOT_CONFIGURED }, 503);
      const n = await new FakeStoreVerifier(channel, ready.storeKey).parse(body, req.headers);
      if (n && "refund" in n) {
        const r = await applyRefund({ ledgerFor: (a) => new DoLedger(ready.ns, a), claims: directoryClaims(env), refund: n.refund });
        const amount = r?.entry?.amount ?? 0;
        log({
          ev: "ai_refund",
          channel,
          kind: n.refund.kind,
          account: r?.accountId ?? null,
          amount,
          matched: !!r,
          credits: Math.abs(amount) / MICRO,
          usd_est: refundUsdEstimate(pricing, channel, amount),
        });
        await bumpLiability(env, log, amount);
      }
      if (n && "consumptionRequest" in n) {
        // Apple asks how much of a purchase was used (the customer asked Apple
        // for a refund). Answer ONLY with the customer's consent; otherwise
        // don't respond at all (Apple's rule). A failed answer is a 500 so
        // Apple retries the notification (12-hour deadline).
        const cr = n.consumptionRequest;
        const owner = await directoryClaims(env).owner("apple", cr.transactionId);
        const a = owner ? (await new DoLedger(ready.ns, owner).account()).account : null;
        if (!owner || !a || a.apple_consumption_consent?.consented !== true) {
          log({ ev: "ai_consumption_skipped", account: owner ?? null, reason: !owner ? "unknown_transaction" : "no_consent" });
          return ctx.json({ ok: true });
        }
        const c = await new DoLedger(ready.ns, owner).consumptionOf(`apple:${cr.transactionId}`);
        const answer = consumptionRequestFor(c);
        try {
          await (ctx.consumption ?? new FakeConsumptionSender()).send(cr.transactionId, cr.environment, answer);
        } catch (e) {
          log({ ev: "ai_consumption_failed", alert: true, account: owner, detail: String(e) });
          return ctx.json({ error: "consumption_failed" }, 500);
        }
        log({ ev: "ai_consumption_sent", account: owner, consumption_milli: answer.consumptionPercentage ?? null, preference: answer.refundPreference ?? null });
      }
      return ctx.json({ ok: true });
    }

    if (path === "/billing/admin/status" && req.method === "POST") {
      const h = req.headers.get("authorization") ?? "";
      const admin = !!env.BILLING_ADMIN_TOKEN && h.startsWith("Bearer ") && safeEqual(h.slice(7), env.BILLING_ADMIN_TOKEN);
      if (!admin) return ctx.json({ error: "unauthorized" }, 401);
      const b = (await req.json().catch(() => ({}))) as { account?: unknown; status?: unknown; reason?: unknown };
      if (typeof b.account !== "string" || !/^acct_[a-z2-7]{20}$/.test(b.account) || (b.status !== "active" && b.status !== "suspended")) {
        return ctx.json({ error: "invalid_request", message: "{account, status: active|suspended, reason?}" }, 400);
      }
      await new DoLedger(ready.ns, b.account).setStatus(b.status);
      // The reason is a short admin label (e.g. "aup:spam"), never user content.
      const reason = typeof b.reason === "string" ? b.reason.slice(0, 40) : null;
      log({ ev: b.status === "suspended" ? "ai_account_suspended" : "ai_account_reinstated", account: b.account, reason });
      return ctx.json({ ok: true, account: b.account, status: b.status });
    }

    // -- authenticated ----------------------------------------------------------------
    const account = await verifySession(ready.secret, bearer(req), nowS);
    if (!account) return ctx.json({ error: "unauthorized", message: "sign in to use Splanc AI credits" }, 401);
    const ledger = new DoLedger(ready.ns, account);

    if (path === "/ai/v1/messages" && req.method === "POST") {
      return proxyMessages(req, account, {
        pricing,
        apiKey: ready.apiKey,
        ledger,
        upstream: ctx.upstream ?? ((u, i) => fetch(u, i)),
        log,
        waitUntil: ctx.waitUntil,
        org: directoryOrgSpend(env),
      });
    }
    if (path === "/billing/balance" && req.method === "GET") {
      const a = (await ledger.account()).account;
      if (!a) return ctx.json({ error: "not_found" }, 404);
      const avail = a.balance - a.held;
      return ctx.json({
        balance_credits: a.balance / MICRO,
        held_credits: a.held / MICRO,
        available_credits: avail / MICRO,
        low: avail < pricing.low_balance_credits * MICRO,
        status: a.status,
        adult: a.adult_confirmed_at !== undefined,
        apple_consumption_consent: a.apple_consumption_consent?.consented === true,
        pricing_version: pricing.version,
      });
    }
    if (path === "/billing/consent" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { apple_consumption?: unknown };
      if (typeof b.apple_consumption !== "boolean") return ctx.json({ error: "invalid_request", message: "{apple_consumption: boolean}" }, 400);
      await ledger.setAppleConsumptionConsent(b.apple_consumption);
      return ctx.json({ ok: true, apple_consumption_consent: b.apple_consumption });
    }
    if (path === "/billing/age" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { confirm?: unknown };
      if (b.confirm !== true) return ctx.json({ error: "invalid_request", message: "{confirm: true}" }, 400);
      await ledger.confirmAdult();
      return ctx.json({ ok: true, adult: true });
    }
    if (path === "/billing/statement" && req.method === "GET") {
      const { entries } = await ledger.statement(50);
      return ctx.json({
        entries: entries.map((e) => ({
          at: new Date(e.at).toISOString(),
          kind: e.kind,
          credits: e.amount / MICRO,
          balance_credits: e.balance / MICRO,
          ...(e.model ? { model: e.model } : {}),
          ...(e.usage ? { usage: e.usage } : {}),
          ...(e.sku ? { sku: e.sku } : {}),
        })),
      });
    }
    if (path === "/billing/checkout" && req.method === "POST") {
      // Web checkout (Stripe). Never offered inside the iOS app (the app hides
      // it; App Store rules): this route serves the PWA in a browser / Android.
      if (!ready.stripe) return ctx.json({ error: "not_configured", message: "Web checkout isn't enabled on this relay." }, 503);
      const a = (await ledger.account()).account;
      if (!a || a.status !== "active") return ctx.json({ error: "inactive", message: "Splanc AI credits are not available on this account." }, 403);
      if (a.adult_confirmed_at === undefined) return ctx.json({ error: "age_required", message: "Buying Splanc AI credits is for adults (18+). Please confirm your age first." }, 403);
      const b = (await req.json().catch(() => ({}))) as { sku?: unknown; return_url?: unknown };
      const pack = typeof b.sku === "string" ? findPack(pricing, "web", b.sku) : undefined;
      if (!pack) return ctx.json({ error: "unknown_product", message: "No such credit pack." }, 400);
      if (!pack.stripe_price_id) return ctx.json({ error: "not_configured", message: "This credit pack isn't on sale yet." }, 503);
      const returnUrl = safeReturnUrl(b.return_url, env.BILLING_APP_URL);
      try {
        const s = await createCheckoutSession(
          ready.stripe.secretKey,
          { pack: { ...pack, stripe_price_id: pack.stripe_price_id }, accountId: account, accountRef: await accountRefFor(account), returnUrl },
          { fetchImpl: ctx.stripeFetch },
        );
        log({ ev: "ai_checkout_created", account, sku: pack.sku, session: s.id });
        return ctx.json({ url: s.url, id: s.id }, 201);
      } catch (e) {
        log({ ev: "ai_checkout_failed", alert: true, account, sku: pack.sku, detail: e instanceof StripeError ? e.message : String(e) });
        return ctx.json({ error: "checkout_unavailable", message: "Checkout is unavailable right now. Try again later." }, 503);
      }
    }
    const buy = /^\/billing\/purchase\/([a-z]+)$/.exec(path);
    if (buy && req.method === "POST") {
      const channel = buy[1] as Channel;
      if (!(CHANNELS as readonly string[]).includes(channel)) return ctx.json({ error: "not_found" }, 404);
      // Web purchases come from Stripe's webhook once Stripe is configured;
      // this route is the fake store's (sandbox tests) only.
      if (!ready.storeKey || (channel === "web" && ready.stripe)) return ctx.json({ error: "not_found" }, 404);
      const purchase = await new FakeStoreVerifier(channel, ready.storeKey).verify(await req.json().catch(() => null));
      const r = await applyPurchase({ ledger, claims: directoryClaims(env), pricing, accountId: account, purchase, environment: "sandbox" });
      log({
        ev: "ai_purchase",
        account,
        channel,
        sku: purchase.sku,
        replay: r.replay,
        amount: r.entry.amount,
        ...(r.replay ? {} : { ...purchaseMoney(pricing, channel, purchase.sku, r.entry.amount), first_purchase: r.first_purchase === true }),
      });
      if (!r.replay) await bumpLiability(env, log, r.entry.amount);
      return ctx.json({ credited_credits: r.entry.amount / MICRO, balance_credits: r.entry.balance / MICRO, replay: r.replay }, r.replay ? 200 : 201);
    }
    if (path === "/billing/account" && req.method === "DELETE") {
      const before = (await ledger.account()).account;
      await ledger.close();
      const forfeited = before && before.status !== "closed" ? Math.max(0, before.balance) : 0;
      log({
        ev: "ai_account_closed",
        account,
        forfeited_credits: forfeited / MICRO,
      });
      await bumpLiability(env, log, -forfeited);
      return ctx.json({ ok: true, closed: account });
    }
    return ctx.json({ error: "method_not_allowed" }, 405);
  } catch (e) {
    if (e instanceof PurchaseError) return ctx.json({ error: e.code, message: e.message }, e.status);
    log({ ev: "ai_billing_error", path, detail: String(e) });
    return ctx.json({ error: "billing_error", message: "Something went wrong with Splanc AI credits." }, 500);
  }
}
