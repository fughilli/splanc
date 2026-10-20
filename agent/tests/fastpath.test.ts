/**
 * The fast path (agent first-call latency): every TLS handshake costs a real
 * player ~0.7 s of ECDHE and it serves one at a time, so the hub must not spend
 * them on discovery. Pins, per call, what the player sees: a cold call to a new
 * host is ONE /ws session (no manifest GET, reused by the tool); a warm call
 * (remembered player) reaches it with no TLS before the tool and one session for
 * it; mDNS is skipped when hosts are given and cut short when the known players
 * already answered; an unreachable host fails fast. Plus the progress the CLI
 * prints and the MCP server sends as notifications/progress.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { HubConfig } from "../src/config";
import type { Advert, BrowseOptions } from "../src/discovery";
import { Hub } from "../src/hub";
import { createServer } from "../src/server";
import { FakePlayer, TEST_CERT_SHA256, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-fastpath-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");

const emptyConfig = (): HubConfig => ({ players: {}, groups: {}, poses: {} });

async function startPlayers(n: number): Promise<FakePlayer[]> {
  const out: FakePlayer[] = [];
  for (let i = 0; i < n; i++) {
    const p = new FakePlayer({ name: `Fixture ${"ABC"[i]}`, mac: `CC:FD:49:00:05:0${i}` });
    p.bundle = yFixture();
    await p.start();
    p.serveManifest();
    out.push(p);
  }
  return out;
}

/** A hub as the CLI makes one per call, sharing `cfg` across "calls". */
function hubFor(hosts: string[], cfg: HubConfig, extra: Partial<ConstructorParameters<typeof Hub>[0]> = {}): Hub {
  return new Hub({
    root: WASM_ROOT,
    hosts,
    config: cfg,
    persist: () => undefined,
    ...extra,
    registryDeps: { sweepHosts: () => [], ...extra.registryDeps },
  });
}

async function mcp(hub: Hub): Promise<Client> {
  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "fastpath-test", version: "0" });
  await c.connect(b);
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}, onprogress?: (m: string) => void) {
  const r = (await c.callTool({ name, arguments: args }, undefined, {
    ...(onprogress
      ? {
          onprogress: (p: { message?: string | undefined }) => {
            if (p.message) onprogress(p.message);
          },
        }
      : {}),
  })) as { isError?: boolean; content: { type: string; text?: string }[] };
  const text = r.content.find((x) => x.type === "text")?.text ?? "";
  return { isError: r.isError === true, text, json: JSON.parse(text.startsWith("{") ? text : "null") };
}

/** A browse that never hears anything: resolves at its timeout, or when aborted. */
function silentBrowse(calls: { ms: number; aborted: boolean; took: number }[]) {
  return (ms: number, opts: BrowseOptions = {}): Promise<Advert[]> =>
    new Promise((res) => {
      const t0 = performance.now();
      const rec = { ms, aborted: false, took: 0 };
      calls.push(rec);
      const done = () => {
        rec.took = performance.now() - t0;
        res([]);
      };
      const t = setTimeout(done, ms);
      opts.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rec.aborted = true;
        done();
      });
    });
}

