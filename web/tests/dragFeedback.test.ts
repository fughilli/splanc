/**
 * Continuous adjustments (PR-2): a drag gives immediate perceptual feedback on
 * every step, while the expensive work it could trigger is bounded — deferred
 * to the release, debounced to the settled value, or cancelled when superseded.
 *
 *  - kit Slider: the readout tracks every `input`; `onChange` fires on release.
 *  - Settings: the UI scale (a whole-app reflow) commits on release only; the
 *    3D-view knobs write through live WITHOUT rebuilding the screen, so the
 *    slider being dragged is never torn out mid-gesture (FUG-30).
 *  - Uniform panel: every step streams to preview + device, no re-render; the
 *    device send is fire-and-forget so no step (or the final value) is dropped.
 *  - Color correction: curves/simulator repaint per step; the device push (a
 *    LUT rebuild) is debounced to one RAM-only update; controls rebuild on release.
 *  - Map detail: a Cleanup drag aborts superseded topology extractions.
 *  - Effects workspace: resize relayouts coalesce; divider drags save on release.
 *
 * Runs against the fake DOM (tests/fakeDom.ts) with node:test mock timers.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { OutputMap, ServerMessage } from "@ledmapper/protocol";
import { recordCanvas } from "./canvasRecorder";
import { asFake, fire, installFakeDom, typeInto, type FakeElement } from "./fakeDom";
import { getAppearance, renderSettings, resetAppearance, subscribeAppearance } from "../src/store/appearance";
import { mapStore, type StoredMap } from "../src/store/mapStore";
import { generateFixture } from "../src/effects/fixtures";
import { FxLayout, type PaneSpec } from "../src/effects/editor/layout";
import { UniformPanel } from "../src/effects/editor/uniform-panel";
import type { FxUniform } from "../src/fx/preview";
import { LedMapperClient, type SocketLike } from "../src/net/client";
import { decodeClient, encodeServer } from "../src/net/proto";
import { Slider } from "../src/ui/kit";
import { MapView } from "../src/ui/mapview";
import { appState } from "../src/ui/app/state";
import type { Router } from "../src/ui/app/router";
import { SettingsScreen } from "../src/ui/screens/settings";
import { ColorCorrectionScreen } from "../src/ui/screens/colorCorrection";
import { MapDetailScreen } from "../src/ui/screens/mapDetail";

const dom = installFakeDom();
const router = { navigate: () => undefined, path: () => "/", back: () => undefined } as unknown as Router;

function sliderByLabel(root: unknown, label: string): { input: FakeElement; readout: FakeElement } {
  for (const wrap of asFake(root).querySelectorAll(".k-slider")) {
    if (wrap.querySelector(".k-slider-head > span")?.textContent === label) {
      return { input: wrap.querySelector("input")!, readout: wrap.querySelector(".k-slider-val")! };
    }
  }
  throw new Error(`no slider labelled "${label}"`);
}

/** A connected-device stand-in recording what the screens push to it. */
function stubDevice(): { client: LedMapperClient; pushes: { kind: string; arg: unknown }[] } {
  const pushes: { kind: string; arg: unknown }[] = [];
  const client = {
    isConnected: true,
    setColorCorrection: (cc: unknown) => {
      pushes.push({ kind: "color", arg: JSON.parse(JSON.stringify(cc)) });
      return Promise.resolve();
    },
    setBrightness: (b: number) => {
      pushes.push({ kind: "brightness", arg: b });
      return Promise.resolve();
    },
    setUniforms: (v: unknown) => {
      pushes.push({ kind: "uniforms", arg: v });
      return true;
    },
  };
  return { client: client as unknown as LedMapperClient, pushes };
}

/** Let pending promise continuations run (setImmediate is never mocked here). */
const flushTasks = (): Promise<void> => new Promise((r) => setImmediate(r));

// -- kit Slider ----------------------------------------------------------------

