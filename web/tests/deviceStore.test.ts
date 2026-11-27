/**
 * Known-devices store tests (FUG-66): the URL-keyed store must still collapse
 * to ONE record when the same physical device (same welcome MAC) is reached via
 * two different URL spellings — e.g. a BLE-onboarding wss://ledmapper.local/ws
 * and a manually "added by address" wss://<ip>. Without the MAC merge the same
 * player shows up twice. Runs under a localStorage shim (the store reads
 * localStorage lazily inside its methods).
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

import {
  deviceStore,
  deviceDisambiguator,
  clampCaptureStride,
  DEFAULT_CAPTURE_STRIDE,
  MIN_CAPTURE_STRIDE,
  MAX_CAPTURE_STRIDE,
} from "../src/store/deviceStore";

beforeEach(() => {
  mem.clear();
});

test("upsert dedups the same URL and refreshes it in place", () => {
  const a = deviceStore.upsert("wss://192.168.68.54");
  const b = deviceStore.upsert("wss://192.168.68.54", "ignored-label");
  assert.equal(a.id, b.id);
  assert.equal(deviceStore.list().length, 1);
});

test("applyWelcome adopts the MAC and the device's own name", () => {
  const d = deviceStore.upsert("wss://192.168.68.54");
  deviceStore.applyWelcome(d.id, { mac: "AA:BB:CC:DD:EE:FF", deviceName: "Kitchen Widget" });
  const got = deviceStore.get(d.id)!;
  assert.equal(got.bleMac, "AA:BB:CC:DD:EE:FF");
  assert.equal(got.label, "Kitchen Widget");
  assert.equal(got.named, true);
});

test("applyWelcome collapses two URL spellings of the same MAC into one record", () => {
  // Device first known from BLE onboarding (mDNS URL), with user-set fields.
  const ble = deviceStore.upsert("wss://ledmapper.local/ws");
  deviceStore.setFolder(ble.id, "Living Room");
  deviceStore.setBleId("wss://ledmapper.local/ws", "ble-xyz");
  deviceStore.applyWelcome(ble.id, { mac: "AA:BB:CC:DD:EE:FF", deviceName: "Kitchen Widget" });
  assert.equal(deviceStore.list().length, 1);

  // Then the user adds the SAME device "by address" and connects → welcome
  // reports the same MAC. The two records must merge into the freshly-connected
  // one, whose URL we know is reachable.
  const ip = deviceStore.upsert("wss://192.168.68.54");
  assert.notEqual(ip.id, ble.id); // distinct URL → distinct id before the merge
  deviceStore.setActive(ip.id);
  deviceStore.applyWelcome(ip.id, { mac: "AA:BB:CC:DD:EE:FF", deviceName: "Kitchen Widget" });

  const list = deviceStore.list();
  assert.equal(list.length, 1, "duplicate should collapse to a single record");
  const survivor = list[0]!;
  assert.equal(survivor.id, ip.id, "the freshly-connected record survives");
  assert.equal(survivor.wssUrl, "wss://192.168.68.54");
  assert.equal(survivor.folder, "Living Room", "absorbed record's folder is kept");
  assert.equal(survivor.bleId, "ble-xyz", "absorbed record's BLE id is kept");
  assert.equal(deviceStore.activeId(), ip.id, "active follows the survivor");
  assert.equal(deviceStore.get(ble.id), undefined, "the absorbed record is gone");
});

test("a queued rename on the absorbed record is carried onto the survivor", () => {
  // Rename while disconnected queues a pendingName on the mDNS record.
  const ble = deviceStore.upsert("wss://ledmapper.local/ws");
  deviceStore.applyWelcome(ble.id, { mac: "11:22:33:44:55:66" });
  deviceStore.rename(ble.id, "My Lamp"); // sets pendingName

  const ip = deviceStore.upsert("wss://192.168.68.54");
  // No deviceName in welcome (device hasn't adopted the rename yet).
  deviceStore.applyWelcome(ip.id, { mac: "11:22:33:44:55:66" });

  const list = deviceStore.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.pendingName, "My Lamp", "queued rename survives the merge");
});

test("records with different MACs are never merged", () => {
  const a = deviceStore.upsert("wss://192.168.68.54");
  deviceStore.applyWelcome(a.id, { mac: "AA:AA:AA:AA:AA:AA" });
  const b = deviceStore.upsert("wss://192.168.68.99");
  deviceStore.applyWelcome(b.id, { mac: "BB:BB:BB:BB:BB:BB" });
  assert.equal(deviceStore.list().length, 2);
});

test("records without a MAC yet are not merged (identity unknown)", () => {
  deviceStore.upsert("wss://ledmapper.local/ws");
  const ip = deviceStore.upsert("wss://192.168.68.54");
  deviceStore.applyWelcome(ip.id, { mac: "" }); // no identity learned
  assert.equal(deviceStore.list().length, 2);
});

test("a BLE device.id churn is reconciled by the welcome MAC (no lasting duplicate)", () => {
  // The real reconnect scenario: connectOverBle keys on device.id (bleDeviceUrl).
  // On platforms where device.id changes across sessions, a re-scan makes a second
  // ble: record — but the SAME physical device reports the same welcome MAC, so the
  // authoritative MAC-merge collapses the two into one. Distinct MACs never merge,
  // and a rename can't split them (the MAC, not the name, is the identity).
  const first = deviceStore.upsert("ble:session-A"); // first scan
  deviceStore.applyWelcome(first.id, { mac: "58:E6:C5:11:FC:DA", deviceName: "Kitchen" });
  const second = deviceStore.upsert("ble:session-B"); // reconnect, device.id churned
  deviceStore.applyWelcome(second.id, { mac: "58:E6:C5:11:FC:DA", deviceName: "Kitchen" });
  assert.equal(deviceStore.list().length, 1); // collapsed onto the fresh record
});

test("two BLE devices sharing a display name stay distinct (keyed on identity, not name)", () => {
  const a = deviceStore.upsert("ble:dev-1", "Kitchen");
  deviceStore.applyWelcome(a.id, { mac: "AA:AA:AA:AA:AA:AA", deviceName: "Kitchen" });
  const b = deviceStore.upsert("ble:dev-2", "Kitchen");
  deviceStore.applyWelcome(b.id, { mac: "BB:BB:BB:BB:BB:BB", deviceName: "Kitchen" });
  assert.equal(deviceStore.list().length, 2); // same name, different MAC -> two entries
  // …and the drawer can tell them apart by the stable MAC suffix (not the name).
  assert.equal(deviceDisambiguator({ bleMac: "58:E6:C5:11:FC:DA" }), "11FCDA");
  assert.notEqual(
    deviceDisambiguator({ bleMac: "AA:AA:AA:AA:AA:AA" }),
    deviceDisambiguator({ bleMac: "BB:BB:BB:BB:BB:BB" }),
  );
  assert.equal(deviceDisambiguator({ bleMac: "" }), ""); // unknown until connected
});

test("per-device capture stride persists, clamps, and clears back to the default", () => {
  const d = deviceStore.upsert("wss://192.168.4.7");
  // Unset -> undefined (callers fall back to DEFAULT_CAPTURE_STRIDE).
  assert.equal(deviceStore.getCaptureStride(d.id), undefined);

  deviceStore.setCaptureStride(d.id, 6);
  assert.equal(deviceStore.getCaptureStride(d.id), 6);

  // Survives a fresh read of the record (normalize() must carry the field).
  assert.equal(deviceStore.get(d.id)?.captureStride, 6);

  // Out-of-range values are clamped on write.
  deviceStore.setCaptureStride(d.id, 999);
  assert.equal(deviceStore.getCaptureStride(d.id), MAX_CAPTURE_STRIDE);
  deviceStore.setCaptureStride(d.id, 0);
  assert.equal(deviceStore.getCaptureStride(d.id), MIN_CAPTURE_STRIDE);

  // Clearing removes it (back to the capture default).
  deviceStore.setCaptureStride(d.id, undefined);
  assert.equal(deviceStore.getCaptureStride(d.id), undefined);
});

test("clampCaptureStride rounds, bounds, and rejects non-numbers", () => {
  assert.equal(clampCaptureStride(4), 4);
  assert.equal(clampCaptureStride(4.6), 5);
  assert.equal(clampCaptureStride(-3), MIN_CAPTURE_STRIDE);
  assert.equal(clampCaptureStride(1000), MAX_CAPTURE_STRIDE);
  assert.equal(clampCaptureStride("7"), 7);
  assert.equal(clampCaptureStride("nope"), undefined);
  assert.equal(clampCaptureStride(NaN), undefined);
  assert.ok(DEFAULT_CAPTURE_STRIDE >= MIN_CAPTURE_STRIDE && DEFAULT_CAPTURE_STRIDE <= MAX_CAPTURE_STRIDE);
});

// A DHCP lease moved between fixtures: CalvinLamp was at .71, moved to .75, and
// PixieLamp2 got .71. Improv handed the app wss://192.168.68.71/ws; the URL-keyed
// record there was CalvinLamp's, so the app showed CalvinLamp while connecting and
// PixieLamp2's welcome then overwrote CalvinLamp's record.
const CALVIN = "98:88:E0:71:55:92";
const PIXIE = "98:A3:16:81:98:7A";
const AT71 = "wss://192.168.68.71/ws";

function calvinAt71() {
  const d = deviceStore.upsert(AT71);
  deviceStore.applyWelcome(d.id, { mac: CALVIN, deviceName: "CalvinLamp" });
  deviceStore.setFolder(d.id, "Bench");
  deviceStore.markWssOk(AT71);
  mem.setItem(`brightness:${d.id}`, "0.4");
  mem.setItem("ledmapper.deviceEffects", JSON.stringify({ [d.id]: ["fx-a"] }));
  return d;
}

test("another device's welcome at a saved address moves the old record aside", () => {
  const d = calvinAt71();
  deviceStore.applyWelcome(d.id, { mac: PIXIE, deviceName: "PixieLamp2" });
  const here = deviceStore.get(d.id)!;
  assert.equal(here.label, "PixieLamp2");
  assert.equal(here.bleMac, PIXIE);
  assert.equal(here.folder, undefined, "CalvinLamp's folder stays with CalvinLamp");
  assert.equal(deviceStore.wssTrusted(AT71), false, "CalvinLamp's certificate was trusted, not PixieLamp2's");
  const calvin = deviceStore.list().find((x) => x.label === "CalvinLamp")!;
  assert.equal(calvin.bleMac, CALVIN);
  assert.equal(calvin.folder, "Bench");
  assert.equal(mem.getItem(`brightness:${calvin.id}`), "0.4");
  assert.equal(mem.getItem(`brightness:${d.id}`), null);
  assert.deepEqual(JSON.parse(mem.getItem("ledmapper.deviceEffects")!), { [calvin.id]: ["fx-a"] });
  // CalvinLamp answers at its new address: its moved record folds into that one.
  const at75 = deviceStore.upsert("wss://192.168.68.75/ws");
  deviceStore.applyWelcome(at75.id, { mac: CALVIN, deviceName: "CalvinLamp" });
  const calvins = deviceStore.list().filter((x) => sameHex(x.bleMac, CALVIN));
  assert.equal(calvins.length, 1);
  assert.equal(calvins[0]!.id, at75.id);
  assert.equal(calvins[0]!.folder, "Bench");
  assert.equal(mem.getItem(`brightness:${at75.id}`), "0.4", "its settings follow it");
});

test("Improv's expected identity moves a stale record aside before connecting", () => {
  const d = calvinAt71();
  deviceStore.setBleId(AT71, "calvin-ble");
  const dev = deviceStore.upsert(AT71, "PixieLamp2", { name: "PixieLamp2", bleId: "pixie-ble" });
  assert.equal(dev.id, d.id);
  assert.equal(dev.label, "PixieLamp2", "shown as PixieLamp2 while it connects");
  assert.equal(dev.folder, undefined);
  const calvin = deviceStore.list().find((x) => x.label === "CalvinLamp")!;
  assert.equal(calvin.bleId, "calvin-ble");
  assert.equal(calvin.folder, "Bench");
  // The same fixture re-provisioned at its own address keeps its record.
  const again = deviceStore.upsert(AT71, "PixieLamp2", { name: "PixieLamp2" });
  assert.equal(again.id, d.id);
  assert.equal(deviceStore.list().length, 2);
});

function sameHex(a: string, b: string): boolean {
  return a.replace(/[^0-9a-f]/gi, "").toUpperCase() === b.replace(/[^0-9a-f]/gi, "").toUpperCase();
}
