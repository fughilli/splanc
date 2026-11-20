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
 *   POST   /billing/purchase/<channel>    the app's proof of purchase -> credit (idempotent);
 *                                         apple: {jws} = StoreKit 2's signed transaction
 *   POST   /billing/notify/<channel>      store / processor server notifications: Stripe's
 *                                         webhook (web), App Store Server Notifications v2 (apple)
 *   POST   /ai/v1/messages                the metered AI proxy (proxy.ts)
 *
 * MODES (`billingReady`). Everything answers 503 not_configured unless
 * AI_BILLING is exactly "sandbox" or "production" AND AI_PRICING is valid AND
 * ANTHROPIC_API_KEY, BILLING_TOKEN_SECRET and the BILLING Durable Object
 * binding are there. The mode decides everything money-related, never a mix:
 *
 *   sandbox     Stripe TEST keys only (sk_test_ / rk_test_; a live key turns
 *               the feature off); only test-mode (livemode=false) events
 *               credit or claw back; the fake store (AI_BILLING_FAKE_STORE_KEY)
 *               serves Apple purchases and, without Stripe, web purchases.
 *   production  Stripe LIVE keys required (sk_live_ / rk_live_ and a webhook
 *               secret; a test key or none turns the feature off) plus
 *               BILLING_ADMIN_TOKEN; only livemode=true events count; the fake
 *               store is never used, even if its key is set.
 *
 * Sessions, account tags and the liability counter are per mode, so credits
 * bought with test money in the sandbox can't be spent in production.
 *
 * Apple purchases are StoreKit 2 signed transactions ({jws}) and App Store
 * Server Notifications v2, verified against Apple's root (apple.ts). Only the
 * mode's App Store environment counts: Sandbox transactions (TestFlight and
 * development builds) in sandbox, Production ones in production; the other is
 * refused (purchases) or acknowledged and ignored (notifications).
 */

import { dir } from "../oauth";
import { now, type Env } from "../platform";
import { DoLedger, mintSession, newAccountId, verifySession, type BillingMode } from "./account";
import { MICRO, findPack, publicPricing, validatePricing, CHANNELS, type Channel, type PricingConfig } from "./pricing";
import { proxyMessages, redact, type OrgSpend } from "./proxy";
import { purchaseMoney, refundUsdEstimate } from "./metrics";
import { StripeError, createCheckoutSession, stripeAction, verifyStripeSignature, type StripeAction } from "./stripe";
import { safeEqual } from "../crypto";
import { AppStoreConsumptionSender, AppleStoreVerifier, appStoreApiKeyFrom, type AppleVerifierOptions } from "./apple";
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
  type StoreNotification,
  type VerifiedPurchase,
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
  /** fetch toward the App Store Server API (tests: a fake). Defaults to fetch. */
  appStoreFetch?: typeof fetch | undefined;
  /** Trusted roots for App Store signed data (tests: a test root). Default:
   * Apple Root CA G3, pinned in apple.ts. */
  appleRoots?: Uint8Array<ArrayBuffer>[] | undefined;
}

function appleOptions(env: Env, ctx: BillingContext): AppleVerifierOptions {
  const id = Number(env.APPLE_APP_ID);
  return { roots: ctx.appleRoots, now: now(env), ...(env.APPLE_APP_ID && Number.isFinite(id) ? { appAppleId: id } : {}) };
}

/** Is this body an App Store Server Notification v2 (`{"signedPayload": …}`)? */
function isSignedPayload(body: string): boolean {
  try {
    return typeof (JSON.parse(body) as { signedPayload?: unknown }).signedPayload === "string";
  } catch {
    return false;
  }
}

/**
 * App Store Server Notifications v2 (`POST /billing/notify/apple`): verify the
 * signed payload, ignore other environments (200, so Apple stops retrying),
 * then act. A bad signature is a 400; a processing failure a 500 (Apple
 * retries); a permanent problem with the transaction inside is a 200 plus a
 * log line, since a retry can't fix it.
 */
