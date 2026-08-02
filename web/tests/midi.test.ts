/**
 * MIDI core (src/midi/manager.ts, src/store/midiStore.ts, src/midi/router.ts) —
 * the pure, DOM/hardware-free contract:
 *   - parseMidiMessage folds CC / note / pitch-bend into a normalized 0..1 event
 *     with a stable control id;
 *   - scaleToRange maps 0..1 into a uniform range with optional sub-range/invert;
 *   - resolveControlUpdates walks the three tables (semantic → binding →
 *     manifest) and emits the right uniform writes, skipping unmapped controls
 *     and non-scalar uniforms.
 * Web MIDI + localStorage are never touched here (only the pure exports).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseMidiMessage,
  controlKey,
  type MidiControlEvent,
} from "../src/midi/manager";
import {
  scaleToRange,
  normName,
  type SemanticControl,
  type UniformBinding,
} from "../src/store/midiStore";
import { resolveControlUpdates, isDrivable } from "../src/midi/router";
import type { FxUniform } from "../src/fx/preview";

test("parseMidiMessage: control change normalizes to 0..1", () => {
  const ev = parseMidiMessage("Nano", [0xb0, 74, 127]);
  assert.ok(ev);
  assert.deepEqual(ev.control, { device: "Nano", kind: "cc", channel: 0, number: 74 });
  assert.equal(ev.raw, 127);
  assert.ok(Math.abs(ev.value - 1) < 1e-6);
});

test("parseMidiMessage: channel is the low nibble of status", () => {
  const ev = parseMidiMessage("Nano", [0xb3, 10, 64]);
  assert.ok(ev);
  assert.equal(ev.control.channel, 3);
  assert.ok(Math.abs(ev.value - 64 / 127) < 1e-6);
});

test("parseMidiMessage: note-on with velocity, note-off → 0", () => {
  const on = parseMidiMessage("Pad", [0x90, 60, 100]);
  assert.ok(on);
  assert.equal(on.control.kind, "note");
  assert.ok(Math.abs(on.value - 100 / 127) < 1e-6);
  // Note-on velocity 0 is a note-off in MIDI.
  const off0 = parseMidiMessage("Pad", [0x90, 60, 0]);
  assert.equal(off0?.value, 0);
  const off = parseMidiMessage("Pad", [0x80, 60, 40]);
  assert.equal(off?.value, 0);
});

test("parseMidiMessage: pitch bend is 14-bit little-endian", () => {
  // LSB=0, MSB=64 → center 8192/16383 ≈ 0.5.
  const ev = parseMidiMessage("Keys", [0xe0, 0x00, 0x40]);
  assert.ok(ev);
  assert.equal(ev.control.kind, "pitch");
  assert.equal(ev.raw, 8192);
  assert.ok(Math.abs(ev.value - 8192 / 16383) < 1e-4);
});

test("parseMidiMessage: unmapped / short messages return null", () => {
  assert.equal(parseMidiMessage("x", [0xf8]), null); // clock
  assert.equal(parseMidiMessage("x", [0xb0]), null); // too short
});

test("controlKey is stable and distinguishes controls", () => {
  const a = controlKey({ device: "N", kind: "cc", channel: 0, number: 74 });
  const b = controlKey({ device: "N", kind: "cc", channel: 0, number: 75 });
  assert.equal(a, "N|cc|0|74");
  assert.notEqual(a, b);
});

test("normName collapses case and separators", () => {
  assert.equal(normName("Speed"), "speed");
  assert.equal(normName("SPEED_1"), "speed1");
  assert.equal(normName("wave width"), "wavewidth");
});

test("scaleToRange maps, sub-ranges, inverts, and clamps", () => {
  assert.ok(Math.abs(scaleToRange(0.5, 0, 10) - 5) < 1e-6);
  assert.ok(Math.abs(scaleToRange(0, 0, 10, { min: 2, max: 8 }) - 2) < 1e-6);
  assert.ok(Math.abs(scaleToRange(1, 0, 10, { min: 2, max: 8 }) - 8) < 1e-6);
  assert.ok(Math.abs(scaleToRange(0, 0, 10, { invert: true }) - 10) < 1e-6);
  // out-of-range input clamps into the (possibly narrowed) band.
  assert.ok(Math.abs(scaleToRange(2, 0, 10) - 10) < 1e-6);
});

// -- resolveControlUpdates ---------------------------------------------------

const CC74: MidiControlEvent = {
  control: { device: "Nano", kind: "cc", channel: 0, number: 74 },
  value: 0.5,
  raw: 64,
};

function slider(name: string, slot: number, min: number, max: number, step = 0): FxUniform {
  return { name, slot, width: 1, ui: { kind: "slider", min, max, step }, default: [min] };
}

const SPEED_SEMANTIC: SemanticControl = {
  id: controlKey(CC74.control),
  name: "speed",
  control: CC74.control,
};

test("isDrivable accepts scalar slider/toggle, rejects vectors", () => {
  assert.equal(isDrivable(slider("s", 0, 0, 1)), true);
  assert.equal(
    isDrivable({ name: "t", slot: 1, width: 1, ui: { kind: "toggle" }, default: [0] }),
    true,
  );
  assert.equal(
    isDrivable({ name: "tint", slot: 2, width: 3, ui: { kind: "color" }, default: [0, 0, 0] }),
    false,
  );
});

test("resolveControlUpdates routes a named control to a bound uniform", () => {
  const manifest = [slider("speed", 3, 0, 4)];
  const bindings: UniformBinding[] = [{ uniform: "speed", semantic: "speed" }];
  const updates = resolveControlUpdates(CC74, manifest, [SPEED_SEMANTIC], bindings);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]!.slot, 3);
  assert.ok(Math.abs(updates[0]!.value[0]! - 2) < 1e-6); // 0.5 of 0..4
});

test("resolveControlUpdates: unnamed control or no binding yields nothing", () => {
  const manifest = [slider("speed", 3, 0, 4)];
  // Control has no semantic name.
  assert.equal(resolveControlUpdates(CC74, manifest, [], []).length, 0);
  // Semantic exists but no binding references it.
  assert.equal(resolveControlUpdates(CC74, manifest, [SPEED_SEMANTIC], []).length, 0);
});

test("resolveControlUpdates: toggle uniform thresholds at 0.5", () => {
  const manifest: FxUniform[] = [
    { name: "invert", slot: 5, width: 1, ui: { kind: "toggle" }, default: [0] },
  ];
  const bindings: UniformBinding[] = [{ uniform: "invert", semantic: "speed" }];
  const hi = resolveControlUpdates(CC74, manifest, [SPEED_SEMANTIC], bindings);
  assert.deepEqual(hi[0]!.value, [1]);
  const lo = resolveControlUpdates({ ...CC74, value: 0.2 }, manifest, [SPEED_SEMANTIC], bindings);
  assert.deepEqual(lo[0]!.value, [0]);
});

test("resolveControlUpdates: step snaps the scaled value", () => {
  const manifest = [slider("count", 1, 0, 10, 1)];
  const bindings: UniformBinding[] = [{ uniform: "count", semantic: "speed" }];
  const updates = resolveControlUpdates({ ...CC74, value: 0.44 }, manifest, [SPEED_SEMANTIC], bindings);
  // 0.44 * 10 = 4.4 → snaps to 4.
  assert.equal(updates[0]!.value[0], 4);
});
