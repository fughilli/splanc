/**
 * The lamp's wall clock (firmware feature "wall_clock", docs/design/wall-clock.md):
 * the set_wall_clock / get_clock -> clock_state types, the push the app and the
 * bridge make on every connect, and the device-sheet card's text.
 *
 * The push maps this device's UTC onto the lamp's clock exactly as
 * set_time_base does: a few time_sync_ping rounds give the min-RTT offset
 * between the local monotonic clock and the lamp's device ms, then the UTC
 * time read at one local instant is sent with that instant on the lamp's
 * clock (`atDeviceMs`). The error bound is half the round trip plus this
 * clock's own error against UTC.
 */

import { parsePosixTz, phonePosixTz, posixNameAt, posixOffsetS, type PhoneTz } from "./posixTz";

/** Who pushed a set_wall_clock (proto WallClockPusher). */
export type WallClockPusher = "app" | "bridge" | "manual" | "frontend";

const PUSHER_ENUM: Record<WallClockPusher, string> = {
  app: "WALL_CLOCK_PUSHER_APP",
  bridge: "WALL_CLOCK_PUSHER_BRIDGE",
  manual: "WALL_CLOCK_PUSHER_MANUAL",
  frontend: "WALL_CLOCK_PUSHER_FRONTEND",
};

/** proto SetWallClock, flat. */
export interface SetWallClockMessage {
  type: "set_wall_clock";
  /** UTC ms (0 = only the zone). */
  unixMs: number;
  /** Lamp device ms at which `unixMs` was true (omit = on receipt). */
  atDeviceMs?: number;
  errMs?: number;
  pushedBy?: string;
  /** POSIX TZ rule. */
  tz?: string;
  /** IANA name, for display. */
  tzName?: string;
}

/** proto ClockState as decoded (proto3 JSON: int64 as strings, enums as names). */
export interface ClockStateMessage {
  type: "clock_state";
  valid?: boolean;
  unixMs?: string | number;
  deviceMs?: string | number;
  source?: string | number;
  pushedBy?: string | number;
  errMs?: number;
  ageS?: number;
  driftPpb?: string | number;
  tz?: string;
  tzName?: string;
  utcOffsetS?: number;
  tzAbbrev?: string;
  gen?: number;
  steps?: number;
  monoJumps?: number;
  lastSet?: string | number;
}

export type ClockSource = "none" | "sntp" | "mesh" | "push" | "rtc" | "carry";
export type ClockSetResult =
  | "none"
  | "accepted"
  | "not_better"
  | "disagrees"
  | "implausible"
  | "locked"
  | "bad_tz";

/** A clock_state with defaults filled and enums shortened. */
export interface ClockState {
  valid: boolean;
  /** The reading: UTC ms at lamp device ms `deviceMs`. */
  unixMs: number;
  deviceMs: number;
  source: ClockSource;
  pushedBy: WallClockPusher | "none";
  errMs: number;
  ageS: number;
  driftPpb: number;
  tz: string;
  tzName: string;
  utcOffsetS: number;
  tzAbbrev: string;
  gen: number;
  steps: number;
  monoJumps: number;
  lastSet: ClockSetResult;
}

const SOURCES: ClockSource[] = ["none", "sntp", "mesh", "push", "rtc", "carry"];
const PUSHERS: (WallClockPusher | "none")[] = ["none", "app", "bridge", "manual", "frontend"];
const RESULTS: ClockSetResult[] = ["none", "accepted", "not_better", "disagrees", "implausible", "locked", "bad_tz"];

/** An enum field (a NAME from proto3 JSON, or a number) as its index. */
function enumIndex(v: string | number | undefined, names: readonly string[], prefix: string): number {
  if (typeof v === "number") return v;
  if (typeof v !== "string") return 0;
  const short = v.startsWith(prefix) ? v.slice(prefix.length).toLowerCase() : v.toLowerCase();
  const i = names.indexOf(short);
  return i < 0 ? 0 : i;
}

