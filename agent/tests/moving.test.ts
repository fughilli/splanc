/**
 * Players that move (field handoff, 2026-10: ESP32-C6 firmware that picks a random
 * Wi-Fi MAC every boot gets a NEW DHCP lease after every reboot): identity is the
 * device id, never the host, and a bridge that is never restarted must follow.
 *
 * - a player that vanishes without closing its socket (rebooted elsewhere) is
 *   detected by the session heartbeat, marked unreachable, found again at its new
 *   address by the background search (a LAN sweep for its manifest), and a deploy
 *   to it by name then just works — no add_player;
 * - one whose socket closes is given a short grace to reconnect, then searched for;
 * - a call in flight on a dead session fails with the specific reason, never hangs;
 * - add_player at a known player's new address updates that player (stale host
 *   entries pruned), and an unknown certificate under a known id is TLS CHANGED;
 * - a dead player's error says why (the connection error), never a generic one.
 */

import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { HubConfig } from "../src/config";
import { loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { Liveness } from "../src/liveness";
import { neighbourHint, parseProcArp } from "../src/netdiag";
import { errorText } from "../src/socket";
import { createServer } from "../src/server";
import { FakePlayer, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-moving-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
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
const LAMP = "8C:FD:49:10:3A:86";
const WIDGET = "F0:F5:BD:2C:E7:F2";

type Text = { type: string; text?: string };

const emptyConfig = (): HubConfig => ({ players: {}, groups: {}, poses: {} });

async function fake(name: string, mac: string, identity: 1 | 2 = 1): Promise<FakePlayer> {
  const p = new FakePlayer({ name, mac, identity });
  p.bundle = yFixture();
  await p.start();
  p.serveManifest();
  return p;
}

async function mcp(hub: Hub): Promise<Client> {
  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "moving-test", version: "0" });
  await c.connect(b);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: Text[] };
  const text = r.content.find((x) => x.type === "text")?.text ?? "";
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { isError: r.isError === true, text, json };
}

