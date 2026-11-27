/**
 * D-541 PR 10: the mat3 / mat4 gizmo. TRS <-> matrix compose / decompose for
 * the three matrix meanings (mat4, 3D-linear mat3, `: transform2d` mat3), the
 * delta edit that keeps shear, the handle layout + hit test, the widget's
 * drags (stream floats, one commit on release, orbit changes nothing), the
 * swatch's full Sheet vs popover, and the uniform panel's gizmo button with
 * the grid behind "Advanced", registered in `setters` for MIDI / the agent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { asFake, fire, installFakeDom, typeInto, type FakeElement } from "./fakeDom";
import {
  applyDelta,
  axisAngle,
  compose,
  decompose,
  eulerToRot,
  fromMat4,
  identity,
  matKindOf,
  pivotOf,
  rotToEuler,
  toMat4,
  translation,
  trsSummary,
  type MatKind,
} from "../src/geom/trs";
import {
  frameRadius,
  hitHandle,
  layoutScene,
  MatGizmo,
  MatSwatch,
  matProjector,
  modesFor,
} from "../src/ui/kit/matGizmo";
import { UniformPanel } from "../src/effects/editor/uniform-panel";
import type { FxUniform } from "../src/fx/preview";

const dom = installFakeDom();

const near = (a: readonly number[], b: readonly number[], eps = 1e-6): void => {
  assert.equal(a.length, b.length, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  a.forEach((x, i) => assert.ok(Math.abs(x - b[i]!) <= eps, `${i}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`));
};

function canvasOf(el: unknown, size = 300): FakeElement {
  const c = asFake(el).querySelector("canvas")!;
  c.rect = { x: 0, y: 0, width: size, height: size };
  return c;
}

// -- geometry -------------------------------------------------------------------

test("matrix kinds: mat4, 3D-linear mat3, transform2d mat3 (D-556)", () => {
  assert.equal(matKindOf(16, "matrix"), "mat4");
  assert.equal(matKindOf(9, "matrix"), "mat3");
  assert.equal(matKindOf(9, "transform2d"), "affine2d");
  assert.deepEqual(modesFor("mat3"), ["rotate", "scale"], "a linear mat3 has no Move");
  assert.deepEqual(modesFor("affine2d"), ["move", "rotate", "scale"]);
});

test("Euler <-> rotation round-trips, including gimbal lock", () => {
  for (const r of [
    [0, 0, 0],
    [10, -20, 30],
    [-170, 45, 120],
    [33, -89.5, 2],
  ]) {
    near(rotToEuler(eulerToRot(r)), r, 1e-9);
  }
  // At b = 90° only a - c is defined: the matrix still round-trips.
  const R = eulerToRot([20, 90, 15]);
  near(eulerToRot(rotToEuler(R)), R, 1e-9);
});

test("TRS compose / decompose round-trip for each matrix kind", () => {
  const trs = { t: [0.5, -1.25, 2] as [number, number, number], r: [10, 20, 30] as [number, number, number], s: [1.5, 1.5, 1.5] as [number, number, number] };
  const m4 = compose("mat4", trs);
  const d4 = decompose("mat4", m4);
  near(d4.t, trs.t, 1e-9);
  near(d4.r, trs.r, 1e-9);
  near(d4.s, trs.s, 1e-9);
  assert.equal(d4.exact, true);
  // Column-major, translation in column 3.
  near(m4.slice(12, 16), [0.5, -1.25, 2, 1]);

  const m3 = compose("mat3", trs);
  assert.equal(m3.length, 9);
  const d3 = decompose("mat3", m3);
  near(d3.t, [0, 0, 0], 0);
  near(d3.r, trs.r, 1e-9);

  // affine2d: z rotation, xy translation; translation in column 2.
  const a = compose("affine2d", { t: [3, -2, 0], r: [0, 0, 90], s: [2, 2, 1] });
  near(a, [0, 2, 0, -2, 0, 0, 3, -2, 1], 1e-12);
  const da = decompose("affine2d", a);
  near([da.t[0], da.t[1], da.r[2], da.s[0]], [3, -2, 90, 2], 1e-9);
  assert.equal(trsSummary("affine2d", a), "3,-2 · 90° ×2");
  assert.equal(trsSummary("mat3", identity("mat3")), "0° ×1");

  // A mirror keeps its sign in one scale; shear / perspective is flagged.
  const mirror = decompose("mat4", [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.ok(mirror.s[0] < 0 && mirror.exact);
  near(compose("mat4", mirror), [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 1e-12);
  const shear = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  assert.equal(decompose("mat4", shear).exact, false);
  assert.equal(decompose("affine2d", [1, 0, 0.2, 0, 1, 0, 0, 0, 1]).exact, false, "projective row");
});

test("a delta edit keeps what TRS cannot express", () => {
  // Shear + translate: moving adds to the translation, the shear stays.
  const shear = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
  const moved = applyDelta("mat4", shear, translation([1, 0, 0]));
  near(moved, [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 2, 2, 3, 1], 1e-6);
  // affine2d: the bottom (projective) row survives a rotation.
  const a = [1, 0, 0.1, 0, 1, 0.2, 0, 0, 1];
  const r = applyDelta("affine2d", a, axisAngle([0, 0, 1], Math.PI / 2));
  near([r[2]!, r[5]!, r[8]!], [0.1, 0.2, 1], 1e-12);
  near([r[0]!, r[1]!, r[3]!, r[4]!], [0, 1, -1, 0], 1e-12);
  // mat3 (linear): only the 3×3 block of a delta applies.
  near(applyDelta("mat3", identity("mat3"), translation([5, 5, 5])), identity("mat3"));
  // toMat4 / fromMat4 round-trip each layout.
  for (const [k, m] of [
    ["mat4", compose("mat4", { t: [1, 2, 3], r: [4, 5, 6], s: [1, 2, 3] })],
    ["mat3", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ["affine2d", [1, 2, 0.25, 4, 5, 0.5, 7, 8, 1]],
  ] as [MatKind, number[]][]) {
    near(fromMat4(k, toMat4(k, m), m), m, 1e-12);
  }
  near(pivotOf("affine2d", [1, 0, 0, 0, 1, 0, 4, -2, 2]), [2, -1, 0]);
  near(pivotOf("mat3", [2, 0, 0, 0, 2, 0, 9, 9, 1]), [0, 0, 0], 0);
});

test("handle layout + hit test: centre, arrows, rings, scale ring", () => {
  const m = identity("affine2d");
  const cam = { yaw: 0, pitch: 0, radius: frameRadius("affine2d", m) };
  const mv = layoutScene({ kind: "affine2d", m, cam, mode: "move" }, 300, 300);
  assert.deepEqual(
    mv.handles.map((h) => h.id),
    ["tv", "tx", "ty"],
  );
  assert.equal(hitHandle(mv.handles, 150, 150, 12), "tv");
  const tipX = mv.handles.find((h) => h.id === "tx")!.pts[1]!;
  assert.equal(hitHandle(mv.handles, tipX.x - 3, tipX.y + 4, 12), "tx");
  assert.equal(hitHandle(mv.handles, 40, 260, 12), null);
  const rot3 = layoutScene({ kind: "mat4", m: identity("mat4"), cam: { yaw: 0.6, pitch: 0.4, radius: 1.2 }, mode: "rotate" }, 300, 300);
  assert.deepEqual(
    rot3.handles.map((h) => h.id),
    ["rx", "ry", "rz"],
  );
  const onRing = rot3.handles[1]!.pts[10]!;
  assert.equal(hitHandle(rot3.handles, onRing.x, onRing.y, 12), "ry");
  // A linear mat3 has no Move handles at all.
  assert.equal(layoutScene({ kind: "mat3", m: identity("mat3"), cam, mode: "move" }, 300, 300).handles.length, 0);
  // The 3D projector puts the origin at the centre and +y up the screen.
  const p = matProjector("mat4", { yaw: 0.6, pitch: 0.4, radius: 1.2 }, 300, 300);
  near([p([0, 0, 0]).x, p([0, 0, 0]).y], [150, 150], 1e-6);
  assert.ok(p([0, 1, 0]).y < 150);
});

// -- the widget -----------------------------------------------------------------

/** The flat view's px per world unit for a 300 px canvas. */
const flatK = (m: readonly number[]): number => 300 / (2.3 * frameRadius("affine2d", m));

