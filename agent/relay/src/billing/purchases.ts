/**
 * Purchase validation (docs/design/ai-billing.md §Purchases): the interfaces,
 * the shared credit / refund logic, and the sandbox FAKES. The real stores
 * live next to it: apple.ts (StoreKit 2 JWS + App Store Server Notifications
 * v2 + the App Store Server API) and stripe.ts (web checkout).
 *
 * Owner decision 2026-11-18: iOS sells consumable In-App Purchases (channel
 * "apple"); the web app (every browser, Android included) uses web checkout
 * (Stripe, channel "web"). No Google Play Billing for now.
 *
 * The real implementations:
 * - Apple (apple.ts): the app sends StoreKit 2's signed transaction (JWS). The server
 *   verifies the x5c chain to Apple Root CA G3, the bundle id
 *   `dev.splanc.app`, the product id, the environment, and that the
 *   transaction's `appAccountToken` equals the account's (the app sets it at
 *   purchase), then credits. App Store Server Notifications V2 (REFUND,
 *   REVOKE, CONSUMPTION_REQUEST) arrive signed the same way.
 * - Stripe (stripe.ts): Checkout Session created server-side with the account id as
 *   `client_reference_id`; credit on the `checkout.session.completed` webhook
 *   (Stripe-Signature HMAC); claw back on `charge.refunded` /
 *   `charge.dispute.created`.
 */

import type { Ledger, LedgerEntry } from "./ledger";
import { MICRO, findPack, packCredits, type Channel, type PricingConfig } from "./pricing";

export type StoreEnvironment = "sandbox" | "production";

/** A purchase the store / processor has vouched for. */
export interface VerifiedPurchase {
  channel: Channel;
  sku: string;
  /** The store's id for this purchase (Apple originalTransactionId for a
   * consumable = transactionId; Stripe checkout session id). Globally unique
   * per channel: the idempotency key of the credit. */
  transactionId: string;
  environment: StoreEnvironment;
  purchasedAt: number;
  /** The account the purchase was made for, as the store carries it (Apple
   * appAccountToken; Stripe client_reference_id). */
  accountRef: string;
}

/** A refund / revocation / chargeback of an earlier purchase. */
export interface RefundNotice {
  channel: Channel;
  transactionId: string;
  kind: "refund" | "revoke" | "chargeback";
  environment: StoreEnvironment;
}

/** Validates what the app sends after a purchase (Apple: the signed transaction). */
export interface PurchaseVerifier {
  readonly channel: Channel;
  verify(payload: unknown): Promise<VerifiedPurchase>;
}

/** Apple asks how much of a purchase was used, because the customer asked
 * Apple for a refund (App Store Server Notifications v2 CONSUMPTION_REQUEST). */
export interface ConsumptionRequestNotice {
  channel: "apple";
  /** The credit's key (the original transaction id). */
  transactionId: string;
  /** The id to answer Apple for, when it differs (the transaction Apple named). */
  apiTransactionId?: string | undefined;
  environment: StoreEnvironment;
}

/** What a notification asks for (at most one action), plus what it was. */
export interface StoreNotification {
  purchase?: VerifiedPurchase | undefined;
  refund?: RefundNotice | undefined;
  consumptionRequest?: ConsumptionRequestNotice | undefined;
  /** The store's own type (Apple notificationType / subtype), for the log. */
  info?: { type: string; subtype: string | null; environment: StoreEnvironment } | undefined;
}

/** Parses a store / processor server-to-server notification (Apple ASSN v2,
 * Stripe webhook). Returns null for a notification we don't act on. */
export interface NotificationVerifier {
  readonly channel: Channel;
  parse(body: string, headers: Headers): Promise<StoreNotification | null>;
}

// -- Apple "Send Consumption Information" ----------------------------------------------
//
// App Store Server API: PUT /inApps/v2/transactions/consumption/{transactionId}
// with a ConsumptionRequest, within 12 hours of the CONSUMPTION_REQUEST, and
// ONLY if the customer consented; without consent, don't respond at all
// (developer.apple.com/documentation/appstoreserverapi/send-consumption-information).
// Fields per Apple's app-store-server-library 3.1.0 (models/ConsumptionRequest).

export type DeliveryStatus = "DELIVERED" | "UNDELIVERED_QUALITY_ISSUE" | "UNDELIVERED_WRONG_ITEM" | "UNDELIVERED_SERVER_OUTAGE" | "UNDELIVERED_OTHER";
export type RefundPreference = "DECLINE" | "GRANT_FULL" | "GRANT_PRORATED";

