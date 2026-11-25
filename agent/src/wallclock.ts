/**
 * The lamps' wall clock through the bridge (docs/design/wall-clock.md): the
 * get_clock / set_clock tools' views and the request a set builds. The push
 * itself (sync, then UTC at a device-clock instant) is the app's,
 * web/src/net/wallClock.ts; the zone comes from the bridge host (hostTz.ts) or
 * the tool's `tz` (an IANA name or a POSIX rule).
 */

import { parsePosixTz, posixTzFromIntl, type PhoneTz } from "../../web/src/net/posixTz";
import { lampLocalTime, lampZoneLabel, type ClockState } from "../../web/src/net/wallClock";

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
  return out;
}
