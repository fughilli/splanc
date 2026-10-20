/**
 * Web Crypto helpers for the relay (Workers runtime and Node >= 20 alike):
 * base64url, random identifiers, SHA-256, HMAC-SHA-256, Ed25519 verify and the
 * pairing-code alphabet.
 */

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(n: number): Uint8Array {
  const u = new Uint8Array(n);
  crypto.getRandomValues(u);
  return u;
}

/** 32 random bytes, base64url (43 chars): token and code secrets. */
export const randomSecret = () => b64url(randomBytes(32));

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A bridge id: 20 lower-case base32 chars (100 bits). */
export function randomBridgeId(): string {
  let s = "";
  for (const b of randomBytes(20)) s += BASE32[b & 31];
  return s;
}

export const BRIDGE_ID_RE = /^[a-z2-7]{20}$/;

/** Pairing-code alphabet: 32 symbols, no 0/O/1/I (read off a small screen). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** `ABCD-EFGH`: 8 symbols = 40 bits. */
export function randomPairingCode(): string {
  let s = "";
  for (const b of randomBytes(8)) s += CODE_ALPHABET[b & 31];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Canonical form of what a person typed: upper case, separators dropped. Null
 * when it can't be a code (wrong length, or a symbol outside the alphabet). */
export function normalizePairingCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s\-_.]/g, "");
  if (s.length !== 8 || ![...s].every((c) => CODE_ALPHABET.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

export async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256b64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

export async function hmac(keyB64: string, msg: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromB64url(keyB64) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return b64url(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}

/** Constant-time string comparison (same length required). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Verify an Ed25519 signature; false on any malformed input. */
export async function ed25519Verify(publicKeyB64: string, msg: string, sigB64: string): Promise<boolean> {
  try {
    const raw = fromB64url(publicKeyB64);
    if (raw.length !== 32) return false;
    const key = await crypto.subtle.importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, fromB64url(sigB64) as BufferSource, enc.encode(msg));
  } catch {
    return false;
  }
}
