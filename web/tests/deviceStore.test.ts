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

import { deviceStore, deviceDisambiguator } from "../src/store/deviceStore";

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
