/**
 * The app's live-VJ client (src/net/bridgeLive.ts) against fake sockets:
 * the bearer credential rides in the subprotocol list, hello/welcome, per-tick
 * coalescing (leading edge, last value wins, one frame per tick for many
 * controls), commit on release, the direct (LAN) path preferred with a relay
 * fallback, query replies, the relay's offline/online notices, and revocation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BridgeLiveClient, commonUniforms, liveProtocols, relayLiveUrl, type LiveSocket } from "../src/net/bridgeLive";
import type { WelcomeMsg } from "../src/net/liveProtocol";

class FakeSock implements LiveSocket {
  readyState = 0;
  sent: string[] = [];
  closedWith: number | undefined;
  onopen: ((ev?: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(d: string): void {
    this.sent.push(d);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(m: unknown): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  msgs(): Record<string, unknown>[] {
    return this.sent.filter((s) => s !== "ping").map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** A manual clock + timer queue. */
function clock() {
  let t = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => t,
    schedule: (fn: () => void, ms: number) => {
      timers.push({ at: t + ms, fn });
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

const welcome = (via: "relay" | "lan", extra: Partial<WelcomeMsg> = {}): WelcomeMsg => ({
  t: "welcome",
  v: 1,
  bridge: { id: "b" },
  via,
  lan: { url: "wss://10.0.0.5:8443/live", page: "https://10.0.0.5:8443/", sha256: "ab".repeat(32) },
  players: [{ id: "P1", name: "Kitchen", host: "10.0.0.7", connected: true, features: [], lock: null, effect: null }],
  rooms: {},
  tick_ms: via === "lan" ? 16 : 33,
  ...extra,
});

const creds = () => ({ relay: "https://splanc.pages.dev", token: "spl_pt_aaaaaaaaaaaaaaaaaaaa_" + "x".repeat(43), clientId: "client-000001", name: "Phone" });

test("relay URL and subprotocols carry the credential", () => {
  assert.equal(relayLiveUrl("https://splanc.pages.dev/"), "wss://splanc.pages.dev/live");
  assert.deepEqual(liveProtocols("tok"), ["splanc-live.v1", "bearer.tok"]);
});

test("connects via the relay, says hello, learns the LAN ticket, coalesces controls per tick", async () => {
  const c0 = clock();
  const socks: FakeSock[] = [];
  const lanSeen: (string | undefined)[] = [];
  const c = new BridgeLiveClient(creds(), {
    factory: (u, p) => {
      const s = new FakeSock(u, p);
      socks.push(s);
      return s;
    },
    preferLan: false,
    now: c0.now,
    schedule: c0.schedule,
  });
  c.events.onLan = (_lan, tok) => lanSeen.push(tok);
  const p = c.connect();
  const s = socks[0]!;
  assert.equal(s.url, "wss://splanc.pages.dev/live");
  assert.deepEqual(s.protocols, ["splanc-live.v1", `bearer.${creds().token}`]);
  s.open();
  assert.equal(s.msgs()[0]!["t"], "hello");
  assert.equal(s.msgs()[0]!["client_id"], "client-000001");
  s.recv(welcome("relay", { lan_token: "spl_lt_" + "y".repeat(43) }));
  const w = await p;
  assert.equal(w.via, "relay");
  assert.equal(c.via, "relay");
  assert.equal(c.state, "live");
  assert.deepEqual(lanSeen, ["spl_lt_" + "y".repeat(43)]);
  assert.equal(c.creds.lanToken, "spl_lt_" + "y".repeat(43));

  // Leading edge: the first move goes at once.
  c.control(["all"], { u: { rain: 0.1 } });
  assert.equal(s.msgs().filter((m) => m["t"] === "c").length, 1);
  // Many moves within the tick: held, merged, last value wins, ONE frame.
  for (let i = 2; i <= 50; i++) c.control(["all"], { u: { rain: i / 100 }, bri: i / 100 });
  c.control(["all"], { u: { speed: 2 } });
  c.control(["all"], { xf: { pos: 0.3 } });
  assert.equal(s.msgs().filter((m) => m["t"] === "c").length, 1);
  c0.advance(33);
  const cs = s.msgs().filter((m) => m["t"] === "c");
  assert.equal(cs.length, 2);
  assert.deepEqual(cs[1], { t: "c", to: ["all"], u: { rain: 0.5, speed: 2 }, xf: { pos: 0.3 }, bri: 0.5 });
  // Release: flush now, committed.
  c.control(["all"], { u: { rain: 0.9 }, commit: true });
  c.flush();
  assert.deepEqual(s.msgs().filter((m) => m["t"] === "c").at(-1), { t: "c", to: ["all"], u: { rain: 0.9 }, commit: true });
  // Different decks/targets are separate frames.
  c0.advance(100);
  c.control(["P1"], { deck: 1, u: { a: 1 } });
  c.control(["all"], { u: { a: 2 } });
  c0.advance(33);
  const last = s.msgs().filter((m) => m["t"] === "c").slice(-2);
  assert.deepEqual(last.map((m) => m["deck"] ?? 0).sort(), [0, 1]);
  assert.ok(c.stats.coalesced > 40);
});

test("queries resolve on their reply; ping measures the round trip", async () => {
  const c0 = clock();
  let s!: FakeSock;
  const c = new BridgeLiveClient(creds(), {
    factory: (u, p) => (s = new FakeSock(u, p)),
    preferLan: false,
    now: c0.now,
    schedule: c0.schedule,
  });
  const p = c.connect();
  s.open();
  s.recv(welcome("relay"));
  await p;
  const q = c.query("effect", { deck: 0 }, ["P1"]);
  const sent = s.msgs().at(-1)!;
  assert.equal(sent["t"], "q");
  assert.equal(sent["op"], "effect");
  s.recv({ t: "r", id: sent["id"], ok: true, results: [{ player: { id: "P1", name: "Kitchen" }, ok: true, result: { effect_id: "x" } }] });
  const r = await q;
  assert.equal(r.ok, true);
  const pp = c.ping();
  const pm = s.msgs().at(-1)!;
  c0.advance(42);
  s.recv({ t: "pong", id: pm["id"] });
  assert.equal(await pp, 42);
});

test("prefers the direct path when it has a ticket; falls back to the relay when it doesn't answer", async () => {
  const c0 = clock();
  const socks: FakeSock[] = [];
  const mk = () =>
    new BridgeLiveClient(
      { ...creds(), lan: welcome("lan").lan!, lanToken: "spl_lt_" + "z".repeat(43) },
      { factory: (u, p) => (socks.push(new FakeSock(u, p)), socks.at(-1)!), now: c0.now, schedule: c0.schedule, lanTimeoutMs: 3000 },
    );
  // Direct answers: used, tick 16 ms.
  const a = mk();
  const pa = a.connect();
  assert.equal(socks[0]!.url, "wss://10.0.0.5:8443/live");
  assert.deepEqual(socks[0]!.protocols, ["splanc-live.v1", "bearer.spl_lt_" + "z".repeat(43)]);
  socks[0]!.open();
  socks[0]!.recv(welcome("lan"));
  assert.equal((await pa).via, "lan");
  assert.equal(a.tickMs, 16);
  a.close();

  // Direct silent: timed out after 3 s, then the relay.
  socks.length = 0;
  const b = mk();
  const pb = b.connect();
  c0.advance(3000);
  await new Promise((r) => setImmediate(r));
  const relay = socks.find((x) => x.url.startsWith("wss://splanc.pages.dev"))!;
  assert.ok(relay, "fell back to the relay");
  relay.open();
  relay.recv(welcome("relay"));
  assert.equal((await pb).via, "relay");
  b.close();
});

test("relay notices: bridge offline, then online -> hello again; 4003 = revoked, no reconnect", async () => {
  const c0 = clock();
  const socks: FakeSock[] = [];
  const states: string[] = [];
  const c = new BridgeLiveClient(creds(), {
    factory: (u, p) => (socks.push(new FakeSock(u, p)), socks.at(-1)!),
    preferLan: false,
    now: c0.now,
    schedule: c0.schedule,
  });
  c.events.onState = (st) => states.push(st);
  const p = c.connect();
  socks[0]!.open();
  socks[0]!.recv(welcome("relay"));
  await p;
  socks[0]!.recv({ t: "relay", bridge: "offline" });
  assert.equal(c.state, "bridge-offline");
  const hellos = () => socks[0]!.msgs().filter((m) => m["t"] === "hello").length;
  socks[0]!.recv({ t: "relay", bridge: "online" });
  assert.equal(hellos(), 2);
  socks[0]!.recv(welcome("relay"));
  assert.equal(c.state, "live");
  socks[0]!.drop(4003);
  assert.equal(c.state, "revoked");
  c0.advance(60_000);
  assert.equal(socks.length, 1, "no reconnect after revocation");

  // An ordinary drop reconnects with backoff.
  const d = new BridgeLiveClient(creds(), {
    factory: (u, p2) => (socks.push(new FakeSock(u, p2)), socks.at(-1)!),
    preferLan: false,
    now: c0.now,
    schedule: c0.schedule,
  });
  const pd = d.connect();
  socks.at(-1)!.open();
  socks.at(-1)!.recv(welcome("relay"));
  await pd;
  const n = socks.length;
  socks.at(-1)!.drop(1006);
  assert.equal(d.state, "offline");
  c0.advance(600);
  assert.equal(socks.length, n + 1);
});

test("commonUniforms keeps the names every fixture has", () => {
  const u = (n: string) => ({ name: n });
  assert.deepEqual(commonUniforms([[u("a"), u("b"), u("c")], [u("b"), u("c")], [u("c"), u("b")]]).map((x) => x.name), ["b", "c"]);
  assert.deepEqual(commonUniforms([]), []);
});
