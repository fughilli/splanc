/**
 * Per-view settings vs. defaults (PR-3): appearance defaults only SEED a view's
 * own state; once a view has a setting — toggled by the user or fixed by the
 * view's mode — later default changes never override it, and the user's
 * workspace arrangement survives reloads and view-mode switches.
 *
 *  - MapView (src/ui/mapview.ts): grid/triad are seeded from the Appearance
 *    defaults at construction and then owned per view — asserted on what each
 *    frame actually draws (the FUG-8 bug OR-ed the default in at draw time,
 *    which field-level checks alone would not catch).
 *  - Map Detail's overlay toggles reflect and own their view's state.
 *  - Thumbnails keep their decluttered framing whatever the defaults say.
 *  - FxLayout (src/effects/editor/layout.ts): the pane arrangement persists and
 *    is restored instead of the default layout; narrow and wide modes keep
 *    separate arrangements; an older saved layout is healed, not discarded.
 *  - Settings: defaults replace the user's appearance only after confirmation.
 *
 * Runs against the fake DOM (tests/fakeDom.ts); MapView draws into a recording
 * 2D context (tests/canvasRecorder.ts).
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { OutputMap } from "@ledmapper/protocol";
import { recordCanvas, type CanvasRecorder } from "./canvasRecorder";
import { asFake, installFakeDom, type FakeElement } from "./fakeDom";
import { getAppearance, resetAppearance, updateAppearance } from "../src/store/appearance";
import { mapStore, type StoredMap } from "../src/store/mapStore";
import { generateFixture } from "../src/effects/fixtures";
import { FxLayout, type PaneSpec } from "../src/effects/editor/layout";
import { MapView } from "../src/ui/mapview";
import type { Router } from "../src/ui/app/router";
import { MapDetailScreen } from "../src/ui/screens/mapDetail";
import { SettingsScreen } from "../src/ui/screens/settings";

const dom = installFakeDom();
const router = { navigate: () => undefined, path: () => "/", back: () => undefined } as unknown as Router;
const NARROW = "(max-width: 719px)";
const LAYOUT_KEY = "fxedit.layout.v2";

const ring = (): OutputMap => generateFixture("ring", { count: 12, seed: 1, jitterFrac: 0 });

/** What one frame of a view drew, in overlay terms. */
function overlays(rec: CanvasRecorder): { grid: boolean; triad: boolean; stats: boolean } {
  const t = rec.texts();
  return {
    grid: t.some((s) => s.startsWith("grid ")),
    triad: ["X", "Y", "Z"].every((a) => t.includes(a)),
    stats: t.some((s) => s.includes("solved")),
  };
}

interface Mounted {
  rec: CanvasRecorder;
  view: MapView;
}

function mountView(): Mounted {
  const canvas = asFake(document.createElement("canvas"));
  canvas.rect = { x: 0, y: 0, width: 320, height: 240 };
  const rec = recordCanvas(canvas);
  const view = new MapView(canvas as unknown as HTMLCanvasElement, ring());
  view.start();
  return { rec, view };
}

/** Clear the recorders, draw one frame in every started view, return each frame's overlays. */
function frame(...views: Mounted[]): { grid: boolean; triad: boolean; stats: boolean }[] {
  for (const v of views) v.rec.clear();
  dom.flushAnimationFrames();
  return views.map((v) => overlays(v.rec));
}

const flushTasks = (): Promise<void> => new Promise((r) => setImmediate(r));

// -- MapView: defaults seed, the view owns ---------------------------------------------

test("a view's switched-off grid and triad stay off in every frame even with the defaults on [rr:PR-3]", () => {
  resetAppearance();
  updateAppearance({ showGrid: true, showTriad: true });
  const seeded = mountView(); // follows the defaults
  const own = mountView();
  own.view.showGrid = false; // the user's per-view choice
  own.view.showTriad = false;
  try {
    for (let i = 0; i < 3; i++) {
      const [s, o] = frame(seeded, own);
      assert.equal(s!.grid && s!.triad, true, "the defaults seed new views on");
      assert.equal(o!.grid, false, `frame ${i}: the default must not draw the grid back in`);
      assert.equal(o!.triad, false, `frame ${i}: the default must not draw the triad back in`);
    }
  } finally {
    seeded.view.stop();
    own.view.stop();
    resetAppearance();
  }
});

