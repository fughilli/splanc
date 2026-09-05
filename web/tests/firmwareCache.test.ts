/** Firmware offline cache — pure eviction / id policy (src/flash/firmwareCache.ts). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { selectEvictions, tagOfId, UNPINNED_CAP } from "../src/flash/firmwareCache";

const rec = (id: string, pinned: boolean, cachedAt: number) => ({ id, pinned, cachedAt });

test("tagOfId extracts the release tag from an entry id", () => {
  assert.equal(tagOfId("firmware-v1.2.0::netstack"), "firmware-v1.2.0");
  assert.equal(tagOfId("firmware-v1.0.0::vendor"), "firmware-v1.0.0");
  assert.equal(tagOfId("noseparator"), "noseparator");
});

test("selectEvictions keeps everything within the unpinned cap", () => {
  const recs = [rec("a", false, 3), rec("b", false, 2), rec("c", false, 1)];
  assert.deepEqual(selectEvictions(recs, 3), []);
  assert.deepEqual(selectEvictions(recs, 5), []);
});

test("selectEvictions LRU-evicts the oldest unpinned beyond the cap", () => {
  const recs = [rec("new", false, 30), rec("mid", false, 20), rec("old", false, 10)];
  assert.deepEqual(selectEvictions(recs, 1), ["mid", "old"]);
  assert.deepEqual(selectEvictions(recs, 2), ["old"]);
});

test("selectEvictions never evicts pinned bundles (only unpinned count toward the cap)", () => {
  const recs = [
    rec("pin1", true, 1),
    rec("pin2", true, 2),
    rec("u-new", false, 5),
    rec("u-mid", false, 4),
    rec("u-old", false, 3),
  ];
  // cap 1 among the unpinned → keep the newest unpinned (u-new), evict u-mid/u-old;
  // both pinned bundles are untouched regardless of age.
  assert.deepEqual(selectEvictions(recs, 1), ["u-mid", "u-old"]);
});

test("UNPINNED_CAP is the default cap", () => {
  const many = Array.from({ length: UNPINNED_CAP + 2 }, (_, i) => rec(`u${i}`, false, i));
  assert.equal(selectEvictions(many).length, 2); // the 2 oldest unpinned beyond the cap
});
