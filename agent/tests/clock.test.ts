/**
 * The lamps' wall clock through the bridge (docs/design/wall-clock.md): the push on
 * connect (the bridge's UTC + zone mapped onto the device clock), get_clock's view,
 * set_clock with a zone and an explicit time, the feature gate, the TZif footer reader.
 * Skipped as a whole when this bundle's protocol predates the clock arms.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostPosixTz, tzifFooter } from "../src/hostTz";
import { CLOCK_IN_PROTO, DeviceSession } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { timeFromInput, zoneFromInput } from "../src/wallclock";
import { FakePlayer, TEST_CERT_SHA256 } from "./fakePlayer";

const skip = CLOCK_IN_PROTO ? false : "this bundle's protocol has no wall-clock arms yet";

let player: FakePlayer;

async function connect(features: string[]): Promise<DeviceSession> {
  const s = new DeviceSession({
    url: `wss://${player.host}/ws`,
    socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }),
    features,
  });
  await s.connect();
  return s;
}

beforeEach(async () => {
  player = new FakePlayer();
  player.features = [...player.features, "wall_clock"];
  player.clockOffsetMs = 123_456;
  await player.start();
});

afterEach(async () => {
  await player.stop();
});

const sent = (type: string) => player.received.filter((m) => m.type === type);

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("the bridge pushes its UTC and zone on connect, mapped onto the device clock", { skip }, async () => {
  const s = await connect(["wall_clock"]);
  await until(() => sent("set_wall_clock").length > 0);
  const m = sent("set_wall_clock")[0]!;
  assert.equal(m["pushedBy"], "WALL_CLOCK_PUSHER_BRIDGE");
  assert.ok(typeof m["tz"] === "string" && (m["tz"] as string).length > 0);
  // The device time is this process's clock + 123456 ms: at_device_ms says so.
  const lag = performance.now() + 123_456 - Number(m["atDeviceMs"]);
  assert.ok(lag >= 0 && lag < 2000, `at_device_ms ${lag} ms behind`);
  assert.ok(Math.abs(Number(m["unixMs"]) - Date.now()) < 2000);
  const r = await s.getClock();
  assert.equal(r["valid"], true);
  assert.ok(Math.abs(Date.parse(r["utc"] as string) - Date.now()) < 2000, String(r["utc"]));
  assert.equal(r["source"], "push (bridge)");
  s.close();
});

test("set_clock: an IANA zone and an explicit time", { skip }, async () => {
  const s = await connect(["wall_clock"]);
  await until(() => sent("set_wall_clock").length > 0);
  const r = await s.setClock({ tz: "Europe/Berlin", time: "2027-07-01T12:00:00Z" });
  const m = sent("set_wall_clock").at(-1)!;
  assert.equal(m["pushedBy"], "WALL_CLOCK_PUSHER_MANUAL");
  assert.equal(m["tz"], "CET-1CEST,M3.5.0,M10.5.0/3");
  assert.equal(m["tzName"], "Europe/Berlin");
  assert.ok(Math.abs(Number(m["unixMs"]) - Date.parse("2027-07-01T12:00:00Z")) < 2000);
  assert.equal(r["local_time"], "14:00:00", "CEST");
  assert.equal(r["zone"], "Europe/Berlin (CEST)");
  await assert.rejects(s.setClock({ tz: "Mars/Olympus" }), /unknown time zone/);
  await assert.rejects(s.setClock({ time: "2027-07-01 12:00" }), /zone/);
  s.close();
});

test("firmware without the wall clock gets a clear error and nothing is sent", { skip }, async () => {
  player.features = player.features.filter((f) => f !== "wall_clock");
  const s = await connect([]);
  await assert.rejects(s.getClock(), /no wall clock/);
  await assert.rejects(s.setClock({}), /no wall clock/);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent("set_wall_clock").length + sent("get_clock").length, 0);
  s.close();
});

test("set_clock: network-time settings (feature sntp)", { skip }, async () => {
  player.features = [...player.features, "sntp"];
  const s = await connect(["wall_clock", "sntp"]);
  await until(() => sent("set_wall_clock").length > 0);
  const r = await s.setClock({ ntpServers: ["time.cloudflare.com"] });
  const m = sent("set_clock_config").at(-1)!;
  assert.deepEqual(m["ntpServers"], ["time.cloudflare.com"]);
  assert.equal(m["replaceNtpServers"], true);
  assert.equal(m["syncNow"], true);
  const nt = r["network_time"] as Record<string, unknown>;
  assert.deepEqual(nt["servers"], ["time.cloudflare.com"]);
  assert.equal(nt["override"], true);
  await assert.rejects(s.setClock({ ntpServers: ["not a host"] }), /host name/);
  const off = await s.setClock({ networkTime: false, ntpServers: [] });
  assert.equal((off["network_time"] as Record<string, unknown>)["enabled"], false);
  s.close();
});

test("network-time settings need the sntp feature", { skip }, async () => {
  const s = await connect(["wall_clock"]);
  await assert.rejects(s.setClock({ networkTime: true }), /no network time/);
  s.close();
});

test("zone and time inputs", () => {
  assert.equal(zoneFromInput("America/New_York").tz, "EST5EDT,M3.2.0,M11.1.0");
  assert.equal(zoneFromInput("<+0545>-5:45").tz, "<+0545>-5:45");
  assert.throws(() => zoneFromInput("nonsense zone"), /neither/);
  assert.equal(timeFromInput("2027-01-01T00:00:00+01:00"), Date.parse("2026-12-31T23:00:00Z"));
  assert.equal(timeFromInput(1_800_000_000_000), 1_800_000_000_000);
  assert.throws(() => timeFromInput("tomorrow"), /can't read/);
});

test("the TZif footer is the host's rule", () => {
  const head = new Uint8Array(44);
  head.set([0x54, 0x5a, 0x69, 0x66, 0x32]); // "TZif2"
  const footer = new TextEncoder().encode("\nCET-1CEST,M3.5.0,M10.5.0/3\n");
  const file = new Uint8Array(head.length + footer.length);
  file.set(head);
  file.set(footer, head.length);
  assert.equal(tzifFooter(file), "CET-1CEST,M3.5.0,M10.5.0/3");
  const v1 = file.slice();
  v1[4] = 0;
  assert.equal(tzifFooter(v1), null);
  assert.equal(tzifFooter(new TextEncoder().encode("not a tzif")), null);
  const dir = mkdtempSync(join(tmpdir(), "tz-"));
  writeFileSync(join(dir, "localtime"), file);
  assert.equal(hostPosixTz(join(dir, "localtime")).tz, "CET-1CEST,M3.5.0,M10.5.0/3");
  // No file: the Intl derivation of the process zone.
  assert.ok(hostPosixTz(join(dir, "missing")).tz.length > 0);
});
