/**
 * "Splanc AI credits" (docs/design/ai-billing.md): Claude through OUR metered
 * proxy on the relay, paid with prepaid credits, instead of the user's own key.
 *
 * BEHIND A FLAG, OFF BY DEFAULT: nothing here runs, and the provider is not
 * offered in AI settings, unless `localStorage["splanc.flags.aiCredits"]` is
 * "1" (a developer / sandbox switch until the staged rollout).
 *
 * The app holds only a SESSION TOKEN for its credit account. It never sees an
 * Anthropic key: the relay adds ours server-side. The request body is the same
 * one the BYO-key provider sends (messagesRequestBody), so both paths behave
 * alike; the reply is the same Anthropic event stream plus one
 * `splanc_billing` event with the charge and the new balance.
 *
 * Purchases: the iOS app buys Apple consumables (StoreKit 2, effects/ai/iap.ts)
 * and never shows or links to the web checkout; every other platform (browser
 * PWA, Android) uses the web checkout (Stripe). Credits live on the server
 * account, so they work on every platform the account signs in on.
 */

import { isIosNative } from "../../../net/native";
import { storeKitAvailable } from "../../../net/storeKit";
import type { AiProvider, ChatMessage, SendOptions, SendResult } from "../provider";
import { consumeChatStream, messagesRequestBody } from "./anthropic";

/**
 * The integration surface for other UI (e.g. the first-run model picker's
 * "paid" tier, docs/design/ai-tiers.md): select the paid tier with
 * `updateAiConfig({ kind: CREDITS_KIND })` when `aiCreditsEnabled()`; the rest
 * (sign-in, balance, buying) lives here. Keep these names stable.
 */
export const CREDITS_KIND = "credits" as const;
export const CREDITS_LABEL = "Splanc AI credits";
/** localStorage key of the feature flag ("1" = on). Off by default. */
export const AI_CREDITS_FLAG = "splanc.flags.aiCredits";
const FLAG = AI_CREDITS_FLAG;
const SESSION = "splanc.aiCredits.session";
const RELAY_OVERRIDE = "splanc.aiCredits.relay";
/** The relay origin (the same one bug / feedback reports go to). */
export const CREDITS_RELAY = "https://splanc.pages.dev";
export const DEFAULT_CREDITS_MODEL = "claude-sonnet-5-5";

const ls = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Is the Splanc AI credits option enabled on this device? (Default: no.) */
export function aiCreditsEnabled(): boolean {
  return ls()?.getItem(FLAG) === "1";
}

/** Where credits are bought on this platform: Apple IAP inside the iOS app,
 * the web checkout everywhere else (owner decision 2026-11-18). */
export function purchaseChannel(): "apple" | "web" {
  return isIosNative() ? "apple" : "web";
}

/** May this platform show a link to the web checkout? Never inside the iOS
 * app (App Store rules: it sells credits through In-App Purchase only). */
export function mayShowWebCheckout(): boolean {
  return purchaseChannel() === "web";
}

export function creditsRelay(): string {
  return (ls()?.getItem(RELAY_OVERRIDE) || CREDITS_RELAY).replace(/\/+$/, "");
}

export interface CreditsSession {
  account_id: string;
  token: string;
}

export function getCreditsSession(): CreditsSession | null {
  try {
    const s = JSON.parse(ls()?.getItem(SESSION) ?? "null") as CreditsSession | null;
    return s && typeof s.token === "string" && typeof s.account_id === "string" ? s : null;
  } catch {
    return null;
  }
}

export function setCreditsSession(s: CreditsSession | null): void {
  const st = ls();
  if (!st) return;
  if (s) st.setItem(SESSION, JSON.stringify(s));
  else st.removeItem(SESSION);
}

