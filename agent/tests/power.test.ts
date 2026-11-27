/**
 * Lamp power through the bridge (docs/design/lamp-power.md): get_power shaping,
 * set_power (on / off / toggle / instant / duration), set_transitions (fade,
 * an effect stored with submit_effect{powerSlot} + its config, a keypoint's look
 * resolved to the effect's slots, a library entry, clear), the feature gate,
 * and the MCP tools end to end. Skipped as a whole when this bundle's protocol
 * predates the power arms.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadFxHost } from "../src/fxhost";
import { localLibrary } from "../src/libraryLocal";
import { createServer } from "../src/server";
import { DeviceSession, POWER_IN_PROTO } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { FakePlayer, TEST_CERT_SHA256 } from "./fakePlayer";
import type { CompileOutcome } from "../src/fxhost";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";
const skip = POWER_IN_PROTO ? false : "this bundle's protocol has no lamp power arms yet";

const BLOOM = `
uniform float power : 0.0 .. 1.0 = 1.0;
uniform float spread : 0.1 .. 2.0 = 0.8;
uniform vec3 tint : color = 1.0, 0.6, 0.2;
vec3 shade(Led led) { return tint * clamp(power * spread - length(led.pos), 0.0, 1.0); }
`;

let player: FakePlayer;

async function connect(features: string[]): Promise<DeviceSession> {
  const s = new DeviceSession({
    url: `wss://${player.host}/ws`,
    socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }),
    features,
  });
  await s.connect();
  return s;
}

before(async () => {
  await loadFxHost(WASM_ROOT);
});

beforeEach(async () => {
  player = new FakePlayer();
  player.features = [...player.features, "power", "keypoints"];
  await player.start();
});

afterEach(async () => {
  await player.stop();
});

const sent = (type: string): Record<string, unknown>[] => player.received.filter((m) => m.type === type);

test("get_power: state, transitions and the trigger wired to power", { skip }, async () => {
  player.power = { ...player.power, toggleTrigger: "touch_tap", triggerCount: 4, source: 2 };
  const s = await connect(["power"]);
  const r = await s.getPower();
  assert.equal(r["on"], true);
  assert.equal(r["phase"], "on");
  assert.equal(r["last_change"], "trigger");
  assert.equal(r["boot"], "last");
  assert.deepEqual(r["on_transition"], { style: "fade", duration_s: 0.7, duration_note: "device default" });
  assert.deepEqual(r["toggle_trigger"], { name: "touch_tap", fired_since_boot: 4 });
  s.close();
});

test("set_power: off, toggle, instant + duration go out as asked", { skip }, async () => {
  const s = await connect(["power"]);
  let r = await s.setPower({ on: false });
  assert.equal(r["on"], false);
  assert.equal(r["phase"], "off");
  // The fake decodes with proto3 implicit defaults: compare what was asked.
  const first = sent("set_power")[0]!;
  assert.equal(first["on"], false);
  assert.ok(!first["toggle"] && !first["instant"] && !first["durationMs"]);
  r = await s.setPower({ toggle: true, instant: true });
  assert.equal(r["on"], true);
  assert.equal(sent("set_power")[1]!["toggle"], true);
  assert.equal(sent("set_power")[1]!["instant"], true);
  await s.setPower({ on: true, durationS: 2.5 });
  assert.equal(sent("set_power")[2]!["durationMs"], 2500);
  await assert.rejects(s.setPower({}), /on: true \/ false, or toggle/);
  s.close();
});

test("firmware without power gets a clear error and nothing is sent", { skip }, async () => {
  player.features = player.features.filter((f) => f !== "power");
  const s = await connect([]);
  await assert.rejects(s.getPower(), /too old for power/);
  await assert.rejects(s.setPower({ on: false }), /too old for power/);
  await assert.rejects(s.setTransitions({ on: { style: "fade" } }), /too old for power/);
  assert.equal(sent("set_power").length + sent("get_power").length + sent("set_power_config").length, 0);
  s.close();
});

async function mcp(features: string[], library = false) {
  const session = await connect(features);
  const server = createServer(session, library ? { library: localLibrary(null) } : {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "power-test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
    const text = r.content[0]?.text ?? "";
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: r.isError === true, text, json };
  };
  return {
    call,
    client,
    session,
    close: async () => {
      await client.close();
      session.close();
    },
  };
}

test("set_transitions: fade both ways + boot off", { skip }, async () => {
  const m = await mcp(["power"]);
  const r = await m.call("set_transitions", { on: { duration_s: 1.5 }, off: { style: "cut" }, boot: "off" });
  assert.equal(r.isError, false, r.text);
  const cfg = sent("set_power_config")[0]!;
  const onT = cfg["onTransition"] as Record<string, unknown>;
  const offT = cfg["offTransition"] as Record<string, unknown>;
  assert.equal(onT["style"], 1);
  assert.equal(onT["durationMs"], 1500);
  assert.equal(offT["style"] ?? 0, 0);
  assert.equal(cfg["boot"], 2);
  assert.equal(sent("submit_effect").length, 0, "a fade stores no effect");
  assert.equal(r.json.boot, "off");
  assert.equal(r.json.on_transition.style, "fade");
  assert.equal(r.json.off_transition.style, "cut");
  await m.close();
});

test("set_transitions: an effect with a keypoint's look is stored, then configured", { skip }, async () => {
  // A saved look of the bloom effect on the lamp (by uniform name).
  player.keypoints.set("bloom", new Map([["warm", { index: 0, values: { spread: [1.5], tint: [1, 0.3, 0.1], gone: [1] } }]]));
  const m = await mcp(["power", "keypoints"]);
  const r = await m.call("set_transitions", {
    on: { effect_id: "bloom", source: BLOOM, keypoint: "warm", duration_s: 2 },
  });
  assert.equal(r.isError, false, r.text);
  // The .fxb went out as a power_slot=1 submit (chunked or not), parked-safe for old firmware.
  const stored = player.powerEffects.get(1);
  assert.ok(stored, "the ON transition effect is stored");
  assert.equal(stored!.id, "bloom");
  const sub = player.received.find((x) => x.type === "submit_effect" && x["powerSlot"] === 1)!;
  assert.equal(sub["deck"], 1);
  assert.equal(sub["activate"] ?? false, false);
  const cfg = sent("set_power_config")[0]!;
  const on = cfg["onTransition"] as Record<string, unknown>;
  assert.equal(on["style"], 2);
  assert.equal(on["durationMs"], 2000);
  assert.equal(on["label"], "warm");
  // spread + tint resolved to the effect's slots; `gone` (not declared) dropped.
  const uniforms = on["uniforms"] as { slot: number; value: number[] }[];
  assert.equal(uniforms.length, 2);
  assert.deepEqual(uniforms.map((u) => u.value.length).sort(), [1, 3]);
  assert.equal("offTransition" in cfg, false);
  assert.equal(r.json.on_transition.style, "effect");
  assert.equal(r.json.on_transition.stored_effect, "bloom");
  assert.equal(r.json.on_transition.look, "warm");
  assert.equal(r.json.stored_effects.on, "bloom");
  await m.close();
});

test("set_transitions: a missing keypoint says how to make one", { skip }, async () => {
  const m = await mcp(["power", "keypoints"]);
  const r = await m.call("set_transitions", { off: { effect_id: "bloom", source: BLOOM, keypoint: "nope" } });
  assert.equal(r.isError, true);
  assert.match(r.text, /no keypoint "nope".*save_keypoint/s);
  assert.equal(sent("set_power_config").length, 0);
  await m.close();
});

test("set_transitions: a library entry becomes the OFF effect; clear forgets it", { skip }, async () => {
  const m = await mcp(["power"], true);
  const saved = await m.call("save_effect", {
    name: "Bloom out",
    description: "Warm light shrinking to the centre and going dark; a lamp switch-off transition",
    tags: ["transition", "bloom"],
    source: BLOOM,
  });
  assert.equal(saved.isError, false, saved.text);
  const r = await m.call("set_transitions", { off: { library_id: saved.json.id, uniforms: { spread: 1.2 } } });
  assert.equal(r.isError, false, r.text);
  assert.equal(player.powerEffects.get(2)?.id, r.json.stored_effects.off);
  const off = sent("set_power_config")[0]!["offTransition"] as Record<string, unknown>;
  assert.equal(off["style"], 2);
  assert.equal((off["uniforms"] as unknown[]).length, 1);

  const bad = await m.call("set_transitions", { off: { style: "fade", source: BLOOM } });
  assert.equal(bad.isError, true, "an effect needs style effect");

  const cleared = await m.call("set_transitions", { clear_effects: "off" });
  assert.equal(cleared.isError, false, cleared.text);
  assert.equal(sent("set_power_config")[1]!["clearEffects"], 2);
  assert.equal(player.powerEffects.has(2), false);
  await m.close();
});

test("MCP: set_power / get_power and the descriptions an assistant picks transitions by", { skip }, async () => {
  const m = await mcp(["power"]);
  const tools = (await m.client.listTools()).tools;
  const desc = tools.find((t) => t.name === "set_transitions")!.description ?? "";
  for (const want of [/search_effects/, /uniform float power/, /uniform float transition/, /bloom/, /safe default/]) {
    assert.match(desc, want);
  }
  assert.match(tools.find((t) => t.name === "set_power")!.description ?? "", /stays connected/);
  const off = await m.call("set_power", { on: false });
  assert.equal(off.isError, false, off.text);
  assert.equal(off.json.on, false);
  const got = await m.call("get_power");
  assert.equal(got.json.phase, "off");
  assert.equal(got.json.last_change, "app/agent");
  await m.close();
});

/** The driver compiler stubbed: the fx_compiler support for gpio_mode / gpio_read /
 * `trigger` lands separately, so these tests check the plumbing, not the bytecode. */
