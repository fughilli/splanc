/**
 * Apple In-App Purchase on the relay (docs/design/ai-billing.md §Purchases):
 *
 * - `verifyAppleJws`: StoreKit 2 / App Store Server Notifications v2 signed
 *   data (JWS, ES256). Verified LOCALLY: the x5c chain must be exactly
 *   leaf -> Apple WWDR intermediate -> Apple Root CA G3 (pinned, byte for
 *   byte), every signature must check out, both Apple marker OIDs must be
 *   present, and every certificate must be valid at the payload's
 *   `signedDate`. This is what Apple's own app-store-server-library does
 *   (SignedDataVerifier) with online (OCSP) checks off; no network call, no
 *   secret.
 * - `AppleStoreVerifier`: the PurchaseVerifier / NotificationVerifier for the
 *   "apple" channel on top of it: bundle id, environment, consumable type,
 *   revocation, quantity, the account binding (appAccountToken).
 * - `AppStoreConsumptionSender`: the real "Send Consumption Information" call
 *   (App Store Server API v2), authenticated with a short-lived ES256 JWT made
 *   from our In-App Purchase key. The key is a Worker secret; it never reaches
 *   a client and never appears in a log.
 *
 * Workers have WebCrypto (ECDSA P-256 / P-384 verify, PKCS#8 import) but no
 * X.509 parser, so the few certificate fields we need are read with the small
 * DER reader below.
 */

/** Bytes backed by a plain ArrayBuffer (what WebCrypto takes). */
type Bytes = Uint8Array<ArrayBuffer>;

import { PurchaseError, type ConsumptionRequest, type ConsumptionSender, type RefundNotice, type StoreEnvironment, type StoreNotification, type VerifiedPurchase, type PurchaseVerifier, type NotificationVerifier } from "./purchases";

/** The app's bundle id (web/capacitor.config.ts appId). */
export const APPLE_BUNDLE_ID = "dev.splanc.app";

/**
 * Apple Root CA - G3 (https://www.apple.com/certificateauthority/AppleRootCA-G3.cer),
 * valid 2014-04-30 .. 2039-04-30, SHA-256 fingerprint
 * 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
 * (the test checks it). The only root App Store signed data chains to.
 */
export const APPLE_ROOT_CA_G3 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQL" +
  "DB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMw" +
  "MTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRp" +
  "ZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IA" +
  "BJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqX" +
  "l5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8w" +
  "DgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWT" +
  "xnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

/** Apple's marker extensions (the same ones app-store-server-library checks). */
const OID_APPLE_LEAF = "1.2.840.113635.100.6.11.1"; // App Store receipt signing
const OID_APPLE_WWDR = "1.2.840.113635.100.6.2.1"; // Apple WWDR intermediate
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_EC_PUBLIC_KEY = "1.2.840.10045.2.1";
const CURVES: Record<string, { name: "P-256" | "P-384"; size: number }> = {
  "1.2.840.10045.3.1.7": { name: "P-256", size: 32 },
  "1.3.132.0.34": { name: "P-384", size: 48 },
};
const SIG_HASH: Record<string, "SHA-256" | "SHA-384"> = {
  "1.2.840.10045.4.3.2": "SHA-256", // ecdsa-with-SHA256
  "1.2.840.10045.4.3.3": "SHA-384", // ecdsa-with-SHA384
};

// -- base64 / base64url ----------------------------------------------------------------

export function b64decode(s: string): Bytes {
  const std = s.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  const bin = atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes: Uint8Array | string): string {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let bin = "";
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// -- a minimal DER reader (enough for X.509 certificates) -------------------------------

interface Tlv {
  tag: number;
  /** The whole element (tag + length + value). */
  raw: Bytes;
  value: Bytes;
}

class DerError extends Error {}

function readTlv(buf: Bytes, at: number): { tlv: Tlv; next: number } {
  if (at + 2 > buf.length) throw new DerError("truncated");
  const tag = buf[at]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("high tag numbers are not used here");
  let len = buf[at + 1]!;
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 3 || at + 2 + n > buf.length) throw new DerError("bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[at + 2 + i]!;
    hdr = 2 + n;
  }
  const end = at + hdr + len;
  if (end > buf.length) throw new DerError("truncated value");
  return { tlv: { tag, raw: buf.subarray(at, end), value: buf.subarray(at + hdr, end) }, next: end };
}