async function appleNotification(body: string, env: Env, ctx: BillingContext, ready: Ready, log: (ev: Record<string, unknown>) => void): Promise<Response> {
  const v = new AppleStoreVerifier(appleOptions(env, ctx));
  let verified: Awaited<ReturnType<AppleStoreVerifier["notification"]>>;
  try {
    verified = await v.notification(body);
  } catch (e) {
    if (!(e instanceof PurchaseError)) throw e;
    log({ ev: "ai_webhook_rejected", channel: "apple", reason: e.code });
    return ctx.json({ error: e.code }, 400);
  }
  if (!verified) return ctx.json({ error: "bad_notification" }, 400);
  const { n, environment } = verified;
  const seen = { ev: "ai_apple_notification", type: n.notificationType, subtype: n.subtype ?? null, environment };
  if (environment !== ready.environment) {
    log({ ...seen, ignored: true });
    return ctx.json({ ok: true, ignored: "environment" });
  }
  let action: StoreNotification;
  try {
    action = await v.act(n, environment);
  } catch (e) {
    if (!(e instanceof PurchaseError)) throw e;
    log({ ev: "ai_webhook_rejected", channel: "apple", reason: e.code });
    return ctx.json({ ok: true, ignored: e.code });
  }
  log({ ...seen, ignored: false });
  const key = appStoreApiKeyFrom(env);
  const sender = ctx.consumption ?? (key ? new AppStoreConsumptionSender(key, { fetchImpl: ctx.appStoreFetch, nowS: () => Math.floor(now(env) / 1000) }) : null);
  return actOnNotification(action, "apple", env, ctx, ready, log, sender);
}

/** Refunds claw back; Apple's CONSUMPTION_REQUEST is answered (with consent). */
async function actOnNotification(
  n: StoreNotification,
  channel: Channel,
  env: Env,
  ctx: BillingContext,
  ready: Ready,
  log: (ev: Record<string, unknown>) => void,
  sender: ConsumptionSender | null,
): Promise<Response> {
  if (n.refund) {
    const r = await applyRefund({ ledgerFor: (a) => new DoLedger(ready.ns, a), claims: directoryClaims(env), refund: n.refund });
    // A retried notification is a replay: nothing more is clawed back (or counted).
    const amount = r?.entry && !r.replay ? r.entry.amount : 0;
    log({
      ev: "ai_refund",
      channel,
      kind: n.refund.kind,
      account: r?.accountId ?? null,
      amount,
      matched: !!r,
      credits: Math.abs(amount) / MICRO,
      usd_est: refundUsdEstimate(ready.pricing, channel, amount),
    });
    await bumpLiability(env, ready.environment, log, amount);
  }
  if (n.consumptionRequest) {
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
    if (!sender) {
      log({ ev: "ai_consumption_failed", alert: true, account: owner, reason: "not_configured" });
      return ctx.json({ error: "consumption_failed" }, 500);
    }
    const c = await new DoLedger(ready.ns, owner).consumptionOf(`apple:${cr.transactionId}`);
    const answer = consumptionRequestFor(c);
    try {
      await sender.send(cr.apiTransactionId ?? cr.transactionId, cr.environment, answer);
    } catch (e) {
      log({ ev: "ai_consumption_failed", alert: true, account: owner, reason: "send_failed", detail: String(e) });
      return ctx.json({ error: "consumption_failed" }, 500);
    }
    log({ ev: "ai_consumption_sent", account: owner, consumption_milli: answer.consumptionPercentage ?? null, preference: answer.refundPreference ?? null });
  }
  return ctx.json({ ok: true });
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
    log({ ev: "ai_webhook_rejected", channel: "web", reason: v.reason.replace(/\s+/g, "_") });
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
          environment: ready.environment,
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
        if (!r.replay) await bumpLiability(env, ready.environment, log, r.entry.amount);
      } catch (e) {
        if (!(e instanceof PurchaseError)) throw e;
        log({ ev: "ai_purchase_rejected", alert: true, account: action.accountId, channel: "web", code: e.code });
      }
    } else if (action.kind === "refund" && action.environment !== ready.environment) {
      // A refund / dispute from the other Stripe mode never touches this mode's ledger.
      log({ ev: "ai_purchase_rejected", alert: true, account: null, channel: "web", code: "wrong_environment" });
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
        await bumpLiability(env, ready.environment, log, amount);
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
  /** AI_BILLING: which store / processor environment this relay accepts. */
  environment: BillingMode;
  pricing: PricingConfig;
  apiKey: string;
  secret: string;
  /** The fake store's key (sandbox Apple purchases; fake web purchases when
   * Stripe isn't set). Always null in production. */
  storeKey: string | null;
  /** Stripe keys of the mode (sandbox: test, optional; production: live, required). */
  stripe: { secretKey: string; webhookSecret: string } | null;
  ns: NonNullable<Env["BILLING"]>;
};

export const NOT_CONFIGURED = "Splanc AI credits aren't enabled on this relay.";

