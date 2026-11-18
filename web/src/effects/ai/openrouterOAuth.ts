/**
 * "Connect OpenRouter" — OpenRouter's OAuth PKCE flow (docs/design/ai-tiers.md),
 * so a user gets THEIR OWN OpenRouter key in one click: no copy-paste, no
 * Splanc server, no shared key, and each user's own free-model rate limits.
 *
 *   1. make a random code_verifier, challenge = base64url(SHA-256(verifier));
 *   2. send the user to openrouter.ai/auth?callback_url=…&code_challenge=…&
 *      code_challenge_method=S256&state=…;
 *   3. OpenRouter redirects back to callback_url?code=…&state=…;
 *   4. POST /api/v1/auth/keys {code, code_verifier, code_challenge_method} → {key}.
 *
 * Two ways back, by platform:
 *   - "redirect" (PWA / browser): the callback is this page's own URL. The
 *     page reloads, so the verifier, state and where to return to are kept in
 *     localStorage (not sessionStorage: an installed Android PWA can come back
 *     in a browser tab, which shares localStorage but not sessionStorage).
 *   - "code" (iOS app): the Capacitor WKWebView opens off-origin pages in
 *     Safari and nothing routes the redirect back into the app without a
 *     native URL handler, so we use OpenRouter's headless mode instead: no
 *     callback_url; OpenRouter shows a one-time code (valid 10 minutes) that
 *     the user pastes back into the app. Same PKCE exchange.
 *
 * Pure logic (no DOM) apart from `crypto` and an injectable storage/fetch, so
 * it is unit-tested with fakes.
 */

import { OPENROUTER_BASE_URL } from "./providers/openrouter";

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
const PENDING_KEY = "splanc.openrouter.oauth";
/** OpenRouter codes expire after 10 minutes; keep a little slack for the
 * sign-up detour. */
export const PENDING_TTL_MS = 30 * 60 * 1000;

export type OAuthMode = "redirect" | "code";

export interface PendingOAuth {
  verifier: string;
  state: string;
  mode: OAuthMode;
  /** The hash route to return to after the redirect (e.g. "#/effects/edit/x"). */
  returnHash: string;
  /** The free model the user picked in the sheet. */
  model: string;
  createdAt: number;
}

