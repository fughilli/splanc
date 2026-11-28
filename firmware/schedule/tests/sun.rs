//! Sunrise / sunset against the float64 reference vectors
//! (tools/gen_sun_vectors.py), plus real-world sanity points.

use ledmapper_schedule::sun::{acos, cos, event_s, sin};
use ledmapper_schedule::{Event, Location};

#[test]
fn trig_matches_libm() {
    let mut x = -20.0f64;
    while x < 20.0 {
        assert!((sin(x) - x.sin()).abs() < 1e-13, "sin {x}");
        assert!((cos(x) - x.cos()).abs() < 1e-13, "cos {x}");
        x += 0.0137;
    }
    let mut c = -1.0f64;
    while c <= 1.0 {
        assert!((acos(c) - c.acos()).abs() < 1e-12, "acos {c}");
        c += 0.001;
    }
}

#[test]
fn matches_the_reference_vectors() {
    let text = include_str!("testdata/sun_vectors.txt");
    let mut n = 0;
    for line in text
        .lines()
        .filter(|l| !l.starts_with('#') && !l.is_empty())
    {
        let f: Vec<&str> = line.split_whitespace().collect();
        let p = |i: usize| f[i].parse::<i64>().unwrap();
        let loc = Location::new(p(0) as i32, p(1) as i32).unwrap();
        let (y, m, d) = (p(2), p(3) as u8, p(4) as u8);
        for (ev, col) in [(Event::Sunrise, 5), (Event::Sunset, 6)] {
            let want = (f[col] != "-").then(|| p(col));
            let got = event_s(y, m, d, loc, ev);
            match (want, got) {
                (Some(w), Some(g)) => assert!((w - g).abs() <= 1, "{line}: {ev:?} {g} vs {w}"),
                (None, None) => {}
                _ => panic!("{line}: {ev:?} {got:?} vs {want:?}"),
            }
            n += 1;
        }
    }
    assert!(n >= 400, "{n} checks");
}

#[test]
fn real_world_points() {
    // London, 2026-06-21: sunrise 03:43 UTC, sunset 20:21 UTC (published tables).
    let london = Location::new(515_000, -1_000).unwrap();
    let r = event_s(2026, 6, 21, london, Event::Sunrise).unwrap();
    let s = event_s(2026, 6, 21, london, Event::Sunset).unwrap();
    assert!((r - (3 * 3600 + 43 * 60)).abs() <= 180, "{r}");
    assert!((s - (20 * 3600 + 21 * 60)).abs() <= 180, "{s}");
    // Tromso: no sunrise in mid-December (polar night), no sunset at midsummer.
    let tromso = Location::new(697_000, 189_000).unwrap();
    assert_eq!(event_s(2026, 12, 21, tromso, Event::Sunrise), None);
    assert_eq!(event_s(2026, 6, 21, tromso, Event::Sunset), None);
    // The equator at an equinox: a ~12 h 7 min day.
    let eq = Location::new(0, 0).unwrap();
    let day = event_s(2026, 3, 20, eq, Event::Sunset).unwrap()
        - event_s(2026, 3, 20, eq, Event::Sunrise).unwrap();
    assert!((day - (12 * 3600 + 7 * 60)).abs() < 300, "{day}");
    assert!(Location::new(900_001, 0).is_none());
}
