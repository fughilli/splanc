/**
 * `splanc-agent bridge` (src/bridge/lanBridge.ts) against the in-process relay
 * and a fake player: the display contract (status.json fields + states,
 * atomic writes, the control socket's commands), the paired-client list and
 * revoking one client (also against an older relay that keeps no list), and
 * reconnecting (dropped socket, relay down -> offline -> back, with credentials
 * kept across a relay restart).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { WebSocketServer } from "ws";

import { LanBridge, RELAY_OUTDATED, type BridgeClient, type BridgeStatus } from "../src/bridge/lanBridge";
import { DEFAULT_RELAY_URL, RelayLink, relayUrl } from "../src/bridge/relayLink";
import { Hub } from "../src/hub";
import { RelayHost } from "../src/relayHost";
import { FakePlayer, yFixture } from "./fakePlayer";
import { tempIdentity, until } from "./relayHelpers";

const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-lanbridge-"));
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");

const STATUS = join(SCRATCH, "run", "status.json");
const CONTROL = join(SCRATCH, "run", "control.sock");
const DATA = join(SCRATCH, "relay", "relay.json");

let host: RelayHost;
let relay = "";
let port = 0;
let player: FakePlayer;
let hub: Hub;
let link: RelayLink;
let bridge: LanBridge;

const readStatus = (): BridgeStatus => JSON.parse(readFileSync(STATUS, "utf8")) as BridgeStatus;

function ctl(cmd: string, args: Record<string, unknown> = {}, path = CONTROL): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const c = net.connect(path, () => c.write(`${JSON.stringify({ ...args, cmd })}\n`));
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        c.end();
        resolve(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
      }
    });
    c.on("error", reject);
  });
}

async function startHost(): Promise<void> {
  host = new RelayHost({ port, dataFile: DATA });
  relay = await host.listen();
  port = Number(new URL(relay).port);
}

before(async () => {
  await startHost();
  player = new FakePlayer({ name: "Porch", mac: "CC:FD:49:00:00:AA" });
  player.bundle = yFixture();
  await player.start();
  player.serveManifest();
  hub = new Hub({
    root: "",
    hosts: [player.host],
    mdns: false,
    config: { players: {}, groups: {}, poses: {} },
    persist: () => undefined,
    registryDeps: { sweepHosts: () => [] },
  });
  const { identity } = tempIdentity();
  link = new RelayLink({ relay, identity, backoff: { baseMs: 50, maxMs: 400 }, pingMs: 200 });
  bridge = new LanBridge({ link, hub, statusPath: STATUS, controlPath: CONTROL, heartbeatMs: 1000, refreshMs: 0 });
  await bridge.start();
});

after(async () => {
  await bridge.stop();
  hub.close();
  await player.stop();
  await host.close().catch(() => undefined);
});

describe("display contract", () => {
  test("status.json: every field of contract v1; unpaired bridges show a code by themselves", async () => {
    const s = await until(() => {
      const x = readStatus();
      return x.state === "pairing" && x.players.length === 1 ? x : null;
    }, "pairing state with the player listed");
    assert.deepEqual(
      Object.keys(s).sort(),
      ["bridge_id", "clients", "error", "lan_ip", "pairing", "paired_clients", "paired_clients_state", "players", "relay", "state", "updated_at", "v"].sort(),
    );
    assert.deepEqual(s.paired_clients, []);
    assert.equal(s.paired_clients_state, "ok");
    assert.equal(s.v, 1);
    assert.equal(s.relay, relay);
    assert.match(s.bridge_id, /^[a-z2-7]{20}$/);
    assert.match(s.pairing!.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(s.pairing!.expires_at > Date.now() / 1000 + 500);
    assert.equal(s.pairing!.url, `${relay}/pair?code=${encodeURIComponent(s.pairing!.code)}`);
    assert.equal(s.clients, 0);
    // v1's name/host/ok, plus the optional fixture details (bridgestatus.test.ts).
    assert.equal(s.players.length, 1);
    assert.deepEqual(
      { name: s.players[0]!.name, host: s.players[0]!.host, ok: s.players[0]!.ok, id: s.players[0]!.id },
      { name: "Porch", host: player.host, ok: true, id: "CC:FD:49:00:00:AA" },
    );
    assert.equal(s.error, null);
    assert.ok(Math.abs(s.updated_at - Date.now() / 1000) < 5);
    // Atomic writes: no temp files left beside it.
    assert.deepEqual(readdirSync(join(SCRATCH, "run")).filter((f) => f.endsWith(".tmp")), []);
  });

  test("control: status, new_pairing_code, identify, unknown commands", async () => {
    const st = await ctl("status");
    assert.equal(st["ok"], true);
    assert.equal((st["status"] as BridgeStatus).state, "pairing");
    const before = readStatus().pairing!.code;
    const n = await ctl("new_pairing_code");
    assert.equal(n["ok"], true);
    const code = (n["pairing"] as { code: string }).code;
    assert.notEqual(code, before);
    await until(() => readStatus().pairing?.code === code, "status shows the new code");
    const id = await ctl("identify");
    assert.equal(id["ok"], true);
    assert.equal(id["players"], 1);
    assert.ok(player.received.filter((m) => m.type === "set_brightness").length >= 2, "the fixture blinked");
    const bad = await ctl("reboot");
    assert.equal(bad["ok"], false);
  });

  test("redeeming the code -> paired; revoke_all -> credentials gone", async () => {
    const code = readStatus().pairing!.code;
    const r = await fetch(`${relay}/pair`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ pairing_code: code }),
    });
    assert.equal(r.status, 200);
    await until(() => readStatus().state === "paired", "paired");
    assert.equal(readStatus().pairing, null);
    const rv = await ctl("revoke_all");
    assert.equal(rv["ok"], true);
    assert.equal(rv["revoked"], 1);
    // No credentials left: unpaired (or already showing a fresh code).
    await until(() => ["unpaired", "pairing"].includes(readStatus().state), "unpaired after revoke");
    assert.equal(link.credentials, 0);
    await until(() => readStatus().paired_clients.length === 0, "list emptied");
  });

  test("clients + revoke: the list in status.json and over the socket; revoke one by id or prefix", async () => {
    const pair = async (body: Record<string, string>) => {
      const n = await ctl("new_pairing_code");
      const r = await fetch(`${relay}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ pairing_code: (n["pairing"] as { code: string }).code, ...body }),
      });
      assert.equal(r.status, 200);
      return ((await r.json()) as { token: string }).token;
    };
    const phoneTok = await pair({ label: "Kevin's phone", client: "app" });
    const curlTok = await pair({ label: "curl" });
    const s = await until(() => {
      const x = readStatus();
      return x.paired_clients.length === 2 ? x : null;
    }, "two clients in status.json");
    const phone = s.paired_clients.find((c) => c.label === "Kevin's phone")!;
    assert.deepEqual(Object.keys(phone).sort(), ["created_at", "id", "kind", "label", "last_used_at", "live"]);
    assert.equal(phone.kind, "app");
    assert.equal(phone.live, false);
    assert.equal(phone.last_used_at, null);
    assert.equal(s.paired_clients.find((c) => c.label === "curl")!.kind, "token");
    const listed = await ctl("clients");
    assert.equal(listed["ok"], true);
    assert.equal(listed["state"], "ok");
    assert.equal((listed["clients"] as BridgeClient[]).length, 2);

    // A use through the relay shows up as last used, and live (within 10 min).
    const used = await fetch(`${relay}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${curlTok}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    await used.text();
    await until(() => readStatus().paired_clients.find((c) => c.label === "curl")?.live, "curl live after a call");

    // Revoke by a prefix of the id: gone from the list, its token refused.
    const rv = await ctl("revoke", { grant: phone.id.slice(0, 6) });
    assert.equal(rv["ok"], true, JSON.stringify(rv));
    assert.equal(rv["revoked"], phone.id);
    assert.equal(rv["label"], "Kevin's phone");
    await until(() => readStatus().paired_clients.length === 1, "one left");
    const after = await fetch(`${relay}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${phoneTok}` },
      body: "{}",
    });
    assert.equal(after.status, 401);
    // Unknown id, or none at all: refused with a reason.
    const bad = await ctl("revoke", { grant: "zzzzzzzz" });
    assert.equal(bad["ok"], false);
    assert.match(String(bad["error"]), /no paired client/);
    assert.equal((await ctl("revoke"))["ok"], false);
    // Leave nothing paired for the tests after this one.
    assert.equal((await ctl("revoke_all"))["ok"], true);
    await until(() => readStatus().paired_clients.length === 0, "cleared");
  });
});

describe("an older relay (no client list)", () => {
  test("the bridge connects, says the list needs a relay update, and revoke explains instead of failing", async () => {
    // A minimal relay of the previous protocol: register, then a hello without grants.
    const got: Record<string, unknown>[] = [];
    const server: Server = createServer((req, res) => {
      if (req.url === "/bridge/register") {
        req.resume();
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ bridge_id: "a".repeat(20) }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => {
      ws.on("message", (d) => {
        const t = d.toString();
        if (t !== "ping") got.push(JSON.parse(t) as Record<string, unknown>);
      });
      ws.send(JSON.stringify({ t: "hello", v: 1, bridge_id: "a".repeat(20), relay: "old", mcp_url: "old/mcp", credentials: 2, pairing: null }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const oldRelay = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), "splanc-oldrelay-"));
    const statusPath = join(dir, "status.json");
    const control = join(dir, "c.sock");
    const { identity } = tempIdentity();
    const l = new RelayLink({ relay: oldRelay, identity, backoff: { baseMs: 50, maxMs: 400 } });
    const b = new LanBridge({ link: l, hub, statusPath, controlPath: control, refreshMs: 0, autoPairMs: 0 });
    const st = () => JSON.parse(readFileSync(statusPath, "utf8")) as BridgeStatus;
    await b.start();
    try {
      const s = await until(() => (st().state === "paired" ? st() : null), "paired via the old relay");
      assert.equal(s.paired_clients_state, "relay_outdated");
      assert.deepEqual(s.paired_clients, []);
      await until(() => got.some((f) => f["t"] === "caps"), "caps sent");
      assert.deepEqual(got.find((f) => f["t"] === "caps"), { t: "caps", live: 1, grants: 1 });
      const c = await ctl("clients", {}, control);
      assert.equal(c["ok"], true);
      assert.equal(c["state"], "relay_outdated");
      assert.equal(c["note"], RELAY_OUTDATED);
      const rv = await ctl("revoke", { grant: "abcdef" }, control);
      assert.equal(rv["ok"], false);
      assert.match(String(rv["error"]), /needs a relay update/);
      assert.ok(!got.some((f) => f["t"] === "revoke_grant"), "nothing sent the old relay can't read");
    } finally {
      await b.stop();
      wss.close();
      server.close();
    }
  });
});

describe("configuration", () => {
  test("relay URL: --relay, else SPLANC_RELAY, else the built-in default", () => {
    assert.equal(relayUrl("https://a.example/", { SPLANC_RELAY: "https://b.example" }), "https://a.example");
    assert.equal(relayUrl(undefined, { SPLANC_RELAY: "https://b.example" }), "https://b.example");
    assert.equal(relayUrl(undefined, {}), DEFAULT_RELAY_URL);
  });

  test("no relay: the bridge stays up and its status says why", async () => {
    const dir = mkdtempSync(join(tmpdir(), "splanc-norelay-"));
    const statusPath = join(dir, "status.json");
    const { identity } = tempIdentity();
    const idle = new LanBridge({
      link: new RelayLink({ relay: "", identity }),
      hub,
      statusPath,
      controlPath: join(dir, "control.sock"),
      refreshMs: 0,
    });
    await idle.start({ connect: false });
    idle.setFatal("no relay configured");
    try {
      const s = JSON.parse(readFileSync(statusPath, "utf8")) as BridgeStatus;
      assert.equal(s.state, "error");
      assert.equal(s.error, "no relay configured");
      assert.equal(s.relay, "");
    } finally {
      await idle.stop();
    }
  });
});

describe("framing", () => {
  test("a reply bigger than one chunk (images) goes to the relay as res + chunks + end", () => {
    const { identity } = tempIdentity();
    const fake = new RelayLink({ relay: "", identity });
    const sent: Record<string, unknown>[] = [];
    (fake as unknown as { send: (f: Record<string, unknown>) => void }).send = (f) => void sent.push(f);
    const b = new LanBridge({ link: fake, hub, refreshMs: 0 });
    const reply = (b as unknown as { reply: (f: Record<string, unknown>) => void }).reply.bind(b);
    const body = "x".repeat(600 * 1024);
    reply({ t: "res", id: 7, status: 200, headers: { "content-type": "application/json" }, body, end: true });
    assert.deepEqual(sent[0], { t: "res", id: 7, status: 200, headers: { "content-type": "application/json" } });
    const chunks = sent.slice(1, -1) as { t: string; data: string }[];
    assert.ok(chunks.length >= 3 && chunks.every((c) => c.t === "chunk" && c.data.length <= 256 * 1024));
    assert.equal(chunks.map((c) => c.data).join(""), body);
    assert.deepEqual(sent.at(-1), { t: "end", id: 7 });
    sent.length = 0;
    reply({ t: "res", id: 8, status: 200, headers: {}, body: "small", end: true });
    assert.deepEqual(sent, [{ t: "res", id: 8, status: 200, headers: {}, body: "small", end: true }]);
  });
});

describe("reconnect", () => {
  test("a dropped socket reconnects; a relay outage shows offline, then recovers with credentials intact", async () => {
    // Pair again so there is something to keep.
    const code = (await ctl("new_pairing_code"))["pairing"] as { code: string };
    await fetch(`${relay}/pair`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ pairing_code: code.code }),
    });
    await until(() => readStatus().state === "paired", "paired");
    const id = readStatus().bridge_id;

    const c0 = link.connects;
    host.dropBridgeSockets();
    await until(() => link.connects > c0 && link.online, "reconnected after a drop");

    await host.close();
    await until(() => readStatus().state === "offline", "offline");
    assert.match(readStatus().error ?? "", /relay|closed|reach/);
    const n = await ctl("new_pairing_code");
    assert.equal(n["ok"], false);
    assert.match(String(n["error"]), /offline/);

    await startHost(); // same port, same data file
    await until(() => readStatus().state === "paired", "paired again after the relay came back", 15_000);
    assert.equal(readStatus().bridge_id, id, "same bridge id (no re-registration)");
    assert.equal(readStatus().error, null);
  });
});

describe("pairing edge cases (live-relay E2E findings)", () => {
  test("redeeming the first code doesn't make a fresh one; a stopped bridge shows no code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "splanc-redeem-"));
    const statusPath = join(dir, "status.json");
    const { identity } = tempIdentity();
    // No throttle on automatic codes: the redeem -> credential gap (credentials 0,
    // no code) is then always visible to the auto-pairing logic.
    const l = new RelayLink({ relay, identity, backoff: { baseMs: 50, maxMs: 400 } });
    const b = new LanBridge({ link: l, hub, statusPath, controlPath: join(dir, "c.sock"), refreshMs: 0, autoPairIntervalMs: 0 });
    const st = () => JSON.parse(readFileSync(statusPath, "utf8")) as BridgeStatus;
    await b.start();
    try {
      const code = (await until(() => st().pairing, "an automatic code")).code;
      const r = await fetch(`${relay}/pair`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ pairing_code: code }),
      });
      assert.equal(r.status, 200);
      await until(() => l.credentials === 1, "paired");
      await new Promise((res) => setTimeout(res, 300)); // room for a stray new_code round trip
      assert.equal(l.pairing, null, "no new code after the redeem");
      assert.equal(st().state, "paired");
      // A code on request still works, and a stopped bridge doesn't keep showing it.
      const n = await b.newPairingCode();
      assert.equal(n["ok"], true);
      await until(() => st().state === "pairing", "showing the requested code");
    } finally {
      await b.stop();
    }
    assert.equal(st().state, "offline");
    assert.equal(st().pairing, null);
  });

  test("two bridges with one identity don't evict each other every second", async () => {
    const { identity } = tempIdentity();
    const fast = { baseMs: 20, maxMs: 100 };
    const a = new RelayLink({ relay, identity, backoff: fast, replacedBackoff: { baseMs: 60_000, maxMs: 60_000 } });
    const b = new RelayLink({ relay, identity, backoff: fast, replacedBackoff: { baseMs: 60_000, maxMs: 60_000 } });
    a.start();
    try {
      await until(() => a.online, "a online");
      b.start();
      await until(() => b.online && a.phase === "offline", "b took over");
      assert.match(a.lastError ?? "", /another bridge using this identity/);
      await new Promise((res) => setTimeout(res, 600));
      // With the plain backoff (20 ms) they would have swapped ~30 times by now.
      assert.equal(a.connects, 1);
      assert.equal(b.connects, 1);
      assert.equal(a.replaced, 1);
      assert.ok(b.online);
    } finally {
      a.stop();
      b.stop();
    }
  });
});
