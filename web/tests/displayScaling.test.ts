/**
 * Display scaling (PR-1): the app's scale settings apply consistently across
 * views and controls rather than to one screen at a time.
 *
 *  - UI scale: one knob, applied as the root font-size (src/store/appearance.ts
 *    applyAppearance), which every rem-sized control and screen inherits — set
 *    live from Settings ▸ Appearance and re-applied at startup.
 *  - Screen stylesheets (the injected *.css.ts modules) size their text with the
 *    rem-based type tokens, so each view follows that root scale.
 *  - LED point size: MapView reads renderSettings() every frame, so one change
 *    rescales the LEDs in every open 3D view, in both render modes.
 *  - Display pixel ratio: canvas views size their backing store to CSS size ×
 *    devicePixelRatio and draw in CSS px, so the picture is crisp and the same
 *    geometry at any display scale.
 *
 * Runs against the fake DOM (tests/fakeDom.ts); MapView draws into a recording
 * 2D context (tests/canvasRecorder.ts) so the assertions are on what was drawn.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutputMap } from "@ledmapper/protocol";
import { recordCanvas, type CanvasRecorder } from "./canvasRecorder";
import { asFake, installFakeDom, typeInto, type FakeElement } from "./fakeDom";
import { getAppearance, initAppearance, resetAppearance, updateAppearance } from "../src/store/appearance";
import { generateFixture } from "../src/effects/fixtures";
import { MapView } from "../src/ui/mapview";
import type { Router } from "../src/ui/app/router";
import { SettingsScreen } from "../src/ui/screens/settings";
import { ColorCorrectionScreen } from "../src/ui/screens/colorCorrection";
import { installSettingsStyles } from "../src/ui/screens/settings.css";
import { installColorCorrectionStyles } from "../src/ui/screens/colorCorrection.css";
import { installAiSettingsStyles } from "../src/ui/screens/aiSettings.css";
import { installAboutStyles } from "../src/ui/screens/about.css";
import { installHardwareSetupStyles } from "../src/ui/screens/hardwareSetup.css";
import { installAcidStyles } from "../src/ui/screens/acidMode.css";
import { installMidiStyles } from "../src/ui/screens/midi";

const dom = installFakeDom();
const router = { navigate: () => undefined, path: () => "/settings", back: () => undefined } as unknown as Router;
const root = (): FakeElement => asFake(document.documentElement);

function ring(count: number): OutputMap {
  return generateFixture("ring", { count, seed: 1, jitterFrac: 0 });
}

interface Mounted {
  canvas: FakeElement;
  rec: CanvasRecorder;
  view: MapView;
}

/** A started MapView on a laid-out canvas whose 2D context records every call
 * (start() draws the first frame synchronously; each rAF flush draws one more). */
function mountView(map: OutputMap, w = 320, h = 240, colors?: Uint8Array): Mounted {
  const canvas = asFake(document.createElement("canvas"));
  canvas.rect = { x: 0, y: 0, width: w, height: h };
  const rec = recordCanvas(canvas);
  const view = new MapView(canvas as unknown as HTMLCanvasElement, map);
  if (colors) view.setLedColors(colors);
  view.start();
  return { canvas, rec, view };
}

const radiusOf = (c: { args: unknown[] }): number => c.args[2] as number;
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/** The distinct values in `xs` (within float tolerance), ascending. */
function distinct(xs: number[]): number[] {
  const out: number[] = [];
  for (const x of [...xs].sort((a, b) => a - b)) if (!out.some((y) => near(x, y))) out.push(x);
  return out;
}

function sliderByLabel(screenEl: HTMLElement, label: string): { input: FakeElement; readout: FakeElement } {
  for (const wrap of asFake(screenEl).querySelectorAll(".k-slider")) {
    if (wrap.querySelector(".k-slider-head > span")?.textContent === label) {
      return { input: wrap.querySelector("input")!, readout: wrap.querySelector(".k-slider-val")! };
    }
  }
  throw new Error(`no slider labelled "${label}"`);
}

