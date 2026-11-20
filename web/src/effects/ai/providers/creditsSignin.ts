/**
 * Sign in with Apple / Google for the Splanc AI credit account
 * (agent/relay/src/billing/signin.ts; owner decision: Apple + Google +
 * anonymous). The app links a sign-in to its (anonymous) account so the
 * credits follow the person to a new device, and signs in on a new device
 * to get them back.
 *
 * Per platform:
 *   Apple   iOS app: native Sign in with Apple (the WebAuth plugin's
 *           `appleSignIn`, AuthenticationServices). Browser / Android:
 *           Sign in with Apple JS in a popup.
 *   Google  iOS app: Google's OAuth page in the system sign-in sheet
 *           (ASWebAuthenticationSession via the WebAuth plugin), PKCE, the
 *           relay exchanges the code. Browser / Android: Google Identity
 *           Services' own button.
 *
 * Every sign-in carries a nonce from the relay: we hand its SHA-256 to Apple
 * / Google and the relay checks the token carries it (single use). No scope
 * asks for a name or an email; the relay keeps only the provider's user id.
 *
 * Sign out is local: the device forgets its session. The credits stay on
 * the account and come back with the next sign-in.
 */

import { isIosNative, registerNativePlugin } from "../../../net/native";
import { WebAuthCancelled, startWebAuth, webAuthAvailable } from "../../../net/webAuth";
import { base64Url, codeChallengeS256, makeCodeVerifier } from "../openrouterOAuth";
import { CreditsApiError, creditsRelay, forgetCreditsSession, getCreditsSession, setCreditsSession } from "./credits";

export type SigninProvider = "apple" | "google";
export const SIGNIN_PROVIDERS: readonly SigninProvider[] = ["apple", "google"];
export const PROVIDER_LABEL: Record<SigninProvider, string> = { apple: "Apple", google: "Google" };
/** What the provider calls the user's identity, in copy. */
export const IDENTITY_NOUN: Record<SigninProvider, string> = { apple: "Apple ID", google: "Google account" };

export interface PublicSigninConfig {
  apple: { ios: boolean; web: { client_id: string; redirect_uri: string } | null } | null;
  google: { web: { client_id: string } | null; ios: { client_id: string; redirect_uri: string } | null } | null;
}

export interface LinkedSignin {
  provider: SigninProvider;
  linked_at: string;
}

export interface AccountSummary {
  balance_credits: number;
  identities: LinkedSignin[];
}

export type SigninResult =
  /** The device's account now has (or already had) this sign-in. */
  | ({ kind: "linked" | "already_linked"; provider: SigninProvider } & AccountSummary)
  /** The device is now on the identity's account (new session stored). */
  | ({ kind: "signed_in" | "created" | "switched"; provider: SigninProvider } & AccountSummary)
  /** The identity belongs to ANOTHER account than this device's. Nothing
   * changed: ask the user (switchAccount(ticket) moves this device). */
  | { kind: "conflict"; provider: SigninProvider; current: AccountSummary | null; other: AccountSummary; ticket: string }
  /** Restore only: no account has this identity yet. */
  | { kind: "no_account"; provider: SigninProvider };

/** The user closed the provider's sheet / popup (not an error to show). */
export class SigninCancelled extends Error {
  constructor() {
    super("Sign-in cancelled.");
    this.name = "SigninCancelled";
  }
}

type Fetch = typeof fetch;

let cachedConfig: { at: number; cfg: PublicSigninConfig | null } | null = null;

/** The relay's sign-in config (cached 5 minutes); null when unreachable. */
export async function fetchSigninConfig(fetchImpl: Fetch = fetch, nowMs = Date.now()): Promise<PublicSigninConfig | null> {
  if (cachedConfig && nowMs - cachedConfig.at < 300_000) return cachedConfig.cfg;
  try {
    const r = await fetchImpl(`${creditsRelay()}/billing/signin/config`);
    const cfg = r.ok ? ((await r.json()) as PublicSigninConfig) : null;
    cachedConfig = { at: nowMs, cfg };
    return cfg;
  } catch {
    return null;
  }
}

/** Tests: forget the cached config. */
export function resetSigninConfigCache(): void {
  cachedConfig = null;
}