/** The children of a constructed element. */
function children(t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < t.value.length; ) {
    const r = readTlv(t.value, at);
    out.push(r.tlv);
    at = r.next;
  }
  return out;
}

function expect(t: Tlv | undefined, tag: number, what: string): Tlv {
  if (!t || t.tag !== tag) throw new DerError(`expected ${what}`);
  return t;
}

function oid(t: Tlv): string {
  const v = expect(t, 0x06, "OID").value;
  if (v.length === 0) throw new DerError("empty OID");
  const parts = [Math.floor(v[0]! / 40), v[0]! % 40];
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    n = n * 128 + (v[i]! & 0x7f);
    if (!(v[i]! & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}

function time(t: Tlv): number {
  const s = new TextDecoder().decode(t.value);
  let m: RegExpExecArray | null;
  if (t.tag === 0x17 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = Number(m[1]);
    return Date.UTC(yy >= 50 ? 1900 + yy : 2000 + yy, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  if (t.tag === 0x18 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }
  throw new DerError("bad time");
}

export interface ParsedCert {
  der: Bytes;
  tbs: Bytes;
  sigHash: "SHA-256" | "SHA-384";
  /** The signature as DER Ecdsa-Sig-Value. */
  sig: Bytes;
  spki: Bytes;
  curve: { name: "P-256" | "P-384"; size: number };
  notBefore: number;
  notAfter: number;
  extensions: Set<string>;
  isCa: boolean;
}

export function parseCert(der: Bytes): ParsedCert {
  const { tlv: cert, next } = readTlv(der, 0);
  if (next !== der.length) throw new DerError("trailing bytes");
  const [tbsT, algT, sigT] = children(expect(cert, 0x30, "Certificate"));
  const tbs = expect(tbsT, 0x30, "TBSCertificate");
  const sigAlg = oid(children(expect(algT, 0x30, "AlgorithmIdentifier"))[0]!);
  const sigHash = SIG_HASH[sigAlg];
  if (!sigHash) throw new DerError(`unsupported signature algorithm ${sigAlg}`);
  const bits = expect(sigT, 0x03, "BIT STRING");
  if (bits.value[0] !== 0) throw new DerError("unused bits in signature");

  let f = children(tbs);
  if (f[0]?.tag === 0xa0) f = f.slice(1); // [0] version
  // serial, signature, issuer, validity, subject, spki, ...
  const validity = children(expect(f[3], 0x30, "Validity"));
  const spkiT = expect(f[5], 0x30, "SubjectPublicKeyInfo");
  const spkiAlg = children(expect(children(spkiT)[0], 0x30, "AlgorithmIdentifier"));
  if (oid(spkiAlg[0]!) !== OID_EC_PUBLIC_KEY) throw new DerError("not an EC key");
  const curve = CURVES[oid(spkiAlg[1]!)];
  if (!curve) throw new DerError("unsupported curve");

  const extensions = new Set<string>();
  let isCa = false;
  const extsT = f.slice(6).find((x) => x.tag === 0xa3);
  if (extsT) {
    for (const ext of children(expect(children(extsT)[0], 0x30, "Extensions"))) {
      const parts = children(ext);
      const id = oid(parts[0]!);
      extensions.add(id);
      if (id === OID_BASIC_CONSTRAINTS) {
        const octets = expect(parts[parts.length - 1], 0x04, "extnValue");
        const bc = children(readTlv(octets.value, 0).tlv);
        isCa = bc[0]?.tag === 0x01 && bc[0].value[0] !== 0;
      }
    }
  }
  return {
    der,
    tbs: tbs.raw,
    sigHash,
    sig: bits.value.subarray(1),
    spki: spkiT.raw,
    curve,
    notBefore: time(validity[0]!),
    notAfter: time(validity[1]!),
    extensions,
    isCa,
  };
}

/** DER Ecdsa-Sig-Value -> the fixed-size r||s WebCrypto verifies. */
export function derSigToRaw(der: Bytes, size: number): Bytes {
  const parts = children(expect(readTlv(der, 0).tlv, 0x30, "Ecdsa-Sig-Value"));
  const out = new Uint8Array(size * 2);
  parts.slice(0, 2).forEach((p, i) => {
    let v = expect(p, 0x02, "INTEGER").value;
    while (v.length > size && v[0] === 0) v = v.subarray(1);
    if (v.length > size) throw new DerError("signature integer too long");
    out.set(v, i * size + (size - v.length));
  });
  return out;
}

const bytesEqual = (a: Bytes, b: Bytes) => a.length === b.length && a.every((x, i) => x === b[i]);

async function publicKey(c: ParsedCert): Promise<CryptoKey> {
  return crypto.subtle.importKey("spki", c.spki, { name: "ECDSA", namedCurve: c.curve.name }, false, ["verify"]);
}

/** Is `child` signed by `issuer`'s key? */
export async function signedBy(child: ParsedCert, issuer: ParsedCert): Promise<boolean> {
  try {
    const raw = derSigToRaw(child.sig, issuer.curve.size);
    return await crypto.subtle.verify({ name: "ECDSA", hash: child.sigHash }, await publicKey(issuer), raw, child.tbs);
  } catch {
    return false;
  }
}

// -- JWS ---------------------------------------------------------------------------------

export class AppleVerificationError extends Error {
  constructor(readonly reason: string) {
    super(`apple signed data: ${reason}`);
  }
}

export interface JwsOptions {
  /** Trusted roots (DER). Default: Apple Root CA G3. Tests pass their own. */
  roots?: Bytes[] | undefined;
  /** "now" in ms (default Date.now()): a payload signed in the future is refused. */
  now?: number | undefined;
}

const DEFAULT_ROOTS = [b64decode(APPLE_ROOT_CA_G3)];

/**
 * Verify App Store signed data (a JWSTransaction, JWSRenewalInfo or a
 * notification's signedPayload) and return its decoded payload.
 */
export async function verifyAppleJws<T = Record<string, unknown>>(jws: string, opts: JwsOptions = {}): Promise<T> {
  if (typeof jws !== "string" || jws.length > 64 * 1024) throw new AppleVerificationError("not a JWS");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new AppleVerificationError("not a JWS");
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: unknown; x5c?: unknown };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64decode(h))) as typeof header;
    payload = JSON.parse(new TextDecoder().decode(b64decode(p))) as Record<string, unknown>;
  } catch {
    throw new AppleVerificationError("malformed");
  }
  if (header.alg !== "ES256") throw new AppleVerificationError("alg must be ES256");
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3 || !header.x5c.every((c) => typeof c === "string")) {
    throw new AppleVerificationError("x5c must hold leaf, intermediate and root");
  }
  let leaf: ParsedCert, inter: ParsedCert, root: ParsedCert;
  try {
    [leaf, inter, root] = (header.x5c as string[]).map((c) => parseCert(b64decode(c))) as [ParsedCert, ParsedCert, ParsedCert];
  } catch (e) {
    throw new AppleVerificationError(`bad certificate (${e instanceof Error ? e.message : "?"})`);
  }
  const roots = opts.roots ?? DEFAULT_ROOTS;
  if (!roots.some((r) => bytesEqual(r, root.der))) throw new AppleVerificationError("untrusted root");
  if (!inter.isCa || !inter.extensions.has(OID_APPLE_WWDR)) throw new AppleVerificationError("intermediate is not Apple's WWDR CA");
  if (!leaf.extensions.has(OID_APPLE_LEAF)) throw new AppleVerificationError("leaf is not an App Store signing certificate");
  if (!(await signedBy(inter, root))) throw new AppleVerificationError("intermediate not signed by the root");
  if (!(await signedBy(leaf, inter))) throw new AppleVerificationError("leaf not signed by the intermediate");

  // Validity at signing time (Apple's verifier does the same without online
  // checks), and no payload "signed" in the future.
  const now = opts.now ?? Date.now();
  const signedDate = typeof payload["signedDate"] === "number" ? (payload["signedDate"] as number) : now;
  if (signedDate > now + 5 * 60_000) throw new AppleVerificationError("signed in the future");
  for (const c of [leaf, inter, root]) {
    if (signedDate < c.notBefore || signedDate > c.notAfter) throw new AppleVerificationError("certificate not valid at signing time");
  }
  if (leaf.curve.name !== "P-256") throw new AppleVerificationError("ES256 needs a P-256 leaf");
  const sig = b64decode(s);
  if (sig.length !== 64) throw new AppleVerificationError("bad signature length");
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, await publicKey(leaf), sig, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new AppleVerificationError("signature does not verify");
  return payload as T;
}