function stubDriverCompile(session: DeviceSession, seen: string[], ok = true): void {
  session.driverCompile = async (source: string): Promise<CompileOutcome> => {
    seen.push(source);
    return {
      ok,
      diagnostics: ok ? [] : [{ line: 1, col: 1, msg: "unknown function gpio_mode" }],
      warnings: [],
      uniforms: [],
      bytecodeBytes: 4,
      textures: [],
      fxb: new Uint8Array([1, 2, 3, 4]),
    };
  };
}

test("setup_touch_sensor: generates the TTP223 driver, loads it, binds its trigger to power", { skip }, async () => {
  const m = await mcp(["power", "drivers"]);
  const seen: string[] = [];
  stubDriverCompile(m.session, seen);
  const r = await m.call("setup_touch_sensor", { gpio: 3, active_low: true, mode: "toggle" });
  assert.equal(r.isError, false, r.text);
  const src = seen[0]!;
  assert.match(src, /export trigger touch_tap;/);
  assert.match(src, /gpio_mode\(3, 1\)/, "active-low: pull-up toward idle");
  assert.match(src, /gpio_read\(3\)/);
  assert.match(src, /fire\(touch_tap\)/);
  const sub = sent("submit_driver")[0]!;
  assert.equal(sub["pollIntervalMs"], 10);
  assert.equal(sent("set_power_config")[0]!["toggleTrigger"], "touch_tap");
  assert.equal(r.json.trigger, "touch_tap");
  assert.equal(r.json.polarity, "active-low");
  assert.equal(r.json.mode, "toggle");
  assert.match(r.json.wiring, /3V3.*GPIO 3/);
  assert.deepEqual(r.json.power.toggle_trigger, { name: "touch_tap", fired_since_boot: 0 });
  assert.equal(r.json.driver.running, true);
  assert.equal("warning" in r.json, false, "no driver was loaded before");
  await m.close();
});

