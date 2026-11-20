/**
 * Sign in with Apple and Sign in with Google for Splanc AI credit accounts
 * (docs/design/ai-billing.md §Accounts and identity, owner decision: Apple +
 * Google + anonymous).
 *
 *   GET  /billing/signin/config        which providers are on + the PUBLIC client ids the app needs
 *   POST /billing/signin/nonce         a fresh single-use nonce (10 min)
 *   POST /billing/signin               {provider, client, nonce, id_token? | code?…} -> link / sign in / conflict
 *   POST /billing/signin/switch        {ticket}: the user chose the OTHER account after a conflict
 *   POST /billing/signin/unlink        {provider, confirm_unrecoverable?} (session): unlink (Apple: revoke)
 *   POST /billing/signin/apple/notify  Apple's server-to-server notifications (consent revoked, Apple ID deleted)
 *
 * The account model:
 * - An anonymous account (POST /billing/account) LINKS a sign-in and keeps
 *   its balance: the request carries the account's session and an identity
 *   nobody has linked yet.
 * - A device with no session SIGNS IN: an identity already linked returns
 *   that account's session (recovery on a new device); an unknown one opens a
 *   new account with the identity linked.
 * - An identity that belongs to a DIFFERENT account than the session's is a
 *   CONFLICT (409 identity_in_use). Balances are never merged: the answer
 *   describes both accounts (balances, linked providers) and carries a
 *   short-lived switch ticket; the app asks the user, and only an explicit
 *   POST /billing/signin/switch moves this device to the other account.
 * - One identity per provider per account; one account per identity
 *   (`link:<provider>:<sub>` in the Directory, first claim wins).
 * - Sign out is local (the app forgets its session). Account deletion
 *   (DELETE /billing/account) revokes the Apple token first (Apple's rule for
 *   apps offering Sign in with Apple), unlinks everything, then closes.
 *
 * What is stored (and nothing else): the provider's subject id, the client id
 * it was issued to, when it was linked, and for Apple the refresh token
 * (AES-GCM, APPLE_SIGNIN_TOKEN_KEY) kept only so it can be revoked. Never a
 * name or an email: the tokens' email claims are not read.
 *
 * Token checks: RS256 signature against the provider's JWKS, issuer, our
 * client id as audience, expiry, and the nonce: the relay mints it (HMAC,
 * 10 minutes), the app hands its SHA-256 to Apple / Google, the token must
 * carry that hash, and each nonce is accepted once. A token minted for
 * another app, replayed, or forged fails.
 */

import { dir } from "../oauth";
import { b64url, fromB64url, hmac, randomBytes, safeEqual, sha256hex } from "../crypto";
import type { Env } from "../platform";
import { DoLedger, type BillingMode } from "./account";
import { JwksCache, JwtError, parseJwt, signEs256, verifyJwt } from "./jwt";
import type { IdentityProvider, LinkedIdentity } from "./ledger";
import { MICRO } from "./pricing";

export const PROVIDERS: readonly IdentityProvider[] = ["apple", "google"];

export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS = "https://appleid.apple.com/auth/keys";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
export const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const NONCE_TTL_S = 10 * 60;
export const SWITCH_TTL_S = 10 * 60;

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// -- config ----------------------------------------------------------------------------

export interface AppleConfig {
  teamId: string;
  keyId: string;
  /** The Sign in with Apple key (.p8, PKCS#8 PEM). Worker secret. */
  privateKey: string;
  /** AES-256 key (base64url) for the stored refresh tokens. Worker secret. */
  tokenKey: string;
  /** Native iOS app: the bundle id is the audience. */
  bundleId: string | null;
  /** Web (Sign in with Apple JS): the Services ID and its return URL. */
  servicesId: string | null;
  redirectUri: string | null;
}

export interface GoogleConfig {
  webClientId: string | null;
  iosClientId: string | null;
}

export interface SigninConfig {
  apple: AppleConfig | null;
  google: GoogleConfig | null;
}

const s = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

/** What's configured. Apple needs the key, the team, the token key and at
 * least one client (app or web); Google at least one client id. */
