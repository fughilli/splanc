/**
 * `splanc-agent bridge` (src/bridge/lanBridge.ts) against the in-process relay
 * and a fake player: the display contract (status.json fields + states,
 * atomic writes, the control socket's commands) and reconnecting (dropped
 * socket, relay down -> offline -> back, with credentials kept across a relay
 * restart).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { LanBridge, type BridgeStatus } from "../src/bridge/lanBridge";
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

function ctl(cmd: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const c = net.connect(CONTROL, () => c.write(`${JSON.stringify({ cmd })}\n`));
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
    assert.deepEqual(Object.keys(s).sort(), ["bridge_id", "clients", "error", "lan_ip", "pairing", "players", "relay", "state", "updated_at", "v"].sort());
    assert.equal(s.v, 1);
    assert.equal(s.relay, relay);
    assert.match(s.bridge_id, /^[a-z2-7]{20}$/);
    assert.match(s.pairing!.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    assert.ok(s.pairing!.expires_at > Date.now() / 1000 + 500);
    assert.equal(s.pairing!.url, `${relay}/pair?code=${encodeURIComponent(s.pairing!.code)}`);
    assert.equal(s.clients, 0);
    assert.deepEqual(s.players, [{ name: "Porch", host: player.host, ok: true }]);
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