test("a kit Slider's readout tracks every drag step while onChange waits for the release [rr:PR-2]", () => {
  const steps: number[] = [];
  const commits: number[] = [];
  const s = Slider({
    label: "Speed",
    min: 0,
    max: 1,
    step: 0.01,
    value: 0.5,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => steps.push(v),
    onChange: (v) => commits.push(v),
  });
  const readout = asFake(s.el).querySelector(".k-slider-val")!;
  for (const [v, shown] of [
    ["0.55", "55%"],
    ["0.6", "60%"],
    ["0.72", "72%"],
  ] as const) {
    typeInto(s.input, v);
    assert.equal(readout.textContent, shown, "readout follows the thumb");
  }
  assert.deepEqual(steps, [0.55, 0.6, 0.72]);
  assert.deepEqual(commits, [], "nothing committed mid-drag");
  fire(s.input, "change"); // release
  assert.deepEqual(commits, [0.72]);
});

// -- Settings ▸ Appearance ---------------------------------------------------------

test("dragging the UI-scale slider previews the value but reflows the app only on release [rr:PR-2]", () => {
  resetAppearance();
  const screen = SettingsScreen(router);
  document.body.appendChild(screen.el);
  let applied = 0;
  const unsub = subscribeAppearance(() => applied++);
  try {
    const { input, readout } = sliderByLabel(screen.el, "UI scale");
    const rootStyle = asFake(document.documentElement).style;
    for (const [v, shown] of [
      ["1.05", "105%"],
      ["1.15", "115%"],
      ["1.3", "130%"],
    ] as const) {
      typeInto(input, v);
      assert.equal(readout.textContent, shown, "the target scale previews live");
      assert.equal(rootStyle.fontSize, "100.00%", "no whole-app reflow mid-drag");
    }
    assert.equal(applied, 0);
    assert.equal(getAppearance().uiScale, 1);
    fire(input, "change"); // release
    assert.equal(applied, 1, "applied exactly once");
    assert.equal(rootStyle.fontSize, "130.00%");
  } finally {
    unsub();
    screen.el.remove();
    resetAppearance();
  }
});

test("the 3D-view controls apply every drag step live without rebuilding the settings screen [rr:PR-2]", () => {
  resetAppearance();
  const screen = SettingsScreen(router);
  document.body.appendChild(screen.el);
  const panels = (): FakeElement[] => [...asFake(screen.el).firstElementChild!.children];
  try {
    const before = panels();
    const size = sliderByLabel(screen.el, "LED point size");
    const glow = sliderByLabel(screen.el, "Glow");
    const bg = asFake(screen.el).querySelector("input.settings-color")!;
    for (const v of ["1.2", "1.6", "2.1"]) {
      typeInto(size.input, v);
      // Written through immediately: every open viewport draws it next frame.
      assert.equal(renderSettings().ledSize, parseFloat(v));
      assert.ok(size.input.isConnected, "the slider under the finger is never torn out");
    }
    typeInto(glow.input, "1.4");
    assert.equal(renderSettings().glow, 1.4);
    assert.ok(glow.input.isConnected);
    typeInto(bg, "#223344");
    assert.equal(renderSettings().viewBg, "#223344");
    assert.ok(bg.isConnected);
    assert.equal(size.readout.textContent, "2.1×", "the readout tracks the drag on its own");
    assert.ok(
      panels().length === before.length && panels().every((p, i) => p === before[i]),
      "no settings rebuild during continuous adjustment",
    );
  } finally {
    screen.el.remove();
    resetAppearance();
  }
});

// -- Uniform panel (effect editor / color test) -------------------------------------

const SPEED: FxUniform = {
  name: "speed",
  slot: 3,
  width: 1,
  ui: { kind: "slider", min: 0, max: 1, step: 0.01 },
  default: [0.5],
};

test("a uniform-slider drag streams every value to preview and device without re-rendering [rr:PR-2]", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const changes: [number, number[]][] = [];
  const panel = new UniformPanel(host, (slot, value) => changes.push([slot, value]));
  panel.setManifest([SPEED]);
  try {
    const range = asFake(host).querySelector("input[type=range]")!;
    const num = asFake(host).querySelector("input.upanel-num")!;
    const steps = ["0.52", "0.61", "0.7", "0.734"];
    steps.forEach((v, i) => {
      typeInto(range, v);
      assert.equal(changes.length, i + 1, "each step reaches the preview/device sink at once");
      assert.deepEqual(changes[i], [3, [parseFloat(v)]]);
      assert.equal(num.value, v, "the value field tracks the thumb");
      assert.ok(range.isConnected, "the panel is not re-rendered under the drag");
    });
    assert.deepEqual(panel.values(), [{ slot: 3, value: [0.734] }]);
  } finally {
    host.remove();
  }
});