export function signinConfig(env: Env): SigninConfig {
  const servicesId = s(env.APPLE_SIGNIN_SERVICES_ID);
  const redirectUri = s(env.APPLE_SIGNIN_REDIRECT_URI);
  const apple: AppleConfig = {
    teamId: s(env.APPLE_SIGNIN_TEAM_ID) ?? "",
    keyId: s(env.APPLE_SIGNIN_KEY_ID) ?? "",
    privateKey: env.APPLE_SIGNIN_PRIVATE_KEY ?? "",
    tokenKey: env.APPLE_SIGNIN_TOKEN_KEY ?? "",
    bundleId: s(env.APPLE_SIGNIN_BUNDLE_ID),
    // The web client needs both halves.
    servicesId: servicesId && redirectUri ? servicesId : null,
    redirectUri: servicesId && redirectUri ? redirectUri : null,
  };
  const appleOn = !!(apple.teamId && apple.keyId && apple.privateKey && apple.tokenKey && (apple.bundleId || apple.servicesId));
  const google: GoogleConfig = { webClientId: s(env.GOOGLE_SIGNIN_WEB_CLIENT_ID), iosClientId: s(env.GOOGLE_SIGNIN_IOS_CLIENT_ID) };
  return { apple: appleOn ? apple : null, google: google.webClientId || google.iosClientId ? google : null };
}

/** Google's iOS redirect: the client id reversed into a URL scheme. */
export function googleIosRedirect(iosClientId: string): string {
  return `com.googleusercontent.apps.${iosClientId.replace(/\.apps\.googleusercontent\.com$/, "")}:/oauth2redirect`;
}

/** The public view (client ids are not secrets; the app needs them). */
export function publicSigninConfig(c: SigninConfig) {
  return {
    apple: c.apple
      ? { ios: c.apple.bundleId !== null, web: c.apple.servicesId ? { client_id: c.apple.servicesId, redirect_uri: c.apple.redirectUri } : null }
      : null,
    google: c.google
      ? {
          web: c.google.webClientId ? { client_id: c.google.webClientId } : null,
          ios: c.google.iosClientId ? { client_id: c.google.iosClientId, redirect_uri: googleIosRedirect(c.google.iosClientId) } : null,
        }
      : null,
  };
}

// -- nonces + switch tickets (stateless HMAC with BILLING_TOKEN_SECRET) ----------------

const nonceMsg = (exp: number, r: string) => `splanc-signin-nonce\n${exp}\n${r}`;
const switchMsg = (account: string, exp: number) => `splanc-signin-switch\n${account}\n${exp}`;

/** A fresh nonce. The app passes `provider_nonce` (its SHA-256, hex) to Apple
 * / Google and `nonce` itself back to us with the token. */
export async function mintNonce(secret: string, nowS: number): Promise<{ nonce: string; provider_nonce: string; expires_at: number }> {
  const exp = nowS + NONCE_TTL_S;
  const r = b64url(randomBytes(18));
  const nonce = `sn1.${exp}.${r}.${await hmac(secret, nonceMsg(exp, r))}`;
  return { nonce, provider_nonce: await sha256hex(nonce), expires_at: exp };
}

/** Our MAC and expiry on `nonce`, and the token's `nonce` claim is its hash.
 * (Single use is checked separately, after the token verified.) */
export async function checkNonce(secret: string, nonce: unknown, claim: unknown, nowS: number): Promise<{ ok: true; key: string; exp: number } | { ok: false }> {
  if (typeof nonce !== "string") return { ok: false };
  const m = /^sn1\.(\d{1,12})\.([A-Za-z0-9_-]{24})\.([A-Za-z0-9_-]{43})$/.exec(nonce);
  if (!m) return { ok: false };
  const exp = Number(m[1]);
  if (exp <= nowS || !safeEqual(await hmac(secret, nonceMsg(exp, m[2]!)), m[3]!)) return { ok: false };
  if (typeof claim !== "string" || !safeEqual(claim, await sha256hex(nonce))) return { ok: false };
  return { ok: true, key: `sn:${m[2]}`, exp };
}