export interface CreditsBalance {
  balance_credits: number;
  available_credits: number;
  held_credits: number;
  low: boolean;
  status: string;
  /** The account confirmed 18+ (buying credits is 18+). */
  adult: boolean;
  /** Opted in to sharing consumption data with Apple on refund requests. */
  apple_consumption_consent?: boolean;
  /** The user answered that question (yes or no); the iOS flow asks once. */
  apple_consumption_asked?: boolean;
  /** StoreKit's appAccountToken for this account (a UUID). */
  account_ref?: string;
  /** The recovery e-mail, masked by the server ("k•••@gmail.com"), when one
   * is set (PR #557). */
  email_hint?: string | null;
  email_verified?: boolean;
  /** When the user chose "Continue anonymously" (null: never). */
  anonymous_ack_at?: string | null;
}

/** The balance shown in AI settings and under the chat (STUB until the relay
 * route is deployed: null when off, signed out or unreachable). */
export async function fetchCreditsBalance(fetchImpl: typeof fetch = fetch): Promise<CreditsBalance | null> {
  const s = getCreditsSession();
  if (!aiCreditsEnabled() || !s) return null;
  try {
    const r = await fetchImpl(`${creditsRelay()}/billing/balance`, { headers: { authorization: `Bearer ${s.token}` } });
    return r.ok ? ((await r.json()) as CreditsBalance) : null;
  } catch {
    return null;
  }
}

/** The balance, or why there is none: `signedOut` = the server no longer
 * knows this device's session (401: restored on another device, or the
 * account was deleted), so the UI offers "Restore account". */
export type BalanceResult = { balance: CreditsBalance } | { signedOut: true } | { unreachable: true } | { none: true };

export async function loadCreditsBalance(fetchImpl: typeof fetch = fetch): Promise<BalanceResult> {
  const s = getCreditsSession();
  if (!aiCreditsEnabled() || !s) return { none: true };
  try {
    const r = await fetchImpl(`${creditsRelay()}/billing/balance`, { headers: { authorization: `Bearer ${s.token}` } });
    if (r.status === 401) return { signedOut: true };
    return r.ok ? { balance: (await r.json()) as CreditsBalance } : { unreachable: true };
  } catch {
    return { unreachable: true };
  }
}

/** The session was revoked / the account deleted (401 anywhere). */
export function isSignedOut(e: unknown): boolean {
  return e instanceof CreditsApiError && e.status === 401;
}

/** Forget this device's (dead) session so the user can restore or start over. */
export function forgetCreditsSession(): void {
  setCreditsSession(null);
  ls()?.removeItem(EMAIL_KEY);
}

// -- account lifecycle (owner decisions 2026-11-18) ------------------------------------
//
// Accounts start ANONYMOUS and device-bound (no sign-in needed to look); they
// can be linked later to Sign in with Apple or Google (no e-mail login). There
// is no free credit: the free tier covers trying the AI. Buying is 18+.
// Deleting the account forfeits any credit left, after a clear warning.

export const SIGN_IN_PROVIDERS = ["apple", "google"] as const;

export const ADULT_CONFIRM_TEXT = "Buying Splanc AI credits is for adults. Please confirm you are 18 or older.";

export const DELETE_ACCOUNT_WARNING =
  "Deleting your Splanc AI account can't be undone. Any credits left on it are lost and are not refunded.";

const authed = (s: CreditsSession) => ({ authorization: `Bearer ${s.token}` });

/** Create an anonymous, device-bound credit account and keep its session. */
export async function createCreditsAccount(fetchImpl: typeof fetch = fetch): Promise<CreditsSession> {
  const r = await fetchImpl(`${creditsRelay()}/billing/account`, { method: "POST" });
  const b = (await r.json().catch(() => null)) as { account_id?: string; token?: string; message?: string } | null;
  if (!r.ok || !b?.account_id || !b.token) throw new Error(creditsErrorMessage(r.status, b));
  const s = { account_id: b.account_id, token: b.token };
  setCreditsSession(s);
  return s;
}

/** Record the user's 18+ confirmation (call after they confirm ADULT_CONFIRM_TEXT). */
export async function confirmAdult(fetchImpl: typeof fetch = fetch): Promise<void> {
  const s = getCreditsSession();
  if (!s) throw new Error("Sign in to use Splanc AI credits.");
  const r = await fetchImpl(`${creditsRelay()}/billing/age`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(s) },
    body: JSON.stringify({ confirm: true }),
  });
  if (!r.ok) throw new Error(creditsErrorMessage(r.status, (await r.json().catch(() => null)) as { message?: string } | null));
}

