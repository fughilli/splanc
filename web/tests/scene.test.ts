import { test } from "node:test";
import assert from "node:assert/strict";
import { captureUniforms, sceneUniformValues } from "../src/effects/scene";
import type { FxUniform } from "../src/fx/preview";

const manifest: FxUniform[] = [
  { name: "speed", slot: 3, width: 1, default: [1], ui: { kind: "slider", min: 0, max: 5, step: 0.1 } },
  { name: "tint", slot: 0, width: 3, default: [1, 0, 0], ui: { kind: "color" } },
];

test("a captured scene restores named values when compiler slots change", () => {
  const saved = captureUniforms(manifest, [
    { slot: 3, value: [2.7] }, { slot: 0, value: [0.2, 0.4, 0.6] },
  ]);
  const reordered = manifest.map(uniform => ({ ...uniform, slot: uniform.slot + 4 }));
  assert.deepEqual(sceneUniformValues(reordered, saved), [
    { slot: 7, value: [2.7] }, { slot: 4, value: [0.2, 0.4, 0.6] },
  ]);
});

test("changed widths and nonfinite scene values fall back to compiler defaults", () => {
  assert.deepEqual(sceneUniformValues(manifest, { speed: [NaN], tint: [0.5] }), [
    { slot: 3, value: [1] }, { slot: 0, value: [1, 0, 0] },
  ]);
});

test("capture and restore own their arrays", () => {
  const value = [2];
  const saved = captureUniforms(manifest, [{ slot: 3, value }]);
  value[0] = 99;
  const restored = sceneUniformValues(manifest, saved);
  restored[0]!.value[0] = 42;
  assert.deepEqual(saved.speed, [2]);
  assert.deepEqual(manifest[1]!.default, [1, 0, 0]);
});