export async function mintSwitchTicket(secret: string, account: string, nowS: number): Promise<string> {
  const exp = nowS + SWITCH_TTL_S;
  return `sw1.${account}.${exp}.${await hmac(secret, switchMsg(account, exp))}`;
}

export async function verifySwitchTicket(secret: string, ticket: unknown, nowS: number): Promise<string | null> {
  if (typeof ticket !== "string") return null;
  const m = /^sw1\.(acct_[a-z2-7]{20})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(ticket);
  if (!m || Number(m[2]) <= nowS) return null;
  return safeEqual(await hmac(secret, switchMsg(m[1]!, Number(m[2]))), m[3]!) ? m[1]! : null;
}

// -- Apple refresh-token encryption ----------------------------------------------------

async function aesKey(tokenKey: string): Promise<CryptoKey> {
  const raw = fromB64url(tokenKey);
  if (raw.length !== 32) throw new Error("APPLE_SIGNIN_TOKEN_KEY must be 32 bytes (base64url)");
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function sealToken(tokenKey: string, token: string): Promise<{ iv: string; ct: string }> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, await aesKey(tokenKey), new TextEncoder().encode(token));
  return { iv: b64url(iv), ct: b64url(ct) };
}

export async function openToken(tokenKey: string, sealed: { iv: string; ct: string }): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(sealed.iv) as BufferSource }, await aesKey(tokenKey), fromB64url(sealed.ct) as BufferSource);
  return new TextDecoder().decode(pt);
}

// -- provider calls --------------------------------------------------------------------

/** Apple's `client_secret`: an ES256 JWT signed with our Sign in with Apple key. */
export function appleClientSecret(a: AppleConfig, clientId: string, nowS: number): Promise<string> {
  return signEs256(a.privateKey, a.keyId, { iss: a.teamId, iat: nowS, exp: nowS + 300, aud: APPLE_ISSUER, sub: clientId });
}

const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(o).toString(),
});

export class SigninError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SigninError";
  }
}

const TRY_AGAIN = "That sign-in didn't work. Please try again.";
const PROVIDER_DOWN = "Sign-in is unavailable right now. Please try again in a few minutes.";

/** Exchange Apple's authorization code: the refresh token (to revoke later)
 * and an ID token for the same user. */
export async function appleExchange(a: AppleConfig, clientId: string, code: string, redirectUri: string | null, nowS: number, f: Fetch) {
  const r = await f(
    APPLE_TOKEN_URL,
    form({
      client_id: clientId,
      client_secret: await appleClientSecret(a, clientId, nowS),
      code,
      grant_type: "authorization_code",
      ...(redirectUri ? { redirect_uri: redirectUri } : {}),
    }),
  );
  const b = (await r.json().catch(() => null)) as { refresh_token?: unknown; id_token?: unknown; error?: unknown } | null;
  // invalid_grant = a used / expired / foreign code: the user's problem, not Apple's.
  if (!r.ok) throw r.status === 400 ? new SigninError("invalid_token", 401, TRY_AGAIN) : new SigninError("provider_unavailable", 503, PROVIDER_DOWN);
  if (typeof b?.refresh_token !== "string" || typeof b.id_token !== "string") throw new SigninError("provider_unavailable", 503, PROVIDER_DOWN);
  return { refreshToken: b.refresh_token, idToken: b.id_token };
}

export async function appleRevoke(a: AppleConfig, clientId: string, refreshToken: string, nowS: number, f: Fetch): Promise<void> {
  const r = await f(
    APPLE_REVOKE_URL,
    form({ client_id: clientId, client_secret: await appleClientSecret(a, clientId, nowS), token: refreshToken, token_type_hint: "refresh_token" }),
  );
  if (!r.ok) throw new Error(`apple revoke ${r.status}`);
}

/** Google's iOS client (no secret, PKCE): exchange the code for an ID token. */
export async function googleExchange(g: GoogleConfig, code: string, verifier: string, f: Fetch): Promise<string> {
  const r = await f(
    GOOGLE_TOKEN_URL,
    form({ client_id: g.iosClientId!, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: googleIosRedirect(g.iosClientId!) }),
  );
  const b = (await r.json().catch(() => null)) as { id_token?: unknown } | null;
  if (!r.ok) throw r.status === 400 ? new SigninError("invalid_token", 401, TRY_AGAIN) : new SigninError("provider_unavailable", 503, PROVIDER_DOWN);
  if (typeof b?.id_token !== "string") throw new SigninError("provider_unavailable", 503, PROVIDER_DOWN);
  return b.id_token;
}

