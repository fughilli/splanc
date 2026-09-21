/**
 * Firmware build-info display (FUG-126): the device card's "Firmware version" +
 * "Firmware build" rows must report what the device sends in `welcome`
 * (fwVersion / fwGitCommit / fwGitDirty), and fall back to a clear placeholder
 * before a device has ever connected. deviceSheet renders these rows straight
 * from firmwareCardFields, so pinning that function pins the UI. The store leg
 * (applyWelcome → get) is exercised too, so a protocol field rename in codegen —
 * which would silently blank the version in the UI — fails here.
 *
 * Runs under a localStorage shim (the store reads localStorage lazily).
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
const mem = new MemStorage();
(globalThis as { localStorage?: unknown }).localStorage = mem;

import { firmwareCardFields, buildLabel, commitUrl } from "../src/buildInfo";
import { deviceStore } from "../src/store/deviceStore";

beforeEach(() => {
  mem.clear();
});

const FULL = "0123456789abcdef0123456789abcdef01234567"; // 40-char git hash

test("firmwareCardFields reports version + linked build for a connected device", () => {
  const fw = firmwareCardFields({ fwVersion: "1.2.0", fwGitCommit: FULL, fwGitDirty: false });
  assert.equal(fw.version, "1.2.0");
  assert.equal(fw.build, "01234567");
  assert.equal(fw.buildUrl, commitUrl(FULL));
  assert.equal(fw.commit, FULL);
});

test("firmwareCardFields marks a dirty build", () => {
  const fw = firmwareCardFields({ fwVersion: "0.0.0-dev", fwGitCommit: FULL, fwGitDirty: true });
  assert.equal(fw.version, "0.0.0-dev"); // dev builds still report a concrete version, never blank
  assert.equal(fw.build, buildLabel(FULL, true));
  assert.match(fw.build, / \(dirty\)$/);
});

test("firmwareCardFields falls back to a placeholder before the device has connected", () => {
  // Older firmware / a device only ever seen by URL: no fields yet.
  const fw = firmwareCardFields({});
  assert.equal(fw.version, "unknown (connect once)");
  assert.equal(fw.build, "unknown (connect once)");
  assert.equal(fw.buildUrl, null); // rendered as plain text, not a broken link
  assert.equal(fw.commit, "");
});

test("an empty-string version (unstamped build) still shows the placeholder, not a blank row", () => {
  const fw = firmwareCardFields({ fwVersion: "", fwGitCommit: "", fwGitDirty: false });
  assert.equal(fw.version, "unknown (connect once)");
  assert.equal(fw.build, "unknown (connect once)");
});

test("a device's welcome flows through the store to the exact UI strings", () => {
  // The whole chain a user sees: connect → applyWelcome(welcome) → device card.
  const d = deviceStore.upsert("wss://192.168.68.54/ws");
  deviceStore.applyWelcome(d.id, {
    mac: "AA:BB:CC:DD:EE:FF",
    deviceName: "Kitchen Widget",
    fwVersion: "1.4.2",
    fwGitCommit: FULL,
    fwGitDirty: false,
  });
  const stored = deviceStore.get(d.id)!;
  const fw = firmwareCardFields(stored);
  assert.equal(fw.version, "1.4.2");
  assert.equal(fw.build, "01234567");
  assert.equal(fw.buildUrl, commitUrl(FULL));
});