/** Apple refund requests (iOS only): with the user's opt-in, Splanc tells Apple
 * how much of a credit pack was used when the user asks Apple for a refund
 * (App Store Server API "Send Consumption Information"). Asked in the purchase
 * flow and changeable in AI settings; off until the user says yes. */
export const APPLE_CONSUMPTION_CONSENT_TEXT =
  "If you ask Apple for a refund of a credit pack, may Splanc tell Apple how much of that pack you've used? " +
  "This helps Apple decide the refund. You can change this any time in AI settings.";

export async function setAppleConsumptionConsent(consented: boolean, fetchImpl: typeof fetch = fetch): Promise<void> {
  const s = getCreditsSession();
  if (!s) throw new Error("Sign in to use Splanc AI credits.");
  const r = await fetchImpl(`${creditsRelay()}/billing/consent`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(s) },
    body: JSON.stringify({ apple_consumption: consented }),
  });
  if (!r.ok) throw new Error(creditsErrorMessage(r.status, (await r.json().catch(() => null)) as { message?: string } | null));
}

// -- Apple In-App Purchase: the iOS app only (effects/ai/iap.ts drives StoreKit) --------

/** Credit a StoreKit 2 transaction (its signed `jwsRepresentation`). 201 =
 * credited now; 200 with `replay` = it already was. */
export async function submitApplePurchase(
  jws: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ credited_credits: number; balance_credits: number; replay: boolean }> {
  return billingCall("/billing/purchase/apple", { method: "POST", body: { jws }, auth: true }, fetchImpl);
}

// -- web checkout (Stripe): the PWA in a browser and on Android, NEVER iOS ------------

export interface CreditPack {
  sku: string;
  credits: number;
  /** The reference (US) price; web packs only. Stripe Checkout shows the final
   * price with tax. */
  reference_price_usd?: number;
}

/** The packs this platform sells (the relay's public pricing view). */
export async function fetchCreditPacks(fetchImpl: typeof fetch = fetch): Promise<CreditPack[]> {
  const r = await fetchImpl(`${creditsRelay()}/billing/pricing?channel=${purchaseChannel()}`);
  if (!r.ok) return [];
  const b = (await r.json().catch(() => null)) as { packs?: CreditPack[] } | null;
  return Array.isArray(b?.packs) ? b.packs : [];
}

/** Where Stripe sends the user back: the credits flow's return screen
 * (`#/credits/return`, which reads `?checkout=success|cancel`). */
export const CHECKOUT_RETURN_ROUTE = "#/credits/return";
export function checkoutReturnUrl(loc: { origin: string; pathname: string } = location): string {
  return `${loc.origin}${loc.pathname}${CHECKOUT_RETURN_ROUTE}`;
}

/**
 * Start a web checkout for `sku` and return the Stripe Checkout URL to open.
 * Refuses inside the iOS app (In-App Purchase only there). The caller
 * navigates to the URL (the same tab: Stripe returns to the credits flow).
 */
export async function startWebCheckout(sku: string, fetchImpl: typeof fetch = fetch, loc?: { origin: string; pathname: string }): Promise<string> {
  if (!mayShowWebCheckout()) throw new Error("Credits are bought through the App Store in the iOS app.");
  const s = getCreditsSession();
  if (!s) throw new Error("Sign in to use Splanc AI credits.");
  const r = await fetchImpl(`${creditsRelay()}/billing/checkout`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authed(s) },
    body: JSON.stringify({ sku, return_url: checkoutReturnUrl(loc) }),
  });
  const b = (await r.json().catch(() => null)) as { url?: string; message?: string } | null;
  if (!r.ok || typeof b?.url !== "string" || !b.url.startsWith("https://checkout.stripe.com/")) {
    throw new Error(creditsErrorMessage(r.status, b));
  }
  return b.url;
}

/** After Stripe sends the user back: "success" | "cancel" | null, read from
 * `?checkout=` (and removed from the address bar so a reload doesn't repeat it). */
