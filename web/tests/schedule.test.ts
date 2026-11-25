/** Wall-clock schedules (net/schedule.ts + ui/screens/scheduleModel.ts): the rule
 * <-> wire mapping and the set_schedule / schedule_state round trip, paging, the
 * rounded location, the one-line text, and the editor's steps. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeClient, decodeServer, encodeClient, encodeServer } from "../src/net/proto";
import {
  daysLabel,
  flatScheduleState,
  lampWhen,
  locationE4,
  locationLabel,
  locationRequest,
  nextFreeId,
  readSchedule,
  ruleFromWire,
  ruleSummary,
  ruleToWire,
  saveRule,
  scheduleStatus,
  validateRule,
  whenLabel,
  type ScheduleRule,
  type ScheduleState,
} from "../src/net/schedule";
import { actionFor, daysPreset, flowSteps, newRule, stepAfter, toggleDay } from "../src/ui/screens/scheduleModel";
import type { ClientMessage, ServerMessage } from "@ledmapper/protocol";

const rule = (patch: Partial<ScheduleRule> = {}): ScheduleRule => ({ ...newRule(1), ...patch });

test("a rule survives the set_schedule wire round trip, every action", () => {
  const rules: ScheduleRule[] = [
    rule({ id: 1, minuteOfDay: 420, daysMask: 0b0111110, action: { kind: "power", on: true, durationMs: 30_000 } }),
    rule({ id: 2, when: "sunset", minuteOfDay: 0, offsetMin: -30, label: "Evening", action: { kind: "effect", effectId: "embers", crossfadeMs: 5000 } }),
    rule({ id: 3, when: "sunrise", minuteOfDay: 0, offsetMin: 15, enabled: false, action: { kind: "brightness", level: 0.25, rampMs: 600_000 } }),
    rule({ id: 4, minuteOfDay: 0, action: { kind: "trigger", name: "alarm" } }),
  ];
  const frame = encodeClient({ type: "set_schedule", rules: rules.map(ruleToWire), holdS: 0 } as unknown as ClientMessage);
  const back = decodeClient(frame) as unknown as { type: string; rules: Record<string, unknown>[] };
  assert.equal(back.type, "set_schedule");
  assert.equal(back.rules[1]!["when"], "SCHEDULE_WHEN_SUNSET");
  const again = back.rules.map((w) => ruleFromWire(w as never));
  assert.deepEqual(again, rules);
  // A minute 0 rule still says LOCAL_TIME (the zero enum).
  assert.equal(again[3]!.when, "time");
});

test("schedule_state decodes into the flat state", () => {
  const frame = encodeServer({
    type: "schedule_state",
    rules: [ruleToWire(rule({ id: 7, minuteOfDay: 1320 }))],
    page: 0,
    pages: 1,
    count: 1,
    capacity: 24,
    clockValid: true,
    hasLocation: false,
    nextFireUnixMs: "1795000000000",
    nextRuleId: 7,
    fired: 3,
    skipped: 1,
    lastSkippedId: 7,
    lastSkip: "SCHEDULE_SKIP_LIVE",
    holdS: 90,
    result: "SCHEDULE_RESULT_FULL",
  } as unknown as ServerMessage);
  const st = flatScheduleState(decodeServer(frame) as never);
  assert.equal(st.rules[0]!.id, 7);
  assert.equal(st.rules[0]!.minuteOfDay, 1320);
  assert.equal(st.nextFireUnixMs, 1_795_000_000_000);
  assert.equal(st.lastSkip, "live");
  assert.equal(st.result, "full");
  assert.equal(st.holdS, 90);
  const empty = flatScheduleState({ type: "schedule_state" });
  assert.equal(empty.result, "ok");
  assert.deepEqual(empty.rules, []);
});

test("set_clock_config carries the location only rounded to 0.1 degrees", () => {
  assert.deepEqual(locationRequest(47.376_887, 8.541_694), { latE4: 474_000, lonE4: 85_000 });
  assert.deepEqual(locationRequest(-33.868_82, 151.209_29), { latE4: -339_000, lonE4: 1_512_000 });
  assert.equal(locationE4(-0.04), 0);
  // Every value is a multiple of 1000 (0.1 degree) and wraps / clamps into range.
  assert.deepEqual(locationRequest(91, 190.06), { latE4: 900_000, lonE4: -1_699_000 });
  const back = decodeClient(
    encodeClient({ type: "set_clock_config", ...locationRequest(40.7128, -74.006) } as unknown as ClientMessage),
  ) as unknown as Record<string, unknown>;
  assert.equal(back["latE4"], 407_000);
  assert.equal(back["lonE4"], -740_000);
  assert.equal(locationLabel(407_000, -740_000), "40.7° N, 74.0° W");
});

test("the one-line text", () => {
  assert.equal(
    ruleSummary(rule({ minuteOfDay: 420, daysMask: 0b0111110, action: { kind: "power", on: true, durationMs: 30_000 } })),
    "07:00 Mon–Fri · Turn on · fade 30 s",
  );
  assert.equal(
    ruleSummary(
      rule({ when: "sunset", offsetMin: -90, action: { kind: "effect", effectId: "e1", crossfadeMs: 0 } }),
      (id) => (id === "e1" ? "Embers" : undefined),
    ),
    "1 h 30 min before sunset · Every day · Effect Embers · cut",
  );
  assert.equal(whenLabel({ when: "sunrise", minuteOfDay: 0, offsetMin: 0 }), "Sunrise");
  assert.equal(daysLabel(0b1000001), "Weekends");
  assert.equal(daysLabel(0b0011110), "Mon–Thu");
  assert.equal(daysLabel(0b0101010), "Mon, Wed, Fri");
  assert.equal(daysLabel(0b1000110), "Mon, Tue, Sat");
  assert.equal(daysLabel(0b1111110), "Mon–Sat");
});

test("next fire in the lamp's zone, and the status line", () => {
  // 2026-11-25 12:00 UTC is 13:00 in Berlin (CET).
  const now = Date.UTC(2026, 10, 25, 12, 0);
  const tz = "CET-1CEST,M3.5.0,M10.5.0/3";
  assert.equal(lampWhen(Date.UTC(2026, 10, 25, 16, 30), tz, now), "17:30 today");
  assert.equal(lampWhen(Date.UTC(2026, 10, 26, 6, 0), tz, now), "07:00 tomorrow");
  assert.equal(lampWhen(Date.UTC(2026, 10, 28, 6, 0), tz, now), "07:00 Saturday");
  const st: ScheduleState = {
    ...flatScheduleState({ type: "schedule_state" }),
    rules: [rule({ id: 2, action: { kind: "power", on: true, durationMs: 0 } })],
    count: 1,
    clockValid: true,
    nextFireUnixMs: Date.UTC(2026, 10, 26, 6, 0),
    nextRuleId: 2,
  };
  assert.equal(scheduleStatus(st, tz, now), "Next: 07:00 tomorrow · Turn on");
  assert.match(scheduleStatus({ ...st, clockValid: false }, tz, now), /clock isn't set/);
  assert.match(scheduleStatus({ ...st, holdS: 100 }, tz, now), /^Paused for a live show \(2 min left\)/);
});

test("validation mirrors the lamp's limits", () => {
  assert.equal(validateRule(rule()), null);
  assert.match(validateRule(rule({ id: 0 }))!, /1..255/);
  assert.match(validateRule(rule({ minuteOfDay: 1440 }))!, /23:59/);
  assert.match(validateRule(rule({ when: "sunset", offsetMin: 721 }))!, /12 h/);
  assert.match(validateRule(rule({ label: "é".repeat(13) }))!, /24 bytes/);
  assert.match(validateRule(rule({ action: { kind: "effect", effectId: "", crossfadeMs: 0 } }))!, /pick an effect/);
  assert.match(validateRule(rule({ action: { kind: "brightness", level: 2, rampMs: 0 } }))!, /0..1/);
  assert.equal(nextFreeId([{ id: 1 }, { id: 2 }, { id: 4 }]), 3);
});

test("paging reads every rule; a refused save throws the lamp's reason", async () => {
  const all = Array.from({ length: 9 }, (_, i) => rule({ id: i + 1 }));
  const pages: number[] = [];
  const client = {
    getSchedule: async (page = 0) => {
      pages.push(page);
      return {
        ...flatScheduleState({ type: "schedule_state" }),
        rules: all.slice(page * 4, page * 4 + 4),
        page,
        pages: 3,
        count: 9,
      };
    },
  };
  const st = await readSchedule(client);
  assert.deepEqual(pages, [0, 1, 2]);
  assert.equal(st.rules.length, 9);
  const full = { setSchedule: async () => ({ ...flatScheduleState({ type: "schedule_state" }), result: "full" as const }) };
  await assert.rejects(saveRule(full, rule()), /schedule is full/);
  await assert.rejects(saveRule(full, rule({ id: 0 })), /1..255/);
});

test("the editor's steps: the location step only for a sun rule on a lamp without one", () => {
  assert.deepEqual(flowSteps({ when: "time" }, false), ["when", "time", "days", "action", "detail", "review"]);
  assert.deepEqual(flowSteps({ when: "sunset" }, true), ["when", "time", "days", "action", "detail", "review"]);
  const sun = flowSteps({ when: "sunrise" }, false);
  assert.deepEqual(sun, ["when", "time", "days", "action", "detail", "location", "review"]);
  assert.equal(stepAfter(sun, "detail"), "location");
  assert.equal(stepAfter(sun, "review"), null);
  // Days: every day expands before a toggle; the last day stays on; seven = every day.
  assert.equal(toggleDay(0, 0), 0b1111110);
  assert.equal(toggleDay(0b0000010, 1), 0b0000010);
  assert.equal(toggleDay(0b1111110, 0), 0);
  assert.equal(daysPreset(0b0111110), "weekdays");
  assert.equal(daysPreset(0b0000110), "custom");
  // Actions keep what still applies.
  assert.deepEqual(actionFor("power_off", { kind: "power", on: true, durationMs: 4000 }), {
    kind: "power",
    on: false,
    durationMs: 4000,
  });
  assert.deepEqual(actionFor("effect", null), { kind: "effect", effectId: "", crossfadeMs: 5000 });
});