test("2D move: an arrow drag streams float translation and commits once", () => {
  const inputs: number[][] = [];
  const commits: number[][] = [];
  const m = identity("affine2d");
  const g = MatGizmo({ value: m, kind: "affine2d", onInput: (v) => inputs.push(v), onCommit: (v) => commits.push(v) });
  const c = canvasOf(g.el);
  assert.equal(g.mode(), "move");
  const k = flatK(m);
  const arm = frameRadius("affine2d", m) * 0.5;
  // Grab the x arrow near its tip and pull it 0.1 world units (+ a third of a px).
  const x0 = 150 + arm * k * 0.9;
  fire(c, "pointerdown", { clientX: x0, clientY: 150, pointerId: 1 });
  fire(c, "pointermove", { clientX: x0 + 0.1 * k, clientY: 152, pointerId: 1 });
  fire(c, "pointermove", { clientX: x0 + 0.1 * k + 0.33, clientY: 152, pointerId: 1 });
  assert.equal(commits.length, 0, "no commit mid-gesture");
  fire(c, "pointerup", { pointerId: 1 });
  assert.equal(inputs.length, 2);
  near([inputs[0]![6]!, inputs[0]![7]!], [0.1, 0], 1e-5);
  assert.ok(Math.abs(inputs[1]![6]! - (0.1 + 0.33 / k)) < 1e-5, "float, not a grid");
  assert.equal(commits.length, 1);
  near(commits[0]!, inputs[1]!);
  // set() moves it without firing.
  g.set(compose("affine2d", { t: [0.25, 0, 0], r: [0, 0, 0], s: [1, 1, 1] }));
  assert.equal(inputs.length, 2);
  near(g.value().slice(6, 8), [0.25, 0]);
});

