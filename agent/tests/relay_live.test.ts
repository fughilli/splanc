/**
 * The relay's live (VJ) pass-through (docs/design/live-vj-relay.md, "Relay"):
 * `GET /live` WebSockets authenticated by a bearer token in the subprotocol list,
 * routed to the bridge's Durable Object, passed through verbatim both ways as
 * `live` frames; refusals (no/bad token 401, MCP-only bridge 501, offline 503,
 * too many 429), the bridge going away and coming back, revocation closing the
 * socket, the per-socket rate limit, and the auto-answered keepalive.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import WebSocket from "ws";

import { LIVE_MAX_RATE_HZ, MAX_LIVE_CLIENTS, type LiveFrame, type LiveOpenFrame, type RelayFrame, type StateFrame } from "../relay/src/protocol";
import { RelayLink } from "../src/bridge/relayLink";
import { RelayHost } from "../src/relayHost";
import { tempIdentity, until } from "./relayHelpers";

const host = new RelayHost();
let relay = "";

before(async () => {
  relay = await host.listen();
});
after(async () => {
  await host.close();
});

function resetLimits(): void {
  const dir = host.storageOf("directory", "global");
  for (const k of [...(dir?.keys() ?? [])]) if (k.startsWith("rl:")) dir!.delete(k);
}

/** A bridge on the real RelayLink that records frames; `caps` says it speaks live. */
async function bridge(caps = true): Promise<{ link: RelayLink; frames: RelayFrame[] }> {
  resetLimits();
  const { identity } = tempIdentity();
  const link = new RelayLink({ relay, identity, backoff: { baseMs: 20, maxMs: 200 } });
  const frames: RelayFrame[] = [];
  link.onFrame = (f) => {
    frames.push(f);
    if (f.t === "hello" && caps) link.send({ t: "caps", live: 1 });
  };
  link.start();
  await until(() => link.online, "bridge online");
  return { link, frames };
}

