/**
 * The per-fixture details the bridge puts in its status file for the OLED's
 * fixture screens (src/bridge/lanBridge.ts BridgePlayer): id, firmware, room,
 * last contact, session state + error, the rendered LED count (configured, else
 * the stored map's: channels.ts), the known effect and the latest perf numbers.
 * All of it comes from what the bridge already holds; nothing secret.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { LanBridge, type BridgePlayer } from "../src/bridge/lanBridge";
import { RelayLink } from "../src/bridge/relayLink";
import { Hub } from "../src/hub";
import { FakePlayer, yFixture } from "./fakePlayer";
import { tempIdentity, until } from "./relayHelpers";

const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-bridgestatus-"));
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");

const PORCH = "CC:FD:49:00:00:B1";
const ARCH = "CC:FD:49:00:00:B2";

let porch: FakePlayer;
let arch: FakePlayer;
let hub: Hub;
let bridge: LanBridge;

const entry = (id: string): BridgePlayer => {
  const p = bridge.status().players.find((x) => x.id === id);
  assert.ok(p, `${id} in the status`);
  return p;
};

before(async () => {
  porch = new FakePlayer({ name: "Test Porch", mac: PORCH, fwVersion: "1.7.2" });
  porch.bundle = yFixture();
  arch = new FakePlayer({ name: "Test Arch", mac: ARCH });
  arch.bundle = yFixture(); // 30 LEDs
  arch.hwLedCounts = [0, 0]; // never configured: renders the map
  arch.ledCapacity = 512;
  for (const p of [porch, arch]) {
    await p.start();
    p.serveManifest();
  }
  hub = new Hub({
    root: "",
    hosts: [porch.host, arch.host],
    mdns: false,
    config: { players: {}, groups: { "Test Room": [PORCH] }, poses: {} },
    persist: () => undefined,
    registryDeps: { sweepHosts: () => [] },
    reconnectGraceMs: 200,
    huntBackoffMs: [],
  });
  const { identity } = tempIdentity();
  bridge = new LanBridge({
    link: new RelayLink({ relay: "", identity }),
    hub,
    statusPath: join(SCRATCH, "run", "status.json"),
    controlPath: join(SCRATCH, "run", "control.sock"),
    refreshMs: 0,
  });
  await bridge.start({ connect: false });
  await hub.warm();
  await bridge.loadDetails();
});

after(async () => {
  await bridge.stop();
  hub.close();
  await porch.stop().catch(() => undefined);
  await arch.stop().catch(() => undefined);
});

test("identity, firmware, room, session and last contact", () => {
  const p = entry(PORCH);
  assert.equal(p.name, "Test Porch");
  assert.equal(p.host, porch.host);
  assert.equal(p.ok, true);
  assert.equal(p.fw, "1.7.2");
  assert.equal(p.room, "Test Room");
  assert.equal(p.session, "live");
  assert.equal(p.error, undefined);
  assert.ok(p.seen !== undefined && Math.abs(p.seen - Date.now() / 1000) < 30, `seen ${p.seen}`);
  assert.equal(entry(ARCH).room, undefined, "no room: the field is omitted");
});

test("LED count: the configured count, else the stored map's (channels.ts)", () => {
  assert.deepEqual([entry(PORCH).leds, entry(PORCH).leds_src], [64, "configured"]);
  assert.deepEqual([entry(ARCH).leds, entry(ARCH).leds_src], [30, "map"]);
});

test("perf: the last perf report + fps_state the bridge holds; the known effect", async () => {
  assert.equal(entry(PORCH).perf, undefined, "nothing measured yet");
  assert.equal(entry(PORCH).effect, undefined);
  porch.effect = { id: "test-aurora", manifest: "", current: [] }; // put there by another client
  porch.perf = { budgetCycles: 1000, frameCyclesMean: 630, frameCyclesMax: 900, overruns: 2, currentFps: 40 };
  const s = hub.openSession(PORCH)!;
  await s.measureEffect(0.05, { sleep: async () => undefined });
  const p = entry(PORCH).perf!;
  assert.equal(p.budget_used, 0.63);
  assert.equal(p.overruns, 2);
  assert.equal(p.heap_free, 90000);
  assert.equal(p.fps, 40);
  assert.ok(Math.abs(p.at - Date.now() / 1000) < 30);
  assert.equal(entry(PORCH).effect, "test-aurora", "named by the perf report");
  porch.pushFpsState({ targetFps: 40, currentFps: 25, auto: true, lagging: true, achievedFps: 18 });
  const lag = await until(() => (entry(PORCH).perf?.lagging ? entry(PORCH).perf : null), "lagging fps_state");
  assert.equal(lag.fps, 18, "lagging: the achieved rate");
});

test("small and secret-free: no certificate pins or tokens", () => {
  const json = JSON.stringify(bridge.status());
  for (const pin of [porch.certSha256, arch.certSha256]) {
    assert.ok(pin && !json.includes(pin), "no certificate pin in the status");
  }
  assert.ok(!/token|secret|pin"/i.test(json), json);
  assert.ok(json.length < 1500, `status is ${json.length} bytes for two fixtures`);
});

test("a player that drops off: no session, unreachable with the reason", async () => {
  await arch.stop();
  const p = await until(() => {
    const e = entry(ARCH);
    return e.session === "none" && e.error ? e : null;
  }, "the lost player's status", 5000);
  assert.match(p.error!, /didn't come back|heartbeat|not answering/);
  // What it last knew stays (the display shows the last LED count).
  assert.equal(p.leds, 30);
});

test("used: a tool call marks the fixtures it reached; never-used ones have none", async () => {
  assert.equal(entry(PORCH).used, undefined, "nothing has used it yet");
  const t0 = Date.now();
  await hub.each(PORCH, async () => undefined);
  const used = entry(PORCH).used;
  assert.ok(used !== undefined && used >= Math.floor(t0 / 1000) && used <= Date.now() / 1000 + 1, `used ${used}`);
  // A call that couldn't reach the player (Arch dropped off above) doesn't count.
  const [r] = await hub.each(ARCH, async () => undefined);
  assert.equal(r?.ok, false);
  assert.equal(entry(ARCH).used, undefined);
});

test("used: saved to the config, at most every 10 minutes per fixture", () => {
  let saves = 0;
  const cfg = { players: { [PORCH]: { host: porch.host } }, groups: {}, poses: {} } as const;
  const h = new Hub({
    root: "",
    mdns: false,
    config: structuredClone(cfg) as never,
    persist: () => void saves++,
    registryDeps: { sweepHosts: () => [] },
  });
  try {
    const t = 1_800_000_000_000;
    h.markUsed(PORCH, t);
    assert.equal(saves, 1);
    h.markUsed(PORCH, t + 60_000); // a minute later: memory only
    assert.equal(saves, 1);
    assert.equal(h.lastUsed(PORCH), t + 60_000);
    h.markUsed(PORCH, t + 11 * 60_000);
    assert.equal(saves, 2);
    h.markUsed("CC:FD:49:00:00:FF", t); // not remembered: memory only
    assert.equal(saves, 2);
    assert.equal(h.lastUsed("CC:FD:49:00:00:FF"), t);
  } finally {
    h.close();
  }
});