/** The providers this device can use right now, in display order. */
export function availableProviders(cfg: PublicSigninConfig | null, env: { ios: boolean; webAuth: boolean } = { ios: isIosNative(), webAuth: webAuthAvailable() }): SigninProvider[] {
  if (!cfg) return [];
  const out: SigninProvider[] = [];
  if (env.ios ? cfg.apple?.ios === true && env.webAuth : !!cfg.apple?.web) out.push("apple");
  if (env.ios ? !!cfg.google?.ios && env.webAuth : !!cfg.google?.web) out.push("google");
  return out;
}

export async function getSigninNonce(fetchImpl: Fetch = fetch): Promise<{ nonce: string; provider_nonce: string }> {
  const r = await fetchImpl(`${creditsRelay()}/billing/signin/nonce`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const b = (await r.json().catch(() => null)) as { nonce?: string; provider_nonce?: string; message?: string } | null;
  if (!r.ok || !b?.nonce || !b.provider_nonce) throw new CreditsApiError(r.status, "nonce", b?.message ?? "Sign-in is unavailable right now. Try again in a minute.");
  return { nonce: b.nonce, provider_nonce: b.provider_nonce };
}

const summary = (b: Record<string, unknown>): AccountSummary => ({
  balance_credits: typeof b["balance_credits"] === "number" ? b["balance_credits"] : 0,
  identities: Array.isArray(b["identities"]) ? (b["identities"] as LinkedSignin[]) : [],
});

/** What the relay needs from one provider sign-in. */
export interface ProviderProof {
  provider: SigninProvider;
  client: "ios" | "web";
  nonce: string;
  id_token?: string;
  code?: string;
  code_verifier?: string;
}

/**
 * Send a provider's proof to the relay, with this device's session when it
 * has one (so a new sign-in LINKS to it). Stores a new session when the
 * device moves to another account. `create: false` = restore only.
 */
export async function submitSignin(proof: ProviderProof, opts: { create?: boolean } = {}, fetchImpl: Fetch = fetch): Promise<SigninResult> {
  const s = getCreditsSession();
  let r: Response;
  try {
    r = await fetchImpl(`${creditsRelay()}/billing/signin`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(s ? { authorization: `Bearer ${s.token}` } : {}) },
      body: JSON.stringify({ ...proof, ...(opts.create === false ? { create: false } : {}) }),
    });
  } catch {
    throw new CreditsApiError(0, "network", "Can't reach Splanc right now. Check your connection and try again.");
  }
  const b = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const provider = proof.provider;
  if (r.status === 409 && b["error"] === "identity_in_use") {
    return { kind: "conflict", provider, current: b["current"] ? summary(b["current"] as Record<string, unknown>) : null, other: summary(b["other"] as Record<string, unknown>), ticket: String(b["switch_ticket"] ?? "") };
  }
  if (r.status === 404 && b["error"] === "no_account") return { kind: "no_account", provider };
  if (!r.ok) throw new CreditsApiError(r.status, String(b["error"] ?? ""), signinMessage(r.status, b));
  const kind = String(b["result"] ?? "");
  if ((kind === "signed_in" || kind === "created") && typeof b["token"] === "string") {
    adoptSession(String(b["account_id"]), b["token"]);
    return { kind, provider, ...summary(b) };
  }
  if (kind === "linked" || kind === "already_linked") return { kind, provider, ...summary(b) };
  throw new CreditsApiError(500, "bad_response", "Sign-in is unavailable right now. Try again in a minute.");
}

/** Move this device to another account (its own session replaces ours). */
function adoptSession(accountId: string, token: string): void {
  const before = getCreditsSession();
  if (before && before.account_id !== accountId) forgetCreditsSession();
  setCreditsSession({ account_id: accountId, token });
}

