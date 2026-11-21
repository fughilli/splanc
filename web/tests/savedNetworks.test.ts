/**
 * Saved Wi-Fi networks (D-72): whatever the user enters and presses Connect with
 * is saved, upserted by SSID; the join's outcome is recorded on it; the list is
 * the user's to edit, reorder (make default) and delete. Runs the pure list
 * operations and the localStorage-backed store under a storage shim.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

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
  MAX_SAVED_NETWORKS,
  editNetwork,
  makeDefaultNetwork,
  moveNetwork,
  parseStoredNetworks,
  removeNetwork,
  savedNetworks,
  upsertNetwork,
  type SavedNetwork,
} from "../src/store/savedNetworks";
import { prefs } from "../src/store/prefs";

beforeEach(() => mem.clear());

const ssids = (l: SavedNetwork[]): string[] => l.map((n) => n.ssid);

test("upsert: a new SSID goes first (the new default), unverified", () => {
  let l = upsertNetwork([], { ssid: "Home", password: "a" });
  l = upsertNetwork(l, { ssid: "Cafe", password: "b" });
  assert.deepEqual(ssids(l), ["Cafe", "Home"]);
  assert.equal(l[0]!.state, "unverified");
});

test("upsert: an existing SSID keeps its place and takes the new password", () => {
  let l = upsertNetwork([], { ssid: "Home", password: "a" });
  l = upsertNetwork(l, { ssid: "Cafe", password: "b" });
  l = makeDefaultNetwork(l, "Home");
  l = upsertNetwork(l, { ssid: "Cafe", password: "b2" });
  assert.deepEqual(ssids(l), ["Home", "Cafe"], "the chosen default is not displaced");
  assert.equal(l[1]!.password, "b2");
  assert.equal(l.length, 2, "no duplicate");
});

test("upsert: a changed password clears the old verdict; the same one keeps it", () => {
  let l = upsertNetwork([], { ssid: "Home", password: "a" }, { state: "rejected" });
  assert.equal(upsertNetwork(l, { ssid: "Home", password: "a" })[0]!.state, "rejected");
  l = upsertNetwork(l, { ssid: "Home", password: "fixed" });
  assert.equal(l[0]!.state, "unverified");
  assert.equal(upsertNetwork(l, { ssid: "Home", password: "fixed" }, { state: "joined" })[0]!.state, "joined");
});

test("upsert: blank SSIDs are ignored and whitespace trimmed; the list is bounded", () => {
  assert.deepEqual(upsertNetwork([], { ssid: "  ", password: "x" }), []);
  assert.equal(upsertNetwork([], { ssid: " Home ", password: "x" })[0]!.ssid, "Home");
  let l: SavedNetwork[] = [];
  for (let i = 0; i < MAX_SAVED_NETWORKS + 5; i++) l = upsertNetwork(l, { ssid: `n${i}`, password: "" });
  assert.equal(l.length, MAX_SAVED_NETWORKS);
  assert.equal(l[0]!.ssid, `n${MAX_SAVED_NETWORKS + 4}`, "newest kept");
});

test("edit renames in place; renaming onto another saved SSID merges", () => {
  let l = upsertNetwork(upsertNetwork(upsertNetwork([], { ssid: "A", password: "1" }), { ssid: "B", password: "2" }), {
    ssid: "C",
    password: "3",
  });
  assert.deepEqual(ssids(l), ["C", "B", "A"]);
  l = editNetwork(l, "B", { ssid: "B5", password: "22" });
  assert.deepEqual(ssids(l), ["C", "B5", "A"]);
  assert.equal(l[1]!.password, "22");
  l = editNetwork(l, "A", { ssid: "C", password: "33" });
  assert.deepEqual(ssids(l), ["C", "B5"], "merged into C");
  assert.equal(l[0]!.password, "33");
});

test("remove, make default and move", () => {
  const l = ["A", "B", "C"].reduceRight<SavedNetwork[]>((acc, s) => upsertNetwork(acc, { ssid: s, password: "" }), []);
  assert.deepEqual(ssids(l), ["A", "B", "C"]);
  assert.deepEqual(ssids(removeNetwork(l, "B")), ["A", "C"]);
  assert.deepEqual(ssids(makeDefaultNetwork(l, "C")), ["C", "A", "B"]);
  assert.deepEqual(ssids(moveNetwork(l, "A", 1)), ["B", "A", "C"]);
  assert.deepEqual(ssids(moveNetwork(l, "A", -3)), ["A", "B", "C"], "clamped");
  assert.deepEqual(ssids(moveNetwork(l, "C", 9)), ["A", "B", "C"]);
});

test("stored lists parse leniently: the legacy shapes carry over", () => {
  assert.deepEqual(parseStoredNetworks([{ ssid: "Old", password: "p" }]), [{ ssid: "Old", password: "p" }]);
  assert.deepEqual(parseStoredNetworks(null, { ssid: "Single", password: "q" }), [{ ssid: "Single", password: "q" }]);
  assert.deepEqual(
    parseStoredNetworks([{ ssid: "A", password: "1", state: "bogus" }, { ssid: "" }, null, { ssid: "A", password: "dup" }]),
    [{ ssid: "A", password: "1" }],
  );
  assert.deepEqual(parseStoredNetworks("junk"), []);
});

test("store: Connect saves at once; results are recorded; prefs sees plain credentials", () => {
  savedNetworks.saveOnConnect({ ssid: "Home", password: "typo" });
  assert.equal(savedNetworks.get("Home")?.state, "unverified");
  assert.ok(savedNetworks.get("Home")?.lastUsed, "stamped");
  savedNetworks.markResult({ ssid: "Home", password: "typo" }, "rejected");
  assert.equal(savedNetworks.get("Home")?.state, "rejected");
  savedNetworks.saveOnConnect({ ssid: "Home", password: "right" });
  prefs.addWifi({ ssid: "Home", password: "right" }); // what a successful join does
  assert.equal(savedNetworks.get("Home")?.state, "joined");
  assert.deepEqual(prefs.getWifiList(), [{ ssid: "Home", password: "right" }]);
  assert.deepEqual(prefs.getWifi(), { ssid: "Home", password: "right" }, "single-entry cache follows the default");
});

test("store: subscribers hear every change; delete empties the default", () => {
  let n = 0;
  const off = savedNetworks.subscribe(() => n++);
  savedNetworks.add({ ssid: "A", password: "" });
  savedNetworks.add({ ssid: "B", password: "" });
  savedNetworks.makeDefault("A");
  savedNetworks.remove("A");
  savedNetworks.remove("B");
  off();
  savedNetworks.add({ ssid: "C", password: "" });
  assert.equal(n, 5);
  assert.deepEqual(ssids(savedNetworks.list()), ["C"]);
});
