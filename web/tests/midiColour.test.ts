/**
 * Colour and vector MIDI mapping (D-541 PR 3): per-channel bindings routed
 * through the router's vector shadow (src/midi/router.ts), HSV→RGB on the
 * host, the agent summary + mapping validation (src/midi/agentSummary.ts),
 * the prompts that describe the options, and old stored bindings loading.
 */

import assert from "node:assert/strict";
import { test, beforeEach } from "node:test";

import type { MidiControlEvent, MidiControlId } from "../src/midi/manager";
import { controlKey } from "../src/midi/manager";
import {
  UniformShadow,
  bindingChannels,
  isAutoBindable,
  isDrivable,
  resolveControlUpdates,
} from "../src/midi/router";
import {
  MIDI_COLOUR_GUIDANCE,
  MIDI_REMAP_PROMPT,
  midiListSummary,
  validateMidiMappings,
} from "../src/midi/agentSummary";
import type { SemanticControl, UniformBinding } from "../src/store/midiStore";
import { midiStore } from "../src/store/midiStore";
import { hsvToRgb } from "../src/color/hsv";
import { CHAT_SYSTEM, MIDI_TOOLS } from "../src/effects/ai/chatPrompt";
import { ACID_SYSTEM } from "../src/effects/ai/acidPersona";
import type { FxUniform } from "../src/fx/preview";

// -- fixtures -----------------------------------------------------------------

const knob = (n: number): MidiControlId => ({ device: "Nano", kind: "cc", channel: 0, number: n });
const sem = (name: string, n: number): SemanticControl => ({
  id: controlKey(knob(n)),
  name,
  control: knob(n),
});
const SEMS = [sem("k1", 1), sem("k2", 2), sem("k3", 3)];
const turn = (n: number, value: number): MidiControlEvent => ({
  control: knob(n),
  value,
  raw: Math.round(value * 127),
});

const TINT: FxUniform = {
  name: "tint",
  slot: 4,
  width: 3,
  ui: { kind: "color" },
  default: [1, 0, 0], // red: h 0, s 1, v 1
};
const GLOW: FxUniform = { name: "glow", slot: 5, width: 4, ui: { kind: "color" }, default: [0, 0, 1, 0.5] };
const DIR: FxUniform = {
  name: "dir",
  slot: 6,
  width: 3,
  ui: { kind: "slider", min: -1, max: 1, step: 0 },
  default: [0, 0, 0],
  mins: [-1, -2, 0],
  maxs: [1, 2, 10],
};
const XF: FxUniform = {
  name: "xf",
  slot: 7,
  width: 9,
  ui: { kind: "matrix", min: -4, max: 4 },
  default: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};
const SPEED: FxUniform = { name: "speed", slot: 1, width: 1, ui: { kind: "slider", min: 0, max: 4, step: 0 }, default: [1] };

const close = (a: readonly number[], b: readonly number[], eps = 1e-6): boolean =>
  a.length === b.length && a.every((x, i) => Math.abs(x - b[i]!) < eps);

// -- drivability --------------------------------------------------------------

test("isDrivable/bindingChannels cover colour, vector and matrix components", () => {
  assert.deepEqual(bindingChannels(SPEED), []);
  assert.deepEqual(bindingChannels(TINT), ["h", "s", "v", "r", "g", "b"]);
  assert.deepEqual(bindingChannels(GLOW), ["h", "s", "v", "r", "g", "b", "a"]);
  assert.deepEqual(bindingChannels(DIR), ["x", "y", "z"]);
  assert.equal(bindingChannels(XF).length, 9);
  for (const u of [SPEED, TINT, GLOW, DIR, XF]) assert.equal(isDrivable(u), true, u.name);
  // Name-based auto-binding (no channel) only for scalars and colours (→ hue).
  assert.deepEqual(
    [SPEED, TINT, DIR, XF].map(isAutoBindable),
    [true, true, false, false],
  );
});

// -- routing ------------------------------------------------------------------

