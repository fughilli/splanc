/** Solver placement decision (src/solver/placement.ts). */

import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseSolvePlacement, PHONE_SLOWDOWN_LIMIT } from "../src/solver/placement";

test("no wasm solver -> host (the classic flow)", () => {
  assert.equal(chooseSolvePlacement(null, 200), "host");
  assert.equal(chooseSolvePlacement(null, null), "host");
});

test("no host score yet -> phone-first", () => {
  assert.equal(chooseSolvePlacement(800, null), "phone");
});

test("phone keeps the solve within the slowdown margin", () => {
  assert.equal(chooseSolvePlacement(100, 200), "phone"); // faster outright
  assert.equal(chooseSolvePlacement(200 * PHONE_SLOWDOWN_LIMIT, 200), "phone"); // at the limit
});

test("a decisively slower phone offloads to the host", () => {
  assert.equal(chooseSolvePlacement(200 * PHONE_SLOWDOWN_LIMIT + 1, 200), "host");
  assert.equal(chooseSolvePlacement(10_000, 150), "host"); // very slow phone, fast host
});