test("changing the appearance defaults never overrides an open view's own overlay choice [rr:PR-3]", () => {
  resetAppearance(); // grid default off
  const a = mountView();
  a.view.showGrid = true; // the user turned this view's grid on
  try {
    updateAppearance({ showGrid: true });
    updateAppearance({ showGrid: false });
    assert.equal(frame(a)[0]!.grid, true, "the default flipping off doesn't reach into the view");
    a.view.showGrid = false; // …and later off again
    updateAppearance({ showGrid: true });
    assert.equal(frame(a)[0]!.grid, false, "the default flipping on doesn't either");
    // The default still seeds views opened after it changed.
    const b = mountView();
    try {
      assert.equal(frame(a, b)[1]!.grid, true);
    } finally {
      b.view.stop();
    }
  } finally {
    a.view.stop();
    resetAppearance();
  }
});

test("a thumbnail view stays decluttered whatever the appearance defaults say [rr:PR-3]", () => {
  resetAppearance();
  updateAppearance({ showGrid: true, showTriad: true, showStats: true });
  const thumb = mountView();
  thumb.view.useThumbnailFraming();
  try {
    assert.deepEqual(frame(thumb)[0], { grid: false, triad: false, stats: false });
    updateAppearance({ showGrid: false });
    updateAppearance({ showGrid: true, showStats: true });
    assert.deepEqual(frame(thumb)[0], { grid: false, triad: false, stats: false });
  } finally {
    thumb.view.stop();
    resetAppearance();
  }
});

// -- Map Detail overlay toggles --------------------------------------------------------

test("Map Detail's overlay toggles seed from the defaults, then the view's own choice wins [rr:PR-3]", async () => {
  resetAppearance();
  updateAppearance({ showGrid: true, showTriad: false });
  const rec = {
    id: "m1",
    name: "Ring",
    map: ring(),
    rmsReprojPx: 0.3,
    updatedAt: new Date(0).toISOString(),
  } as unknown as StoredMap;
  const store = mapStore as unknown as { get: (id: string) => Promise<StoredMap | undefined> };
  const realGet = store.get;
  store.get = () => Promise.resolve(rec);
  const screen = MapDetailScreen(router, "m1");
  const el = asFake(screen.el);
  const drawn = recordCanvas(el.querySelector("canvas.detail-canvas")!);
  try {
    document.body.appendChild(screen.el);
    screen.onMount?.();
    for (let i = 0; i < 5 && el.querySelector(".viewtoggle") === null; i++) await flushTasks();
    const toggle = (title: string): FakeElement =>
      el.querySelector(`.detail-viewtoggles .viewtoggle[title="${title}"]`)!;
    const draw = (): ReturnType<typeof overlays> => {
      drawn.clear();
      dom.flushAnimationFrames();
      return overlays(drawn);
    };
    // Seeded from the defaults: grid lit + drawn, triad off.
    assert.equal(toggle("Grid").getAttribute("aria-pressed"), "true");
    assert.equal(toggle("World triad").getAttribute("aria-pressed"), "false");
    assert.deepEqual([draw().grid, draw().triad], [true, false]);

    toggle("Grid").click(); // the user turns this view's grid off…
    toggle("World triad").click(); // …and its triad on
    assert.equal(toggle("Grid").classList.contains("viewtoggle--on"), false);
    assert.deepEqual([draw().grid, draw().triad], [false, true]);

    // Re-saving / flipping the defaults afterwards doesn't override the view.
    updateAppearance({ showGrid: true, showTriad: false });
    updateAppearance({ showGrid: false, showTriad: false });
    updateAppearance({ showGrid: true });
    const f = draw();
    assert.deepEqual([f.grid, f.triad], [false, true]);
    assert.equal(toggle("Grid").getAttribute("aria-pressed"), "false");
    assert.equal(toggle("World triad").getAttribute("aria-pressed"), "true");
  } finally {
    screen.onUnmount?.();
    el.remove();
    store.get = realGet;
    resetAppearance();
  }
});

