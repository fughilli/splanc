/**
 * The schedule editor's pure model (ui/screens/scheduleScreen.ts): the steps a
 * rule goes through, a new rule's defaults, and the action presets. No DOM, so
 * it is unit-tested (web/tests/schedule.test.ts).
 */

import {
  EVERY_DAY_MASK,
  WEEKDAYS_MASK,
  WEEKENDS_MASK,
  needsLocation,
  type RuleAction,
  type RuleActionKind,
  type ScheduleRule,
} from "../../net/schedule";

export type FlowStep = "when" | "time" | "days" | "action" | "detail" | "location" | "review";

/** The steps for `draft`, in order. The location step appears only for a sun
 * rule on a lamp that has no location yet (and none was picked in this flow). */
export function flowSteps(draft: Pick<ScheduleRule, "when">, lampHasLocation: boolean): FlowStep[] {
  const steps: FlowStep[] = ["when", "time", "days", "action", "detail"];
  if (needsLocation(draft) && !lampHasLocation) steps.push("location");
  steps.push("review");
  return steps;
}

/** The step after / before `s` (null at either end). */
export function stepAfter(steps: FlowStep[], s: FlowStep): FlowStep | null {
  const i = steps.indexOf(s);
  return i < 0 || i + 1 >= steps.length ? null : steps[i + 1]!;
}
export function stepBefore(steps: FlowStep[], s: FlowStep): FlowStep | null {
  const i = steps.indexOf(s);
  return i <= 0 ? null : steps[i - 1]!;
}

/** A new rule: 07:00 every day, turning the lamp on. */
export function newRule(id: number): ScheduleRule {
  return {
    id,
    enabled: true,
    label: "",
    when: "time",
    minuteOfDay: 7 * 60,
    offsetMin: 0,
    daysMask: EVERY_DAY_MASK,
    action: { kind: "power", on: true, durationMs: 0 },
  };
}

/** The action a kind starts from (keeping what still applies from `prev`). */
export function actionFor(kind: RuleActionKind | "power_on" | "power_off", prev: RuleAction | null): RuleAction {
  switch (kind) {
    case "power_on":
    case "power_off":
    case "power":
      return {
        kind: "power",
        on: kind === "power" ? (prev?.kind === "power" ? prev.on : true) : kind === "power_on",
        durationMs: prev?.kind === "power" ? prev.durationMs : 0,
      };
    case "brightness":
      return prev?.kind === "brightness" ? prev : { kind: "brightness", level: 0.4, rampMs: 600_000 };
    case "effect":
      return prev?.kind === "effect" ? prev : { kind: "effect", effectId: "", crossfadeMs: 5000 };
    case "trigger":
      return prev?.kind === "trigger" ? prev : { kind: "trigger", name: "" };
  }
}

/** Which "days" preset a mask is. */
export type DaysPreset = "every" | "weekdays" | "weekends" | "custom";
export function daysPreset(mask: number): DaysPreset {
  const m = mask & 0x7f;
  if (m === 0 || m === 0x7f) return "every";
  if (m === WEEKDAYS_MASK) return "weekdays";
  if (m === WEEKENDS_MASK) return "weekends";
  return "custom";
}

/** Toggle one day (0 = Sunday) in a mask. "Every day" (0) expands first; the
 * last day can't be turned off (a rule fires on at least one day), and a mask
 * with every day becomes 0. */
export function toggleDay(mask: number, day: number): number {
  const full = (mask & 0x7f) === 0 ? 0x7f : mask & 0x7f;
  const next = full ^ (1 << day);
  if (next === 0) return mask & 0x7f;
  return next === 0x7f ? 0 : next;
}

/** Whether `rule` can be saved from the detail step. */
export function detailComplete(a: RuleAction | null): boolean {
  if (!a) return false;
  if (a.kind === "effect") return a.effectId.length > 0;
  if (a.kind === "trigger") return a.name.trim().length > 0;
  return true;
}
