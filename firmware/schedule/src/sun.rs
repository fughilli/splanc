//! Sunrise and sunset (D-565): NOAA's general solar position equations
//! (Spencer's Fourier series for the declination and the equation of time),
//! with the standard -0.833° horizon (refraction + the solar disc). Good to
//! about a minute between the polar circles, which is plenty for lamps. f64,
//! with the few transcendental functions written here (no_std has no libm).
//!
//! The location is what the phone reported, rounded to 0.1° (about 11 km),
//! stored on the lamp; no geocoding service is involved.

use core::f64::consts::{FRAC_PI_2, PI};

/// A lamp's location, 1e-4 degrees (north and east positive). The app sends it
/// rounded to 0.1° (multiples of 1000).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Location {
    pub lat_e4: i32,
    pub lon_e4: i32,
}

impl Location {
    /// None unless |lat| <= 90° and |lon| <= 180°.
    pub const fn new(lat_e4: i32, lon_e4: i32) -> Option<Self> {
        if lat_e4.abs() <= 900_000 && lon_e4.abs() <= 1_800_000 {
            Some(Location { lat_e4, lon_e4 })
        } else {
            None
        }
    }
}

/// Which event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    Sunrise,
    Sunset,
}

const DEG: f64 = PI / 180.0;

/// sin on [-π/4, π/4] (Taylor to x^15: error < 1e-16 there).
fn sin_k(x: f64) -> f64 {
    let x2 = x * x;
    let mut t = x;
    let mut s = x;
    for k in 1..8 {
        let k = k as f64;
        t *= -x2 / ((2.0 * k) * (2.0 * k + 1.0));
        s += t;
    }
    s
}

fn cos_k(x: f64) -> f64 {
    let x2 = x * x;
    let mut t = 1.0;
    let mut s = 1.0;
    for k in 1..9 {
        let k = k as f64;
        t *= -x2 / ((2.0 * k - 1.0) * (2.0 * k));
        s += t;
    }
    s
}

/// Rounds to the nearest integer (no_std f64 has no round()).
fn round(x: f64) -> f64 {
    let t = x as i64 as f64; // toward zero
    let d = x - t;
    if d >= 0.5 {
        t + 1.0
    } else if d <= -0.5 {
        t - 1.0
    } else {
        t
    }
}

pub fn sin(x: f64) -> f64 {
    let q = round(x / FRAC_PI_2);
    let r = x - q * FRAC_PI_2;
    match (q as i64).rem_euclid(4) {
        0 => sin_k(r),
        1 => cos_k(r),
        2 => -sin_k(r),
        _ => -cos_k(r),
    }
}

pub fn cos(x: f64) -> f64 {
    sin(x + FRAC_PI_2)
}

fn sqrt(x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    let mut r = if x > 1.0 { x } else { 1.0 };
    for _ in 0..64 {
        let n = 0.5 * (r + x / r);
        if n >= r {
            break;
        }
        r = n;
    }
    r
}

/// asin on [0, sin(π/4)] by bisection on sin (well conditioned there).
fn asin_small(y: f64) -> f64 {
    let (mut lo, mut hi) = (0.0f64, FRAC_PI_2 * 0.5 + 1e-3);
    for _ in 0..64 {
        let mid = 0.5 * (lo + hi);
        if sin(mid) < y {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// acos on [-1, 1]: 2·asin(√((1-x)/2)) for x >= 0 and π minus that of -x
/// below, so both ends stay well conditioned. Called a few times per rule per
/// day: simple beats fast.
pub fn acos(x: f64) -> f64 {
    let x = x.clamp(-1.0, 1.0);
    // Not recursive (the firmware's stack-bound check rejects recursion).
    let a = 2.0 * asin_small(sqrt((1.0 - x.abs()) * 0.5));
    if x >= 0.0 {
        a
    } else {
        PI - a
    }
}

/// Fractional-year angle (radians) for day-of-year `doy` (1-based) at `hour` UTC.
fn gamma(doy: u16, hour: f64, leap: bool) -> f64 {
    let days = if leap { 366.0 } else { 365.0 };
    2.0 * PI / days * (doy as f64 - 1.0 + (hour - 12.0) / 24.0)
}

/// (equation of time in minutes, declination in radians).
fn eot_decl(g: f64) -> (f64, f64) {
    let eqt = 229.18
        * (0.000075 + 0.001868 * cos(g)
            - 0.032077 * sin(g)
            - 0.014615 * cos(2.0 * g)
            - 0.040849 * sin(2.0 * g));
    let decl = 0.006918 - 0.399912 * cos(g) + 0.070257 * sin(g) - 0.006758 * cos(2.0 * g)
        + 0.000907 * sin(2.0 * g)
        - 0.002697 * cos(3.0 * g)
        + 0.00148 * sin(3.0 * g);
    (eqt, decl)
}

/// The event's time in minutes after 00:00 UTC of the given date (may lie
/// outside 0..1440 far from Greenwich), or None on a day without one (polar
/// night or midnight sun).
fn event_min(doy: u16, leap: bool, loc: Location, ev: Event, hour: f64) -> Option<f64> {
    let lat = loc.lat_e4 as f64 * 1e-4 * DEG;
    let lon = loc.lon_e4 as f64 * 1e-4;
    let (eqt, decl) = eot_decl(gamma(doy, hour, leap));
    let cos_lat = cos(lat);
    let cos_decl = cos(decl);
    if cos_lat.abs() < 1e-12 || cos_decl.abs() < 1e-12 {
        return None;
    }
    let tan = |a: f64| sin(a) / cos(a);
    let c = cos(90.833 * DEG) / (cos_lat * cos_decl) - tan(lat) * tan(decl);
    if !(-1.0..=1.0).contains(&c) {
        return None;
    }
    let ha = acos(c) / DEG;
    Some(match ev {
        Event::Sunrise => 720.0 - 4.0 * (lon + ha) - eqt,
        Event::Sunset => 720.0 - 4.0 * (lon - ha) - eqt,
    })
}

/// The event on the civil date `year-month-day` (the lamp's LOCAL date) at
/// `loc`, as seconds relative to 00:00 UTC of that date, or None on a day
/// without one. Two passes: the second evaluates the sun at the first
/// estimate's hour.
pub fn event_s(year: i64, month: u8, day: u8, loc: Location, ev: Event) -> Option<i64> {
    let leap = ledmapper_clock::civil::is_leap_year(year);
    let doy = (ledmapper_clock::civil::days_from_civil(year, month, day)
        - ledmapper_clock::civil::days_from_civil(year, 1, 1)
        + 1) as u16;
    let first = event_min(doy, leap, loc, ev, 12.0)?;
    let m = event_min(doy, leap, loc, ev, (first / 60.0).clamp(-12.0, 36.0)).unwrap_or(first);
    Some(round(m * 60.0) as i64)
}
