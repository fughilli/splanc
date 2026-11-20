/**
 * Apple In-App Purchase (StoreKit 2) for Splanc AI credits, via the
 * first-party Capacitor plugin @splanc/storekit-bridge
 * (native-plugins/storekit-bridge, JS name "StoreKitBridge"). iOS app only:
 * there, credits are sold through the App Store and never through the web
 * checkout (docs/design/ai-billing.md). Bound through the injected Capacitor
 * global (no @capacitor/core import), like the other first-party bridges.
 */

import { isIosNative, registerNativePlugin } from "./native";

/** A credit pack as the App Store sells it (Apple's localized price). */
export interface StoreProduct {
  id: string;
  displayName: string;
  description: string;
  /** Apple's formatted local price, e.g. "$4.99" or "4,99 €". */
  displayPrice: string;
  price: number;
  currencyCode: string;
}

/** A verified StoreKit transaction; `jws` is what the relay checks. */
export interface StoreTransaction {
  transactionId: string;
  originalTransactionId: string;
  productId: string;
  jws: string;
  revoked?: boolean;
}

export type PurchaseOutcome =
  | { status: "purchased"; transaction: StoreTransaction }
  /** Ask to Buy, or a payment that needs another step: it completes later
   * and arrives as a `transaction` event. */
  | { status: "pending" }
  | { status: "cancelled" };

export interface StoreKitPlugin {
  products(opts: { ids: string[] }): Promise<{ products: StoreProduct[] }>;
  purchase(opts: { productId: string; appAccountToken: string }): Promise<PurchaseOutcome>;
  finish(opts: { transactionId: string }): Promise<{ finished: boolean }>;
  unfinished(): Promise<{ transactions: StoreTransaction[] }>;
  sync(): Promise<void>;
  canMakePayments(): Promise<{ allowed: boolean }>;
  addListener(event: "transaction", cb: (t: StoreTransaction) => void): Promise<{ remove: () => Promise<void> }>;
}

export const STOREKIT_PLUGIN = "StoreKitBridge";

let override: StoreKitPlugin | null = null;
let bound: StoreKitPlugin | null = null;

/** Tests / screenshots: use a fake plugin (null restores the real one). */
export function setStoreKitPluginForTests(p: StoreKitPlugin | null): void {
  override = p;
  bound = null;
}

/** True inside an iOS app build that contains the StoreKit plugin (an older
 * build without it keeps credits hidden). */
export function storeKitAvailable(): boolean {
  if (override) return true;
  if (!isIosNative()) return false;
  const cap = (globalThis as { Capacitor?: { isPluginAvailable?: (name: string) => boolean } }).Capacitor;
  return cap?.isPluginAvailable?.(STOREKIT_PLUGIN) === true;
}

export function storeKit(): StoreKitPlugin {
  if (override) return override;
  if (!bound) bound = registerNativePlugin<StoreKitPlugin>(STOREKIT_PLUGIN);
  return bound;
}

/** A StoreKit failure with the plugin's stable code ("network",
 * "not_allowed", "unavailable", "unverified", "failed"). */
export class StoreKitError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "StoreKitError";
  }
}

export function storeKitError(e: unknown): StoreKitError {
  if (e instanceof StoreKitError) return e;
  const code = typeof (e as { code?: unknown })?.code === "string" ? String((e as { code: string }).code) : "failed";
  return new StoreKitError(code, storeKitMessage(code));
}

/** Plain-language text for each code (Apple's own text is not shown). */
export function storeKitMessage(code: string): string {
  switch (code) {
    case "network":
      return "Can't reach the App Store right now. Check your connection and try again.";
    case "not_allowed":
      return "Purchases aren't allowed on this device. Check Screen Time ▸ Content & Privacy Restrictions.";
    case "unavailable":
      return "This credit pack isn't available in your country's App Store right now.";
    case "unverified":
      return "The App Store couldn't verify this purchase. You haven't been given credits for it; if you were charged, contact Apple support.";
    default:
      return "The App Store purchase didn't go through. Please try again.";
  }
}