// -- verifying one sign-in -------------------------------------------------------------

export interface SigninRequest {
  provider: IdentityProvider;
  /** Which client the user signed in from: the iOS app or a browser. */
  client: "ios" | "web";
  nonce: string;
  id_token?: string | undefined;
  code?: string | undefined;
  code_verifier?: string | undefined;
  /** false: only sign in to an EXISTING account (the app's "restore"); an
   * identity with no account answers 404 no_account instead of opening one. */
  create?: boolean | undefined;
}

export interface VerifiedIdentity {
  provider: IdentityProvider;
  sub: string;
  aud: string;
  apple_rt?: { iv: string; ct: string } | undefined;
}

export interface SigninDeps {
  fetch: Fetch;
  jwks: JwksCache;
  /** Records a key the first time it's seen (Directory `once`). */
  once: (key: string, exp: number) => Promise<boolean>;
}

const str = (v: unknown, max = 8192) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

export function parseSigninRequest(b: Record<string, unknown>): SigninRequest | null {
  const provider = b["provider"];
  const client = b["client"];
  if ((provider !== "apple" && provider !== "google") || (client !== "ios" && client !== "web")) return null;
  const nonce = str(b["nonce"], 200);
  if (!nonce) return null;
  return {
    provider,
    client,
    nonce,
    id_token: str(b["id_token"]),
    code: str(b["code"], 2048),
    code_verifier: str(b["code_verifier"], 256),
    create: b["create"] !== false,
  };
}

/**
 * Verify a sign-in and return the identity (for Apple, with the sealed refresh
 * token). Throws SigninError.
 */
export async function verifySignin(cfg: SigninConfig, secret: string, r: SigninRequest, nowS: number, deps: SigninDeps): Promise<VerifiedIdentity> {
  const disabled = () => new SigninError("provider_disabled", 503, `Sign in with ${r.provider === "apple" ? "Apple" : "Google"} isn't available yet.`);
  let claims: Record<string, unknown>;
  let aud: string;
  let appleRt: { iv: string; ct: string } | undefined;
  try {
    if (r.provider === "apple") {
      const a = cfg.apple;
      const clientId = r.client === "ios" ? a?.bundleId : a?.servicesId;
      if (!a || !clientId) throw disabled();
      if (!r.id_token || !r.code) throw new SigninError("invalid_request", 400, "{provider, client, nonce, id_token, code}");
      claims = await verifyJwt(r.id_token, { jwksUrl: APPLE_JWKS, issuers: [APPLE_ISSUER], audiences: [clientId], nowS }, deps.jwks);
      aud = clientId;
      const n = await checkNonce(secret, r.nonce, claims["nonce"], nowS);
      if (!n.ok) throw new SigninError("invalid_token", 401, TRY_AGAIN);
      if (!(await deps.once(n.key, n.exp))) throw new SigninError("invalid_token", 401, TRY_AGAIN);
      // The code exchange gives the refresh token Apple wants revoked on
      // deletion; its ID token must name the same user.
      const ex = await appleExchange(a, clientId, r.code, r.client === "web" ? a.redirectUri : null, nowS, deps.fetch);
      if (parseJwt(ex.idToken).claims["sub"] !== claims["sub"]) throw new SigninError("invalid_token", 401, TRY_AGAIN);
      appleRt = await sealToken(a.tokenKey, ex.refreshToken);
    } else {
      const g = cfg.google;
      let idToken = r.id_token;
      if (r.client === "ios") {
        if (!g?.iosClientId) throw disabled();
        if (!r.code || !r.code_verifier) throw new SigninError("invalid_request", 400, "{provider, client, nonce, code, code_verifier}");
        idToken = await googleExchange(g, r.code, r.code_verifier, deps.fetch);
        aud = g.iosClientId;
      } else {
        if (!g?.webClientId) throw disabled();
        if (!idToken) throw new SigninError("invalid_request", 400, "{provider, client, nonce, id_token}");
        aud = g.webClientId;
      }
      claims = await verifyJwt(idToken, { jwksUrl: GOOGLE_JWKS, issuers: GOOGLE_ISSUERS, audiences: [aud], nowS }, deps.jwks);
      const n = await checkNonce(secret, r.nonce, claims["nonce"], nowS);
      if (!n.ok) throw new SigninError("invalid_token", 401, TRY_AGAIN);
      if (!(await deps.once(n.key, n.exp))) throw new SigninError("invalid_token", 401, TRY_AGAIN);
    }
  } catch (e) {
    if (e instanceof JwtError) {
      if (e.reason === "jwks_unavailable") throw new SigninError("provider_unavailable", 503, PROVIDER_DOWN);
      throw new SigninError("invalid_token", 401, TRY_AGAIN);
    }
    throw e;
  }
  return { provider: r.provider, sub: claims["sub"] as string, aud, ...(appleRt ? { apple_rt: appleRt } : {}) };
}