async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A hub tuned for tests: fast heartbeat, short reconnect grace, a quick search;
 * the "LAN" is whatever `lan` holds (the sweep's host list). */
function hubOn(lan: string[], cfg: HubConfig, extra: Partial<ConstructorParameters<typeof Hub>[0]> = {}): Hub {
  return new Hub({
    root: HOST_ROOT,
    mdns: false,
    config: cfg,
    persist: () => undefined,
    registryDeps: { sweepHosts: () => [...lan] },
    liveness: { idleMs: 150, busyMs: 150, pingTimeoutMs: 150, misses: 2 },
    reconnectGraceMs: 300,
    huntBackoffMs: [100, 200],
    connectTimeoutMs: 2000,
    ...extra,
  });
}

before(async () => {
  await loadFxHost(HOST_ROOT);
});

describe("a player that moves to a new IP", () => {
  const cleanup: FakePlayer[] = [];
  after(async () => {
    for (const p of cleanup) await p.stop().catch(() => undefined);
  });

  test("vanishes without closing its socket: heartbeat -> unreachable -> found at the new host -> deploy by name works, no add_player", async () => {
    const cfg = emptyConfig();
    const lamp = await fake("PixieLamp", LAMP);
    const widget = await fake("FugWidget", WIDGET);
    cleanup.push(lamp, widget);
    const lan = [lamp.host, widget.host, "127.0.0.1:1"];
    const hub = hubOn(lan, cfg);
    const c = await mcp(hub);
    try {
      const first = await call(c, "list_players");
      assert.deepEqual(first.json.players.map((p: any) => p.name), ["FugWidget", "PixieLamp"]);
      const d1 = await call(c, "deploy_effect", { effect_id: "mood", source: EFFECT, players: "PixieLamp" });
      assert.equal(d1.isError, false, d1.text);
      assert.equal(lamp.effect?.id, "mood");
      const oldHost = lamp.host;

      // Power-cycle: the old socket goes dead silently, the player comes back
      // (same id, same certificate) at another address.
      lamp.freeze();
      const back = await fake("PixieLamp", LAMP);
      cleanup.push(back);
      lan.push(back.host);

      // The bridge notices by itself (heartbeat), and finds it again (sweep by id).
      await until(async () => {
        const l = await call(c, "list_players");
        const p = l.json.players.find((x: any) => x.id === LAMP);
        return p?.host === back.host && p.checked !== "unreachable";
      }, "the lamp listed at its new host");
      const l = await call(c, "list_players");
      assert.equal(l.json.players.length, 2, "no duplicate, no stale host entry");
      assert.ok(!l.json.players.some((p: any) => p.host === oldHost));
      assert.equal(cfg.players[LAMP]?.host, back.host, "remembered at the new host");

      const d2 = await call(c, "deploy_effect", { effect_id: "rain", source: EFFECT, players: "PixieLamp" });
      assert.equal(d2.isError, false, d2.text);
      assert.equal(back.effect?.id, "rain");
      const listed = (await call(c, "list_players")).json.players.find((x: any) => x.id === LAMP);
      assert.equal(listed.checked, "session");
      assert.equal(listed.session.state, "live");
      // The other fixture never noticed.
      assert.equal((await call(c, "set_brightness", { level: 0.3, players: "FugWidget" })).isError, false);
    } finally {
      hub.close();
    }
  });

  test("a call in flight on a session that goes dead fails fast with the reason (never hangs)", async () => {
    const cfg = emptyConfig();
    const lamp = await fake("PixieLamp", LAMP);
    cleanup.push(lamp);
    const hub = hubOn([lamp.host], cfg, { huntBackoffMs: [] });
    const c = await mcp(hub);
    try {
      assert.equal((await call(c, "set_brightness", { level: 0.5, players: "PixieLamp" })).isError, false);
      lamp.freeze();
      const t0 = Date.now();
      const r = await call(c, "set_brightness", { level: 0.6, players: "PixieLamp" });
      const took = Date.now() - t0;
      assert.ok(took < 5000, `answered in ${took} ms`);
      const res = r.json.results[0];
      assert.equal(res.ok, false);
      assert.match(res.error, /PixieLamp stopped answering during the call: no reply|no reply to two heartbeat pings/);
      assert.doesNotMatch(res.error, /tool call failed/i);
      // ...and the player is now listed as unreachable, with the reason.
      const p = (await call(c, "list_players")).json.players[0];
      assert.equal(p.checked, "unreachable");
      assert.match(p.error, /no reply/);
      assert.equal(p.session.state, "none");
    } finally {
      hub.close();
    }
  });

  test("its socket closes: a short grace to reconnect, then it is looked for and found", async () => {
    const cfg = emptyConfig();
    const lamp = await fake("PixieLamp", LAMP);
    cleanup.push(lamp);
    const lan = [lamp.host];
    const hub = hubOn(lan, cfg);
    const c = await mcp(hub);
    try {
      assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, false);
      await lamp.stop(); // RST/close: the bridge's socket closes; nothing listens there now
      const back = await fake("PixieLamp", LAMP);
      cleanup.push(back);
      lan.push(back.host);
      await until(() => hub.registry.get(LAMP)?.host === back.host, "found at the new host");
      const r = await call(c, "set_brightness", { level: 0.25 });
      assert.equal(r.isError, false, r.text);
      assert.equal(back.brightness, 0.25);
    } finally {
      hub.close();
    }
  });

  test("a deploy right after the move, before the heartbeat noticed: the call re-finds it by id", async () => {
    const cfg = emptyConfig();
    const lamp = await fake("PixieLamp", LAMP);
    cleanup.push(lamp);
    const lan = [lamp.host];
    // A slow heartbeat (it won't notice by itself during this test) and no
    // background search: the tool call itself must verify and re-find the player.
    const hub = hubOn(lan, cfg, { liveness: { idleMs: 60_000, busyMs: 150, pingTimeoutMs: 150, misses: 2 }, huntBackoffMs: [] });
    const c = await mcp(hub);
    try {
      assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, false);
      lamp.freeze();
      const back = await fake("PixieLamp", LAMP);
      cleanup.push(back);
      lan.push(back.host);
      // Silent long enough that the tool pings before using the session.
      const live = [...(hub as unknown as { liveness: Map<unknown, Liveness> }).liveness.values()][0]!;
      live.lastRx -= 20_000;
      const r = await call(c, "deploy_effect", { effect_id: "rain", source: EFFECT, players: "PixieLamp" });
      assert.equal(r.isError, false, r.text);
      assert.equal(back.effect?.id, "rain");
      assert.equal(hub.registry.get(LAMP)?.host, back.host);
    } finally {
      hub.close();
    }
  });

  test("add_player at a known player's new address updates it (no error, no duplicate); the stale host entry goes", async () => {
    const cfg = emptyConfig();
    const lamp = await fake("PixieLamp", LAMP);
    cleanup.push(lamp);
    // Found only through an explicit host (no sweep, no search): the field setup
    // after add_player <old ip>.
    const hub = hubOn([], cfg, { hosts: [lamp.host], huntBackoffMs: [] });
    const c = await mcp(hub);
    try {
      assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, false);
      const oldHost = lamp.host;
      lamp.freeze();
      const back = await fake("PixieLamp", LAMP);
      cleanup.push(back);
      const r = await call(c, "add_player", { host: back.host });
      assert.equal(r.isError, false, r.text);
      assert.equal(r.json.ok, true, r.text);
      assert.equal(r.json.player.id, LAMP);
      const l = await call(c, "refresh_players");
      assert.deepEqual(
        l.json.players.map((p: any) => [p.id, p.host]),
        [[LAMP, back.host]],
        "one record, at the new host: the old address isn't kept as a host: entry",
      );
      assert.ok(!l.json.players.some((p: any) => p.host === oldHost));
      const d = await call(c, "deploy_effect", { effect_id: "mood", source: EFFECT, players: "PixieLamp" });
      assert.equal(d.isError, false, d.text);
      assert.equal(back.effect?.id, "mood");
    } finally {
      hub.close();
    }
  });

  test("add_player at a known id presenting another certificate: TLS CHANGED (trust_player), not a generic failure", async () => {
    const cfg = emptyConfig();
    const lamp = await fake("PixieLamp", LAMP);
    cleanup.push(lamp);
    const hub = hubOn([], cfg, { hosts: [lamp.host], huntBackoffMs: [] });
    const c = await mcp(hub);
    try {
      assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, false);
      lamp.freeze();
      const impostor = await fake("PixieLamp", LAMP, 2);
      cleanup.push(impostor);
      const r = await call(c, "add_player", { host: impostor.host });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, /REFUSING PixieLamp .*certificate changed/);
      assert.match(r.text, /trust_player/);
      // Identifying an unknown host takes its hello/welcome; nothing else is sent.
      assert.deepEqual(impostor.types(), ["hello"]);
      const p = (await call(c, "list_players")).json.players.find((x: any) => x.id === LAMP);
      assert.match(p.tls, /^CHANGED/);
    } finally {
      hub.close();
    }
  });

  test("another player that got this player's old IP is 'moved', never 'TLS CHANGED' (and never driven in its place)", async () => {
    const cfg = emptyConfig();
    const lamp = await fake("PixieLamp", LAMP);
    cleanup.push(lamp);
    const lan = [lamp.host];
    const hub = hubOn(lan, cfg, { huntBackoffMs: [] });
    const c = await mcp(hub);
    try {
      assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, false);
      const port = lamp.port;
      await lamp.stop();
      // The widget (its own certificate) gets the lamp's old address.
      const widget = new FakePlayer({ name: "FugWidget", mac: WIDGET, identity: 2 });
      widget.bundle = yFixture();
      await widget.start(port);
      widget.serveManifest();
      cleanup.push(widget);
      await until(() => hub.registry.get(LAMP)?.checked === "unreachable", "lamp session dropped");
      const r = await call(c, "set_brightness", { level: 0.9, players: "PixieLamp" });
      const err: string = r.json?.results?.[0]?.error ?? r.text;
      assert.match(err, /PixieLamp \(8C:FD:49:10:3A:86\) isn't at 127\.0\.0\.1:\d+ any more: FugWidget \(F0:F5:BD:2C:E7:F2\) answers there now/);
      assert.doesNotMatch(err, /REFUSING|certificate changed/);
      assert.equal(widget.brightness, 1, "the widget was not driven as the lamp");
      assert.notEqual(hub.registry.get(LAMP)?.trust?.kind, "changed", "the lamp's own certificate is still trusted");
      // The lamp turns up elsewhere: found, and usable.
      const back = await fake("PixieLamp", LAMP);
      cleanup.push(back);
      lan.push(back.host);
      const ok = await call(c, "set_brightness", { level: 0.8, players: "PixieLamp" });
      assert.equal(ok.json?.results?.[0]?.ok ?? !ok.isError, true, ok.text);
      assert.equal(back.brightness, 0.8);
      assert.equal(widget.brightness, 1);
    } finally {
      hub.close();
    }
  });

  test("a dead player's error is the specific cause, never generic", async () => {
    const cfg = emptyConfig();
    const lamp = await fake("PixieLamp", LAMP);
    cleanup.push(lamp);
    const lan = [lamp.host];
    const hub = hubOn(lan, cfg, { huntBackoffMs: [] });
    const c = await mcp(hub);
    try {
      assert.equal((await call(c, "set_brightness", { level: 0.5 })).isError, false);
      await lamp.stop(); // gone for good: nothing listens anywhere
      lan.length = 0;
      await until(() => hub.registry.get(LAMP)?.checked === "unreachable", "marked unreachable");
      const r = await call(c, "deploy_effect", { effect_id: "mood", source: EFFECT, players: "PixieLamp" });
      const err: string = r.json?.results?.[0]?.error ?? r.text;
      assert.match(err, /can't reach PixieLamp at 127\.0\.0\.1:\d+: .*ECONNREFUSED/);
      assert.match(err, /Not found anywhere else either/);
      // A name that was never a player: still a specific answer.
      const none = await call(c, "set_brightness", { level: 0.5, players: "Nobody" });
      assert.equal(none.isError, true);
      assert.match(none.text, /no player or room "Nobody"/);
    } finally {
      hub.close();
    }
  });
});

