/**
 * D-541 native-precision uniforms: a float slider is continuous (step 0 →
 * `step="any"`, typed values only clamp), an int keeps its whole-number grid,
 * and a colour picker never round-trips an untouched channel (or alpha)
 * through its 8-bit hex.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { asFake, fire, installFakeDom, typeInto, type FakeElement } from "./fakeDom";
import { UniformPanel } from "../src/effects/editor/uniform-panel";
import { colorFromHex, colorToHex, snapToStep, stepAttr } from "../src/effects/uniformValues";
import type { FxUniform } from "../src/fx/preview";

installFakeDom();

const SPEED: FxUniform = { name: "speed", slot: 0, width: 1, ui: { kind: "slider", min: 0, max: 5, step: 0 }, default: [1] };
const COUNT: FxUniform = { name: "count", slot: 1, width: 1, ui: { kind: "slider", min: 0, max: 10, step: 1 }, default: [3] };
const TINT: FxUniform = { name: "tint", slot: 2, width: 4, ui: { kind: "color" }, default: [0.123456, 0.5, 0.9, 0.25] };

function mount(uniforms: FxUniform[]): { host: FakeElement; panel: UniformPanel; changes: [number, number[]][] } {
  const host = asFake(document.createElement("div"));
  document.body.appendChild(host as unknown as HTMLElement);
  const changes: [number, number[]][] = [];
  const panel = new UniformPanel(host as unknown as HTMLElement, (slot, value) => changes.push([slot, value]));
  panel.setManifest(uniforms);
  return { host, panel, changes };
}

test("stepAttr / snapToStep: step 0 is continuous, a grid still snaps", () => {
  assert.equal(stepAttr(0), "any");
  assert.equal(stepAttr(Number.NaN), "any");
  assert.equal(stepAttr(1), "1");
  assert.equal(snapToStep(1.23456, 0, 5, 0), 1.23456);
  assert.equal(snapToStep(9, 0, 5, 0), 5);
  assert.equal(snapToStep(4.4, 0, 10, 1), 4);
  assert.equal(snapToStep(-3, 0, 10, 1), 0);
});

test("colorFromHex keeps every channel the user did not move at full precision", () => {
  const prev = [0.123456, 0.5, 0.9, 0.25];
  const hex = colorToHex(prev);
  assert.equal(hex, "#1f80e6");
  // Unchanged pick (e.g. the picker opened and closed): identical floats + alpha.
  assert.deepEqual(colorFromHex(hex, prev, 4), prev);
  // Only green moved: red/blue/alpha keep their exact floats.
  assert.deepEqual(colorFromHex("#1fffe6", prev, 4), [0.123456, 1, 0.9, 0.25]);
  // A vec3 stays 3 wide; a missing alpha defaults opaque.
  assert.deepEqual(colorFromHex("#000000", [0.001, 0, 0], 3), [0.001, 0, 0]);
  assert.deepEqual(colorFromHex("#ff0000", [], 4), [1, 0, 0, 1]);
});

test("panel: a float slider is continuous and keeps a typed value exactly", () => {
  const { host, changes } = mount([SPEED, COUNT]);
  try {
    const ranges = host.querySelectorAll("input[type=range]");
    const nums = host.querySelectorAll("input.upanel-num");
    assert.equal(ranges[0]!.step, "any", "float: no 101-step grid");
    assert.equal(nums[0]!.step, "any");
    assert.equal(ranges[1]!.step, "1", "int: whole numbers");
    typeInto(ranges[0]!, "1.2345678");
    assert.deepEqual(changes.at(-1), [0, [1.2345678]]);
    nums[0]!.value = "2.71828";
    fire(nums[0]!, "change");
    assert.deepEqual(changes.at(-1), [0, [2.71828]], "typed value is clamped, not snapped");
    nums[1]!.value = "4.4";
    fire(nums[1]!, "change");
    assert.deepEqual(changes.at(-1), [1, [4]], "an int still snaps to its step");
  } finally {
    host.remove();
  }
});

test("panel: an unedited number field commits the exact live value, not its label", () => {
  const { host, panel, changes } = mount([SPEED]);
  try {
    panel.hydrate([{ slot: 0, value: [1.23456789] }]);
    const num = host.querySelectorAll("input.upanel-num")[0]!;
    assert.equal(num.value, "1.2346");
    fire(num, "change");
    assert.deepEqual(changes.at(-1), [0, [1.23456789]]);
  } finally {
    host.remove();
  }
});

test("panel: hydrating and picking a colour do not quantise untouched channels", () => {
  const { host, panel, changes } = mount([TINT]);
  try {
    panel.hydrate([{ slot: 2, value: [0.123456, 0.5, 0.9, 0.25] }]);
    assert.equal(changes.length, 0, "hydrate sends nothing");
    assert.deepEqual(panel.values()[0]!.value, [0.123456, 0.5, 0.9, 0.25]);
    const color = host.querySelectorAll("input[type=color]")[0]!;
    typeInto(color, "#ff80e6"); // only red moved
    assert.deepEqual(changes.at(-1), [2, [1, 0.5, 0.9, 0.25]]);
  } finally {
    host.remove();
  }
});
