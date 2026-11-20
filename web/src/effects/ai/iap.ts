/**
 * Buying Splanc AI credits with Apple In-App Purchase (the iOS app only;
 * docs/design/ai-billing.md §Purchases). StoreKit lives in the native plugin
 * (net/storeKit.ts); this module is the app logic around it:
 *
 * - the packs: the relay's "apple" packs (credits) joined with the App Store's
 *   products (Apple's localized price), in the relay's order;
 * - a purchase: StoreKit sheet with the account's appAccountToken -> the
 *   signed transaction to the relay (`POST /billing/purchase/apple`) -> finish
 *   it ONLY once the relay credited it;
 * - delivery in the background: Transaction.updates (Ask to Buy approved, a
 *   pending payment cleared) and, at every start, the transactions still
 *   unfinished (a crash or no network between paying and crediting).
 *
 * Finishing rules (StoreKit re-delivers an unfinished transaction at every
 * launch, so leaving one unfinished is how a purchase is never lost):
 * - finish when the relay credited it (201) or already had it (200 replay);
 * - finish when it was already credited to another account (409) or was
 *   refunded / revoked: nothing is owed on this device;
 * - otherwise keep it: signed out (401), bought for another account (403,
 *   e.g. before a restore), the relay unreachable or failing. It is sent again
 *   on the next start, or from "Check for App Store purchases".
 */

import { storeKit, storeKitAvailable, storeKitError, type StoreProduct, type StoreTransaction } from "../../net/storeKit";
import { CreditsApiError, aiCreditsEnabled, getCreditsSession, submitApplePurchase, type CreditPack } from "./providers/credits";

export interface IapPack extends CreditPack {
  product: StoreProduct;
}

/** The packs to offer: relay packs the App Store also sells, relay order. */
export async function loadIapPacks(relayPacks: CreditPack[]): Promise<IapPack[]> {
  if (relayPacks.length === 0) return [];
  let products: StoreProduct[];
  try {
    products = (await storeKit().products({ ids: relayPacks.map((p) => p.sku) })).products;
  } catch (e) {
    throw storeKitError(e);
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  return relayPacks.flatMap((p) => {
    const product = byId.get(p.sku);
    return product ? [{ ...p, product }] : [];
  });
}

export type Delivery =
  | { status: "credited"; credited: number; balance: number; replay: boolean }
  /** Nothing owed here (credited to another account, or refunded). */
  | { status: "settled" };

/** Relay error codes after which the transaction is finished anyway. */
const SETTLED = new Set(["already_claimed", "revoked"]);

const inflight = new Map<string, Promise<Delivery>>();

/** Send one transaction to the relay; finish it if nothing more is owed. */
export function deliverTransaction(t: StoreTransaction, fetchImpl: typeof fetch = fetch): Promise<Delivery> {
  const running = inflight.get(t.transactionId);
  if (running) return running;
  const p = (async (): Promise<Delivery> => {
    try {
      const r = await submitApplePurchase(t.jws, fetchImpl);
      await finish(t);
      return { status: "credited", credited: r.credited_credits, balance: r.balance_credits, replay: r.replay };
    } catch (e) {
      if (e instanceof CreditsApiError && SETTLED.has(e.code)) {
        await finish(t);
        return { status: "settled" };
      }
      throw e;
    }
  })().finally(() => inflight.delete(t.transactionId));
  inflight.set(t.transactionId, p);
  return p;
}

async function finish(t: StoreTransaction): Promise<void> {
  try {
    await storeKit().finish({ transactionId: t.transactionId });
  } catch {
    // Unfinished means "sent again later", and the relay credits once: harmless.
  }
}

export type BuyResult = { status: "credited"; credited: number; balance: number | null } | { status: "pending" } | { status: "cancelled" };

/**
 * Buy one pack: the App Store sheet, then credit. Throws StoreKitError (the
 * store refused or failed) or CreditsApiError (paid, but the relay didn't
 * credit yet: the transaction stays unfinished and is sent again later).
 */
export async function buyCreditPack(sku: string, accountRef: string, fetchImpl: typeof fetch = fetch): Promise<BuyResult> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountRef)) {
    throw new CreditsApiError(0, "no_account_ref", "Your Splanc AI account isn't ready for App Store purchases. Update the app and try again.");
  }
  let o;
  try {
    o = await storeKit().purchase({ productId: sku, appAccountToken: accountRef });
  } catch (e) {
    throw storeKitError(e);
  }
  if (o.status === "cancelled") return { status: "cancelled" };
  if (o.status !== "purchased") return { status: "pending" };
  const d = await deliverTransaction(o.transaction, fetchImpl);
  // "settled" right after paying would be odd (another account already had
  // it): report it as credited with nothing new rather than as a failure.
  return d.status === "credited" ? { status: "credited", credited: d.credited, balance: d.balance } : { status: "credited", credited: 0, balance: null };
}