export interface ConsumptionRequest {
  customerConsented: boolean;
  /** Percentage consumed, in milliunits (0..100000). */
  consumptionPercentage?: number;
  deliveryStatus: DeliveryStatus;
  refundPreference?: RefundPreference;
  sampleContentProvided: boolean;
}

/** Sends a ConsumptionRequest (the real one: a JWT-signed App Store Server
 * API call with our In-App Purchase key; the fake records it). */
export interface ConsumptionSender {
  send(transactionId: string, environment: StoreEnvironment, body: ConsumptionRequest): Promise<void>;
}

export class FakeConsumptionSender implements ConsumptionSender {
  readonly sent: { transactionId: string; environment: StoreEnvironment; body: ConsumptionRequest }[] = [];
  async send(transactionId: string, environment: StoreEnvironment, body: ConsumptionRequest) {
    if (environment !== "sandbox") throw new Error("the fake consumption sender is sandbox-only");
    this.sent.push({ transactionId, environment, body });
  }
}

/**
 * The ConsumptionRequest for a credit pack, from its FIFO consumption
 * (ledger.ts lotConsumption):
 * - deliveryStatus DELIVERED (the credits were on the account and usable);
 * - consumptionPercentage = the share of the pack's credits spent;
 * - refundPreference: nothing used -> GRANT_FULL, partly -> GRANT_PRORATED,
 *   all used -> DECLINE (owner decision, 2026-11-18);
 * - sampleContentProvided: true (owner decision: the free tier counts as a
 * sample). Before buying, the free tier lets people try
 *   the AI and the app shows what requests cost.
 */
export function consumptionRequestFor(c: { fraction: number } | null): ConsumptionRequest {
  if (!c) return { customerConsented: true, deliveryStatus: "UNDELIVERED_OTHER", sampleContentProvided: true, refundPreference: "GRANT_FULL" };
  const milli = Math.max(0, Math.min(100_000, Math.round(c.fraction * 100_000)));
  return {
    customerConsented: true,
    consumptionPercentage: milli,
    deliveryStatus: "DELIVERED",
    refundPreference: milli === 0 ? "GRANT_FULL" : milli >= 100_000 ? "DECLINE" : "GRANT_PRORATED",
    sampleContentProvided: true,
  };
}

/**
 * One store transaction credits exactly ONE account, ever (a replayed receipt
 * on another account is refused). The Worker backs this with the Directory
 * Durable Object (`pur:<channel>:<txid>` -> account, first claim wins).
 */
export interface PurchaseClaims {
  claim(channel: Channel, transactionId: string, accountId: string): Promise<{ ok: true } | { ok: false; owner: string }>;
  owner(channel: Channel, transactionId: string): Promise<string | undefined>;
}

export class MemoryClaims implements PurchaseClaims {
  private readonly m = new Map<string, string>();
  async claim(channel: Channel, tx: string, account: string) {
    const k = `${channel}:${tx}`;
    const cur = this.m.get(k);
    if (cur !== undefined && cur !== account) return { ok: false as const, owner: cur };
    this.m.set(k, account);
    return { ok: true as const };
  }
  async owner(channel: Channel, tx: string) {
    return this.m.get(`${channel}:${tx}`);
  }
}

export class PurchaseError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** The account reference a store carries for an account (Apple wants a UUID
 * for appAccountToken; we derive one deterministically from the account id so
 * the app needs no extra round trip). */
