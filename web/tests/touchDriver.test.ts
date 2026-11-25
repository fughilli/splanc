/**
 * The TTP223 touch driver template (src/power/touchDriver.ts), the Sensors
 * assistant's pure parts (src/power/sensorAgent.ts) and the kit definitions
 * (src/kits/kits.ts) — docs/design/lamp-power.md, owner decision D-185.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_TOUCH_TRIGGER,
  TOUCH_MODE_MOMENTARY,
  TOUCH_MODE_TOGGLE,
  setUpTouch,
  touchConfigError,
  touchDriverSource,
  triggerExportCount,
  triggerName,
} from "../src/power/touchDriver";
import { describeTouch, parseTouchProposal, runSensorTurn, SENSOR_TOOLS } from "../src/power/sensorAgent";
import { KITS, KIT_LINK_VERSION, kitById, kitUrl } from "../src/kits/kits";
import type { ChatMessage, SendOptions, SendResult } from "../src/effects/ai/provider";

/** //firmware/sensor:drivers/ttp223_touch.fx (bazel copies it next to the tests). */
function canonical(): string {
  const rel = "firmware/sensor/drivers/ttp223_touch.fx";
  const candidates = [
    resolve(__dirname, "../../firmware_drivers/ttp223_touch.fx"),
    resolve("web/firmware_drivers/ttp223_touch.fx"),
    resolve(__dirname, "../../..", rel),
    resolve(rel),
  ];
  const hit = candidates.find((p) => existsSync(p));
  assert.ok(hit, `canonical driver not found (${candidates.join(", ")})`);
  return readFileSync(hit, "utf8");
}

test("the defaults reproduce the canonical driver exactly", () => {
  const src = touchDriverSource({ gpio: 3, activeLow: false, mode: TOUCH_MODE_MOMENTARY, exportName: "touch_tap" });
  assert.equal(src, canonical());
  // exportName defaults to touch_tap.
  assert.equal(touchDriverSource({ gpio: 3, activeLow: false, mode: TOUCH_MODE_MOMENTARY }), src);
});

