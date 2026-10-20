/**
 * The multi-fixture hub (docs/design/agent-multi-fixture.md) against N fake
 * players: registry (explicit hosts, remembered, the /24 sweep, dedupe by MAC),
 * fan-out with per-player results and partial failure, rooms + the default
 * target, poses (hub-only until fixture_pose), the time base (offset math, and
 * "unsupported" fan-out), room previews, the fleet budget check, identify, and
 * per-firmware-version toolchains loaded from a fetched, sha256-checked bundle.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { HubConfig } from "../src/config";
import { loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { applyPose, placeFixtures, yaw } from "../src/room";
import { createServer } from "../src/server";
import { deviceEpochs, skewBoundMs } from "../src/timesync";
import { compareVersions, covers, untgz } from "../src/toolchain";
import { FakePlayer, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-hub-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");

// A host bundle root that claims firmware 1.6.0 (so 9.9.9 players need their own).
const HOST_ROOT = join(SCRATCH, "host-bundle");
cpSync(WASM_ROOT, HOST_ROOT, { recursive: true, dereference: true });
writeFileSync(
  join(HOST_ROOT, "bundle.json"),
  JSON.stringify({ schema: "splanc-agent-bundle/1", version: "1.6.0", firmware: { min: "1.6.0", max: "1.6.0" } }),
);

const EFFECT = `
uniform float rain : 0.0 .. 1.0 = 0.2;
vec3 shade(Led led) { return vec3(rain, led.pos.y * 0.5, fract(time)); }
`;

type Text = { type: string; text?: string; data?: string };

function emptyConfig(): HubConfig {
  return { players: {}, groups: {}, poses: {} };
}

async function startPlayers(n: number): Promise<FakePlayer[]> {
  const out: FakePlayer[] = [];
  for (let i = 0; i < n; i++) {
    const p = new FakePlayer({ name: `Fixture ${"ABC"[i]}`, mac: `CC:FD:49:00:00:0${i}` });
    p.bundle = yFixture();
    await p.start();
    p.serveManifest();
    out.push(p);
  }
  return out;
}

async function mcp(hub: Hub): Promise<Client> {
  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "hub-test", version: "0" });
  await c.connect(b);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Text[] };
  const text = r.content.find((x) => x.type === "text")?.text ?? "";
  return { isError: r.isError === true, text, json: safeJson(text), images: r.content.filter((x) => x.type === "image") };
}

function safeJson(t: string): any {
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

function hubFor(players: FakePlayer[], extra: Partial<ConstructorParameters<typeof Hub>[0]> = {}): Hub {
  return new Hub({
    root: HOST_ROOT,
    hosts: players.map((p) => p.host),
    mdns: false,
    config: emptyConfig(),
    persist: () => undefined,
    registryDeps: { sweepHosts: () => [] },
    ...extra,
  });
}

before(async () => {
  await loadFxHost(HOST_ROOT);
});

describe("registry", () => {
  test("explicit hosts, dedupe by MAC across two hosts, remembered for the next run", async () => {
    const ps = await startPlayers(2);
    const cfg = emptyConfig();
    let saved = 0;
    const hub = new Hub({
      root: HOST_ROOT,
      // Player A twice: by IP and by name.
      hosts: [ps[0]!.host, `localhost:${ps[0]!.port}`, ps[1]!.host],
      mdns: false,
      config: cfg,
      persist: () => saved++,
      registryDeps: { sweepHosts: () => [] },
    });
    try {
      const list = await hub.players();
      assert.deepEqual(
        list.map((p) => p.name),
        ["Fixture A", "Fixture B"],
      );
      assert.equal(list[0]!.id, "CC:FD:49:00:00:00");
      assert.ok(saved > 0);
      assert.equal(Object.keys(cfg.players).length, 2);
      // A fresh hub with no hosts finds them again from the config alone.
      const hub2 = new Hub({
        root: HOST_ROOT,
        mdns: false,
        config: cfg,
        persist: () => undefined,
        registryDeps: { sweepHosts: () => [] },
      });
      const again = await hub2.players();
      assert.equal(again.length, 2);
      assert.ok(again.every((p) => p.sources.includes("remembered")));
      hub2.close();
    } finally {
      hub.close();
      for (const p of ps) await p.stop();
    }
  });

  test("the /24 sweep finds a player mDNS can't see (only manifest-serving hosts)", async () => {
    const ps = await startPlayers(2);
    ps[1]!.manifest = null; // TLS but no manifest: not a player as far as the sweep knows
    const hub = new Hub({
      root: HOST_ROOT,
      mdns: false,
      config: emptyConfig(),
      persist: () => undefined,
      registryDeps: { sweepHosts: () => [ps[0]!.host, ps[1]!.host, "127.0.0.1:1"] },
    });
    try {
      const list = await hub.players();
      assert.deepEqual(
        list.map((p) => [p.name, p.sources]),
        [["Fixture A", ["sweep"]]],
      );
    } finally {
      hub.close();
      for (const p of ps) await p.stop();
    }
  });

  test("no players: a clear error", async () => {
    const hub = hubFor([]);
    const c = await mcp(hub);
    const r = await call(c, "set_brightness", { level: 0.5 });
    assert.ok(r.isError);
    assert.match(r.text, /no Splanc players found/);
    // list_players isn't an error with nothing found, but says how to add one.
    const l = await call(c, "list_players");
    assert.equal(l.isError, false);
    assert.deepEqual(l.json.players, []);
    assert.match(l.json.hint, /--host <ip>/);
    assert.match(l.json.hint, /mDNS/);
    hub.close();
  });
});

describe("fan-out", () => {
  let ps: FakePlayer[];
  let hub: Hub;
  let c: Client;
  before(async () => {
    ps = await startPlayers(3);
    hub = hubFor(ps);
    c = await mcp(hub);
  });
  after(async () => {
    hub.close();
    for (const p of ps) await p.stop();
  });

  test("list_players: every player, one socket each", async () => {
    const r = await call(c, "list_players");
    assert.equal(r.json.players.length, 3);
    assert.match(r.json.hint, /no rooms yet/);
  });

  test("no selector + one room: every player; per-player results", async () => {
    const r = await call(c, "set_brightness", { level: 0.4 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.results.length, 3);
    assert.ok(ps.every((p) => p.brightness === 0.4));
    assert.equal(r.json.summary, "ok on all 3");
  });

  test("partial failure is reported per player and doesn't stop the others", async () => {
    ps[1]!.refuse.set("set_brightness", { code: "busy", message: "fake busy" });
    try {
      const r = await call(c, "set_brightness", { level: 0.7, players: "all" });
      assert.equal(r.isError, false);
      assert.equal(r.json.summary, "2 ok, 1 failed");
      const bad = r.json.results.find((x: any) => !x.ok);
      assert.equal(bad.player.name, "Fixture B");
      assert.equal(ps[0]!.brightness, 0.7);
      assert.equal(ps[2]!.brightness, 0.7);
    } finally {
      ps[1]!.refuse.delete("set_brightness");
    }
  });

  test("selectors: by name, by MAC, lists; unknown names list what exists", async () => {
    let r = await call(c, "set_brightness", { level: 0.2, players: "Fixture C" });
    assert.equal(r.json.results.length, 1);
    assert.equal(ps[2]!.brightness, 0.2);
    r = await call(c, "set_brightness", { level: 0.3, players: ["CC:FD:49:00:00:00", "fixture b"] });
    assert.equal(r.json.results.length, 2);
    r = await call(c, "set_brightness", { level: 0.3, players: "kitchen" });
    assert.ok(r.isError);
    assert.match(r.text, /Fixture A \(CC:FD:49:00:00:00\)/);
  });

  test("rooms: target by room; two rooms and no selector asks which", async () => {
    let r = await call(c, "set_room", { room: "living", players: ["Fixture A", "Fixture B"] });
    assert.equal(r.isError, false, r.text);
    r = await call(c, "set_room", { room: "hall", players: ["Fixture C"] });
    r = await call(c, "set_brightness", { level: 0.9, players: "living" });
    assert.equal(r.json.results.length, 2);
    assert.equal(ps[0]!.brightness, 0.9);
    assert.notEqual(ps[2]!.brightness, 0.9);
    r = await call(c, "set_brightness", { level: 0.9 });
    assert.ok(r.isError);
    assert.match(r.text, /2 rooms \(living, hall\)/);
    await call(c, "set_room", { room: "hall", players: [] });
    await call(c, "set_room", { room: "living", players: [] });
  });

  test("deploy: per-player budget estimate, then deployed everywhere; time base reported unsupported", async () => {
    const r = await call(c, "deploy_effect", { effect_id: "mood", source: EFFECT, players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.ok(ps.every((p) => p.effect?.id === "mood"));
    assert.equal(Object.keys(r.json.estimates).length, 3);
    assert.equal(r.json.estimates["Fixture A"].leds, 30);
    assert.equal(r.json.time_base.time_base, "unsupported");
    assert.match(r.json.time_base.note, /time base unsupported/);
    // Pings went out to each player; no time-base message was sent.
    assert.ok(ps.every((p) => p.types().includes("time_sync_ping")));
    assert.ok(ps.every((p) => !p.types().includes("set_time_base")));
    // Each player got the declared defaults right after the submit: the VM
    // starts every uniform at 0, so without them the effect renders black.
    await new Promise((res) => setTimeout(res, 50));
    for (const p of ps) {
      const types = p.types();
      const submit = types.lastIndexOf("submit_effect");
      assert.equal(types[submit + 1], "set_uniforms", "set_uniforms follows submit_effect");
      assert.ok((p.received[submit + 1]!["values"] as unknown[]).length > 0);
    }
  });

  test("an effect that doesn't compile deploys nowhere", async () => {
    const before = ps.map((p) => p.effect?.id);
    const r = await call(c, "deploy_effect", { effect_id: "bad", source: "vec3 shade(Led led) { return oops; }", players: "all" });
    assert.ok(r.json.results.every((x: any) => !x.ok));
    assert.deepEqual(
      ps.map((p) => p.effect?.id),
      before,
    );
  });

  test("ramp_uniforms on every player at once", async () => {
    const t0 = Date.now();
    const r = await call(c, "ramp_uniforms", { targets: { rain: 0.9 }, seconds: 0.5, players: "all" });
    assert.equal(r.isError, false, r.text);
    assert.ok(Date.now() - t0 < 1500, "parallel, not 3 x 0.5 s in series");
    assert.equal(r.json.results.length, 3);
  });

  test("poses: stored in the hub, 'not yet applied on device'; room view in the shared frame", async () => {
    await call(c, "set_room", { room: "living", players: ["all"] });
    let r = await call(c, "set_fixture_pose", { player: "Fixture B", translation: [3, 0, 0], yaw_deg: 90 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.stored, "in the hub only");
    assert.match(r.json.note, /not yet applied on device/);
    const room = await c.readResource({ uri: "splanc://room/living" });
    const v = JSON.parse((room.contents[0] as { text: string }).text);
    assert.equal(v.total_leds, 90);
    const b = v.fixtures.find((f: any) => f.name === "Fixture B");
    assert.equal(b.posed, true);
    assert.ok(b.bounding_box_m.min[0] > 2);
    assert.match(v.note, /no pose yet/);
    r = await call(c, "list_players");
    assert.deepEqual(r.json.rooms, { living: ps.map((p) => p.mac) });
  });

  test("room preview: one image of every fixture, per-fixture stats", async () => {
    const r = await call(c, "preview_effect", { source: EFFECT, times: [0, 0.5], players: "living" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.images.length, 2);
    assert.equal(r.json.frames[0].lit_leds + 0 >= 0, true);
    assert.equal(Object.keys(r.json.frames[0].per_fixture).length, 3);
    assert.equal(r.json.room.total_leds, 90);
  });

  test("per-player resources + the aliased spec URIs", async () => {
    const one = await c.readResource({ uri: `splanc://player/${encodeURIComponent(ps[0]!.mac)}/fixture/summary` });
    assert.equal(JSON.parse((one.contents[0] as { text: string }).text).led_count, 30);
    const all = await c.readResource({ uri: "splanc://device" });
    const v = JSON.parse((all.contents[0] as { text: string }).text);
    assert.equal(Object.keys(v.players).length, 3);
  });

  test("identify blinks and restores brightness", async () => {
    await call(c, "set_brightness", { level: 0.6, players: "Fixture A" });
    const r = await call(c, "identify_player", { players: "Fixture A" });
    assert.equal(r.isError, false, r.text);
    const levels = ps[0]!.received.filter((m) => m.type === "set_brightness").slice(-7).map((m) => m["brightness"]);
    assert.deepEqual(levels, [0.05, 0.6, 0.05, 0.6, 0.05, 0.6, 0.6]);
    assert.equal(ps[0]!.brightness, 0.6);
  });
});

describe("single player (back compat)", () => {
  test("one player, no selector: the legacy flat result shape", async () => {
    const ps = await startPlayers(1);
    const hub = hubFor(ps);
    const c = await mcp(hub);
    try {
      const r = await call(c, "set_brightness", { level: 0.5 });
      assert.deepEqual(r.json, { brightness: 0.5 });
      const d = await c.readResource({ uri: "splanc://device" });
      assert.equal(JSON.parse((d.contents[0] as { text: string }).text).id, ps[0]!.mac);
    } finally {
      hub.close();
      await ps[0]!.stop();
    }
  });
});

describe("time base", () => {
  test("offset math: epochs per player clock, skew bound", () => {
    const syncs = new Map([
      ["a", { offsetMs: 1000, rttMs: 10, at: 0 }],
      ["b", { offsetMs: -250.4, rttMs: 4, at: 0 }],
    ]);
    const e = deviceEpochs(5000, syncs);
    assert.equal(e.get("a"), 6000);
    assert.equal(e.get("b"), 4750);
    assert.equal(skewBoundMs(syncs.values()), 7);
  });

  test("syncClock recovers a device clock offset within the round trip", async () => {
    const ps = await startPlayers(2);
    ps[0]!.clockOffsetMs = 123_456;
    ps[1]!.clockOffsetMs = -5_000;
    ps[1]!.pingDelayMs = 5;
    const hub = hubFor(ps);
    try {
      const t = await hub.alignTime("all");
      const byName = Object.fromEntries((t["players"] as any[]).map((p) => [p.name, p]));
      assert.ok(Math.abs(byName["Fixture A"].offset_ms - 123_456) <= byName["Fixture A"].rtt_ms / 2 + 1);
      assert.ok(Math.abs(byName["Fixture B"].offset_ms + 5_000) <= byName["Fixture B"].rtt_ms / 2 + 1);
      assert.equal(t["time_base"], "unsupported");
    } finally {
      hub.close();
      for (const p of ps) await p.stop();
    }
  });
});

describe("room math", () => {
  test("pose transform and side-by-side layout of unposed fixtures", () => {
    const p = applyPose({ room: "r", translation: [1, 0, 0], rotation: yaw(90), scale: 2 }, [1, 0, 0]);
    assert.ok(Math.abs(p[0] - 1) < 1e-9 && Math.abs(p[2] + 2) < 1e-9, JSON.stringify(p));
    const placed = placeFixtures("r", [
      { id: "a", name: "a", bundle: yFixture() },
      { id: "b", name: "b", bundle: yFixture() },
    ]);
    assert.ok(placed[1]!.box!.min[0] >= placed[0]!.box!.max[0] + 0.49);
    assert.ok(placed.every((x) => !x.posed));
  });
});

describe("per-version toolchains", () => {
  test("version ordering + bundle ranges", () => {
    assert.equal(compareVersions("1.10.0", "1.9.2"), 1);
    assert.ok(covers({ version: "1.6.0", firmware: { min: "1.6.0", max: "1.6.0" } }, "1.6.0"));
    assert.ok(!covers({ version: "1.6.0", firmware: { min: "1.6.0", max: "1.6.0" } }, "9.9.9"));
    assert.ok(covers(null, "9.9.9"), "a dev checkout speaks anything");
  });

  test("a player on other firmware gets its own fetched, sha256-checked bundle", async () => {
    // A fake second bundle: the same wasm, packed as splanc-agent-9.9.9.tgz.
    const stage = join(SCRATCH, "stage");
    cpSync(WASM_ROOT, join(stage, "splanc-agent-9.9.9"), { recursive: true, dereference: true });
    writeFileSync(
      join(stage, "splanc-agent-9.9.9", "bundle.json"),
      JSON.stringify({ schema: "splanc-agent-bundle/1", version: "9.9.9", firmware: { min: "9.9.9", max: "9.9.9" } }),
    );
    const tgzPath = join(SCRATCH, "b.tgz");
    execFileSync("tar", ["-chzf", tgzPath, "-C", stage, "splanc-agent-9.9.9"]); // -h: runfiles are symlinks
    const tgz = readFileSync(tgzPath);
    const sha = createHash("sha256").update(tgz).digest("hex");
    // untgz round-trips the archive.
    untgz(tgz, join(SCRATCH, "untgz"));
    assert.ok(readFileSync(join(SCRATCH, "untgz", "splanc-agent-9.9.9", "bundle.json"), "utf8").includes("9.9.9"));
    let fetches = 0;
    const srv = http.createServer((_req, res) => {
      fetches++;
      res.end(tgz);
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/splanc-agent-9.9.9.tgz`;

    const ps = await startPlayers(3);
    ps[1]!.fwVersion = "9.9.9";
    ps[1]!.serveManifest({ bundle: { url, sha256: sha } });
    ps[2]!.fwVersion = "9.9.8";
    ps[2]!.serveManifest({ bundle: { url, sha256: "00".repeat(32) } });
    const hub = hubFor(ps);
    const c = await mcp(hub);
    try {
      const r = await call(c, "compile_effect", { source: EFFECT, players: "all" });
      const by = Object.fromEntries(r.json.results.map((x: any) => [x.player.name, x]));
      assert.equal(by["Fixture A"].result?.compiler, "local", r.text);
      assert.equal(by["Fixture B"].result?.compiler, "9.9.9", r.text);
      assert.equal(by["Fixture B"].result.ok, true);
      assert.equal(by["Fixture C"].ok, false);
      assert.match(by["Fixture C"].error, /sha256/);
      // Cached: a second compile doesn't refetch.
      const n = fetches;
      await call(c, "compile_effect", { source: EFFECT, players: "Fixture B" });
      assert.equal(fetches, n);
      // And it previews with its own VM too.
      const p = await call(c, "preview_effect", { source: EFFECT, times: [0], players: "Fixture B" });
      assert.equal(p.isError, false, p.text);
      assert.equal(p.json.leds, 30);
    } finally {
      hub.close();
      srv.close();
      for (const p of ps) await p.stop();
    }
  });
});