describe("handshakes per call", () => {
  let ps: FakePlayer[];
  before(async () => {
    ps = await startPlayers(2);
  });
  after(async () => {
    for (const p of ps) await p.stop();
  });

  test("cold: a new host costs one /ws session (no manifest GET), reused by the tool; its cert is remembered", async () => {
    const cfg = emptyConfig();
    const hub = hubFor(
      ps.map((p) => p.host),
      cfg,
    );
    const c = await mcp(hub);
    try {
      const r = await call(c, "set_brightness", { level: 0.3 });
      assert.equal(r.isError, false, r.text);
      assert.ok(ps.every((p) => p.brightness === 0.3));
      for (const p of ps) assert.deepEqual(p.connections, ["ws"], `${p.name}: ${p.connections.join(", ")}`);
      // Trust on first use: the session's certificate is the pin from now on.
      const want = TEST_CERT_SHA256.replace(/:/g, "").toLowerCase();
      assert.deepEqual(
        Object.values(cfg.players).map((x) => x.pin),
        [want, want],
      );
      // Features came from Welcome, not a manifest.
      const d = await call(c, "list_uniforms", { players: "Fixture A" });
      assert.equal(d.isError, false, d.text);
      assert.deepEqual(ps[0]!.connections, ["ws"]);
    } finally {
      hub.close();
    }
  });

  test("warm: list_players needs no TLS at all; a device tool opens exactly one session", async () => {
    // A remembered config, as the first call left it.
    const cfg = emptyConfig();
    const first = hubFor(
      ps.map((p) => p.host),
      cfg,
    );
    await first.players();
    first.close();
    for (const p of ps) p.connections.length = 0;

    const browses: { ms: number; aborted: boolean; took: number }[] = [];
    const hub = hubFor([], cfg, { registryDeps: { browse: silentBrowse(browses) } });
    const c = await mcp(hub);
    try {
      const t0 = performance.now();
      const l = await call(c, "list_players");
      assert.equal(l.json.players.length, 2, l.text);
      assert.ok(l.json.players.every((p: { checked: string }) => p.checked === "tcp"), l.text);
      for (const p of ps) assert.deepEqual(p.connections, [], `${p.name}: no TLS for a cached list`);
      // mDNS ran (no hosts given), but was cut short once both known players answered.
      assert.equal(browses.length, 1);
      assert.ok(browses[0]!.aborted, "mDNS stopped early");
      assert.ok(performance.now() - t0 < 1200, `list took ${performance.now() - t0} ms`);
      const r = await call(c, "set_brightness", { level: 0.6 });
      assert.equal(r.isError, false, r.text);
      for (const p of ps) assert.deepEqual(p.connections, ["ws"], `${p.name}: ${p.connections.join(", ")}`);
    } finally {
      hub.close();
    }
  });

  test("warm(): the MCP server opens sessions ahead of the first tool call", async () => {
    const cfg = emptyConfig();
    const first = hubFor(
      ps.map((p) => p.host),
      cfg,
    );
    await first.players();
    first.close();
    for (const p of ps) p.connections.length = 0;
    const hub = hubFor([], cfg, { mdns: false });
    const c = await mcp(hub);
    try {
      await hub.warm();
      for (const p of ps) assert.deepEqual(p.connections, ["ws"]);
      const seen: string[] = [];
      const r = await call(c, "set_brightness", { level: 0.45 }, (m) => seen.push(m));
      assert.equal(r.isError, false, r.text);
      assert.ok(!seen.some((m) => /connecting/.test(m)), `no connect in the tool call: ${seen.join(" | ")}`);
      for (const p of ps) assert.deepEqual(p.connections, ["ws"], "the warmed session served the tool");
    } finally {
      hub.close();
    }
  });

  test("warm device tool: no probe, no mDNS before its session; a moved player is found by its advert", async () => {
    const cfg = emptyConfig();
    const first = hubFor(
      ps.map((p) => p.host),
      cfg,
    );
    await first.players();
    first.close();
    for (const p of ps) p.connections.length = 0;
    let probes = 0;
    const browses: { ms: number; aborted: boolean; took: number }[] = [];
    let hub = hubFor([], cfg, {
      registryDeps: { browse: silentBrowse(browses), probePort: async () => (probes++, true) },
    });
    let c = await mcp(hub);
    try {
      const r = await call(c, "set_brightness", { level: 0.55 });
      assert.equal(r.isError, false, r.text);
      assert.equal(probes, 0, "no TCP probe ahead of the session");
      assert.equal(browses.length, 0, "no mDNS when the players are remembered");
      for (const p of ps) assert.deepEqual(p.connections, ["ws"]);
    } finally {
      hub.close();
    }
    // Player A "moved": its remembered host is dead; mDNS knows the new one.
    const a = ps[0]!;
    const id = a.mac.toUpperCase();
    cfg.players[id]!.host = "127.0.0.1:1";
    const advert: Advert = { instance: "A", host: "a.local", port: a.port, addresses: ["127.0.0.1"], txt: { id: a.mac } };
    hub = hubFor([], cfg, {
      registryDeps: {
        browse: async (_ms: number, o: BrowseOptions = {}) => {
          o.onAdvert?.(advert);
          return [advert];
        },
      },
    });
    c = await mcp(hub);
    try {
      const r = await call(c, "set_brightness", { level: 0.65, players: "Fixture A" });
      assert.equal(r.isError, false, r.text);
      assert.equal(a.brightness, 0.65);
      assert.equal(cfg.players[id]!.host, a.host, "the new host is remembered");
    } finally {
      hub.close();
    }
  });

  test("hosts given: no mDNS wait, no sweep", async () => {
    const browses: { ms: number; aborted: boolean; took: number }[] = [];
    let swept = 0;
    const hub = hubFor(
      ps.map((p) => p.host),
      emptyConfig(),
      { registryDeps: { browse: silentBrowse(browses), sweepHosts: () => (swept++, []) } },
    );
    try {
      assert.equal((await hub.players()).length, 2);
      assert.equal(browses.length, 0, "no mDNS with explicit hosts");
      assert.equal(swept, 0, "no sweep with explicit hosts");
    } finally {
      hub.close();
    }
  });

  test("refresh_players is the thorough path: mDNS even with hosts, manifests re-read", async () => {
    const browses: { ms: number; aborted: boolean; took: number }[] = [];
    const hub = hubFor(
      ps.map((p) => p.host),
      emptyConfig(),
      { registryDeps: { browse: silentBrowse(browses) } },
    );
    const c = await mcp(hub);
    for (const p of ps) p.connections.length = 0;
    try {
      const r = await call(c, "refresh_players");
      assert.equal(r.json.players.length, 2, r.text);
      assert.equal(browses.length, 1);
      assert.ok(r.json.players.every((p: { manifest: string }) => p.manifest === "yes"), r.text);
      for (const p of ps) assert.ok(p.connections.includes("manifest"));
    } finally {
      hub.close();
    }
  });

  test("an unreachable host fails fast, with the reason, without holding up the others", async () => {
    const hub = hubFor([ps[0]!.host, "127.0.0.1:1"], emptyConfig());
    const c = await mcp(hub);
    try {
      const t0 = performance.now();
      const l = await call(c, "list_players");
      const dead = l.json.players.find((p: { host: string }) => p.host === "127.0.0.1:1");
      assert.equal(dead.checked, "unreachable", l.text);
      assert.match(dead.error, /ECONNREFUSED|no answer/);
      const r = await call(c, "set_brightness", { level: 0.5, players: "all" });
      assert.equal(r.json.summary, "1 ok, 1 failed", r.text);
      assert.ok(performance.now() - t0 < 4000, `took ${performance.now() - t0} ms`);
    } finally {
      hub.close();
    }
  });
});

describe("progress", () => {
  test("a tool call streams phase progress as MCP notifications/progress", async () => {
    const ps = await startPlayers(1);
    const hub = hubFor([ps[0]!.host], emptyConfig());
    const c = await mcp(hub);
    try {
      const seen: string[] = [];
      const r = await call(c, "set_brightness", { level: 0.2 }, (m) => seen.push(m));
      assert.equal(r.isError, false, r.text);
      assert.ok(seen.some((m) => /^discovering/.test(m)), seen.join(" | "));
      assert.ok(seen.some((m) => /^connecting /.test(m)), seen.join(" | "));
      assert.ok(seen.some((m) => /^Fixture A: connected \d+ ms/.test(m)), seen.join(" | "));
      assert.ok(seen.some((m) => /^found 1 player/.test(m)), seen.join(" | "));
    } finally {
      hub.close();
      await ps[0]!.stop();
    }
  });
});