export async function accountRefFor(accountId: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`splanc-account-ref\n${accountId}`)));
  d[6] = (d[6]! & 0x0f) | 0x50; // UUID v5-style version bits
  d[8] = (d[8]! & 0x3f) | 0x80;
  const h = [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * Credit a verified purchase to `accountId`. Checks the environment (a sandbox
 * build only accepts sandbox purchases and vice versa), the account binding,
 * the pack, and the global claim; the ledger credit is idempotent on
 * `<channel>:<transactionId>`, so a retry, a restore or a duplicate
 * notification credits once.
 */
export async function applyPurchase(opts: {
  ledger: Pick<Ledger, "credit">;
  claims: PurchaseClaims;
  pricing: PricingConfig;
  accountId: string;
  purchase: VerifiedPurchase;
  environment: StoreEnvironment;
}): Promise<{ entry: LedgerEntry; replay: boolean; first_purchase?: boolean }> {
  const { purchase: p, accountId } = opts;
  if (p.environment !== opts.environment) {
    throw new PurchaseError(400, "wrong_environment", `a ${p.environment} purchase on a ${opts.environment} server`);
  }
  if (p.accountRef !== (await accountRefFor(accountId))) {
    throw new PurchaseError(403, "wrong_account", "this purchase was made for another account");
  }
  const pack = findPack(opts.pricing, p.channel, p.sku);
  if (!pack) throw new PurchaseError(400, "unknown_product", `no enabled ${p.channel} pack ${p.sku}`);
  const c = await opts.claims.claim(p.channel, p.transactionId, accountId);
  if (!c.ok) throw new PurchaseError(409, "already_claimed", "this purchase already credited another account");
  return opts.ledger.credit("purchase", `${p.channel}:${p.transactionId}`, packCredits(opts.pricing, pack) * MICRO, {
    channel: p.channel,
    sku: p.sku,
    pricing_version: opts.pricing.version,
  });
}

/** Claw back a refunded purchase on the account that got it (idempotent). */
export async function applyRefund(opts: {
  ledgerFor: (accountId: string) => Pick<Ledger, "clawback">;
  claims: PurchaseClaims;
  refund: RefundNotice;
}): Promise<{ accountId: string; entry: LedgerEntry | null; replay: boolean } | null> {
  const owner = await opts.claims.owner(opts.refund.channel, opts.refund.transactionId);
  if (!owner) return null; // never credited (or not ours)
  const r = await opts.ledgerFor(owner).clawback(`${opts.refund.channel}:${opts.refund.transactionId}`, opts.refund.kind);
  return { accountId: owner, entry: r.entry, replay: r.replay };
}

// -- sandbox fakes ---------------------------------------------------------------------

/**
 * The sandbox stand-in for StoreKit / Stripe: a "receipt" is a JSON object
 * HMAC-signed with a TEST key (never a real key; the fake refuses to sign or
 * verify anything claiming to be production). Exercises every server-side
 * path without a store account.
 */
export class FakeStoreVerifier implements PurchaseVerifier, NotificationVerifier {
  constructor(
    readonly channel: Channel,
    private readonly testKey: string,
  ) {}

  private async mac(msg: string): Promise<string> {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.testKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
    return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** Make a signed fake receipt (tests / the sandbox app's "fake buy" button). */
  async sign(p: Omit<VerifiedPurchase, "channel" | "environment">): Promise<{ payload: string; sig: string }> {
    const payload = JSON.stringify({ ...p, channel: this.channel, environment: "sandbox" });
    return { payload, sig: await this.mac(payload) };
  }

  async signRefund(transactionId: string, kind: RefundNotice["kind"] = "refund"): Promise<{ body: string; sig: string }> {
    const body = JSON.stringify({ refund: { channel: this.channel, transactionId, kind, environment: "sandbox" } });
    return { body, sig: await this.mac(body) };
  }

  async verify(raw: unknown): Promise<VerifiedPurchase> {
    const r = raw as { payload?: unknown; sig?: unknown } | null;
    if (!r || typeof r.payload !== "string" || typeof r.sig !== "string") throw new PurchaseError(400, "bad_receipt", "{payload, sig} required");
    if ((await this.mac(r.payload)) !== r.sig) throw new PurchaseError(400, "bad_receipt", "signature does not verify");
    const p = JSON.parse(r.payload) as VerifiedPurchase;
    if (p.channel !== this.channel) throw new PurchaseError(400, "bad_receipt", "wrong channel");
    if (p.environment !== "sandbox") throw new PurchaseError(400, "bad_receipt", "the fake verifier only accepts sandbox purchases");
    return p;
  }

  async signConsumptionRequest(transactionId: string): Promise<{ body: string; sig: string }> {
    const body = JSON.stringify({ consumptionRequest: { channel: this.channel, transactionId, environment: "sandbox" } });
    return { body, sig: await this.mac(body) };
  }

  async parse(body: string, headers: Headers): Promise<StoreNotification | null> {
    if ((await this.mac(body)) !== headers.get("x-fake-signature")) throw new PurchaseError(400, "bad_notification", "signature does not verify");
    const n = JSON.parse(body) as { refund?: RefundNotice; consumptionRequest?: ConsumptionRequestNotice };
    if (n.refund && n.refund.environment === "sandbox") return { refund: n.refund };
    if (n.consumptionRequest && n.consumptionRequest.environment === "sandbox" && this.channel === "apple") {
      return { consumptionRequest: n.consumptionRequest };
    }
    return null;
  }
}
