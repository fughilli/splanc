/**
 * #452: the effect agent sees EFFECTIVE live uniform values (not just source
 * defaults) and can set/reset them with a scoped tool, while the panel's
 * intended preservation of live tuning across recompiles is unchanged.
 * (src/effects/ai/liveUniforms.ts, UniformPanel, generate.ts tool wiring.)
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { installFakeDom } from "./fakeDom";

installFakeDom();

import {
  describeLiveUniformResult,
  describeLiveUniforms,
  liveDeviceSink,
  parseLiveUniformCall,
  planLiveUniformChange,
  retainedLiveNote,
  type LiveUniformCall,
} from "../src/effects/ai/liveUniforms";
import { editorContext, runChatTurn, type ChatHooks } from "../src/effects/ai/generate";
import { LIVE_UNIFORMS_GUIDE, selectTools } from "../src/effects/ai/chatPrompt";
import type { AiProvider, ChatMessage, SendOptions } from "../src/effects/ai/provider";
import { UniformPanel } from "../src/effects/editor/uniform-panel";
import type { FxUniform } from "../src/fx/preview";

const ORANGE = [1, 0.5, 0];
const BLUE = [0.2, 0.6, 1];
const tint = (def: number[]): FxUniform => ({ name: "tint", slot: 1, width: 3, ui: { kind: "color" }, default: def });
const SPEED: FxUniform = {
  name: "speed",
  slot: 0,
  width: 1,
  ui: { kind: "slider", min: 0, max: 3, step: 0.01 },
  default: [0.6],
};

function panelWith(manifest: FxUniform[]): { panel: UniformPanel; changes: [number, number[]][] } {
  const changes: [number, number[]][] = [];
  const host = document.createElement("div");
  const panel = new UniformPanel(host, (slot, value) => changes.push([slot, value]));
  panel.setManifest(manifest);
  return { panel, changes };
}

test("changed source default + existing live value: preservation kept, mismatch visible to the agent", () => {
  const { panel } = panelWith([SPEED, tint(ORANGE)]);
  panel.applyExternal(1, BLUE); // the user (or MIDI) tuned the tint to blue
  panel.applyExternal(0, [1.5]);
  // The agent asks for green by editing the default; the recompile keeps blue.
  const next = [SPEED, tint([0, 1, 0])];
  panel.setManifest(next);
  const live = panel.values();
  assert.deepEqual(live.find((v) => v.slot === 1)!.value, BLUE, "intended preservation unchanged");
  const note = retainedLiveNote(next, live);
  assert.match(note, /tint live \(0\.2, 0\.6, 1\) vs default \(0, 1, 0\)/);
  assert.match(note, /speed live 1\.5 vs default 0\.6/);
  assert.match(note, /set_live_uniforms/);
  const ctx = describeLiveUniforms(next, live);
  assert.match(ctx, /EFFECTIVE values/);
  assert.match(ctx, /- tint \(color\): live \(0\.2, 0\.6, 1\); source default \(0, 1, 0\) ← LIVE DIFFERS FROM DEFAULT/);
  // ...and it rides in the turn's editor context, distinct from the source.
  const turn = editorContext({ source: "uniform vec3 tint = …", compileSummary: "OK", liveUniforms: ctx });
  assert.ok(turn.indexOf("Latest compile result") < turn.indexOf("Live uniform values"));
});

test("an unrelated source edit raises no live-value note", () => {
  const { panel } = panelWith([SPEED, tint(ORANGE)]);
  panel.setManifest([SPEED, tint(ORANGE)]);
  assert.equal(retainedLiveNote([SPEED, tint(ORANGE)], panel.values()), "");
  assert.match(describeLiveUniforms([SPEED, tint(ORANGE)], panel.values()), /All live values equal their source defaults/);
  assert.equal(describeLiveUniforms([], []), "");
});

test("set/reset changes only the named uniforms; the panel moves without firing onChange", () => {
  const manifest = [SPEED, tint([0, 1, 0])];
  const { panel, changes } = panelWith(manifest);
  panel.applyExternal(0, [2.2]); // unrelated user tuning
  panel.applyExternal(1, BLUE);
  const before = changes.length;
  const plan = planLiveUniformChange(manifest, panel.values(), parseLiveUniformCall({ reset: ["tint"] }));
  assert.deepEqual(
    plan.changes.map((c) => [c.name, c.to, c.reset]),
    [["tint", [0, 1, 0], true]],
  );
  for (const c of plan.changes) assert.ok(panel.setLive(c.slot, c.to));
  assert.equal(changes.length, before, "setLive leaves the sinks to the caller");
  assert.deepEqual(panel.values(), [
    { slot: 0, value: [2.2] },
    { slot: 1, value: [0, 1, 0] },
  ]);
  // A set clamps into range and fills a vector from one number; unknowns reported.
  const p2 = planLiveUniformChange(
    manifest,
    panel.values(),
    parseLiveUniformCall({ set: [{ name: "tint", value: 1 }, { name: "speed", value: [9] }, { name: "nope", value: [1] }] }),
  );
  assert.deepEqual(
    p2.changes.map((c) => [c.name, c.to, c.clamped]),
    [
      ["speed", [3], true],
      ["tint", [1, 1, 1], false],
    ],
  );
  assert.deepEqual(p2.unknown, ["nope"]);
  // reset_all is explicit; a set wins over a reset of the same name.
  const p3 = planLiveUniformChange(manifest, [{ slot: 0, value: [2.2] }, { slot: 1, value: BLUE }], {
    set: [{ name: "tint", value: [1, 0, 0] }],
    reset: [],
    resetAll: true,
  });
  assert.deepEqual(
    p3.changes.map((c) => [c.name, c.to]),
    [
      ["speed", [0.6]],
      ["tint", [1, 0, 0]],
    ],
  );
  // Wrong arity is rejected rather than guessed.
  const p4 = planLiveUniformChange(manifest, panel.values(), parseLiveUniformCall({ set: [{ name: "tint", value: [1, 0] }] }));
  assert.deepEqual(p4.invalid, ["tint (needs 3 components, got 2)"]);
});

test("colour + MIDI: the mapping is kept and the override risk is stated", () => {
  const manifest = [SPEED, tint(ORANGE)];
  const bindings = [{ uniform: "tint", semantic: "hue knob" }];
  assert.match(describeLiveUniforms(manifest, [{ slot: 1, value: BLUE }], bindings), /\[MIDI-mapped to "hue knob"\]/);
  const plan = planLiveUniformChange(manifest, [{ slot: 1, value: BLUE }], parseLiveUniformCall({ set: [{ name: "tint", value: [0, 1, 0] }] }));
  const text = describeLiveUniformResult(plan, { preview: true, device: "sent", midiBound: bindings });
  assert.match(text, /tint \(0\.2, 0\.6, 1\) → \(0, 1, 0\)/);
  assert.match(text, /tint is MIDI-mapped to "hue knob" — moving that control will override this value again\. The mapping was left unchanged\./);
  assert.match(text, /Other uniforms and MIDI mappings were not touched/);
  assert.deepEqual(bindings, [{ uniform: "tint", semantic: "hue knob" }]);
});

test("connected vs disconnected fixtures: the result says honestly where values went", () => {
  const base = { demo: false, connected: true, runningEffectId: "fx", effectId: "fx", pushedCurrent: true };
  assert.equal(liveDeviceSink(base), "sent");
  assert.equal(liveDeviceSink({ ...base, pushedCurrent: false }), "sent-maybe-stale");
  assert.equal(liveDeviceSink({ ...base, connected: false }), "not-connected");
  assert.equal(liveDeviceSink({ ...base, runningEffectId: "other" }), "other-effect");
  assert.equal(liveDeviceSink({ ...base, runningEffectId: null }), "unknown-effect");
  assert.equal(liveDeviceSink({ ...base, demo: true }), "demo");
  const plan = planLiveUniformChange([SPEED], [], parseLiveUniformCall({ set: [{ name: "speed", value: [1] }] }));
  assert.match(describeLiveUniformResult(plan, { preview: true, device: "sent" }), /Sent to the connected fixture/);
  assert.match(describeLiveUniformResult(plan, { preview: true, device: "not-connected" }), /No fixture is connected: NOT sent/);
  assert.match(describeLiveUniformResult(plan, { preview: true, device: "other-effect" }), /DIFFERENT effect: NOT sent/);
  assert.match(describeLiveUniformResult(plan, { preview: false, device: "not-connected" }), /preview is not running/);
  const none = planLiveUniformChange([SPEED], [{ slot: 0, value: [0.6] }], parseLiveUniformCall({ reset: ["speed"] }));
  assert.match(describeLiveUniformResult(none, { preview: true, device: "sent" }), /no live value changed[\s\S]*Already at the requested value: speed/);
});

test("the tool is advertised only with its hook, and the agent's call reaches it", async () => {
  assert.ok(!selectTools({ tools: true, vision: true }, { perf: false, midi: false }).some((t) => t.name === "set_live_uniforms"));
  assert.ok(
    selectTools({ tools: true, vision: true }, { perf: false, midi: false, liveUniforms: true }).some(
      (t) => t.name === "set_live_uniforms",
    ),
  );
  const seen: SendOptions[] = [];
  let n = 0;
  const provider: AiProvider = {
    id: "openai",
    capabilities: { tools: true, vision: false },
    async send(_m: ChatMessage[], opts: SendOptions) {
      seen.push(opts);
      n++;
      return n === 1
        ? {
            content: [{ type: "tool_use", id: "u1", name: "set_live_uniforms", input: { set: [{ name: "tint", value: [0, 0, 1] }] } }],
            stop_reason: "tool_use",
          }
        : { content: [{ type: "text", text: "The live tint is now blue." }], stop_reason: "end_turn" };
    },
  };
  const calls: LiveUniformCall[] = [];
  const hooks: ChatHooks = {
    onSetScript: async () => "ok",
    onCapturePreview: async () => "data:image/png;base64,AA",
    onSetLiveUniforms: async (c) => {
      calls.push(c);
      return "set_live_uniforms: tint → (0, 0, 1). Sent to the connected fixture.";
    },
  };
  const r = await runChatTurn([{ role: "user", content: "make it blue" }], hooks, undefined, undefined, provider);
  assert.equal(r.outcome, "complete");
  assert.deepEqual(calls, [{ set: [{ name: "tint", value: [0, 0, 1] }], reset: [], resetAll: false }]);
  assert.ok(seen[0]!.system.includes(LIVE_UNIFORMS_GUIDE));
  assert.ok(seen[0]!.tools.some((t) => t.name === "set_live_uniforms"));
});
