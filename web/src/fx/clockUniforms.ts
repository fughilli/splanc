/**
 * The wall-clock uniforms (docs/design/wall-clock.md, firmware
 * uniform_pool.rs CLOCK_ENTRIES) for the in-browser preview. On a lamp the
 * firmware writes these every frame, BY NAME, from its own clock in its own
 * zone; in the editor the preview feeds them from the phone's clock, or from
 * the "Preview time" scrubber so a sunrise effect can be checked at 06:30
 * without waiting for it.
 *
 * Same values as the firmware: `clock` = (hour, minute, second.frac, weekday
 * with Sunday = 0), `clock_day` = local seconds since midnight / 86400,
 * `clock_date` = (year, month 1-12, day), `clock_valid` = 1.
 */

/** Pool entry name -> width (as the firmware's CLOCK_ENTRIES). */
export const CLOCK_ENTRIES: ReadonlyMap<string, number> = new Map([
  ["clock", 4],
  ["clock_day", 1],
  ["clock_date", 3],
  ["clock_valid", 1],
]);

interface NamedSlot {
  name: string;
  slot: number;
  width: number;
}

/** The manifest uniforms the clock drives (by exact name). */
export function clockBindings<U extends NamedSlot>(uniforms: readonly U[]): U[] {
  return uniforms.filter((u) => CLOCK_ENTRIES.has(u.name));
}

/** The four values at local time `d` (the browser's zone, i.e. the phone's). */
export function clockValues(d: Date): Record<string, number[]> {
  const sec = d.getSeconds() + d.getMilliseconds() / 1000;
  const sod = d.getHours() * 3600 + d.getMinutes() * 60 + sec;
  return {
    clock: [d.getHours(), d.getMinutes(), sec, d.getDay()],
    clock_day: [sod / 86400],
    clock_date: [d.getFullYear(), d.getMonth() + 1, d.getDate()],
    clock_valid: [1],
  };
}

/** Writes the clock values at `d` into every bound slot (the firmware writes
 * min(declared width, entry width) components). */
export function applyClockUniforms(
  bound: readonly NamedSlot[],
  d: Date,
  set: (slot: number, vals: number[]) => void,
): void {
  if (bound.length === 0) return;
  const v = clockValues(d);
  for (const u of bound) {
    const vals = v[u.name];
    if (vals === undefined) continue;
    set(u.slot, vals.slice(0, Math.min(u.width, vals.length)));
  }
}

/**
 * The preview's time: the phone's clock, or a picked minute of the day that
 * then runs on in real time from when it was picked (so `clock.z` seconds and
 * `clock_day` still move while you watch).
 */
export class PreviewTime {
  private pickedMin: number | null = null;
  private pickedAt = 0;

  /** Pin the preview to `minuteOfDay` (0..1439) of today, at wall time `nowMs`. */
  pick(minuteOfDay: number, nowMs: number): void {
    this.pickedMin = Math.max(0, Math.min(1439, Math.round(minuteOfDay)));
    this.pickedAt = nowMs;
  }

  /** Back to the phone's clock. */
  follow(): void {
    this.pickedMin = null;
  }

  get following(): boolean {
    return this.pickedMin === null;
  }

  /** The time the preview shows at wall time `nowMs`. */
  at(nowMs: number): Date {
    const now = new Date(nowMs);
    if (this.pickedMin === null) return now;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, this.pickedMin, 0, 0);
    return new Date(d.getTime() + (nowMs - this.pickedAt));
  }
}

/** "06:30" for a minute of the day. */
export function formatMinute(minuteOfDay: number): string {
  const m = ((Math.round(minuteOfDay) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
