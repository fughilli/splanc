/**
 * Halloween play mode, pure parts: preset sliders + uniform values
 * (src/halloween/playLogic.ts), the QR fixture-name parse, the Web Bluetooth
 * name filter (src/net/bleTransport.ts), routing context, and the preset list's
 * shape (the content agent fills it in).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { FxUniform } from "../src/fx/preview";
import { presetUniformValues, ropeStartFromChannels, sliderSpecs } from "../src/halloween/playLogic";
import { HALLOWEEN_PRESETS, attractPreset, presetEffectId } from "../src/halloween/presets";
import { bleRequestOptions, PLAYER_SERVICE_UUID } from "../src/net/bleTransport";
import { IMPROV_SERVICE } from "../src/net/improv";
import { HALLOWEEN_NAME_PREFIX, parseFixtureName } from "../src/net/halloweenConnect";
import { isPlayHash, playRoute } from "../src/halloween/playSession";

const U: FxUniform[] = [
  { name: "speed", slot: 0, width: 1, ui: { kind: "slider", min: 0, max: 2, step: 0.01 }, default: [0.4] },
  { name: "tint", slot: 1, width: 3, ui: { kind: "color" }, default: [1, 0.5, 0] },
  { name: "size", slot: 4, width: 1, ui: { kind: "slider", min: 1, max: 9, step: 0 }, default: [3] },
  { name: "flip", slot: 5, width: 1, ui: { kind: "toggle" }, default: [0] },
];

test("sliderSpecs: up to two scalar sliders, in preset order, skipping non-sliders", () => {
  const p = { sliders: ["size", "tint", "flip", "nope", "speed"], uniforms: {} };
  const s = sliderSpecs(p, U);
  assert.deepEqual(
    s.map((x) => [x.name, x.slot, x.min, x.max, x.value]),
    [
      ["size", 4, 1, 9, 3],
      ["speed", 0, 0, 2, 0.4],
    ],
  );
  assert.equal(s[0]!.step, 0.08); // step 0 -> 1% of range
});

test("sliderSpecs: visitor value > preset override > default, clamped", () => {
  const p = { sliders: ["speed"], uniforms: { speed: 1.5 } };
  assert.equal(sliderSpecs(p, U)[0]!.value, 1.5);
  assert.equal(sliderSpecs(p, U, { speed: 0.2 })[0]!.value, 0.2);
  assert.equal(sliderSpecs(p, U, { speed: 99 })[0]!.value, 2);
});

test("presetUniformValues: defaults, overrides (width-checked), visitor sliders", () => {
  const p = { uniforms: { tint: [0, 1, 0], speed: 1, size: [1, 2] } };
  assert.deepEqual(presetUniformValues(p, U, { size: 7 }), [
    { slot: 0, value: [1] },
    { slot: 1, value: [0, 1, 0] },
    { slot: 4, value: [7] }, // width mismatch override ignored, visitor value wins
    { slot: 5, value: [0] },
  ]);
});

test("rope_start: CH0's LED count when CH1 drives a rope, else 0; applied after preset overrides", () => {
  assert.equal(ropeStartFromChannels([{ channel: 0, ledCount: 300 }, { channel: 1, ledCount: 120 }]), 300);
  assert.equal(ropeStartFromChannels([{ channel: 0, ledCount: 300 }, { channel: 1, ledCount: 0 }]), 0);
  assert.equal(ropeStartFromChannels([{ channel: 0, ledCount: 300 }]), 0);
  assert.equal(ropeStartFromChannels([]), 0);
  const withRope: FxUniform[] = [
    ...U,
    { name: "rope_start", slot: 6, width: 1, ui: { kind: "slider", min: 0, max: 2048, step: 1 }, default: [0] },
  ];
  const vals = presetUniformValues({ uniforms: { rope_start: 5 } }, withRope, {}, { rope_start: 300, nope: 1 });
  assert.deepEqual(vals.find((v) => v.slot === 6), { slot: 6, value: [300] });
  assert.equal(vals.length, withRope.length);
});

test("parseFixtureName: QR f= values", () => {
  assert.equal(parseFixtureName("SpookySplanc1"), "SpookySplanc1");
  assert.equal(parseFixtureName("  SpookySplanc2 "), "SpookySplanc2");
  assert.equal(parseFixtureName(""), undefined);
  assert.equal(parseFixtureName(null), undefined);
  assert.equal(parseFixtureName("<script>"), undefined);
  assert.equal(parseFixtureName("x".repeat(40)), undefined);
});

test("bleRequestOptions: exact name, prefix, or the legacy Improv filter", () => {
  assert.deepEqual(bleRequestOptions({ name: "SpookySplanc1", namePrefix: "Spooky" }), {
    filters: [{ name: "SpookySplanc1" }],
    optionalServices: [PLAYER_SERVICE_UUID, IMPROV_SERVICE],
  });
  assert.deepEqual(bleRequestOptions({ namePrefix: HALLOWEEN_NAME_PREFIX }), {
    filters: [{ namePrefix: "SpookySplanc" }],
    optionalServices: [PLAYER_SERVICE_UUID, IMPROV_SERVICE],
  });
  assert.deepEqual(bleRequestOptions(), {
    filters: [{ services: [IMPROV_SERVICE] }],
    optionalServices: [PLAYER_SERVICE_UUID],
  });
});

test("play routing context survives #/acid?play=1", () => {
  assert.equal(playRoute("SpookySplanc1"), "/play?f=SpookySplanc1");
  assert.equal(playRoute(), "/play");
  assert.equal(isPlayHash("#/play?f=SpookySplanc1"), true);
  assert.equal(isPlayHash("#/play"), true);
  assert.equal(isPlayHash("#/acid?play=1"), true);
  assert.equal(isPlayHash("#/acid"), false);
  assert.equal(isPlayHash("#/maps"), false);
  assert.equal(isPlayHash(""), false);
});

test("HALLOWEEN_PRESETS shape", () => {
  assert.ok(HALLOWEEN_PRESETS.length >= 2);
  const ids = new Set<string>();
  for (const p of HALLOWEEN_PRESETS) {
    assert.ok(p.id && !ids.has(p.id), `unique id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.name && p.emoji && p.source.includes("shade"), p.id);
    assert.ok(p.sliders.length <= 2, `${p.id}: at most two sliders`);
    for (const s of p.sliders) assert.match(p.source, new RegExp(`uniform\\s+\\w+\\s+${s}\\b`), `${p.id}: ${s}`);
    // Rate knobs integrate in update(); never time * speed (CONTRACT/RULES).
    assert.doesNotMatch(p.source, /\btime\s*\*/, `${p.id}: no time*rate`);
  }
  assert.ok(attractPreset());
  assert.equal(presetEffectId({ id: "x" }), "boo-x");
});
