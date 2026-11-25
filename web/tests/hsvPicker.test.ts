/**
 * D-541 PR 2: the live HSV colour picker. Float colour maths (HSV<->RGB in
 * turns, hex, the LED display transform), the picker widget (pointer drags
 * stream float values; set() moves it without firing), the swatch's Sheet vs
 * popover, and the uniform panel registering colour controls in `setters` so
 * MIDI / the agent can move them live.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { asFake, fire, installFakeDom, type FakeElement } from "./fakeDom";
import {
  hsvToRgb,
  ledDisplay,
  parseHex,
  rawDisplay,
  rgbToHsv,
  srgbDecode,
  srgbEncode,
  toHex,
} from "../src/color/hsv";
import { ColorSwatch, HsvPicker, hueAt, wheelGeometry } from "../src/ui/kit/hsvPicker";
import { UniformPanel } from "../src/effects/editor/uniform-panel";
import type { FxUniform } from "../src/fx/preview";

const dom = installFakeDom();

const near = (a: readonly number[], b: readonly number[], eps = 1e-6): void => {
  assert.equal(a.length, b.length, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]!) <= eps, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`));
};

// -- colour maths ---------------------------------------------------------------

test("hsvToRgb: hue in turns, the VM's hsv2rgb sectors", () => {
  near(hsvToRgb(0, 1, 1), [1, 0, 0]);
  near(hsvToRgb(1 / 3, 1, 1), [0, 1, 0]);
  near(hsvToRgb(2 / 3, 1, 1), [0, 0, 1]);
  near(hsvToRgb(1 / 6, 1, 1), [1, 1, 0]);
  near(hsvToRgb(1.5, 1, 0.5), [0, 0.5, 0.5], 1e-9); // wraps
  near(hsvToRgb(-0.5, 1, 0.5), [0, 0.5, 0.5], 1e-9);
  near(hsvToRgb(0.3, 0, 0.42), [0.42, 0.42, 0.42]);
});

test("rgbToHsv <-> hsvToRgb round-trips floats with no 8-bit grid", () => {
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 500; i++) {
    const c: [number, number, number] = [rnd(), rnd(), rnd()];
    const [h, s, v] = rgbToHsv(...c);
    near(hsvToRgb(h, s, v), c, 1e-9);
  }
  // A value between two bytes survives exactly (well under 1/255).
  near(hsvToRgb(...rgbToHsv(0.123456, 0.5, 0.9)), [0.123456, 0.5, 0.9], 1e-12);
});

test("rgbToHsv keeps the previous hue on greys and saturation on black", () => {
  assert.deepEqual(rgbToHsv(0.5, 0.5, 0.5, { h: 0.7, s: 0.8 }), [0.7, 0, 0.5]);
  assert.deepEqual(rgbToHsv(0, 0, 0, { h: 0.7, s: 0.8 }), [0.7, 0.8, 0]);
  assert.deepEqual(rgbToHsv(0, 0, 0), [0, 0, 0]);
});

test("hex: parse #rgb/#rrggbb/#rrggbbaa, format with optional alpha", () => {
  near(parseHex("#ff8000")!.rgb, [1, 128 / 255, 0]);
  near(parseHex("  F80 ")!.rgb, [1, 136 / 255, 0]);
  assert.equal(parseHex("#ff800080")!.alpha, 128 / 255);
  assert.equal(parseHex("#ff8000")!.alpha, undefined);
  assert.equal(parseHex("#ff80")!.alpha, 0, "#rgba");
  assert.equal(parseHex("nope"), null);
  assert.equal(parseHex("#12345"), null);
  assert.equal(toHex([1, 0.5, 0]), "#ff8000");
  assert.equal(toHex([1, 0.5, 0], 0.25), "#ff800040");
});

test("LED display: value^gamma shown through sRGB, darker mids than value*255", () => {
  for (const x of [0, 0.001, 0.02, 0.2, 0.5, 0.9, 1]) assert.ok(Math.abs(srgbDecode(srgbEncode(x)) - x) < 1e-9);
  const led = ledDisplay(); // firmware default WS2812B, gamma 2.8
  assert.equal(led(0, 0), 0);
  assert.equal(led(1, 1), 255);
  // Mid grey on the strip emits 0.5^2.8 ≈ 14 % light: a screen shows that as ~104, not 128.
  assert.equal(led(0, 0.5), Math.round(srgbEncode(Math.pow(0.5, 2.8)) * 255));
  assert.ok(led(0, 0.5) < rawDisplay(0, 0.5));
  // A linear profile is a pure sRGB encode (no white balance tint either).
  const lin = ledDisplay({ gamma: [1, 1, 1], luminance: [625, 1250, 300] });
  assert.equal(lin(1, 0.2), Math.round(srgbEncode(0.2) * 255));
  assert.equal(lin(0, 1), 255);
  assert.equal(lin(2, 1), 255, "white balance never tints the swatch");
});

test("hueAt: red at the top, clockwise", () => {
  assert.equal(hueAt(0, -1), 0);
  assert.ok(Math.abs(hueAt(1, 0) - 0.25) < 1e-12);
  assert.ok(Math.abs(hueAt(0, 1) - 0.5) < 1e-12);
  assert.ok(Math.abs(hueAt(-1, 0) - 0.75) < 1e-12);
});

// -- picker widget --------------------------------------------------------------

function mountPicker(value: number[], alpha = false): {
  canvas: FakeElement;
  root: FakeElement;
  inputs: number[][];
  commits: number[][];
  picker: ReturnType<typeof HsvPicker>;
} {
  const inputs: number[][] = [];
  const commits: number[][] = [];
  const picker = HsvPicker({
    value,
    alpha,
    display: rawDisplay,
    size: 200,
    onInput: (v) => inputs.push(v),
    onCommit: (v) => commits.push(v),
  });
  const root = asFake(picker.el);
  document.body.appendChild(picker.el);
  const canvas = root.querySelector("canvas")!;
  canvas.rect = { x: 0, y: 0, width: 200, height: 200 };
  return { canvas, root, inputs, commits, picker };
}

test("picker: dragging the SV square streams float colours, commit once on release", () => {
  const { canvas, root, inputs, commits } = mountPicker([1, 0, 0]);
  try {
    const { c, half } = wheelGeometry(200);
    // s = 0.3, v = 0.7 at hue 0 (red).
    const at = (s: number, v: number) => ({ clientX: c - half + s * 2 * half, clientY: c - half + (1 - v) * 2 * half, pointerId: 1 });
    fire(canvas, "pointerdown", at(0.3, 0.7));
    fire(canvas, "pointermove", at(0.3337, 0.7123));
    assert.equal(commits.length, 0, "no commit mid-drag");
    assert.ok(inputs.length >= 2, "every move streams");
    near(inputs.at(-1)!, hsvToRgb(0, 0.3337, 0.7123), 1e-9);
    const g = inputs.at(-1)![1]!;
    assert.ok(Math.abs(g * 255 - Math.round(g * 255)) > 1e-3, "not on the 8-bit grid");
    fire(canvas, "pointerup", at(0.3337, 0.7123));
    assert.equal(commits.length, 1);
    near(commits[0]!, inputs.at(-1)!);
    // The numeric fields follow.
    const nums = root.querySelectorAll("input[type=number]");
    assert.equal(nums[1]!.value, "0.3337");
    assert.equal(nums[2]!.value, "0.7123");
  } finally {
    asFake(root).remove();
  }
});

test("picker: the hue ring changes hue only, keeping S and V", () => {
  const { canvas, root, inputs } = mountPicker(hsvToRgb(0, 0.5, 0.8));
  try {
    const { c, ro, ri } = wheelGeometry(200);
    const r = (ro + ri) / 2;
    fire(canvas, "pointerdown", { clientX: c + r, clientY: c, pointerId: 1 }); // 3 o'clock = 0.25 turn
    const [h, s, v] = rgbToHsv(...(inputs.at(-1)! as [number, number, number]));
    assert.ok(Math.abs(h - 0.25) < 1e-6);
    assert.ok(Math.abs(s - 0.5) < 1e-9);
    assert.ok(Math.abs(v - 0.8) < 1e-9);
  } finally {
    root.remove();
  }
});

test("picker: set() moves it silently and keeps the hue through black", () => {
  const { root, inputs, picker } = mountPicker(hsvToRgb(0.6, 1, 1));
  try {
    picker.set([0, 0, 0]);
    assert.equal(inputs.length, 0, "an external move never echoes");
    const nums = root.querySelectorAll("input[type=number]");
    assert.equal(nums[0]!.value, "216", "hue kept (0.6 turn = 216°)");
    // Raising V from black brings the same hue back.
    nums[2]!.value = "0.5";
    fire(nums[2]!, "change");
    near(inputs.at(-1)!, hsvToRgb(0.6, 1, 0.5), 1e-9);
  } finally {
    root.remove();
  }
});

test("picker: an unedited field or hex keeps exact floats; a pasted hex applies", () => {
  const { root, inputs, commits } = mountPicker([0.123456, 0.5, 0.9, 0.25], true);
  try {
    const hex = root.querySelector("input.hsvp-hex-input")!;
    assert.equal(hex.value, "#1f80e640");
    fire(hex, "change"); // focus + blur with no edit
    for (const n of root.querySelectorAll("input[type=number]")) fire(n, "change");
    assert.equal(inputs.length, 0);
    hex.value = "#FF000080";
    fire(hex, "change");
    near(inputs.at(-1)!, [1, 0, 0, 128 / 255]);
    assert.equal(commits.length, 1);
    // The alpha slider streams a float.
    const alpha = root.querySelector("input[type=range]")!;
    alpha.value = "0.3333";
    fire(alpha, "input");
    near(inputs.at(-1)!, [1, 0, 0, 0.3333]);
    // Typing R keeps hue/saturation coherent.
    const nums = root.querySelectorAll("input[type=number]");
    nums[3]!.value = "0.25";
    fire(nums[3]!, "change");
    near(inputs.at(-1)!, [0.25, 0, 0, 0.3333]);
  } finally {
    root.remove();
  }
});

// -- swatch: Sheet on phones, popover on desktop ------------------------------

test("swatch: a phone opens a Sheet, desktop an inline popover that closes outside", () => {
  dom.window.mediaMatcher = (q) => q.includes("max-width: 640px");
  const inputs: number[][] = [];
  const sw = ColorSwatch({ value: [0, 0, 1], title: "tint", display: rawDisplay, onInput: (v) => inputs.push(v) });
  document.body.appendChild(sw.el);
  try {
    sw.el.click();
    const body = asFake(document.body);
    assert.ok(body.querySelector(".k-sheet"), "phone: bottom sheet");
    assert.ok(body.querySelector(".k-sheet .hsvp-canvas"));
    // The open picker follows an external move.
    sw.set([0, 1, 0]);
    assert.equal(asFake(body.querySelector(".k-sheet input.hsvp-hex-input")).value, "#00ff00");
    sw.close();

    dom.window.mediaMatcher = () => false;
    sw.el.click();
    const pop = body.querySelector(".k-cpop");
    assert.ok(pop, "desktop: popover");
    assert.equal(asFake(body.querySelector(".k-cswatch-fill")).style.background, "rgb(0 255 0)");
    fire(pop!.querySelector("canvas")!, "pointerdown", { clientX: 1, clientY: 1 }); // inside: stays
    assert.ok(body.querySelector(".k-cpop"));
    fire(document.body, "pointerdown", {});
    assert.equal(body.querySelector(".k-cpop"), null, "outside pointerdown closes it");
  } finally {
    sw.close();
    asFake(sw.el).remove();
    for (const n of asFake(document.body).querySelectorAll(".k-sheet, .k-sheet-scrim")) n.remove();
    dom.window.mediaMatcher = () => false;
  }
});

// -- uniform panel wiring ---------------------------------------------------------

const TINT: FxUniform = { name: "tint", slot: 2, width: 4, ui: { kind: "color" }, default: [0.123456, 0.5, 0.9, 0.25] };
const BASE: FxUniform = { name: "base", slot: 0, width: 3, ui: { kind: "color" }, default: [1, 0, 0] };

test("panel: colour uniforms register setters (MIDI/agent move them live) and stream floats", () => {
  dom.window.mediaMatcher = () => false;
  const host = asFake(document.createElement("div"));
  document.body.appendChild(host as unknown as HTMLElement);
  const changes: [number, number[]][] = [];
  const panel = new UniformPanel(host as unknown as HTMLElement, (slot, value) => changes.push([slot, value]));
  panel.setManifest([BASE, TINT]);
  try {
    panel.hydrate([{ slot: 2, value: [0.123456, 0.5, 0.9, 0.25] }]);
    assert.equal(changes.length, 0, "hydrate sends nothing");
    assert.deepEqual(panel.values()[1]!.value, [0.123456, 0.5, 0.9, 0.25], "no 8-bit round-trip");
    const vals = host.querySelectorAll(".upanel-hex");
    assert.equal(vals[1]!.textContent, "#1f80e640");

    // An external driver (MIDI) moves the swatch and fans out once.
    panel.applyExternal(0, [0, 0.25, 1]);
    assert.deepEqual(changes.at(-1), [0, [0, 0.25, 1]]);
    assert.equal(vals[0]!.textContent, "#0040ff");
    const fills = host.querySelectorAll(".k-cswatch-fill");
    assert.notEqual(fills[0]!.style.background, "", "swatch repainted");
    // The agent's setLive moves it without firing.
    const n = changes.length;
    assert.equal(panel.setLive(0, [0.5, 0.5, 0.5]), true);
    assert.equal(changes.length, n);
    assert.equal(vals[0]!.textContent, "#808080");

    // Open the vec4 picker and drag: every move streams a full-width float value.
    host.querySelectorAll(".k-cswatch")[1]!.click();
    const pop = asFake(document.body).querySelector(".k-cpop")!;
    const canvas = pop.querySelector("canvas")!;
    canvas.rect = { x: 0, y: 0, width: 240, height: 240 };
    const { c } = wheelGeometry(240);
    fire(canvas, "pointerdown", { clientX: c + 3.3, clientY: c - 7.7, pointerId: 1 });
    const [slot, v] = changes.at(-1)!;
    assert.equal(slot, 2);
    assert.equal(v.length, 4);
    assert.equal(v[3], 0.25, "alpha kept");
    assert.ok(v.slice(0, 3).some((x) => Math.abs(x * 255 - Math.round(x * 255)) > 1e-3), "float, not 8-bit");
    fire(canvas, "pointerup", { pointerId: 1 });
    fire(document.body, "pointerdown", {});
  } finally {
    host.remove();
  }
});
