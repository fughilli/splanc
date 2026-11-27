/**
 * Wall-clock schedules through the bridge (docs/design/schedule.md): the MCP
 * list_schedules / set_schedule / delete_schedule tools' input parsing and views.
 * The wire mapping and the rule text are the app's, web/src/net/schedule.ts.
 *
 * (Not schedule.ts: that is the apply_at timing of live changes.)
 */

import {
  DAY_NAMES,
  EVERY_DAY_MASK,
  MAX_FADE_MS,
  MAX_OFFSET_MIN,
  WEEKDAYS_MASK,
  WEEKENDS_MASK,
  actionLabel,
  clampLabel,
  daysLabel,
  hhmm,
  lampWhen,
  locationLabel,
  ruleSummary,
  skipLabel,
  validateRule,
  whenLabel,
  type RuleAction,
  type ScheduleRule,
  type ScheduleState,
} from "../../web/src/net/schedule";
import type { ClockState } from "../../web/src/net/wallClock";

/** A rule as a tool takes it (snake_case, seconds, "HH:MM", day names). */
export interface RuleInput {
  id?: number | undefined;
  label?: string | undefined;
  enabled?: boolean | undefined;
  when: "time" | "sunrise" | "sunset";
  time?: string | undefined;
  offset_min?: number | undefined;
  days?: string | string[] | undefined;
  action:
    | { type: "power"; on: boolean; fade_s?: number | undefined }
    | { type: "brightness"; level: number; ramp_s?: number | undefined }
    | { type: "effect"; effect_id: string; crossfade_s?: number | undefined }
    | { type: "trigger"; name: string };
}

const DAY_ALIASES: Record<string, number> = {};
DAY_NAMES.forEach((n, i) => {
  DAY_ALIASES[n.toLowerCase()] = i;
  DAY_ALIASES[n.slice(0, 3).toLowerCase()] = i;
  DAY_ALIASES[n.slice(0, 2).toLowerCase()] = i;
});

/** "every day" | "weekdays" | "weekends" | ["mon", "wed"] | "mon,wed" -> days_mask. */
export function daysFromInput(days: string | string[] | undefined): number {
  if (days === undefined) return EVERY_DAY_MASK;
  const list = (Array.isArray(days) ? days : days.split(/[,\s]+/)).map((d) => d.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) return EVERY_DAY_MASK;
  let mask = 0;
  for (const d of list) {
    if (d === "every" || d === "everyday" || d === "every day" || d === "daily" || d === "all") return EVERY_DAY_MASK;
    if (d === "weekdays") mask |= WEEKDAYS_MASK;
    else if (d === "weekends" || d === "weekend") mask |= WEEKENDS_MASK;
    else if (DAY_ALIASES[d] !== undefined) mask |= 1 << DAY_ALIASES[d];
    else throw new Error(`unknown day "${d}" (use day names, "weekdays", "weekends" or "every day")`);
  }
  return mask === 0x7f ? EVERY_DAY_MASK : mask;
}

