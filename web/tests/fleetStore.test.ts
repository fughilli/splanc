/**
 * AI estimation-fleet store tests (FUG-11): toggle membership, per-device LED
 * counts, and self-healing of a stale/invalid selection, under a localStorage
 * shim (the module reads localStorage lazily inside methods).
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

import { fleetStore } from "../src/store/fleetStore";

beforeEach(() => {
  mem.clear();
});

test("empty by default", () => {
  assert.deepEqual(fleetStore.get(), []);
  assert.equal(fleetStore.has("x"), false);
});

test("toggle adds then removes a member", () => {
  fleetStore.toggle("esp32c6@160#1", 128);
  assert.equal(fleetStore.has("esp32c6@160#1"), true);
  assert.deepEqual(fleetStore.get(), [{ tableId: "esp32c6@160#1", ledCount: 128 }]);
  fleetStore.toggle("esp32c6@160#1", 128);
  assert.equal(fleetStore.has("esp32c6@160#1"), false);
});

test("setLedCount updates only an existing member and rounds/floors to >=1", () => {
  fleetStore.toggle("a", 100);
  fleetStore.setLedCount("a", 250.6);
  assert.equal(fleetStore.get()[0]!.ledCount, 251);
  fleetStore.setLedCount("a", 0);
  assert.equal(fleetStore.get()[0]!.ledCount, 1);
  // no-op for a non-member.
  fleetStore.setLedCount("missing", 999);
  assert.equal(fleetStore.get().length, 1);
});

test("remove drops a member (e.g. when its profile is deleted)", () => {
  fleetStore.toggle("a", 64);
  fleetStore.toggle("b", 64);
  fleetStore.remove("a");
  assert.deepEqual(
    fleetStore.get().map((e) => e.tableId),
    ["b"],
  );
});

test("ignores malformed persisted entries", () => {
  mem.setItem("ledmapper.perfFleet", JSON.stringify([{ tableId: "ok", ledCount: 10 }, { junk: 1 }, 5]));
  assert.deepEqual(fleetStore.get(), [{ tableId: "ok", ledCount: 10 }]);
});

test("notifies subscribers on change", () => {
  let hits = 0;
  const off = fleetStore.subscribe(() => {
    hits++;
  });
  fleetStore.toggle("a", 32);
  fleetStore.setLedCount("a", 48);
  off();
  fleetStore.toggle("a", 32);
  assert.equal(hits, 2);
});