// -- the routes ------------------------------------------------------------------------

/** What the billing router lends the sign-in routes. */
export interface SigninHost {
  env: Env;
  secret: string;
  ns: NonNullable<Env["BILLING"]>;
  nowS: number;
  clientIp: string;
  json: (obj: unknown, status?: number, extra?: Record<string, string>) => Response;
  log: (ev: Record<string, unknown>) => void;
  /** AI_BILLING: links and sessions are per mode, and an account of the other
   * mode is never signed into (ledger.ts Account.environment). */
  environment: BillingMode;
  /** The account this request's session names, null without one, "invalid"
   * for a bad / revoked one. */
  session: () => Promise<string | "invalid" | null>;
  /** Mint a session token for `account` (billing/account.ts). */
  mintSession: (account: string) => Promise<string>;
  /** Open a new account (the same path as POST /billing/account, rate limits
   * included); null when rate-limited. */
  openAccount: () => Promise<string | null>;
  accountRef: (account: string) => Promise<string>;
  deps: Partial<SigninDeps>;
}

/** One isolate-wide JWKS cache (Workers keep isolates warm between requests). */
const sharedJwks = new JwksCache();

function depsFor(h: SigninHost): SigninDeps {
  return {
    fetch: h.deps.fetch ?? ((u, i) => fetch(u, i)),
    jwks: h.deps.jwks ?? sharedJwks,
    once: h.deps.once ?? (async (k, exp) => (await dir<{ fresh: boolean }>(h.env, "/once", { k, exp })).body.fresh),
  };
}

type AcctView = Awaited<ReturnType<DoLedger["account"]>>["account"];

/** What the app may show about an account: balance and linked providers. */
export function accountSummary(a: NonNullable<AcctView>) {
  return {
    balance_credits: (a.balance - a.held) / MICRO,
    identities: identityList(a),
  };
}

export function identityList(a: { identities?: Partial<Record<IdentityProvider, LinkedIdentity>> | undefined }) {
  return PROVIDERS.filter((p) => a.identities?.[p]).map((p) => ({ provider: p, linked_at: new Date(a.identities![p]!.linked_at).toISOString() }));
}

// Links live per billing mode (directory.ts linkKey).
const linkOwner = async (env: Env, mode: BillingMode, provider: IdentityProvider, sub: string) =>
  (await dir<{ account: string | null }>(env, "/link/get", { provider, sub, env: mode })).body.account;
const claimLink = async (env: Env, mode: BillingMode, provider: IdentityProvider, sub: string, account: string) =>
  (await dir<{ ok: boolean }>(env, "/link/claim", { provider, sub, account, env: mode })).body.ok;
const releaseLink = (env: Env, mode: BillingMode, provider: IdentityProvider, sub: string, account: string) =>
  dir(env, "/link/del", { provider, sub, account, env: mode });

/** The mode an account was opened under (absent = before modes: sandbox). */
const modeOf = (a: { environment?: BillingMode | undefined }): BillingMode => a.environment ?? "sandbox";