// -- the App Store's decoded payloads (the fields we use) ---------------------------------

/** JWSTransactionDecodedPayload. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  signedDate: number;
  quantity?: number;
  type: string; // "Consumable" | "Non-Consumable" | "Auto-Renewable Subscription" | "Non-Renewing Subscription"
  environment: string; // "Sandbox" | "Production" | "Xcode" | "LocalTesting"
  appAccountToken?: string;
  revocationDate?: number;
  revocationReason?: number;
  inAppOwnershipType?: string;
}

/** ResponseBodyV2DecodedPayload. */
export interface AppleNotification {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  version?: string;
  signedDate: number;
  data?: {
    bundleId?: string;
    environment?: string;
    appAppleId?: number;
    signedTransactionInfo?: string;
    consumptionRequestReason?: string;
  };
  summary?: unknown;
}

/** Apple's environment names -> ours. Xcode / LocalTesting transactions are
 * signed by a local certificate, never by Apple, so they can't verify anyway. */
function storeEnvironment(e: unknown): StoreEnvironment {
  if (e === "Sandbox") return "sandbox";
  if (e === "Production") return "production";
  throw new PurchaseError(400, "bad_receipt", "only App Store Sandbox and Production transactions are accepted");
}

export interface AppleVerifierOptions extends JwsOptions {
  bundleId?: string | undefined;
  /** Production notifications carry the app's App Store id; checked when set. */
  appAppleId?: number | undefined;
}

