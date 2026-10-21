/**
 * Crossfades between FX decks (FUG-110) through the bridge, against fake players
 * that model the firmware's two decks: the incoming effect is cued on the idle
 * deck and the crossfade glides to it; the outgoing effect stays loaded as the
 * rollback target (also when this bridge didn't deploy it); deck-addressed tools
 * follow the live deck; several players fade on one clock with a shared time
 * base; and firmware without decks gets a clear error.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { compile, loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { localLibrary } from "../src/libraryLocal";
import { createServer } from "../src/server";
import { curveAt, DECKS_IN_PROTO, DeviceSession } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { FakePlayer, TEST_CERT_SHA256, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-xfade-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
const skip = DECKS_IN_PROTO ? false : "this bundle's protocol has no FX decks";

const DECK_FEATURES = ["effects", "perf", "stored_map", "list_effects", "decks", "crossfade", "time_base", "uniform_commit"];

const CALM = `
uniform float level : 0.0 .. 1.0 = 0.3;
vec3 shade(Led led) { return vec3(0.0, 0.0, level); }
`;
const STORM = `
uniform float rain : 0.0 .. 1.0 = 0.8;
vec3 shade(Led led) { return vec3(rain, rain, 1.0); }
`;
const EMBERS = `
vec3 shade(Led led) { return vec3(1.0, 0.3, 0.0); }
`;

type Text = { type: string; text?: string; data?: string };

async function connect(p: FakePlayer): Promise<DeviceSession> {
  const s = new DeviceSession({ url: `wss://${p.host}/ws`, socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }) });
  await s.connect();
  return s;
}

async function newPlayer(features = DECK_FEATURES, name?: string, mac?: string): Promise<FakePlayer> {
  const p = new FakePlayer({ ...(name ? { name } : {}), ...(mac ? { mac } : {}) });
  p.features = features;
  p.bundle = yFixture();
  await p.start();
  p.serveManifest();
  return p;
}

const settle = () => new Promise((r) => setTimeout(r, 60));

before(async () => {
  await loadFxHost(WASM_ROOT);
});

after(() => undefined);

test("curves run 0 -> 1 and are monotone", () => {
  for (const c of ["linear", "ease", "ease_in", "ease_out"] as const) {
    assert.equal(curveAt(c, 0), 0, c);
    assert.equal(curveAt(c, 1), 1, c);
    let last = -1;
    for (let u = 0; u <= 1.0001; u += 0.05) {
      const v = curveAt(c, u);
      assert.ok(v >= last - 1e-12, `${c} monotone`);
      last = v;
    }
  }
  assert.equal(curveAt("ease", 0.5), 0.5);
  assert.ok(curveAt("ease_in", 0.5) < 0.5 && curveAt("ease_out", 0.5) > 0.5);
});

describe("crossfade (one player)", { skip }, () => {
  let player: FakePlayer;
  let session: DeviceSession;

  beforeEach(async () => {
    player = await newPlayer();
    session = await connect(player);
  });
  afterEach(async () => {
    session.close();
    await player.stop();
  });

  async function fadeTo(id: string, src: string | undefined, seconds = 0.3) {
    const cue = await session.cueCrossfade(id, src, src ? await compile(src) : undefined);
    const f = await session.fadeCrossfade(cue.to, seconds, { from: cue.from, curve: "linear" });
    return { cue, f };
  }

  test("cues the idle deck, glides the crossfade, keeps the outgoing effect running for rollback", async () => {
    await session.deployEffect("calm", CALM, true);
    assert.deepEqual(player.visible(), ["A"]);
    const { cue, f } = await fadeTo("storm", STORM);
    assert.equal(cue.from_deck, 0);
    assert.equal(cue.to_deck, 1);
    assert.equal(cue.outgoing, "calm");
    assert.equal(player.deckB?.id, "storm");
    assert.equal(player.effect?.id, "calm", "the outgoing effect is still loaded on deck A");
    assert.ok(player.deckActive[0] && player.deckActive[1]);
    assert.equal(player.crossfade, 1);
    assert.deepEqual(player.visible(), ["B"]);
    // A real glide: several intermediate positions, in order.
    const mids = player.crossfades.map((c) => c.position).filter((p) => p > 0 && p < 1);
    assert.ok(mids.length >= 3, `intermediate steps: ${mids.length}`);
    assert.deepEqual(mids, [...mids].sort((a, b) => a - b));
    assert.ok(f.steps >= 4);
    // The incoming effect got its uniform defaults on ITS deck.
    assert.deepEqual(player.deckB!.current.map((c) => c.value[0]!.toFixed(2)), ["0.80"]);

    // Deck-addressed tools now follow deck B.
    const st = await session.deckStatus();
    assert.equal(st.live, 1);
    assert.deepEqual(
      st.decks.map((d) => [d.name, d.effect_id, d.active, d.visible]),
      [
        ["A", "calm", true, false],
        ["B", "storm", true, true],
      ],
    );
    const lu = (await session.listUniforms()) as { effect_id: string };
    assert.equal(lu.effect_id, "storm");
    await session.setUniforms({ rain: 0.1 });
    await settle();
    assert.equal(player.deckB!.current.find((c) => c.slot === 0)!.value[0]!.toFixed(2), "0.10");
    assert.equal(player.effect!.current.find((c) => c.slot === 0)!.value[0]!.toFixed(2), "0.30", "deck A untouched");

    // Rollback fades back to the outgoing effect without re-uploading it; again = forward.
    const uploads = player.types().filter((t) => t === "submit_effect").length;
    const r = await session.rollback(0.2);
    assert.equal(r["restored"], "calm");
    assert.equal(player.crossfade, 0);
    assert.deepEqual(player.visible(), ["A"]);
    assert.equal(player.types().filter((t) => t === "submit_effect").length, uploads, "no re-upload");
    assert.equal(((await session.listUniforms()) as { effect_id: string }).effect_id, "calm");
    const again = await session.rollback();
    assert.equal(again["restored"], "storm");
    assert.deepEqual(player.visible(), ["B"]);
  });

  test("a slow player never falls behind: each step is acknowledged, the fade still ends on time", async () => {
    await session.deployEffect("calm", CALM, true);
    player.crossfadeDelayMs = 150; // a C6 busy with TLS records
    const t0 = performance.now();
    await fadeTo("storm", STORM, 0.9);
    const took = performance.now() - t0;
    assert.ok(took < 1600, `done in ${Math.round(took)} ms (no backlog to drain)`);
    assert.equal(player.crossfade, 1);
    const steps = player.crossfades.filter((c) => c.position > 0 && c.position < 1).length;
    assert.ok(steps >= 2 && steps <= 8, `paced to the player: ${steps} steps`);
  });

  test("the outgoing effect is the rollback target even when this bridge didn't deploy it", async () => {
    // The app put "aurora" on deck A; the bridge has no record (and no bytecode) of it.
    const c = await compile(CALM);
    const mlen = Buffer.from(c.fxb).readUInt16LE(8);
    player.effect = { id: "aurora", manifest: Buffer.from(c.fxb).subarray(18, 18 + mlen).toString("utf8"), current: [{ slot: 0, value: [0.7] }] };
    player.deckActive[0] = true;
    session.close();
    session = await connect(player);
    const { cue } = await fadeTo("storm", STORM, 0.1);
    assert.equal(cue.outgoing, "aurora");
    const r = await session.rollback();
    assert.equal(r["restored"], "aurora", "not turned off");
    assert.deepEqual(player.visible(), ["A"]);
    assert.equal(player.effect?.id, "aurora");
    assert.equal(player.effect!.current[0]!.value[0], 0.7, "its live values untouched");
  });

  test("from deck B the next effect goes onto deck A (persisted) and the fade runs 1 -> 0", async () => {
    await session.deployEffect("calm", CALM, true);
    await fadeTo("storm", STORM, 0.1);
    const { cue } = await fadeTo("embers", EMBERS, 0.1);
    assert.equal(cue.from_deck, 1);
    assert.equal(cue.to_deck, 0);
    assert.equal(cue.outgoing, "storm");
    assert.equal(player.effect?.id, "embers");
    assert.equal(player.crossfade, 0);
    assert.deepEqual(player.visible(), ["A"]);
    assert.equal((await session.rollback())["restored"], "storm");
  });

  test("an effect already waiting on the idle deck is cued by id alone", async () => {
    await session.deployEffect("calm", CALM, true);
    await fadeTo("storm", STORM, 0.1);
    const uploads = player.types().filter((t) => t === "submit_effect").length;
    const { cue } = await fadeTo("calm", undefined, 0.1);
    assert.equal(cue.uploaded, false);
    assert.equal(player.types().filter((t) => t === "submit_effect").length, uploads);
    assert.deepEqual(player.visible(), ["A"]);
    await assert.rejects(fadeTo("nope", undefined, 0.1), /isn't loaded on the idle deck/);
  });

  test("nothing running: the effect simply starts on deck A", async () => {
    const { cue } = await fadeTo("embers", EMBERS, 0.1);
    assert.equal(cue.outgoing, null);
    assert.equal(cue.to_deck, 0);
    assert.equal(player.effect?.id, "embers");
    assert.deepEqual(player.visible(), ["A"]);
  });

  test("a half-way crossfade left by the app is settled on the outgoing side before the cue", async () => {
    await session.deployEffect("calm", CALM, true);
    await fadeTo("storm", STORM, 0.1);
    await session.snapCrossfade(0.3); // the user nudged the fader back toward A
    player.crossfades.length = 0;
    await fadeTo("embers", EMBERS, 0.1);
    assert.equal(player.crossfades[0]!.position, 0, "snapped to A (the live side) first");
    assert.equal(player.deckB?.id, "embers");
    assert.equal(player.crossfade, 1);
  });

  test("deploy_effect while deck B is live snaps back to A; the effect on B is the rollback target", async () => {
    await session.deployEffect("calm", CALM, true);
    await fadeTo("storm", STORM, 0.1);
    await session.deployEffect("embers", EMBERS, true);
    assert.equal(player.crossfade, 0);
    assert.equal(player.effect?.id, "embers");
    assert.deepEqual(player.visible(), ["A"]);
    const r = await session.rollback();
    assert.equal(r["restored"], "storm");
    assert.deepEqual(player.visible(), ["B"]);
  });

  test("a deck that won't fit next to the other names the shared arena", async () => {
    await session.deployEffect("calm", CALM, true);
    player.nextUploadError = { code: "effect_too_large", message: "the two decks' buffers exceed the 24 KB fx arena" };
    await assert.rejects(fadeTo("storm", STORM), /share one 24 KB buffer arena/);
    assert.deepEqual(player.visible(), ["A"], "nothing changed on the LEDs");
  });
});

describe("crossfade_to (MCP, several players)", { skip }, () => {
  let players: FakePlayer[] = [];
  let hub: Hub;
  let client: Client;

  beforeEach(async () => {
    players = [await newPlayer(DECK_FEATURES, "Fixture A", "CC:FD:49:00:00:01"), await newPlayer(DECK_FEATURES, "Fixture B", "CC:FD:49:00:00:02")];
    players[1]!.clockOffsetMs = 123_456;
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
    client = new Client({ name: "xfade-test", version: "0" });
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

  test("a room crossfades in lockstep on one time base; rollback fades every player back", async () => {
    const dep = await call("deploy_effect", { effect_id: "calm", source: CALM, players: "all" });
    assert.equal(dep.isError, false, dep.text);
    const t0 = performance.now();
    const r = await call("crossfade_to", { effect_id: "storm", source: STORM, seconds: 0.6, curve: "linear", players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.ok(performance.now() - t0 >= 550, "returns when the fade is done");
    assert.equal(r.json.summary, "ok on all 2");
    for (const x of r.json.results) {
      assert.equal(x.result.effect_id, "storm");
      assert.equal(x.result.deck, "B");
      assert.equal(x.result.previous, "calm");
      assert.equal(x.result.persists_reboot, false);
    }
    assert.match(r.json.rollback, /rollback_effect/);
    assert.match(r.json.persistence, /runtime-only/);
    assert.equal(r.json.time_base.time_base, "applied");
    for (const p of players) {
      assert.equal(p.crossfade, 1);
      assert.deepEqual(p.visible(), ["B"]);
      assert.ok(p.types().includes("set_time_base"));
    }
    // Lockstep: at any moment both players' positions agree (sampled from each
    // player's own receive log, interpolated).
    const at = (p: FakePlayer, t: number) => {
      const xs = p.crossfades.filter((c) => c.at <= t);
      return xs.length ? xs[xs.length - 1]!.position : 0;
    };
    const ramp = players[0]!.crossfades.filter((c) => c.position > 0 && c.position < 1);
    assert.ok(ramp.length >= 5, `steps: ${ramp.length}`);
    const start = ramp[0]!.at;
    for (let t = start + 100; t < start + 500; t += 50) {
      assert.ok(Math.abs(at(players[0]!, t) - at(players[1]!, t)) < 0.2, `in step at +${Math.round(t - start)} ms`);
    }
    // The second crossfade re-uses the room's epoch (no jump for running effects).
    const epochs = players.map((p) => p.timeBase);
    const r2 = await call("crossfade_to", { effect_id: "embers", source: EMBERS, seconds: 0.1, players: "all" });
    assert.equal(r2.isError, false, r2.text);
    for (const [i, p] of players.entries()) assert.ok(Math.abs(p.timeBase! - epochs[i]!) <= 2, "same epoch re-sent");

    // By id alone (its source is known this session): the copy waiting on the idle
    // deck is faded to, not re-uploaded.
    const ups = players[0]!.types().filter((t) => t === "submit_effect").length;
    const byId = await call("crossfade_to", { effect_id: "storm", seconds: 0.1, players: "all" });
    assert.equal(byId.isError, false, byId.text);
    assert.equal(byId.json.results[0].result.uploaded, false);
    assert.equal(players[0]!.types().filter((t) => t === "submit_effect").length, ups);
    await call("crossfade_to", { effect_id: "embers", seconds: 0.1, players: "all" });

    const decks = await call("list_decks", { players: "all" });
    assert.equal(decks.isError, false, decks.text);
    assert.equal(decks.json.results[0].result.live, 0);
    assert.equal(decks.json.results[0].result.decks[0].effect_id, "embers");

    const back = await call("rollback_effect", { seconds: 0.1, players: "all" });
    assert.equal(back.isError, false, back.text);
    for (const p of players) assert.deepEqual(p.visible(), ["B"]);
    assert.equal(back.json.results[0].result.restored, "storm");
  });

  test("crossfade_to a library entry (library_id) on every player", async () => {
    await call("deploy_effect", { effect_id: "calm", source: CALM, players: "all" });
    const saved = await call("save_effect", {
      name: "Storm front",
      description: "Bright white-blue rain flashes over a dark sky, dramatic",
      tags: ["storm"],
      source: STORM,
    });
    assert.equal(saved.isError, false, saved.text);
    const r = await call("crossfade_to", { library_id: saved.json.id, seconds: 0.1, players: "all" });
    assert.equal(r.isError, false, r.text);
    for (const p of players) {
      assert.equal(p.deckB?.id, r.json.results[0].result.effect_id);
      assert.deepEqual(p.visible(), ["B"]);
    }
    const bad = await call("crossfade_to", { library_id: "fx_zzzzzzzz", players: "all" });
    assert.equal(bad.isError, true);
    const none = await call("crossfade_to", { players: "all" });
    assert.match(none.text, /pass effect_id/);
  });

  test("an over-budget effect changes nothing; firmware without decks is told to use deploy_effect", async () => {
    await call("deploy_effect", { effect_id: "calm", source: CALM, players: "all" });
    const heavy = `vec3 shade(Led led) { float a = 0.0; ${"a = a + sin(a + led.pos.x) * cos(a);".repeat(400)} return vec3(a); }`;
    const over = await call("crossfade_to", { effect_id: "heavy", source: heavy, players: "all" });
    if (over.isError) {
      assert.match(over.text, /nothing changed|doesn't compile/);
      for (const p of players) assert.equal(p.deckB, null);
    }
    // A player whose firmware has no decks.
    players[1]!.features = ["effects", "perf", "stored_map"];
    players[1]!.serveManifest();
    hub.close();
    hub = new Hub({
      root: WASM_ROOT,
      hosts: [players[1]!.host],
      mdns: false,
      config: { players: {}, groups: {}, poses: {} },
      persist: () => undefined,
      registryDeps: { sweepHosts: () => [] },
    });
    const server = createServer(hub);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.close();
    client = new Client({ name: "xfade-test", version: "0" });
    await client.connect(b);
    const r = await call("crossfade_to", { effect_id: "storm", source: STORM });
    assert.equal(r.isError, true);
    assert.match(r.text, /no second FX deck: use deploy_effect/);
  });
});
