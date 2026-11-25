/**
 * D-541 PR 4: vector / direction pickers. The pad / sphere geometry, the
 * picker widget (pointer drags stream float values and commit once on
 * release; set() moves it without firing), the swatch's Sheet vs popover, the
 * uniform panel registering them in `setters` (so MIDI / the agent move them
 * live), and the .fxb format check that keeps format-2 effects off old firmware.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { asFake, fire, installFakeDom, typeInto, type FakeElement } from "./fakeDom";
import {
  aimAt,
  azEl,
  fromAzEl,
  fromView,
  glyphAngle,
  normalize,
  padToValue,
  polar,
  snapTo,
  toView,
  valueToPad,
  VectorPicker,
  VectorSwatch,
  vectorSummary,
} from "../src/ui/kit/vectorPicker";
import { UniformPanel } from "../src/effects/editor/uniform-panel";
import type { FxUniform } from "../src/fx/preview";
import { fxbFormatOf, fxbFormatProblem } from "../src/net/fxbFormat";

const dom = installFakeDom();

const near = (a: readonly number[], b: readonly number[], eps = 1e-6): void => {
  assert.equal(a.length, b.length, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]!) <= eps, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`));
};

function canvasOf(el: HTMLElement, size = 200): FakeElement {
  const c = asFake(el).querySelector("canvas")!;
  c.rect = { x: 0, y: 0, width: size, height: size };
  return c;
}

// -- geometry -------------------------------------------------------------------

test("pad <-> value maps the declared ranges, y up", () => {
  const rx = { min: -2, max: 2 };
  const ry = { min: 0, max: 10 };
  near(padToValue(0, 0, rx, ry), [-2, 10]);
  near(padToValue(1, 1, rx, ry), [2, 0]);
  near(padToValue(0.5, 0.5, rx, ry), [0, 5]);
  near(padToValue(-1, 2, rx, ry), [-2, 0], 0); // clamped to the pad
  for (const [x, y] of [
    [-1.3, 7.25],
    [0.001, 0.5],
  ] as const) {
    const [fx, fy] = valueToPad(x, y, rx, ry);
    near(padToValue(fx, fy, rx, ry), [x, y], 1e-12);
  }
  assert.equal(snapTo(0.26, { min: 0, max: 1 }, 0.25), 0.25);
  assert.equal(snapTo(0.123456, { min: 0, max: 1 }, 0), 0.123456, "continuous: no grid");
});

test("view rotation round-trips and aiming stays on the front hemisphere", () => {
  for (const [yaw, pitch] of [
    [0, 0],
    [-0.6, 0.35],
    [2.1, -1.2],
  ] as const) {
    const p = [0.3, -0.5, 0.81];
    near(fromView(toView(p, yaw, pitch), yaw, pitch), p, 1e-12);
    const d = aimAt(0.2, 0.4, yaw, pitch);
    near([Math.hypot(...d)], [1], 1e-12);
    const v = toView(d, yaw, pitch);
    near([v[0], v[1]], [0.2, 0.4], 1e-12);
    assert.ok(v[2] >= 0, "front");
    // Outside the disk: slides to the rim (view z = 0).
    near([toView(aimAt(3, 0, yaw, pitch), yaw, pitch)[2]], [0], 1e-9);
  }
  near(aimAt(0, 0, 0, 0), [0, 0, 1], 1e-12); // the centre faces the viewer (+z)
});

test("azimuth / elevation and polar readouts", () => {
  near(fromAzEl(90, 0), [1, 0, 0], 1e-12);
  near(fromAzEl(0, 90), [0, 1, 0], 1e-12);
  const a = azEl([0.5, 0.5, -0.7071]);
  const back = azEl(fromAzEl(a.az, a.el));
  near([back.az, back.el], [a.az, a.el], 1e-9);
  near([polar(0, 2).deg, polar(0, 2).len], [90, 2]);
  near(normalize([0, 0], [0, 1]), [0, 1]);
  assert.equal(vectorSummary([0, 1], 2, "direction"), "90°");
  assert.equal(vectorSummary([1, 1], 2, "vector"), "45° · 1.41");
  assert.equal(vectorSummary([0, 0, 1], 3, "direction"), "az 0° el 0°");
  assert.equal(vectorSummary([0.5, -0.25, 2], 3, "vector"), "len 2.08");
  assert.equal(glyphAngle([0, 0]), null);
  near([glyphAngle([0, 1])!], [-Math.PI / 2]); // up on screen
});

// -- the picker -----------------------------------------------------------------

test("2D vector pad: a drag streams float values and commits once on release", () => {
  const inputs: number[][] = [];
  const commits: number[][] = [];
  const p = VectorPicker({
    value: [0, 0],
    dims: 2,
    mode: "vector",
    ranges: [
      { min: -1, max: 1 },
      { min: -1, max: 1 },
    ],
    onInput: (v) => inputs.push(v),
    onCommit: (v) => commits.push(v),
  });
  const c = canvasOf(p.el);
  // The pad sits inside a 6% margin: (12+0.75*176, 12+0.25*176) = (144, 56).
  fire(c, "pointerdown", { clientX: 144, clientY: 56, pointerId: 1 });
  fire(c, "pointermove", { clientX: 100, clientY: 100, pointerId: 1 });
  fire(c, "pointermove", { clientX: 100.37, clientY: 99.1, pointerId: 1 });
  assert.equal(commits.length, 0, "no commit mid-gesture");
  fire(c, "pointerup", { pointerId: 1 });
  assert.equal(inputs.length, 3);
  near(inputs[0]!, [0.5, 0.5], 1e-9);
  near(inputs[1]!, [0, 0], 1e-9);
  // Float, not a grid: a third of a pixel moves the value.
  assert.ok(Math.abs(inputs[2]![0]! - 0.37 / 88) < 1e-9, String(inputs[2]));
  assert.equal(commits.length, 1);
  near(commits[0]!, inputs[2]!);
  // set() moves the picker without firing.
  p.set([0.25, -0.75]);
  near(p.value(), [0.25, -0.75]);
  assert.equal(inputs.length, 3);
});

test("3D vector: pad for x/y plus a z slider; typed fields clamp to the range", () => {
  const inputs: number[][] = [];
  const commits: number[][] = [];
  const p = VectorPicker({
    value: [0, 0, 1],
    dims: 3,
    mode: "vector",
    ranges: [
      { min: -1, max: 1 },
      { min: -1, max: 1 },
      { min: 0, max: 2 },
    ],
    onInput: (v) => inputs.push(v),
    onCommit: (v) => commits.push(v),
  });
  const z = asFake(p.el).querySelector(".vecp-z input")!;
  assert.equal(z.getAttribute("step") ?? (z as unknown as { step: string }).step, "any");
  typeInto(z, "1.625", true);
  near(inputs.at(-1)!, [0, 0, 1.625]);
  assert.equal(commits.length, 1, "slider release commits");
  const fields = asFake(p.el).querySelectorAll(".vecp-field input");
  assert.equal(fields.length, 3);
  typeInto(fields[0]!, "7");
  fire(fields[0]!, "change");
  near(p.value(), [1, 0, 1.625], 1e-12);
});

test("2D direction dial keeps unit length; 3D sphere aims and orbits", () => {
  const inputs: number[][] = [];
  const d2 = VectorPicker({ value: [3, 4], dims: 2, mode: "direction", onInput: (v) => inputs.push(v) });
  near(d2.value(), [0.6, 0.8], 1e-12); // normalised on the way in
  const c2 = canvasOf(d2.el);
  fire(c2, "pointerdown", { clientX: 190, clientY: 100, pointerId: 1 });
  near(inputs.at(-1)!, [1, 0], 1e-12);
  fire(c2, "pointermove", { clientX: 100, clientY: 20, pointerId: 1 });
  near(inputs.at(-1)!, [0, 1], 1e-12);
  fire(c2, "pointerup", { pointerId: 1 });

  const commits: number[][] = [];
  const d3 = VectorPicker({
    value: [0, 1, 0],
    dims: 3,
    mode: "direction",
    onInput: (v) => inputs.push(v),
    onCommit: (v) => commits.push(v),
  });
  const c3 = canvasOf(d3.el);
  const n0 = inputs.length;
  fire(c3, "pointerdown", { clientX: 130, clientY: 80, pointerId: 2 });
  fire(c3, "pointerup", { pointerId: 2 });
  assert.equal(inputs.length, n0 + 1);
  near([Math.hypot(...inputs.at(-1)!)], [1], 1e-9);
  assert.equal(commits.length, 1);
  // Orbit mode turns the view only: no value change, no commit.
  const [aim, orbit] = asFake(d3.el).querySelectorAll(".vecp-mode");
  assert.ok(aim && orbit);
  assert.equal(orbit.getAttribute("aria-pressed"), "false");
  orbit.click();
  assert.equal(orbit.getAttribute("aria-pressed"), "true");
  const before = d3.value();
  fire(c3, "pointerdown", { clientX: 100, clientY: 100, pointerId: 3 });
  fire(c3, "pointermove", { clientX: 160, clientY: 120, pointerId: 3 });
  fire(c3, "pointerup", { pointerId: 3 });
  assert.equal(inputs.length, n0 + 1);
  assert.equal(commits.length, 1);
  near(d3.value(), before);
  // Angle fields edit a direction (it can't leave the sphere).
  const f = asFake(d3.el).querySelectorAll(".vecp-field input");
  assert.equal(f.length, 2);
  typeInto(f[1]!, "90");
  fire(f[1]!, "change");
  near(d3.value(), [0, 1, 0], 1e-9);
});

test("swatch opens a Sheet on phones and a popover on desktop", () => {
  dom.window.mediaMatcher = (q) => q.includes("max-width: 640px");
  const sw = VectorSwatch({ value: [0, 1], dims: 2, mode: "direction", title: "heading", onInput: () => {} });
  dom.document.body.appendChild(sw.el as unknown as FakeElement);
  sw.el.click();
  assert.ok(dom.document.body.querySelector(".k-sheet"), "sheet on a phone");
  assert.ok(dom.document.body.querySelector(".vecp-sheet .vecp-canvas"));
  sw.close();
  dom.window.mediaMatcher = () => false;
  const sw2 = VectorSwatch({ value: [0, 0, 1], dims: 3, mode: "vector", title: "aim", onInput: () => {} });
  dom.document.body.appendChild(sw2.el as unknown as FakeElement);
  sw2.el.click();
  const pop = dom.document.body.querySelector(".k-vpop");
  assert.ok(pop, "popover on desktop");
  sw2.set([0.5, 0.5, 0.5]);
  near(sw2.value(), [0.5, 0.5, 0.5]);
  sw2.close();
  assert.equal(dom.document.body.querySelector(".k-vpop"), null);
});

// -- uniform panel ----------------------------------------------------------------

const VEC_UNIFORMS: FxUniform[] = [
  { name: "wind", slot: 0, width: 2, ui: { kind: "vector", min: -2, max: 2, step: 0 }, default: [0.5, 0], min: -2, max: 2 },
  { name: "sun", slot: 2, width: 3, ui: { kind: "direction" }, default: [0, 1, 0], min: -1, max: 1 },
];

test("the panel renders vector/direction pickers, streams, commits and registers setters", () => {
  dom.window.mediaMatcher = () => false;
  const host = dom.document.createElement("div");
  const changes: [number, number[]][] = [];
  const commits: [number, number[]][] = [];
  const panel = new UniformPanel(host as unknown as HTMLElement, (slot, v) => changes.push([slot, v]), {
    onCommit: (slot, v) => commits.push([slot, v]),
  });
  panel.setManifest(VEC_UNIFORMS);
  const swatches = host.querySelectorAll(".k-vswatch");
  assert.equal(swatches.length, 2);
  assert.equal(host.querySelectorAll("input[type=range]").length, 0, "no per-component sliders");
  const vals = host.querySelectorAll(".upanel-val");
  assert.equal(vals[0]!.textContent, "0° · 0.5");
  // MIDI / the agent move the control in place (registered in setters).
  panel.applyExternal(0, [0, 1]);
  assert.equal(vals[0]!.textContent, "90° · 1");
  assert.deepEqual(changes.at(-1), [0, [0, 1]]);
  panel.setLive(2, [1, 0, 0]);
  assert.equal(vals[1]!.textContent, "az 90° el 0°");
  // Drag the wind pad (desktop popover): streams, then one commit.
  swatches[0]!.click();
  const c = dom.document.body.querySelector(".k-vpop canvas")!;
  c.rect = { x: 0, y: 0, width: 200, height: 200 };
  const n0 = changes.length;
  fire(c, "pointerdown", { clientX: 12, clientY: 12, pointerId: 1 });
  fire(c, "pointermove", { clientX: 100, clientY: 100, pointerId: 1 });
  fire(c, "pointerup", { pointerId: 1 });
  assert.equal(changes.length, n0 + 2);
  assert.deepEqual(changes[n0], [0, [-2, 2]]);
  assert.deepEqual(commits, [[0, [0, 0]]]);
  assert.deepEqual(
    panel.values().find((v) => v.slot === 0),
    { slot: 0, value: [0, 0] },
  );
});

// -- .fxb format (D-557) ------------------------------------------------------------

test("format-2 effects are refused before upload to firmware that runs format 1", () => {
  const fxb = (v: number): Uint8Array => new Uint8Array([0x46, 0x58, 0x42, 0x31, v, 0, 0, 0]);
  assert.equal(fxbFormatOf(fxb(2)), 2);
  assert.equal(fxbFormatProblem(fxb(1), 1), null);
  assert.equal(fxbFormatProblem(fxb(2), 2), null);
  assert.match(fxbFormatProblem(fxb(2), 1) ?? "", /update the device's firmware/);
  // Firmware too old to report a format (0): left to the device to answer.
  assert.equal(fxbFormatProblem(fxb(2), 0), null);
  assert.equal(fxbFormatProblem(fxb(2), undefined), null);
});