export function takeCheckoutResult(): "success" | "cancel" | null {
  try {
    const u = new URL(location.href);
    const v = u.searchParams.get("checkout");
    if (v !== "success" && v !== "cancel") return null;
    u.searchParams.delete("checkout");
    u.searchParams.delete("session_id");
    history.replaceState(history.state, "", u.href);
    return v;
  } catch {
    return null;
  }
}

/** May the Buy button show? Only for a confirmed adult. */
export function mayBuyCredits(b: CreditsBalance | null): boolean {
  return b !== null && b.adult === true && b.status === "active";
}

/** Delete the account (the iOS in-app deletion requirement). Show
 * DELETE_ACCOUNT_WARNING and get a confirmation first. */
export async function deleteCreditsAccount(fetchImpl: typeof fetch = fetch): Promise<void> {
  const s = getCreditsSession();
  if (!s) return;
  const r = await fetchImpl(`${creditsRelay()}/billing/account`, { method: "DELETE", headers: authed(s) });
  if (!r.ok && r.status !== 401) throw new Error(creditsErrorMessage(r.status, (await r.json().catch(() => null)) as { message?: string } | null));
  forgetCreditsSession();
}

/** "1,234.5 credits" — the one place credits are formatted. */
export function formatCredits(n: number): string {
  const v = Math.floor(n * 10) / 10;
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })} credits`;
}

/** The friendly message for a refusal the proxy sent (402/403/429/503). */
export function creditsErrorMessage(status: number, body: { error?: string; message?: string } | null): string {
  if (status === 401) return "This device is signed out of your Splanc AI account. Restore it in Settings ▸ AI.";
  if (body?.message) return body.message;
  if (status === 402) return "You're out of Splanc AI credits. Buy more in Settings ▸ AI.";
  return `Splanc AI is unavailable right now (${status}).`;
}

/** Watches the stream for the proxy's `splanc_billing` event, passing every
 * byte through unchanged to the shared Anthropic stream parser. */
function sniffBilling(body: ReadableStream<Uint8Array>, onBilling: (ev: { charged_credits: number; balance_credits: number }) => void): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  let buf = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, ctl) {
        buf += dec.decode(chunk, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const f of frames) {
          const m = /^data: (.*splanc_billing.*)$/m.exec(f);
          if (m) {
            try {
              onBilling(JSON.parse(m[1]!) as { charged_credits: number; balance_credits: number });
            } catch {
              // ignore a malformed billing event
            }
          }
        }
        ctl.enqueue(chunk);
      },
    }),
  );
}

export interface CreditsProviderConfig {
  model: string;
  /** Live balance after each request (the `splanc_billing` event). */
  onBilling?: ((ev: { charged_credits: number; balance_credits: number }) => void) | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export function makeCreditsProvider(cfg: CreditsProviderConfig): AiProvider {
  return {
    id: "credits",
    capabilities: { tools: true, vision: true },
    async send(messages: ChatMessage[], opts: SendOptions): Promise<SendResult> {
      if (!aiCreditsEnabled()) throw new Error("Splanc AI credits are not enabled on this device.");
      const s = getCreditsSession();
      if (!s) throw new Error("Sign in to use Splanc AI credits.");
      const resp = await (cfg.fetchImpl ?? fetch)(`${creditsRelay()}/ai/v1/messages`, {
        method: "POST",
        // Only our session token: there is no Anthropic key on this path.
        headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
        signal: opts.signal ?? null,
        body: JSON.stringify(messagesRequestBody(cfg.model || DEFAULT_CREDITS_MODEL, messages, opts)),
      });
      if (!resp.ok || resp.body === null) {
        const body = (await resp.json().catch(() => null)) as { error?: string; message?: string } | null;
        throw new CreditsApiError(resp.status, body?.error ?? "", creditsErrorMessage(resp.status, body));
      }
      const onBilling = (ev: { charged_credits: number; balance_credits: number }): void => {
        noteBilling(ev);
        cfg.onBilling?.(ev);
      };
      const stream = sniffBilling(resp.body, onBilling);
      return consumeChatStream(stream, opts.stream);
    },
  };
}


// -- typed errors -------------------------------------------------------------------

/** A refusal from the billing API, with the HTTP status and the server's
 * error code (`{error, message}`), so the UI can react to the kind (out of
 * credit, wrong code, too many tries) instead of parsing text. */
export class CreditsApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds to wait before trying again (429 `retry_after_s`), when sent. */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "CreditsApiError";
  }
}

/** The proxy refused for lack of credit (402): offer to buy more. */
export function isOutOfCredits(e: unknown): boolean {
  return e instanceof CreditsApiError && e.status === 402;
}

async function billingCall<T>(
  path: string,
  init: { method: string; body?: unknown; auth?: boolean },
  fetchImpl: typeof fetch,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.auth) {
    const s = getCreditsSession();
    if (!s) throw new CreditsApiError(401, "unauthorized", "Sign in to use Splanc AI credits.");
    Object.assign(headers, authed(s));
  }
  let r: Response;
  try {
    r = await fetchImpl(`${creditsRelay()}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw new CreditsApiError(0, "network", "Can't reach Splanc right now. Check your connection and try again.");
  }
  const b = (await r.json().catch(() => null)) as (T & { error?: string; message?: string; retry_after_s?: number }) | null;
  if (!r.ok) {
    const code = b?.error ?? "";
    throw new CreditsApiError(r.status, code, codeMessage(r.status, code) ?? creditsErrorMessage(r.status, b), b?.retry_after_s);
  }
  return (b ?? {}) as T;
}