async function pairToken(link: RelayLink, frames: RelayFrame[], label = "Test phone"): Promise<string> {
  const n = frames.length;
  link.send({ t: "new_code" });
  const f = await until(() => frames.slice(n).find((x): x is StateFrame => x.t === "state" && x.pairing !== null), "code");
  const r = await fetch(`${relay}/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ pairing_code: f.pairing!.code, label }),
  });
  assert.equal(r.status, 200);
  return ((await r.json()) as { token: string }).token;
}

interface App {
  ws: WebSocket;
  msgs: string[];
  closed: Promise<{ code: number; reason: string }>;
}

function openLive(token: string | null, protocols?: string[]): Promise<App> {
  const ws = new WebSocket(`${relay.replace(/^http/, "ws")}/live`, protocols ?? ["splanc-live.v1", ...(token ? [`bearer.${token}`] : [])]);
  const msgs: string[] = [];
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (code, reason) => r({ code, reason: reason.toString() })));
  ws.on("message", (d) => msgs.push(d.toString()));
  return new Promise((resolve, reject) => {
    ws.on("open", () => resolve({ ws, msgs, closed }));
    ws.on("unexpected-response", (_q, res) => {
      res.resume();
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
    });
    ws.on("error", () => undefined);
  });
}

const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { status?: number }) => e.status ?? -1);

test("refusals: no token, bad token (401, no object woken), MCP-only bridge (501)", async () => {
  assert.equal(await statusOf(openLive(null)), 401);
  assert.equal(await statusOf(openLive("spl_pt_aaaaaaaaaaaaaaaaaaaa_" + "x".repeat(43))), 401);
  // A token without our subprotocol is not a live request.
  const old = await bridge(false);
  const tok = await pairToken(old.link, old.frames);
  assert.equal(await statusOf(openLive(tok, [`bearer.${tok}`])), 401);
  assert.equal(await statusOf(openLive(tok)), 501);
  old.link.stop();
  await until(async () => (await statusOf(openLive(tok))) === 503, "offline -> 503");
});

test("pass-through both ways, subprotocol, keepalive, close in both directions", async () => {
  const { link, frames } = await bridge();
  const tok = await pairToken(link, frames, "Kevin's phone");
  try {
    const app = await openLive(tok);
    assert.equal(app.ws.protocol, "splanc-live.v1");
    const open = await until(() => frames.find((f): f is LiveOpenFrame => f.t === "live_open"), "live_open");
    assert.equal(open.label, "Kevin's phone");
    assert.ok(open.grant.length > 0);
    app.ws.send(JSON.stringify({ t: "hello", v: 1 }));
    const fwd = await until(() => frames.find((f): f is LiveFrame => f.t === "live"), "forwarded");
    assert.equal(fwd.c, open.c);
    assert.deepEqual(JSON.parse(fwd.d), { t: "hello", v: 1 });
    link.send({ t: "live", c: open.c, d: '{"t":"welcome"}' });
    await until(() => app.msgs.includes('{"t":"welcome"}'), "bridge -> app");
    // The keepalive text is answered by the relay itself (never reaches the bridge).
    const before = frames.length;
    app.ws.send("ping");
    await until(() => app.msgs.includes("pong"), "pong");
    assert.equal(frames.slice(before).filter((f) => f.t === "live").length, 0);
    // The app goes away: the bridge hears it.
    app.ws.close();
    await until(() => frames.some((f) => f.t === "live_close" && f.c === open.c), "live_close to bridge");
    // The bridge ends a session: the app's socket closes with 4005.
    const app2 = await openLive(tok);
    const open2 = await until(() => frames.find((f): f is LiveOpenFrame => f.t === "live_open" && f.c !== open.c), "second open");
    link.send({ t: "live_close", c: open2.c, reason: "bye" });
    assert.equal((await app2.closed).code, 4005);
  } finally {
    link.stop();
  }
});

test("bridge drops and returns: the app is told, the session is re-opened after caps", async () => {
  const { link, frames } = await bridge();
  const tok = await pairToken(link, frames);
  try {
    const app = await openLive(tok);
    const open = await until(() => frames.find((f): f is LiveOpenFrame => f.t === "live_open"), "live_open");
    const opens = () => frames.filter((f) => f.t === "live_open" && f.c === open.c).length;
    host.dropBridgeSockets();
    await until(() => app.msgs.some((m) => m.includes('"bridge":"offline"')), "offline notice");
    // While offline, app messages are answered with the notice (not lost silently).
    await until(() => link.online, "bridge reconnected");
    await until(() => opens() === 2, "live_open again");
    await until(() => app.msgs.some((m) => m.includes('"bridge":"online"')), "online notice");
    app.ws.send('{"t":"ping","id":1}');
    await until(() => frames.some((f) => f.t === "live" && f.d === '{"t":"ping","id":1}'), "forwarded after reconnect");
    app.ws.close();
  } finally {
    link.stop();
  }
});

test("revocation closes live sockets (4003) and tells the bridge which grant", async () => {
  const { link, frames } = await bridge();
  const tok = await pairToken(link, frames);
  try {
    const app = await openLive(tok);
    const open = await until(() => frames.find((f): f is LiveOpenFrame => f.t === "live_open"), "live_open");
    const r = await fetch(`${relay}/revoke`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tok }) });
    assert.equal(r.status, 200);
    assert.equal((await app.closed).code, 4003);
    await until(() => frames.some((f) => f.t === "revoked" && f.grants.includes(open.grant)), "revoked frame");
    assert.equal(await statusOf(openLive(tok)), 401);
    // revoke_all ends every session.
    const tok2 = await pairToken(link, frames);
    const app2 = await openLive(tok2);
    link.send({ t: "revoke_all" });
    assert.equal((await app2.closed).code, 4003);
    await until(() => frames.some((f) => f.t === "revoked" && f.grants.includes("*")), "revoked *");
  } finally {
    link.stop();
  }
});

test("a runaway client is rate-limited; at most MAX_LIVE_CLIENTS sockets", async () => {
  const { link, frames } = await bridge();
  const tok = await pairToken(link, frames);
  try {
    const app = await openLive(tok);
    await until(() => frames.some((f) => f.t === "live_open"), "open");
    const n0 = frames.filter((f) => f.t === "live").length;
    for (let i = 0; i < 3 * LIVE_MAX_RATE_HZ; i++) app.ws.send(`{"t":"c","i":${i}}`);
    await until(() => app.msgs.some((m) => m.includes("rate limited")), "rate-limit notice");
    await new Promise((r) => setTimeout(r, 200));
    const got = frames.filter((f) => f.t === "live").length - n0;
    assert.ok(got <= 2 * LIVE_MAX_RATE_HZ && got >= LIVE_MAX_RATE_HZ, `forwarded ${got}`);
    const more: App[] = [];
    for (let i = 1; i < MAX_LIVE_CLIENTS; i++) more.push(await openLive(tok));
    assert.equal(await statusOf(openLive(tok)), 429);
    for (const a of [app, ...more]) a.ws.close();
  } finally {
    link.stop();
  }
});
