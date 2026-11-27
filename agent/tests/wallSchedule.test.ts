/**
 * Wall-clock schedules through the bridge (docs/design/schedule.md): the tools' rule
 * input, list / set / delete against a fake player (ask-first on overwrite and delete,
 * paging, ids, an effect stored first), and the live-show hold lease (D-567).
 * Skipped as a whole when this bundle's protocol predates the schedule arms.
 */

import assert from "node:assert/strict";
import { afterEach, before, beforeEach, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadFxHost } from "../src/fxhost";
import { createServer } from "../src/server";

import { SCHEDULE_HOLD_S, SCHEDULE_IN_PROTO, SCHEDULE_RENEW_MS, DeviceSession, ToolError } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { assignIds, daysFromInput, minuteFromInput, overwrites, ruleFromInput } from "../src/wallSchedule";
import { FakePlayer, TEST_CERT_SHA256 } from "./fakePlayer";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";
const skip = SCHEDULE_IN_PROTO ? false : "this bundle's protocol has no schedule arms yet";

before(async () => {
  await loadFxHost(WASM_ROOT);
});

let player: FakePlayer;

async function connect(): Promise<DeviceSession> {
  const s = new DeviceSession({
    url: `wss://${player.host}/ws`,
    socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }),
    features: player.features,
  });
  await s.connect();
  return s;
}

beforeEach(async () => {
  player = new FakePlayer();
  player.features = [...player.features, "wall_clock", "schedule"];
  await player.start();
});

afterEach(async () => {
  await player.stop();
});

const sent = (type: string) => player.received.filter((m) => m.type === type);

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const wake = (time = "07:00") =>
  ruleFromInput({ when: "time", time, days: "weekdays", action: { type: "power", on: true, fade_s: 30 } });

test("the tools' rule input: days, times, actions and their limits", () => {
  assert.equal(daysFromInput(undefined), 0);
  assert.equal(daysFromInput("weekdays"), 0b0111110);
  assert.equal(daysFromInput(["sat", "Sunday"]), 0b1000001);
  assert.equal(daysFromInput("mon, wed fri"), 0b0101010);
  assert.equal(daysFromInput(["weekdays", "weekends"]), 0, "all seven = every day");
  assert.throws(() => daysFromInput(["funday"]), /unknown day/);
  assert.equal(minuteFromInput("7:05"), 425);
  assert.throws(() => minuteFromInput("24:00"), /HH:MM/);
  const r = wake();
  assert.equal(r.minuteOfDay, 420);
  assert.deepEqual(r.action, { kind: "power", on: true, durationMs: 30_000 });
  const sun = ruleFromInput({
    when: "sunset",
    offset_min: -30,
    action: { type: "effect", effect_id: "embers" },
  });
  assert.equal(sun.offsetMin, -30);
  assert.deepEqual(sun.action, { kind: "effect", effectId: "embers", crossfadeMs: 5000 });
  assert.throws(() => ruleFromInput({ when: "time", action: { type: "trigger", name: "x" } }), /needs time/);
  assert.throws(
    () => ruleFromInput({ when: "time", time: "08:00", action: { type: "brightness", level: 1.5 } }),
    /brightness must be 0..1/,
  );
  // Ids: new rules take free ids around the existing and the explicit ones.
  const ids = assignIds([{ ...r, id: 1 }], [{ ...r, id: 0 }, { ...r, id: 2 }, { ...r, id: 0 }]).map((x) => x.id);
  assert.deepEqual(ids, [3, 2, 4]);
  assert.deepEqual(
    overwrites([{ ...r, id: 1 }, { ...r, id: 5 }], [{ ...r, id: 5 }, { ...r, id: 0 }]).map((x) => x.id),
    [5],
  );
});

test("set_schedule adds rules, asks before overwriting, pages a big replace", { skip }, async () => {
  const s = await connect();
  const empty = await s.listSchedules();
  assert.deepEqual(empty["rules"], []);
  assert.equal(empty["capacity"], 24);

  const v = await s.setSchedules([wake()]);
  assert.deepEqual(v["saved"], [1]);
  const rules = v["rules"] as Record<string, unknown>[];
  assert.equal(rules.length, 1);
  assert.equal(rules[0]!["summary"], "07:00 Mon–Fri · Turn on · fade 30 s");
  assert.equal(rules[0]!["time"], "07:00");

  // The same id again changes the user's rule: refused until they agree.
  await assert.rejects(s.setSchedules([{ ...wake("07:30"), id: 1 }]), (e: Error) => {
    assert.ok(e instanceof ToolError);
    assert.match(e.message, /overwrite 1 existing rule.*#1 "07:00 Mon–Fri/);
    assert.match(e.message, /Ask the user/);
    return true;
  });
  assert.equal(player.schedule.size, 1);
  await s.setSchedules([{ ...wake("07:30"), id: 1 }], { overwrite: true });
  assert.equal(player.schedule.get(1)!["minuteOfDay"], 450);

  // replace drops everything: also ask-first. Six rules go as 4 + 2 frames.
  await assert.rejects(s.setSchedules([wake()], { replace: true }), /replace 1 existing rule/);
  const before = sent("set_schedule").length;
  const six = Array.from({ length: 6 }, (_, i) => wake(`0${i}:15`));
  const r = await s.setSchedules(six, { replace: true, overwrite: true });
  const frames = sent("set_schedule").slice(before);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!["replaceAll"], true);
  assert.equal((frames[0]!["rules"] as unknown[]).length, 4);
  assert.notEqual(frames[1]!["replaceAll"], true);
  assert.equal((r["rules"] as unknown[]).length, 6, "list reads both pages");
  assert.deepEqual(r["saved"], [1, 2, 3, 4, 5, 6]);
  s.close();
});

