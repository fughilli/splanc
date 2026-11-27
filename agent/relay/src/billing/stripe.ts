/**
 * Stripe web checkout (docs/design/ai-billing.md §Web checkout): the
 * "web" channel, for the PWA in any browser and on Android. NEVER used by the
 * iOS app (App Store rules: it sells through In-App Purchase only).
 *
 * - `createCheckoutSession`: a server-side Checkout Session for one pack
 *   (its Stripe Price from the pricing config), `client_reference_id` =
 *   the account ref, automatic tax (Stripe Tax), and success / cancel URLs
 *   back into the app. Payment methods are Stripe's dynamic ones (cards,
 *   Apple Pay, Google Pay as enabled in the Dashboard).
 * - `verifyStripeSignature`: the `Stripe-Signature` header check (HMAC-SHA256
 *   of `<t>.<raw body>` with the endpoint's signing secret, 5-minute
 *   tolerance), done before the body is parsed.
 * - `stripeNotification`: turns a verified event into a purchase / refund /
 *   dispute for the ledger.
 *
 * Talks to api.stripe.com with fetch and form encoding (no SDK; the relay has
 * no npm dependencies at runtime). The secret key never leaves the relay.
 */

import type { Pack } from "./pricing";
import type { StoreEnvironment, VerifiedPurchase } from "./purchases";

export const STRIPE_API = "https://api.stripe.com/v1";
/** The API version the webhook destination is pinned to. */
export const STRIPE_VERSION = "2026-06-24.dahlia";
/** Signature timestamps older / newer than this are refused (replays). */
export const STRIPE_TOLERANCE_S = 300;
/** What follows the account's shortened descriptor on a buyer's card statement
 * ("<PREFIX>* SPLANC"): the Stripe account is shared with the owner's other
 * business, whose name is the account's own descriptor. */
export const STATEMENT_DESCRIPTOR_SUFFIX = "SPLANC";

/** Encode nested params the way Stripe's form API expects (a[b][0][c]=…). */
export function stripeForm(params: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, x);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  walk("", params);
  return out.join("&");
}

export interface CheckoutParams {
  pack: Pack & { stripe_price_id: string };
  accountId: string;
  accountRef: string;
  /** Where Stripe sends the user back (already validated by the caller). */
  returnUrl: string;
}

/** The Checkout Session parameters (pure; tested without a network). */
export function checkoutSessionParams(p: CheckoutParams): Record<string, unknown> {
  const back = (state: string) => {
    const u = new URL(p.returnUrl);
    u.searchParams.set("checkout", state);
    // Stripe fills {CHECKOUT_SESSION_ID} in; keep the braces unencoded.
    return u.href.replace("checkout=" + state, `checkout=${state}&session_id={CHECKOUT_SESSION_ID}`);
  };
  const meta = { account_id: p.accountId, sku: p.pack.sku, channel: "web" };
  return {
    mode: "payment",
    line_items: [{ price: p.pack.stripe_price_id, quantity: 1 }],
    client_reference_id: p.accountRef,
    metadata: meta,
    // The PaymentIntent carries the same metadata, so refunds and disputes
    // (which name the PaymentIntent / Charge, not the session) map back.
    payment_intent_data: { metadata: meta, statement_descriptor_suffix: STATEMENT_DESCRIPTOR_SUFFIX },
    // Stripe Tax (owner decision): Checkout collects what tax needs (country /
    // postal code) on its own when automatic tax is on.
    automatic_tax: { enabled: true },
    success_url: back("success"),
    cancel_url: back("cancel").replace("&session_id={CHECKOUT_SESSION_ID}", ""),
  };
}

