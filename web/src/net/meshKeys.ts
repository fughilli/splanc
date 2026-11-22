/**
 * The mesh admin's cryptography on the app side (docs/design/mesh-m7.md "M8 (app)",
 * mesh.md §7.9): the session grant and the key-rotation order the app signs, byte for byte
 * as firmware/mesh/src/admin.rs (Grant) and rekey.rs (RekeyOrder) lay them out, and the
 * key hashes the firmware names device keys by.
 *
 * Signatures are ECDSA P-256 over SHA-256 of the signed bytes, r ‖ s (64 bytes): exactly
 * what WebCrypto's ECDSA returns (IEEE P1363), and what the C6 verifies with MbedTLS.
 * The signing key is a WebCrypto key the browser keeps non-extractable (store/meshStore.ts):
 * fixtures only ever get its public half.
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
