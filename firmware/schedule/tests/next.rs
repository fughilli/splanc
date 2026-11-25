//! Next / previous fire in a real zone: DST gaps and overlaps, weekday masks,
//! the year boundary, sun rules.

use ledmapper_clock::civil::DateTime;
use ledmapper_clock::local::to_local;
use ledmapper_clock::PosixTz;
use ledmapper_schedule::{next_fire, prev_fire, Location, When, WhenKind};

fn utc(y: i64, mo: u8, d: u8, h: u8, mi: u8) -> i64 {
    let dt = DateTime {
        year: y,
        month: mo,
        day: d,
        hour: h,
        minute: mi,
        second: 0,
        micros: 0,
    };
    dt.to_unix_us().unwrap() / 1_000_000
}

fn local_hm(s: i64, z: &PosixTz) -> (i64, u8, u8, u8, u8) {
    let l = to_local(s * 1_000_000, z);
    (l.year, l.month, l.day, l.hour, l.minute)
}

fn cet() -> PosixTz {
    PosixTz::parse("CET-1CEST,M3.5.0,M10.5.0/3").unwrap()
}

#[test]
fn daily_local_time() {
    let z = cet();
    let w = When::local(7 * 60, 0);
    // 2026-11-25 05:00Z = 06:00 CET -> today 07:00 CET = 06:00Z.
    assert_eq!(
        next_fire(&w, utc(2026, 11, 25, 5, 0), &z, None),
        Some(utc(2026, 11, 25, 6, 0))
    );
    // Exactly at the fire: strictly after -> tomorrow.
    assert_eq!(
        next_fire(&w, utc(2026, 11, 25, 6, 0), &z, None),
        Some(utc(2026, 11, 26, 6, 0))
    );
    assert_eq!(
        prev_fire(&w, utc(2026, 11, 25, 6, 0), &z, None),
        Some(utc(2026, 11, 25, 6, 0))
    );
    assert_eq!(
        prev_fire(&w, utc(2026, 11, 25, 5, 59), &z, None),
        Some(utc(2026, 11, 24, 6, 0))
    );
    // Summer: 07:00 CEST = 05:00Z.
    assert_eq!(
        next_fire(&w, utc(2026, 7, 1, 0, 0), &z, None),
        Some(utc(2026, 7, 1, 5, 0))
    );
    // Across the year boundary.
    let late = When::local(23 * 60 + 30, 0);
    assert_eq!(
        local_hm(
            next_fire(&late, utc(2026, 12, 31, 23, 0), &z, None).unwrap(),
            &z
        ),
        (2027, 1, 1, 23, 30)
    );
}

#[test]
fn dst_gap_and_overlap() {
    let z = cet();
    // 2027-03-28: 02:00 CET jumps to 03:00 CEST. A 02:30 rule fires at 03:00 CEST (01:00Z).
    let w = When::local(2 * 60 + 30, 0);
    let t = next_fire(&w, utc(2027, 3, 27, 12, 0), &z, None).unwrap();
    assert_eq!(t, utc(2027, 3, 28, 1, 0));
    assert_eq!(local_hm(t, &z), (2027, 3, 28, 3, 0));
    // ...and normally the next day.
    assert_eq!(
        local_hm(next_fire(&w, t, &z, None).unwrap(), &z),
        (2027, 3, 29, 2, 30)
    );
    // 2026-10-25: 03:00 CEST falls back to 02:00 CET; 02:30 happens twice. Fires once,
    // at the first (00:30Z), and the next is the following day.
    let t = next_fire(&w, utc(2026, 10, 24, 12, 0), &z, None).unwrap();
    assert_eq!(t, utc(2026, 10, 25, 0, 30));
    let n = next_fire(&w, t, &z, None).unwrap();
    assert_eq!(n, utc(2026, 10, 26, 1, 30));
}

#[test]
fn weekday_masks_use_the_local_date() {
    let z = PosixTz::parse("EST5EDT,M3.2.0,M11.1.0").unwrap();
    // Mon-Fri at 23:30 local: 04:30Z the next UTC day.
    let w = When::local(23 * 60 + 30, 0b0111110);
    // 2026-11-27 is a Friday. After Fri 23:30 EST the next is Mon 2026-11-30.
    let fri = next_fire(&w, utc(2026, 11, 27, 12, 0), &z, None).unwrap();
    assert_eq!(local_hm(fri, &z), (2026, 11, 27, 23, 30));
    assert_eq!(
        local_hm(next_fire(&w, fri, &z, None).unwrap(), &z),
        (2026, 11, 30, 23, 30)
    );
    // Saturday only.
    let sat = When::local(9 * 60, 1 << 6);
    assert_eq!(
        local_hm(
            next_fire(&sat, utc(2026, 11, 25, 0, 0), &z, None).unwrap(),
            &z
        ),
        (2026, 11, 28, 9, 0)
    );
    assert_eq!(
        local_hm(
            prev_fire(&sat, utc(2026, 11, 25, 0, 0), &z, None).unwrap(),
            &z
        ),
        (2026, 11, 21, 9, 0)
    );
}

#[test]
fn sun_rules() {
    let z = PosixTz::parse("GMT0BST,M3.5.0/1,M10.5.0").unwrap();
    let london = Location::new(515_000, -1_000);
    let set = When {
        kind: WhenKind::Sunset,
        minute_of_day: 0,
        offset_min: -30,
        days_mask: 0,
    };
    // Midsummer: sunset ~21:21 BST -> 30 min before ~20:51 BST.
    let t = next_fire(&set, utc(2026, 6, 21, 12, 0), &z, london).unwrap();
    let (_, _, d, h, m) = local_hm(t, &z);
    assert_eq!((d, h), (21, 20));
    assert!((49..=54).contains(&m), "{m}");
    // No location: a sun rule never fires.
    assert_eq!(next_fire(&set, utc(2026, 6, 21, 12, 0), &z, None), None);
    // Polar night: Tromso sunrise rules skip to the first day with a sunrise.
    let tz = PosixTz::parse("CET-1CEST,M3.5.0,M10.5.0/3").unwrap();
    let rise = When {
        kind: WhenKind::Sunrise,
        minute_of_day: 0,
        offset_min: 0,
        days_mask: 0,
    };
    assert_eq!(
        next_fire(
            &rise,
            utc(2026, 12, 10, 12, 0),
            &tz,
            Location::new(697_000, 189_000)
        ),
        None
    );
    // Sydney (east of Greenwich, UTC+11 in summer): the event is on the LOCAL date.
    let syd = PosixTz::parse("AEST-10AEDT,M10.1.0,M4.1.0/3").unwrap();
    let t = next_fire(
        &rise,
        utc(2026, 12, 20, 12, 0),
        &syd,
        Location::new(-338_700, 1_512_000),
    )
    .unwrap();
    let (_, _, d, h, _) = local_hm(t, &syd);
    assert_eq!((d, h), (21, 5));
}
