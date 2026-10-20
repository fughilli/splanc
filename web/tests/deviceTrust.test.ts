/**
 * Per-device certificate TOFU in the app (src/net/deviceTrust.ts,
 * docs/design/per-device-cert.md): first sight remembers the pin by device id
 * (welcome MAC), a known device reporting a different certificate is a "changed"
 * warning that is NOT recorded until the user re-trusts, the legacy shared
 * certificate re-pins silently, and a device still generating its first-boot
 * identity is reported as such.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  CertPinStore,
  LEGACY_SHARED_CERT_SHA256,
  certChangedMessage,
  decideCert,
  normFingerprint,
} from "../src/net/deviceTrust";

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
}

const A = "aa".repeat(32);
const B = "bb".repeat(32);
const MAC = "CC:FD:49:00:AA:01";
let mem: MemStorage;
let pins: CertPinStore;

beforeEach(() => {
  mem = new MemStorage();
  pins = new CertPinStore(() => mem);
});

test("decideCert: first sight, known, changed, generating, none", () => {
  assert.deepEqual(decideCert(undefined, { state: "ready", certSha256: A }), { kind: "first-sight", pin: A });
  assert.deepEqual(decideCert(A, { state: "ready", certSha256: A.toUpperCase() }), { kind: "known", pin: A });
  assert.deepEqual(decideCert(A, { state: "ready", certSha256: B }), { kind: "changed", known: A, reported: B });
  assert.deepEqual(decideCert(A, { state: "generating", certSha256: "" }), { kind: "generating" });
  assert.deepEqual(decideCert(A, { state: "ready", certSha256: "" }), { kind: "none" });
  assert.deepEqual(decideCert(A, null), { kind: "none" });
});

test("the legacy shared certificate re-pins silently", () => {
  const v = decideCert(LEGACY_SHARED_CERT_SHA256, { state: "ready", certSha256: B });
  assert.deepEqual(v, { kind: "legacy-repin", pin: B, previous: LEGACY_SHARED_CERT_SHA256 });
  pins.set(MAC, LEGACY_SHARED_CERT_SHA256);
  assert.equal(pins.check(MAC, { state: "ready", certSha256: B }).kind, "legacy-repin");
  assert.equal(pins.get(MAC), B);
});

test("TOFU store: remembered on first sight, keyed case-insensitively by MAC", () => {
  assert.equal(pins.check(MAC, { state: "ready", certSha256: A }).kind, "first-sight");
  assert.equal(pins.get(MAC.toLowerCase()), A);
  assert.equal(pins.check(MAC, { state: "ready", certSha256: A }).kind, "known");
  // A fresh store over the same storage remembers it (survives reloads).
  assert.equal(new CertPinStore(() => mem).get(MAC), A);
});

test("a changed certificate warns and is not recorded until re-trusted", () => {
  pins.check(MAC, { state: "ready", certSha256: A });
  const v = pins.check(MAC, { state: "ready", certSha256: B });
  assert.equal(v.kind, "changed");
  assert.equal(pins.get(MAC), A, "the pin is NOT replaced by a changed report");
  assert.equal(pins.check(MAC, { state: "ready", certSha256: B }).kind, "changed", "still warns next time");
  pins.retrust(MAC, B);
  assert.equal(pins.check(MAC, { state: "ready", certSha256: B }).kind, "known");
  pins.forget(MAC);
  assert.equal(pins.get(MAC), undefined);
});

test("a generating device records nothing", () => {
  assert.equal(pins.check(MAC, { state: "generating", certSha256: "" }).kind, "generating");
  assert.equal(pins.get(MAC), undefined);
  assert.equal(pins.check("", { state: "ready", certSha256: A }).kind, "none");
});

test("storage failures degrade to first sight, never throw", () => {
  const broken = new CertPinStore(() => ({
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  }));
  assert.equal(broken.check(MAC, { state: "ready", certSha256: A }).kind, "first-sight");
  assert.equal(new CertPinStore(() => null).get(MAC), undefined);
});

test("the legacy hash matches the shared CN=heapless cert; helpers", () => {
  assert.equal(LEGACY_SHARED_CERT_SHA256.length, 64);
  assert.equal(normFingerprint("AB:cd:01"), "abcd01");
  assert.match(certChangedMessage("Porch"), /factory-reset/);
});
