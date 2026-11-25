/**
 * Share links (docs/design/share-links.md): one Splanc link that carries something to
 * another person's app, sent through the system share sheet (Messages, mail, a chat app).
 *
 *     https://splanc.io/app/#/share?s=1.<sealed>&k=<key>      the key rides in the link
 *     https://splanc.io/app/#/share?s=1.<sealed>&c=<salt>     a code, sent another way, opens it
 *
 * Everything after `#` stays on the two phones: a browser never sends the fragment to a
 * server, so splanc.io (and any CDN log) sees only `/app/`. The messaging app that carries
 * the link does see it, which is why a link can instead need a code sent separately.
 *
 * `sealed` is AES-GCM-128 over a JSON envelope `{v, kind, at, from?, body}`; `kind` says
 * what `body` is (`mesh`: a mesh's admin access, `fixture`: one fixture's own admin token;
 * later effects, maps and marketplace listings). The key is either random and in the link
 * (`k`), or PBKDF2 from a 10-character code with the salt in the link (`c`).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The fragment route a share link opens (router path `/share`). */
export const SHARE_ROUTE = "/share";
export const SHARE_VERSION = 1;
/** PBKDF2 rounds for a code: about 0.2 s on a phone, once per open. */
export const CODE_ITERATIONS = 310_000;
/** Crockford base32 without the look-alikes the decoder folds (I, L → 1; O → 0). */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LEN = 10;

export type ShareKind = "mesh" | "fixture";

export interface ShareEnvelope<B = unknown> {
  v: number;
  kind: ShareKind;
  /** When it was made (ISO). */
  at: string;
  /** The sender's name for it, shown to the receiver ("Kitchen mesh"). */
  title?: string;
  body: B;
}

export interface MadeLink {
  url: string;
  /** The code to send separately (null: the link opens by itself). */
  code: string | null;
}

/** Thrown for a link this app can't open: damaged, a newer version, or a wrong code. */
export class ShareLinkError extends Error {
  constructor(
    message: string,
    readonly reason: "damaged" | "version" | "code",
  ) {
    super(message);
    this.name = "ShareLinkError";
  }
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("this browser has no WebCrypto (a secure https page is needed)");
  return s;
}

function rand(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function b64url(b: Uint8Array): string {
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (/[^A-Za-z0-9_-]/.test(s)) throw new ShareLinkError("This Splanc link is damaged.", "damaged");
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** A fresh code: 10 symbols, 50 bits. */
export function newCode(): string {
  const b = rand(CODE_LEN);
  let s = "";
  for (const x of b) s += CODE_ALPHABET[x & 31];
  return s;
}

/** The code as people read it: XXXXX-XXXXX. */
export function formatCode(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** What someone typed, back to the code: case, spaces, dashes and look-alikes folded. */
export function normalizeCode(typed: string): string {
  return typed
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function codeKey(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", enc.encode(normalizeCode(code)) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: CODE_ITERATIONS },
    base,
    { name: "AES-GCM", length: 128 },
    false,
    ["encrypt", "decrypt"],
  );
}

function ad(): Uint8Array {
  return enc.encode(`splanc share ${SHARE_VERSION}`);
}

/** Make a link. `withCode` keeps the key out of the link: the receiver types the code. */
export async function makeShareLink(
  env: Omit<ShareEnvelope, "v" | "at"> & { at?: string },
  opts: { base: string; withCode?: boolean },
): Promise<MadeLink> {
  const full: ShareEnvelope = { v: SHARE_VERSION, kind: env.kind, at: env.at ?? new Date().toISOString(), body: env.body };
  if (env.title) full.title = env.title;
  const plain = enc.encode(JSON.stringify(full));
  const iv = rand(12);
  let key: CryptoKey;
  let param: string;
  let code: string | null = null;
  if (opts.withCode) {
    code = newCode();
    const salt = rand(16);
    key = await codeKey(code, salt);
    param = `c=${b64url(salt)}`;
  } else {
    const raw = rand(16);
    key = await aesKey(raw);
    param = `k=${b64url(raw)}`;
    raw.fill(0);
  }
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: ad() as BufferSource }, key, plain as BufferSource));
  plain.fill(0);
  const sealed = new Uint8Array(iv.length + ct.length);
  sealed.set(iv, 0);
  sealed.set(ct, iv.length);
  return { url: `${opts.base}#${SHARE_ROUTE}?s=${SHARE_VERSION}.${b64url(sealed)}&${param}`, code };
}

/** A share link, parsed but not yet opened. */
export interface ParsedShare {
  sealed: Uint8Array;
  key: Uint8Array | null;
  salt: Uint8Array | null;
}

/** Parse a link, its fragment, or the fragment's query (`s=…&k=…`). Null: not a share link. */
export function parseShareLink(text: string): ParsedShare | null {
  const t = text.trim();
  const at = t.indexOf(`${SHARE_ROUTE}?`);
  const query = at >= 0 ? t.slice(at + SHARE_ROUTE.length + 1) : t.startsWith("s=") ? t : null;
  if (query === null) return null;
  const q = new URLSearchParams(query);
  const s = q.get("s");
  if (!s) return null;
  const dot = s.indexOf(".");
  const ver = Number(dot > 0 ? s.slice(0, dot) : NaN);
  if (!Number.isInteger(ver)) throw new ShareLinkError("This Splanc link is damaged.", "damaged");
  if (ver > SHARE_VERSION) throw new ShareLinkError("This link was made by a newer Splanc. Update the app to open it.", "version");
  const sealed = fromB64url(s.slice(dot + 1));
  const k = q.get("k");
  const c = q.get("c");
  if (sealed.length < 12 + 16 || (!k && !c)) throw new ShareLinkError("This Splanc link is damaged.", "damaged");
  return { sealed, key: k ? fromB64url(k) : null, salt: c ? fromB64url(c) : null };
}

export function needsCode(p: ParsedShare): boolean {
  return p.key === null;
}

/** Open a parsed link (with the code, when it needs one). */
export async function openShare(p: ParsedShare, code?: string): Promise<ShareEnvelope> {
  let key: CryptoKey;
  if (p.key) key = await aesKey(p.key);
  else {
    if (!code || normalizeCode(code).length !== CODE_LEN) throw new ShareLinkError("Type the 10-character code the sender gave you.", "code");
    key = await codeKey(code, p.salt!);
  }
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: p.sealed.slice(0, 12) as BufferSource, additionalData: ad() as BufferSource }, key, p.sealed.slice(12) as BufferSource),
    );
  } catch {
    throw p.key
      ? new ShareLinkError("This Splanc link is damaged. Ask for it again.", "damaged")
      : new ShareLinkError("That code doesn't open this link. Check it with the sender.", "code");
  }
  let env: ShareEnvelope;
  try {
    env = JSON.parse(dec.decode(plain)) as ShareEnvelope;
  } catch {
    throw new ShareLinkError("This Splanc link is damaged.", "damaged");
  } finally {
    plain.fill(0);
  }
  if (typeof env?.v !== "number" || env.v > SHARE_VERSION) throw new ShareLinkError("This link was made by a newer Splanc. Update the app to open it.", "version");
  if (env.kind !== "mesh" && env.kind !== "fixture") throw new ShareLinkError("This link holds something this version of Splanc can't open. Update the app.", "version");
  return env;
}
