/**
 * previewCache (src/store/previewCache.ts) — the pure TTL + LRU policy that keeps
 * the effect-preview clip cache bounded. The IndexedDB wrapper is browser-only;
 * these are the invalidation rules it leans on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hashSource,
  isExpired,
  selectEvictions,
  PREVIEW_TTL_MS,
} from "../src/store/previewCache";

test("hashSource is deterministic and source-sensitive", () => {
  assert.equal(hashSource("abc"), hashSource("abc"));
  assert.notEqual(hashSource("abc"), hashSource("abd"));
  assert.notEqual(hashSource("abc"), hashSource("ab")); // length matters
});

test("isExpired is true only once the TTL has fully elapsed", () => {
  const now = 1_000_000_000;
  assert.equal(isExpired(now, now), false);
  assert.equal(isExpired(now - PREVIEW_TTL_MS + 1, now), false);
  assert.equal(isExpired(now - PREVIEW_TTL_MS, now), true);
});

test("selectEvictions drops expired clips", () => {
  const now = 10 * PREVIEW_TTL_MS;
  const recs = [
    { id: "fresh", createdAt: now - 1000 },
    { id: "stale", createdAt: now - PREVIEW_TTL_MS - 1 },
  ];
  assert.deepEqual(selectEvictions(recs, now, 100), ["stale"]);
});

test("selectEvictions evicts the oldest live clips beyond the cap", () => {
  const now = PREVIEW_TTL_MS; // nothing expired
  const recs = [
    { id: "a", createdAt: 5 },
    { id: "b", createdAt: 1 },
    { id: "c", createdAt: 3 },
  ];
  // Cap of 1 → keep newest ("a"@5), evict the two oldest ("b"@1, "c"@3).
  const evicted = selectEvictions(recs, now, 1).sort();
  assert.deepEqual(evicted, ["b", "c"]);
});
