/**
 * Screen space (PR-4): the workspace spends the viewport on content — on
 * phones and desktops alike — for 3D previews, panes, menus and workspace
 * controls.
 *
 *  - FxLayout (src/effects/editor/layout.ts): a vertical dock stack below the
 *    720px breakpoint, edge docks around one center pane above it; docked panes
 *    carry their title + controls in a single tab strip (no second header row,
 *    FUG-55); the center takes exactly what the docks leave and empty docks
 *    reserve nothing; closed panes leave the workspace but stay recallable; the
 *    pane menu flips/clamps to stay on screen; a collapsed toolbar drawer puts
 *    its expand control inside an existing corner strip (FUG-58).
 *  - MapView: the 3D preview tracks its pane's box and frames the fixture to
 *    the box's short side, so a bigger pane shows a bigger fixture (FUG-34).
 *  - Map Detail: the view toggles overlay the 3D stage; opening an editor panel
 *    keeps the 3D view's size (the page scrolls) and closing releases it.
 *  - App shell: tab-specific actions fold into the ⋯ menu; immersive screens
 *    hide the tab bar.
 *
 * Runs against the fake DOM (tests/fakeDom.ts): assertions are on structure,
 * classes, inline sizes and positions — what the TS code controls (the CSS
 * that styles them is not loadable under node:test).
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { OutputMap } from "@ledmapper/protocol";
import { recordCanvas, type CanvasRecorder } from "./canvasRecorder";
import { asFake, fire, installFakeDom, textOf, FakeElement, type FakeNode } from "./fakeDom";
import { resetAppearance } from "../src/store/appearance";
import { mapStore, type StoredMap } from "../src/store/mapStore";
import { generateFixture } from "../src/effects/fixtures";
import { FxLayout, type PaneSpec } from "../src/effects/editor/layout";
import { MapView } from "../src/ui/mapview";
import type { Router } from "../src/ui/app/router";
import { Shell } from "../src/ui/app/shell";
import { setTabMenuItems } from "../src/ui/app/tabMenu";
import { MapDetailScreen } from "../src/ui/screens/mapDetail";

const dom = installFakeDom();
const router = { navigate: () => undefined, path: () => "/", back: () => undefined } as unknown as Router;
const LAYOUT_KEY = "fxedit.layout.v2";

/** Size the viewport; `(max-width: Npx)` media queries answer against it. */
function viewport(width: number, height = 800): void {
  dom.window.innerWidth = width;
  dom.window.innerHeight = height;
  dom.window.mediaMatcher = (q) => {
    const m = /\(max-width:\s*(\d+)px\)/.exec(q);
    return m !== null && width <= Number(m[1]);
  };
}

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

interface Workspace {
  layout: FxLayout;
  root: FakeElement;
  panes: PaneSpec[];
}

/** A freshly-mounted effects workspace (default arrangement) at the current viewport. */
function openWorkspace(collapseToggle?: { collapsed: () => boolean; onExpand: () => void }): Workspace {
  localStorage.removeItem(LAYOUT_KEY);
  const panes = editorPanes();
  const layout = new FxLayout(
    collapseToggle ? { panes, onRelayout: () => undefined, collapseToggle } : { panes, onRelayout: () => undefined },
  );
  document.body.appendChild(layout.root);
  layout.mount();
  return { layout, root: asFake(layout.root), panes };
}

function closeWorkspace(ws: Workspace): void {
  ws.layout.unmount();
  ws.layout.root.remove();
  localStorage.removeItem(LAYOUT_KEY);
}

/** Pane ids with a tab in a strip, in order. */
const tabs = (strip: FakeElement): string[] =>
  strip.querySelectorAll(".fxlayout-tablist [data-pane]").map((b) => b.dataset["pane"]!);
/** The `Nfr` shares of a grid template (dividers skipped). */
const shares = (template: string): number[] =>
  template
    .split(" ")
    .filter((t) => t.endsWith("fr"))
    .map(parseFloat);
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps;

// -- workspace modes ------------------------------------------------------------------

test("phones get a vertical dock stack and wider screens edge docks, switching at 720px [rr:PR-4]", () => {
  for (const [width, narrow] of [
    [390, true],
    [719, true],
    [720, false],
    [1280, false],
  ] as const) {
    viewport(width);
    const ws = openWorkspace();
    try {
      assert.equal(ws.root.classList.contains("fxlayout--narrow"), narrow, `${width}px`);
      assert.equal(ws.root.classList.contains("fxlayout--wide"), !narrow, `${width}px`);
      assert.equal(ws.root.querySelector(".fxlayout-nstack") !== null, narrow, `${width}px stack`);
      assert.equal(ws.root.querySelector(".fxlayout-dock") !== null, !narrow, `${width}px docks`);
    } finally {
      closeWorkspace(ws);
    }
  }
  viewport(1280);
});