// -- Effects workspace arrangement ---------------------------------------------------------

function editorPanes(): PaneSpec[] {
  const pane = (id: string, title: string, primary = false): PaneSpec => ({
    id,
    title,
    primary,
    node: document.createElement("div") as unknown as HTMLElement,
  });
  return [
    pane("code", "Code", true),
    pane("uniforms", "Uniforms", true),
    pane("preview", "Preview"),
    pane("diagnostics", "Device"),
    pane("disasm", "Disassembly"),
    pane("chat", "AI chat"),
    pane("midi", "MIDI"),
    pane("video", "Video"),
  ];
}

/** Open the effects workspace in wide (desktop) or narrow (phone) mode. */
function openWorkspace(mode: "wide" | "narrow"): FxLayout {
  dom.window.mediaMatcher = (q) => mode === "narrow" && q === NARROW;
  const layout = new FxLayout({ panes: editorPanes(), onRelayout: () => undefined });
  document.body.appendChild(layout.root);
  layout.mount();
  return layout;
}

function closeWorkspace(layout: FxLayout): void {
  layout.unmount();
  layout.root.remove();
  dom.window.mediaMatcher = () => false;
}

/** Pane ids with a tab in the given strip (wide edge or narrow region). */
function tabsIn(layout: FxLayout, stripSel: string): string[] {
  const strip = asFake(layout.root).querySelector(stripSel);
  return strip ? strip.querySelectorAll(".fxlayout-tablist [data-pane]").map((b) => b.dataset["pane"]!) : [];
}

test("the user's workspace arrangement is restored on reopen instead of the default layout [rr:PR-3]", () => {
  localStorage.removeItem(LAYOUT_KEY);
  const fresh = openWorkspace("wide");
  assert.equal(fresh.dockOf("preview"), "right", "default home of the preview");
  fresh.relocate("preview", "left");
  fresh.relocate("diagnostics", "top");
  fresh.setVisible("chat", false);
  // Front the Video tab on the bottom dock (not the tab the dock would heal to).
  asFake(fresh.root).querySelector('.fxlayout-edge--bottom [data-pane="video"]')!.click();
  closeWorkspace(fresh);

  const reopened = openWorkspace("wide");
  try {
    assert.equal(reopened.dockOf("preview"), "left");
    assert.equal(reopened.dockOf("diagnostics"), "top");
    assert.equal(reopened.isVisible("chat"), false);
    assert.deepEqual(reopened.hiddenPanes(), [{ id: "chat", title: "AI chat" }]);
    const front = asFake(reopened.root).querySelector(".fxlayout-edge--bottom .fxlayout-edgetab--active")!;
    assert.equal(front.dataset["pane"], "video");
    assert.deepEqual(tabsIn(reopened, ".fxlayout-edge--left"), ["preview"]);
  } finally {
    closeWorkspace(reopened);
    localStorage.removeItem(LAYOUT_KEY);
  }
});

test("the phone and desktop modes keep separate arrangements, so switching modes overrides neither [rr:PR-3]", () => {
  localStorage.removeItem(LAYOUT_KEY);
  const desk = openWorkspace("wide");
  desk.relocate("preview", "left");
  closeWorkspace(desk);

  const phone = openWorkspace("narrow");
  // The desktop move didn't leak into the phone arrangement (still the default).
  assert.ok(tabsIn(phone, ".fxlayout-nregion--bottom").includes("preview"));
  phone.relocateNarrow("chat", "top");
  closeWorkspace(phone);

  const desk2 = openWorkspace("wide");
  try {
    assert.equal(desk2.dockOf("preview"), "left", "the phone session didn't override the desktop layout");
    assert.equal(desk2.dockOf("chat"), "bottom");
  } finally {
    closeWorkspace(desk2);
  }
  const phone2 = openWorkspace("narrow");
  try {
    assert.deepEqual(tabsIn(phone2, ".fxlayout-nregion--top"), ["chat"]);
    assert.ok(tabsIn(phone2, ".fxlayout-nregion--bottom").includes("preview"));
  } finally {
    closeWorkspace(phone2);
    localStorage.removeItem(LAYOUT_KEY);
  }
});

