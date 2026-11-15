/**
 * Scheduled changes (apply_at; docs/design/synced-show.md): the planner's rules,
 * and through the MCP tools against fake players with different clocks — a change
 * to several players carries ONE instant on the shared time base (the same hub
 * time on every player once its epoch is folded in), a lead ahead; ramps and
 * crossfades schedule every step; players without the feature apply on arrival and
 * the result says so; a single player is untouched unless asked.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, before, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { localLibrary } from "../src/libraryLocal";
import { applyAtOf, DEFAULT_LEAD_MS, needsAlign, planSchedule, type ScheduleCandidate } from "../src/schedule";
import { createServer } from "../src/server";
import { DECKS_IN_PROTO } from "../src/session";
import { FakePlayer, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-schedule-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");

const FEATURES = ["effects", "perf", "stored_map", "list_effects", "decks", "crossfade", "time_base", "uniform_commit"];
const SCHED = [...FEATURES, "apply_at"];

const CALM = `
uniform float level : 0.0 .. 1.0 = 0.3;
vec3 shade(Led led) { return vec3(0.0, 0.0, level); }
`;
const STORM = `
uniform float rain : 0.0 .. 1.0 = 0.8;
vec3 shade(Led led) { return vec3(rain, rain, 1.0); }
`;

type Text = { type: string; text?: string };

/** set_uniforms is fire-and-forget: give the fake player a moment to receive it. */
const settle = () => new Promise((r) => setTimeout(r, 60));

