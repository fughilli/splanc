//! POSIX TZ rules (D-562): the parser, the evaluator against tzdata vectors
//! (Python zoneinfo, 2027..2060, across every DST change, northern and
//! southern hemisphere, half- and quarter-hour zones, no-DST zones), and the
//! local -> UTC gap/overlap rules a schedule needs.

use ledmapper_clock::civil::US_PER_SEC;
use ledmapper_clock::local::to_local;
use ledmapper_clock::tz::{RuleDay, MAX_TZ_LEN};
use ledmapper_clock::{DateTime, LocalOffset, LocalResult, Phase, PosixTz, TzError};

const VECTORS: &str = include_str!("testdata/tz_vectors.txt");

fn tz(s: &str) -> PosixTz {
    PosixTz::parse(s).unwrap_or_else(|e| panic!("{s}: {e:?}"))
}

/// UTC µs of a UTC civil time.
fn utc(y: i64, mo: u8, d: u8, h: u8, mi: u8, s: u8) -> i64 {
    DateTime {
        year: y,
        month: mo,
        day: d,
        hour: h,
        minute: mi,
        second: s,
        micros: 0,
    }
    .to_unix_us()
    .unwrap()
}

/// Local wall time as µs "since the epoch" on the local clock.
fn local(y: i64, mo: u8, d: u8, h: u8, mi: u8) -> i64 {
    utc(y, mo, d, h, mi, 0)
}

#[test]
fn tzdata_vectors() {
    let mut zone: Option<(String, PosixTz)> = None;
    let (mut zones, mut checked) = (0, 0);
    for line in VECTORS.lines() {
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("Z ") {
            let (name, rule) = rest.split_once(' ').unwrap();
            zone = Some((name.to_string(), tz(rule)));
            zones += 1;
            continue;
        }
        let (name, z) = zone.as_ref().unwrap();
        let (t, off) = line.split_once(' ').unwrap();
        let t: i64 = t.parse().unwrap();
        let off: i32 = off.parse().unwrap();
        assert_eq!(
            z.utc_offset_s(t * US_PER_SEC),
            off,
            "{name} at unix {t} ({:?})",
            DateTime::from_unix_us(t * US_PER_SEC)
        );
        checked += 1;
    }
    assert!(zones >= 35, "{zones} zones");
    assert!(checked > 5_000, "{checked} samples");
}

#[test]
fn vectors_round_trip_local_to_utc() {
    // Every sample instant maps back from its local time, except the second
    // occurrence of an overlap hour (which resolves to the first).
    let mut zone: Option<PosixTz> = None;
    for line in VECTORS.lines() {
        if line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("Z ") {
            zone = Some(tz(rest.split_once(' ').unwrap().1));
            continue;
        }
        let z = zone.as_ref().unwrap();
        let t: i64 = line.split_once(' ').unwrap().0.parse().unwrap();
        let t_us = t * US_PER_SEC;
        let l = t_us + z.utc_offset_s(t_us) as i64 * US_PER_SEC;
        match z.resolve_local(l) {
            LocalResult::Unique(u) => assert_eq!(u, t_us, "{line}"),
            LocalResult::Ambiguous { earlier, later } => {
                assert!(earlier == t_us || later == t_us, "{line}");
                assert!(earlier < later);
            }
            LocalResult::Gap { .. } => {
                panic!("an instant's own local time is never in a gap: {line}")
            }
        }
    }
}

#[test]
fn parses_the_common_shapes() {
    let z = tz("CET-1CEST,M3.5.0,M10.5.0/3");
    assert_eq!((z.std_name(), z.std_offset_s()), ("CET", 3600));
    assert_eq!((z.dst_name(), z.dst_offset_s()), (Some("CEST"), Some(7200)));

    let z = tz("<+0545>-5:45");
    assert_eq!(
        (z.std_name(), z.std_offset_s(), z.has_dst()),
        ("+0545", 20_700, false)
    );

    let z = tz("NST3:30NDT,M3.2.0,M11.1.0");
    assert_eq!(z.std_offset_s(), -(3 * 3600 + 1800));
    assert_eq!(z.dst_offset_s(), Some(-(2 * 3600 + 1800)));

    // Explicit dst offset, a sign on the std offset, seconds.
    let z = tz("<+1030>-10:30<+11>-11,M10.1.0,M4.1.0");
    assert_eq!(z.dst_offset_s(), Some(11 * 3600));
    assert_eq!(tz("XXX+1:02:03").std_offset_s(), -3723);

    // A bare dst name gets the US rules and std + 1 h.
    let bare = tz("EST5EDT");
    let full = tz("EST5EDT,M3.2.0/2,M11.1.0/2");
    for y in [2027, 2031, 2050] {
        assert_eq!(bare.transitions_s(y), full.transitions_s(y));
    }
}