test("hue only, S and V fixed: one knob sweeps the hue at the pinned S/V", () => {
  const bindings: UniformBinding[] = [
    { uniform: "tint", semantic: "k1", channel: "h", space: "hsv", fixed: { s: 0.5, v: 0.8 } },
  ];
  const shadow = new UniformShadow();
  const up = resolveControlUpdates(turn(1, 1 / 3), [TINT], SEMS, bindings, shadow);
  assert.equal(up.length, 1);
  assert.equal(up[0]!.slot, 4);
  // Whole vec3 sent: hue 1/3 (green) at s 0.5, v 0.8.
  assert.ok(close(up[0]!.value, hsvToRgb(1 / 3, 0.5, 0.8)), String(up[0]!.value));
  const up2 = resolveControlUpdates(turn(1, 2 / 3), [TINT], SEMS, bindings, shadow);
  assert.ok(close(up2[0]!.value, hsvToRgb(2 / 3, 0.5, 0.8)));
});

test("hue only without `fixed` keeps the colour's current S and V", () => {
  const dim: FxUniform = { ...TINT, default: [0.4, 0.2, 0.2] }; // h 0, s 0.5, v 0.4
  const up = resolveControlUpdates(
    turn(1, 0.5),
    [dim],
    SEMS,
    [{ uniform: "tint", semantic: "k1" }], // no channel: a colour's default is hue
  );
  assert.ok(close(up[0]!.value, hsvToRgb(0.5, 0.5, 0.4)), String(up[0]!.value));
});

test("three knobs as H, S, V drive one colour through the shadow", () => {
  const bindings: UniformBinding[] = [
    { uniform: "tint", semantic: "k1", channel: "h", space: "hsv" },
    { uniform: "tint", semantic: "k2", channel: "s", space: "hsv" },
    { uniform: "tint", semantic: "k3", channel: "v", space: "hsv" },
  ];
  const shadow = new UniformShadow();
  resolveControlUpdates(turn(1, 0.25), [TINT], SEMS, bindings, shadow);
  resolveControlUpdates(turn(2, 0.6), [TINT], SEMS, bindings, shadow);
  const up = resolveControlUpdates(turn(3, 0.9), [TINT], SEMS, bindings, shadow);
  assert.ok(close(up[0]!.value, hsvToRgb(0.25, 0.6, 0.9)), String(up[0]!.value));
  // V to 0 (black) and back: the hue and saturation survive.
  resolveControlUpdates(turn(3, 0), [TINT], SEMS, bindings, shadow);
  const back = resolveControlUpdates(turn(3, 1), [TINT], SEMS, bindings, shadow);
  assert.ok(close(back[0]!.value, hsvToRgb(0.25, 0.6, 1)), String(back[0]!.value));
});

test("RGB: each knob drives one component, the rest (and alpha) are kept", () => {
  const bindings: UniformBinding[] = [
    { uniform: "glow", semantic: "k1", channel: "r", space: "rgb" },
    { uniform: "glow", semantic: "k2", channel: "g", space: "rgb" },
  ];
  const shadow = new UniformShadow();
  resolveControlUpdates(turn(1, 0.2), [GLOW], SEMS, bindings, shadow);
  const up = resolveControlUpdates(turn(2, 0.7), [GLOW], SEMS, bindings, shadow);
  assert.ok(close(up[0]!.value, [0.2, 0.7, 1, 0.5]), String(up[0]!.value));
});

test("the live value wins over the shadow (a manual edit between turns)", () => {
  let live: number[] = [0, 0, 1];
  const shadow = new UniformShadow(() => live);
  const bindings: UniformBinding[] = [{ uniform: "tint", semantic: "k1", channel: "r" }];
  const up = resolveControlUpdates(turn(1, 1), [TINT], SEMS, bindings, shadow);
  assert.ok(close(up[0]!.value, [1, 0, 1]));
  live = [0, 1, 0];
  const up2 = resolveControlUpdates(turn(1, 0.5), [TINT], SEMS, bindings, shadow);
  assert.ok(close(up2[0]!.value, [0.5, 1, 0]));
});

test("vector components use their own range; matrix by index", () => {
  const vb: UniformBinding[] = [
    { uniform: "dir", semantic: "k1", channel: "z" },
    { uniform: "dir", semantic: "k2", channel: "1" }, // numeric index == y
  ];
  const shadow = new UniformShadow();
  resolveControlUpdates(turn(1, 0.5), [DIR], SEMS, vb, shadow);
  const up = resolveControlUpdates(turn(2, 1), [DIR], SEMS, vb, shadow);
  assert.ok(close(up[0]!.value, [0, 2, 5]), String(up[0]!.value));

  const mb: UniformBinding[] = [{ uniform: "xf", semantic: "k1", channel: "4" }];
  const m = resolveControlUpdates(turn(1, 0), [XF], SEMS, mb);
  assert.ok(close(m[0]!.value, [1, 0, 0, 0, -4, 0, 0, 0, 1]));
});

