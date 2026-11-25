/**
 * The lamps' wall clock through the bridge (docs/design/wall-clock.md): the
 * get_clock / set_clock tools' views and the request a set builds. The push
 * itself (sync, then UTC at a device-clock instant) is the app's,
 * web/src/net/wallClock.ts; the zone comes from the bridge host (hostTz.ts) or
 * the tool's `tz` (an IANA name or a POSIX rule). A hardware RTC chip (feature "rtc")
 * shows as `hardware_clock`.
 */

import { parsePosixTz, posixTzFromIntl, type PhoneTz } from "../../web/src/net/posixTz";
import { lampLocalTime, lampZoneLabel, ntpDetail, RTC_CHIP_NAMES, type ClockState } from "../../web/src/net/wallClock";

/** A tool input `tz`: an IANA zone ("Europe/Berlin") or a POSIX rule
 * ("CET-1CEST,M3.5.0,M10.5.0/3"). Throws an Error with a user-facing message. */
export function zoneFromInput(tz: string, nowMs: number = Date.now()): PhoneTz {
  const t = tz.trim();
  if (/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+$/.test(t) || t === "UTC") {
    try {
      const z = posixTzFromIntl(t, nowMs);
      return { ...z, zone: t };
    } catch {
      throw new Error(`unknown time zone "${t}" (use an IANA name like Europe/Berlin, or a POSIX TZ rule)`);
    }
  }
  if (parsePosixTz(t)) return { tz: t, zone: "", exact: true };
  throw new Error(`"${t}" is neither an IANA time zone (Europe/Berlin) nor a POSIX TZ rule (CET-1CEST,M3.5.0,M10.5.0/3)`);
}

/** A time the user gave (ISO 8601 with a zone or Z, or Unix ms). Throws on junk. */
export function timeFromInput(time: string | number): number {
  const ms = typeof time === "number" ? time : /^\d{10,}$/.test(time.trim()) ? Number(time) : Date.parse(time);
  if (!Number.isFinite(ms)) throw new Error(`can't read the time "${String(time)}" (ISO 8601, e.g. 2026-11-25T09:30:00Z)`);
  if (typeof time === "string" && !/^\d+$/.test(time.trim()) && !/(Z|[+-]\d\d:?\d\d)$/i.test(time.trim())) {
    throw new Error(`give the time with its zone (…Z or …+01:00): "${time}" is ambiguous`);
  }
  return ms;
}

/** The tools' view of a clock_state (at the moment it was read). */
export function clockView(st: ClockState): Record<string, unknown> {
  const out: Record<string, unknown> = { valid: st.valid };
  if (st.valid) {
    out["utc"] = new Date(st.unixMs).toISOString();
    out["local_time"] = lampLocalTime(st, st.unixMs, true);
    out["error_ms"] = st.errMs;
    out["source"] = st.source === "push" ? `push (${st.pushedBy})` : st.source;
    out["age_s"] = st.ageS;
  } else {
    out["note"] = "the clock is not set (a power loss clears it); set_clock, or opening the app, sets it";
  }
  out["zone"] = lampZoneLabel(st, st.valid ? st.unixMs : Date.now());
  out["tz_rule"] = st.tz || "UTC0";
  if (st.driftPpb !== 0) out["drift_ppm"] = Math.round(st.driftPpb / 100) / 10;
  if (st.monoJumps > 0) out["device_clock_jumps"] = st.monoJumps;
  if (st.lastSet !== "none") out["set_result"] = st.lastSet;
  if (st.ntp) {
    const n = st.ntp;
    out["network_time"] = {
      enabled: n.enabled,
      servers: n.servers.length > 0 ? n.servers : n.useDhcp && n.dhcpServers.length > 0 ? n.dhcpServers : ["pool.ntp.org"],
      override: n.servers.length > 0,
      use_dhcp: n.useDhcp,
      last_result: n.lastResult,
      ...(n.server ? { last_server: n.server, rtt_ms: n.rttMs, synced_age_s: n.syncedAgeS } : {}),
      ...(n.nextPollS ? { next_poll_s: n.nextPollS } : {}),
      summary: ntpDetail(st),
    };
  }
  const r = st.rtc;
  if (r.present) {
    const chip: Record<string, unknown> = {
      chip: `${RTC_CHIP_NAMES[r.chip]} at 0x${r.addr.toString(16).padStart(2, "0")}`,
      keeps_time: r.timeValid,
    };
    if (r.batteryLow) chip["battery"] = "lost time at the last power-off: coin cell missing or flat";
    if (r.tempC !== null) chip["temperature_c"] = r.tempC;
    if (r.reads > 0 && r.timeValid) chip["offset_ms"] = r.offsetMs;
    chip["last_written"] = r.sinceWriteS > 0 ? `${Math.round(r.sinceWriteS / 60)} min ago` : "never by this lamp";
    if (r.errors > 0) chip["bus_errors"] = r.errors;
    out["hardware_clock"] = chip;
  } else if (r.configured !== "auto") {
    out["hardware_clock"] =
      r.configured === "off" ? "off (set_clock rtc_chip=auto to look for one)" : `${RTC_CHIP_NAMES[r.configured]} configured but not answering`;
  }
  return out;
}
