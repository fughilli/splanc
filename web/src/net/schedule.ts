/**
 * Wall-clock schedules (firmware feature "schedule", docs/design/schedule.md):
 * the set_schedule / delete_schedule / get_schedule -> schedule_state types, the
 * rule <-> wire mapping, paging, and the one-line text the app and the agent
 * show for a rule ("07:00 Mon–Fri · Turn on · fade 30 s").
 *
 * Pure (no DOM): shared by the app's schedule screen and the bridge's MCP tools.
 */

import { parsePosixTz, posixOffsetS } from "./posixTz";

/** What a rule's time is relative to. */
export type RuleWhen = "time" | "sunrise" | "sunset";

export type RuleAction =
  | { kind: "power"; on: boolean; durationMs: number }
  | { kind: "brightness"; level: number; rampMs: number }
  | { kind: "effect"; effectId: string; crossfadeMs: number }
  | { kind: "trigger"; name: string };

export type RuleActionKind = RuleAction["kind"];

/** A ScheduleRule, flat. */
export interface ScheduleRule {
  /** 1..255, unique per lamp (set_schedule upserts by id). */
  id: number;
  enabled: boolean;
  /** <= 24 bytes. */
  label: string;
  when: RuleWhen;
  /** time: minutes after local midnight, 0..1439. */
  minuteOfDay: number;
  /** sunrise / sunset: minutes after the event (negative = before), within ±720. */
  offsetMin: number;
  /** Bit 0 = Sunday .. bit 6 = Saturday; 0 = every day. */
  daysMask: number;
  /** null: the lamp sent an action this app doesn't know. */
  action: RuleAction | null;
}

export type ScheduleSkip = "none" | "live" | "no_effect" | "busy";
export type ScheduleResult = "ok" | "full" | "bad_rule" | "storage" | "not_found";

/** A schedule_state, flat. */
export interface ScheduleState {
  rules: ScheduleRule[];
  page: number;
  pages: number;
  count: number;
  capacity: number;
  clockValid: boolean;
  hasLocation: boolean;
  /** UTC ms of the next fire (0 = none within a week, or no clock). */
  nextFireUnixMs: number;
  nextRuleId: number;
  fired: number;
  skipped: number;
  lastFiredId: number;
  lastFiredUnixMs: number;
  lastSkippedId: number;
  lastSkip: ScheduleSkip;
  /** Seconds left of a live-show hold. */
  holdS: number;
  result: ScheduleResult;
}

/** Limits (firmware/schedule/src/rule.rs). */
export const MAX_LABEL_BYTES = 24;
export const MAX_NAME_BYTES = 64;
export const MAX_OFFSET_MIN = 720;
export const MAX_FADE_MS = 600_000;
export const RULES_PER_FRAME = 4;
/** The longest set_schedule{hold_s} lease the lamp takes. */
export const MAX_HOLD_S = 3600;

// ---- wire --------------------------------------------------------------------------

const WHEN_ENUM: Record<RuleWhen, string> = {
  time: "SCHEDULE_WHEN_LOCAL_TIME",
  sunrise: "SCHEDULE_WHEN_SUNRISE",
  sunset: "SCHEDULE_WHEN_SUNSET",
};
const WHENS: RuleWhen[] = ["time", "sunrise", "sunset"];
const SKIPS: ScheduleSkip[] = ["none", "live", "no_effect", "busy"];
const RESULTS: ScheduleResult[] = ["ok", "full", "bad_rule", "storage", "not_found"];

/** proto ScheduleRule as proto3 JSON (camelCase, enums as names). */
export interface ScheduleRuleWire {
  id?: number;
  disabled?: boolean;
  label?: string;
  when?: string | number;
  minuteOfDay?: number;
  offsetMin?: number;
  daysMask?: number;
  power?: { on?: boolean; durationMs?: number };
  brightness?: { level?: number; rampMs?: number };
  effect?: { effectId?: string; crossfadeMs?: number };
  trigger?: { name?: string };
}