test("the UI scale is applied once, as the root font-size every rem-sized control and view inherits [rr:PR-1]", () => {
  resetAppearance();
  assert.equal(root().style.fontSize, "100.00%");
  for (const [scale, pct] of [
    [0.85, "85.00%"],
    [1.2, "120.00%"],
    [1.4, "140.00%"],
  ] as const) {
    updateAppearance({ uiScale: scale });
    assert.equal(root().style.fontSize, pct, `uiScale ${scale}`);
  }
  // Out-of-range values clamp to the supported range instead of breaking layouts.
  updateAppearance({ uiScale: 3 });
  assert.equal(root().style.fontSize, "140.00%");
  updateAppearance({ uiScale: 0.1 });
  assert.equal(root().style.fontSize, "85.00%");
  resetAppearance();
  assert.equal(root().style.fontSize, "100.00%");
});

test("a saved UI scale is re-applied to the root at startup, before any screen renders [rr:PR-1]", () => {
  localStorage.setItem("ledmapper.appearance", JSON.stringify({ uiScale: 1.15 }));
  root().style.fontSize = "";
  const s = initAppearance();
  assert.equal(s.uiScale, 1.15);
  assert.equal(root().style.fontSize, "115.00%");
  resetAppearance();
});

test("committing the Settings UI-scale slider rescales the whole app from the root [rr:PR-1]", () => {
  resetAppearance();
  const screen = SettingsScreen(router);
  const { input, readout } = sliderByLabel(screen.el, "UI scale");
  typeInto(input, "1.25", true); // drag to 125% and release
  assert.equal(readout.textContent, "125%");
  assert.equal(getAppearance().uiScale, 1.25);
  assert.equal(root().style.fontSize, "125.00%");
  resetAppearance();
  assert.equal(root().style.fontSize, "100.00%");
});

test("screen stylesheets size their text with the rem-based type tokens, never fixed px [rr:PR-1]", () => {
  // Each view's injected stylesheet. (perfPanel.css.ts is NOT listed: it still
  // uses fixed px font sizes — a known gap, reported against PR-1.)
  const sheets: [string, () => void, string][] = [
    ["settings", installSettingsStyles, ".settings-row"],
    ["colorCorrection", installColorCorrectionStyles, ".cc-row"],
    ["aiSettings", installAiSettingsStyles, ".aiset-"],
    ["about", installAboutStyles, ".about-"],
    ["hardwareSetup", installHardwareSetupStyles, ".hw-"],
    ["acidMode", installAcidStyles, ".acid"],
    ["midi", installMidiStyles, ".midi-"],
  ];
  for (const [, install] of sheets) install();
  const styles = asFake(document.head)
    .querySelectorAll("style")
    .map((s) => s.textContent);
  for (const [name, , marker] of sheets) {
    const css = styles.find((s) => s.includes(marker));
    assert.ok(css !== undefined, `${name}: stylesheet installed`);
    const decls = [...css.matchAll(/(?:^|[\s;{])(font(?:-size)?)\s*:\s*([^;}]+)/g)];
    assert.ok(decls.length > 0, `${name}: declares its text sizes`);
    for (const m of decls) {
      assert.doesNotMatch(m[2]!, /\d(?:\.\d+)?px\b/, `${name}: "${m[1]}: ${m[2]!.trim()}" won't follow the UI scale`);
    }
  }
});

