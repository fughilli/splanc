/** The lamp's wall clock (net/wallClock.ts): the push request through a sync,
 * the set_wall_clock / clock_state wire round trip, and the card's text. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeClient, decodeServer, encodeClient, encodeServer } from "../src/net/proto";
import {
  clockDetail,
  deviceHasWallClock,
  flatClockState,
  lampLocalTime,
  lampZoneLabel,
  ntpDetail,
  pushWallClock,
  wallClockRequest,
  type ClockState,
  type SetWallClockMessage,
} from "../src/net/wallClock";
import type { ClientMessage, ServerMessage } from "@ledmapper/protocol";

const T = Date.UTC(2026, 10, 25, 8, 0, 0);

test("the request maps UTC onto the lamp's clock through the sync", () => {
  // Lamp device ms = local + 1000; 8 ms round trip.
  const r = wallClockRequest({ offsetMs: 1000, rttMs: 8 }, 500.4, T, "app", {
    tz: "CET-1CEST,M3.5.0,M10.5.0/3",
    zone: "Europe/Berlin",
    exact: true,
  });
  assert.equal(r.unixMs, T);
  assert.equal(r.atDeviceMs, 1500);
  assert.equal(r.errMs, 4 + 20, "rtt/2 + this clock's own error");
  assert.equal(r.pushedBy, "WALL_CLOCK_PUSHER_APP");
  assert.equal(r.tz, "CET-1CEST,M3.5.0,M10.5.0/3");
  assert.equal(r.tzName, "Europe/Berlin");
  assert.equal(wallClockRequest({ offsetMs: 0, rttMs: 0 }, 0, T, "bridge", null).tz, undefined);
});

test("set_wall_clock encodes (int64 + optional fields + enum) and decodes back", () => {
  const msg: SetWallClockMessage = {
    type: "set_wall_clock",
    unixMs: T,
    atDeviceMs: 123_456_789,
    errMs: 24,
    pushedBy: "WALL_CLOCK_PUSHER_BRIDGE",
    tz: "EST5EDT,M3.2.0,M11.1.0",
    tzName: "America/New_York",
  };
  const back = decodeClient(encodeClient(msg as unknown as ClientMessage)) as unknown as Record<string, unknown>;
  assert.equal(back["type"], "set_wall_clock");
  assert.equal(String(back["unixMs"]), String(T));
  assert.equal(String(back["atDeviceMs"]), "123456789");
  assert.equal(back["pushedBy"], "WALL_CLOCK_PUSHER_BRIDGE");
  assert.equal(back["tz"], "EST5EDT,M3.2.0,M11.1.0");
  const get = decodeClient(encodeClient({ type: "get_clock" } as unknown as ClientMessage));
  assert.equal((get as unknown as { type: string }).type, "get_clock");
});

test("clock_state decodes into the flat state", () => {
  const frame = encodeServer({
    type: "clock_state",
    valid: true,
    unixMs: String(T),
    deviceMs: "5000",
    source: "CLOCK_SOURCE_PUSH",
    pushedBy: "WALL_CLOCK_PUSHER_APP",
    errMs: 25,
    ageS: 120,
    driftPpb: "-1500",
    tz: "CET-1CEST,M3.5.0,M10.5.0/3",
    tzName: "Europe/Berlin",
    utcOffsetS: 3600,
    tzAbbrev: "CET",
    gen: 2,
    steps: 1,
    monoJumps: 0,
    lastSet: "CLOCK_SET_RESULT_ACCEPTED",
  } as unknown as ServerMessage);
  const st = flatClockState(decodeServer(frame) as never);
  assert.equal(st.valid, true);
  assert.equal(st.unixMs, T);
  assert.equal(st.deviceMs, 5000);
  assert.equal(st.source, "push");
  assert.equal(st.pushedBy, "app");
  assert.equal(st.driftPpb, -1500);
  assert.equal(st.lastSet, "accepted");
  assert.equal(st.utcOffsetS, 3600);
  // An unset clock: every field defaulted.
  const empty = flatClockState({ type: "clock_state" });
  assert.equal(empty.valid, false);
  assert.equal(empty.source, "none");
  assert.equal(empty.lastSet, "none");
});

function state(p: Partial<ClockState>): ClockState {
  return { ...flatClockState({}), ...p };
}

test("the card shows the lamp's local time in its own zone", () => {
  const st = state({ valid: true, unixMs: T, tz: "CET-1CEST,M3.5.0,M10.5.0/3", tzName: "Europe/Berlin" });
  assert.equal(lampLocalTime(st, T), "09:00");
  assert.equal(lampLocalTime(st, T + 7_000, true), "09:00:07");
  assert.equal(lampZoneLabel(st, T), "Europe/Berlin (CET)");
  assert.equal(lampZoneLabel(st, Date.UTC(2027, 6, 1)), "Europe/Berlin (CEST)");
  assert.equal(lampZoneLabel(state({}), T), "UTC");
  const sydney = state({ valid: true, tz: "AEST-10AEDT,M10.1.0,M4.1.0/3" });
  assert.equal(lampLocalTime(sydney, T), "19:00", "AEDT in November");
});

test("the card's detail line", () => {
  assert.equal(clockDetail(null), "Reading the clock…");
  assert.equal(clockDetail(state({})), "Lost at the last power-off; this phone sets it on connect");
  assert.equal(
    clockDetail(state({ valid: true, source: "push", pushedBy: "app", ageS: 240, errMs: 12 })),
    "Set from a phone 4 min ago · ±12 ms",
  );
  assert.equal(
    clockDetail(state({ valid: true, source: "carry", ageS: 5, errMs: 1200 })),
    "Kept across a restart just now · ±1.2 s",
  );
  assert.equal(
    clockDetail(state({ valid: true, source: "push", pushedBy: "bridge", ageS: 7200, errMs: 30 })),
    "Set by the bridge 2 h ago · ±30 ms",
  );
});

test("pushWallClock syncs, then sends one request; skips lamps without the feature", async () => {
  const sent: Omit<SetWallClockMessage, "type">[] = [];
  const reply = state({ valid: true, lastSet: "accepted" });
  const client = {
    welcome: { features: ["wall_clock"] },
    syncClock: async () => ({ offsetMs: 250, rttMs: 10 }),
    setWallClock: async (r: Omit<SetWallClockMessage, "type">) => {
      sent.push(r);
      return reply;
    },
  };
  const st = await pushWallClock(client, { now: () => 1000, utcNow: () => T, zone: null, pushedBy: "bridge" });
  assert.equal(st, reply);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.atDeviceMs, 1250);
  assert.equal(sent[0]!.unixMs, T);
  assert.equal(sent[0]!.pushedBy, "WALL_CLOCK_PUSHER_BRIDGE");
  assert.equal(await pushWallClock({ ...client, welcome: { features: [] } }), null);
  assert.equal(deviceHasWallClock(null), false);
});

test("clock_state.ntp round-trips and the card says where network time stands", () => {
  const frame = encodeServer({
    type: "clock_state",
    valid: true,
    unixMs: String(T),
    source: "CLOCK_SOURCE_SNTP",
    ntp: {
      enabled: true,
      useDhcp: true,
      dhcpServers: ["192.168.1.1"],
      network: true,
      server: "162.159.200.1",
      rttMs: 18,
      syncedAgeS: 180,
      lastResult: "CLOCK_NTP_RESULT_SYNCED",
      rounds: 3,
      intervalS: 128,
    },
  } as unknown as ServerMessage);
  const st = flatClockState(decodeServer(frame) as never);
  assert.equal(st.source, "sntp");
  assert.equal(st.ntp?.lastResult, "synced");
  assert.deepEqual(st.ntp?.dhcpServers, ["192.168.1.1"]);
  assert.equal(ntpDetail(st), "Network time: 162.159.200.1 (18 ms)");
  assert.equal(clockDetail(st).startsWith("Synced to a time server"), true);
  const n = st.ntp!;
  assert.equal(ntpDetail({ ...st, ntp: { ...n, lastResult: "timeout" } }), "Network time: no answer from the time server");
  assert.equal(ntpDetail({ ...st, ntp: { ...n, enabled: false } }), "Network time: off");
  assert.equal(ntpDetail({ ...st, ntp: { ...n, network: false } }), "Network time: waiting for Wi-Fi");
  // A lamp without network time: no line.
  assert.equal(ntpDetail(flatClockState({})), "");
});

test("set_clock_config encodes the override", () => {
  const f = encodeClient({
    type: "set_clock_config",
    ntpEnabled: true,
    ntpServers: ["time.cloudflare.com"],
    replaceNtpServers: true,
  } as unknown as ClientMessage);
  const back = decodeClient(f) as unknown as { type: string; ntpServers: string[]; ntpEnabled: boolean };
  assert.equal(back.type, "set_clock_config");
  assert.deepEqual(back.ntpServers, ["time.cloudflare.com"]);
  assert.equal(back.ntpEnabled, true);
});
