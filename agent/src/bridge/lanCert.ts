/**
 * The bridge's own TLS identity for its LAN live port (docs/design/live-vj-relay.md,
 * "Direct LAN path"): a self-signed ECDSA P-256 certificate, made once and kept in
 * `<state dir>/live-tls.json` (mode 0600). Node can't mint X.509 by itself and the
 * Pi image has no guaranteed `openssl`, so the certificate is DER-encoded here.
 *
 * The app learns the certificate's SHA-256 over the relay (an authenticated
 * channel) before it ever dials the LAN port, so a native client pins it and a
 * browser user can compare it; it's also what TOFU means for the bridge.
 */

import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LanCert {
  key: string;
  cert: string;
  /** SHA-256 of the DER certificate, lower-case hex (no separators). */
  sha256: string;
  /** Unix ms. */
  notAfter: number;
}

/** Validity: under the 398 days browsers accept, renewed when < 30 days remain. */
export const CERT_DAYS = 397;
const RENEW_MS = 30 * 86_400_000;

// -- DER ------------------------------------------------------------------------------

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  for (let x = n; x > 0; x >>= 8) b.unshift(x & 0xff);
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const ctx = (n: number, body: Buffer) => tlv(0xa0 | n, body);

function oid(dotted: string): Buffer {
  const p = dotted.split(".").map(Number);
  const out: number[] = [40 * p[0]! + p[1]!];
  for (const v of p.slice(2)) {
    const b: number[] = [v & 0x7f];
    for (let x = v >> 7; x > 0; x >>= 7) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}

function int(b: Buffer): Buffer {
  let x = b;
  while (x.length > 1 && x[0] === 0 && (x[1]! & 0x80) === 0) x = x.subarray(1);
  if (x[0]! & 0x80) x = Buffer.concat([Buffer.from([0]), x]);
  return tlv(0x02, x);
}

function time(ms: number): Buffer {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  return y < 2050 ? tlv(0x17, Buffer.from(`${p(y % 100)}${body}`)) : tlv(0x18, Buffer.from(`${y}${body}`));
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

/** A self-signed certificate for `key` (EC P-256), CN `cn`, DNS SANs `dns`. */
export function selfSigned(key: { privateKey: KeyObject; publicKey: KeyObject }, cn: string, dns: string[], nowMs = Date.now()): Buffer {
  const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))));
  const serial = randomBytes(16);
  serial[0] = serial[0]! & 0x7f;
  const spki = key.publicKey.export({ type: "spki", format: "der" });
  const san = seq(...dns.map((d) => tlv(0x82, Buffer.from(d, "ascii"))));
  const exts = ctx(
    3,
    seq(
      seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq())), // basicConstraints: critical, CA false
      seq(oid("2.5.29.17"), tlv(0x04, san)), // subjectAltName
      seq(oid("2.5.29.37"), tlv(0x04, seq(oid("1.3.6.1.5.5.7.3.1")))), // extKeyUsage: serverAuth
    ),
  );
  const tbs = seq(
    ctx(0, int(Buffer.from([2]))),
    int(serial),
    ECDSA_SHA256,
    name,
    seq(time(nowMs - 86_400_000), time(nowMs + CERT_DAYS * 86_400_000)),
    name,
    spki,
    exts,
  );
  const sig = sign("sha256", tbs, key.privateKey); // DER ECDSA-Sig-Value
  return seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

const pem = (label: string, der: Buffer) =>
  `-----BEGIN ${label}-----\n${der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n?$/, "\n")}-----END ${label}-----\n`;

export const sha256Hex = (der: Buffer) => createHash("sha256").update(der).digest("hex");

/** Make a fresh identity (key + self-signed cert). */
export function makeLanCert(nowMs = Date.now()): LanCert {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = selfSigned(pair, "Splanc bridge", ["splanc-bridge.local", "localhost"], nowMs);
  const key = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { key, cert: pem("CERTIFICATE", der), sha256: sha256Hex(der), notAfter: new X509Certificate(der).validToDate.getTime() };
}

/** The bridge's LAN certificate from `<stateDir>/live-tls.json`, made (or renewed
 * near expiry) when needed. */
export function loadLanCert(stateDir: string, nowMs = Date.now()): LanCert {
  const file = join(stateDir, "live-tls.json");
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as LanCert;
    if (c.key && c.cert && c.sha256 && c.notAfter - nowMs > RENEW_MS) return c;
  } catch {
    // none yet
  }
  const c = makeLanCert(nowMs);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(`${file}.tmp`, JSON.stringify(c), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  chmodSync(file, 0o600);
  return c;
}