describe("planSchedule", () => {
  const c = (id: string, applyAt: boolean, epochHubMs: number | undefined): ScheduleCandidate => ({
    id,
    name: id,
    applyAt,
    epochHubMs,
  });

  test("several capable players: one instant, the default lead ahead", () => {
    const p = planSchedule([c("a", true, 100), c("b", true, 100)], undefined, 1000);
    assert.equal(p.leadMs, DEFAULT_LEAD_MS);
    assert.equal(p.scheduled.size, 2);
    assert.deepEqual(p.scheduled.get("a"), { atHubMs: 1150, epochHubMs: 100, leadMs: DEFAULT_LEAD_MS });
    assert.equal(applyAtOf(p.scheduled.get("a")!), 1050);
    // Players aligned at different times still land on the same hub instant.
    const q = planSchedule([c("a", true, 100), c("b", true, 400)], undefined, 1000);
    assert.equal(applyAtOf(q.scheduled.get("a")!) + 100, applyAtOf(q.scheduled.get("b")!) + 400);
  });

  test("default: one player, or any player that can't, means on arrival everywhere", () => {
    assert.equal(planSchedule([c("a", true, 0)], undefined, 0).leadMs, 0);
    const mixed = planSchedule([c("a", true, 0), c("b", false, 0)], undefined, 0);
    assert.equal(mixed.leadMs, 0);
    assert.equal(mixed.scheduled.size, 0);
    assert.match(mixed.note!, /b can't take a scheduled change/);
    const unaligned = planSchedule([c("a", true, 0), c("b", true, undefined)], undefined, 0);
    assert.equal(unaligned.leadMs, 0);
  });

  test("an explicit lead schedules who can and names the rest; 0 = on arrival; capped", () => {
    const p = planSchedule([c("a", true, 0), c("b", false, 0)], 300, 1000);
    assert.equal(p.leadMs, 300);
    assert.deepEqual([...p.scheduled.keys()], ["a"]);
    assert.deepEqual(p.immediate, ["b"]);
    assert.match(p.note!, /b applied on arrival/);
    assert.equal(planSchedule([c("a", true, 0)], 250, 0).scheduled.size, 1, "a single player when asked");
    assert.equal(planSchedule([c("a", true, 0), c("b", true, 0)], 0, 0).leadMs, 0);
    assert.equal(planSchedule([c("a", true, 0)], 1e9, 0).leadMs, 5000);
  });

  test("align first only when a capable target has no epoch", () => {
    assert.equal(needsAlign([c("a", true, 0), c("b", true, undefined)], undefined), true);
    assert.equal(needsAlign([c("a", true, 0), c("b", false, undefined)], undefined), false);
    assert.equal(needsAlign([c("a", true, undefined)], undefined), false, "one player, default: no schedule");
    assert.equal(needsAlign([c("a", true, undefined)], 100), true);
    assert.equal(needsAlign([c("a", true, undefined), c("b", true, undefined)], 0), false);
  });
});

describe("scheduled tools (MCP, several players)", { skip: DECKS_IN_PROTO ? false : "no FX decks in this bundle" }, () => {
  let players: FakePlayer[] = [];
  let hub: Hub;
  let client: Client;

  before(async () => {
    await loadFxHost(WASM_ROOT);
  });

  async function newPlayer(features: string[], name: string, mac: string): Promise<FakePlayer> {
    const p = new FakePlayer({ name, mac });
    p.features = features;
    p.bundle = yFixture();
    await p.start();
    p.serveManifest();
    return p;
  }

  async function open(features: [string[], string[]]) {
    players = [
      await newPlayer(features[0], "Fixture A", "CC:FD:49:00:00:11"),
      await newPlayer(features[1], "Fixture B", "CC:FD:49:00:00:12"),
    ];
    players[1]!.clockOffsetMs = 98_765;
    hub = new Hub({
      root: WASM_ROOT,
      hosts: players.map((p) => p.host),
      mdns: false,
      config: { players: {}, groups: {}, poses: {} },
      persist: () => undefined,
      registryDeps: { sweepHosts: () => [] },
    });
    const server = createServer(hub, { library: localLibrary(null) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "schedule-test", version: "0" });
    await client.connect(b);
  }

  beforeEach(() => {
    players = [];
  });
  afterEach(async () => {
    await client?.close();
    hub?.close();
    for (const p of players) await p.stop();
  });

  async function call(name: string, args: Record<string, unknown> = {}) {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Text[] };
    const text = r.content.find((x) => x.type === "text")?.text ?? "";
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* error text */
    }
    return { isError: r.isError === true, text, json };
  }

  const dues = (type: string) => players.map((p) => p.scheduled.filter((s) => s.type === type));

  test("set_uniforms / set_brightness / set_effect: one instant everywhere, a lead ahead", async () => {
    await open([SCHED, SCHED]);
    const dep = await call("deploy_effect", { effect_id: "calm", source: CALM, players: "all" });
    assert.equal(dep.isError, false, dep.text);

    const t0 = performance.now();
    const r = await call("set_uniforms", { values: { level: 0.9 }, players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.schedule.lead_ms, DEFAULT_LEAD_MS);
    assert.equal(r.json.schedule.scheduled, 2);
    await settle();
    const [a, b] = dues("set_uniforms").map((x) => x[x.length - 1]!);
    assert.ok(a && b, "both got a scheduled set_uniforms");
    assert.ok(Math.abs(a.dueHubMs - b.dueHubMs) <= 2, `same instant: ${a.dueHubMs} vs ${b.dueHubMs}`);
    assert.ok(a.dueHubMs >= t0 + DEFAULT_LEAD_MS - 5 && a.dueHubMs <= performance.now() + DEFAULT_LEAD_MS + 5);
    assert.ok(a.at < a.dueHubMs && b.at < b.dueHubMs, "arrived before it is due");

    const br = await call("set_brightness", { level: 0.4, players: "all" });
    assert.equal(br.isError, false, br.text);
    assert.equal(br.json.results[0].result.brightness, 0.4, "reports the level asked for");
    const [ba, bb] = dues("set_brightness").map((x) => x[0]!);
    assert.ok(Math.abs(ba!.dueHubMs - bb!.dueHubMs) <= 2);

    const off = await call("set_effect", { effect_id: "off", players: "all" });
    assert.equal(off.isError, false, off.text);
    const [ea, eb] = dues("set_effect").map((x) => x[0]!);
    assert.ok(Math.abs(ea!.dueHubMs - eb!.dueHubMs) <= 2);

    // lead_ms 0: on arrival, as before.
    const n = players[0]!.scheduled.length;
    const now = await call("set_brightness", { level: 1, lead_ms: 0, players: "all" });
    assert.equal(now.json.schedule, undefined);
    assert.equal(players[0]!.scheduled.length, n);
  });

  test("a single player is untouched unless lead_ms asks", async () => {
    await open([SCHED, SCHED]);
    await call("deploy_effect", { effect_id: "calm", source: CALM, players: "Fixture A" });
    const r = await call("set_uniforms", { values: { level: 0.2 }, players: "Fixture A" });
    assert.equal(r.isError, false, r.text);
    await settle();
    assert.equal(players[0]!.scheduled.length, 0);
    const asked = await call("set_uniforms", { values: { level: 0.3 }, lead_ms: 300, players: "Fixture A" });
    assert.equal(asked.isError, false, asked.text);
    assert.ok(asked.json.time_base, "aligned its time base first");
    await settle();
    assert.equal(players[0]!.scheduled.length, 1);
  });

  test("firmware without apply_at: on arrival everywhere by default; an explicit lead names it", async () => {
    await open([SCHED, FEATURES]);
    await call("deploy_effect", { effect_id: "calm", source: CALM, players: "all" });
    const r = await call("set_uniforms", { values: { level: 0.5 }, players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.schedule.applied, "on arrival");
    assert.match(r.json.schedule.note, /Fixture B/);
    await settle();
    assert.equal(players[0]!.scheduled.length, 0);
    const lead = await call("set_uniforms", { values: { level: 0.6 }, lead_ms: 200, players: "all" });
    assert.deepEqual(lead.json.schedule.on_arrival, ["Fixture B"]);
    await settle();
    assert.equal(players[0]!.scheduled.length, 1);
    assert.equal(players[1]!.received.filter((m) => m["applyAtMs"] !== undefined).length, 0);
  });

  test("ramp_uniforms: every step scheduled on one timeline; the final commit lands together", async () => {
    await open([SCHED, SCHED]);
    await call("deploy_effect", { effect_id: "calm", source: CALM, players: "all" });
    const t0 = performance.now();
    const r = await call("ramp_uniforms", { targets: { level: 1 }, seconds: 0.5, players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.ok(performance.now() - t0 >= 450, "returns when the ramp is done");
    for (const x of r.json.results) assert.equal(x.result.scheduled, true);
    const [a, b] = dues("set_uniforms");
    assert.ok(a!.length >= 4 && b!.length >= 4, `steps: ${a!.length}, ${b!.length}`);
    for (const xs of [a!, b!]) {
      for (let i = 1; i < xs.length; i++) assert.ok(xs[i]!.dueHubMs > xs[i - 1]!.dueHubMs, "steps in time order");
      for (const x of xs) assert.ok(x.at < x.dueHubMs, "each step sent ahead of its instant");
    }
    const end = (xs: typeof a) => xs![xs!.length - 1]!.dueHubMs;
    assert.ok(Math.abs(end(a) - end(b)) <= 2, "the final commit lands together");
    const span = end(a) - a![0]!.dueHubMs;
    assert.ok(span > 300 && span <= 500, `the ramp spans its seconds on the shared base: ${span} ms`);
  });

  test("crossfade_to: each step and the landing are scheduled on the shared base", async () => {
    await open([SCHED, SCHED]);
    await call("deploy_effect", { effect_id: "calm", source: CALM, players: "all" });
    const r = await call("crossfade_to", { effect_id: "storm", source: STORM, seconds: 0.5, curve: "linear", players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.schedule.lead_ms, DEFAULT_LEAD_MS);
    const [a, b] = dues("set_crossfade");
    assert.ok(a!.length >= 3 && b!.length >= 3, `steps: ${a!.length}, ${b!.length}`);
    const last = (xs: typeof a) => xs![xs!.length - 1]!.dueHubMs;
    assert.ok(Math.abs(last(a) - last(b)) <= 2, "the landing is one instant");
    for (const p of players) assert.equal(p.crossfade, 1);
  });
});
