/**
 * Live VJ end to end (docs/design/live-vj-relay.md): the app's own client
 * (web/src/net/bridgeLive.ts) -> relay /live -> bridge (LanBridge + LiveMux) ->
 * hub -> two fake players; then the same client directly on the bridge's LAN
 * endpoint with the ticket it got over the relay.
 *
 * Covers pairing with a code, the player list, deploy + time alignment across
 * fixtures, uniforms / crossfade / brightness fanned out, coalescing (a burst of
 * slider moves becomes a few frames, last value wins), the Show Mode lock refusing
 * another live client AND an MCP agent on the same bridge, a player dropping and
 * coming back, revocation ending both paths, and the latency numbers.
 *
 * The relay is the in-process Node host by default; SPLANC_E2E_RELAY=<url> runs
 * the same test against `wrangler dev` or the deployed Worker.
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import WebSocket from "ws";

import {
  BridgeLiveClient,
  forgetBridge,
  pairWithCode,
  type BridgeCreds,
  type LiveSocket,
  type LiveState,
} from "../../web/src/net/bridgeLive";
import { LanBridge, type BridgeStatus } from "../src/bridge/lanBridge";
import { RelayLink } from "../src/bridge/relayLink";
import { loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { RelayHost } from "../src/relayHost";
import { FakePlayer, yFixture } from "./fakePlayer";
import { tempIdentity, until } from "./relayHelpers";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-live-e2e-"));
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
const STATUS = join(SCRATCH, "status.json");
const EXTERNAL = process.env["SPLANC_E2E_RELAY"];
const HOST_ROOT = join(SCRATCH, "host-bundle");
cpSync(WASM_ROOT, HOST_ROOT, { recursive: true, dereference: true });
writeFileSync(
  join(HOST_ROOT, "bundle.json"),
  JSON.stringify({ schema: "splanc-agent-bundle/1", version: "1.6.0", firmware: { min: "1.6.0", max: "1.6.0" } }),
);

const EFFECT = `
uniform float rain : 0.0 .. 1.0 = 0.2;
uniform float speed : 0.0 .. 4.0 = 1.0;
vec3 shade(Led led) { return vec3(rain, led.pos.y * 0.5, fract(time * speed)); }
`;

let host: RelayHost | null = null;
let relay = "";
let players: FakePlayer[] = [];
let hub: Hub;
let bridge: LanBridge;
let link: RelayLink;
let token = "";

const status = () => JSON.parse(readFileSync(STATUS, "utf8")) as BridgeStatus;

/** The app's socket, on Node: `ws` (accepting the bridge's self-signed cert, as a
 * browser does once the user trusted it; the test checks the fingerprint itself). */
const factory = (url: string, protocols: string[]) =>
  new WebSocket(url, protocols, { rejectUnauthorized: false }) as unknown as LiveSocket;

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

function liveClient(over: Partial<BridgeCreds> = {}, preferLan = false): BridgeLiveClient {
  return new BridgeLiveClient(
    { relay, token, clientId: "test-client-0001", name: "VJ phone", ...over },
    { factory, preferLan, backoffMs: [100, 200, 400] },
  );
}

/** Record when each set_uniforms carrying `value` for slot 0 reaches a player. */
function watchUniform(p: FakePlayer): { at: Map<number, number>; count: () => number } {
  const at = new Map<number, number>();
  let n = 0;
  const orig = p.received.push.bind(p.received);
  p.received.push = (...ms) => {
    for (const m of ms) {
      if (m.type !== "set_uniforms") continue;
      n++;
      for (const v of m["values"] as { slot: number; value: number[] }[]) {
        // float32 on the wire: key by the value rounded to 1e-4.
        const k = Math.round(v.value[0]! * 1e4);
        if (!at.has(k)) at.set(k, performance.now());
      }
    }
    return orig(...ms);
  };
  return { at, count: () => n };
}

const pctl = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))]!;

before(async () => {
  await loadFxHost(HOST_ROOT);
  if (EXTERNAL) relay = EXTERNAL.replace(/\/+$/, "");
  else {
    host = new RelayHost();
    relay = await host.listen();
  }
  for (const [i, name] of ["Kitchen", "Hall"].entries()) {
    const p = new FakePlayer({ name, mac: `CC:FD:49:00:02:0${i}` });
    p.bundle = yFixture();
    p.features = ["effects", "perf", "decks", "crossfade", "keypoints", "time_base"];
    await p.start();
    p.serveManifest();
    players.push(p);
  }
  hub = new Hub({
    root: HOST_ROOT,
    hosts: players.map((p) => p.host),
    mdns: false,
    config: { players: {}, groups: {}, poses: {} },
    persist: () => undefined,
    registryDeps: { sweepHosts: () => [] },
  });
  const { identity, dir } = tempIdentity();
  link = new RelayLink({ relay, identity, backoff: { baseMs: 100, maxMs: 2000 } });
  bridge = new LanBridge({
    link,
    hub,
    statusPath: STATUS,
    controlPath: join(SCRATCH, "control.sock"),
    refreshMs: 0,
    live: { stateDir: dir, port: await freePort(), host: "127.0.0.1", advertise: "127.0.0.1" },
  });
  await bridge.start();
  const s = await until(() => {
    const x = status();
    return x.state === "pairing" && x.players.length === 2 ? x : null;
  }, "bridge showing a pairing code", 20_000);
  // The person types the code from the bridge's screen into the app.
  token = await pairWithCode(relay, s.pairing!.code, "Test phone");
  assert.match(token, /^spl_pt_/);
});