/**
 * The real "apple" channel verifier: what the app posts after a purchase
 * (`{jws}`: StoreKit 2's Transaction.jwsRepresentation) and what Apple posts
 * to the notification URL (`{signedPayload}`).
 */
export class AppleStoreVerifier implements PurchaseVerifier, NotificationVerifier {
  readonly channel = "apple" as const;
  constructor(private readonly opts: AppleVerifierOptions = {}) {}

  private get bundleId() {
    return this.opts.bundleId ?? APPLE_BUNDLE_ID;
  }

  /** A verified, decoded transaction (no business checks yet). */
  async transaction(jws: string): Promise<AppleTransaction> {
    let t: AppleTransaction;
    try {
      t = await verifyAppleJws<AppleTransaction>(jws, this.opts);
    } catch (e) {
      if (e instanceof AppleVerificationError) throw new PurchaseError(400, "bad_receipt", e.message);
      throw e;
    }
    if (t.bundleId !== this.bundleId) throw new PurchaseError(400, "bad_receipt", "the transaction is for another app");
    if (typeof t.transactionId !== "string" || typeof t.productId !== "string") throw new PurchaseError(400, "bad_receipt", "incomplete transaction");
    return t;
  }

  async verify(raw: unknown): Promise<VerifiedPurchase> {
    const jws = (raw as { jws?: unknown } | null)?.jws;
    if (typeof jws !== "string") throw new PurchaseError(400, "bad_receipt", "{jws} required");
    const t = await this.transaction(jws);
    const environment = storeEnvironment(t.environment);
    if (t.type !== "Consumable") throw new PurchaseError(400, "unknown_product", "credit packs are consumables");
    if (t.revocationDate !== undefined) throw new PurchaseError(400, "revoked", "this purchase was refunded or revoked");
    // The app never asks for more than one pack at a time.
    if ((t.quantity ?? 1) !== 1) throw new PurchaseError(400, "unsupported_quantity", "one pack per purchase");
    if (typeof t.appAccountToken !== "string") throw new PurchaseError(403, "wrong_account", "the purchase carries no account");
    return {
      channel: "apple",
      sku: t.productId,
      // A consumable's originalTransactionId is its transactionId; key on the
      // original so the credit is once per purchase whatever Apple re-sends.
      transactionId: t.originalTransactionId || t.transactionId,
      environment,
      purchasedAt: t.purchaseDate,
      accountRef: t.appAccountToken.toLowerCase(),
    };
  }

