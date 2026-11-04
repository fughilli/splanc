/**
 * The effect editor's preview map (store/previewMap.ts): the connected (or last
 * connected) fixture's own map by default; a pick is remembered per fixture
 * across sessions until the fixture's own map is picked again.
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

import { deviceStore } from "../src/store/deviceStore";
import { DEVICE_MAP, initialPreviewMap, learnDeviceMap, pickMap, pickedMap } from "../src/store/previewMap";

const ALL = new Set(["__fixture__", "curtain", "rope", "tree"]);

beforeEach(() => mem.clear());

test("the fixture's own map by default, else the fallback", () => {
  assert.equal(initialPreviewMap("dev-a", ALL, "tree"), "tree");
  learnDeviceMap("dev-a", "curtain");
  assert.equal(initialPreviewMap("dev-a", ALL, "tree"), "curtain");
  // Another fixture has its own (unknown) map.
  assert.equal(initialPreviewMap("dev-b", ALL, "tree"), "tree");
});

test("a pick is remembered per fixture and wins over its map", () => {
  learnDeviceMap("dev-a", "curtain");
  pickMap("dev-a", "rope");
  assert.equal(initialPreviewMap("dev-a", ALL, null), "rope");
  learnDeviceMap("dev-b", "tree");
  assert.equal(initialPreviewMap("dev-b", ALL, null), "tree");
  // No fixture known: its own slot.
  pickMap(null, "__fixture__");
  assert.equal(initialPreviewMap(null, ALL, "tree"), "__fixture__");
  assert.equal(pickedMap("dev-a"), "rope");
});

test("picking the fixture's own map follows the fixture again", () => {
  learnDeviceMap("dev-a", "curtain");
  pickMap("dev-a", "rope");
  pickMap("dev-a", "curtain");
  assert.equal(pickedMap("dev-a"), null);
  pickMap("dev-a", "rope");
  pickMap("dev-a", DEVICE_MAP);
  assert.equal(pickedMap("dev-a"), null);
  // The fixture was re-mapped: the new map is followed.
  learnDeviceMap("dev-a", "tree");
  assert.equal(initialPreviewMap("dev-a", ALL, null), "tree");
});

test("a deleted map is skipped", () => {
  learnDeviceMap("dev-a", "curtain");
  pickMap("dev-a", "gone");
  assert.equal(initialPreviewMap("dev-a", ALL, null), "curtain");
  learnDeviceMap("dev-a", "gone-too");
  assert.equal(initialPreviewMap("dev-a", ALL, "tree"), "tree");
});

test("survives corrupt storage", () => {
  mem.setItem("fxedit.previewMap.v1", "{not json");
  assert.equal(initialPreviewMap("dev-a", ALL, "tree"), "tree");
  pickMap("dev-a", "rope");
  assert.equal(pickedMap("dev-a"), "rope");
});

test("the last connected fixture is kept after a disconnect", () => {
  const a = deviceStore.upsert("wss://10.0.0.5:8443", "Curtain");
  deviceStore.setActive(a.id);
  deviceStore.setActive(null);
  assert.equal(deviceStore.activeId(), null);
  assert.equal(deviceStore.lastId(), a.id);
  deviceStore.forget(a.id);
  assert.equal(deviceStore.lastId(), null);
});