/** Plain-language messages for the e-mail / code errors (server codes are
 * assumed: invalid_email, invalid_code, expired_code, too_many_attempts,
 * rate_limited). */
function codeMessage(status: number, code: string): string | null {
  switch (code) {
    case "invalid_email":
      return "That doesn't look like an e-mail address. Check it and try again.";
    // The server answers every code failure the same way (wrong, expired,
    // used, too many tries: anti-enumeration), so the message covers them all.
    case "invalid_code":
    case "expired_code":
    case "too_many_attempts":
      return "That code didn't work. Check the latest email or request a new code.";
    case "email_in_use":
      return "That email already belongs to another Splanc AI account. To use those credits here, restore that account instead.";
    case "rate_limited":
      return "Too many codes sent. Wait a minute, then try again.";
    // App Store purchases (POST /billing/purchase/apple).
    case "wrong_account":
      return "This App Store purchase belongs to another Splanc AI account. Restore that account on this device and its credits arrive.";
    case "wrong_environment":
      return "This purchase was made in a different App Store environment (for example a TestFlight build) and can't be used here.";
    case "bad_receipt":
    case "unknown_product":
    case "unsupported_quantity":
      return "Splanc couldn't confirm this App Store purchase, so no credits were added. If you were charged, you can ask Apple for a refund at reportaproblem.apple.com.";
  }
  if (status === 429) return "Too many tries. Wait a minute, then try again.";
  return null;
}

// -- recovery e-mail (owner 2026-11-18: optional; recovers credits on a new device) --

const EMAIL_KEY = "splanc.aiCredits.email";
const EMAIL_DECLINED_KEY = "splanc.aiCredits.emailDeclined";
/** Default wait before "Resend code" when the server doesn't say. */
export const DEFAULT_RESEND_S = 30;

export function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

/** "kevin@example.com" -> "k•••@example.com" (what the app shows). */
export function maskEmail(email: string): string {
  const e = email.trim();
  const at = e.lastIndexOf("@");
  if (at < 1) return e;
  if (e.slice(0, at).includes("•")) return e; // already masked by the server
  return `${e[0]}•••${e.slice(at)}`;
}

/** The verified recovery e-mail this device knows (masked for display):
 * the server's view when the balance carried one, else the local copy. */
export function creditsEmail(b?: CreditsBalance | null): string | null {
  if (b) {
    if (typeof b.email_hint === "string" && b.email_hint && b.email_verified !== false) return maskEmail(b.email_hint);
    // The server's view wins once it says there's no e-mail (removed elsewhere).
    if (b.email_verified === false || b.email_hint === null) return null;
  }
  const local = ls()?.getItem(EMAIL_KEY);
  return local ? maskEmail(local) : null;
}