test("on a phone the code fills the middle and every other pane shares one tabbed bottom strip [rr:PR-4]", () => {
  viewport(390, 760);
  const ws = openWorkspace();
  try {
    const regions = ws.root.querySelectorAll(".fxlayout-nregion");
    assert.deepEqual(
      regions.map((r) => r.className),
      ["fxlayout-nregion fxlayout-nregion--center", "fxlayout-nregion fxlayout-nregion--bottom"],
      "an empty top region takes no space at all",
    );
    const [center, bottom] = regions;
    assert.deepEqual(tabs(center!), ["code"]);
    assert.deepEqual(tabs(bottom!), ["uniforms", "preview", "diagnostics", "disasm", "chat", "midi", "video"]);
    // Only the fronted pane of the strip is mounted; the rest are a tab away.
    assert.deepEqual(
      bottom!.querySelectorAll(".fxpane").map((p) => p.dataset["pane"]),
      ["uniforms"],
    );
    assert.ok(!asFake(ws.panes.find((p) => p.id === "preview")!.node).isConnected);
    // Two tracks + one divider, sharing the full height.
    const rows = ws.root.querySelector(".fxlayout-nstack")!.style.getPropertyValue("grid-template-rows");
    assert.equal(rows.split(" ").length, 3);
    assert.ok(near(shares(rows).reduce((a, b) => a + b, 0), 1), rows);
  } finally {
    closeWorkspace(ws);
    viewport(1280);
  }
});

// -- panes ----------------------------------------------------------------------------

test("a docked pane's title and controls live in its tab strip, with no second header row [rr:PR-4]", () => {
  viewport(1280);
  const ws = openWorkspace();
  try {
    const right = ws.root.querySelector(".fxlayout-edge--right")!;
    assert.deepEqual(tabs(right), ["uniforms", "preview"]);
    const ctl = right.querySelector(".fxlayout-edgetabs > .fxlayout-tabctl")!;
    assert.deepEqual(
      ctl.querySelectorAll("button").map((b) => b.getAttribute("title")),
      ["Move pane", "Hide pane"],
    );
    const head = (id: string): FakeElement => ws.root.querySelector(`.fxpane[data-pane="${id}"] > .fxpane-head`)!;
    assert.equal(head("uniforms").style.getPropertyValue("display"), "none", "fronted docked pane: no header row");
    assert.equal(head("code").style.getPropertyValue("display"), "", "the center pane (no tab strip) keeps its header");
    // A lone pane on an edge still gets the single strip and no header.
    ws.layout.relocate("chat", "left");
    const left = ws.root.querySelector(".fxlayout-edge--left")!;
    assert.deepEqual(tabs(left), ["chat"]);
    assert.ok(left.querySelector(".fxlayout-tabctl"));
    assert.equal(head("chat").style.getPropertyValue("display"), "none");
  } finally {
    closeWorkspace(ws);
  }
});

test("the center pane takes exactly the space the docks leave, and empty docks reserve none [rr:PR-4]", () => {
  viewport(1280);
  const ws = openWorkspace();
  const grid = (): FakeElement => ws.root.querySelector(".fxlayout-dock")!;
  const cols = (): string => grid().style.getPropertyValue("grid-template-columns");
  const rows = (): string => grid().style.getPropertyValue("grid-template-rows");
  try {
    // Default: right + bottom docks only — no tracks or dividers for left/top.
    assert.deepEqual(shares(cols()), [0.7, 0.3]);
    assert.equal(shares(rows()).length, 2);
    assert.ok(near(shares(rows()).reduce((a, b) => a + b, 0), 1));
    assert.equal(ws.root.querySelectorAll(".fxlayout-divider--v").length, 1);
    assert.equal(ws.root.querySelectorAll(".fxlayout-divider--h").length, 1);
    // Close both right-dock panes: the dock and its divider vanish; the center widens.
    ws.layout.setVisible("uniforms", false);
    ws.layout.setVisible("preview", false);
    assert.ok(ws.root.querySelector(".fxlayout-edge--right") === null, "no strip for an empty dock");
    assert.deepEqual(shares(cols()), [1]);
    assert.equal(ws.root.querySelectorAll(".fxlayout-divider--v").length, 0);
  } finally {
    closeWorkspace(ws);
  }
});

