import { strict as assert } from "node:assert";
import { test } from "node:test";

import { computeBindings } from "../src/hardware/driverBindings";
import type { FxExport, FxUniform } from "../src/fx/preview";

function uniform(name: string, slot: number, width: number): FxUniform {
  return { name, slot, width, ui: { kind: "slider", min: 0, max: 1, step: 0.01 }, default: [] };
}
function exp(name: string, slot: number, width: number): FxExport {
  return { name, slot, width, unit: "" };
}

test("matches exports to same-named same-width uniforms", () => {
  const exports = [exp("temperature", 0, 1), exp("mag", 1, 3)];
  const uniforms = [uniform("mag", 5, 3), uniform("temperature", 2, 1), uniform("other", 8, 1)];
  const { bindings, unmatched } = computeBindings(exports, uniforms);
  assert.deepEqual(unmatched, []);
  // Order follows the exports list; slots come from each side.
  assert.deepEqual(bindings, [
    { exportSlot: 0, width: 1, uniformSlot: 2 },
    { exportSlot: 1, width: 3, uniformSlot: 5 },
  ]);
});

test("reports exports with no matching uniform", () => {
  const { bindings, unmatched } = computeBindings([exp("lux", 0, 1)], [uniform("speed", 0, 1)]);
  assert.deepEqual(bindings, []);
  assert.deepEqual(unmatched, ["lux"]);
});

test("skips a name match with a width mismatch", () => {
  // export scalar vs uniform vec3 of the same name: not bindable.
  const { bindings, unmatched } = computeBindings([exp("tilt", 0, 1)], [uniform("tilt", 4, 3)]);
  assert.deepEqual(bindings, []);
  assert.deepEqual(unmatched, ["tilt"]);
});

test("no exports yields no bindings", () => {
  assert.deepEqual(computeBindings([], [uniform("x", 0, 1)]), { bindings: [], unmatched: [] });
});
