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
 * Purchases are NOT wired yet. When they are: iOS buys Apple consumables
 * (StoreKit) and never shows or links to the web checkout; every other
 * platform (browser PWA, Android) uses the web checkout. Credits live on the
 * server account, so they work on every platform the account signs in on.
 */

import { isIosNative } from "../../../net/native";
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
  setCreditsSession(null);
}

/** "1,234.5 credits" — the one place credits are formatted. */
export function formatCredits(n: number): string {
  const v = Math.floor(n * 10) / 10;
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })} credits`;
}

/** The friendly message for a refusal the proxy sent (402/403/429/503). */
export function creditsErrorMessage(status: number, body: { error?: string; message?: string } | null): string {
  if (status === 401) return "Sign in to use Splanc AI credits.";
  if (body?.message) return body.message;
  if (status === 402) return "Not enough Splanc AI credit. Buy more in AI settings.";
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
        throw new Error(creditsErrorMessage(resp.status, body));
      }
      const stream = cfg.onBilling ? sniffBilling(resp.body, cfg.onBilling) : resp.body;
      return consumeChatStream(stream, opts.stream);
    },
  };
}
