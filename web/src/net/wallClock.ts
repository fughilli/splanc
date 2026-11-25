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
  /** Also write the lamp's hardware RTC (feature "rtc") once accepted. */
  writeRtc?: boolean;
}

/** RTC chips the firmware drives (proto RtcChip). "auto" = autodetect in config, none
 * found in state; "off" = never probe. */
export type RtcChip = "auto" | "ds3231" | "pcf8563" | "rv3028" | "off";
const RTC_CHIPS: Record<number, RtcChip> = { 0: "auto", 1: "ds3231", 2: "pcf8563", 3: "rv3028", 15: "off" };
/** Display names. */
export const RTC_CHIP_NAMES: Record<RtcChip, string> = {
  auto: "auto",
  ds3231: "DS3231",
  pcf8563: "PCF8563",
  rv3028: "RV-3028",
  off: "off",
};

/** The proto enum name for a chip ("rv3028" -> "RTC_CHIP_RV3028"). */
export function rtcChipName(c: RtcChip): string {
  return `RTC_CHIP_${c.toUpperCase()}`;
}

/** proto RtcState as decoded. */
export interface RtcStateMessage {
  configured?: string | number;
  configuredAddr?: number;
  chip?: string | number;
  addr?: number;
  present?: boolean;
  timeValid?: boolean;
  batteryLow?: boolean;
  hasTemp?: boolean;
  tempCc?: number;
  offsetMs?: string | number;
  readAgeS?: number;
  sinceWriteS?: number;
  reads?: number;
  writes?: number;
  errors?: number;
}

/** clock_state.rtc with defaults filled. */
export interface RtcState {
  configured: RtcChip;
  configuredAddr: number;
  /** The chip found ("auto" = none). */
  chip: RtcChip;
  addr: number;
  present: boolean;
  timeValid: boolean;
  batteryLow: boolean;
  /** °C, DS3231 only. */
  tempC: number | null;
  offsetMs: number;
  readAgeS: number;
  /** 0 = never written by this lamp. */
  sinceWriteS: number;
  reads: number;
  writes: number;
  errors: number;
}

function rtcChip(v: string | number | undefined): RtcChip {
  if (typeof v === "number") return RTC_CHIPS[v] ?? "auto";
  if (typeof v !== "string") return "auto";
  const short = (v.startsWith("RTC_CHIP_") ? v.slice(9) : v).toLowerCase();
  return (Object.values(RTC_CHIPS) as string[]).includes(short) ? (short as RtcChip) : "auto";
}

export function flatRtcState(m: RtcStateMessage | undefined): RtcState {
  const r = m ?? {};
  return {
    configured: rtcChip(r.configured),
    configuredAddr: r.configuredAddr ?? 0,
    chip: rtcChip(r.chip),
    addr: r.addr ?? 0,
    present: r.present ?? false,
    timeValid: r.timeValid ?? false,
    batteryLow: r.batteryLow ?? false,
    tempC: r.hasTemp ? (r.tempCc ?? 0) / 100 : null,
    offsetMs: num(r.offsetMs),
    readAgeS: r.readAgeS ?? 0,
    sinceWriteS: r.sinceWriteS ?? 0,
    reads: r.reads ?? 0,
    writes: r.writes ?? 0,
    errors: r.errors ?? 0,
  };
}

/** proto SetClockConfig, flat (fields 1-15: network time, feature "sntp"; 16 on: the hardware RTC, feature "rtc"). */
export interface SetClockConfigMessage {
  type: "set_clock_config";
  ntpEnabled?: boolean;
  useDhcpNtp?: boolean;
  /** With replaceNtpServers: the override (<= 2; empty = DHCP, then pool.ntp.org). */
  ntpServers?: string[];
  replaceNtpServers?: boolean;
  syncNow?: boolean;
  rtcChip?: string;
  rtcAddr?: number;
}

/** proto ClockNtp as decoded. */
export interface ClockNtpMessage {
  enabled?: boolean;
  useDhcp?: boolean;
  servers?: string[];
  dhcpServers?: string[];
  network?: boolean;
  server?: string;
  rttMs?: number;
  syncedAgeS?: number;
  lastResult?: string | number;
  rounds?: number;
  fails?: number;
  nextPollS?: number;
  intervalS?: number;
  lastOffer?: string | number;
}

export type ClockNtpResult =
  | "none"
  | "synced"
  | "no_servers"
  | "dns_timeout"
  | "dns_error"
  | "timeout"
  | "kiss_of_death"
  | "unsynchronised"
  | "bad_reply"
  | "disagree"
  | "unconfirmed";