test("delete_schedule says what it would delete until confirmed", { skip }, async () => {
  const s = await connect();
  await s.setSchedules([wake(), wake("22:00")]);
  await assert.rejects(s.deleteSchedules({ id: 2 }), /deletes #2 "22:00 Mon–Fri.*confirmed: true/);
  assert.equal(player.schedule.size, 2);
  await assert.rejects(s.deleteSchedules({ id: 9, confirmed: false }), /no rule #9/);
  const v = await s.deleteSchedules({ id: 2, confirmed: true });
  assert.equal((v["rules"] as unknown[]).length, 1);
  await s.deleteSchedules({ all: true, confirmed: true });
  assert.equal(player.schedule.size, 0);
  s.close();
});

test("a sun rule on a lamp without a location warns; an effect source is stored first", { skip }, async () => {
  player.features = [...player.features, "effect_store"];
  const s = await connect();
  const sun = ruleFromInput({ when: "sunrise", offset_min: 15, action: { type: "effect", effect_id: "dawn" } });
  const src = "vec3 shade(Led led) { return vec3(1.0, 0.5, 0.2); }";
  const v = await s.setSchedules([sun], { stores: [{ effectId: "dawn", name: "Dawn", source: src }] });
  assert.match(String(v["warning"]), /no location/);
  assert.equal(player.storedEffects.get("dawn"), "Dawn");
  const l = await s.listSchedules();
  assert.deepEqual(l["stored_effects"], [{ effect_id: "dawn", name: "Dawn" }]);
  assert.match(String(l["location"]), /not set/);
  assert.equal((l["rules"] as Record<string, unknown>[])[0]!["summary"], "15 min after sunrise · Every day · Effect dawn · crossfade 5 s");
  s.close();
});

test("a firmware without schedules says so", { skip }, async () => {
  player.features = player.features.filter((f) => f !== "schedule");
  const s = await connect();
  await assert.rejects(s.listSchedules(), /has no schedules/);
  s.close();
});

test("the Show Mode lock holds the lamp's rules: renewed lease, released at once (D-567)", { skip }, async () => {
  const s = await connect();
  const t0 = performance.now();
  s.syncScheduleHold(true, t0);
  await until(() => sent("set_schedule").length === 1);
  assert.equal(sent("set_schedule")[0]!["holdS"], SCHEDULE_HOLD_S);
  assert.ok(player.scheduleHoldUntil > Date.now() + 100_000);
  // Every lock sync (~2 s) calls it: only a renewal interval later is it sent again.
  s.syncScheduleHold(true, t0 + 2000);
  s.syncScheduleHold(true, t0 + SCHEDULE_RENEW_MS - 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent("set_schedule").length, 1);
  s.syncScheduleHold(true, t0 + SCHEDULE_RENEW_MS);
  await until(() => sent("set_schedule").length === 2);
  // Unlocked: release_hold once, then nothing.
  s.syncScheduleHold(false, t0 + SCHEDULE_RENEW_MS + 2000);
  await until(() => sent("set_schedule").length === 3);
  assert.equal(sent("set_schedule")[2]!["releaseHold"], true);
  assert.equal(player.scheduleHoldUntil, 0);
  s.syncScheduleHold(false, t0 + SCHEDULE_RENEW_MS + 4000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent("set_schedule").length, 3);
  s.close();
});

test("the MCP tools end to end: add, list, ask-first, delete", { skip }, async () => {
  const session = await connect();
  const server = createServer(session, {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schedule-test", version: "0" });
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
  const add = await call("set_schedule", {
    rules: [
      { when: "time", time: "06:45", days: ["mon", "tue"], action: { type: "brightness", level: 0.8, ramp_s: 600 } },
      { when: "sunset", offset_min: -30, label: "Evening", action: { type: "trigger", name: "dusk" } },
    ],
  });
  assert.equal(add.isError, false, add.text);
  assert.deepEqual(add.json.saved, [1, 2]);
  assert.equal(player.schedule.get(1)!["brightness"] !== undefined, true);
  assert.equal(player.schedule.get(2)!["when"], "SCHEDULE_WHEN_SUNSET");
  assert.equal(player.schedule.get(2)!["offsetMin"], -30);
  const list = await call("list_schedules");
  assert.equal(list.json.rules[0].summary, "06:45 Mon, Tue · Brightness 80% over 10 min");
  assert.equal(list.json.rules[1].summary, "30 min before sunset · Every day · Trigger dusk");
  const over = await call("set_schedule", {
    rules: [{ id: 2, when: "sunset", action: { type: "power", on: true } }],
  });
  assert.equal(over.isError, true);
  assert.match(over.text, /Ask the user/);
  const del = await call("delete_schedule", { id: 1 });
  assert.equal(del.isError, true);
  assert.match(del.text, /confirmed: true/);
  const ok = await call("delete_schedule", { id: 1, confirmed: true });
  assert.equal(ok.isError, false, ok.text);
  assert.equal(player.schedule.size, 1);
  await client.close();
  session.close();
});
