/**
 * Lamp power, app side (src/power/power.ts): the toggle's wording, transition
 * summaries + the set_power_config payload, keypoint -> slot presets, and the
 * touch-sensor pin / readout logic (docs/design/lamp-power.md).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_OFF_MS,
  DEFAULT_ON_MS,
  MAX_PRESET_VALUES,
  TRANSITION_PRESETS,
  choiceFromState,
  clampUtf8,
  deviceHasPower,
  effectDisplayName,
  effectiveDurationMs,
  formatSeconds,
  keypointToUniforms,
  powerDetail,
  powerHeadline,
  slotFor,
  suggestedTouchPin,
  switchOn,
  triggerLiveLine,
  CountWatch,
  touchPinOptions,
  transitionMessage,
  transitionSummary,
} from "../src/power/power";
import {
  POWER_PHASE_OFF,
  POWER_PHASE_ON,
  POWER_PHASE_TURNING_OFF,
  POWER_PHASE_TURNING_ON,
  POWER_SOURCE_TRIGGER,
  POWER_STYLE_CUT,
  POWER_STYLE_EFFECT,
  POWER_STYLE_FADE,
  flatPowerState,
  type PowerState,
} from "../src/net/proto";

const st = (over: Partial<PowerState> = {}): PowerState => ({ ...flatPowerState({}), ...over });

test("deviceHasPower gates on welcome.features", () => {
  assert.equal(deviceHasPower({ features: ["kiosk", "power"] }), true);
  assert.equal(deviceHasPower({ features: ["kiosk"] }), false);
  assert.equal(deviceHasPower(null), false);
  assert.equal(deviceHasPower({}), false);
});

test("flatPowerState fills proto3 defaults (absent false / zero fields)", () => {
  const s = flatPowerState({ phase: 2, seq: 7, onTransition: { style: 2, effectId: "x" } });
  assert.equal(s.on, false);
  assert.equal(s.phase, 2);
  assert.equal(s.seq, 7);
  assert.equal(s.onTransition.style, 2);
  assert.equal(s.onTransition.durationMs, 0);
  assert.equal(s.offTransition.style, POWER_STYLE_CUT);
  assert.equal(s.triggerCount, 0);
  assert.equal(s.toggleTrigger, "");
});

test("headline follows the phase; the switch follows the target", () => {
  assert.equal(powerHeadline(null), "Reading…");
  assert.equal(powerHeadline(st({ phase: POWER_PHASE_ON, on: true })), "On");
  assert.equal(powerHeadline(st({ phase: POWER_PHASE_OFF })), "Off");
  assert.equal(powerHeadline(st({ phase: POWER_PHASE_TURNING_ON, on: true })), "Turning on…");
  assert.equal(powerHeadline(st({ phase: POWER_PHASE_TURNING_OFF })), "Turning off…");
  // Mid turn-off the switch already shows off (the target), not on.
  assert.equal(switchOn(st({ phase: POWER_PHASE_TURNING_OFF, on: false })), false);
  assert.equal(switchOn(st({ phase: POWER_PHASE_TURNING_ON, on: true })), true);
  assert.equal(switchOn(null), false);
});

test("detail mentions a lid tap and that an off lamp stays connected", () => {
  assert.match(powerDetail(st({ phase: POWER_PHASE_OFF })), /Still connected/);
  assert.match(powerDetail(st({ phase: POWER_PHASE_ON, source: POWER_SOURCE_TRIGGER })), /tap on the lid/);
  assert.match(powerDetail(st({ phase: POWER_PHASE_ON, toggleTrigger: "touch_tap" })), /Tap the lid/);
  assert.equal(powerDetail(null), "");
});

test("durations: 0 = device default per direction, clamped otherwise", () => {
  assert.equal(effectiveDurationMs({ durationMs: 0 }, "on"), DEFAULT_ON_MS);
  assert.equal(effectiveDurationMs({}, "off"), DEFAULT_OFF_MS);
  assert.equal(effectiveDurationMs({ durationMs: 50 }, "on"), 100);
  assert.equal(effectiveDurationMs({ durationMs: 99_999 }, "on"), 30_000);
  assert.equal(formatSeconds(700), "0.7 s");
  assert.equal(formatSeconds(12_000), "12 s");
  assert.equal(slotFor("on"), 1);
  assert.equal(slotFor("off"), 2);
});

test("transition summaries", () => {
  const t = flatPowerState({}).onTransition;
  assert.equal(transitionSummary({ ...t, style: POWER_STYLE_CUT }, "on"), "Cut (instant)");
  assert.equal(transitionSummary({ ...t, style: POWER_STYLE_FADE }, "off"), "Fade · 0.9 s");
  assert.equal(
    transitionSummary({ ...t, style: POWER_STYLE_EFFECT, effectId: "transition:bloom", durationMs: 2000, label: "Warm" }, "on"),
    "Bloom (Warm) · 2.0 s",
  );
  assert.match(transitionSummary({ ...t, style: POWER_STYLE_EFFECT }, "on"), /no effect stored/);
  // A library effect's name comes from the lookup.
  assert.equal(
    transitionSummary({ ...t, style: POWER_STYLE_EFFECT, effectId: "abc", durationMs: 1000 }, "on", (id) =>
      id === "abc" ? "Aurora" : undefined,
    ),
    "Aurora · 1.0 s",
  );
  assert.equal(effectDisplayName("transition:sparkle"), "Sparkle");
  assert.equal(effectDisplayName("lib-id"), "lib-id");
});

test("transitionMessage: clamps, drops effect-only fields for fade/cut, caps the preset", () => {
  assert.deepEqual(transitionMessage({ style: POWER_STYLE_FADE, durationMs: 20, label: "x" }), {
    style: POWER_STYLE_FADE,
    durationMs: 100,
  });
  assert.deepEqual(transitionMessage({ style: 99, durationMs: 800 }), { style: POWER_STYLE_FADE, durationMs: 800 });
  const many = Array.from({ length: 12 }, (_, i) => ({ slot: i, value: [i] }));
  const m = transitionMessage({ style: POWER_STYLE_EFFECT, durationMs: 1500, label: "Warm", uniforms: many });
  assert.equal(m.style, POWER_STYLE_EFFECT);
  assert.equal(m.label, "Warm");
  assert.equal(m.uniforms?.length, MAX_PRESET_VALUES);
  // The effect id is never sent (set by the stored submit_effect).
  assert.equal("effectId" in m, false);
});

test("clampUtf8 never splits a character", () => {
  assert.equal(clampUtf8("short", 32), "short");
  const s = "é".repeat(20); // 40 bytes
  const c = clampUtf8(s, 32);
  assert.equal(new TextEncoder().encode(c).length, 32);
  assert.equal(clampUtf8("aé", 2), "a");
});

test("choiceFromState seeds from the device config, defaults to a fade", () => {
  assert.deepEqual(choiceFromState(null, "off"), { style: POWER_STYLE_FADE, durationMs: DEFAULT_OFF_MS });
  const s = flatPowerState({
    offTransition: { style: POWER_STYLE_EFFECT, durationMs: 2500, effectId: "transition:sparkle", label: "Cold" },
  });
  assert.deepEqual(choiceFromState(s, "off"), {
    style: POWER_STYLE_EFFECT,
    durationMs: 2500,
    effectId: "transition:sparkle",
    label: "Cold",
  });
  assert.equal(choiceFromState(s, "on").style, POWER_STYLE_CUT); // absent style on the wire = 0
});

test("keypointToUniforms resolves names to slots, chunks wide values, drops unknowns", () => {
  const manifest = [
    { name: "tint", slot: 4, width: 3 },
    { name: "edge", slot: 7, width: 1 },
    { name: "m", slot: 8, width: 9 },
  ];
  const u = keypointToUniforms(
    [
      { uniform: "tint", value: [1, 0.5, 0.2] },
      { uniform: "gone", value: [1] },
      { uniform: "m", value: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    ],
    manifest,
  );
  assert.deepEqual(u, [
    { slot: 4, value: [1, 0.5, 0.2] },
    { slot: 8, value: [1, 2, 3, 4] },
    { slot: 12, value: [5, 6, 7, 8] },
    { slot: 16, value: [9] },
  ]);
  const big = Array.from({ length: 9 }, (_, i) => ({ uniform: `u${i}`, value: [i] }));
  const bigManifest = big.map((b, i) => ({ name: b.uniform, slot: i, width: 1 }));
  assert.equal(keypointToUniforms(big, bigManifest), null);
});

test("built-in transition presets declare the power uniform", () => {
  assert.ok(TRANSITION_PRESETS.length >= 2);
  for (const p of TRANSITION_PRESETS) {
    assert.match(p.id, /^transition:/);
    assert.match(p.source, /uniform float power/);
    assert.ok(new TextEncoder().encode(p.id).length <= 64);
  }
});

test("touch pin options exclude LED data pins and suggest GPIO 3", () => {
  // LED data pins (20, 14) are excluded; the current pin is always offered.
  assert.deepEqual(touchPinOptions([0, 1, 2, 3, 10, 14, 20], [20, 14], -1), [0, 1, 2, 3, 10]);
  assert.deepEqual(touchPinOptions([0, 1], [], 9), [0, 1, 9]);
  assert.equal(suggestedTouchPin([0, 1, 2, 3]), 3);
  assert.equal(suggestedTouchPin([0, 1]), 0);
  assert.equal(suggestedTouchPin([]), null);
});

test("trigger live readout", () => {
  assert.match(triggerLiveLine(null), /Waiting/);
  assert.match(triggerLiveLine(st()), /No sensor/);
  assert.equal(triggerLiveLine(st({ toggleTrigger: "touch_tap", triggerCount: 1 })), '"touch_tap" toggles the lamp · 1 tap since boot');
  assert.equal(triggerLiveLine(st({ toggleTrigger: "touch_tap", triggerCount: 4 })), '"touch_tap" toggles the lamp · 4 taps since boot');
});

test("CountWatch flags increments only, never the first observation", () => {
  const w = new CountWatch();
  assert.equal(w.bumped(5), false);
  assert.equal(w.bumped(5), false);
  assert.equal(w.bumped(6), true);
  assert.equal(w.bumped(null), false);
  assert.equal(w.bumped(6), false);
  assert.equal(w.bumped(2), false); // a reboot resets the count: not a tap
  assert.equal(w.bumped(3), true);
});