after(async () => {
  await bridge.stop();
  hub.close();
  for (const p of players) await p.stop();
  await host?.close();
  players = [];
});

test("via the relay: player list, deploy + align, uniforms/crossfade/brightness fan out, coalescing", async () => {
  const c = liveClient();
  try {
    const w = await c.connect();
    assert.equal(w.via, "relay");
    assert.equal(c.tickMs, 33);
    assert.deepEqual(w.players.map((p) => p.name).sort(), ["Hall", "Kitchen"]);
    assert.ok(w.lan && w.lan.url.startsWith("wss://127.0.0.1:"), JSON.stringify(w.lan));
    assert.match(w.lan_token ?? "", /^spl_lt_/);
    await until(() => c.players.every((p) => p.connected), "players connected");

    const dep = await c.query("deploy", { effect_id: "rain", source: EFFECT }, ["all"]);
    assert.equal(dep.ok, true, JSON.stringify(dep));
    assert.ok(dep.results!.every((r) => r.ok), JSON.stringify(dep.results));
    // Two fixtures got the same effect: their clocks were aligned.
    assert.ok((dep.data as { align?: { time_base?: string } }).align?.time_base, JSON.stringify(dep.data));
    assert.ok(players.every((p) => p.types().includes("set_time_base")));

    const eff = await c.query("effect", {}, ["Kitchen"]);
    const kitchen = eff.results![0]!.result as { effect_id: string; uniforms: { name: string }[] };
    assert.equal(kitchen.effect_id, "rain");
    assert.deepEqual(kitchen.uniforms.map((u) => u.name).sort(), ["rain", "speed"]);

    // One slider move -> both players.
    c.control(["all"], { u: { rain: 0.7 } });
    await until(() => players.every((p) => p.effect?.current.some((v) => Math.abs(v.value[0]! - 0.7) < 1e-6)), "rain=0.7 on both");

    // A burst of 200 moves within ~100 ms: a handful of frames, last value wins.
    const watch = players.map(watchUniform);
    const framesBefore = c.stats.frames;
    for (let i = 1; i <= 200; i++) {
      c.control(["all"], { u: { rain: i / 200 } });
      if (i % 40 === 0) await new Promise((r) => setTimeout(r, 20));
    }
    c.flush();
    await until(() => players.every((p) => p.effect?.current.some((v) => v.slot === 0 && v.value[0] === 1)), "final value on both");
    const frames = c.stats.frames - framesBefore;
    assert.ok(frames <= 10, `app sent ${frames} frames for 200 moves`);
    for (const wch of watch) assert.ok(wch.count() <= frames + 1, `player got ${wch.count()} set_uniforms`);

    // Crossfade + brightness ride the same frames.
    c.control(["all"], { xf: { pos: 0.25 }, bri: 0.5 });
    await until(() => players.every((p) => p.crossfade === 0.25 && p.brightness === 0.5), "xf + brightness");

    // The framerate autoscaler (FUG-82): a step shows in the player list; an abort
    // (the effect parked) reaches the app at once.
    const fpsMsgs: { name: string; aborted: boolean }[] = [];
    c.events.onFps = (m) => fpsMsgs.push(m);
    players[1]!.pushFpsState({ targetFps: 0, currentFps: 40, auto: true, aborted: false });
    await until(() => c.players.find((p) => p.name === "Hall")?.fps?.current === 40, "fps in the player list", 10_000);
    players[1]!.pushFpsState({ targetFps: 0, currentFps: 25, auto: true, aborted: true });
    await until(() => fpsMsgs.some((m) => m.name === "Hall" && m.aborted), "fps abort pushed");
    await until(() => c.players.find((p) => p.name === "Hall")?.fps?.aborted === true, "parked in the list", 10_000);

    // An unknown uniform is reported (asynchronously), not silently dropped.
    const errs: string[] = [];
    c.events.onError = (code, msg) => errs.push(`${code}: ${msg}`);
    c.control(["Kitchen"], { u: { nope: 1 } });
    await until(() => errs.some((e) => e.startsWith("bad_uniform")), "bad_uniform error");
  } finally {
    c.close();
  }
});

