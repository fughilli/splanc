/**
 * MIDI on the `: vector` (XY pad) and `: direction` (dial / sphere) uniform
 * kinds (D-541 PR 4): they are drivable per component like a ranged-slider
 * vector, a vector snaps to its step and range, and a direction stays a unit
 * vector. The agent summary lists them with their channels and ranges.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { MidiControlEvent, MidiControlId } from "../src/midi/manager";
import { controlKey } from "../src/midi/manager";
import { UniformShadow, bindingChannels, isDrivable, resolveControlUpdates } from "../src/midi/router";
import { midiListSummary } from "../src/midi/agentSummary";
import type { SemanticControl, UniformBinding } from "../src/store/midiStore";
import type { FxUniform } from "../src/fx/preview";

const knob = (n: number): MidiControlId => ({ device: "Nano", kind: "cc", channel: 0, number: n });
const sem = (name: string, n: number): SemanticControl => ({ id: controlKey(knob(n)), name, control: knob(n) });
const SEMS = [sem("k1", 1), sem("k2", 2)];
const turn = (n: number, value: number): MidiControlEvent => ({
  control: knob(n),
  value,
  raw: Math.round(value * 127),
});
const close = (a: readonly number[], b: readonly number[], eps = 1e-6): boolean =>
  a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < eps);

const PAD: FxUniform = {
  name: "pos",
  slot: 2,
  width: 2,
  ui: { kind: "vector", min: -1, max: 1, step: 0.25 },
  default: [0, 0],
};
const AIM: FxUniform = { name: "aim", slot: 3, width: 3, ui: { kind: "direction" }, default: [0, 0, 1] };
const DIAL: FxUniform = { name: "wind", slot: 4, width: 2, ui: { kind: "direction" }, default: [1, 0] };

test("vector and direction uniforms are drivable per component", () => {
  assert.ok(isDrivable(PAD) && isDrivable(AIM) && isDrivable(DIAL));
  assert.deepEqual(bindingChannels(PAD), ["x", "y"]);
  assert.deepEqual(bindingChannels(AIM), ["x", "y", "z"]);
});

test("a vector knob sweeps its range and snaps to its step", () => {
  const b: UniformBinding[] = [{ uniform: "pos", semantic: "k1", channel: "y" }];
  const up = resolveControlUpdates(turn(1, 0.6), [PAD], SEMS, b);
  // -1 + 0.6*2 = 0.2 -> step 0.25 grid -> 0.25; x untouched.
  assert.ok(close(up[0]!.value, [0, 0.25]), String(up[0]!.value));
  // A numeric index works too.
  const n = resolveControlUpdates(turn(1, 1), [PAD], SEMS, [{ uniform: "pos", semantic: "k1", channel: "0" }]);
  assert.ok(close(n[0]!.value, [1, 0]));
});

test("a direction stays a unit vector", () => {
  const b: UniformBinding[] = [
    { uniform: "aim", semantic: "k1", channel: "x" },
    { uniform: "aim", semantic: "k2", channel: "y" },
  ];
  const shadow = new UniformShadow();
  const up = resolveControlUpdates(turn(1, 0.75), [AIM], SEMS, b, shadow); // x = 0.5
  const v = up[0]!.value;
  assert.ok(Math.abs(v[0]! - 0.5) < 1e-6);
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6, String(v));
  assert.ok(close(v, [0.5, 0, Math.sqrt(0.75)]));
  const up2 = resolveControlUpdates(turn(2, 0.5), [AIM], SEMS, b, shadow); // y = 0
  assert.ok(Math.abs(Math.hypot(...up2[0]!.value) - 1) < 1e-6);
  assert.ok(Math.abs(up2[0]!.value[0]! - 0.5) < 1e-6, "x kept through the shadow");

  // 2D: knob x to 1 with y already 0 -> (1, 0); x to 0 from (1, 0) -> spread to y.
  const d = resolveControlUpdates(turn(1, 0.5), [DIAL], SEMS, [{ uniform: "wind", semantic: "k1", channel: "x" }]);
  assert.ok(close(d[0]!.value, [0, 1]), String(d[0]!.value));
});

test("the agent summary lists vector and direction uniforms with ranges", () => {
  const json = JSON.parse(
    midiListSummary({ uniforms: [PAD, AIM], semantics: SEMS, bindings: [], midiEnabled: true }),
  ) as { uniforms: Array<Record<string, unknown>> };
  const pos = json.uniforms.find((u) => u.name === "pos")!;
  assert.equal(pos.type, "vector");
  assert.deepEqual(pos.channels, ["x", "y"]);
  assert.deepEqual(pos.min, [-1, -1]);
  const aim = json.uniforms.find((u) => u.name === "aim")!;
  assert.equal(aim.type, "direction");
  assert.deepEqual(aim.max, [1, 1, 1]);
});