/** The user chose "Continue without email" (so the buy flow doesn't ask again). */
export function emailDeclined(b?: CreditsBalance | null): boolean {
  return ls()?.getItem(EMAIL_DECLINED_KEY) === "1" || (typeof b?.anonymous_ack_at === "string" && b.anonymous_ack_at !== "");
}
export function setEmailDeclined(v: boolean): void {
  if (v) ls()?.setItem(EMAIL_DECLINED_KEY, "1");
  else ls()?.removeItem(EMAIL_DECLINED_KEY);
}

/** Send a one-time code to `email` to link it to this account. The server
 * always answers 202 (an address that belongs to another account gets a "use
 * Restore instead" e-mail); a taken address shows up as 409 at verify. */
export async function startEmailLink(email: string, fetchImpl: typeof fetch = fetch): Promise<{ resendAfterS: number }> {
  if (!isValidEmail(email)) throw new CreditsApiError(400, "invalid_email", codeMessage(400, "invalid_email")!);
  const b = await billingCall<{ resend_after_s?: number }>("/billing/account/email", { method: "POST", auth: true, body: { email: email.trim() } }, fetchImpl);
  return { resendAfterS: b.resend_after_s ?? DEFAULT_RESEND_S };
}

/** Check the code; on success the e-mail is the account's recovery address. */
export async function verifyEmailLink(email: string, code: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await billingCall("/billing/account/email/verify", { method: "POST", auth: true, body: { email: email.trim(), code: code.trim() } }, fetchImpl);
  ls()?.setItem(EMAIL_KEY, email.trim());
  setEmailDeclined(false);
}

/** "Continue anonymously": record that the user was told credits can't be
 * recovered without an e-mail (POST /billing/account/anonymous). */
export async function acknowledgeAnonymous(fetchImpl: typeof fetch = fetch): Promise<void> {
  await billingCall("/billing/account/anonymous", { method: "POST", auth: true, body: { acknowledge: true } }, fetchImpl);
  setEmailDeclined(true);
}

/** Remove the recovery e-mail (after a warning: recovery won't be possible). */
export async function removeRecoveryEmail(fetchImpl: typeof fetch = fetch): Promise<void> {
  await billingCall("/billing/account/email", { method: "DELETE", auth: true }, fetchImpl);
  ls()?.removeItem(EMAIL_KEY);
}

/** Restore on a new device, step 1: the server answers the same whether or not
 * the address has an account (no account probing). */
export async function startRecovery(email: string, fetchImpl: typeof fetch = fetch): Promise<{ resendAfterS: number }> {
  if (!isValidEmail(email)) throw new CreditsApiError(400, "invalid_email", codeMessage(400, "invalid_email")!);
  const b = await billingCall<{ resend_after_s?: number }>("/billing/recover/start", { method: "POST", body: { email: email.trim() } }, fetchImpl);
  return { resendAfterS: b.resend_after_s ?? DEFAULT_RESEND_S };
}

/** Restore, step 2: the code proves the address; the account's session is
 * kept on this device and its balance returned. Other devices signed in to
 * the account are signed out (the server's default; their token gets 401). */
export async function verifyRecovery(email: string, code: string, fetchImpl: typeof fetch = fetch): Promise<{ balanceCredits: number }> {
  const b = await billingCall<{ token?: string; account_ref?: string; account_id?: string; balance_credits?: number }>(
    "/billing/recover/verify",
    { method: "POST", body: { email: email.trim(), code: code.trim() } },
    fetchImpl,
  );
  if (!b.token) throw new CreditsApiError(500, "bad_response", "Splanc AI is unavailable right now. Try again in a minute.");
  setCreditsSession({ account_id: b.account_id ?? b.account_ref ?? "", token: b.token });
  ls()?.setItem(EMAIL_KEY, email.trim());
  setEmailDeclined(false);
  return { balanceCredits: b.balance_credits ?? 0 };
}

// -- statement + public pricing --------------------------------------------------------