/** The lamp's network-time client (clock_state.ntp), defaults filled. */
export interface ClockNtp {
  enabled: boolean;
  useDhcp: boolean;
  servers: string[];
  dhcpServers: string[];
  network: boolean;
  server: string;
  rttMs: number;
  syncedAgeS: number;
  lastResult: ClockNtpResult;
  rounds: number;
  fails: number;
  nextPollS: number;
  intervalS: number;
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
  ntp?: ClockNtpMessage;
  rtc?: RtcStateMessage;
}

export type ClockSource = "none" | "sntp" | "mesh" | "push" | "rtc" | "carry";
export type ClockSetResult =
  | "none"
  | "accepted"
  | "not_better"
  | "disagrees"
  | "implausible"
  | "locked"
  | "bad_tz"
  | "bad_server";

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
  /** Network time (feature "sntp"); absent on lamps without it. */
  ntp?: ClockNtp;
  /** The hardware RTC (feature "rtc"; present = false without one). */
  rtc: RtcState;
}

const SOURCES: ClockSource[] = ["none", "sntp", "mesh", "push", "rtc", "carry"];
const PUSHERS: (WallClockPusher | "none")[] = ["none", "app", "bridge", "manual", "frontend"];
const RESULTS: ClockSetResult[] = [
  "none",
  "accepted",
  "not_better",
  "disagrees",
  "implausible",
  "locked",
  "bad_tz",
  "bad_server",
];
const NTP_RESULTS: ClockNtpResult[] = [
  "none",
  "synced",
  "no_servers",
  "dns_timeout",
  "dns_error",
  "timeout",
  "kiss_of_death",
  "unsynchronised",
  "bad_reply",
  "disagree",
  "unconfirmed",
];

export function flatClockNtp(m: ClockNtpMessage): ClockNtp {
  return {
    enabled: m.enabled ?? false,
    useDhcp: m.useDhcp ?? false,
    servers: m.servers ?? [],
    dhcpServers: m.dhcpServers ?? [],
    network: m.network ?? false,
    server: m.server ?? "",
    rttMs: m.rttMs ?? 0,
    syncedAgeS: m.syncedAgeS ?? 0,
    lastResult: NTP_RESULTS[enumIndex(m.lastResult, NTP_RESULTS, "CLOCK_NTP_RESULT_")] ?? "none",
    rounds: m.rounds ?? 0,
    fails: m.fails ?? 0,
    nextPollS: m.nextPollS ?? 0,
    intervalS: m.intervalS ?? 0,
  };
}

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
    // The proto name is CLOCK_SOURCE_HW_RTC; the short form here is "rtc".
    source: SOURCES[enumIndex(m.source === "CLOCK_SOURCE_HW_RTC" ? 4 : m.source, SOURCES, "CLOCK_SOURCE_")] ?? "none",
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
    ...(m.ntp ? { ntp: flatClockNtp(m.ntp) } : {}),
    rtc: flatRtcState(m.rtc),
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
    /** Also write the hardware RTC once accepted (feature "rtc"). */
    writeRtc?: boolean;
  } = {},
): Promise<ClockState | null> {
  if (!deviceHasWallClock(client.welcome)) return null;
  const sync = await client.syncClock(opts.rounds ?? 6);
  const now = opts.now ?? (() => performance.now());
  const utcNow = opts.utcNow ?? (() => Date.now());
  const zone = opts.zone === undefined ? phonePosixTz() : opts.zone;
  const req = wallClockRequest(sync, now(), utcNow(), opts.pushedBy ?? "app", zone);
  return client.setWallClock(opts.writeRtc ? { ...req, writeRtc: true } : req);
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

const NTP_FAIL_TEXT: Record<ClockNtpResult, string> = {
  none: "",
  synced: "",
  no_servers: "no time server to ask",
  dns_timeout: "can't look up the time server",
  dns_error: "can't look up the time server",
  timeout: "no answer from the time server",
  kiss_of_death: "the time server asked it to wait",
  unsynchronised: "the time server isn't synchronised",
  bad_reply: "a bad answer from the time server",
  disagree: "two time servers disagreed",
  unconfirmed: "only one time server answered",
};

/**
 * The network-time line: "Network time: 162.159.200.1 (18 ms)",
 * "Network time: no answer from the time server", "Network time: off", or ""
 * when the lamp has no network-time client (or no reading yet).
 */
export function ntpDetail(st: ClockState | null): string {
  const n = st?.ntp;
  if (!n) return "";
  if (!n.enabled) return "Network time: off";
  if (!n.network) return "Network time: waiting for Wi-Fi";
  if (n.lastResult === "none") return "Network time: asking…";
  const fail = NTP_FAIL_TEXT[n.lastResult];
  if (fail) return `Network time: ${fail}`;
  return `Network time: ${n.server} (${n.rttMs} ms)`;
}