test("Show Mode lock: another live client and an MCP agent are refused until released", async () => {
  const a = liveClient();
  const b = liveClient({ clientId: "other-client-0002", name: "Second phone" });
  const transport = new StreamableHTTPClientTransport(new URL(`${relay}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const agent = new Client({ name: "live-e2e-agent", version: "0" });
  try {
    await a.connect();
    await b.connect();
    await agent.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    const lk = await a.query("lock", { on: true }, ["Kitchen"]);
    assert.ok(lk.results![0]!.ok, JSON.stringify(lk));
    await until(() => b.players.find((p) => p.name === "Kitchen")?.lock?.by === "VJ phone", "b sees the lock");
    assert.equal(a.players.find((p) => p.name === "Kitchen")?.lock?.mine, true);

    const errs: string[] = [];
    b.events.onError = (code) => errs.push(code);
    b.control(["Kitchen"], { bri: 0.1 });
    await until(() => errs.includes("locked"), "b refused");
    assert.notEqual(players[0]!.brightness, 0.1);

    const r = (await agent.callTool({ name: "set_brightness", arguments: { level: 0.2, players: "Kitchen" } })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    // The per-player result names the holder (the tool's shape: results[], not isError).
    assert.match(r.content[0]?.text ?? "", /performed live \(Show Mode lock held by \\"VJ phone\\"\)/);
    assert.notEqual(players[0]!.brightness, 0.2);
    // crossfade_to (the agent's live deck change) is refused too, before touching the device.
    const xfBefore = players[0]!.crossfades.length;
    const cf = (await agent.callTool({
      name: "crossfade_to",
      arguments: { effect_id: "agentfx", source: EFFECT, seconds: 0, players: "Kitchen" },
    })) as { content: { text?: string }[] };
    assert.match(cf.content[0]?.text ?? "", /performed live/);
    assert.equal(players[0]!.crossfades.length, xfBefore);
    // Reads still work for the agent.
    const list = (await agent.callTool({ name: "list_players", arguments: {} })) as { isError?: boolean };
    assert.notEqual(list.isError, true);

    // The holder still drives it.
    a.control(["Kitchen"], { bri: 0.3 });
    await until(() => players[0]!.brightness === 0.3, "holder drives");

    await a.query("lock", { on: false }, ["Kitchen"]);
    b.control(["Kitchen"], { bri: 0.4 });
    await until(() => players[0]!.brightness === 0.4, "released: b drives");
  } finally {
    await agent.close().catch(() => undefined);
    a.close();
    b.close();
  }
});

test("decks are shared: a performer's cue + fader is what crossfade_to / rollback_effect / list_decks see", async () => {
  const c = liveClient();
  const transport = new StreamableHTTPClientTransport(new URL(`${relay}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const agent = new Client({ name: "live-e2e-decks", version: "0" });
  const tool = async (name: string, args: Record<string, unknown>) =>
    JSON.parse(((await agent.callTool({ name, arguments: args })) as { content: { text?: string }[] }).content[0]?.text ?? "null");
  try {
    await c.connect();
    await agent.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    const hall = players[1]!;
    // Deck A: rain (from the first test). Cue "storm" on deck B: the crossfade must not move.
    const before = hall.crossfades.length;
    const cue = await c.query("deploy", { effect_id: "storm", source: EFFECT, deck: 1 }, ["Hall"]);
    assert.ok(cue.results!.every((r) => r.ok), JSON.stringify(cue.results));
    assert.equal(hall.crossfades.length, before, "cueing the idle deck doesn't cut to it");
    // The performer drags the crossfader to B.
    c.control(["Hall"], { xf: { pos: 1 } });
    c.flush();
    await until(() => hall.crossfade === 1, "fader at B");
    await new Promise((r) => setTimeout(r, 100));
    // The agent sees the same deck state.
    const decks = await tool("list_decks", { players: "Hall" });
    const st = decks.results?.[0]?.result ?? decks;
    assert.equal(st.live, 1, JSON.stringify(decks));
    // rollback_effect fades back to what the performer cut away from (deck A).
    const rb = await tool("rollback_effect", { seconds: 0, players: "Hall" });
    assert.ok(JSON.stringify(rb).includes('"deck":"A"'), JSON.stringify(rb));
    await until(() => hall.crossfade === 0, "faded back to A");
  } finally {
    await agent.close().catch(() => undefined);
    c.close();
  }
});

test("direct on the LAN with the relay-minted ticket; a player drops and comes back", async () => {
  const viaRelay = liveClient();
  const w = await viaRelay.connect();
  viaRelay.close();
  // The certificate the bridge serves is the one it vouched for over the relay.
  const fp = await new Promise<string>((res, rej) => {
    const u = new URL(w.lan!.page);
    https
      .get({ host: u.hostname, port: u.port, path: "/healthz", rejectUnauthorized: false }, (r) => {
        res((r.socket as import("node:tls").TLSSocket).getPeerCertificate().fingerprint256.replace(/:/g, "").toLowerCase());
        r.resume();
      })
      .on("error", rej);
  });
  assert.equal(fp, w.lan!.sha256);

  const states: LiveState[] = [];
  const d = liveClient({ lan: w.lan!, lanToken: w.lan_token! }, true);
  d.events.onState = (s) => states.push(s);
  try {
    const dw = await d.connect();
    assert.equal(dw.via, "lan");
    assert.equal(d.tickMs, 16);
    assert.equal(dw.lan_token, undefined); // tickets are only minted via the relay
    d.control(["Hall"], { u: { speed: 3 } });
    await until(() => players[1]!.effect?.current.some((v) => v.slot === 1 && v.value[0] === 3), "speed=3 via LAN");
    const probe = await d.query("probe", {}, ["all"]);
    assert.ok(probe.results!.every((r) => r.ok && typeof (r.result as { device_rtt_ms: number }).device_rtt_ms === "number"));

    // Hall reboots: the list says so, then it's back and drivable.
    const hall = players[1]!;
    const port = hall.port;
    await hall.stop();
    await until(() => d.players.find((p) => p.name === "Hall")?.connected === false, "Hall shown offline", 15_000);
    await hall.start(port);
    await until(() => d.players.find((p) => p.name === "Hall")?.connected === true, "Hall back", 30_000);
    // It rebooted with no effect: deploy again, then drive it.
    await d.query("deploy", { effect_id: "rain", source: EFFECT }, ["Hall"]);
    d.control(["Hall"], { u: { rain: 0.33 } });
    await until(() => hall.effect?.current.some((v) => v.slot === 0 && Math.abs(v.value[0]! - 0.33) < 1e-6), "Hall driven again");
  } finally {
    d.close();
  }
});

test("latency: ping, device probe and slider -> player, relay vs direct", async () => {
  const relayC = liveClient();
  const w = await relayC.connect();
  const lanC = liveClient({ lan: w.lan!, lanToken: w.lan_token! }, true);
  await lanC.connect();
  assert.equal(lanC.via, "lan");
  const out: Record<string, unknown> = {};
  try {
    for (const [name, c] of [
      ["relay", relayC],
      ["lan", lanC],
    ] as const) {
      const pings: number[] = [];
      for (let i = 0; i < 20; i++) pings.push(await c.ping());
      const watch = watchUniform(players[0]!);
      const slider: number[] = [];
      for (let i = 0; i < 20; i++) {
        const v = 0.5 + (name === "lan" ? 0.25 : 0) + i / 1000;
        const t0 = performance.now();
        c.control(["Kitchen"], { u: { rain: v } });
        c.flush();
        const k = Math.round(v * 1e4);
        await until(() => watch.at.get(k), "slider applied", 5000);
        slider.push(watch.at.get(k)! - t0);
        await new Promise((r) => setTimeout(r, 40));
      }
      out[name] = {
        ping_p50_ms: +pctl(pings, 0.5).toFixed(1),
        ping_p95_ms: +pctl(pings, 0.95).toFixed(1),
        slider_to_player_p50_ms: +pctl(slider, 0.5).toFixed(1),
        slider_to_player_p95_ms: +pctl(slider, 0.95).toFixed(1),
      };
    }
    console.log(`LATENCY ${EXTERNAL ? "(relay " + relay + ")" : "(in-process relay)"} ${JSON.stringify(out)}`);
  } finally {
    relayC.close();
    lanC.close();
  }
});

test("revoking the app's credential ends the relay session and its LAN ticket", async () => {
  const c = liveClient();
  const w = await c.connect();
  const d = liveClient({ lan: w.lan!, lanToken: w.lan_token! }, true);
  await d.connect();
  assert.equal(d.via, "lan");
  const states: LiveState[] = [];
  c.events.onState = (s) => states.push(s);
  const dStates: LiveState[] = [];
  d.events.onState = (s) => dStates.push(s);
  await forgetBridge(relay, token);
  await until(() => states.includes("revoked"), "relay session revoked");
  await until(() => dStates.includes("revoked"), "LAN session revoked");
  // The ticket is gone too: a fresh direct connection is refused.
  const e = liveClient({ lan: w.lan!, lanToken: w.lan_token!, token: "spl_pt_aaaaaaaaaaaaaaaaaaaa_" + "x".repeat(43) }, true);
  await assert.rejects(e.connect());
  e.close();
  c.close();
  d.close();
});
