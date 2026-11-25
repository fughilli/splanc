/**
 * The mesh admin's cryptography on the app side (docs/design/mesh-m7.md "M8 (app)",
 * mesh.md §7.9): the session grant and the key-rotation order the app signs, byte for byte
 * as firmware/mesh/src/admin.rs (Grant) and rekey.rs (RekeyOrder) lay them out, and the
 * key hashes the firmware names device keys by.
 *
 * Signatures are ECDSA P-256 over SHA-256 of the signed bytes, r ‖ s (64 bytes): exactly
 * what WebCrypto's ECDSA returns (IEEE P1363), and what the C6 verifies with MbedTLS.
 * The signing key derives from a 16-byte admin secret (desk D-442: exportable, so a mesh can
 * be backed up and administered from a second phone), exactly as mesh_admin_tool derives it
 * (host_keys.rs AdminSigner::from_secret); the browser imports the derived private key as a
 * non-extractable WebCrypto key to sign. Fixtures only ever get its public half.
 */

/** The admin's signer: the public key fixtures hold (65 B, uncompressed P-256) and sign(). */
export interface MeshAdminSigner {
  readonly publicKey: Uint8Array;
  sign(msg: Uint8Array): Promise<Uint8Array>;
}

const enc = new TextEncoder();

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("this browser has no WebCrypto (a secure https page is needed)");
  return s;
}