  /** The decoded notification (signature + bundle checked), or null when it
   * isn't App Store Server Notifications v2. */
  async notification(body: string): Promise<{ n: AppleNotification; environment: StoreEnvironment } | null> {
    let signedPayload: unknown;
    try {
      signedPayload = (JSON.parse(body) as { signedPayload?: unknown }).signedPayload;
    } catch {
      return null;
    }
    if (typeof signedPayload !== "string") return null;
    let n: AppleNotification;
    try {
      n = await verifyAppleJws<AppleNotification>(signedPayload, this.opts);
    } catch (e) {
      if (e instanceof AppleVerificationError) throw new PurchaseError(400, "bad_notification", e.message);
      throw e;
    }
    if (n.data?.bundleId !== this.bundleId) throw new PurchaseError(400, "bad_notification", "the notification is for another app");
    const environment = storeEnvironment(n.data?.environment);
    if (environment === "production" && this.opts.appAppleId !== undefined && n.data?.appAppleId !== this.opts.appAppleId) {
      throw new PurchaseError(400, "bad_notification", "the notification is for another app id");
    }
    return { n, environment };
  }

  async parse(body: string): Promise<StoreNotification | null> {
    const r = await this.notification(body);
    if (!r) throw new PurchaseError(400, "bad_notification", "{signedPayload} required");
    return this.act(r.n, r.environment);
  }

  /** What a verified notification asks us to do. */
  async act(n: AppleNotification, environment: StoreEnvironment): Promise<StoreNotification> {
    const info = { type: n.notificationType, subtype: n.subtype ?? null, environment };
    const tx = async () => {
      const s = n.data?.signedTransactionInfo;
      if (typeof s !== "string") throw new PurchaseError(400, "bad_notification", "no signedTransactionInfo");
      const t = await this.transaction(s);
      if (storeEnvironment(t.environment) !== environment) throw new PurchaseError(400, "bad_notification", "environment mismatch");
      return t;
    };
    switch (n.notificationType) {
      case "REFUND":
      case "REVOKE": {
        const t = await tx();
        const refund: RefundNotice = {
          channel: "apple",
          transactionId: t.originalTransactionId || t.transactionId,
          kind: n.notificationType === "REFUND" ? "refund" : "revoke",
          environment,
        };
        return { refund, info };
      }
      case "CONSUMPTION_REQUEST": {
        const t = await tx();
        // The ledger keys the credit on the original id; Apple wants the
        // answer for the transaction id it named (the same for consumables).
        return { consumptionRequest: { channel: "apple", transactionId: t.originalTransactionId || t.transactionId, apiTransactionId: t.transactionId, environment }, info };
      }
      default:
        // TEST, ONE_TIME_CHARGE (the app credits from the transaction itself),
        // REFUND_DECLINED, REFUND_REVERSED (rare; the owner adjusts by hand),
        // subscription types we don't sell: acknowledged, logged, nothing else.
        return { info };
    }
  }
}

