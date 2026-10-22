/**
 * Canned interpolation profiles through the bridge (docs/design/ramps.md),
 * against fake players: on firmware advertising "ramps" ramp_uniforms /
 * crossfade_to / blend_keypoints / rollback_effect send ONE request per player
 * and nothing streams while it runs; several players get one start in their own
 * clocks; a live set cancels a running ramp (the outcome says so); a link that
 * never pushes the completion still returns (unconfirmed); and older firmware
 * falls back to ACKNOWLEDGED, wall-clock-paced steps (no fire-and-forget flood).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, before, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { compile, loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { localLibrary } from "../src/libraryLocal";
import { createServer } from "../src/server";
import { CURVES, curveAt, curveWire, DeviceSession, RAMPS_IN_PROTO } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { FakePlayer, TEST_CERT_SHA256, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-ramps-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
const skip = RAMPS_IN_PROTO ? false : "this bundle's protocol has no ramp arms";

const OLD = ["effects", "perf", "stored_map", "list_effects", "decks", "crossfade", "time_base", "uniform_commit", "keypoints"];
const RAMPS = [...OLD, "ramps"];

const STORM = `
uniform float rain : 0.0 .. 1.0 = 0.2;
uniform float wind : 0.0 .. 1.0 = 0.0;
vec3 shade(Led led) { return vec3(rain, wind, 1.0); }
`;
const CALM = `
uniform float level : 0.0 .. 1.0 = 0.3;
vec3 shade(Led led) { return vec3(0.0, 0.0, level); }
`;

type Text = { type: string; text?: string };
const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function newPlayer(features: string[], name?: string, mac?: string): Promise<FakePlayer> {
  const p = new FakePlayer({ ...(name ? { name } : {}), ...(mac ? { mac } : {}) });
  p.features = features;
  p.bundle = yFixture();
  await p.start();
  p.serveManifest();
  return p;
}

async function connect(p: FakePlayer): Promise<DeviceSession> {
  const s = new DeviceSession({ url: `wss://${p.host}/ws`, socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }) });
  await s.connect();
  return s;
}

before(async () => {
  await loadFxHost(WASM_ROOT);
});

test("curves match the firmware's eases (wire order, endpoints, midpoints)", () => {
  assert.deepEqual(CURVES.map(curveWire), [0, 1, 2, 3, 4]);
  for (const c of CURVES) {
    assert.equal(curveAt(c, 0), 0);
    assert.equal(curveAt(c, 1), 1);
  }
  assert.equal(curveAt("ease", 0.25), 0.0625); // cubic in-out
  assert.equal(curveAt("ease_in", 0.5), 0.125);
  assert.equal(curveAt("smoothstep", 0.5), 0.5);
});

describe("canned ramps (one player)", { skip }, () => {
  let player: FakePlayer;
  let session: DeviceSession;
  afterEach(async () => {
    session.close();
    await player.stop();
  });

  test("ramps firmware: one ramp_uniforms, no set_uniforms stream, lands + commits", async () => {
    player = await newPlayer(RAMPS);
    session = await connect(player);
    await session.deployEffect("storm", STORM, true);
    await settle();
    const before = player.received.length;
    const t0 = performance.now();
    const r = await session.rampUniforms({ rain: 0.9, wind: 0.5 }, 0.4, { curve: "ease" });
    assert.ok(performance.now() - t0 >= 350, "waits for the device to land it");
    assert.equal(r["on_device"], true);
    assert.equal(r["outcome"], "done");
    const sent = player.received.slice(before).map((m) => m.type).filter((t) => t !== "get_effect_uniforms");
    assert.deepEqual(sent, ["ramp_uniforms"], "one request, nothing streamed");
    const m = player.ramps[0]!;
    assert.equal(m["durationMs"], 400);
    assert.equal(m["ease"], 1);
    assert.equal(m["commit"], true);
    assert.equal(Number(m["startAtMs"] ?? 0), 0, "a single player starts on receipt");
    const cur = new Map(player.effect!.current.map((c) => [c.slot, c.value[0]!]));
    assert.equal(cur.get(0)!.toFixed(2), "0.90");
    assert.equal(cur.get(1)!.toFixed(2), "0.50");
    // wait=false returns once started.
    const q = await session.rampUniforms({ rain: 0.1 }, 0.5, { wait: false });
    assert.equal(q["outcome"], "running");
    assert.ok((q["end_at_ms"] as number) - (q["start_at_ms"] as number) === 500);
  });

  test("a live set_uniforms cancels the running ramp: the outcome says so", async () => {
    player = await newPlayer(RAMPS);
    session = await connect(player);
    await session.deployEffect("storm", STORM, true);
    await settle();
    const ramp = session.rampUniforms({ rain: 1 }, 0.6);
    await settle(150);
    await session.setUniforms({ rain: 0.3 }); // the user's slider / MIDI
    const r = await ramp;
    assert.equal(r["outcome"], "cancelled");
    await settle(600);
    assert.equal(player.effect!.current.find((c) => c.slot === 0)!.value[0]!.toFixed(2), "0.30", "the live value wins");
  });

  test("no completion push (a link without pushes): returns unconfirmed after the end", async () => {
    player = await newPlayer(RAMPS);
    player.muteRampEvents = true;
    session = await connect(player);
    await session.deployEffect("storm", STORM, true);
    await settle();
    const t0 = performance.now();
    const r = await session.rampUniforms({ rain: 1 }, 0.1);
    assert.equal(r["outcome"], "unconfirmed");
    assert.ok(performance.now() - t0 < 5000);
  });

  test("older firmware: acknowledged steps paced off the wall clock, then one commit", async () => {
    player = await newPlayer(OLD);
    session = await connect(player);
    await session.deployEffect("storm", STORM, true);
    await settle();
    const before = player.received.length;
    const t0 = performance.now();
    const r = await session.rampUniforms({ rain: 1 }, 0.5, { hz: 20 });
    const took = performance.now() - t0;
    assert.ok(took >= 400 && took < 1500, `took ${took} ms`);
    assert.equal(r["on_device"], undefined);
    const sets = player.received.slice(before).filter((m) => m.type === "set_uniforms");
    assert.equal(sets.length, r.steps);
    assert.ok(r.steps >= 5 && r.steps <= 10, `${r.steps} steps`);
    assert.equal(sets.at(-1)!["commit"], true);
    assert.equal(player.ramps.length, 0);
  });

  test("crossfade_to / rollback on ramps firmware: one ramp_crossfade, no set_crossfade stream", async () => {
    player = await newPlayer(RAMPS);
    session = await connect(player);
    await session.deployEffect("calm", CALM, true);
    const cue = await session.cueCrossfade("storm", STORM, await compile(STORM));
    const before = player.crossfades.length;
    const f = await session.fadeCrossfade(cue.to, 0.3, { from: cue.from, curve: "smoothstep" });
    assert.equal(f.on_device, true);
    assert.equal(f.outcome, "done");
    assert.equal(player.crossfades.length - before, 1, "only the device's own landing");
    assert.equal(player.crossfade, 1);
    assert.deepEqual(player.visible(), ["B"]);
    const xf = player.ramps.find((m) => m.type === "ramp_crossfade")!;
    assert.equal(xf["ease"], 4);
    assert.equal(xf["position"], 1);
    const back = await session.rollback(0.2);
    assert.equal(back["restored"], "calm");
    assert.equal(player.crossfade, 0);
    assert.equal(player.ramps.filter((m) => m.type === "ramp_crossfade").length, 2);
  });

  test("blend_keypoints on ramps firmware carries the curve; older firmware doesn't", async () => {
    player = await newPlayer(RAMPS);
    session = await connect(player);
    await session.deployEffect("storm", STORM, true);
    await settle();
    await session.saveKeypoint("calm");
    const r = await session.blendKeypoints({ calm: 1 }, { seconds: 2, curve: "ease_out" });
    assert.equal(r["curve"], "ease_out");
    assert.equal(player.blends.at(-1)!["ease"], 3);
    session.close();
    await player.stop();
    player = await newPlayer(OLD);
    session = await connect(player);
    await session.deployEffect("storm", STORM, true);
    await settle();
    await session.saveKeypoint("calm");
    const o = await session.blendKeypoints({ calm: 1 }, { seconds: 2, curve: "ease_out" });
    assert.equal(o["curve"], "smoothstep", "older firmware only morphs with smoothstep");
    assert.equal(player.blends.at(-1)!["ease"], undefined);
  });
});

describe("canned ramps (MCP, several players)", { skip }, () => {
  let players: FakePlayer[] = [];
  let hub: Hub;
  let client: Client;

  beforeEach(async () => {
    players = [await newPlayer(RAMPS, "Fixture A", "CC:FD:49:00:00:11"), await newPlayer(RAMPS, "Fixture B", "CC:FD:49:00:00:12")];
    players[1]!.clockOffsetMs = 987_654; // a different device clock
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
    client = new Client({ name: "ramps-test", version: "0" });
    await client.connect(b);
  });
  afterEach(async () => {
    await client.close();
    hub.close();
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

  /** A player's start_at back on the hub clock (device ms − its clock offset). */
  const hubStart = (p: FakePlayer, type: string) => Number(p.ramps.filter((m) => m.type === type).at(-1)!["startAtMs"]) - p.clockOffsetMs;

  test("ramp_uniforms: one request per player, one shared start in each player's clock", async () => {
    const dep = await call("deploy_effect", { effect_id: "storm", source: STORM, players: "all" });
    assert.equal(dep.isError, false, dep.text);
    await settle();
    const before = players.map((p) => p.received.length);
    const r = await call("ramp_uniforms", { targets: { rain: 0.8 }, seconds: 0.3, curve: "ease", players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.summary, "ok on all 2");
    for (const x of r.json.results) {
      assert.equal(x.result.on_device, true);
      assert.equal(x.result.synced, true);
      assert.equal(x.result.outcome, "done");
    }
    for (const [i, p] of players.entries()) {
      const sent = p.received.slice(before[i]).map((m) => m.type);
      assert.equal(sent.filter((t) => t === "ramp_uniforms").length, 1);
      assert.equal(sent.filter((t) => t === "set_uniforms").length, 0, "nothing streamed");
    }
    // Same instant on the hub clock (within the sync's error on loopback).
    const [a, b] = players.map((p) => hubStart(p, "ramp_uniforms"));
    assert.ok(Math.abs(a! - b!) < 15, `starts ${a} vs ${b}`);
  });

  test("crossfade_to fades a room from one request each, in lockstep; recall_keypoint is synced too", async () => {
    await call("deploy_effect", { effect_id: "calm", source: CALM, players: "all" });
    const r = await call("crossfade_to", { effect_id: "storm", source: STORM, seconds: 0.3, players: "all" });
    assert.equal(r.isError, false, r.text);
    for (const p of players) {
      assert.equal(p.crossfade, 1);
      assert.equal(p.crossfades.filter((c) => c.position > 0 && c.position < 1).length, 0, "no stepped positions");
      assert.equal(p.ramps.filter((m) => m.type === "ramp_crossfade").length, 1);
    }
    const [a, b] = players.map((p) => hubStart(p, "ramp_crossfade"));
    assert.ok(Math.abs(a! - b!) < 15, `crossfade starts ${a} vs ${b}`);
    await call("save_keypoint", { name: "look", players: "all" });
    const k = await call("recall_keypoint", { name: "look", seconds: 1, curve: "linear", players: "all" });
    assert.equal(k.isError, false, k.text);
    for (const x of k.json.results) assert.equal(x.result.synced_start, true);
    const starts = players.map((p) => Number(p.blends.at(-1)!["startAtMs"]) - p.clockOffsetMs);
    assert.ok(Math.abs(starts[0]! - starts[1]!) < 15);
  });

  test("mixed firmware: the ramps player runs it, the older one is stepped", async () => {
    players[1]!.features = OLD;
    players[1]!.serveManifest();
    hub.close();
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
    await client.close();
    client = new Client({ name: "ramps-test", version: "0" });
    await client.connect(b);
    await call("deploy_effect", { effect_id: "storm", source: STORM, players: "all" });
    await settle();
    const r = await call("ramp_uniforms", { targets: { rain: 0.7 }, seconds: 0.3, players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.equal(players[0]!.ramps.length, 1);
    assert.equal(players[1]!.ramps.length, 0);
    assert.ok(players[1]!.types().filter((t) => t === "set_uniforms").length >= 3);
  });
});