test("a vector binding without a valid channel is ignored", () => {
  for (const channel of [undefined, "w", "h", "9"]) {
    const b: UniformBinding = { uniform: "dir", semantic: "k1", ...(channel ? { channel } : {}) };
    assert.equal(resolveControlUpdates(turn(1, 1), [DIR], SEMS, [b]).length, 0, String(channel));
  }
});

test("one knob on two channels of a colour sends ONE merged write", () => {
  const bindings: UniformBinding[] = [
    { uniform: "tint", semantic: "k1", channel: "r" },
    { uniform: "tint", semantic: "k1", channel: "b" },
  ];
  const up = resolveControlUpdates(turn(1, 0.5), [TINT], SEMS, bindings);
  assert.equal(up.length, 1);
  assert.ok(close(up[0]!.value, [0.5, 0, 0.5]));
});

// -- store: old bindings still load; channel bindings coexist ----------------

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}
const mem = new MemStorage();
(globalThis as { localStorage?: unknown }).localStorage = mem;
beforeEach(() => mem.clear());

test("bindings stored before channels existed load and route unchanged", () => {
  // The exact shape the app wrote before D-541 PR 3.
  mem.setItem(
    "ledmapper.midi",
    JSON.stringify({
      semantics: [SEMS[0]],
      bindings: { eff: [{ uniform: "speed", semantic: "k1", min: 1, max: 3, invert: true }] },
      showBindings: {},
    }),
  );
  const b = midiStore.bindings("eff");
  assert.deepEqual(b, [{ uniform: "speed", semantic: "k1", min: 1, max: 3, invert: true }]);
  const up = resolveControlUpdates(turn(1, 0.25), [SPEED], midiStore.semantics(), b);
  assert.ok(close(up[0]!.value, [2.5])); // inverted 0.25 over 1..3
});

test("setBinding keys colour bindings by channel; clearBinding can drop one", () => {
  midiStore.setBinding("eff", { uniform: "tint", semantic: "k1", channel: "h" });
  midiStore.setBinding("eff", { uniform: "tint", semantic: "k2", channel: "s" });
  midiStore.setBinding("eff", { uniform: "tint", semantic: "k3", channel: "h" }); // replaces h
  assert.deepEqual(
    midiStore.bindingsFor("eff", "tint").map((b) => [b.channel, b.semantic]),
    [
      ["s", "k2"],
      ["h", "k3"],
    ],
  );
  midiStore.clearBinding("eff", "tint", "s");
  assert.deepEqual(midiStore.bindingsFor("eff", "tint").map((b) => b.channel), ["h"]);
  midiStore.clearBinding("eff", "tint");
  assert.equal(midiStore.bindingsFor("eff", "tint").length, 0);
});

// -- the agent: summary, validation, schema, prompts -------------------------

test("midiListSummary lists colours/vectors with channels and current HSV", () => {
  const binds: UniformBinding[] = [
    { uniform: "tint", semantic: "k1", channel: "h", space: "hsv", fixed: { s: 1, v: 0.5 } },
  ];
  const json = JSON.parse(
    midiListSummary({
      uniforms: [SPEED, TINT, DIR, XF],
      values: (u) => (u.name === "tint" ? [0, 0.5, 0.5] : undefined),
      semantics: SEMS,
      bindings: binds,
      midiEnabled: true,
    }),
  ) as {
    uniforms: Array<Record<string, unknown>>;
    namedControls: Array<{ name: string; source: string }>;
    currentMappings: Array<Record<string, unknown>>;
    midiEnabled: boolean;
    colourAndVectorMapping?: string;
  };
  const byName = new Map(json.uniforms.map((u) => [u["name"], u]));
  assert.deepEqual(byName.get("speed"), { name: "speed", type: "slider", min: 0, max: 4 });
  const tint = byName.get("tint")!;
  assert.equal(tint["type"], "color");
  assert.deepEqual(tint["channels"], ["h", "s", "v", "r", "g", "b"]);
  assert.deepEqual(tint["rgb"], [0, 0.5, 0.5]); // the LIVE value, not the default
  assert.deepEqual(tint["hsv"], [0.5, 1, 0.5]); // cyan
  assert.deepEqual(byName.get("dir"), {
    name: "dir",
    type: "vector",
    channels: ["x", "y", "z"],
    min: [-1, -2, 0],
    max: [1, 2, 10],
  });
  assert.equal(byName.get("xf")!["type"], "matrix");
  assert.deepEqual(json.currentMappings, [
    { uniform: "tint", control: "k1", channel: "h", space: "hsv", fixed: { s: 1, v: 0.5 } },
  ]);
  assert.equal(json.namedControls[0]!.source, "Nano · CC 1 · ch 1");
  assert.equal(json.colourAndVectorMapping, MIDI_COLOUR_GUIDANCE);
  // All three colour options are spelled out for the model.
  assert.match(MIDI_COLOUR_GUIDANCE, /ONE knob → hue: channel 'h'.*fixed \{s, v\}/);
  assert.match(MIDI_COLOUR_GUIDANCE, /THREE knobs → channels 'h', 's', 'v'/);
  assert.match(MIDI_COLOUR_GUIDANCE, /RGB.*'r', 'g', 'b'/);
});