test("active-low pulls up and compares to 0; the pin is substituted everywhere", () => {
  const src = touchDriverSource({ gpio: 2, activeLow: true, mode: TOUCH_MODE_MOMENTARY });
  assert.match(src, /^\/\/ Touch sensor module \(TTP223\) on GPIO 2: active-low, momentary\.\n/);
  assert.match(src, /gpio_mode\(2, 1\) == 1/);
  assert.match(src, /gpio_read\(2\) == 0/);
  assert.doesNotMatch(src, /\(3,|\(3\)/);
  assert.match(src, /&& stable > 0\.5\) \{/);
  assert.match(src, /if \(stable < 0\.5\) \{\n {4}armed = 1\.0;/);
});

test("toggle mode fires on every debounced change and arms after calibration", () => {
  const src = touchDriverSource({ gpio: 3, activeLow: false, mode: TOUCH_MODE_TOGGLE, exportName: "lid" });
  assert.match(src, /active-high, toggle\./);
  assert.match(src, /export trigger lid;/);
  assert.match(src, /fire\(lid\);/);
  assert.match(src, /if \(armed > 0\.5 && since_fire >= 0\.15\) \{/);
  assert.doesNotMatch(src, /stable > 0\.5/);
  assert.match(src, /\n {2}armed = 1\.0;\n\}\n$/);
  // The calibration window is kept in every variant.
  assert.match(src, /uptime < 1\.0/);
});

test("config validation + trigger names", () => {
  assert.equal(touchConfigError({ gpio: 3, activeLow: false, mode: 0 }), null);
  assert.ok(touchConfigError({ gpio: -1, activeLow: false, mode: 0 }));
  assert.ok(touchConfigError({ gpio: 3, activeLow: false, mode: 5 }));
  assert.throws(() => touchDriverSource({ gpio: 99, activeLow: false, mode: 0 }));
  assert.equal(triggerName("lid_tap"), "lid_tap");
  assert.equal(triggerName("bad name"), DEFAULT_TOUCH_TRIGGER);
  assert.equal(triggerName("9x"), DEFAULT_TOUCH_TRIGGER);
  assert.equal(triggerName(undefined), DEFAULT_TOUCH_TRIGGER);
  assert.equal(triggerExportCount([{ name: "touch_tap", value: [4] }], "touch_tap"), 4);
  assert.equal(triggerExportCount([{ name: "x", value: [] }], "x"), null);
  assert.equal(triggerExportCount([], "touch_tap"), null);
});

test("setUpTouch compiles, submits at 10 ms and binds the trigger (injected compile)", async () => {
  const calls: string[] = [];
  let compiled = "";
  const client = {
    async submitDriver(fxb: Uint8Array, poll?: number) {
      calls.push(`submit ${fxb.length} ${poll}`);
      return { running: true };
    },
    async setPowerConfig(cfg: { toggleTrigger?: string }) {
      calls.push(`bind ${cfg.toggleTrigger}`);
      return { toggleTrigger: cfg.toggleTrigger ?? "" };
    },
  };
  const r = await setUpTouch(
    client,
    async (src) => {
      compiled = src;
      return { ok: true, bytecode: new Uint8Array([1, 2, 3]) };
    },
    { gpio: 3, activeLow: false, mode: 0 },
  );
  assert.equal(r.trigger, "touch_tap");
  assert.equal(compiled, canonical());
  assert.deepEqual(calls, ["submit 3 10", "bind touch_tap"]);
  // A failed compile never reaches the lamp.
  calls.length = 0;
  await assert.rejects(
    setUpTouch(client, async () => ({ ok: false, bytecode: new Uint8Array(), error: "line 1: unknown gpio_mode" }), {
      gpio: 3,
      activeLow: false,
      mode: 0,
    }),
    /unknown gpio_mode/,
  );
  assert.deepEqual(calls, []);
  // A driver that didn't start never gets bound.
  const dead = { ...client, async submitDriver() { return { running: false }; } };
  await assert.rejects(setUpTouch(dead, async () => ({ ok: true, bytecode: new Uint8Array([1]) }), { gpio: 3, activeLow: false, mode: 0 }));
});

test("assistant proposals are validated against the free pins", () => {
  const ok = parseTouchProposal({ gpio: 3, active_low: false, mode: "momentary", why: "GPIO 3 is free" }, [2, 3]);
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.cfg, { gpio: 3, activeLow: false, mode: TOUCH_MODE_MOMENTARY, exportName: "touch_tap" });
    assert.equal(describeTouch(ok.cfg), 'TTP223 on GPIO 3, active-high, momentary; trigger "touch_tap" toggles the lamp');
  }
  const busy = parseTouchProposal({ gpio: 20, active_low: false, mode: "momentary" }, [2, 3]);
  assert.ok(!busy.ok && /isn't free/.test(busy.error));
  assert.ok(!parseTouchProposal({ gpio: "3", mode: "momentary" }, []).ok);
  assert.ok(!parseTouchProposal({ gpio: 3, mode: "latch" }, []).ok);
  const tog = parseTouchProposal({ gpio: 2, active_low: true, mode: "toggle", trigger: "lid" }, []);
  assert.ok(tog.ok && tog.cfg.mode === TOUCH_MODE_TOGGLE && tog.cfg.activeLow && tog.cfg.exportName === "lid");
  assert.deepEqual(
    SENSOR_TOOLS.map((t) => t.name),
    ["get_sensor_status", "propose_touch_setup"],
  );
});

test("runSensorTurn runs tools and returns the reply (fake provider)", async () => {
  const sent: SendOptions[] = [];
  const replies: SendResult[] = [
    {
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "t1", name: "get_sensor_status", input: {} },
      ],
      stop_reason: "tool_use",
    },
    { content: [{ type: "text", text: "Use GPIO 3." }], stop_reason: "end_turn" },
  ];
  const provider = {
    capabilities: { tools: true, vision: false },
    async send(_h: ChatMessage[], o: SendOptions) {
      sent.push(o);
      return replies.shift()!;
    },
  };
  const history: ChatMessage[] = [{ role: "user", content: "I have a TTP223" }];
  const ran: string[] = [];
  const text = await runSensorTurn(provider, history, async (name) => {
    ran.push(name);
    return { text: '{"free_pins":[3]}' };
  });
  assert.equal(text, "Let me look.\n\nUse GPIO 3.");
  assert.deepEqual(ran, ["get_sensor_status"]);
  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.tools.length, 2);
  // user, assistant(tool_use), user(tool_result), assistant
  assert.equal(history.length, 4);
  const tr = history[2]!.content as Array<{ type: string; tool_use_id?: string }>;
  assert.equal(tr[0]!.type, "tool_result");
  assert.equal(tr[0]!.tool_use_id, "t1");
  // A provider without tools gets none advertised.
  const plain = { capabilities: { tools: false, vision: false }, async send(_h: ChatMessage[], o: SendOptions) {
    assert.equal(o.tools.length, 0);
    return { content: [{ type: "text" as const, text: "hi" }], stop_reason: "end_turn" };
  } };
  assert.equal(await runSensorTurn(plain, [{ role: "user", content: "x" }], async () => ({ text: "" })), "hi");
});

test("kits: the COIL kit + its booklet URL", () => {
  const coil = kitById("coil");
  assert.ok(coil);
  assert.deepEqual(coil!.touch, { gpio: 3, activeLow: false, mode: TOUCH_MODE_MOMENTARY, exportName: "touch_tap" });
  assert.deepEqual(coil!.onTransition, { style: 1, durationMs: 700 });
  assert.deepEqual(coil!.offTransition, { style: 1, durationMs: 900 });
  assert.equal(kitById("nope"), null);
  assert.equal(kitById("toString"), null);
  assert.equal(kitById(undefined), null);
  assert.equal(kitUrl("coil"), `https://splanc.io/app/#/kit/coil?v=${KIT_LINK_VERSION}`);
  assert.equal(kitUrl("coil", "http://localhost:5173/"), "http://localhost:5173/#/kit/coil?v=1");
  for (const k of Object.values(KITS)) assert.equal(touchConfigError(k.touch), null);
});