/** Big-endian byte writer (firmware/mesh/src/codec.rs W). */
class W {
  private parts: number[] = [];
  put(b: Uint8Array | readonly number[]): this {
    for (const x of b) this.parts.push(x & 0xff);
    return this;
  }
  u8(v: number): this {
    return this.put([v]);
  }
  u16(v: number): this {
    return this.put([(v >>> 8) & 0xff, v & 0xff]);
  }
  u32(v: number): this {
    return this.put([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** A fresh non-zero u32 (mesh ids, admin sessions: 0 means "none" on the wire). */
export function randomU32(): number {
  for (;;) {
    const b = randomBytes(4);
    const v = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0;
    if (v !== 0) return v;
  }
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
  const s = h.trim();
  if (s.length % 2 !== 0 || /[^0-9a-f]/i.test(s)) throw new Error("bad hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

async function sha256(b: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", b as BufferSource));
}

/** SHA-256(key)[..8]: how the firmware names a device key (crypto.rs key_hash). */
export async function keyHash(publicKey: Uint8Array): Promise<Uint8Array> {
  return (await sha256(publicKey)).slice(0, 8);
}

/** The order's commitment to the new keys: HMAC-SHA256("SMkeys1", mesh key ‖ site secret)[..16]
 * (rekey.rs keys_hash). */
export async function keysHash(meshKey: Uint8Array, siteSecret: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", enc.encode("SMkeys1") as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const msg = new Uint8Array(meshKey.length + siteSecret.length);
  msg.set(meshKey, 0);
  msg.set(siteSecret, meshKey.length);
  return new Uint8Array(await subtle().sign("HMAC", k, msg as BufferSource)).slice(0, 16);
}

// -- The session grant ----------------------------------------------------------------

export const GRANT_LEN = 144;
const T_GRANT = 0x40;

export interface GrantFields {
  meshId: number;
  /** The admin session (non-zero). */
  session: number;
  /** The gateway's node id (MeshState.node) and device key (MeshState.device_key). */
  gateway: number;
  gatewayKey: Uint8Array;
  /** Expiry in mesh seconds (MeshState.mesh_s + a lifetime). */
  notAfter: number;
}

/** The 87 signed bytes: "SMgrant1" ‖ mesh id ‖ session ‖ gateway ‖ gateway key ‖ not_after. */
export function grantSignedBytes(g: GrantFields): Uint8Array {
  if (g.gatewayKey.length !== 65) throw new Error("the gateway key must be 65 bytes");
  return new W().put(enc.encode("SMgrant1")).u32(g.meshId).u32(g.session).u16(g.gateway).put(g.gatewayKey).u32(g.notAfter).done();
}

/** The grant `mesh_admin.unlock` carries (SessionMsg::Grant: 0x40 ‖ fields ‖ signature, 144 B). */
export async function signGrant(signer: MeshAdminSigner, g: GrantFields): Promise<Uint8Array> {
  const sig = await signer.sign(grantSignedBytes(g));
  const out = new W().u8(T_GRANT).u32(g.meshId).u32(g.session).u16(g.gateway).put(g.gatewayKey).u32(g.notAfter).put(sig).done();
  if (out.length !== GRANT_LEN) throw new Error("grant length");
  return out;
}

// -- The key-rotation order (revoke) ----------------------------------------------------

/** Revocations one order carries (rekey.rs ORDER_REVOKED). */
export const ORDER_REVOKED = 4;
export const ORDER_LEN = 4 + 1 + 16 + 2 + 1 + ORDER_REVOKED * 8 + 64;

export interface RekeyFields {
  meshId: number;
  /** The new key epoch (the current one + 1, mod 256). */
  epoch: number;
  meshKey: Uint8Array;
  siteSecret: Uint8Array;
  /** The revocation list's new version (higher than the members'). */
  revVersion: number;
  /** Device-key hashes (8 B each) to put on the revocation list (at most 4). */
  revoked: Uint8Array[];
}

function revokedTable(revoked: Uint8Array[]): Uint8Array {
  if (revoked.length > ORDER_REVOKED) throw new Error(`at most ${ORDER_REVOKED} fixtures per removal`);
  const t = new Uint8Array(ORDER_REVOKED * 8);
  revoked.forEach((h, i) => {
    if (h.length !== 8) throw new Error("a key hash is 8 bytes");
    t.set(h, i * 8);
  });
  return t;
}

/** The order `mesh_admin.revoke` carries (RekeyOrder::encode, 120 B). */
export async function signRekeyOrder(signer: MeshAdminSigner, o: RekeyFields): Promise<Uint8Array> {
  if (o.meshKey.length !== 16 || o.siteSecret.length !== 32) throw new Error("mesh key 16 B, site secret 32 B");
  const kh = await keysHash(o.meshKey, o.siteSecret);
  const table = revokedTable(o.revoked);
  const n = o.revoked.length;
  const signed = new W().put(enc.encode("SMrekey1")).u32(o.meshId).u8(o.epoch).put(kh).u16(o.revVersion).u8(n).put(table).done();
  const sig = await signer.sign(signed);
  return new W().u32(o.meshId).u8(o.epoch).put(kh).u16(o.revVersion).u8(n).put(table).put(sig).done();
}

// -- WebCrypto signer -------------------------------------------------------------------

/** A new admin key pair. The private half is non-extractable: it can sign in this browser
 * and be stored (IndexedDB keeps CryptoKeys as they are), never read out. */
export async function generateAdminKeyPair(): Promise<CryptoKeyPair> {
  return (await subtle().generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as CryptoKeyPair;
}

/** The public key as fixtures hold it (65 B uncompressed SEC1). */
export async function exportPublicKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().exportKey("raw", key));
}

export function webCryptoSigner(privateKey: CryptoKey, publicKey: Uint8Array): MeshAdminSigner {
  return {
    publicKey,
    async sign(msg: Uint8Array): Promise<Uint8Array> {
      return new Uint8Array(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, msg as BufferSource));
    },
  };
}

/** Check a signature (the tests; and a cheap self-check before a key is first used). */
export async function verifyAdminSignature(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array): Promise<boolean> {
  const k = await subtle().importKey("raw", publicKey as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return subtle().verify({ name: "ECDSA", hash: "SHA-256" }, k, sig as BufferSource, msg as BufferSource);
}

// -- The admin key from its exportable secret (D-442) -------------------------------------

// P-256 (SEC 2): the field prime, the group order, the generator. Plain BigInt affine
// arithmetic: one scalar multiplication per mesh, when its signer is first needed.
const P256_P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const P256_G: [bigint, bigint] = [
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
];

function mod(a: bigint, m: bigint): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

function inv(a: bigint, m: bigint): bigint {
  let [r0, r1, t0, t1] = [mod(a, m), m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [t0, t1] = [t1, t0 - q * t1];
  }
  return mod(t0, m);
}

type Pt = [bigint, bigint] | null;

function ptAdd(a: Pt, b: Pt): Pt {
  if (a === null) return b;
  if (b === null) return a;
  const p = P256_P;
  let l: bigint;
  if (a[0] === b[0]) {
    if (mod(a[1] + b[1], p) === 0n) return null;
    l = mod((3n * a[0] * a[0] - 3n) * inv(2n * a[1], p), p);
  } else {
    l = mod((b[1] - a[1]) * inv(b[0] - a[0], p), p);
  }
  const x = mod(l * l - a[0] - b[0], p);
  return [x, mod(l * (a[0] - x) - a[1], p)];
}

function bytesToBig(b: Uint8Array): bigint {
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v;
}

function bigTo32(v: bigint): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** The public key (65 B uncompressed) of private scalar `d`. */
export function p256PublicKey(d: Uint8Array): Uint8Array {
  let k = bytesToBig(d);
  let acc: Pt = null;
  let add: Pt = P256_G;
  while (k > 0n) {
    if (k & 1n) acc = ptAdd(acc, add);
    add = ptAdd(add, add);
    k >>= 1n;
  }
  if (acc === null) throw new Error("bad scalar");
  const out = new Uint8Array(65);
  out[0] = 4;
  out.set(bigTo32(acc[0]), 1);
  out.set(bigTo32(acc[1]), 33);
  return out;
}

/** The private scalar of a mesh's admin secret: HKDF-SHA256(salt = mesh id BE, ikm = secret,
 * info = "splanc mesh admin sign" ‖ ctr), the first ctr that gives a valid scalar (host_keys.rs). */
export async function adminScalar(secret: Uint8Array, meshId: number): Promise<Uint8Array> {
  if (secret.length !== 16) throw new Error("an admin secret is 16 bytes");
  const ikm = await subtle().importKey("raw", secret as BufferSource, "HKDF", false, ["deriveBits"]);
  const salt = new W().u32(meshId >>> 0).done();
  const label = enc.encode("splanc mesh admin sign");
  for (let ctr = 0; ctr < 256; ctr++) {
    const info = new Uint8Array(label.length + 1);
    info.set(label);
    info[label.length] = ctr;
    const d = new Uint8Array(
      await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource }, ikm, 256),
    );
    const v = bytesToBig(d);
    if (v > 0n && v < P256_N) return d;
  }
  throw new Error("no valid scalar");
}

function b64url(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The admin signer of a mesh's exportable secret (D-442): the derived private key imported as
 * a non-extractable WebCrypto key; the scalar is zeroed once imported. */
export async function adminSignerFromSecret(secret: Uint8Array, meshId: number): Promise<MeshAdminSigner> {
  const d = await adminScalar(secret, meshId);
  const publicKey = p256PublicKey(d);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: b64url(d),
    x: b64url(publicKey.subarray(1, 33)),
    y: b64url(publicKey.subarray(33, 65)),
    ext: false,
  };
  d.fill(0);
  const key = await subtle().importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  jwk.d = "";
  return webCryptoSigner(key, publicKey);
}