const identityRecord = (v: VerifiedIdentity): Omit<LinkedIdentity, "linked_at"> => ({ sub: v.sub, aud: v.aud, ...(v.apple_rt ? { apple_rt: v.apple_rt } : {}) });

export const SIGNIN_PATHS = [
  "/billing/signin",
  "/billing/signin/config",
  "/billing/signin/nonce",
  "/billing/signin/switch",
  "/billing/signin/unlink",
  "/billing/signin/apple/notify",
];

/** Sign-in routes; null when `path` isn't one. */
export async function signinEndpoint(req: Request, path: string, h: SigninHost): Promise<Response | null> {
  if (!SIGNIN_PATHS.includes(path)) return null;
  const cfg = signinConfig(h.env);
  const deps = depsFor(h);
  const body = async () => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  if (path === "/billing/signin/config" && req.method === "GET") {
    return h.json(publicSigninConfig(cfg), 200, { "cache-control": "public, max-age=300" });
  }
  if (path === "/billing/signin/nonce" && req.method === "POST") {
    if (!cfg.apple && !cfg.google) return h.json({ error: "not_configured", message: "Sign-in isn't available yet." }, 503);
    return h.json(await mintNonce(h.secret, h.nowS));
  }
  if (path === "/billing/signin/apple/notify" && req.method === "POST") return appleNotification(await body(), cfg, h, deps);
  if (req.method !== "POST") return h.json({ error: "method_not_allowed" }, 405);

  if (path === "/billing/signin") {
    if ((await dir(h.env, "/limit", { name: "signinIp", key: h.clientIp })).status === 429) {
      return h.json({ error: "rate_limited", message: "Too many sign-in attempts; try again later." }, 429, { "retry-after": "600" });
    }
    const r = parseSigninRequest(await body());
    if (!r) return h.json({ error: "invalid_request", message: "{provider: apple|google, client: ios|web, nonce, …}" }, 400);
    const current = await h.session();
    if (current === "invalid") return h.json({ error: "unauthorized", message: "This device's session isn't valid any more." }, 401);
    const v = await verifySignin(cfg, h.secret, r, h.nowS, deps);
    return signIn(v, current, h, r.create !== false);
  }

  if (path === "/billing/signin/switch") {
    const account = await verifySwitchTicket(h.secret, (await body())["ticket"], h.nowS);
    const a = account ? (await new DoLedger(h.ns, account).account()).account : null;
    if (!account || !a || a.status === "closed" || modeOf(a) !== h.environment) return h.json({ error: "invalid_ticket", message: "That took too long. Please sign in again." }, 400);
    h.log({ ev: "ai_signin_switched", account });
    return h.json({ result: "switched", account_id: account, token: await h.mintSession(account), account_ref: await h.accountRef(account), ...accountSummary(a) });
  }

  // /billing/signin/unlink (needs the session)
  const account = await h.session();
  if (!account || account === "invalid") return h.json({ error: "unauthorized", message: "sign in to use Splanc AI credits" }, 401);
  const b = await body();
  const provider = b["provider"];
  if (provider !== "apple" && provider !== "google") return h.json({ error: "invalid_request", message: "{provider: apple|google}" }, 400);
  const ledger = new DoLedger(h.ns, account);
  const a = (await ledger.account()).account;
  const have = a?.identities?.[provider];
  if (!a || !have) return h.json({ ok: true, identities: a ? identityList(a) : [] });
  // The last way back to a balance: say so, and require the user's OK.
  const others = PROVIDERS.filter((p) => p !== provider && a.identities?.[p]).length + ((a as { email?: unknown }).email ? 1 : 0);
  if (others === 0 && a.balance - a.held > 0 && b["confirm_unrecoverable"] !== true) {
    return h.json(
      { error: "unrecoverable", message: "This is the only way to get this account back on another device. Without it, the credits are lost if this device's data is." },
      409,
    );
  }
  await revokeApple(cfg, have, provider, h, deps);
  await ledger.unlinkIdentity(provider, have.sub);
  await releaseLink(h.env, h.environment, provider, have.sub, account);
  h.log({ ev: "ai_signin_unlinked", account, provider });
  const after = (await ledger.account()).account;
  return h.json({ ok: true, identities: after ? identityList(after) : [] });
}

