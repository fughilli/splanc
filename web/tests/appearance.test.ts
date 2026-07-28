/**
 * Appearance store (src/store/appearance.ts) — the pure, DOM-free contract:
 * defaults reproduce today's look, settings normalize/clamp, and the resolved
 * CSS-var + render-setting maps match what MapView and :root consume. The live
 * store's update/get/renderSettings path is exercised too (it only touches
 * `document`/`localStorage` behind typeof guards, so it runs fine under Node).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULTS,
  ACCENT_HEX,
  DEFAULT_VIEW_BG,
  normalizeSettings,
  resolveAccent,
  resolveThemeVars,
  resolveRenderSettings,
  updateAppearance,
  getAppearance,
  resetAppearance,
  renderSettings,
} from "../src/store/appearance";

test("defaults reproduce today's dark indigo look", () => {
  assert.equal(DEFAULTS.mode, "dark");
  assert.equal(resolveAccent(DEFAULTS), "#5b7cfa");
  const vars = resolveThemeVars(DEFAULTS);
  assert.equal(vars["--bg"], "#0e0e12");
  assert.equal(vars["--accent"], "#5b7cfa");
  assert.equal(vars["--font-ui"], "system-ui, sans-serif");
  assert.equal(vars["color-scheme"], "dark");
});

test("default render settings match MapView's original constants", () => {
  const r = resolveRenderSettings(DEFAULTS);
  assert.deepEqual(r, {
    ledSize: 1,
    viewBg: DEFAULT_VIEW_BG,
    glow: 1,
    showGrid: false,
    showTriad: false,
  });
});

test("normalize clamps out-of-range numbers and rejects junk", () => {
  const s = normalizeSettings({
    mode: "sideways",
    accentPreset: "custom",
    accent: "not-a-hex",
    uiScale: 99,
    ledSize: -3,
    glow: 5,
    viewBg: "#ff0000",
    showGrid: true,
    font: "bogus",
  });
  assert.equal(s.mode, "dark"); // invalid → default
  assert.equal(s.accentPreset, "custom");
  assert.equal(s.accent, DEFAULTS.accent); // bad hex → default
  assert.equal(s.uiScale, 1.4); // clamped to max
  assert.equal(s.ledSize, 0.5); // clamped to min
  assert.equal(s.glow, 2); // clamped to max
  assert.equal(s.viewBg, "#ff0000"); // valid hex kept
  assert.equal(s.showGrid, true);
  assert.equal(s.font, "system"); // invalid → default
});

test("light mode flips the base palette but keeps the accent", () => {
  const s = normalizeSettings({ mode: "light", accentPreset: "teal" });
  const vars = resolveThemeVars(s);
  assert.equal(vars["color-scheme"], "light");
  assert.notEqual(vars["--bg"], "#0e0e12");
  assert.equal(vars["--accent"], ACCENT_HEX.teal);
});

test("custom accent overrides the preset hex", () => {
  const s = normalizeSettings({ accentPreset: "custom", accent: "#00ff88" });
  assert.equal(resolveAccent(s), "#00ff88");
  assert.equal(resolveThemeVars(s)["--accent"], "#00ff88");
});

test("empty viewBg resolves to MapView's default, a set one passes through", () => {
  assert.equal(resolveRenderSettings(normalizeSettings({ viewBg: "" })).viewBg, DEFAULT_VIEW_BG);
  assert.equal(resolveRenderSettings(normalizeSettings({ viewBg: "#223344" })).viewBg, "#223344");
});

test("updateAppearance persists a partial patch and live renderSettings tracks it", () => {
  resetAppearance();
  updateAppearance({ ledSize: 2, showTriad: true, mode: "light" });
  const s = getAppearance();
  assert.equal(s.ledSize, 2);
  assert.equal(s.showTriad, true);
  assert.equal(s.mode, "light");
  // The live render snapshot MapView reads reflects the update immediately.
  assert.equal(renderSettings().ledSize, 2);
  assert.equal(renderSettings().showTriad, true);
  // Untouched fields stay at their defaults.
  assert.equal(s.glow, DEFAULTS.glow);
  resetAppearance();
  assert.equal(renderSettings().ledSize, 1);
});