export interface SetScheduleMessage {
  type: "set_schedule";
  rules?: ScheduleRuleWire[];
  replaceAll?: boolean;
  holdS?: number;
  releaseHold?: boolean;
}

export interface DeleteScheduleMessage {
  type: "delete_schedule";
  id?: number;
  all?: boolean;
}

export interface GetScheduleMessage {
  type: "get_schedule";
  page?: number;
}

/** proto ScheduleState as decoded (int64 as strings, enums as names). */
export interface ScheduleStateMessage {
  type: "schedule_state";
  rules?: ScheduleRuleWire[];
  page?: number;
  pages?: number;
  count?: number;
  capacity?: number;
  clockValid?: boolean;
  hasLocation?: boolean;
  nextFireUnixMs?: string | number;
  nextRuleId?: number;
  fired?: number;
  skipped?: number;
  lastFiredId?: number;
  lastFiredUnixMs?: string | number;
  lastSkippedId?: number;
  lastSkip?: string | number;
  holdS?: number;
  result?: string | number;
}

/** proto SetClockConfig, flat (the location part: docs/design/schedule.md). */
export interface SetClockConfigMessage {
  type: "set_clock_config";
  latE4?: number;
  lonE4?: number;
  clearLocation?: boolean;
}

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

export function ruleToWire(r: ScheduleRule): ScheduleRuleWire {
  const w: ScheduleRuleWire = {
    id: r.id,
    disabled: !r.enabled,
    label: r.label,
    when: WHEN_ENUM[r.when],
    minuteOfDay: r.when === "time" ? r.minuteOfDay : 0,
    offsetMin: r.when === "time" ? 0 : r.offsetMin,
    daysMask: r.daysMask & 0x7f,
  };
  const a = r.action;
  if (a?.kind === "power") w.power = { on: a.on, durationMs: a.durationMs };
  else if (a?.kind === "brightness") w.brightness = { level: a.level, rampMs: a.rampMs };
  else if (a?.kind === "effect") w.effect = { effectId: a.effectId, crossfadeMs: a.crossfadeMs };
  else if (a?.kind === "trigger") w.trigger = { name: a.name };
  return w;
}

export function ruleFromWire(w: ScheduleRuleWire): ScheduleRule {
  // The "when" names are SCHEDULE_WHEN_LOCAL_TIME / _SUNRISE / _SUNSET.
  const whenIdx =
    typeof w.when === "string" && w.when.endsWith("LOCAL_TIME") ? 0 : enumIndex(w.when, WHENS, "SCHEDULE_WHEN_");
  let action: RuleAction | null = null;
  if (w.power) action = { kind: "power", on: w.power.on ?? false, durationMs: w.power.durationMs ?? 0 };
  else if (w.brightness) {
    action = { kind: "brightness", level: w.brightness.level ?? 0, rampMs: w.brightness.rampMs ?? 0 };
  } else if (w.effect) {
    action = { kind: "effect", effectId: w.effect.effectId ?? "", crossfadeMs: w.effect.crossfadeMs ?? 0 };
  } else if (w.trigger) action = { kind: "trigger", name: w.trigger.name ?? "" };
  return {
    id: w.id ?? 0,
    enabled: !(w.disabled ?? false),
    label: w.label ?? "",
    when: WHENS[whenIdx] ?? "time",
    minuteOfDay: w.minuteOfDay ?? 0,
    offsetMin: w.offsetMin ?? 0,
    daysMask: (w.daysMask ?? 0) & 0x7f,
    action,
  };
}

export function flatScheduleState(m: Partial<ScheduleStateMessage>): ScheduleState {
  return {
    rules: (m.rules ?? []).map(ruleFromWire),
    page: m.page ?? 0,
    pages: m.pages ?? 0,
    count: m.count ?? 0,
    capacity: m.capacity ?? 0,
    clockValid: m.clockValid ?? false,
    hasLocation: m.hasLocation ?? false,
    nextFireUnixMs: num(m.nextFireUnixMs),
    nextRuleId: m.nextRuleId ?? 0,
    fired: m.fired ?? 0,
    skipped: m.skipped ?? 0,
    lastFiredId: m.lastFiredId ?? 0,
    lastFiredUnixMs: num(m.lastFiredUnixMs),
    lastSkippedId: m.lastSkippedId ?? 0,
    lastSkip: SKIPS[enumIndex(m.lastSkip, SKIPS, "SCHEDULE_SKIP_")] ?? "none",
    holdS: m.holdS ?? 0,
    result: RESULTS[enumIndex(m.result, RESULTS, "SCHEDULE_RESULT_")] ?? "ok",
  };
}