async function signIn(v: VerifiedIdentity, current: string | null, h: SigninHost, create: boolean): Promise<Response> {
  const owner = await linkOwner(h.env, h.environment, v.provider, v.sub);
  const ownerLedger = owner ? new DoLedger(h.ns, owner) : null;
  const ownerAcct = ownerLedger ? (await ownerLedger.account()).account : null;
  if (ownerAcct && modeOf(ownerAcct) !== h.environment) {
    // Links are per mode, so this means a mis-keyed link: never re-issue a
    // session across modes (sandbox credits must not be spent in production).
    h.log({ ev: "ai_signin", provider: v.provider, result: "wrong_environment", account: owner, alert: true });
    return h.json({ error: "wrong_environment", message: "That account can't be used here." }, 409);
  }
  if (owner && ownerLedger && ownerAcct && ownerAcct.status !== "closed") {
    // Keep the newest Apple refresh token on the account that owns the identity.
    await ownerLedger.linkIdentity(v.provider, identityRecord(v)).catch(() => undefined);
    if (current === owner) {
      h.log({ ev: "ai_signin", provider: v.provider, result: "already_linked", account: owner });
      return h.json({ result: "already_linked", account_id: owner, ...accountSummary(ownerAcct) });
    }
    if (current) {
      // A different account than this device's. Never merge: ask the user.
      const cur = (await new DoLedger(h.ns, current).account()).account;
      h.log({ ev: "ai_signin", provider: v.provider, result: "conflict", account: current, other: owner });
      return h.json(
        {
          error: "identity_in_use",
          message: `This ${v.provider === "apple" ? "Apple ID" : "Google account"} already belongs to another Splanc AI account.`,
          current: cur ? accountSummary(cur) : null,
          other: accountSummary(ownerAcct),
          switch_ticket: await mintSwitchTicket(h.secret, owner, h.nowS),
        },
        409,
      );
    }
    h.log({ ev: "ai_signin", provider: v.provider, result: "signed_in", account: owner });
    return h.json({ result: "signed_in", account_id: owner, token: await h.mintSession(owner), account_ref: await h.accountRef(owner), ...accountSummary(ownerAcct) });
  }
  if (owner) await releaseLink(h.env, h.environment, v.provider, v.sub, owner); // a closed account's leftover

  let account = current;
  let created = false;
  if (!account) {
    if (!create) {
      h.log({ ev: "ai_signin", provider: v.provider, result: "no_account", account: null });
      return h.json({ error: "no_account", message: `There's no Splanc AI account for this ${v.provider === "apple" ? "Apple ID" : "Google account"} yet.` }, 404);
    }
    account = await h.openAccount();
    if (!account) return h.json({ error: "rate_limited", message: "Too many new accounts from here; try later." }, 429, { "retry-after": "3600" });
    created = true;
  }
  if (!(await claimLink(h.env, h.environment, v.provider, v.sub, account))) {
    return h.json({ error: "retry", message: "Please try signing in again." }, 409);
  }
  const ledger = new DoLedger(h.ns, account);
  try {
    await ledger.linkIdentity(v.provider, identityRecord(v));
  } catch (e) {
    await releaseLink(h.env, h.environment, v.provider, v.sub, account);
    if (String((e as Error).message).includes("provider_linked")) {
      return h.json(
        {
          error: "provider_linked",
          message: `This account is already linked to a different ${v.provider === "apple" ? "Apple ID" : "Google account"}. Unlink it first in Settings ▸ AI.`,
        },
        409,
      );
    }
    throw e;
  }
  const a = (await ledger.account()).account!;
  h.log({ ev: "ai_signin", provider: v.provider, result: created ? "created" : "linked", account });
  return h.json(
    {
      result: created ? "created" : "linked",
      account_id: account,
      ...(created ? { token: await h.mintSession(account), account_ref: await h.accountRef(account) } : {}),
      ...accountSummary(a),
    },
    created ? 201 : 200,
  );
}

