/**
 * Scheduled changes across a room (docs/design/synced-show.md "Scheduled changes").
 * A control change sent to N players lands spread over their Wi-Fi latency (tens of
 * ms+). Firmware with the "apply_at" feature takes an apply time on the shared
 * effect time base (SetUniforms / SetEffect / SetCrossfade / SetBrightness
 * `apply_at_ms`) and applies it at that render frame. The hub picks ONE instant on
 * its own clock a little ahead (the lead) and gives each player that instant in its
 * time base: apply_at = at - (the room epoch alignTime gave it), both hub ms — the
 * player's clock offset is already folded into its epoch, so every player changes
 * on the same frame (to within the time-base skew).
 */

/** Default lead (ms) for a change sent to several players: comfortably more than a
 * Wi-Fi round trip, short enough to feel immediate. */
export const DEFAULT_LEAD_MS = 150;
/** The most a caller may ask for (the firmware treats > 10 s ahead as a mismatch). */
export const MAX_LEAD_MS = 5000;

/** One player's scheduled change: when it should land (hub clock,
 * performance.now() ms) and the room epoch its time base was given (hub ms). */
export interface Scheduled {
  atHubMs: number;
  epochHubMs: number;
  /** The lead it was planned with: a ramp / fade sends each step this far ahead
   * of its instant (even when the start itself was missed). */
  leadMs?: number;
}

/** A player's apply_at_ms for hub time `hubMs` (default: the scheduled instant). */
export function applyAtOf(s: Scheduled, hubMs = s.atHubMs): number {
  return Math.max(0, Math.round(hubMs - s.epochHubMs));
}

/** What the planner needs to know about each target. */
export interface ScheduleCandidate {
  id: string;
  name: string;
  /** The firmware advertises "apply_at" (and this bundle can encode it). */
  applyAt: boolean;
  /** The room epoch alignTime gave it (hub ms); undefined: not aligned. */
  epochHubMs: number | undefined;
}

export interface SchedulePlan {
  /** 0: everything applies on arrival. */
  leadMs: number;
  /** Per scheduled player id. */
  scheduled: Map<string, Scheduled>;
  /** Names applying on arrival although a lead was in force. */
  immediate: string[];
  note?: string;
}

/**
 * Decide who gets a scheduled time. `leadMs` undefined = the default: schedule
 * only when several players are targeted and every one supports apply_at (a mixed
 * room would otherwise put the scheduled ones `lead` behind the rest). An explicit
 * lead schedules every player that can take it; the others apply on arrival (noted).
 * Players must already share a time base (`epochHubMs`); see {@link needsAlign}.
 */
export function planSchedule(
  players: ScheduleCandidate[],
  leadMs: number | undefined,
  nowHubMs: number,
): SchedulePlan {
  const none = (note?: string): SchedulePlan => ({
    leadMs: 0,
    scheduled: new Map(),
    immediate: [],
    ...(note ? { note } : {}),
  });
  const can = (p: ScheduleCandidate) => p.applyAt && p.epochHubMs !== undefined;
  const cannot = players.filter((p) => !can(p)).map((p) => p.name);
  let lead: number;
  if (leadMs === undefined) {
    if (players.length < 2) return none();
    if (cannot.length) {
      return none(
        `applied on arrival everywhere (not scheduled): ${cannot.join(", ")} can't take a scheduled change ` +
          '(firmware without "apply_at", or no shared time base), so the players may change a few tens of ms apart',
      );
    }
    lead = DEFAULT_LEAD_MS;
  } else {
    lead = Math.min(MAX_LEAD_MS, Math.max(0, leadMs));
    if (lead === 0) return none();
  }
  const atHubMs = nowHubMs + lead;
  const scheduled = new Map<string, Scheduled>();
  for (const p of players) if (can(p)) scheduled.set(p.id, { atHubMs, epochHubMs: p.epochHubMs!, leadMs: lead });
  return {
    leadMs: lead,
    scheduled,
    immediate: cannot,
    ...(cannot.length
      ? {
          note:
            `${cannot.join(", ")} applied on arrival (firmware without "apply_at", or no shared time base); ` +
            `the others changed together ${lead} ms after the call`,
        }
      : {}),
  };
}

/** Whether to (re)align the time base before scheduling: some target that could
 * take a scheduled change has no room epoch yet. */
export function needsAlign(players: ScheduleCandidate[], leadMs: number | undefined): boolean {
  if (leadMs === 0 || (leadMs === undefined && players.length < 2)) return false;
  return players.some((p) => p.applyAt && p.epochHubMs === undefined);
}

/** The result fields a scheduled tool call reports. */
export function scheduleReport(plan: SchedulePlan): Record<string, unknown> {
  if (plan.leadMs === 0) return plan.note ? { schedule: { applied: "on arrival", note: plan.note } } : {};
  return {
    schedule: {
      lead_ms: plan.leadMs,
      scheduled: plan.scheduled.size,
      ...(plan.immediate.length ? { on_arrival: plan.immediate } : {}),
      ...(plan.note ? { note: plan.note } : {}),
    },
  };
}
