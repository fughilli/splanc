/**
 * MapView grid/triad seeding (src/ui/mapview.ts): the Appearance grid/triad
 * settings are *defaults* that seed a new view's per-view toggles, not an
 * override. Regression guard for FUG-8 — a default of "on" must still leave the
 * per-view flag free to turn off, and flipping the default must not reach into
 * views that already exist.
 *
 * The constructor only reads renderSettings() and sets fields (no DOM until
 * start()), so a bare object stands in for the canvas/map under node:test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutputMap } from "@ledmapper/protocol";
import { MapView } from "../src/ui/mapview";
import { updateAppearance, resetAppearance } from "../src/store/appearance";

const fakeCanvas = {} as unknown as HTMLCanvasElement;
const fakeMap = { leds: [] } as unknown as OutputMap;

test("new MapView seeds grid/triad from the Appearance defaults", () => {
  resetAppearance();
  updateAppearance({ showGrid: true, showTriad: true });
  const view = new MapView(fakeCanvas, fakeMap);
  assert.equal(view.showGrid, true);
  assert.equal(view.showTriad, true);
  resetAppearance();
});

test("the default only seeds — a per-view toggle can still turn it off", () => {
  resetAppearance();
  updateAppearance({ showGrid: true, showTriad: true });
  const view = new MapView(fakeCanvas, fakeMap);
  // Per-view toggle wins: turning it off stays off despite the "on" default.
  view.showGrid = false;
  assert.equal(view.showGrid, false);
  assert.equal(view.showTriad, true);
  resetAppearance();
});

test("flipping the default does not reach into already-constructed views", () => {
  resetAppearance();
  const view = new MapView(fakeCanvas, fakeMap); // seeded off (shipped default)
  assert.equal(view.showGrid, false);
  updateAppearance({ showGrid: true });
  // The existing view keeps its own state; only the *next* view seeds on.
  assert.equal(view.showGrid, false);
  const next = new MapView(fakeCanvas, fakeMap);
  assert.equal(next.showGrid, true);
  resetAppearance();
});
