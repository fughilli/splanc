/**
 * The phone's time zone as a POSIX TZ rule (D-562: the lamp stores one, e.g.
 * "CET-1CEST,M3.5.0,M10.5.0/3", so DST stays right while it is offline).
 *
 * The rule is DERIVED from the phone's own zone data through `Intl`, not looked
 * up in a bundled IANA→POSIX table:
 *
 * - **It always matches the phone's clock.** Both read the same OS/browser
 *   tzdata, so the lamp shows the time the phone shows. A bundled table is a
 *   second copy of tzdata that is right only as of the app's last build: a
 *   zone law change (tzdata ships several a year) would be wrong on the lamp
 *   until the app is rebuilt AND the user reloads, while the phone's OS update
 *   fixes the derived rule on the next connect.
 * - **Every zone the phone can be in works**, including aliases and renamed
 *   zones (Europe/Kiev vs Europe/Kyiv), with no 15 KB table in the bundle.
 * - **It verifies itself.** The derived rule is evaluated (the same algorithm
 *   as the firmware's `firmware/clock/src/tz.rs`) against `Intl` at every
 *   offset change ±1 s and twice a month over the next ten years. A zone whose
 *   changes don't follow a POSIX rule fails that check and falls back to its
 *   current fixed offset, marked `exact: false` (tzdata's own footer does no
 *   better for those).
 *
 * The derivation costs a few hundred `Intl` calls (well under 100 ms on a phone)
 * and is cached per zone and year.
 *
 * Also here: a small evaluator of POSIX rules (parse + UTC offset at an
 * instant) so the device sheet can show the lamp's local time exactly as the
 * lamp computes it.
 */

/** A POSIX TZ string's offset rule: hours WEST of UTC, so UTC+1 is "-1". */
export interface PosixRuleDay {
  kind: "J" | "n" | "M";
  /** J: 1..365 (Feb 29 never counted); n: 0..365; M: month 1..12. */
  a: number;
  /** M only: week 1..5 (5 = last). */
  w: number;
  /** M only: weekday 0..6 (0 = Sunday). */
  d: number;
  /** Local time of the change, seconds (may be negative or past 24 h). */
  timeS: number;
}

export interface ParsedPosixTz {
  stdName: string;
  /** Seconds EAST of UTC. */
  stdOffsetS: number;
  dst?: { name: string; offsetS: number; start: PosixRuleDay; end: PosixRuleDay };
}

export interface PhoneTz {
  /** The POSIX rule to send to the lamp (≤ 64 bytes). */
  tz: string;
  /** The IANA zone it came from (for display). */
  zone: string;
  /** False when the zone's changes don't follow a POSIX rule: `tz` is then only
   * the current fixed offset (right until the zone's next change). */
  exact: boolean;
}

const DAY_S = 86_400;
/** The protocol's default string cap (micropb), = MAX_TZ_LEN in tz.rs. */
export const MAX_TZ_LEN = 64;
/** Years of `Intl` data the derivation fits and checks. */
const HORIZON_YEARS = 10;

// ---- civil time (Hinnant), on day numbers since 1970-01-01 -----------------

export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

function yearOfDays(days: number): number {
  return new Date(days * DAY_S * 1000).getUTCFullYear();
}

