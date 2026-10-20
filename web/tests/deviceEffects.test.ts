/**
 * Per-device "on device" effect tracking (src/store/deviceEffects.ts) under a
 * localStorage shim: mark/has/list ordering, unmark, forgetEverywhere, clear.
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

// The store reads localStorage lazily inside each call, so the hoisted import
// resolving before this shim assignment is fine (mirrors midiStore.test.ts).
import { deviceEffects } from "../src/store/deviceEffects";

const DEV_A = "dev-a";
const DEV_B = "dev-b";

beforeEach(() => {
  mem.clear();
});

test("markSent records per device and dedups, most-recent first", () => {
  deviceEffects.markSent(DEV_A, "e1");
  deviceEffects.markSent(DEV_A, "e2");
  deviceEffects.markSent(DEV_A, "e1"); // re-cue moves it to the front
  assert.deepEqual(deviceEffects.list(DEV_A), ["e1", "e2"]);
  assert.ok(deviceEffects.has(DEV_A, "e1"));
  assert.ok(!deviceEffects.has(DEV_B, "e1"));
});

test("markSent ignores empty ids / devices", () => {
  deviceEffects.markSent(null, "e1");
  deviceEffects.markSent(DEV_A, "");
  assert.deepEqual(deviceEffects.list(DEV_A), []);
});

test("unmark removes just that effect on that device", () => {
  deviceEffects.markSent(DEV_A, "e1");
  deviceEffects.markSent(DEV_A, "e2");
  deviceEffects.unmark(DEV_A, "e1");
  assert.deepEqual(deviceEffects.list(DEV_A), ["e2"]);
});

test("forgetEverywhere drops an effect across all devices", () => {
  deviceEffects.markSent(DEV_A, "e1");
  deviceEffects.markSent(DEV_B, "e1");
  deviceEffects.markSent(DEV_B, "e2");
  deviceEffects.forgetEverywhere("e1");
  assert.deepEqual(deviceEffects.list(DEV_A), []);
  assert.deepEqual(deviceEffects.list(DEV_B), ["e2"]);
});

test("clear forgets everything on one device only", () => {
  deviceEffects.markSent(DEV_A, "e1");
  deviceEffects.markSent(DEV_B, "e2");
  deviceEffects.clear(DEV_A);
  assert.deepEqual(deviceEffects.list(DEV_A), []);
  assert.deepEqual(deviceEffects.list(DEV_B), ["e2"]);
});