test("a layout saved by an older build keeps the user's placements while new panes get default homes [rr:PR-3]", () => {
  // Saved before the MIDI / Video panes existed, and naming a pane that is gone.
  localStorage.setItem(
    LAYOUT_KEY,
    JSON.stringify({
      v: 2,
      center: "preview",
      docks: { left: ["code"], right: ["uniforms", "oldpane"], top: [], bottom: ["diagnostics", "chat", "disasm"] },
      active: { left: "code", right: "uniforms", top: null, bottom: "chat" },
      edgeSizes: { left: 0.4, right: 0.3, top: 0.25, bottom: 0.2 },
      hidden: ["oldpane"],
    }),
  );
  const layout = openWorkspace("wide");
  try {
    assert.equal(layout.dockOf("preview"), "center", "the user's center pane is kept");
    assert.equal(layout.dockOf("code"), "left");
    assert.equal(layout.dockOf("uniforms"), "right");
    assert.equal(
      asFake(layout.root).querySelector(".fxlayout-edge--bottom .fxlayout-edgetab--active")!.dataset["pane"],
      "chat",
    );
    // New panes land in a default dock; the vanished one is simply dropped.
    assert.equal(layout.dockOf("midi"), "bottom");
    assert.equal(layout.dockOf("video"), "bottom");
    assert.deepEqual(tabsIn(layout, ".fxlayout-edge--right"), ["uniforms"]);
    assert.deepEqual(layout.hiddenPanes(), []);
    const cols = asFake(layout.root).querySelector(".fxlayout-dock")!.style.getPropertyValue("grid-template-columns");
    assert.ok(cols.startsWith("0.4fr "), `the user's left-dock size is kept (${cols})`);
  } finally {
    closeWorkspace(layout);
    localStorage.removeItem(LAYOUT_KEY);
  }
});

// -- Settings: explicit appearance vs. Reset to defaults ----------------------------------

test("the shipped defaults replace the user's appearance only after an explicit confirmation [rr:PR-3]", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  resetAppearance();
  updateAppearance({ ledSize: 2, showGrid: true, accentPreset: "teal" });
  const screen = SettingsScreen(router);
  const el = asFake(screen.el);
  document.body.appendChild(screen.el);
  const resetBtn = (): FakeElement => el.querySelector(".settings-reset button")!;
  const dialogButton = (label: string): FakeElement =>
    asFake(document.body)
      .querySelectorAll(".k-confirm button")
      .find((b) => b.textContent === label)!;
  try {
    resetBtn().click();
    assert.ok(asFake(document.body).querySelector(".k-confirm"), "asks before resetting");
    assert.equal(getAppearance().ledSize, 2, "nothing reset just by asking");
    dialogButton("Cancel").click();
    await flushTasks();
    mock.timers.tick(200);
    assert.deepEqual(
      [getAppearance().ledSize, getAppearance().showGrid, getAppearance().accentPreset],
      [2, true, "teal"],
      "cancelling keeps every explicit setting",
    );
    resetBtn().click();
    dialogButton("Reset").click();
    await flushTasks();
    mock.timers.tick(200);
    assert.deepEqual(
      [getAppearance().ledSize, getAppearance().showGrid, getAppearance().accentPreset],
      [1, false, "indigo"],
      "confirmed: back to the shipped defaults",
    );
    mock.timers.tick(3000); // let the confirmation toast clear
  } finally {
    el.remove();
    mock.timers.reset();
    resetAppearance();
  }
});