/** After a conflict, the user chose the signed-in account. */
export async function switchAccount(ticket: string, provider: SigninProvider, fetchImpl: Fetch = fetch): Promise<SigninResult> {
  const r = await fetchImpl(`${creditsRelay()}/billing/signin/switch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ticket }) });
  const b = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (!r.ok || typeof b["token"] !== "string") throw new CreditsApiError(r.status, String(b["error"] ?? ""), signinMessage(r.status, b));
  adoptSession(String(b["account_id"]), b["token"]);
  return { kind: "switched", provider, ...summary(b) };
}

/** A conflict that can't lose anything (this device's account is empty, and
 * nothing else leads back to it): switch without asking. */
export function conflictIsHarmless(c: Extract<SigninResult, { kind: "conflict" }>, emailVerified = false): boolean {
  return !!c.current && c.current.balance_credits <= 0 && c.current.identities.length === 0 && !emailVerified;
}

/** Remove a sign-in. `confirmUnrecoverable`: the user accepted that this was
 * the only way back to the credits (the relay asks with 409 unrecoverable). */
export async function unlinkSignin(provider: SigninProvider, confirmUnrecoverable = false, fetchImpl: Fetch = fetch): Promise<LinkedSignin[]> {
  const s = getCreditsSession();
  if (!s) throw new CreditsApiError(401, "unauthorized", "Sign in to use Splanc AI credits.");
  const r = await fetchImpl(`${creditsRelay()}/billing/signin/unlink`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
    body: JSON.stringify({ provider, ...(confirmUnrecoverable ? { confirm_unrecoverable: true } : {}) }),
  });
  const b = ((await r.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (!r.ok) throw new CreditsApiError(r.status, String(b["error"] ?? ""), signinMessage(r.status, b));
  return Array.isArray(b["identities"]) ? (b["identities"] as LinkedSignin[]) : [];
}

/** Sign out of Splanc AI on this device only (the account and its credits stay). */
export function signOutCredits(): void {
  forgetCreditsSession();
}

function signinMessage(status: number, b: Record<string, unknown>): string {
  switch (b["error"]) {
    case "provider_linked":
    case "unrecoverable":
    case "provider_disabled":
    case "rate_limited":
      return String(b["message"] ?? "");
    case "invalid_token":
      return "That sign-in didn't work. Please try again.";
    case "invalid_ticket":
      return "That took too long. Please sign in again.";
    case "provider_unavailable":
      return String(b["message"] ?? "Sign-in is unavailable right now. Please try again in a few minutes.");
  }
  if (status === 401) return "This device's Splanc AI session isn't valid any more. Sign in again.";
  return typeof b["message"] === "string" && b["message"] ? b["message"] : `Sign-in is unavailable right now (${status}).`;
}

// -- the provider UIs ------------------------------------------------------------------

interface WebAuthApple {
  appleSignIn(o: { nonce: string }): Promise<{ identityToken: string; authorizationCode: string }>;
}

/** Native Sign in with Apple in the iOS app. */
export async function appleNativeProof(n: { nonce: string; provider_nonce: string }): Promise<ProviderProof> {
  const plugin = registerNativePlugin<WebAuthApple>("WebAuth");
  try {
    const r = await plugin.appleSignIn({ nonce: n.provider_nonce });
    return { provider: "apple", client: "ios", nonce: n.nonce, id_token: r.identityToken, code: r.authorizationCode };
  } catch (e) {
    if ((e as { code?: unknown }).code === "canceled") throw new SigninCancelled();
    throw e instanceof Error ? e : new Error(String(e));
  }
}

/** Sign in with Apple JS (https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_js). */
export const APPLE_JS = "https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js";
export const GOOGLE_GSI = "https://accounts.google.com/gsi/client";

interface AppleIdGlobal {
  auth: {
    init(o: Record<string, unknown>): void;
    signIn(): Promise<{ authorization?: { code?: string; id_token?: string; state?: string } }>;
  };
}

const loaded = new Map<string, Promise<void>>();

/** Load a provider's script once. */
export function loadScript(src: string): Promise<void> {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        loaded.delete(src);
        reject(new CreditsApiError(0, "network", "Can't load the sign-in page. Check your connection and try again."));
      };
      document.head.append(s);
    });
    loaded.set(src, p);
  }
  return p;
}

/** Sign in with Apple in a browser (a popup). No scope: no name, no email. */
export async function appleWebProof(cfg: PublicSigninConfig, n: { nonce: string; provider_nonce: string }, load = loadScript): Promise<ProviderProof> {
  const web = cfg.apple?.web;
  if (!web) throw new CreditsApiError(503, "provider_disabled", "Sign in with Apple isn't available yet.");
  await load(APPLE_JS);
  const AppleID = (globalThis as { AppleID?: AppleIdGlobal }).AppleID;
  if (!AppleID) throw new CreditsApiError(0, "network", "Can't load the sign-in page. Check your connection and try again.");
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  AppleID.auth.init({ clientId: web.client_id, redirectURI: web.redirect_uri, state, nonce: n.provider_nonce, usePopup: true });
  let r: Awaited<ReturnType<AppleIdGlobal["auth"]["signIn"]>>;
  try {
    r = await AppleID.auth.signIn();
  } catch (e) {
    const err = (e as { error?: unknown }).error;
    if (err === "popup_closed_by_user" || err === "user_cancelled_authorize") throw new SigninCancelled();
    throw new CreditsApiError(0, "apple", "Sign in with Apple didn't finish. Please try again.");
  }
  const a = r.authorization;
  if (!a?.id_token || !a.code || a.state !== state) throw new CreditsApiError(0, "apple", "Sign in with Apple didn't finish. Please try again.");
  return { provider: "apple", client: "web", nonce: n.nonce, id_token: a.id_token, code: a.code };
}

/** Google's authorization URL for the iOS app (code + PKCE, openid only). */
export function googleAuthorizeUrl(o: { clientId: string; redirectUri: string; challenge: string; state: string; nonce: string }): string {
  const p = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: "openid",
    code_challenge: o.challenge,
    code_challenge_method: "S256",
    state: o.state,
    nonce: o.nonce,
    prompt: "select_account",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

/** Sign in with Google in the iOS app: Google's page in the system sheet. */
export async function googleIosProof(cfg: PublicSigninConfig, n: { nonce: string; provider_nonce: string }, start = startWebAuth): Promise<ProviderProof> {
  const ios = cfg.google?.ios;
  if (!ios) throw new CreditsApiError(503, "provider_disabled", "Sign in with Google isn't available yet.");
  const verifier = makeCodeVerifier();
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const url = googleAuthorizeUrl({ clientId: ios.client_id, redirectUri: ios.redirect_uri, challenge: await codeChallengeS256(verifier), state, nonce: n.provider_nonce });
  let back: string;
  try {
    back = await start(url, ios.redirect_uri.split(":")[0]!);
  } catch (e) {
    if (e instanceof WebAuthCancelled) throw new SigninCancelled();
    throw e;
  }
  const q = new URL(back).searchParams;
  if (q.get("state") !== state) throw new CreditsApiError(0, "google", "Sign in with Google didn't finish. Please try again.");
  if (q.get("error") === "access_denied") throw new SigninCancelled();
  const code = q.get("code");
  if (!code) throw new CreditsApiError(0, "google", "Sign in with Google didn't finish. Please try again.");
  return { provider: "google", client: "ios", nonce: n.nonce, code, code_verifier: verifier };
}

interface GoogleIdGlobal {
  accounts: {
    id: {
      initialize(o: Record<string, unknown>): void;
      renderButton(el: HTMLElement, o: Record<string, unknown>): void;
    };
  };
}

/**
 * Google Identity Services' own "Continue with Google" button (the browser
 * path: Google's brand rules want their button). `onProof` gets the ID token
 * once the user picks an account. The nonce is bound when the button is
 * drawn, so it is drawn with a fresh one each time.
 */
export async function renderGoogleButton(
  el: HTMLElement,
  cfg: PublicSigninConfig,
  n: { nonce: string; provider_nonce: string },
  onProof: (p: ProviderProof) => void,
  opts: { dark: boolean; width: number },
  load = loadScript,
): Promise<void> {
  const web = cfg.google?.web;
  if (!web) throw new CreditsApiError(503, "provider_disabled", "Sign in with Google isn't available yet.");
  await load(GOOGLE_GSI);
  const google = (globalThis as { google?: GoogleIdGlobal }).google;
  if (!google?.accounts?.id) throw new CreditsApiError(0, "network", "Can't load the sign-in page. Check your connection and try again.");
  google.accounts.id.initialize({
    client_id: web.client_id,
    nonce: n.provider_nonce,
    auto_select: false,
    use_fedcm_for_button: true,
    callback: (resp: { credential?: string }) => {
      if (resp.credential) onProof({ provider: "google", client: "web", nonce: n.nonce, id_token: resp.credential });
    },
  });
  google.accounts.id.renderButton(el, {
    type: "standard",
    theme: opts.dark ? "filled_black" : "outline",
    size: "large",
    text: "continue_with",
    shape: "pill",
    logo_alignment: "center",
    width: Math.max(200, Math.min(400, Math.round(opts.width))),
  });
}

/** One provider sign-in for the paths with our own button (Apple everywhere,
 * Google in the iOS app). Google in a browser uses renderGoogleButton. */
export async function providerProof(provider: SigninProvider, cfg: PublicSigninConfig, deps: { ios?: boolean; fetchImpl?: Fetch } = {}): Promise<ProviderProof> {
  const ios = deps.ios ?? isIosNative();
  const n = await getSigninNonce(deps.fetchImpl ?? fetch);
  if (provider === "apple") return ios ? appleNativeProof(n) : appleWebProof(cfg, n);
  if (ios) return googleIosProof(cfg, n);
  throw new Error("Google in a browser signs in through its own button.");
}