test("midiListSummary for a scalar-only effect has no colour guidance (unchanged shape)", () => {
  const json = JSON.parse(
    midiListSummary({ uniforms: [SPEED], semantics: [], bindings: [], midiEnabled: false }),
  ) as Record<string, unknown>;
  assert.deepEqual(Object.keys(json), ["uniforms", "namedControls", "currentMappings", "midiEnabled"]);
});

test("validateMidiMappings normalises channel/space/fixed and rejects bad ones", () => {
  const { applied, skipped } = validateMidiMappings(
    [
      { uniform: "speed", control: "k1", channel: "h" }, // scalar: channel dropped
      { uniform: "tint", control: "k1", fixed: { s: 2, v: 0.3 } }, // → h, s clamped
      { uniform: "tint", control: "k2", channel: "r", space: "hsv" }, // contradiction
      { uniform: "dir", control: "k2" }, // vector needs a channel
      { uniform: "dir", control: "k3", channel: "x", fixed: { s: 1 } }, // fixed ignored
      { uniform: "nope", control: "k1" },
      { uniform: "tint", control: "k3", channel: "v", fixed: { s: 0.4, v: 0.1 } }, // v not fixed on v
    ],
    [SPEED, TINT, DIR],
  );
  assert.deepEqual(applied, [
    { uniform: "speed", semantic: "k1" },
    { uniform: "tint", semantic: "k1", channel: "h", space: "hsv", fixed: { s: 1, v: 0.3 } },
    { uniform: "dir", semantic: "k3", channel: "x" },
    { uniform: "tint", semantic: "k3", channel: "v", space: "hsv", fixed: { s: 0.4 } },
  ]);
  assert.equal(skipped.length, 3);
  assert.match(skipped.join("\n"), /tint \(channel 'r' is rgb, not hsv\)/);
  assert.match(skipped.join("\n"), /dir \(needs a channel: one of x, y, z\)/);
  assert.match(skipped.join("\n"), /nope \(not a drivable uniform\)/);
});

test("set_midi_mapping schema exposes channel, space and fixed", () => {
  const tool = MIDI_TOOLS[1];
  assert.equal(tool.name, "set_midi_mapping");
  const item = tool.input_schema.properties.mappings.items;
  assert.deepEqual(Object.keys(item.properties).sort(), [
    "channel",
    "control",
    "fixed",
    "invert",
    "max",
    "min",
    "space",
    "uniform",
  ]);
  assert.deepEqual([...item.properties.space.enum], ["hsv", "rgb"]);
  assert.deepEqual(Object.keys(item.properties.fixed.properties).sort(), ["s", "v"]);
  assert.deepEqual([...item.required], ["uniform", "control"]); // old calls stay valid
});

test("prompts in all three places describe hue-only, HSV and RGB colour mapping", () => {
  // 1. the chat system prompt, 2. the editor's ✨ Remap request, 3. Acid Mode.
  for (const p of [CHAT_SYSTEM, MIDI_REMAP_PROMPT]) {
    assert.doesNotMatch(p, /only map scalar/);
    assert.match(p, /spare knob → hue only \(channel 'h', fixed s\/v/);
    assert.match(p, /three knobs → h, s, v/);
  }
  assert.match(CHAT_SYSTEM, /RGB \(r, g, b\) only when the user asks/);
  assert.match(MIDI_REMAP_PROMPT, /r, g, b only if I ask for RGB/);
  assert.match(ACID_SYSTEM, /one knob → hue.*three knobs → hue, saturation, brightness.*red\/green\/blue/);
});