async function revokeApple(cfg: SigninConfig, ident: LinkedIdentity, provider: IdentityProvider, h: SigninHost, deps: SigninDeps): Promise<void> {
  if (provider !== "apple" || !ident.apple_rt) return;
  if (!cfg.apple) {
    // Can't revoke without the key: don't block the user; ops must follow up.
    h.log({ ev: "ai_apple_revoke_skipped", alert: true, reason: "not_configured" });
    return;
  }
  const rt = await openToken(cfg.apple.tokenKey, ident.apple_rt);
  let last: unknown;
  for (let i = 0; i < 2; i++) {
    try {
      await appleRevoke(cfg.apple, ident.aud, rt, h.nowS, deps.fetch);
      return;
    } catch (e) {
      last = e;
    }
  }
  h.log({ ev: "ai_apple_revoke_failed", alert: true, detail: String(last) });
  throw new SigninError("provider_unavailable", 503, "We couldn't reach Apple to finish this. Nothing was changed; please try again in a few minutes.");
}

/**
 * Account deletion: revoke the Apple token (Apple's rule), then unlink every
 * identity and drop the links. Throws SigninError (503) when Apple can't be
 * reached, BEFORE anything changed, so the deletion can be retried.
 */
export async function unlinkAllForDeletion(account: string, h: Pick<SigninHost, "env" | "ns" | "nowS" | "log" | "deps">): Promise<void> {
  const ledger = new DoLedger(h.ns, account);
  const a = (await ledger.account()).account;
  if (!a?.identities) return;
  const cfg = signinConfig(h.env);
  const host = h as SigninHost;
  const deps = depsFor(host);
  const apple = a.identities.apple;
  if (apple) await revokeApple(cfg, apple, "apple", host, deps);
  for (const p of PROVIDERS) {
    const ident = a.identities[p];
    if (!ident) continue;
    await ledger.unlinkIdentity(p, ident.sub);
    await releaseLink(h.env, modeOf(a), p, ident.sub, account); // the account's own mode
  }
}

/**
 * Apple's server-to-server notifications for Sign in with Apple
 * (`{payload: <JWT signed by Apple>}`). "consent-revoked" (the user stopped
 * using their Apple ID with Splanc) and "account-delete" (they deleted their
 * Apple ID) unlink Apple from the account; its credits stay, reachable from
 * this device's session or another linked sign-in. Email relay events are
 * ignored (we never store an email).
 */
async function appleNotification(b: Record<string, unknown>, cfg: SigninConfig, h: SigninHost, deps: SigninDeps): Promise<Response> {
  const a = cfg.apple;
  if (!a) return h.json({ error: "not_configured" }, 503);
  let claims: Record<string, unknown>;
  try {
    claims = await verifyJwt(
      b["payload"],
      {
        jwksUrl: APPLE_JWKS,
        issuers: [APPLE_ISSUER],
        audiences: [a.bundleId, a.servicesId].filter((x): x is string => !!x),
        nowS: h.nowS,
        // Apple retries a failed delivery; a day-old one is still news.
        notification: { maxAgeS: 86400 },
      },
      deps.jwks,
    );
  } catch {
    h.log({ ev: "ai_apple_notify_rejected" });
    return h.json({ error: "bad_signature" }, 400);
  }
  let ev: { type?: unknown; sub?: unknown } = {};
  try {
    ev = typeof claims["events"] === "string" ? (JSON.parse(claims["events"]) as typeof ev) : ((claims["events"] ?? {}) as typeof ev);
  } catch {
    return h.json({ error: "bad_event" }, 400);
  }
  const type = typeof ev.type === "string" ? ev.type : "";
  if ((type === "consent-revoked" || type === "account-delete") && typeof ev.sub === "string") {
    const owner = await linkOwner(h.env, h.environment, "apple", ev.sub);
    if (owner) {
      await new DoLedger(h.ns, owner).unlinkIdentity("apple", ev.sub);
      await releaseLink(h.env, h.environment, "apple", ev.sub, owner);
    }
    h.log({ ev: "ai_apple_notify", type, account: owner ?? null });
  } else {
    h.log({ ev: "ai_apple_notify", type: type || "unknown", account: null });
  }
  return h.json({ ok: true });
}