export async function createCheckoutSession(
  secretKey: string,
  p: CheckoutParams,
  opts: { fetchImpl?: typeof fetch | undefined; idempotencyKey?: string | undefined } = {},
): Promise<{ id: string; url: string }> {
  const r = await (opts.fetchImpl ?? fetch)(`${STRIPE_API}/checkout/sessions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": STRIPE_VERSION,
      ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
    },
    body: stripeForm(checkoutSessionParams(p)),
  });
  const j = (await r.json().catch(() => ({}))) as { id?: string; url?: string; error?: { type?: string; code?: string } };
  // Stripe's error message is never passed on (it can echo request params);
  // the caller logs the type / code only.
  if (!r.ok || !j.id || !j.url) throw new StripeError(r.status, j.error?.type ?? "unknown", j.error?.code ?? "");
  return { id: j.id, url: j.url };
}

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    readonly code: string,
  ) {
    super(`stripe ${status} ${type}${code ? ` ${code}` : ""}`);
  }
}

// -- webhooks --------------------------------------------------------------------------

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmacHex(secret: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Sign a payload like Stripe does (tests and the e2e script). */
export async function stripeSignatureHeader(secret: string, body: string, t: number): Promise<string> {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${body}`)}`;
}

/** Verify `Stripe-Signature` for the RAW body. */
export async function verifyStripeSignature(secret: string, header: string | null, body: string, nowS: number): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!header) return { ok: false, reason: "missing signature" };
  let t = NaN;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=", 2) as [string, string | undefined];
    if (k === "t") t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  if (!Number.isFinite(t) || v1.length === 0) return { ok: false, reason: "malformed signature" };
  if (Math.abs(nowS - t) > STRIPE_TOLERANCE_S) return { ok: false, reason: "timestamp outside tolerance" };
  const want = await hmacHex(secret, `${t}.${body}`);
  return v1.some((s) => constantTimeEq(s, want)) ? { ok: true } : { ok: false, reason: "signature mismatch" };
}

/** What a verified Stripe event means for the ledger. */
export type StripeAction =
  | { kind: "purchase"; eventId: string; purchase: VerifiedPurchase; accountId: string; paymentIntent: string | null }
  | { kind: "refund"; eventId: string; paymentIntent: string; fraction: number; reason: "refund" | "chargeback"; environment: StoreEnvironment }
  | { kind: "ignore"; eventId: string; why: string };

interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

const str = (x: unknown) => (typeof x === "string" ? x : null);

/** Map a verified event (already signature-checked) to an action. */
export function stripeAction(raw: string): StripeAction {
  const ev = JSON.parse(raw) as StripeEvent;
  const o = ev.data?.object ?? {};
  const environment: StoreEnvironment = ev.livemode ? "production" : "sandbox";
  switch (ev.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      // A delayed method completes "unpaid" first; credit on async success.
      if (o["payment_status"] !== "paid") return { kind: "ignore", eventId: ev.id, why: `payment_status ${String(o["payment_status"])}` };
      const meta = (o["metadata"] ?? {}) as Record<string, unknown>;
      const accountId = str(meta["account_id"]);
      const sku = str(meta["sku"]);
      const ref = str(o["client_reference_id"]);
      const id = str(o["id"]);
      if (!accountId || !sku || !ref || !id) return { kind: "ignore", eventId: ev.id, why: "not a Splanc credits session" };
      return {
        kind: "purchase",
        eventId: ev.id,
        accountId,
        paymentIntent: str(o["payment_intent"]),
        purchase: { channel: "web", sku, transactionId: id, environment, purchasedAt: Number(o["created"] ?? 0) * 1000, accountRef: ref },
      };
    }
    case "charge.refunded": {
      const pi = str(o["payment_intent"]);
      const amount = Number(o["amount"] ?? 0);
      const refunded = Number(o["amount_refunded"] ?? 0);
      if (!pi || !(amount > 0)) return { kind: "ignore", eventId: ev.id, why: "no payment intent" };
      // Cumulative: a second partial refund raises the fraction.
      return { kind: "refund", eventId: ev.id, paymentIntent: pi, fraction: Math.min(1, refunded / amount), reason: "refund", environment };
    }
    case "charge.dispute.created": {
      const pi = str(o["payment_intent"]);
      if (!pi) return { kind: "ignore", eventId: ev.id, why: "no payment intent" };
      // The disputed amount is withdrawn from us now: claw back all of it.
      return { kind: "refund", eventId: ev.id, paymentIntent: pi, fraction: 1, reason: "chargeback", environment };
    }
    default:
      return { kind: "ignore", eventId: ev.id, why: `unhandled ${ev.type}` };
  }
}