// ---- the client side ---------------------------------------------------------------

/** The lamp serves schedules. */
export function deviceHasSchedule(welcome: { features?: string[] } | null | undefined): boolean {
  return (welcome?.features ?? []).includes("schedule");
}

/** What the schedule helpers need from a client (net/client.ts). */
export interface ScheduleClient {
  getSchedule(page?: number): Promise<ScheduleState>;
  setSchedule(req: Omit<SetScheduleMessage, "type">): Promise<ScheduleState>;
  deleteSchedule(req: Omit<DeleteScheduleMessage, "type">): Promise<ScheduleState>;
}

/** Every rule (all pages) plus the state of the last page read. */
export async function readSchedule(client: Pick<ScheduleClient, "getSchedule">): Promise<ScheduleState> {
  const first = await client.getSchedule(0);
  const rules = [...first.rules];
  let last = first;
  for (let p = 1; p < first.pages && p < 16; p++) {
    last = await client.getSchedule(p);
    rules.push(...last.rules);
  }
  return { ...last, rules, page: 0 };
}

/** Why a set / delete was refused, in words (null when it was taken). */
export function scheduleResultError(r: ScheduleResult): string | null {
  switch (r) {
    case "ok":
      return null;
    case "full":
      return "the lamp's schedule is full";
    case "bad_rule":
      return "the lamp refused the rule (out of range)";
    case "storage":
      return "the lamp couldn't store its schedule";
    case "not_found":
      return "no such rule on the lamp";
  }
}

/** Upsert one rule; throws with the lamp's reason when refused. */
export async function saveRule(client: Pick<ScheduleClient, "setSchedule">, rule: ScheduleRule): Promise<ScheduleState> {
  const err = validateRule(rule);
  if (err) throw new Error(err);
  const st = await client.setSchedule({ rules: [ruleToWire(rule)] });
  const why = scheduleResultError(st.result);
  if (why) throw new Error(why);
  return st;
}

/** The lowest id 1..255 not in use (0 = full). */
export function nextFreeId(rules: readonly { id: number }[]): number {
  const used = new Set(rules.map((r) => r.id));
  for (let i = 1; i <= 255; i++) if (!used.has(i)) return i;
  return 0;
}

const utf8Len = (s: string): number => new TextEncoder().encode(s).length;

/** Cut a label to the lamp's 24 bytes without splitting a character. */
export function clampLabel(s: string): string {
  let out = s.trim();
  while (utf8Len(out) > MAX_LABEL_BYTES) out = [...out].slice(0, -1).join("");
  return out;
}

/** Why the lamp would refuse this rule (null = fine). */
export function validateRule(r: ScheduleRule): string | null {
  if (!Number.isInteger(r.id) || r.id < 1 || r.id > 255) return "rule id must be 1..255";
  if (utf8Len(r.label) > MAX_LABEL_BYTES) return `label is longer than ${MAX_LABEL_BYTES} bytes`;
  if (r.when === "time" && (!Number.isInteger(r.minuteOfDay) || r.minuteOfDay < 0 || r.minuteOfDay > 1439)) {
    return "time must be 00:00..23:59";
  }
  if (r.when !== "time" && (!Number.isInteger(r.offsetMin) || Math.abs(r.offsetMin) > MAX_OFFSET_MIN)) {
    return "sun offset must be within ±12 h";
  }
  const a = r.action;
  if (!a) return "the rule needs an action";
  if (a.kind === "power" && (a.durationMs < 0 || a.durationMs > MAX_FADE_MS)) return "fade must be 0..600 s";
  if (a.kind === "brightness") {
    if (!(a.level >= 0 && a.level <= 1)) return "brightness must be 0..1";
    if (a.rampMs < 0 || a.rampMs > MAX_FADE_MS) return "ramp must be 0..600 s";
  }
  if (a.kind === "effect") {
    if (!a.effectId) return "pick an effect";
    if (utf8Len(a.effectId) > MAX_NAME_BYTES) return "effect id is too long";
    if (a.crossfadeMs < 0 || a.crossfadeMs > MAX_FADE_MS) return "crossfade must be 0..600 s";
  }
  if (a.kind === "trigger") {
    if (!a.name) return "the trigger needs a name";
    if (utf8Len(a.name) > MAX_NAME_BYTES) return "trigger name is too long";
  }
  return null;
}

