/** The phone's zone as a POSIX TZ rule (D-562), derived from Intl, and the
 * POSIX evaluator that mirrors firmware/clock/src/tz.rs. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  intlOffsetS,
  parsePosixTz,
  phonePosixTz,
  posixNameAt,
  posixOffsetS,
  posixTzFromIntl,
  verifyAgainstIntl,
} from "../src/net/posixTz";

const NOW = Date.UTC(2026, 10, 25);

/** tzdata 2026 footers (the rules tzdata itself uses past its tables). */
const FOOTERS: Record<string, string> = {
  "Europe/Berlin": "CET-1CEST,M3.5.0,M10.5.0/3",
  "Europe/London": "GMT0BST,M3.5.0/1,M10.5.0",
  "America/New_York": "EST5EDT,M3.2.0,M11.1.0",
  "America/Los_Angeles": "PST8PDT,M3.2.0,M11.1.0",
  "America/St_Johns": "NST3:30NDT,M3.2.0,M11.1.0",
  "America/Nuuk": "<-02>2<-01>,M3.5.0/-1,M10.5.0/0",
  "Asia/Jerusalem": "IST-2IDT,M3.4.4/26,M10.5.0",
  "Africa/Cairo": "EET-2EEST,M4.5.5/0,M10.5.4/24",
  "Australia/Sydney": "AEST-10AEDT,M10.1.0,M4.1.0/3",
  "Australia/Adelaide": "ACST-9:30ACDT,M10.1.0,M4.1.0/3",
  "Australia/Lord_Howe": "<+1030>-10:30<+11>-11,M10.1.0,M4.1.0",
  "Pacific/Auckland": "NZST-12NZDT,M9.5.0,M4.1.0/3",
  "Pacific/Chatham": "<+1245>-12:45<+1345>,M9.5.0/2:45,M4.1.0/3:45",
  "America/Santiago": "<-04>4<-03>,M9.1.6/24,M4.1.6/24",
  "Asia/Tokyo": "JST-9",
  "Asia/Kolkata": "IST-5:30",
  "Asia/Kathmandu": "<+0545>-5:45",
  "America/Phoenix": "MST7",
  "Pacific/Marquesas": "<-0930>9:30",
  UTC: "UTC0",
};

/** Strip the names: two rules are the same zone when the rest matches. */
function shape(tz: string): string {
  return tz.replace(/<[^>]*>|[A-Za-z]{3,}/g, "N");
}

test("derived rules equal tzdata's footers (modulo abbreviations)", () => {
  for (const [zone, footer] of Object.entries(FOOTERS)) {
    const r = posixTzFromIntl(zone, NOW);
    assert.equal(r.exact, true, zone);
    assert.equal(shape(r.tz), shape(footer), `${zone}: ${r.tz} vs ${footer}`);
    assert.ok(parsePosixTz(r.tz), r.tz);
  }
  // Where Intl has the usual abbreviations, they are kept.
  assert.equal(posixTzFromIntl("Europe/Berlin", NOW).tz, FOOTERS["Europe/Berlin"]);
  assert.equal(posixTzFromIntl("America/New_York", NOW).tz, FOOTERS["America/New_York"]);
});

test("every zone Intl knows derives a rule that matches Intl for ten years", () => {
  const zones = Intl.supportedValuesOf("timeZone");
  assert.ok(zones.length > 300);
  const inexact: string[] = [];
  for (const zone of zones) {
    const r = posixTzFromIntl(zone, NOW);
    assert.ok(r.tz.length <= 64, `${zone}: ${r.tz}`);
    assert.ok(parsePosixTz(r.tz), `${zone}: ${r.tz}`);
    if (!r.exact) inexact.push(zone);
  }
  // Only zones whose changes follow no POSIX rule (Morocco's Ramadan, in
  // engines whose tzdata still has it) may fall back to a fixed offset.
  for (const z of inexact) assert.match(z, /^Africa\/(Casablanca|El_Aaiun)$/, z);
});

test("the evaluator matches Intl at DST changes, both hemispheres", () => {
  const cases: [string, number, number][] = [
    // zone, UTC instant of a change, offset after it
    ["Europe/Berlin", Date.UTC(2027, 2, 28, 1), 7200],
    ["Europe/Berlin", Date.UTC(2027, 9, 31, 1), 3600],
    ["Australia/Sydney", Date.UTC(2027, 3, 3, 16), 36_000],
    ["Australia/Sydney", Date.UTC(2027, 9, 2, 16), 39_600],
    ["America/New_York", Date.UTC(2027, 2, 14, 7), -4 * 3600],
  ];
  for (const [zone, t, after] of cases) {
    const z = parsePosixTz(FOOTERS[zone] ?? "")!;
    assert.equal(posixOffsetS(z, t), after, zone);
    assert.notEqual(posixOffsetS(z, t - 1000), after, zone);
    assert.equal(intlOffsetS(zone, t), after, zone);
    assert.equal(intlOffsetS(zone, t - 1000), posixOffsetS(z, t - 1000), zone);
  }
  const berlin = parsePosixTz("CET-1CEST,M3.5.0,M10.5.0/3")!;
  assert.equal(posixNameAt(berlin, Date.UTC(2027, 6, 1)), "CEST");
  assert.equal(posixNameAt(berlin, Date.UTC(2027, 0, 1)), "CET");
});

test("the parser accepts and refuses what the firmware does", () => {
  for (const ok of ["UTC0", "<+0545>-5:45", "EST5EDT", "EST5EDT,0/0,J365/25", "XXX+1:02:03"]) {
    assert.ok(parsePosixTz(ok), ok);
  }
  for (const bad of [
    "",
    "UT0",
    "<+05-5",
    "CET",
    "CET-24",
    "CET-1CEST,M3.5.0",
    "CET-1CEST,M13.5.0,M10.5.0",
    "CET-1CEST,J0,J365",
    "CET-1CEST,M3.5.0/168,M10.5.0",
    "CET-1CEST,M3.5.0,M10.5.0/3x",
    ":Europe/Berlin",
    "x".repeat(65),
  ]) {
    assert.equal(parsePosixTz(bad), null, bad);
  }
  const bare = parsePosixTz("EST5EDT")!;
  assert.equal(bare.dst?.offsetS, -4 * 3600);
  assert.equal(posixOffsetS(bare, Date.UTC(2027, 6, 1)), -4 * 3600);
});

test("verifyAgainstIntl catches a wrong rule", () => {
  const from = NOW / 1000;
  const to = Date.UTC(2030, 0, 1) / 1000;
  assert.ok(verifyAgainstIntl("Europe/Berlin", "CET-1CEST,M3.5.0,M10.5.0/3", from, to));
  // US dates for a European zone are wrong for a few weeks a year.
  assert.ok(!verifyAgainstIntl("Europe/Berlin", "CET-1CEST,M3.2.0,M11.1.0", from, to));
});

test("phonePosixTz answers for the process zone and caches", () => {
  const a = phonePosixTz(NOW);
  assert.ok(parsePosixTz(a.tz), a.tz);
  assert.equal(phonePosixTz(NOW), a);
});