test("2D rotate and scale drags turn / grow about the pivot", () => {
  const m = identity("affine2d");
  const k = flatK(m);
  const arm = frameRadius("affine2d", m) * 0.5;
  const inputs: number[][] = [];
  const g = MatGizmo({ value: m, kind: "affine2d", onInput: (v) => inputs.push(v) });
  const c = canvasOf(g.el);
  const btns = asFake(g.el).querySelectorAll(".matg-mode");
  assert.deepEqual(
    btns.map((b) => b.textContent),
    ["Move", "Rotate", "Scale"],
  );
  btns[1]!.click();
  assert.equal(g.mode(), "rotate");
  assert.equal(btns[1]!.getAttribute("aria-pressed"), "true");
  const r = arm * 0.85 * k;
  // A quarter turn counter-clockwise on screen = +90° about z.
  fire(c, "pointerdown", { clientX: 150 + r, clientY: 150, pointerId: 2 });
  fire(c, "pointermove", { clientX: 150 + r * Math.SQRT1_2, clientY: 150 - r * Math.SQRT1_2, pointerId: 2 });
  fire(c, "pointermove", { clientX: 150, clientY: 150 - r, pointerId: 2 });
  fire(c, "pointerup", { pointerId: 2 });
  near(inputs.at(-1)!.slice(0, 2), [0, 1], 1e-5);
  near(decompose("affine2d", g.value()).r.slice(2), [90], 1e-3);

  btns[2]!.click();
  const rs = arm * 1.2 * k;
  fire(c, "pointerdown", { clientX: 150, clientY: 150 + rs, pointerId: 3 });
  fire(c, "pointermove", { clientX: 150, clientY: 150 + 2 * rs, pointerId: 3 });
  fire(c, "pointerup", { pointerId: 3 });
  near([Math.abs(decompose("affine2d", g.value()).s[0])], [2], 1e-5);
  near(g.value().slice(6, 8), [0, 0], 1e-9);
});

test("3D: an empty-canvas drag orbits without changing the value; fields compose", () => {
  const inputs: number[][] = [];
  const commits: number[][] = [];
  const g = MatGizmo({ value: identity("mat4"), kind: "mat4", onInput: (v) => inputs.push(v), onCommit: (v) => commits.push(v) });
  const c = canvasOf(g.el);
  fire(c, "pointerdown", { clientX: 10, clientY: 290, pointerId: 4 });
  fire(c, "pointermove", { clientX: 60, clientY: 270, pointerId: 4 });
  fire(c, "pointerup", { pointerId: 4 });
  assert.equal(inputs.length, 0);
  assert.equal(commits.length, 0);
  near(g.value(), identity("mat4"));
  asFake(g.el).querySelectorAll(".matg-mode")[1]!.click();
  // Typed fields: move z, then rot y.
  const f = asFake(g.el).querySelectorAll(".matg-field input");
  assert.equal(f.length, 7, "move xyz, rot xyz, scale");
  typeInto(f[2]!, "1.5");
  fire(f[2]!, "change");
  typeInto(f[4]!, "30");
  fire(f[4]!, "change");
  const d = decompose("mat4", g.value());
  near([d.t[2], d.r[1]], [1.5, 30], 1e-4);
  assert.equal(commits.length, 2);
  // Arrow keys nudge and commit.
  fire(c, "keydown", { key: "ArrowRight" });
  near([decompose("mat4", g.value()).r[1]], [31], 1e-3);
  assert.equal(commits.length, 3);
});

