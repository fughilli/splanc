/**
 * Behavior-settings persistence (diffuse_capture): the diffuse-mode toggle and
 * the app-global capture-engine params live in localStorage via `prefs`. These
 * feed capture.ts (with the URL params overriding) so re-mapping a diffused
 * fixture never requires re-typing. Runs under a localStorage shim — prefs reads
 * localStorage lazily inside each method.
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

import { prefs, DEFAULT_DIFFUSE_CAPTURE_PARAMS } from "../src/store/prefs";

beforeEach(() => {
  mem.clear();
});

test("diffuse toggle defaults off and round-trips", () => {
  assert.equal(prefs.getDiffuseEnabled(), false);
  prefs.setDiffuseEnabled(true);
  assert.equal(prefs.getDiffuseEnabled(), true);
  prefs.setDiffuseEnabled(false);
  assert.equal(prefs.getDiffuseEnabled(), false);
});

test("diffuse params default to the safe reproduce-today values", () => {
  assert.deepEqual(prefs.getDiffuseParams(), DEFAULT_DIFFUSE_CAPTURE_PARAMS);
});

test("setDiffuseParams merges a partial update and persists the rest", () => {
  prefs.setDiffuseParams({ anchorDensity: 5 });
  prefs.setDiffuseParams({ lcGain: 2.0 });
  const p = prefs.getDiffuseParams();
  assert.equal(p.anchorDensity, 5);
  assert.equal(p.lcGain, 2.0);
  // Untouched fields keep their defaults.
  assert.equal(p.threshold, DEFAULT_DIFFUSE_CAPTURE_PARAMS.threshold);
  assert.equal(p.downscale, DEFAULT_DIFFUSE_CAPTURE_PARAMS.downscale);
  assert.equal(p.flipV, DEFAULT_DIFFUSE_CAPTURE_PARAMS.flipV);
});

test("diffuse params are clamped on read", () => {
  prefs.setDiffuseParams({ anchorDensity: 999, downscale: 0, threshold: 5, lcGain: -1 });
  const p = prefs.getDiffuseParams();
  assert.ok(p.anchorDensity <= 32 && p.anchorDensity >= 3);
  assert.ok(p.downscale >= 1 && p.downscale <= 8);
  assert.ok(p.threshold > 0 && p.threshold <= 1);
  assert.ok(p.lcGain >= 0 && p.lcGain <= 4);
});

test("a garbled stored blob falls back to defaults, not a throw", () => {
  mem.setItem("ledmapper.diffuseParams", "{not json");
  assert.deepEqual(prefs.getDiffuseParams(), DEFAULT_DIFFUSE_CAPTURE_PARAMS);
});

test("flipV persists as a boolean", () => {
  prefs.setDiffuseParams({ flipV: true });
  assert.equal(prefs.getDiffuseParams().flipV, true);
  prefs.setDiffuseParams({ flipV: false });
  assert.equal(prefs.getDiffuseParams().flipV, false);
});

test("resetDiffuseParams clears back to defaults", () => {
  prefs.setDiffuseParams({ anchorDensity: 9, flipV: true });
  prefs.resetDiffuseParams();
  assert.deepEqual(prefs.getDiffuseParams(), DEFAULT_DIFFUSE_CAPTURE_PARAMS);
});
