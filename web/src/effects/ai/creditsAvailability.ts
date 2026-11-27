/**
 * Is "Splanc AI credits" switched on for this device? (D-149,
 * docs/ops/billing-go-live.md.)
 *
 * The flag `localStorage["splanc.flags.aiCredits"]` is now an override:
 *   "1"   forced on (sandbox testing, the TestFlight debug toggle, the smoke test);
 *   "0"   forced off;
 *   unset (everyone): ON where the relay really sells credits on this platform,
 *         i.e. its last `GET /billing/pricing?channel=<this platform>` said
 *         `environment: "production"` and listed at least one pack. A device
 *         that already holds a production session also keeps its account.
 *
 * So the web and Android see credits once the relay is in Stripe live mode,
 * and never while it's in the sandbox (test money). The iOS app sees them only
 * once the production pricing enables an Apple pack, which happens only after
 * the App Store products exist (`billing_go_live.mjs --apple-packs on`). Until
 * then the relay lists no Apple pack and iOS shows nothing. iOS never shows the
 * web checkout either way (providers/credits.ts `mayShowWebCheckout`).
 *
 * The answer is cached (it must be synchronous for rendering) and refreshed at
 * app start by `refreshCreditsAvailability()`. This module stays tiny and
 * import-free (bar the native check) so tiers.ts can use it without pulling in
 * the credits provider.
 */

import { isIosNative } from "../../net/native";

/** localStorage key of the override ("1" on, "0" off, unset = automatic). */
export const AI_CREDITS_FLAG = "splanc.flags.aiCredits";
const AVAILABILITY = "splanc.aiCredits.availability";
const SESSION = "splanc.aiCredits.session";
const RELAY_OVERRIDE = "splanc.aiCredits.relay";
/** The relay origin (the same one bug / feedback reports go to). */
export const CREDITS_RELAY = "https://splanc.pages.dev";
/** Fired on window when a refresh changes `aiCreditsEnabled()`. */
export const CREDITS_AVAILABILITY_EVENT = "splanc:credits-availability";

const ls = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Where credits are bought on this platform: Apple IAP inside the iOS app,
 * the web checkout everywhere else (owner decision 2026-11-18). */
export function purchaseChannel(): "apple" | "web" {
  return isIosNative() ? "apple" : "web";
}

export function creditsRelay(): string {
  return (ls()?.getItem(RELAY_OVERRIDE) || CREDITS_RELAY).replace(/\/+$/, "");
}

/** What the relay last said about this platform (cached). */
export interface CreditsAvailability {
  /** "production" | "sandbox"; null = billing off (503). */
  environment: string | null;
  channel: "apple" | "web";
  /** Enabled packs on sale for `channel`. */
  packs: number;
  at: number;
}

export function creditsAvailability(): CreditsAvailability | null {
  try {
    const a = JSON.parse(ls()?.getItem(AVAILABILITY) ?? "null") as CreditsAvailability | null;
    return a && typeof a.packs === "number" && (a.channel === "apple" || a.channel === "web") ? a : null;
  } catch {
    return null;
  }
}

/** The packs a pricing body really sells here: the relay leaves disabled ones
 * out already; a pack marked `enabled: false`, or one for another channel, is
 * dropped as well, so a disabled Apple pack never shows. */
export function packsOnSale<P extends { channel?: string; enabled?: boolean }>(packs: unknown, channel = purchaseChannel()): P[] {
  if (!Array.isArray(packs)) return [];
  return (packs as P[]).filter((p) => p && p.enabled !== false && (p.channel === undefined || p.channel === channel));
}

/** Remember what a `GET /billing/pricing` answered (null body = billing off). */
export function noteCreditsPricing(body: { environment?: unknown; packs?: unknown } | null, channel = purchaseChannel()): void {
  const st = ls();
  if (!st) return;
  const before = aiCreditsEnabled();
  const a: CreditsAvailability = {
    environment: body && typeof body.environment === "string" ? body.environment : null,
    channel,
    packs: body ? packsOnSale(body.packs, channel).length : 0,
    at: Date.now(),
  };
  try {
    st.setItem(AVAILABILITY, JSON.stringify(a));
  } catch {
    return;
  }
  if (aiCreditsEnabled() !== before && typeof globalThis.dispatchEvent === "function" && typeof Event === "function") {
    globalThis.dispatchEvent(new Event(CREDITS_AVAILABILITY_EVENT));
  }
}

/** Credits are really on sale on this platform (production, with a pack). */
export function creditsOnSale(): boolean {
  const a = creditsAvailability();
  return a !== null && a.environment === "production" && a.channel === purchaseChannel() && a.packs > 0;
}

/** Is the Splanc AI credits option enabled on this device? */
export function aiCreditsEnabled(): boolean {
  const flag = ls()?.getItem(AI_CREDITS_FLAG);
  if (flag === "1") return true;
  if (flag === "0") return false;
  if (creditsOnSale()) return true;
  // A production account already on this device keeps working (its balance,
  // the statement, deletion) even while no pack is on sale here.
  return creditsAvailability()?.environment === "production" && ls()?.getItem(SESSION) != null;
}

/** Ask the relay whether credits are on sale here, and cache it. Never throws;
 * offline or an unexpected answer keeps the last cached value. Returns
 * `aiCreditsEnabled()` afterwards. */
export async function refreshCreditsAvailability(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const channel = purchaseChannel();
  try {
    const r = await fetchImpl(`${creditsRelay()}/billing/pricing?channel=${channel}`);
    if (r.status === 503) noteCreditsPricing(null, channel);
    else if (r.ok) {
      const b = (await r.json().catch(() => undefined)) as { environment?: unknown; packs?: unknown } | null | undefined;
      if (b && typeof b === "object") noteCreditsPricing(b, channel);
    }
  } catch {
    // offline: keep the cached answer
  }
  return aiCreditsEnabled();
}