#[test]
fn refuses_malformed_rules() {
    use TzError::*;
    let cases: &[(&str, TzError)] = &[
        ("", Length),
        (
            "CET-1CEST,M3.5.0,M10.5.0/3,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,,",
            Length,
        ),
        ("ÄÄÄ-1", Length),
        ("UT0", Name),               // 2-letter name
        ("<+05-5", Name),            // unterminated
        ("<+0_5>-5", Name),          // bad char in a quoted name
        ("ABCDEFGHIJKLMNOP0", Name), // 16 letters
        ("CET", Offset),
        ("CET-24", Offset),
        ("CET-1:60", Offset),
        ("CET-1CEST,M3.5.0", Rule),
        ("CET-1CEST,M13.5.0,M10.5.0", Rule),
        ("CET-1CEST,M3.6.0,M10.5.0", Rule),
        ("CET-1CEST,M3.5.7,M10.5.0", Rule),
        ("CET-1CEST,J0,J365", Rule),
        ("CET-1CEST,366,0", Rule),
        ("CET-1CEST,M3.5.0/168,M10.5.0", Rule),
        ("CET-1CEST,M3.5.0,M10.5.0/3x", Trailing),
        (":Europe/Berlin", Name),
    ];
    for &(s, e) in cases {
        assert_eq!(PosixTz::parse(s), Err(e), "{s:?}");
    }
    assert!(MAX_TZ_LEN >= "<+1245>-12:45<+1345>,M9.5.0/2:45,M4.1.0/3:45".len());
}

#[test]
fn rule_days() {
    // J60 is always March 1; 59 (zero-based) is Feb 29 in a leap year.
    let mar1 = |y| ledmapper_clock::civil::days_from_civil(y, 3, 1);
    assert_eq!(RuleDay::Julian1(60).day_in_year(2028), mar1(2028));
    assert_eq!(RuleDay::Julian1(60).day_in_year(2027), mar1(2027));
    assert_eq!(RuleDay::Julian0(59).day_in_year(2028), mar1(2028) - 1);
    assert_eq!(RuleDay::Julian0(59).day_in_year(2027), mar1(2027));
    // M3.5.0 = last Sunday of March; M10.1.0 = first Sunday of October.
    let last_sun_mar = RuleDay::MonthWeekDay {
        month: 3,
        week: 5,
        weekday: 0,
    };
    let days = last_sun_mar.day_in_year(2027);
    let d = DateTime::from_unix_us(days * 86_400 * US_PER_SEC);
    assert_eq!((d.month, d.day), (3, 28));
    assert_eq!(d.weekday().days_from_sunday(), 0);
}

#[test]
fn berlin_spring_and_autumn_instants() {
    let z = tz("CET-1CEST,M3.5.0,M10.5.0/3");
    // 2027-03-28 01:00 UTC: 02:00 CET becomes 03:00 CEST.
    let spring = utc(2027, 3, 28, 1, 0, 0);
    assert_eq!(z.utc_offset_s(spring - 1), 3600);
    assert_eq!(z.utc_offset_s(spring), 7200);
    assert_eq!(z.name_at(spring - US_PER_SEC), "CET");
    assert_eq!(z.name_at(spring), "CEST");
    // 2027-10-31 01:00 UTC: 03:00 CEST becomes 02:00 CET.
    let autumn = utc(2027, 10, 31, 1, 0, 0);
    assert_eq!(z.utc_offset_s(autumn - 1), 7200);
    assert_eq!(z.utc_offset_s(autumn), 3600);
    assert_eq!(
        z.transitions_s(2027),
        Some((spring / US_PER_SEC, autumn / US_PER_SEC))
    );
    assert_eq!(
        z.next_change_us(utc(2027, 1, 1, 0, 0, 0)),
        Some((spring, 7200))
    );
    assert_eq!(z.next_change_us(spring), Some((autumn, 3600)));
    let lt = to_local(spring, &z);
    assert_eq!((lt.hour, lt.minute), (3, 0));
}