class WireSocket implements SocketLike {
  readyState = 0;
  binaryType?: string;
  sent: Uint8Array[] = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(msg: unknown): void {
    this.onmessage?.({ data: encodeServer(msg as ServerMessage) });
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data as Uint8Array);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

test("every step of a uniform drag goes out to the device immediately, final value last [rr:PR-2]", () => {
  const sockets: WireSocket[] = [];
  const client = new LedMapperClient("ws://device.test/ws", {
    socketFactory: () => {
      const s = new WireSocket();
      sockets.push(s);
      return s;
    },
    now: () => 1000,
    schedule: () => undefined,
  });
  void client.connect();
  const sock = sockets[0]!;
  sock.open();
  sock.receive({
    type: "welcome",
    sessionId: "s-1",
    codeParams: {
      ledCount: 64,
      bits: 6,
      encoding: "hue",
      symbols: 2,
      bitPeriodMs: 100,
      syncPattern: "on_off",
      cycleFrames: 8,
    },
    solverBenchMs: null,
  });
  assert.ok(client.isConnected);
  // The editor / color-test seam: the panel's change sink pushes to the device.
  const host = document.createElement("div");
  const panel = new UniformPanel(host, (slot, value) => {
    if (client.isConnected) client.setUniforms([{ slot, value }]);
  });
  panel.setManifest([SPEED]);
  const range = asFake(host).querySelector("input[type=range]")!;
  const steps = [0.1, 0.4, 0.7, 0.9, 0.734];
  // No device reply arrives between steps (a real reply takes 50–200 ms).
  for (const v of steps) typeInto(range, String(v));
  const frames = sock.sent
    .map((f) => decodeClient(f) as unknown as { type: string; values?: { slot: number; value: number[] }[] })
    .filter((m) => m.type === "set_uniforms");
  assert.equal(frames.length, steps.length, "no step is dropped waiting for a reply");
  const sent = frames.map((m) => m.values![0]!.value[0]!);
  sent.forEach((v, i) => assert.ok(Math.abs(v - steps[i]!) < 1e-4, `step ${i} sent in order`));
  assert.equal(frames[frames.length - 1]!.values![0]!.slot, 3);
});

// -- Color correction --------------------------------------------------------------

test("a gamma drag repaints the curves live but sends the device one debounced RAM-only update [rr:PR-2]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, pushes } = stubDevice();
  appState.client = client;
  const screen = ColorCorrectionScreen(router);
  document.body.appendChild(screen.el);
  try {
    pushes.length = 0; // drop the open-time brightness re-assert
    const plot = recordCanvas(asFake(screen.el).querySelector("canvas.cc-plot")!);
    const fwdBar = recordCanvas(asFake(screen.el).querySelectorAll("canvas.cc-sim-bar")[1]!);
    const { input } = sliderByLabel(screen.el, "R gamma");
    const steps = ["2.0", "2.2", "2.4", "2.6", "2.8"];
    steps.forEach((v, i) => {
      typeInto(input, v);
      assert.equal(plot.of("clearRect").length, i + 1, "transfer curves repainted on every step");
      assert.equal(fwdBar.of("drawImage").length, i + 1, "palette simulator repainted on every step");
      assert.ok(input.isConnected, "the dragged slider is not rebuilt mid-drag");
      mock.timers.tick(50); // steps arrive faster than the push debounce
    });
    assert.equal(pushes.length, 0, "nothing sent while the drag is still moving");
    mock.timers.tick(200);
    assert.equal(pushes.length, 1, "one device update once the drag settles");
    const cc = pushes[0]!.arg as { gamma: number[]; commit: boolean };
    assert.equal(pushes[0]!.kind, "color");
    assert.equal(cc.commit, false, "live preview stays in device RAM (no flash write per drag)");
    assert.equal(cc.gamma[0], 2.8, "the settled value is the one sent");
  } finally {
    screen.onUnmount?.();
    screen.el.remove();
    appState.client = null;
    mock.timers.reset();
  }
});