export interface StatementEntry {
  at: string;
  kind: string;
  credits: number;
  balance_credits: number;
  model?: string;
  sku?: string;
}

/** The newest ledger entries (numbers only: no prompt text is ever stored). */
export async function fetchCreditsStatement(fetchImpl: typeof fetch = fetch): Promise<StatementEntry[]> {
  const b = await billingCall<{ entries?: StatementEntry[] }>("/billing/statement", { method: "GET", auth: true }, fetchImpl);
  return Array.isArray(b.entries) ? b.entries : [];
}

/** A statement entry in words ("Credits bought", "AI request", …). */
export function statementLabel(e: StatementEntry): string {
  switch (e.kind) {
    case "purchase":
      return "Credits bought";
    case "usage":
      return "AI request";
    case "refund":
      return "Refund";
    case "forfeit":
      return "Account closed";
    case "trial":
      return "Starter credit";
    case "adjust":
      return "Adjustment";
    default:
      return e.kind;
  }
}

export interface PublicPricing {
  credits_per_usd: number;
  low_balance_credits: number;
  packs: CreditPack[];
}

/** The relay's public pricing view for this platform (null when unreachable). */
export async function fetchCreditsPricing(fetchImpl: typeof fetch = fetch): Promise<PublicPricing | null> {
  try {
    const r = await fetchImpl(`${creditsRelay()}/billing/pricing?channel=${purchaseChannel()}`);
    if (!r.ok) return null;
    const b = (await r.json()) as Partial<PublicPricing> | null;
    return {
      credits_per_usd: typeof b?.credits_per_usd === "number" ? b.credits_per_usd : 100,
      low_balance_credits: typeof b?.low_balance_credits === "number" ? b.low_balance_credits : 50,
      packs: Array.isArray(b?.packs) ? b.packs : [],
    };
  } catch {
    return null;
  }
}

/** One editor ask on the default model costs roughly this many credits
 * (docs/design/ai-billing.md: an estimate, 2–4 tool rounds on Sonnet 5.5). */
export const TYPICAL_PROMPT_CREDITS = { min: 3, max: 12 } as const;

/** "about 70–280 prompts" for a pack of `credits`, rounded to friendly numbers. */
export function promptsFor(credits: number): { min: number; max: number } {
  const nice = (n: number) => (n >= 100 ? Math.round(n / 10) * 10 : n >= 20 ? Math.round(n / 5) * 5 : Math.max(1, Math.round(n)));
  return { min: nice(credits / TYPICAL_PROMPT_CREDITS.max), max: nice(credits / TYPICAL_PROMPT_CREDITS.min) };
}

/** "$10" / "$9.99" for a US-dollar amount. */
export function formatUsd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

// -- the live balance the chat last saw (from `splanc_billing`) -------------------------

let lastBilling: { charged_credits: number; balance_credits: number; at: number } | null = null;
function noteBilling(ev: { charged_credits: number; balance_credits: number }): void {
  lastBilling = { ...ev, at: Date.now() };
}
/** The balance after the newest metered request this session (null: none yet). */
export function lastKnownBalance(): number | null {
  return lastBilling ? lastBilling.balance_credits : null;
}

/** Credits are shown on this device: the flag is on, and inside the iOS app
 * only when the build has the StoreKit plugin (iOS sells through Apple
 * In-App Purchase, never the web flow; an older build keeps them hidden). */
export function creditsVisible(): boolean {
  return aiCreditsEnabled() && (!isIosNative() || storeKitAvailable());
}

/** The server's default `low_balance_credits` (GET /billing/pricing). */
export const LOW_BALANCE_CREDITS = 50;
let lowWarned = false;
/** True once each time the last known balance drops under the low mark (so the
 * chat's heads-up doesn't repeat after every prompt). */
export function takeLowBalanceWarning(threshold = LOW_BALANCE_CREDITS): number | null {
  const b = lastKnownBalance();
  if (b === null) return null;
  if (b >= threshold) {
    lowWarned = false;
    return null;
  }
  if (lowWarned) return null;
  lowWarned = true;
  return b;
}