#[test]
fn sydney_dst_spans_the_new_year() {
    let z = tz("AEST-10AEDT,M10.1.0,M4.1.0/3");
    assert_eq!(
        z.phase_at_s(utc(2027, 1, 1, 0, 0, 0) / US_PER_SEC),
        Phase::Daylight
    );
    assert_eq!(
        z.phase_at_s(utc(2027, 6, 1, 0, 0, 0) / US_PER_SEC),
        Phase::Standard
    );
    assert_eq!(
        z.phase_at_s(utc(2027, 12, 31, 13, 59, 59) / US_PER_SEC),
        Phase::Daylight
    );
    // New Year's Eve in Sydney: 2027-12-31T13:00Z is 00:00 AEDT on Jan 1.
    let ny = to_local(utc(2027, 12, 31, 13, 0, 0), &z);
    assert_eq!((ny.year, ny.month, ny.day, ny.hour), (2028, 1, 1, 0));
    // DST ends 2027-04-04 03:00 AEDT = 2027-04-03 16:00 UTC.
    let end = utc(2027, 4, 3, 16, 0, 0);
    assert_eq!(z.utc_offset_s(end - 1), 11 * 3600);
    assert_eq!(z.utc_offset_s(end), 10 * 3600);
    // A whole-year "DST" (RFC 8536 example) never changes.
    let allyear = tz("EST5EDT,0/0,J365/25");
    for t in [
        utc(2027, 1, 1, 0, 0, 0),
        utc(2027, 7, 1, 0, 0, 0),
        utc(2027, 12, 31, 23, 59, 59),
    ] {
        assert_eq!(allyear.utc_offset_s(t), -4 * 3600);
    }
    assert_eq!(allyear.next_change_us(utc(2027, 6, 1, 0, 0, 0)), None);
}

#[test]
fn no_dst_zones_are_constant() {
    for (s, off) in [
        ("JST-9", 9 * 3600),
        ("<+0545>-5:45", 20_700),
        ("<-0930>9:30", -34_200),
        ("UTC0", 0),
    ] {
        let z = tz(s);
        for t in [
            utc(2027, 1, 15, 0, 0, 0),
            utc(2027, 7, 15, 0, 0, 0),
            utc(2059, 3, 30, 12, 0, 0),
        ] {
            assert_eq!(z.utc_offset_s(t), off, "{s}");
        }
        assert_eq!(z.next_change_us(utc(2027, 1, 1, 0, 0, 0)), None);
        assert_eq!(z.transitions_s(2027), None);
    }
    assert_eq!(PosixTz::UTC, tz("UTC0"));
}

#[test]
fn local_gap_maps_to_the_first_instant_after_it() {
    let berlin = tz("CET-1CEST,M3.5.0,M10.5.0/3");
    // 02:30 on 2027-03-28 never happens in Berlin: it runs 01:59:59 -> 03:00.
    let spring = utc(2027, 3, 28, 1, 0, 0);
    assert_eq!(
        berlin.resolve_local(local(2027, 3, 28, 2, 30)),
        LocalResult::Gap { after_us: spring }
    );
    assert_eq!(berlin.local_to_utc_us(local(2027, 3, 28, 2, 0)), spring);
    assert_eq!(berlin.local_to_utc_us(local(2027, 3, 28, 3, 0)), spring);
    assert_eq!(
        berlin.local_to_utc_us(local(2027, 3, 28, 1, 59)),
        spring - 60 * US_PER_SEC
    );

    // Southern hemisphere: Sydney springs forward 2027-10-03 02:00 -> 03:00.
    let syd = tz("AEST-10AEDT,M10.1.0,M4.1.0/3");
    let syd_spring = utc(2027, 10, 2, 16, 0, 0);
    assert_eq!(
        syd.resolve_local(local(2027, 10, 3, 2, 15)),
        LocalResult::Gap {
            after_us: syd_spring
        }
    );

    // Lord Howe's half-hour DST: 02:00 -> 02:30.
    let lh = tz("<+1030>-10:30<+11>-11,M10.1.0,M4.1.0");
    assert!(matches!(
        lh.resolve_local(local(2027, 10, 3, 2, 10)),
        LocalResult::Gap { .. }
    ));
    assert!(matches!(
        lh.resolve_local(local(2027, 10, 3, 2, 30)),
        LocalResult::Unique(_)
    ));
}

#[test]
fn local_overlap_maps_to_the_first_occurrence() {
    let ny = tz("EST5EDT,M3.2.0,M11.1.0");
    // 01:30 on 2027-11-07 happens twice in New York: EDT, then EST.
    let first = utc(2027, 11, 7, 5, 30, 0);
    let second = utc(2027, 11, 7, 6, 30, 0);
    assert_eq!(
        ny.resolve_local(local(2027, 11, 7, 1, 30)),
        LocalResult::Ambiguous {
            earlier: first,
            later: second
        }
    );
    assert_eq!(ny.local_to_utc_us(local(2027, 11, 7, 1, 30)), first);
    // Just outside the overlap is unique.
    assert_eq!(
        ny.resolve_local(local(2027, 11, 7, 2, 0)),
        LocalResult::Unique(utc(2027, 11, 7, 7, 0, 0))
    );

    // Auckland falls back in April (southern autumn): 02:30 twice.
    let akl = tz("NZST-12NZDT,M9.5.0,M4.1.0/3");
    assert!(matches!(
        akl.resolve_local(local(2027, 4, 4, 2, 30)),
        LocalResult::Ambiguous { .. }
    ));
}