test("a linear mat3 offers Rotate / Scale only; ranges clamp the result", () => {
  const g = MatGizmo({
    value: identity("mat3"),
    kind: "mat3",
    ranges: Array.from({ length: 9 }, () => ({ min: -1.5, max: 1.5 })),
    onInput: () => {},
  });
  canvasOf(g.el);
  assert.deepEqual(
    asFake(g.el).querySelectorAll(".matg-mode").map((b) => b.textContent),
    ["Rotate", "Scale"],
  );
  assert.equal(g.mode(), "rotate");
  const f = asFake(g.el).querySelectorAll(".matg-field input");
  assert.equal(f.length, 4, "rot xyz + scale");
  typeInto(f[3]!, "3");
  fire(f[3]!, "change");
  near([g.value()[0]!, g.value()[4]!, g.value()[8]!], [1.5, 1.5, 1.5], 1e-9);
});

test("swatch: a full-height Sheet on phones, a popover on desktop", () => {
  dom.window.mediaMatcher = (q) => q.includes("max-width: 640px");
  const sw = MatSwatch({ value: identity("affine2d"), kind: "affine2d", title: "uv", onInput: () => {} });
  dom.document.body.appendChild(sw.el as unknown as FakeElement);
  sw.el.click();
  const sheet = dom.document.body.querySelector(".k-sheet");
  assert.ok(sheet, "sheet on a phone");
  assert.ok(sheet.classList.contains("k-sheet--full"), "its own full-height step");
  assert.ok(dom.document.body.querySelector(".matg-sheet .matg-canvas"));
  assert.ok(sw.gizmo());
  sw.close();
  dom.window.mediaMatcher = () => false;
  const sw2 = MatSwatch({ value: identity("mat4"), kind: "mat4", title: "pose", onInput: () => {} });
  dom.document.body.appendChild(sw2.el as unknown as FakeElement);
  sw2.el.click();
  assert.ok(dom.document.body.querySelector(".k-mpop .matg-canvas"), "popover on desktop");
  const moved = compose("mat4", { t: [1, 0, 0], r: [0, 0, 0], s: [1, 1, 1] });
  sw2.set(moved);
  near(sw2.gizmo()!.value(), moved, 1e-9);
  assert.equal(asFake(sw2.el).querySelector(".k-mswatch-text")!.textContent, "1,0,0 · 0° ×1");
  sw2.close();
  assert.equal(dom.document.body.querySelector(".k-mpop"), null);
});

// -- uniform panel ----------------------------------------------------------------

const MAT_UNIFORMS: FxUniform[] = [
  { name: "pose", slot: 0, width: 16, ui: { kind: "matrix", min: -10, max: 10 }, default: identity("mat4"), min: -10, max: 10 },
  { name: "uv", slot: 4, width: 9, ui: { kind: "transform2d", min: -4, max: 4 }, default: identity("affine2d"), min: -4, max: 4 },
];