test("dragging the master brightness sends the device only the settled level [rr:PR-2]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, pushes } = stubDevice();
  appState.client = client;
  const screen = ColorCorrectionScreen(router);
  try {
    pushes.length = 0; // drop the open-time brightness re-assert
    const { input, readout } = sliderByLabel(screen.el, "Output level");
    for (const v of ["0.9", "0.75", "0.6", "0.42"]) {
      typeInto(input, v);
      mock.timers.tick(40);
    }
    assert.equal(readout.textContent, "42%", "the level previews live");
    assert.equal(pushes.length, 0, "nothing sent while the drag is still moving");
    mock.timers.tick(200);
    assert.deepEqual(pushes, [{ kind: "brightness", arg: 0.42 }]);
  } finally {
    screen.onUnmount?.();
    appState.client = null;
    mock.timers.reset();
  }
});

test("dragging a curve on the plot reshapes it live and rebuilds the value controls only on release [rr:PR-2]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, pushes } = stubDevice();
  appState.client = client;
  const screen = ColorCorrectionScreen(router);
  document.body.appendChild(screen.el);
  try {
    pushes.length = 0;
    const canvas = asFake(screen.el).querySelector("canvas.cc-plot")!;
    canvas.rect = { x: 0, y: 0, width: 320, height: 220 }; // CSS box == logical plot size
    const plot = recordCanvas(canvas);
    const gammaReadouts = (): string[] =>
      ["R gamma", "G gamma", "B gamma"].map((l) => sliderByLabel(screen.el, l).readout.textContent);
    const before = gammaReadouts();
    const rSlider = sliderByLabel(screen.el, "R gamma").input;

    fire(canvas, "pointerdown", { pointerId: 1, clientX: 160, clientY: 60 });
    for (const y of [80, 100, 120]) fire(canvas, "pointermove", { pointerId: 1, clientX: 160, clientY: y });
    assert.equal(plot.of("clearRect").length, 4, "the curve follows the pointer on every move");
    assert.ok(rSlider.isConnected, "value controls are not rebuilt during the drag");
    assert.deepEqual(gammaReadouts(), before);

    fire(canvas, "pointerup", { pointerId: 1 });
    assert.ok(!rSlider.isConnected, "controls rebuilt once, on release");
    assert.notDeepEqual(gammaReadouts(), before, "the rebuilt sliders show the dragged gamma");
    mock.timers.tick(200);
    assert.equal(pushes.filter((p) => p.kind === "color").length, 1, "one debounced device update for the whole drag");
  } finally {
    screen.onUnmount?.();
    screen.el.remove();
    appState.client = null;
    mock.timers.reset();
  }
});

// -- Map detail: topology preview ------------------------------------------------------

