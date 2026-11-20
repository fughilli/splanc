/**
 * The JSON Web Token pieces Sign in with Apple / Google need, on Web Crypto
 * only (Workers and Node alike, no dependency):
 *
 * - parse a compact JWS and verify an RS256 signature against a JWKS (Apple's
 *   and Google's ID tokens are both RS256), with a small per-isolate key
 *   cache (refetched hourly, or when a token names a key id we don't have,
 *   at most once a minute: providers rotate keys without notice);
 * - check the standard claims (issuer, audience, expiry with a little skew);
 * - sign an ES256 JWT (Apple's `client_secret` is one, signed with the
 *   Sign in with Apple .p8 key).
 */

import { b64url, fromB64url } from "../crypto";

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  [k: string]: unknown;
}

export interface JwtParts {
  header: { alg?: string; kid?: string; typ?: string };
  claims: Record<string, unknown>;
  signingInput: string;
  signature: Uint8Array;
}

export class JwtError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "JwtError";
  }
}

/** Split and decode a compact JWS (no verification). */
export function parseJwt(token: unknown): JwtParts {
  if (typeof token !== "string" || token.length > 8192) throw new JwtError("malformed");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p))) throw new JwtError("malformed");
  try {
    const header = JSON.parse(dec.decode(fromB64url(parts[0]!))) as JwtParts["header"];
    const claims = JSON.parse(dec.decode(fromB64url(parts[1]!))) as Record<string, unknown>;
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") throw new Error("shape");
    return { header, claims, signingInput: `${parts[0]}.${parts[1]}`, signature: fromB64url(parts[2]!) };
  } catch {
    throw new JwtError("malformed");
  }
}

// -- JWKS ------------------------------------------------------------------------------

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface CacheEntry {
  keys: Jwk[];
  fetchedAt: number;
}

const JWKS_TTL_MS = 60 * 60_000;
const JWKS_MIN_REFETCH_MS = 60_000;

/** Per-isolate JWKS cache. One per relay; tests make their own. */
export class JwksCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly fetchImpl: Fetch = (u, i) => fetch(u, i),
    private readonly clock: () => number = () => Date.now(),
  ) {}

  private async load(url: string): Promise<Jwk[]> {
    const r = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new JwtError("jwks_unavailable");
    const b = (await r.json().catch(() => null)) as { keys?: unknown } | null;
    const keys = Array.isArray(b?.keys) ? (b.keys as Jwk[]).filter((k) => k && typeof k === "object" && typeof k.kty === "string") : [];
    if (!keys.length) throw new JwtError("jwks_unavailable");
    this.entries.set(url, { keys, fetchedAt: this.clock() });
    return keys;
  }

  /** The key `kid` from `url`, refetching when it's missing or the cache is old. */
  async key(url: string, kid: string | undefined): Promise<Jwk | null> {
    const t = this.clock();
    let e = this.entries.get(url);
    if (!e || t - e.fetchedAt > JWKS_TTL_MS) e = { keys: await this.load(url), fetchedAt: t };
    let k = e.keys.find((x) => x.kid === kid);
    if (!k && t - e.fetchedAt >= JWKS_MIN_REFETCH_MS) k = (await this.load(url)).find((x) => x.kid === kid);
    return k ?? null;
  }
}

async function verifyRs256(jwk: Jwk, parts: JwtParts): Promise<boolean> {
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return false;
  if (jwk.alg && jwk.alg !== "RS256") return false;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, parts.signature as BufferSource, enc.encode(parts.signingInput));
}

export interface VerifyOpts {
  jwksUrl: string;
  /** Accepted `iss` values. */
  issuers: readonly string[];
  /** Accepted `aud` values (our client ids). */
  audiences: readonly string[];
  nowS: number;
  /** Clock skew allowed on exp / iat (seconds). */
  skewS?: number;
  /** Tokens without `exp` / `sub` (Apple's server notifications): accept
   * when `iat` is at most this old instead, and don't require a subject. */
  notification?: { maxAgeS: number };
}

/**
 * Verify an RS256 JWT from a provider: signature by a key in its JWKS, the
 * issuer, one of our audiences, not expired, not issued in the future.
 * Returns the claims; throws JwtError with a short reason otherwise.
 */
export async function verifyJwt(token: unknown, opts: VerifyOpts, jwks: JwksCache): Promise<Record<string, unknown>> {
  const p = parseJwt(token);
  if (p.header.alg !== "RS256") throw new JwtError("bad_alg");
  const key = await jwks.key(opts.jwksUrl, p.header.kid);
  if (!key) throw new JwtError("unknown_key");
  if (!(await verifyRs256(key, p))) throw new JwtError("bad_signature");
  const c = p.claims;
  const skew = opts.skewS ?? 60;
  if (typeof c["iss"] !== "string" || !opts.issuers.includes(c["iss"])) throw new JwtError("bad_issuer");
  const aud = c["aud"];
  const auds = Array.isArray(aud) ? aud : [aud];
  if (!auds.some((a) => typeof a === "string" && opts.audiences.includes(a))) throw new JwtError("bad_audience");
  if (typeof c["iat"] === "number" && c["iat"] - skew > opts.nowS) throw new JwtError("not_yet_valid");
  if (opts.notification) {
    if (typeof c["exp"] === "number" ? c["exp"] + skew <= opts.nowS : typeof c["iat"] !== "number" || c["iat"] + opts.notification.maxAgeS < opts.nowS) {
      throw new JwtError("expired");
    }
    return c;
  }
  if (typeof c["exp"] !== "number" || c["exp"] + skew <= opts.nowS) throw new JwtError("expired");
  if (typeof c["sub"] !== "string" || !c["sub"] || c["sub"].length > 255) throw new JwtError("no_subject");
  return c;
}

// -- ES256 signing (Apple client_secret) -----------------------------------------------

/** The DER bytes of a PEM block (the .p8 file Apple hands out is PKCS#8). */
export function pemBytes(pem: string): Uint8Array {
  const body = pem.replace(/-----(BEGIN|END) [A-Z ]+-----/g, "").replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/=]+$/.test(body)) throw new JwtError("bad_key");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const json64 = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

/** Sign `claims` as an ES256 JWT with a PKCS#8 P-256 key (PEM). Web Crypto's
 * ECDSA output is already the raw r||s form JWS wants. */
export async function signEs256(pkcs8Pem: string, kid: string, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(pkcs8Pem) as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const input = `${json64({ alg: "ES256", kid, typ: "JWT" })}.${json64(claims)}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(input));
  return `${input}.${b64url(sig)}`;
}
