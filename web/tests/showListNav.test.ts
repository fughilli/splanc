/**
 * Show Mode effects-list navigation (src/midi/listNav.ts): highlight stepping
 * (clamped for encoders, wrapping for prev/next), the listbox key map, and the
 * nested scroll container's keep-in-view math.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { listKeyAction, scrollTopToReveal, stepIndex } from "../src/midi/listNav";

test("stepIndex clamps at the ends unless wrapping", () => {
  assert.equal(stepIndex(0, 1, 5), 1);
  assert.equal(stepIndex(3, 10, 5), 4, "a hard encoder spin stops on the last item");
  assert.equal(stepIndex(1, -10, 5), 0);
  assert.equal(stepIndex(4, 1, 5, true), 0);
  assert.equal(stepIndex(0, -1, 5, true), 4);
  assert.equal(stepIndex(2, 13, 5, true), 0);
  assert.equal(stepIndex(0, 3, 0), 0, "empty list");
  assert.equal(stepIndex(9, 0, 5), 4, "a stale index is clamped first");
});

test("listKeyAction: arrows, pages, ends, load keys", () => {
  assert.deepEqual(listKeyAction("ArrowDown", 20, 6), { kind: "move", steps: 1 });
  assert.deepEqual(listKeyAction("ArrowUp", 20, 6), { kind: "move", steps: -1 });
  assert.deepEqual(listKeyAction("PageDown", 20, 6.7), { kind: "move", steps: 6 });
  assert.deepEqual(listKeyAction("PageUp", 20, 0.2), { kind: "move", steps: -1 });
  assert.deepEqual(listKeyAction("Home", 20, 6), { kind: "jump", index: 0 });
  assert.deepEqual(listKeyAction("End", 20, 6), { kind: "jump", index: 19 });
  assert.deepEqual(listKeyAction("Enter", 20, 6), { kind: "load", deck: "browse" });
  assert.deepEqual(listKeyAction("a", 20, 6), { kind: "load", deck: 0 });
  assert.deepEqual(listKeyAction("B", 20, 6), { kind: "load", deck: 1 });
  assert.equal(listKeyAction("Tab", 20, 6), null, "Tab keeps moving focus out");
});

test("scrollTopToReveal scrolls the list minimally, or not at all", () => {
  const view = { scrollTop: 100, height: 200 }; // shows 100..300
  assert.equal(scrollTopToReveal(view, { top: 150, height: 40 }), null, "already visible");
  assert.equal(scrollTopToReveal(view, { top: 60, height: 40 }), 60, "above → align top");
  assert.equal(scrollTopToReveal(view, { top: 290, height: 40 }), 130, "below → align bottom");
  assert.equal(scrollTopToReveal(view, { top: 290, height: 40 }, 20), 150, "margin keeps a neighbour visible");
  assert.equal(scrollTopToReveal(view, { top: 5, height: 40 }, 20), 0, "never negative");
});