// ---- location (D-565) --------------------------------------------------------------

/** Degrees -> the lamp's 1e-4 degree units, rounded to 0.1° (about 11 km): the
 * phone's position is never sent more precisely than that. */
export function locationE4(deg: number): number {
  const v = Math.round(deg * 10) * 1000;
  return Object.is(v, -0) ? 0 : v;
}

/** The set_clock_config that stores a rounded location. */
export function locationRequest(latDeg: number, lonDeg: number): Omit<SetClockConfigMessage, "type"> {
  const lat = Math.max(-90, Math.min(90, latDeg));
  let lon = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  if (lon === -180 && lonDeg > 0) lon = 180;
  return { latE4: locationE4(lat), lonE4: locationE4(lon) };
}

/** "47.4° N, 8.5° E". */
export function locationLabel(latE4: number, lonE4: number): string {
  const f = (v: number, pos: string, neg: string): string => `${Math.abs(v / 1e4).toFixed(1)}° ${v < 0 ? neg : pos}`;
  return `${f(latE4, "N", "S")}, ${f(lonE4, "E", "W")}`;
}

// ---- text ----------------------------------------------------------------------------

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const WEEKDAYS_MASK = 0b0111110;
export const WEEKENDS_MASK = 0b1000001;
export const EVERY_DAY_MASK = 0;

export function dayShort(i: number): string {
  return DAY_SHORT[i] ?? "?";
}

/** "Every day", "Mon–Fri", "Weekends", "Mon, Wed, Fri", "Tue–Thu". */
export function daysLabel(mask: number): string {
  const m = mask & 0x7f;
  if (m === 0 || m === 0x7f) return "Every day";
  if (m === WEEKDAYS_MASK) return "Mon–Fri";
  if (m === WEEKENDS_MASK) return "Weekends";
  // Monday-first runs.
  const order = [1, 2, 3, 4, 5, 6, 0];
  const on = order.map((d) => (m >> d) & 1);
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    if (!on[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < 7 && on[j + 1]) j++;
    const a = dayShort(order[i]!);
    const b = dayShort(order[j]!);
    if (j - i >= 2) parts.push(`${a}–${b}`);
    else if (j === i) parts.push(a);
    else parts.push(a, b);
    i = j + 1;
  }
  return parts.join(", ");
}