describe("liveness", () => {
  // The watchdog's own timer is unref'd (it must never keep a CLI alive): hold the
  // event loop open while these tests wait on it.
  let hold: ReturnType<typeof setInterval>;
  before(() => {
    hold = setInterval(() => undefined, 1000);
  });
  after(() => clearInterval(hold));

  test("a ping answered keeps it alive; silence through every miss kills it, failing in-flight calls first", async () => {
    let answer = true;
    const deaths: string[] = [];
    const live = new Liveness(
      async (t) => {
        if (!answer) await new Promise((r) => setTimeout(r, t + 5)).then(() => Promise.reject(new Error("timeout")));
      },
      (why) => deaths.push(why),
      { idleMs: 60, busyMs: 60, pingTimeoutMs: 40, misses: 2 },
    );
    try {
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(live.dead, null);
      answer = false;
      const hang = new Promise<never>(() => undefined);
      await assert.rejects(live.watch(hang), /no reply from the player/);
      assert.equal(deaths.length, 1);
      await assert.rejects(live.watch(Promise.resolve(1)), /no reply/);
    } finally {
      live.stop();
    }
  });

  test("traffic counts as life even when a pong is late", async () => {
    let live!: Liveness;
    live = new Liveness(
      async (t) => {
        live.rx(); // something else arrived meanwhile
        await new Promise((_, rej) => setTimeout(() => rej(new Error("late")), t));
      },
      () => assert.fail("declared dead"),
      { idleMs: 30, busyMs: 30, pingTimeoutMs: 20, misses: 1 },
    );
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(live.dead, null);
    live.stop();
  });
});