function num(v: string | number | undefined): number {
  const n = typeof v === "string" ? Number(v) : (v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export function flatClockState(m: Partial<ClockStateMessage>): ClockState {
  return {
    valid: m.valid ?? false,
    unixMs: num(m.unixMs),
    deviceMs: num(m.deviceMs),
    source: SOURCES[enumIndex(m.source, SOURCES, "CLOCK_SOURCE_")] ?? "none",
    pushedBy: PUSHERS[enumIndex(m.pushedBy, PUSHERS, "WALL_CLOCK_PUSHER_")] ?? "none",
    errMs: m.errMs ?? 0,
    ageS: m.ageS ?? 0,
    driftPpb: num(m.driftPpb),
    tz: m.tz ?? "",
    tzName: m.tzName ?? "",
    utcOffsetS: m.utcOffsetS ?? 0,
    tzAbbrev: m.tzAbbrev ?? "",
    gen: m.gen ?? 0,
    steps: m.steps ?? 0,
    monoJumps: m.monoJumps ?? 0,
    lastSet: RESULTS[enumIndex(m.lastSet, RESULTS, "CLOCK_SET_RESULT_")] ?? "none",
  };
}

/** The sync result a push needs (net/clocksync.ts SyncSample). */
export interface ClockSync {
  /** Add to a local monotonic time to get the lamp's device ms. */
  offsetMs: number;
  rttMs: number;
}

/** What a clock push needs from a client (net/client.ts PlayerClient). */
export interface WallClockClient {
  syncClock(rounds?: number): Promise<ClockSync>;
  setWallClock(req: Omit<SetWallClockMessage, "type">): Promise<ClockState>;
  readonly welcome: { features?: string[] } | null;
}

/** This device's own error against UTC, ms: a phone or Pi on NTP is within tens
 * of ms; the lamp keeps the better of several sources by this bound. */
export const LOCAL_UTC_ERR_MS = 20;

/** The lamp serves the wall clock. */
export function deviceHasWallClock(welcome: { features?: string[] } | null | undefined): boolean {
  return (welcome?.features ?? []).includes("wall_clock");
}

/**
 * Builds the set_wall_clock for one instant: `localMs` on the local monotonic
 * clock, when UTC read `utcMs`, through a sync. Pure.
 */
export function wallClockRequest(
  sync: ClockSync,
  localMs: number,
  utcMs: number,
  pushedBy: WallClockPusher,
  zone: PhoneTz | null,
): Omit<SetWallClockMessage, "type"> {
  const req: Omit<SetWallClockMessage, "type"> = {
    unixMs: Math.round(utcMs),
    atDeviceMs: Math.round(localMs + sync.offsetMs),
    errMs: Math.max(1, Math.ceil(Math.max(0, sync.rttMs) / 2) + LOCAL_UTC_ERR_MS),
    pushedBy: PUSHER_ENUM[pushedBy],
  };
  if (zone) {
    req.tz = zone.tz;
    req.tzName = zone.zone;
  }
  return req;
}

/**
 * Pushes this device's UTC (and its zone, unless `zone` is null) to the lamp.
 * Resolves with the lamp's clock_state, or null when the lamp has no wall clock.
 * `now` is the local monotonic clock the client syncs on (performance.now).
 */
export async function pushWallClock(
  client: WallClockClient,
  opts: {
    pushedBy?: WallClockPusher;
    zone?: PhoneTz | null;
    rounds?: number;
    now?: () => number;
    utcNow?: () => number;
  } = {},
): Promise<ClockState | null> {
  if (!deviceHasWallClock(client.welcome)) return null;
  const sync = await client.syncClock(opts.rounds ?? 6);
  const now = opts.now ?? (() => performance.now());
  const utcNow = opts.utcNow ?? (() => Date.now());
  const zone = opts.zone === undefined ? phonePosixTz() : opts.zone;
  const req = wallClockRequest(sync, now(), utcNow(), opts.pushedBy ?? "app", zone);
  return client.setWallClock(req);
}

// ---- the device-sheet card's text -------------------------------------------

/** The lamp's UTC ms now, extrapolated from a reading taken `sinceMs` ago. */
export function lampUtcNow(st: ClockState, sinceMs: number): number {
  return st.unixMs + sinceMs;
}

/** The lamp's local time "HH:MM" (or "HH:MM:SS") for UTC `utcMs` in its zone. */
export function lampLocalTime(st: ClockState, utcMs: number, seconds = false): string {
  const z = parsePosixTz(st.tz || "UTC0");
  const off = z ? posixOffsetS(z, utcMs) : st.utcOffsetS;
  const d = new Date(utcMs + off * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return seconds ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
}

/** The zone label: "Europe/Berlin (CET)", "UTC". */
export function lampZoneLabel(st: ClockState, utcMs: number): string {
  const z = parsePosixTz(st.tz || "UTC0");
  const abbrev = z ? posixNameAt(z, utcMs) : st.tzAbbrev;
  if (!st.tz) return "UTC";
  return st.tzName ? `${st.tzName} (${abbrev})` : abbrev;
}

function ago(s: number): string {
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

function plusMinus(ms: number): string {
  return ms < 1000 ? `±${ms} ms` : `±${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** "Set from a phone 4 min ago · ±12 ms", "Kept across a restart · ±1.2 s", or why it is unset. */
export function clockDetail(st: ClockState | null): string {
  if (!st) return "Reading the clock…";
  if (!st.valid) return "Lost at the last power-off; this phone sets it on connect";
  const how =
    st.source === "push"
      ? st.pushedBy === "bridge"
        ? "Set by the bridge"
        : st.pushedBy === "manual"
          ? "Set by hand"
          : st.pushedBy === "frontend"
            ? "Set by the network chip"
            : "Set from a phone"
      : st.source === "sntp"
        ? "Synced to a time server"
        : st.source === "mesh"
          ? "From the mesh"
          : st.source === "rtc"
            ? "From the clock chip"
            : st.source === "carry"
              ? "Kept across a restart"
              : "Set";
  return `${how} ${ago(st.ageS)} · ${plusMinus(st.errMs)}`;
}