test("setup_touch_sensor: active-high pulls down; bind_power false leaves power alone; a bad name is refused", { skip }, async () => {
  const m = await mcp(["power", "drivers"]);
  const seen: string[] = [];
  stubDriverCompile(m.session, seen);
  const r = await m.call("setup_touch_sensor", { gpio: 22, export_name: "lid_tap", bind_power: false });
  assert.equal(r.isError, false, r.text);
  assert.match(seen[0]!, /gpio_mode\(22, 2\)/);
  assert.match(seen[0]!, /export trigger lid_tap;/);
  assert.equal(sent("set_power_config").length, 0);
  assert.equal("power" in r.json, false);
  const bad = await m.call("setup_touch_sensor", { gpio: 3, export_name: "9 bad" });
  assert.equal(bad.isError, true);
  assert.equal(sent("submit_driver").length, 1, "nothing loaded for the bad name");
  await m.close();
});

test("setup_touch_sensor: a compile failure loads nothing", { skip }, async () => {
  const m = await mcp(["power", "drivers"]);
  stubDriverCompile(m.session, [], false);
  const r = await m.call("setup_touch_sensor", { gpio: 3 });
  assert.equal(r.isError, true);
  assert.match(r.text, /doesn't compile/);
  assert.equal(sent("submit_driver").length + sent("set_power_config").length, 0);
  await m.close();
});

test("wire_trigger binds and unbinds a trigger", { skip }, async () => {
  const m = await mcp(["power"]);
  let r = await m.call("wire_trigger", { trigger: "knob_click", target: "power" });
  assert.equal(r.isError, false, r.text);
  assert.equal(sent("set_power_config")[0]!["toggleTrigger"], "knob_click");
  assert.equal(r.json.toggle_trigger.name, "knob_click");
  r = await m.call("wire_trigger", { target: "none" });
  assert.equal(r.isError, false, r.text);
  assert.equal(sent("set_power_config")[1]!["toggleTrigger"], "");
  assert.equal(r.json.toggle_trigger, null);
  await m.close();
});

test("setup_touch_sensor warns when it replaces another driver", { skip }, async () => {
  player.driver = { running: true, pollIntervalMs: 10, exports: [{ name: "imu_ok", value: [1] }] };
  const m = await mcp(["power", "drivers"]);
  stubDriverCompile(m.session, []);
  const r = await m.call("setup_touch_sensor", { gpio: 3 });
  assert.equal(r.isError, false, r.text);
  assert.match(r.json.warning, /replaced .*imu_ok/);
  const tools = (await m.client.listTools()).tools;
  const desc = tools.find((t) => t.name === "setup_touch_sensor")!.description ?? "";
  for (const want of [/momentary, active-high/, /A bridged = active_low/, /self-lock/, /3V3/, /GND \/ I\/O \/ VCC/, /1 s after power-up/, /ONE sensor driver/]) {
    assert.match(desc, want);
  }
  await m.close();
});

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("onPowerState: get_power on every (re)connect subscribes; pushes reach subscribers across a reconnect", { skip }, async () => {
  const s = await connect(["power"]);
  const seen: { on: boolean; seq: number }[] = [];
  const off = s.onPowerState((st) => seen.push({ on: st.on, seq: st.seq }));
  await until(() => sent("get_power").length === 1);
  await until(() => s.powerState !== null);
  player.pushPowerState({ on: false, phase: 0, source: 2 });
  await until(() => seen.some((x) => !x.on));
  player.dropSessions();
  await until(() => sent("get_power").length === 2, 15000);
  player.pushPowerState({ on: true, phase: 1, source: 2 });
  await until(() => seen.at(-1)?.on === true);
  assert.equal(s.powerState!.on, true);
  off();
  const n = seen.length;
  player.pushPowerState({ on: false, phase: 0 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(seen.length, n, "unsubscribed");
  s.close();
});