/** The Stripe mode a secret key belongs to (secret `sk_` or restricted `rk_`), or null. */
export function stripeKeyMode(key: string): BillingMode | null {
  if (/^(sk|rk)_test_/.test(key)) return "sandbox";
  if (/^(sk|rk)_live_/.test(key)) return "production";
  return null;
}

/** AI_BILLING as a mode, or null (unset / anything else = off). */
export function billingMode(env: { AI_BILLING?: string | undefined }): BillingMode | null {
  return env.AI_BILLING === "sandbox" || env.AI_BILLING === "production" ? env.AI_BILLING : null;
}

/** Every precondition, or the reason it is off. Never says which secret is missing. */
export function billingReady(env: Env): Ready | { off: string; detail?: string[] } {
  const mode = billingMode(env);
  if (!mode) return { off: "disabled" };
  if (!env.ANTHROPIC_API_KEY || !env.BILLING_TOKEN_SECRET || !env.BILLING) return { off: "incomplete" };
  const v = validatePricing(env.AI_PRICING ?? "");
  if (!v.ok) return { off: "bad_pricing", detail: v.errors };
  // Stripe keys must match the mode; a mismatch turns the WHOLE feature off,
  // so it can't half-work (test money in production, real money in the sandbox).
  const keyMode = env.STRIPE_SECRET_KEY ? stripeKeyMode(env.STRIPE_SECRET_KEY) : null;
  if (mode === "sandbox" && env.STRIPE_SECRET_KEY && keyMode !== "sandbox") return { off: "live_stripe_key_in_sandbox" };
  if (mode === "production") {
    if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET || !env.BILLING_ADMIN_TOKEN) return { off: "incomplete" };
    if (keyMode !== "production") return { off: "test_stripe_key_in_production" };
  }
  const stripe =
    env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET ? { secretKey: env.STRIPE_SECRET_KEY, webhookSecret: env.STRIPE_WEBHOOK_SECRET } : null;
  return {
    environment: mode,
    pricing: v.config,
    apiKey: env.ANTHROPIC_API_KEY,
    secret: env.BILLING_TOKEN_SECRET,
    // The fake store can mint credits from nothing: sandbox only.
    storeKey: mode === "sandbox" ? (env.AI_BILLING_FAKE_STORE_KEY ?? null) : null,
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

function directoryOrgSpend(env: Env, mode: BillingMode): OrgSpend {
  return {
    async get() {
      return (await dir<{ total: number }>(env, "/org/get", {})).body.total;
    },
    async add(microUsd) {
      return (await dir<{ total: number }>(env, "/org/add", { micro_usd: microUsd })).body.total;
    },
    liability: (delta) => liabilityAdd(env, mode, delta),
  };
}

/** Ops: move this mode's running credit liability by `deltaMicro`; returns the total (µcredits). */
async function liabilityAdd(env: Env, mode: BillingMode, deltaMicro: number): Promise<number> {
  return (await dir<{ total: number }>(env, "/org/liability", { delta_micro: deltaMicro, env: mode })).body.total;
}

/** Ops: move the liability and log its new total (`ai_liability`). Never throws. */
async function bumpLiability(env: Env, mode: BillingMode, log: (ev: Record<string, unknown>) => void, deltaMicro: number): Promise<void> {
  if (!deltaMicro) return;
  try {
    log({ ev: "ai_liability", liability_credits: (await liabilityAdd(env, mode, deltaMicro)) / MICRO, delta_credits: deltaMicro / MICRO });
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
  const secrets = [ready.apiKey, ready.secret, ready.stripe?.secretKey, ready.stripe?.webhookSecret, env.APPLE_IAP_KEY].filter((x): x is string => !!x);
  const log = (ev: Record<string, unknown>) =>
    ctx.log?.(JSON.parse(secrets.reduce((l, k) => redact(l, k), JSON.stringify(ev)).replace(/\b(sk|rk|whsec)_(test|live)?_?[A-Za-z0-9]{8,}/g, "$1_[redacted]")) as Record<string, unknown>);

  try {
    // -- unauthenticated --------------------------------------------------------------
    if (path === "/billing/pricing" && req.method === "GET") {
      const ch = new URL(req.url).searchParams.get("channel");
      const channel = (CHANNELS as readonly string[]).includes(ch ?? "") ? (ch as Channel) : null;
      return ctx.json({ ...publicPricing(pricing, channel), environment: ready.environment }, 200, { "cache-control": "public, max-age=300" });
    }
    if (path === "/billing/account" && req.method === "POST") {
      const lim = await dir(env, "/limit", { name: "billingAccountIp", key: ctx.clientIp, global: "billingAccountGlobal" });
      if (lim.status === 429) return ctx.json({ error: "rate_limited", message: "Too many new accounts from here; try later." }, 429, { "retry-after": "3600" });
      const id = newAccountId();
      const a = await new DoLedger(ready.ns, id).open(Math.round(pricing.trial_credits * MICRO), ready.environment);
      log({ ev: "ai_account_opened", account: id, trial_credits: pricing.trial_credits });
      await bumpLiability(env, ready.environment, log, Math.round(pricing.trial_credits * MICRO));
      return ctx.json(
        { account_id: id, token: await mintSession(ready.secret, id, nowS, ready.environment), account_ref: await accountRefFor(id), balance_credits: a.balance / MICRO },
        201,
      );
    }
    const notify = /^\/billing\/notify\/([a-z]+)$/.exec(path);
    if (notify && req.method === "POST") {
      const channel = notify[1] as Channel;
      if (!(CHANNELS as readonly string[]).includes(channel)) return ctx.json({ error: "not_found" }, 404);
      const body = await req.text();
      if (channel === "web" && ready.stripe) return stripeWebhook(req, body, env, ctx, ready, log, nowS);
      if (channel === "apple" && isSignedPayload(body)) return appleNotification(body, env, ctx, ready, log);
      if (!ready.storeKey) return ctx.json({ error: "not_configured", message: NOT_CONFIGURED }, 503);
      const n = await new FakeStoreVerifier(channel, ready.storeKey).parse(body, req.headers);
      if (!n) return ctx.json({ ok: true });
      return actOnNotification(n, channel, env, ctx, ready, log, ctx.consumption ?? new FakeConsumptionSender());
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
    const account = await verifySession(ready.secret, bearer(req), nowS, ready.environment);
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
        org: directoryOrgSpend(env, ready.environment),
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
        // The user answered the Apple consent question (yes or no): the iOS
        // flow asks it once, before the first purchase.
        apple_consumption_asked: a.apple_consumption_consent !== undefined,
        // StoreKit's appAccountToken for this account (purchases.ts accountRefFor).
        account_ref: await accountRefFor(account),
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
      // for web this route is the fake store's (sandbox tests) only. Apple:
      // the app posts StoreKit 2's signed transaction ({jws}); the fake
      // store's receipts ({payload, sig}) still work when its key is set.
      if (channel === "web" && ready.stripe) return ctx.json({ error: "not_found" }, 404);
      const raw = (await req.json().catch(() => null)) as { jws?: unknown } | null;
      const real = channel === "apple" && typeof raw?.jws === "string";
      if (!real && !ready.storeKey) {
        return channel === "apple" ? ctx.json({ error: "bad_receipt", message: "{jws} required" }, 400) : ctx.json({ error: "not_found" }, 404);
      }
      let purchase: VerifiedPurchase;
      let r: Awaited<ReturnType<typeof applyPurchase>>;
      try {
        purchase = real ? await new AppleStoreVerifier(appleOptions(env, ctx)).verify(raw) : await new FakeStoreVerifier(channel, ready.storeKey!).verify(raw);
        r = await applyPurchase({ ledger, claims: directoryClaims(env), pricing, accountId: account, purchase, environment: ready.environment });
      } catch (e) {
        if (e instanceof PurchaseError) log({ ev: "ai_purchase_rejected", account, channel, code: e.code });
        throw e;
      }
      log({
        ev: "ai_purchase",
        account,
        channel,
        sku: purchase.sku,
        replay: r.replay,
        amount: r.entry.amount,
        ...(r.replay ? {} : { ...purchaseMoney(pricing, channel, purchase.sku, r.entry.amount), first_purchase: r.first_purchase === true }),
      });
      if (!r.replay) await bumpLiability(env, ready.environment, log, r.entry.amount);
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
      await bumpLiability(env, ready.environment, log, -forfeited);
      return ctx.json({ ok: true, closed: account });
    }
    return ctx.json({ error: "method_not_allowed" }, 405);
  } catch (e) {
    if (e instanceof PurchaseError) return ctx.json({ error: e.code, message: e.message }, e.status);
    log({ ev: "ai_billing_error", path, detail: String(e) });
    return ctx.json({ error: "billing_error", message: "Something went wrong with Splanc AI credits." }, 500);
  }
}