test("the LED point-size setting rescales the LEDs in every open 3D view on its next frame [rr:PR-1]", () => {
  resetAppearance();
  const n = 8;
  // A confidence-shaded view (map detail / solve) and a lit effect view (editor
  // preview / settings preview): different render paths, one setting.
  const shaded = mountView(ring(n));
  const lit = mountView(ring(n), 320, 240, new Uint8Array(n * 3).fill(200));
  try {
    for (const size of [2, 0.5]) {
      shaded.rec.clear();
      lit.rec.clear();
      updateAppearance({ ledSize: size });
      dom.flushAnimationFrames(); // one frame in each open view, no per-view wiring
      // Confidence dots: (2.5 + 2·confidence) × size, confidence = 1.
      const dots = shaded.rec.of("arc").map(radiusOf);
      assert.equal(dots.length, n);
      assert.ok(dots.every((r) => near(r, 4.5 * size)), `dot radii ${dots} at size ${size}`);
      // Lit LEDs: core dot 2.2 × size and glow halo (6 + brightness/10) × size.
      const halos = lit.rec.of("createRadialGradient").map((c) => c.args[5] as number);
      assert.equal(halos.length, n);
      assert.ok(halos.every((r) => near(r, 26 * size)), `halo radii ${halos} at size ${size}`);
      const radii = distinct(lit.rec.of("arc").map(radiusOf));
      assert.equal(radii.length, 2);
      assert.ok(near(radii[0]!, 2.2 * size) && near(radii[1]!, 26 * size), `lit radii ${radii} at size ${size}`);
    }
  } finally {
    shaded.view.stop();
    lit.view.stop();
    resetAppearance();
  }
});

test("the 3D view renders at the display pixel ratio while keeping its geometry in CSS pixels [rr:PR-1]", () => {
  resetAppearance();
  const map = ring(12);
  const at = (dpr: number, w = 300, h = 200): Mounted => {
    dom.window.devicePixelRatio = dpr;
    return mountView(map, w, h);
  };
  const views: Mounted[] = [];
  try {
    const x1 = at(1);
    const x2 = at(2);
    views.push(x1, x2);
    assert.equal(x1.canvas.width, 300);
    assert.equal(x2.canvas.width, 600);
    assert.equal(x2.canvas.height, 400);
    assert.deepEqual(x2.rec.of("setTransform")[0]!.args, [2, 0, 0, 2, 0, 0]);
    // Same picture in CSS px at 1× and 2×: every LED dot lands in the same place
    // at the same size — only the backing store is denser.
    const dots = (m: Mounted): number[][] => m.rec.of("arc").map((c) => (c.args as number[]).slice(0, 3));
    assert.equal(dots(x2).length, 12);
    assert.deepEqual(dots(x2), dots(x1));
    // Very dense displays are capped (fill-rate) but still scaled.
    const x4 = at(4);
    views.push(x4);
    assert.equal(x4.canvas.width, 750);
    // When the view's box changes (pane resize, rotation) the backing store follows.
    dom.window.devicePixelRatio = 2;
    dom.resize(x2.canvas, 400, 250);
    assert.equal(x2.canvas.width, 800);
    assert.equal(x2.canvas.height, 500);
  } finally {
    for (const v of views) v.view.stop();
    dom.window.devicePixelRatio = 1;
  }
});

test("the color-correction curve plot and palette bars also render at the display pixel ratio [rr:PR-1]", () => {
  dom.window.devicePixelRatio = 2;
  try {
    const screen = ColorCorrectionScreen(router);
    const el = asFake(screen.el);
    const plot = el.querySelector("canvas.cc-plot")!;
    // Backing store = logical 320×220 plot × DPR; the CSS box keeps the aspect.
    assert.equal(plot.width, 640);
    assert.equal(plot.height, 440);
    assert.equal(plot.style.getPropertyValue("aspect-ratio"), "320 / 220");
    const bars = el.querySelectorAll("canvas.cc-sim-bar");
    assert.equal(bars.length, 5);
    for (const bar of bars) {
      assert.equal(bar.width, 512);
      assert.equal(bar.height, 52);
    }
    // A redraw (dragging an R-gamma step) scales the context so drawing stays in CSS px.
    const rec = recordCanvas(plot);
    typeInto(sliderByLabel(screen.el, "R gamma").input, "2.4");
    assert.deepEqual(rec.of("setTransform")[0]!.args, [2, 0, 0, 2, 0, 0]);
    screen.onUnmount?.();
  } finally {
    dom.window.devicePixelRatio = 1;
  }
});