describe("error text", () => {
  test("an AggregateError (localhost: ::1 + 127.0.0.1 both refused) is never an empty cause", () => {
    const refused = (a: string) => Object.assign(new Error(`connect ECONNREFUSED ${a}`), { code: "ECONNREFUSED" });
    const agg = new AggregateError([refused("::1:443"), refused("127.0.0.1:443")], "");
    assert.equal(errorText(agg), "connect ECONNREFUSED ::1:443; connect ECONNREFUSED 127.0.0.1:443");
    assert.equal(errorText(Object.assign(new Error(""), { code: "EHOSTUNREACH" })), "EHOSTUNREACH");
    assert.equal(errorText(new Error("boom")), "boom");
  });
});

describe("neighbour hints", () => {
  const ARP =
    "IP address       HW type     Flags       HW address            Mask     Device\n" +
    "169.254.100.163  0x1         0x6         02:0c:6a:11:8e:a1     *        wlan0\n" +
    "169.254.100.155  0x1         0x0         00:00:00:00:00:00     *        wlan0\n" +
    "169.254.100.165  0x1         0x2         02:0c:6a:44:01:9c     *        wlan0\n";

  test("a PERMANENT entry (the field's stale .163 pin) is named, with how to remove it", () => {
    assert.equal(parseProcArp(ARP).length, 3);
    const h = neighbourHint("169.254.100.163", () => ARP);
    assert.match(h, /PERMANENT ARP entry for 169\.254\.100\.163 -> 02:0c:6a:11:8e:a1 on wlan0/);
    assert.match(h, /sudo ip neigh del 169\.254\.100\.163 dev wlan0/);
  });

  test("an incomplete entry: nothing answers ARP there; a normal one: no hint", () => {
    assert.match(neighbourHint("169.254.100.155:443", () => ARP), /nothing answers ARP at 169\.254\.100\.155/);
    assert.equal(neighbourHint("169.254.100.165", () => ARP), "");
    assert.equal(neighbourHint("lamp.local", () => ARP), "");
    assert.equal(
      neighbourHint("10.0.0.1", () => {
        throw new Error("no /proc");
      }),
      "",
    );
  });
});