function isLeap(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Days since 1970-01-01 of a rule's day in `year`. */
export function ruleDay(r: PosixRuleDay, year: number): number {
  const jan1 = daysFromCivil(year, 1, 1);
  if (r.kind === "J") return jan1 + r.a - 1 + (isLeap(year) && r.a >= 60 ? 1 : 0);
  if (r.kind === "n") return jan1 + r.a;
  const first = daysFromCivil(year, r.a, 1);
  const firstWd = (((first + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday (4)
  let day = first + ((r.d - firstWd + 7) % 7) + (r.w - 1) * 7;
  const len = daysInMonth(year, r.a);
  while (day >= first + len) day -= 7;
  return day;
}

// ---- parse + evaluate (mirrors firmware/clock/src/tz.rs) --------------------

class Cur {
  i = 0;
  readonly s: string;
  constructor(s: string) {
    this.s = s;
  }
  peek(): string {
    return this.s.charAt(this.i);
  }
  eat(c: string): boolean {
    if (this.s.charAt(this.i) === c) {
      this.i++;
      return true;
    }
    return false;
  }
  num(max: number): number | null {
    const m = /^\d+/.exec(this.s.slice(this.i));
    if (!m || m[0].length > max) return null;
    this.i += m[0].length;
    return Number(m[0]);
  }
  name(): string | null {
    const q = this.eat("<");
    const m = (q ? /^[A-Za-z0-9+-]*/ : /^[A-Za-z]*/).exec(this.s.slice(this.i));
    const n = m ? m[0] : "";
    this.i += n.length;
    if (q && !this.eat(">")) return null;
    return n.length >= 3 && n.length <= 15 ? n : null;
  }
  hms(maxH: number): number | null {
    const neg = this.eat("-");
    if (!neg) this.eat("+");
    const h = this.num(3);
    if (h === null || h > maxH) return null;
    let s = h * 3600;
    if (this.eat(":")) {
      const m = this.num(2);
      if (m === null || m > 59) return null;
      s += m * 60;
      if (this.eat(":")) {
        const x = this.num(2);
        if (x === null || x > 59) return null;
        s += x;
      }
    }
    return neg ? -s : s;
  }
  rule(): PosixRuleDay | null {
    let r: PosixRuleDay;
    if (this.eat("J")) {
      const n = this.num(3);
      if (n === null || n < 1 || n > 365) return null;
      r = { kind: "J", a: n, w: 0, d: 0, timeS: 7200 };
    } else if (this.eat("M")) {
      const m = this.num(2);
      if (m === null || !this.eat(".")) return null;
      const w = this.num(1);
      if (w === null || !this.eat(".")) return null;
      const d = this.num(1);
      if (d === null || m < 1 || m > 12 || w < 1 || w > 5 || d > 6) return null;
      r = { kind: "M", a: m, w, d, timeS: 7200 };
    } else {
      const n = this.num(3);
      if (n === null || n > 365) return null;
      r = { kind: "n", a: n, w: 0, d: 0, timeS: 7200 };
    }
    if (this.eat("/")) {
      const t = this.hms(167);
      if (t === null) return null;
      r.timeS = t;
    }
    return r;
  }
}

/** Parses a POSIX TZ rule; null if malformed (same acceptance as the firmware). */
export function parsePosixTz(s: string): ParsedPosixTz | null {
  // eslint-disable-next-line no-control-regex
  if (!s || s.length > MAX_TZ_LEN || !/^[\x00-\x7f]*$/.test(s)) return null;
  const c = new Cur(s);
  const stdName = c.name();
  if (stdName === null) return null;
  const west = c.hms(24);
  if (west === null || Math.abs(west) >= DAY_S) return null;
  const stdOffsetS = -west;
  if (c.i >= s.length) return { stdName, stdOffsetS };
  const dstName = c.name();
  if (dstName === null) return null;
  let offsetS = stdOffsetS + 3600;
  if (/[+\-0-9]/.test(c.peek())) {
    const w = c.hms(24);
    if (w === null || Math.abs(w) >= DAY_S) return null;
    offsetS = -w;
  }
  let start: PosixRuleDay = { kind: "M", a: 3, w: 2, d: 0, timeS: 7200 };
  let end: PosixRuleDay = { kind: "M", a: 11, w: 1, d: 0, timeS: 7200 };
  if (c.eat(",")) {
    const s1 = c.rule();
    if (s1 === null || !c.eat(",")) return null;
    const e1 = c.rule();
    if (e1 === null) return null;
    start = s1;
    end = e1;
  }
  if (c.i !== s.length) return null;
  return { stdName, stdOffsetS, dst: { name: dstName, offsetS, start, end } };
}

/** The UTC offset (seconds east) a parsed rule gives at a UTC instant (ms). */
export function posixOffsetS(z: ParsedPosixTz, utcMs: number): number {
  const d = z.dst;
  if (!d) return z.stdOffsetS;
  const t = Math.floor(utcMs / 1000);
  const year = yearOfDays(Math.floor((t + z.stdOffsetS) / DAY_S));
  const start = ruleDay(d.start, year) * DAY_S + d.start.timeS - z.stdOffsetS;
  const end = ruleDay(d.end, year) * DAY_S + d.end.timeS - d.offsetS;
  const inDst = start < end ? t >= start && t < end : !(t >= end && t < start);
  return inDst ? d.offsetS : z.stdOffsetS;
}

/** The zone abbreviation a parsed rule gives at a UTC instant (ms). */
export function posixNameAt(z: ParsedPosixTz, utcMs: number): string {
  return z.dst && posixOffsetS(z, utcMs) === z.dst.offsetS && z.dst.offsetS !== z.stdOffsetS
    ? z.dst.name
    : z.stdName;
}

// ---- derivation from Intl ----------------------------------------------------

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    fmtCache.set(zone, f);
  }
  return f;
}

/** `zone`'s UTC offset (seconds east) at a UTC instant (ms), per `Intl`. */
export function intlOffsetS(zone: string, utcMs: number): number {
  const t = Math.floor(utcMs / 1000) * 1000;
  const p: Record<string, number> = {};
  for (const part of partsFormatter(zone).formatToParts(t)) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const local = Date.UTC(p.year ?? 1970, (p.month ?? 1) - 1, p.day ?? 1, (p.hour ?? 0) % 24, p.minute ?? 0, p.second ?? 0);
  return Math.round((local - t) / 1000);
}

/** Offset changes of `zone` in [fromS, toS) (UTC seconds), to the second. */
function intlChanges(zone: string, fromS: number, toS: number): { t: number; before: number; after: number }[] {
  const out: { t: number; before: number; after: number }[] = [];
  const step = 14 * DAY_S; // no real POSIX-rule zone changes twice in two weeks
  let a = fromS;
  let oa = intlOffsetS(zone, a * 1000);
  while (a < toS) {
    const b = Math.min(a + step, toS);
    const ob = intlOffsetS(zone, b * 1000);
    if (ob !== oa) {
      let lo = a;
      let hi = b;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (intlOffsetS(zone, mid * 1000) === oa) lo = mid;
        else hi = mid;
      }
      out.push({ t: hi, before: oa, after: intlOffsetS(zone, hi * 1000) });
    }
    a = b;
    oa = ob;
  }
  return out;
}

/** POSIX `[+-]hh[:mm[:ss]]` of `s` seconds. */
function hmsText(s: number): string {
  const sign = s < 0 ? "-" : "";
  const a = Math.abs(s);
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  const x = a % 60;
  return sign + String(h) + (m || x ? ":" + String(m).padStart(2, "0") : "") + (x ? ":" + String(x).padStart(2, "0") : "");
}

/** The POSIX offset text (hours WEST) for an offset in seconds EAST. */
function offsetText(eastS: number): string {
  return hmsText(-eastS);
}

/** A numeric abbreviation in tzdata's style: "<+0530>", "<-03>". */
function numericName(eastS: number): string {
  const sign = eastS < 0 ? "-" : "+";
  const a = Math.abs(eastS);
  const h = String(Math.floor(a / 3600)).padStart(2, "0");
  const m = Math.floor((a % 3600) / 60);
  return `<${sign}${h}${m ? String(m).padStart(2, "0") : ""}>`;
}

/** The zone's alphabetic abbreviation at an instant if `Intl` knows one (EST,
 * CEST), else tzdata's numeric style. */
function zoneName(zone: string, utcMs: number, eastS: number): string {
  for (const locale of ["en-US", "en-GB"]) {
    try {
      const p = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" })
        .formatToParts(utcMs)
        .find((x) => x.type === "timeZoneName");
      const v = p?.value ?? "";
      if (v === "UTC" || v === "GMT") {
        if (eastS === 0) return v;
        continue;
      }
      if (/^[A-Za-z]{3,6}$/.test(v)) return v;
    } catch {
      /* an engine without short names: numeric */
    }
  }
  return numericName(eastS);
}

function ruleText(r: PosixRuleDay): string {
  const day = r.kind === "M" ? `M${r.a}.${r.w}.${r.d}` : r.kind === "J" ? `J${r.a}` : String(r.a);
  return r.timeS === 7200 ? day : `${day}/${hmsText(r.timeS)}`;
}

/** The Mm.w.d rule (with a time) that reproduces these changes' local times,
 * one per year, or null. `localS[i]` is change i's local time on the offset in
 * force before it. */
function fitRule(years: number[], localS: number[]): PosixRuleDay | null {
  let best: PosixRuleDay | null = null;
  for (let m = 1; m <= 12; m++) {
    for (let w = 1; w <= 5; w++) {
      for (let d = 0; d <= 6; d++) {
        const r: PosixRuleDay = { kind: "M", a: m, w, d, timeS: 0 };
        let time: number | null = null;
        let ok = true;
        for (let i = 0; i < years.length && ok; i++) {
          const ls = localS[i];
          const y = years[i];
          if (ls === undefined || y === undefined) {
            ok = false;
            break;
          }
          const t = ls - ruleDay(r, y) * DAY_S;
          if (time === null) time = t;
          else if (t !== time) ok = false;
        }
        if (!ok || time === null || Math.abs(time) > 167 * 3600 + 3599) continue;
        r.timeS = time;
        // Prefer the rule whose time is nearest the actual day (tzdata's style).
        const score = (x: number) => (x >= 0 && x < DAY_S ? 0 : 1) * 1e9 + Math.abs(x);
        if (!best || score(time) < score(best.timeS)) best = r;
      }
    }
  }
  return best;
}

/** Checks `tz` against `Intl` over [fromS, toS): at every change ±1 s and every
 * 14 days. */
export function verifyAgainstIntl(zone: string, tz: string, fromS: number, toS: number): boolean {
  const z = parsePosixTz(tz);
  if (!z) return false;
  const pts: number[] = [];
  for (let t = fromS; t < toS; t += 14 * DAY_S) pts.push(t);
  for (const c of intlChanges(zone, fromS, toS)) pts.push(c.t - 1, c.t);
  return pts.every((t) => posixOffsetS(z, t * 1000) === intlOffsetS(zone, t * 1000));
}

/** A fixed-offset rule for `eastS`. */
function fixedRule(zone: string, utcMs: number, eastS: number): string {
  return zoneName(zone, utcMs, eastS) + offsetText(eastS);
}

/**
 * Derives the POSIX rule for an IANA zone from `Intl`, valid from `nowMs` on.
 * Throws a RangeError for a zone `Intl` doesn't know.
 */
export function posixTzFromIntl(zone: string, nowMs: number = Date.now()): PhoneTz {
  const nowS = Math.floor(nowMs / 1000);
  const y0 = new Date(nowMs).getUTCFullYear();
  // Fit on whole years from this one; the check runs from now (a law change
  // inside the horizon fails it: then only the current offset is sent).
  const fromS = Date.UTC(y0, 0, 1) / 1000;
  const toS = Date.UTC(y0 + HORIZON_YEARS, 0, 1) / 1000;
  const changes = intlChanges(zone, fromS, toS);
  const curOff = intlOffsetS(zone, nowMs);
  if (changes.length === 0) {
    const tz = fixedRule(zone, nowMs, curOff);
    return { tz, zone, exact: verifyAgainstIntl(zone, tz, nowS, toS) };
  }
  const offs = new Set<number>();
  for (const c of changes) offs.add(c.before).add(c.after);
  const fallback = (): PhoneTz => ({ tz: fixedRule(zone, nowMs, curOff), zone, exact: false });
  if (offs.size !== 2) return fallback();
  const stdOff = Math.min(...offs);
  const dstOff = Math.max(...offs);
  const starts = changes.filter((c) => c.after === dstOff);
  const ends = changes.filter((c) => c.after === stdOff);
  const fit = (cs: typeof changes) =>
    fitRule(
      cs.map((c) => yearOfDays(Math.floor((c.t + stdOff) / DAY_S))),
      cs.map((c) => c.t + c.before),
    );
  // One change each way per year, or the rule can't express it.
  if (starts.length !== HORIZON_YEARS || ends.length !== HORIZON_YEARS) return fallback();
  const start = fit(starts);
  const end = fit(ends);
  if (!start || !end) return fallback();
  // Each name as shown just after the change into it.
  const after = (c: { t: number } | undefined) => (c ? c.t * 1000 + 1000 : nowMs);
  const stdName = zoneName(zone, after(ends[0]), stdOff);
  let dstName = zoneName(zone, after(starts[0]), dstOff);
  if (dstName === stdName) dstName = numericName(dstOff);
  const dstPart = dstOff === stdOff + 3600 ? dstName : dstName + offsetText(dstOff);
  const tz = `${stdName}${offsetText(stdOff)}${dstPart},${ruleText(start)},${ruleText(end)}`;
  if (tz.length > MAX_TZ_LEN || !verifyAgainstIntl(zone, tz, nowS, toS)) return fallback();
  return { tz, zone, exact: true };
}

const phoneCache = new Map<string, PhoneTz>();

/** The phone's own zone as a POSIX rule (cached per zone and UTC year). */
export function phonePosixTz(nowMs: number = Date.now()): PhoneTz {
  let zone = "UTC";
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    /* no Intl: UTC */
  }
  const key = `${zone}|${new Date(nowMs).getUTCFullYear()}`;
  const hit = phoneCache.get(key);
  if (hit) return hit;
  let r: PhoneTz;
  try {
    r = posixTzFromIntl(zone, nowMs);
  } catch {
    r = { tz: "UTC0", zone: "UTC", exact: false };
  }
  phoneCache.set(key, r);
  return r;
}