test("closed panes leave the workspace entirely but stay recallable from a list [rr:PR-4]", () => {
  viewport(1280);
  const ws = openWorkspace();
  const node = (id: string): FakeElement => asFake(ws.panes.find((p) => p.id === id)!.node);
  try {
    ws.root.querySelector('.fxlayout-edge--right .fxlayout-tabctl button[title="Hide pane"]')!.click();
    assert.equal(node("uniforms").isConnected, false, "a closed pane takes no space");
    assert.deepEqual(ws.layout.hiddenPanes(), [{ id: "uniforms", title: "Uniforms" }]);
    assert.deepEqual(tabs(ws.root.querySelector(".fxlayout-edge--right")!), ["preview"]);
    ws.layout.setVisible("uniforms", true); // the ⋯ "Show Uniforms" recall
    assert.deepEqual(ws.layout.hiddenPanes(), []);
    assert.equal(node("uniforms").isConnected, true);
    const front = ws.root.querySelector(".fxlayout-edge--right .fxlayout-edgetab--active")!;
    assert.equal(front.dataset["pane"], "uniforms", "a recalled pane comes back to the front of its dock");
  } finally {
    closeWorkspace(ws);
  }
});

// -- menus ----------------------------------------------------------------------------

/** Open a strip's "Move pane" menu with the button at `anchor` and the menu
 * measuring `size` (the fake DOM has no layout), returning the menu element. */
function openPaneMenu(
  ws: Workspace,
  stripSel: string,
  anchor: { x: number; y: number },
  size: { width: number; height: number },
): FakeElement {
  const body = asFake(document.body);
  const realAppend = body.appendChild.bind(body);
  body.appendChild = <T extends FakeNode>(n: T): T => {
    if (n instanceof FakeElement && n.classList.contains("fxlayout-relo")) n.rect = { x: 0, y: 0, ...size };
    return realAppend(n);
  };
  try {
    const move = ws.root.querySelector(`${stripSel} .fxlayout-tabctl button[title="Move pane"]`)!;
    move.rect = { ...anchor, width: 24, height: 24 };
    move.click();
  } finally {
    Reflect.deleteProperty(body, "appendChild");
  }
  return body.querySelector(".fxlayout-relo")!;
}

test("the pane menu flips and clamps so it stays fully on screen at the viewport edges [rr:PR-4]", () => {
  mock.timers.enable({ apis: ["setTimeout"] }); // the menu's deferred outside-click listener
  const place = (m: FakeElement): { left: number; top: number } => ({
    left: parseFloat(m.style.getPropertyValue("left")),
    top: parseFloat(m.style.getPropertyValue("top")),
  });
  /** Open a workspace at `width`×`height`, run `fn` on it, always close it. */
  const at = (width: number, height: number, fn: (ws: Workspace) => void): void => {
    viewport(width, height);
    const ws = openWorkspace();
    try {
      fn(ws);
    } finally {
      closeWorkspace(ws);
    }
  };
  try {
    // Desktop: a button in the bottom-right corner → the menu opens up and leftward.
    at(1280, 800, (ws) => {
      const menu = openPaneMenu(ws, ".fxlayout-edge--bottom", { x: 1240, y: 770 }, { width: 180, height: 220 });
      assert.equal(menu.style.getPropertyValue("position"), "fixed");
      const p = place(menu);
      assert.deepEqual(p, { left: 1084, top: 548 });
      assert.ok(p.left >= 0 && p.left + 180 <= 1280 && p.top >= 0 && p.top + 220 <= 800, "fully on screen");
      assert.ok(p.top + 220 <= 770, "opens above the button instead of covering it");
    });
    // Phone: room below the button, but not to its right → right-aligned, below.
    at(390, 640, (ws) => {
      const menu = openPaneMenu(ws, ".fxlayout-nregion--center", { x: 360, y: 40 }, { width: 180, height: 220 });
      assert.deepEqual(place(menu), { left: 204, top: 66 });
    });
    // A menu wider than the room on either side is clamped to the screen margin.
    at(320, 640, (ws) => {
      const menu = openPaneMenu(ws, ".fxlayout-nregion--center", { x: 100, y: 40 }, { width: 280, height: 220 });
      assert.equal(place(menu).left, 4);
    });
  } finally {
    viewport(1280);
    mock.timers.reset();
  }
});

// -- workspace controls -----------------------------------------------------------------