/** Re-send every unfinished transaction; resolves with the credits added. */
export async function deliverUnfinished(fetchImpl: typeof fetch = fetch): Promise<{ credited: number; balance: number | null; failed: number }> {
  let txs: StoreTransaction[];
  try {
    txs = (await storeKit().unfinished()).transactions;
  } catch (e) {
    throw storeKitError(e);
  }
  let credited = 0;
  let balance: number | null = null;
  let failed = 0;
  for (const t of txs) {
    try {
      const d = await deliverTransaction(t, fetchImpl);
      if (d.status === "credited" && !d.replay) {
        credited += d.credited;
        balance = d.balance;
      }
    } catch {
      failed++;
    }
  }
  return { credited, balance, failed };
}

/** "Check for App Store purchases": sign in to the App Store if needed
 * (AppStore.sync), then re-send anything unfinished. */
export async function checkForPurchases(fetchImpl: typeof fetch = fetch): Promise<{ credited: number; balance: number | null; failed: number }> {
  try {
    await storeKit().sync();
  } catch (e) {
    const err = storeKitError(e);
    if (err.code === "cancelled") throw err;
    // A failed sync still leaves whatever StoreKit already has locally.
  }
  return deliverUnfinished(fetchImpl);
}

type Credited = (r: { credited: number; balance: number }) => void;
const listeners = new Set<Credited>();
/** Transactions already announced (StoreKit may hand one over twice). */
const announced = new Set<string>();
let started = false;

/** Be told when a background delivery adds credits (the account card, the flow). */
export function onIapCredited(cb: Credited): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function announce(id: string, d: Delivery): void {
  if (d.status !== "credited" || d.replay || d.credited <= 0 || announced.has(id)) return;
  announced.add(id);
  for (const cb of [...listeners]) cb({ credited: d.credited, balance: d.balance });
}

/**
 * At app start (iOS, credits on, signed in): listen for Transaction.updates
 * and re-send what's unfinished. Idempotent; a no-op elsewhere. `notify`
 * (e.g. a toast) is told about credits that arrive this way.
 */
export function startIapDelivery(notify?: Credited, fetchImpl: typeof fetch = fetch): boolean {
  if (started || !aiCreditsEnabled() || !storeKitAvailable()) return false;
  started = true;
  if (notify) listeners.add(notify);
  void storeKit()
    .addListener("transaction", (t) => {
      if (!getCreditsSession()) return; // kept unfinished until there's an account
      void deliverTransaction(t, fetchImpl).then((d) => announce(t.transactionId, d), () => {});
    })
    .catch(() => {});
  if (getCreditsSession()) {
    void storeKit()
      .unfinished()
      .then(async ({ transactions }) => {
        for (const t of transactions) await deliverTransaction(t, fetchImpl).then((d) => announce(t.transactionId, d), () => {});
      })
      .catch(() => {});
  }
  return true;
}

/** Tests only. */
export function resetIapForTests(): void {
  started = false;
  listeners.clear();
  inflight.clear();
  announced.clear();
}
