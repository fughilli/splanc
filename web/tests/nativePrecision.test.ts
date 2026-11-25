/**
 * D-541 native-precision uniforms: a float slider is continuous (step 0 →
 * `step="any"`, typed values only clamp) and an int keeps its whole-number
 * grid. Colour precision is covered by hsvPicker.test.ts.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { asFake, fire, installFakeDom, typeInto, type FakeElement } from "./fakeDom";
import { UniformPanel } from "../src/effects/editor/uniform-panel";
import { snapToStep, stepAttr } from "../src/effects/uniformValues";
import type { FxUniform } from "../src/fx/preview";

installFakeDom();

const SPEED: FxUniform = { name: "speed", slot: 0, width: 1, ui: { kind: "slider", min: 0, max: 5, step: 0 }, default: [1] };
const COUNT: FxUniform = { name: "count", slot: 1, width: 1, ui: { kind: "slider", min: 0, max: 10, step: 1 }, default: [3] };

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