// -- App Store Server API ----------------------------------------------------------------

export const APP_STORE_API = {
  production: "https://api.storekit.apple.com",
  sandbox: "https://api.storekit-sandbox.apple.com",
} as const;

export interface AppStoreApiKey {
  /** The In-App Purchase key's .p8 contents (PKCS#8 PEM). SECRET. */
  privateKeyPem: string;
  keyId: string;
  issuerId: string;
  bundleId?: string | undefined;
}

function pemToDer(pem: string): Bytes {
  const body = pem.replace(/-----BEGIN [A-Z ]+-----|-----END [A-Z ]+-----|\s+/g, "");
  if (!body) throw new Error("empty key");
  return b64decode(body);
}

/** The App Store Server API bearer token: ES256, our key id, <= 60 min. */
export async function appStoreApiJwt(key: AppStoreApiKey, nowS: number): Promise<string> {
  const k = await crypto.subtle.importKey("pkcs8", pemToDer(key.privateKeyPem), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const h = b64url(JSON.stringify({ alg: "ES256", kid: key.keyId, typ: "JWT" }));
  const p = b64url(JSON.stringify({ iss: key.issuerId, iat: nowS, exp: nowS + 300, aud: "appstoreconnect-v1", bid: key.bundleId ?? APPLE_BUNDLE_ID }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, k, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${b64url(sig)}`;
}

export class AppStoreApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: number | null,
  ) {
    super(`App Store Server API ${status}${errorCode !== null ? ` (errorCode ${errorCode})` : ""}`);
  }
}

/**
 * "Send Consumption Information" (v2):
 * PUT /inApps/v2/transactions/consumption/{transactionId} on the environment's
 * host; 202 Accepted on success. The error only carries the status and Apple's
 * numeric errorCode, never the token.
 */
export class AppStoreConsumptionSender implements ConsumptionSender {
  constructor(
    private readonly key: AppStoreApiKey,
    private readonly deps: { fetchImpl?: typeof fetch | undefined; nowS?: (() => number) | undefined } = {},
  ) {}

  async send(transactionId: string, environment: StoreEnvironment, body: ConsumptionRequest): Promise<void> {
    if (!/^\d{1,32}$/.test(transactionId)) throw new Error("bad transaction id");
    const nowS = this.deps.nowS?.() ?? Math.floor(Date.now() / 1000);
    const token = await appStoreApiJwt(this.key, nowS);
    const r = await (this.deps.fetchImpl ?? fetch)(`${APP_STORE_API[environment]}/inApps/v2/transactions/consumption/${transactionId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.status === 200 || r.status === 202) return;
    const e = (await r.json().catch(() => null)) as { errorCode?: unknown } | null;
    throw new AppStoreApiError(r.status, typeof e?.errorCode === "number" ? e.errorCode : null);
  }
}

/** The In-App Purchase key from the Worker env, when all three parts are set. */
export function appStoreApiKeyFrom(env: { APPLE_IAP_KEY?: string | undefined; APPLE_IAP_KEY_ID?: string | undefined; APPLE_IAP_ISSUER_ID?: string | undefined }): AppStoreApiKey | null {
  if (!env.APPLE_IAP_KEY || !env.APPLE_IAP_KEY_ID || !env.APPLE_IAP_ISSUER_ID) return null;
  return { privateKeyPem: env.APPLE_IAP_KEY, keyId: env.APPLE_IAP_KEY_ID, issuerId: env.APPLE_IAP_ISSUER_ID };
}