test("a topology Cleanup drag cancels superseded extractions; only the latest is applied [rr:PR-2]", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  // Big enough that the extractor yields (every 64 rows) — where an abort lands.
  const map: OutputMap = generateFixture("ring", { count: 256, seed: 3, jitterFrac: 0 });
  const rec = {
    id: "m1",
    name: "Ring",
    map,
    rmsReprojPx: 0.3,
    updatedAt: new Date(0).toISOString(),
  } as unknown as StoredMap;
  const store = mapStore as unknown as { get: (id: string) => Promise<StoredMap | undefined> };
  const realGet = store.get;
  store.get = () => Promise.resolve(rec);
  const applied: unknown[] = [];
  const realSetTopology = MapView.prototype.setTopology;
  MapView.prototype.setTopology = function (this: MapView, t) {
    applied.push(t);
    realSetTopology.call(this, t);
  };
  const screen = MapDetailScreen(router, "m1");
  document.body.appendChild(screen.el);
  /** Advance mocked timers + run continuations until `done()` (bounded). */
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 2000 && !done(); i++) {
      mock.timers.tick(1);
      await flushTasks();
    }
    assert.ok(done(), "condition reached");
  };
  try {
    screen.onMount?.();
    await until(() => asFake(screen.el).querySelectorAll(".k-actiontile").length > 0);
    const topoTile = asFake(screen.el)
      .querySelectorAll(".k-actiontile")
      .find((t) => t.textContent === "Topology")!;
    topoTile.click(); // opens the panel → one initial preview
    await until(() => applied.length === 1);

    // One quick drag across five positions (no extraction finishes in between).
    const { input } = sliderByLabel(screen.el, "Cleanup");
    for (const v of ["0.1", "0.3", "0.5", "0.7", "0.9"]) typeInto(input, v);
    await until(() => applied.length >= 2);
    // Let any superseded run that was NOT cancelled finish too, then count.
    for (let i = 0; i < 200; i++) {
      mock.timers.tick(1);
      await flushTasks();
    }
    assert.equal(applied.length, 2, "superseded drag positions were cancelled, not computed and applied");
  } finally {
    screen.onUnmount?.();
    screen.el.remove();
    store.get = realGet;
    MapView.prototype.setTopology = realSetTopology;
    mock.timers.reset();
  }
});

// -- Effects workspace layout ----------------------------------------------------------

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
  ];
}

test("a burst of window resizes refits the workspace canvases once, after the resize settles [rr:PR-2]", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  localStorage.removeItem("fxedit.layout.v2");
  let relayouts = 0;
  const layout = new FxLayout({ panes: editorPanes(), onRelayout: () => relayouts++ });
  try {
    document.body.appendChild(layout.root);
    layout.mount();
    dom.flushAnimationFrames(); // the mount render's own refit
    relayouts = 0;
    for (let i = 0; i < 20; i++) {
      fire(dom.window, "resize");
      mock.timers.tick(10);
    }
    assert.equal(relayouts, 0, "no canvas refit per resize event while the window is dragged");
    mock.timers.tick(80);
    assert.equal(relayouts, 1);
  } finally {
    layout.unmount();
    layout.root.remove();
    mock.timers.reset();
  }
});

test("dragging a workspace divider resizes the panes live and saves the layout once, on release [rr:PR-2]", () => {
  const KEY = "fxedit.layout.v2";
  localStorage.removeItem(KEY);
  let relayouts = 0;
  const layout = new FxLayout({ panes: editorPanes(), onRelayout: () => relayouts++ });
  const realSet = localStorage.setItem;
  let saves = 0;
  localStorage.setItem = (k: string, v: string): void => {
    if (k === KEY) saves++;
    realSet.call(localStorage, k, v);
  };
  try {
    document.body.appendChild(layout.root);
    layout.mount();
    const grid = asFake(layout.root).querySelector(".fxlayout-dock")!;
    grid.rect = { x: 0, y: 0, width: 1000, height: 600 };
    const divider = asFake(layout.root).querySelector(".fxlayout-divider--v")!; // center | right dock
    relayouts = 0;
    fire(divider, "pointerdown", { pointerId: 1, clientX: 700, clientY: 300 });
    const rightShare = (): number =>
      parseFloat(grid.style.getPropertyValue("grid-template-columns").split(" ").pop()!);
    for (const [x, share] of [
      [680, 0.32],
      [650, 0.35],
      [600, 0.4],
      [550, 0.45],
    ] as const) {
      fire(divider, "pointermove", { pointerId: 1, clientX: x, clientY: 300 });
      assert.ok(Math.abs(rightShare() - share) < 1e-9, `the dock tracks the pointer (x=${x})`);
    }
    assert.equal(relayouts, 4, "the preview canvas refits live with each move");
    assert.equal(saves, 0, "no layout save per pointer move");
    fire(divider, "pointerup", { pointerId: 1 });
    assert.equal(saves, 1, "saved once, on release");
    const saved = JSON.parse(localStorage.getItem(KEY)!) as { edgeSizes: { right: number } };
    assert.ok(Math.abs(saved.edgeSizes.right - 0.45) < 1e-9);
  } finally {
    localStorage.setItem = realSet;
    layout.unmount();
    layout.root.remove();
  }
});