test("a collapsed toolbar's expand control docks into an existing corner strip, not over panes [rr:PR-4]", () => {
  let collapsed = true;
  let expanded = 0;
  const toggle = { collapsed: () => collapsed, onExpand: () => void expanded++ };
  const hostOf = (ws: Workspace): FakeElement => {
    const t = ws.root.querySelectorAll(".fxlayout-expand-toggle");
    assert.equal(t.length, 1, "exactly one expand control");
    return t[0]!.parentElement!;
  };
  viewport(1280);
  let ws = openWorkspace(toggle);
  try {
    // Default desktop arrangement: no top dock, so the right dock's strip owns the corner.
    const host = hostOf(ws);
    assert.ok(host.matches(".fxlayout-edge--right > .fxlayout-edgetabs > .fxlayout-tabctl"), host.className);
    assert.deepEqual(
      host.querySelectorAll("button").map((b) => b.getAttribute("title")),
      ["Move pane", "Hide pane", "Show toolbar"],
      "a sibling of the strip's own controls",
    );
    host.querySelector(".fxlayout-expand-toggle")!.click();
    assert.equal(expanded, 1);
    // With a top dock, the top strip owns the corner.
    ws.layout.relocate("chat", "top");
    assert.ok(hostOf(ws).matches(".fxlayout-edge--top > .fxlayout-edgetabs > .fxlayout-tabctl"));
    // Expanded: no in-strip control.
    collapsed = false;
    ws.layout.refresh();
    assert.equal(ws.root.querySelectorAll(".fxlayout-expand-toggle").length, 0);
  } finally {
    closeWorkspace(ws);
  }
  // Phone: the topmost region's strip.
  collapsed = true;
  viewport(390);
  ws = openWorkspace(toggle);
  try {
    assert.ok(hostOf(ws).matches(".fxlayout-nregion--center > .fxlayout-tabs > .fxlayout-tabctl"));
  } finally {
    closeWorkspace(ws);
    viewport(1280);
  }
});

// -- 3D previews ----------------------------------------------------------------------

test("the 3D preview tracks its pane's box and frames the fixture to fill it [rr:PR-4]", () => {
  resetAppearance();
  const map: OutputMap = generateFixture("ring", { count: 16, seed: 1, jitterFrac: 0 });
  const start = (w: number, h: number): { canvas: FakeElement; rec: CanvasRecorder; view: MapView } => {
    const canvas = asFake(document.createElement("canvas"));
    canvas.rect = { x: 0, y: 0, width: w, height: h };
    const rec = recordCanvas(canvas);
    const view = new MapView(canvas as unknown as HTMLCanvasElement, map);
    view.start();
    return { canvas, rec, view };
  };
  /** LED dot centres relative to the box centre. */
  const offsets = (rec: CanvasRecorder, w: number, h: number): number[][] =>
    rec.of("arc").map((c) => [(c.args[0] as number) - w / 2, (c.args[1] as number) - h / 2]);
  const small = start(300, 200);
  const big = start(640, 360);
  try {
    // Framed to the short side: a 360px-tall pane shows the fixture 1.8× a 200px one.
    const a = offsets(small.rec, 300, 200);
    const b = offsets(big.rec, 640, 360);
    assert.equal(a.length, 16);
    a.forEach(([x, y], i) => {
      assert.ok(near(b[i]![0]!, x! * 1.8, 1e-6) && near(b[i]![1]!, y! * 1.8, 1e-6), `LED ${i}`);
    });
    // The small pane grows (splitter drag / rotation): backing store and framing follow.
    dom.resize(small.canvas, 640, 360);
    assert.deepEqual([small.canvas.width, small.canvas.height], [640, 360]);
    small.rec.clear();
    big.rec.clear();
    dom.flushAnimationFrames();
    assert.deepEqual(small.rec.of("fillRect")[0]!.args, [0, 0, 640, 360], "the background fills the new box");
    assert.deepEqual(offsets(small.rec, 640, 360), offsets(big.rec, 640, 360));
  } finally {
    small.view.stop();
    big.view.stop();
  }
});

// -- Map Detail ----------------------------------------------------------------------

async function openMapDetail(): Promise<{ el: FakeElement; dispose: () => void }> {
  const rec = {
    id: "m1",
    name: "Ring",
    map: generateFixture("ring", { count: 12, seed: 1, jitterFrac: 0 }),
    rmsReprojPx: 0.3,
    updatedAt: new Date(0).toISOString(),
  } as unknown as StoredMap;
  const store = mapStore as unknown as { get: (id: string) => Promise<StoredMap | undefined> };
  const realGet = store.get;
  store.get = () => Promise.resolve(rec);
  const screen = MapDetailScreen(router, "m1");
  const el = asFake(screen.el);
  document.body.appendChild(screen.el);
  screen.onMount?.();
  for (let i = 0; i < 5 && el.querySelector(".viewtoggle") === null; i++) {
    await new Promise((r) => setImmediate(r));
  }
  return {
    el,
    dispose: () => {
      screen.onUnmount?.();
      el.remove();
      store.get = realGet;
    },
  };
}