test("the panel shows a gizmo button + the grid behind Advanced, streams, commits, setters", () => {
  dom.window.mediaMatcher = () => false;
  const host = dom.document.createElement("div");
  const changes: [number, number[]][] = [];
  const commits: [number, number[]][] = [];
  const panel = new UniformPanel(host as unknown as HTMLElement, (slot, v) => changes.push([slot, v]), {
    onCommit: (slot, v) => commits.push([slot, v]),
  });
  panel.setManifest(MAT_UNIFORMS);
  const swatches = host.querySelectorAll(".k-mswatch");
  assert.equal(swatches.length, 2);
  const adv = host.querySelectorAll("details.upanel-adv");
  assert.equal(adv.length, 2);
  assert.equal(adv[0]!.querySelectorAll(".upanel-mat input").length, 16, "the 4×4 grid, behind the disclosure");
  assert.equal(adv[1]!.querySelectorAll(".upanel-mat input").length, 9);
  assert.equal(adv[0]!.hasAttribute("open"), false, "closed by default");
  const vals = host.querySelectorAll(".upanel-val");

  // MIDI / the agent move the button, the value and the grid (setters).
  const turned = compose("affine2d", { t: [1, 0.5, 0], r: [0, 0, 45], s: [1, 1, 1] });
  panel.applyExternal(4, turned);
  assert.deepEqual(changes.at(-1), [4, turned]);
  assert.equal(vals[1]!.textContent, "45°");
  assert.equal(asFake(swatches[1]).querySelector(".k-mswatch-text")!.textContent, "1,0.5 · 45° ×1");
  // The grid is shown row by row: [0] is m[0] (cos 45°), [2] is row 0 col 2 (tx).
  assert.equal(adv[1]!.querySelectorAll(".upanel-mat input")[0]!.value, "0.7071");
  assert.equal(adv[1]!.querySelectorAll(".upanel-mat input")[2]!.value, "1");
  const n0 = changes.length;
  assert.equal(panel.setLive(0, compose("mat4", { t: [0, 0, 0], r: [0, 0, 0], s: [2, 2, 2] })), true);
  assert.equal(changes.length, n0, "setLive does not fire onChange");
  assert.equal(vals[0]!.textContent, "×2");

  // A typed grid entry commits and updates the button.
  const cells = adv[0]!.querySelectorAll(".upanel-mat input");
  typeInto(cells[3]!, "3"); // row 0, column 3: translation x
  fire(cells[3]!, "change");
  assert.deepEqual(commits.at(-1)?.[0], 0);
  assert.equal(commits.at(-1)?.[1][12], 3);
  assert.match(asFake(swatches[0]).querySelector(".k-mswatch-text")!.textContent ?? "", /^3,0,0 /);

  // Drag the uv gizmo (desktop popover): streams, then one commit.
  swatches[1]!.click();
  const c = dom.document.body.querySelector(".k-mpop canvas")!;
  c.rect = { x: 0, y: 0, width: 300, height: 300 };
  const before = commits.length;
  const m = panel.values().find((v) => v.slot === 4)!.value;
  const cam = { yaw: 0.6, pitch: 0.42, radius: frameRadius("affine2d", m) };
  const lay = layoutScene({ kind: "affine2d", m, cam, mode: "move" }, 300, 300);
  const ctr = lay.pivot;
  const n1 = changes.length;
  fire(c, "pointerdown", { clientX: ctr.x, clientY: ctr.y, pointerId: 1 });
  fire(c, "pointermove", { clientX: ctr.x + 20, clientY: ctr.y, pointerId: 1 });
  fire(c, "pointermove", { clientX: ctr.x + 40, clientY: ctr.y - 10, pointerId: 1 });
  fire(c, "pointerup", { pointerId: 1 });
  assert.equal(changes.length, n1 + 2);
  assert.equal(commits.length, before + 1);
  const final = commits.at(-1)!;
  assert.equal(final[0], 4);
  assert.ok(final[1][6]! > 1 && final[1][7]! > 0.5, `moved right and up: ${final[1]}`);
  near(final[1].slice(0, 2), turned.slice(0, 2), 1e-6);
  // The grid followed the drag.
  assert.equal(adv[1]!.querySelectorAll(".upanel-mat input")[2]!.value, String(Math.round(final[1][6]! * 1e4) / 1e4));
});

test("3D: an axis arrow moves along that axis only; a ring turns about its axis, right-handed", () => {
  const inputs: number[][] = [];
  const m = identity("mat4");
  const g = MatGizmo({ value: m, kind: "mat4", onInput: (v) => inputs.push(v) });
  const c = canvasOf(g.el);
  const cam = { yaw: 0.6, pitch: 0.42, radius: frameRadius("mat4", m) };
  const mv = layoutScene({ kind: "mat4", m, cam, mode: "move" }, 300, 300);
  const tz = mv.handles.find((h) => h.id === "tz")!;
  const tip = tz.pts[1]!;
  fire(c, "pointerdown", { clientX: tip.x, clientY: tip.y, pointerId: 5 });
  // Pull it further out along its own screen direction.
  fire(c, "pointermove", { clientX: tip.x + (tip.x - 150) * 0.5, clientY: tip.y + (tip.y - 150) * 0.5, pointerId: 5 });
  fire(c, "pointerup", { pointerId: 5 });
  const t = inputs.at(-1)!.slice(12, 15);
  assert.ok(t[2]! > 0.05, `z grew: ${t}`);
  near([t[0]!, t[1]!], [0, 0], 1e-6);

  g.set(identity("mat4"));
  g.setMode("rotate");
  const rot = layoutScene({ kind: "mat4", m: identity("mat4"), cam, mode: "rotate" }, 300, 300);
  const ry = rot.handles.find((h) => h.id === "ry")!;
  // Along the ring's own direction of increasing angle = a positive turn about +y.
  const a = ry.pts[20]!, b = ry.pts[24]!;
  fire(c, "pointerdown", { clientX: a.x, clientY: a.y, pointerId: 6 });
  fire(c, "pointermove", { clientX: b.x, clientY: b.y, pointerId: 6 });
  fire(c, "pointerup", { pointerId: 6 });
  const d = decompose("mat4", g.value());
  assert.ok(d.r[1] > 5, `turned about +y: ${d.r}`);
  near([d.r[0], d.r[2]], [0, 0], 1e-3);
  near(d.t, [0, 0, 0], 1e-6);
});