/** "07:00" / "7:30" / "19:05" -> minutes after midnight. */
export function minuteFromInput(time: string): number {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(time);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`can't read the time "${time}" (use HH:MM, 24 h)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const ms = (s: number | undefined): number => Math.round((s ?? 0) * 1000);

/** A tool's rule -> a ScheduleRule (id 0 = "pick one"). Throws with a user-facing message. */
export function ruleFromInput(r: RuleInput): ScheduleRule {
  const a = r.action;
  let action: RuleAction;
  switch (a.type) {
    case "power":
      action = { kind: "power", on: a.on, durationMs: ms(a.fade_s) };
      break;
    case "brightness":
      action = { kind: "brightness", level: a.level, rampMs: ms(a.ramp_s) };
      break;
    case "effect":
      action = { kind: "effect", effectId: a.effect_id, crossfadeMs: ms(a.crossfade_s ?? 5) };
      break;
    case "trigger":
      action = { kind: "trigger", name: a.name };
      break;
  }
  if (r.when === "time" && r.time === undefined) throw new Error('a "time" rule needs time (HH:MM)');
  const rule: ScheduleRule = {
    id: r.id ?? 0,
    enabled: r.enabled ?? true,
    label: clampLabel(r.label ?? ""),
    when: r.when,
    minuteOfDay: r.when === "time" ? minuteFromInput(r.time!) : 0,
    offsetMin: r.when === "time" ? 0 : Math.round(r.offset_min ?? 0),
    daysMask: daysFromInput(r.days),
    action,
  };
  const err = validateRule({ ...rule, id: rule.id || 1 });
  if (err) throw new Error(err);
  return rule;
}

/** One rule as the tools show it. */
export function ruleView(r: ScheduleRule): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: r.id,
    summary: ruleSummary(r),
    enabled: r.enabled,
    when: r.when,
  };
  if (r.label) out["label"] = r.label;
  if (r.when === "time") out["time"] = hhmm(r.minuteOfDay);
  else out["offset_min"] = r.offsetMin;
  out["days"] = daysLabel(r.daysMask);
  const a = r.action;
  if (a?.kind === "power") out["action"] = { type: "power", on: a.on, fade_s: a.durationMs / 1000 };
  else if (a?.kind === "brightness") out["action"] = { type: "brightness", level: a.level, ramp_s: a.rampMs / 1000 };
  else if (a?.kind === "effect") {
    out["action"] = { type: "effect", effect_id: a.effectId, crossfade_s: a.crossfadeMs / 1000 };
  } else if (a?.kind === "trigger") out["action"] = { type: "trigger", name: a.name };
  else out["action"] = actionLabel(null);
  return out;
}

/** The tools' view of a whole schedule (all pages) with the lamp's clock. */
export function scheduleView(st: ScheduleState, clock: ClockState | null, nowMs = Date.now()): Record<string, unknown> {
  const tz = clock?.tz ?? "";
  const out: Record<string, unknown> = {
    rules: st.rules.map(ruleView),
    count: st.count,
    capacity: st.capacity,
    clock_set: st.clockValid,
  };
  if (!st.clockValid) out["note"] = "the lamp's clock is not set, so no rule fires until it is (set_clock)";
  if (st.nextFireUnixMs > 0) {
    out["next"] = {
      rule_id: st.nextRuleId,
      at_utc: new Date(st.nextFireUnixMs).toISOString(),
      at_lamp_time: lampWhen(st.nextFireUnixMs, tz, nowMs),
    };
  }
  const sun = st.rules.some((r) => r.when !== "time");
  if (sun || st.hasLocation) {
    out["location"] = clock?.hasLocation
      ? locationLabel(clock.latE4, clock.lonE4)
      : st.hasLocation
        ? "set"
        : "not set: sunrise/sunset rules won't fire until the Splanc app's Schedule screen sets it";
  }
  if (st.fired || st.skipped) {
    out["since_boot"] = { fired: st.fired, skipped: st.skipped };
    const why = skipLabel(st.lastSkip);
    if (why && st.lastSkippedId) out["last_skip"] = { rule_id: st.lastSkippedId, why };
  }
  if (st.holdS > 0) out["paused_for_live_show_s"] = st.holdS;
  return out;
}

/** Ids of `incoming` that would replace existing rules (the ask-first check). */
export function overwrites(existing: readonly ScheduleRule[], incoming: readonly ScheduleRule[]): ScheduleRule[] {
  const ids = new Set(incoming.map((r) => r.id).filter((id) => id > 0));
  return existing.filter((r) => ids.has(r.id));
}

/** Give id-less rules free ids (in order), without clashing with `existing` or each other. */
export function assignIds(existing: readonly ScheduleRule[], incoming: ScheduleRule[]): ScheduleRule[] {
  const used = new Set([...existing.map((r) => r.id), ...incoming.map((r) => r.id).filter((id) => id > 0)]);
  return incoming.map((r) => {
    if (r.id > 0) return r;
    let id = 1;
    while (used.has(id) && id <= 255) id++;
    if (id > 255) throw new Error("the lamp has no free rule ids");
    used.add(id);
    return { ...r, id };
  });
}

export { MAX_FADE_MS, MAX_OFFSET_MIN, whenLabel };