test("Map Detail overlays its 3D-view toggles on the viewport instead of adding a control row [rr:PR-4]", async () => {
  const { el, dispose } = await openMapDetail();
  try {
    const stage = el.querySelector(".detail-main > .detail-stage")!;
    const toggles = el.querySelector(".detail-viewtoggles")!;
    const canvas = el.querySelector("canvas.detail-canvas")!;
    assert.ok(
      toggles.parentElement === stage && canvas.parentElement === stage,
      "the toggles share the stage with the 3D canvas",
    );
    assert.deepEqual(
      toggles.querySelectorAll(".viewtoggle").map((b) => b.getAttribute("title")),
      ["Grid", "World triad", "Camera path"],
    );
    assert.ok(el.querySelector(".detail-actions .viewtoggle") === null, "not in the action row below");
  } finally {
    dispose();
  }
});

test("opening a Map Detail editor panel keeps the 3D view's size and closing releases it [rr:PR-4]", async () => {
  const { el, dispose } = await openMapDetail();
  try {
    const stage = el.querySelector(".detail-stage")!;
    stage.rect = { x: 0, y: 0, width: 390, height: 420 }; // the view's current fill height
    const region = el.querySelector(".detail-panelregion")!;
    const tile = (label: string): FakeElement =>
      el.querySelectorAll(".k-actiontile").find((t) => textOf(t) === label)!;
    tile("Transform").click();
    assert.equal(stage.style.getPropertyValue("height"), "420px", "the 3D view keeps its size; the page scrolls");
    assert.ok(el.classList.contains("detail--panel-open"));
    assert.ok(region.classList.contains("detail-panelregion--open"));
    tile("Transform").click(); // close: the region rolls up…
    assert.equal(region.style.getPropertyValue("height"), "0px");
    fire(region, "transitionend", { propertyName: "height" }); // …then the view is released
    assert.equal(stage.style.getPropertyValue("height"), "");
    assert.ok(!el.classList.contains("detail--panel-open"));
  } finally {
    dispose();
  }
});

// -- app shell ----------------------------------------------------------------------

test("tab-specific actions fold into the app bar's ⋯ menu instead of taking screen space [rr:PR-4]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const shell = new Shell();
  const root = asFake(shell.root);
  document.body.appendChild(shell.root);
  try {
    const menu = root.querySelector(".appbar-menu")!;
    const labels = (): string[] => menu.querySelectorAll(".appbar-menu-item").map((b) => textOf(b));
    const appWide = labels();
    assert.equal(menu.style.getPropertyValue("display"), "none", "folded away until asked for");
    let imported = 0;
    setTabMenuItems([
      { icon: "upload", label: "Import…", onClick: () => void imported++ },
      { icon: "download", label: "Export library", onClick: () => undefined },
    ]);
    assert.deepEqual(labels(), [...appWide, "Import…", "Export library"]);
    assert.ok(menu.querySelector(".appbar-menu-divider"), "set apart from the app-wide items");
    root.querySelector('.appbar-menu-wrap button[title="More"]')!.click();
    mock.timers.tick(0);
    assert.equal(menu.style.getPropertyValue("display"), "");
    menu.querySelectorAll(".appbar-menu-item").find((b) => textOf(b) === "Import…")!.click();
    assert.equal(imported, 1);
    assert.equal(menu.style.getPropertyValue("display"), "none", "the menu gets out of the way after a pick");
    setTabMenuItems([]); // leaving the tab drops them
    assert.deepEqual(labels(), appWide);
    assert.ok(menu.querySelector(".appbar-menu-divider") === null, "no empty section left behind");
  } finally {
    setTabMenuItems([]);
    shell.root.remove();
    mock.timers.reset();
  }
});

test("immersive screens hide the tab bar so the workspace gets the full height [rr:PR-4]", () => {
  const shell = new Shell();
  const root = asFake(shell.root);
  const tabBar = root.querySelector(".tab-bar")!;
  shell.setChrome({ title: "Edit effect", back: true, tabs: false, overlay: true });
  assert.equal(tabBar.style.getPropertyValue("display"), "none");
  assert.ok(root.classList.contains("shell--overlay"));
  shell.setChrome({ title: "Maps", tabs: true });
  assert.equal(tabBar.style.getPropertyValue("display"), "");
  assert.ok(!root.classList.contains("shell--overlay"));
});
