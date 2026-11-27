/**
 * HubLamps (src/bridge/lamps.ts): the smart-home view of the hub's players, against
 * fake TLS players. Covers the polite-client rules the Matter bridge depends on:
 * sessions are held (for pushes) only while a controller is commissioned; a takeover
 * (WS 4001: the phone app took the lamp's one session) is not fought back for the
 * back-off; a command dials at once; and the state is re-read on every reconnect.
 * Old firmware (no "power") gets on/off emulated with brightness.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { HubLamps, type LampState, type PowerStateLike } from "../src/bridge/lamps";
import { Hub } from "../src/hub";
import { FakePlayer } from "./fakePlayer";

const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-lamps-"));
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");

async function until<T>(f: () => T | null | undefined | false, what: string, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = f();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function makeHub(p: FakePlayer): Hub {
  return new Hub({
    root: "",
    hosts: [p.host],
    mdns: false,
    config: { players: {}, groups: {}, poses: {} },
    persist: () => undefined,
    registryDeps: { sweepHosts: () => [] },
    huntBackoffMs: [],
  });
}

describe("old firmware (no power feature): on/off emulated with brightness", () => {
  let player: FakePlayer;
  let hub: Hub;
  let lamps: HubLamps;
  const MAC = "CC:FD:49:00:00:B1";
  before(async () => {
    player = new FakePlayer({ name: "Porch", mac: MAC });
    await player.start();
    player.serveManifest();
    hub = makeHub(player);
    lamps = new HubLamps(hub, { tickMs: 60_000 });
  });
  after(async () => {
    lamps.stop();
    hub.close();
    await player.stop();
  });

  test("the player becomes a lamp, read from its Welcome", async () => {
    await hub.ready();
    await lamps.tick();
    assert.deepEqual(
      lamps.list().map((l) => l.id),
      [MAC],
    );
    const st = await until(() => lamps.state(MAC)?.reachable && lamps.state(MAC), "reachable");
    assert.equal(st.power, false);
    assert.equal(st.on, true, "brightness 1 reads as on");
  });

  test("off = brightness 0, on = the last level", async () => {
    await lamps.setBrightness(MAC, 0.4);
    assert.equal(player.brightness, 0.4);
    await lamps.setOn(MAC, false);
    assert.equal(player.brightness, 0);
    assert.equal(lamps.state(MAC)!.on, false);
    assert.equal(lamps.state(MAC)!.brightness, 0.4, "an off lamp keeps its level");
    await lamps.setOn(MAC, true);
    assert.equal(player.brightness, 0.4);
    assert.equal(lamps.state(MAC)!.on, true);
  });
});

describe("takeover etiquette and the power path", () => {
  let player: FakePlayer;
  let hub: Hub;
  let lamps: HubLamps;
  let active = true;
  let now = 1_000_000;
  const MAC = "CC:FD:49:00:00:B2";
  // The power API (agent/lamp-touch-power) on the fake: duck-typed onto each client.
  let power: PowerStateLike = { on: true, brightness: 0.7, seq: 1 };
  const pushes = new Set<(s: PowerStateLike) => void>();
  let getPowers = 0;
  const states: LampState[] = [];

  before(async () => {
    player = new FakePlayer({ name: "Coil", mac: MAC });
    player.features = [...player.features, "power"];
    await player.start();
    player.serveManifest();
    hub = makeHub(player);
    lamps = new HubLamps(hub, { tickMs: 60_000, now: () => now, active: () => active, backoffMs: [60_000, 120_000] });
    lamps.onState((_id, st) => states.push(st));
    await hub.ready();
    const p = hub.registry.list()[0]!;
    const s = await hub.session(p);
    const c = s.client as unknown as Record<string, unknown>;
    c["getPower"] = async () => {
      getPowers++;
      return { ...power };
    };
    c["setPower"] = async (req: { on?: boolean }) => {
      power = { ...power, on: req.on === true, seq: (power.seq ?? 0) + 1 };
      return { ...power };
    };
    c["onPowerState"] = (fn: (s: PowerStateLike) => void) => {
      pushes.add(fn);
      return () => pushes.delete(fn);
    };
  });
  after(async () => {
    lamps.stop();
    hub.close();
    await player.stop();
  });

  const session = () => hub.openSession(MAC)!;

  test("active: the session is held and the state read with get_power (which subscribes)", async () => {
    await lamps.tick();
    const st = await until(() => lamps.state(MAC)?.power && lamps.state(MAC), "power state");
    assert.deepEqual({ on: st.on, brightness: st.brightness }, { on: true, brightness: 0.7 });
    assert.equal(getPowers, 1);
    assert.match(session().keepReason() ?? "", /smart home/);
  });

  test("pushes update the state; a stale push (older seq) is dropped", () => {
    for (const fn of pushes) fn({ on: false, brightness: 0.7, seq: 5 });
    assert.equal(lamps.state(MAC)!.on, false);
    for (const fn of pushes) fn({ on: true, brightness: 0.7, seq: 4 });
    assert.equal(lamps.state(MAC)!.on, false, "seq 4 < 5: ignored");
    for (const fn of pushes) fn({ on: true, brightness: 0.2, seq: 6 });
    assert.deepEqual({ on: lamps.state(MAC)!.on, b: lamps.state(MAC)!.brightness }, { on: true, b: 0.2 });
  });

  test("taken over: no re-dial during the back-off, then one re-dial that re-reads the state", async () => {
    player.takeOver();
    await until(() => session().released === "taken_over", "the session released");
    const opened = player.openSessions;
    const reads = getPowers;
    await lamps.tick(); // notes the takeover, schedules the retry
    now += 30_000;
    await lamps.tick();
    assert.equal(player.openSessions, opened, "no re-dial inside the back-off");
    power = { on: false, brightness: 0.9, seq: 1 }; // changed while we weren't looking
    now += 31_000;
    await lamps.tick();
    await until(() => !session().released && session().client.isConnected, "re-dialed");
    await until(() => lamps.state(MAC)?.brightness === 0.9, "re-read after the reconnect");
    assert.equal(lamps.state(MAC)!.on, false);
    // HubLamps' re-read, plus the session's own subscribe on every connect (session.ts).
    assert.ok(getPowers - reads >= 1 && getPowers - reads <= 2, `a reconnect re-reads (and so re-subscribes): ${getPowers - reads} reads`);
  });

  test("a second takeover backs off longer", async () => {
    player.takeOver();
    await until(() => session().released === "taken_over", "released again");
    await lamps.tick();
    now += 61_000;
    await lamps.tick();
    assert.equal(session().released, "taken_over", "second back-off is 120 s");
    now += 60_000;
    await lamps.tick();
    await until(() => !session().released, "re-dialed after 120 s");
  });

  test("a command dials at once, even inside the back-off", async () => {
    player.takeOver();
    await until(() => session().released === "taken_over", "released");
    await lamps.tick();
    await lamps.setOn(MAC, true);
    assert.equal(power.on, true);
    assert.equal(lamps.state(MAC)!.on, true);
    assert.equal(session().released, null);
  });

  test("not active (no controller commissioned): the hold is dropped, nothing re-dials", async () => {
    active = false;
    await lamps.tick();
    assert.equal(session().keepReason(), null, "the hub may idle-release it now");
    player.takeOver();
    await until(() => session().released === "taken_over", "released");
    now += 3_600_000;
    await lamps.tick();
    assert.equal(session().released, "taken_over", "no background re-dial while inactive");
  });
});