export function hhmm(minuteOfDay: number): string {
  const m = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** "45 min", "1 h 30 min", "2 h". */
export function durationLabel(min: number): string {
  const a = Math.abs(Math.round(min));
  const h = Math.floor(a / 60);
  const mm = a % 60;
  if (h === 0) return `${mm} min`;
  return mm === 0 ? `${h} h` : `${h} h ${mm} min`;
}

/** "07:00", "Sunset", "30 min before sunset", "1 h after sunrise". */
export function whenLabel(r: Pick<ScheduleRule, "when" | "minuteOfDay" | "offsetMin">): string {
  if (r.when === "time") return hhmm(r.minuteOfDay);
  const ev = r.when === "sunrise" ? "sunrise" : "sunset";
  if (r.offsetMin === 0) return ev === "sunrise" ? "Sunrise" : "Sunset";
  return `${durationLabel(r.offsetMin)} ${r.offsetMin < 0 ? "before" : "after"} ${ev}`;
}

/** "30 s", "1.5 s", "2 min". */
export function secondsLabel(ms: number): string {
  const s = ms / 1000;
  if (s >= 60 && Number.isInteger(s / 60)) return `${s / 60} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

/** "Turn on · fade 30 s", "Brightness 40% over 10 min", "Effect Embers · crossfade 5 s", "Trigger alarm". */
export function actionLabel(a: RuleAction | null, effectName: (id: string) => string | undefined = () => undefined): string {
  if (!a) return "Unknown action";
  switch (a.kind) {
    case "power": {
      const base = a.on ? "Turn on" : "Turn off";
      return a.durationMs > 0 ? `${base} · fade ${secondsLabel(a.durationMs)}` : base;
    }
    case "brightness": {
      const pct = `Brightness ${Math.round(a.level * 100)}%`;
      return a.rampMs > 0 ? `${pct} over ${secondsLabel(a.rampMs)}` : pct;
    }
    case "effect": {
      const name = effectName(a.effectId) ?? a.effectId;
      return a.crossfadeMs > 0 ? `Effect ${name} · crossfade ${secondsLabel(a.crossfadeMs)}` : `Effect ${name} · cut`;
    }
    case "trigger":
      return `Trigger ${a.name}`;
  }
}

/** One line per rule: "07:00 Mon–Fri · Turn on · fade 30 s", "Sunset · Every day · Turn on". */
export function ruleSummary(r: ScheduleRule, effectName?: (id: string) => string | undefined): string {
  const sep = r.when === "time" ? " " : " · ";
  return `${whenLabel(r)}${sep}${daysLabel(r.daysMask)} · ${actionLabel(r.action, effectName)}`;
}

/** A local "HH:MM" (plus the weekday when not today) for UTC `unixMs` in POSIX zone `tz`. */
export function lampWhen(unixMs: number, tz: string, nowMs: number): string {
  const z = parsePosixTz(tz || "UTC0");
  const off = (t: number): number => (z ? posixOffsetS(z, t) : 0) * 1000;
  const d = new Date(unixMs + off(unixMs));
  const today = new Date(nowMs + off(nowMs));
  const t = hhmm(d.getUTCHours() * 60 + d.getUTCMinutes());
  const dayDiff = Math.round(
    (Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) -
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) /
      86_400_000,
  );
  if (dayDiff === 0) return `${t} today`;
  if (dayDiff === 1) return `${t} tomorrow`;
  return `${t} ${DAY_NAMES[d.getUTCDay()]}`;
}

/** The status line under the rule list. */
export function scheduleStatus(
  st: ScheduleState,
  tz: string,
  nowMs: number,
  effectName?: (id: string) => string | undefined,
): string {
  if (st.count === 0) return "No rules yet.";
  if (!st.clockValid) return "The lamp's clock isn't set, so rules wait until this phone or the bridge sets it.";
  const parts: string[] = [];
  if (st.holdS > 0) parts.push(`Paused for a live show (${Math.ceil(st.holdS / 60)} min left)`);
  if (st.nextFireUnixMs > 0) {
    const r = st.rules.find((x) => x.id === st.nextRuleId);
    parts.push(`Next: ${lampWhen(st.nextFireUnixMs, tz, nowMs)}${r ? ` · ${actionLabel(r.action, effectName)}` : ""}`);
  } else {
    parts.push("Nothing due in the next week");
  }
  return parts.join(" · ");
}

/** A short reason for the last skip, or "". */
export function skipLabel(s: ScheduleSkip): string {
  switch (s) {
    case "live":
      return "skipped during a live show";
    case "no_effect":
      return "skipped: its effect is no longer on the lamp";
    case "busy":
      return "skipped: the lamp was busy with a power transition";
    default:
      return "";
  }
}

/** The rule needs the lamp's location (a sun rule). */
export function needsLocation(r: Pick<ScheduleRule, "when">): boolean {
  return r.when !== "time";
}