export interface KVStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function store(s?: KVStore): KVStore | null {
  if (s) return s;
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// -- PKCE primitives -----------------------------------------------------------

export function base64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh code_verifier: 32 random bytes → 43 base64url chars (RFC 7636 wants
 * 43–128 chars from the unreserved set). */
export function makeCodeVerifier(rand: (b: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  return base64Url(rand(new Uint8Array(32)));
}

/** S256 challenge: base64url(SHA-256(ascii(verifier))). */
export async function codeChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function authorizeUrl(opts: {
  challenge: string;
  /** Omit for headless ("code") mode. */
  callbackUrl?: string | undefined;
  state?: string | undefined;
  keyLabel?: string | undefined;
}): string {
  const p = new URLSearchParams();
  if (opts.callbackUrl) p.set("callback_url", opts.callbackUrl);
  p.set("code_challenge", opts.challenge);
  p.set("code_challenge_method", "S256");
  if (opts.state) p.set("state", opts.state);
  if (opts.keyLabel) p.set("key_label", opts.keyLabel);
  return `${OPENROUTER_AUTH_URL}?${p.toString()}`;
}

/** The callback URL for redirect mode: this page without query or hash
 * (OpenRouter appends `?code=…&state=…`; the route is restored from the pending
 * record). */
export function callbackUrlFor(loc: { origin: string; pathname: string }): string {
  return `${loc.origin}${loc.pathname}`;
}

// -- pending record --------------------------------------------------------------

export async function beginOAuth(opts: {
  mode: OAuthMode;
  returnHash: string;
  model: string;
  location?: { origin: string; pathname: string };
  storage?: KVStore;
  now?: number;
  rand?: (b: Uint8Array) => Uint8Array;
}): Promise<{ url: string; pending: PendingOAuth }> {
  const verifier = makeCodeVerifier(opts.rand);
  const state = makeCodeVerifier(opts.rand).slice(0, 22);
  const challenge = await codeChallengeS256(verifier);
  const pending: PendingOAuth = {
    verifier,
    state,
    mode: opts.mode,
    returnHash: opts.returnHash,
    model: opts.model,
    createdAt: opts.now ?? Date.now(),
  };
  store(opts.storage)?.setItem(PENDING_KEY, JSON.stringify(pending));
  const loc = opts.location ?? (typeof location !== "undefined" ? location : undefined);
  const callbackUrl = opts.mode === "redirect" && loc ? callbackUrlFor(loc) : undefined;
  return { url: authorizeUrl({ challenge, callbackUrl, state, keyLabel: "Splanc" }), pending };
}

export function readPendingOAuth(storage?: KVStore, now = Date.now()): PendingOAuth | null {
  const s = store(storage);
  try {
    const p = JSON.parse(s?.getItem(PENDING_KEY) ?? "null") as PendingOAuth | null;
    if (!p || typeof p.verifier !== "string" || typeof p.state !== "string") return null;
    if (now - p.createdAt > PENDING_TTL_MS) {
      s?.removeItem(PENDING_KEY);
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

export function clearPendingOAuth(storage?: KVStore): void {
  store(storage)?.removeItem(PENDING_KEY);
}

// -- callback ------------------------------------------------------------------------

export type CallbackParse =
  | { kind: "none" }
  | { kind: "code"; code: string; state: string | null }
  | { kind: "error"; message: string };

/** Parse an OpenRouter redirect (`?code=…&state=…`, or `?error=…`). Codes may
 * also land after the hash on some hosts, so both places are checked. */
export function parseCallback(href: string): CallbackParse {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return { kind: "none" };
  }
  const hashQuery = u.hash.includes("?") ? new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1)) : null;
  const get = (k: string): string | null => u.searchParams.get(k) ?? hashQuery?.get(k) ?? null;
  const err = get("error");
  if (err) return { kind: "error", message: get("error_description") ?? err };
  const code = get("code");
  if (!code) return { kind: "none" };
  return { kind: "code", code, state: get("state") };
}

/** Strip `code` / `state` / `error` from a URL (so a reload can't replay it)
 * and restore the hash route. */
export function cleanedUrl(href: string, returnHash: string): string {
  const u = new URL(href);
  for (const k of ["code", "state", "error", "error_description"]) u.searchParams.delete(k);
  const q = u.searchParams.toString();
  return `${u.origin}${u.pathname}${q ? `?${q}` : ""}${returnHash}`;
}

/** Trade the one-time code for the user's key. */
export async function exchangeCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl = OPENROUTER_BASE_URL,
): Promise<string> {
  let resp: Response;
  try {
    resp = await fetchImpl(`${baseUrl}/auth/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code.trim(), code_verifier: verifier, code_challenge_method: "S256" }),
    });
  } catch {
    throw new Error("Couldn't reach OpenRouter to finish connecting. Check your connection and try again.");
  }
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
    const m = body?.error?.message ?? "";
    if (resp.status === 403 && /expired/i.test(m)) {
      throw new Error("That OpenRouter code expired (codes last 10 minutes). Connect again.");
    }
    if (resp.status === 403) {
      throw new Error("OpenRouter didn't accept that code. Connect again (each code works once).");
    }
    throw new Error(`OpenRouter couldn't create a key (${resp.status}). Try again.`);
  }
  const j = (await resp.json()) as { key?: unknown };
  if (typeof j.key !== "string" || !j.key) throw new Error("OpenRouter returned no key. Try again.");
  return j.key;
}

/**
 * Finish a redirect-mode connect if this page load is OpenRouter's callback.
 * Returns null when it isn't one (the common case: no pending record or no
 * `code`), else the key + pending record (or throws a human error). State must
 * match the pending record: a code we didn't ask for is refused.
 */
export async function completeOAuthRedirect(
  href: string,
  opts: { storage?: KVStore; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ key: string; pending: PendingOAuth } | null> {
  const parsed = parseCallback(href);
  if (parsed.kind === "none") return null;
  const pending = readPendingOAuth(opts.storage, opts.now);
  if (!pending || pending.mode !== "redirect") return null; // not ours
  clearPendingOAuth(opts.storage);
  if (parsed.kind === "error") throw new Error(`OpenRouter sign-in was cancelled (${parsed.message}).`);
  if (parsed.state !== null && parsed.state !== pending.state) {
    throw new Error("That OpenRouter sign-in didn't match this app's request. Connect again.");
  }
  const key = await exchangeCode(parsed.code, pending.verifier, opts.fetchImpl);
  return { key, pending };
}

/** Finish a code-mode (iOS) connect with the code the user pasted. */
export async function completeOAuthCode(
  code: string,
  opts: { storage?: KVStore; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ key: string; pending: PendingOAuth }> {
  const pending = readPendingOAuth(opts.storage, opts.now);
  if (!pending) throw new Error("Start “Connect OpenRouter” again — the sign-in request expired.");
  const key = await exchangeCode(code, pending.verifier, opts.fetchImpl);
  clearPendingOAuth(opts.storage);
  return { key, pending };
}
