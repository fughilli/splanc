//! The wall-clock discipline: age-grown error, source selection and switching,
//! step vs slew, sanity bounds, staleness, the drift fit, the carry-over record
//! and a randomized monotonicity property.

use ledmapper_clock::carry::{crc32, CARRY_BYTES};
use ledmapper_clock::{
    Applied, CarryRecord, Config, DateTime, FixedOffset, Offer, Reject, Source, WallClock,
};

const S: i64 = 1_000_000;
const MIN: i64 = 60 * S;
const HOUR: i64 = 60 * MIN;
const DAY: i64 = 24 * HOUR;
const MS: i64 = 1_000;
/// 2026-11-25T00:00:00Z.
const T0: i64 = 1_795_564_800 * S;
/// An arbitrary monotonic origin (boot + 100 s).
const M0: i64 = 100 * S;

fn sntp(unix: i64, at: i64, err: i64) -> Offer {
    Offer::new(Source::Sntp, unix, at, err)
}
fn app(unix: i64, at: i64, err: i64) -> Offer {
    Offer::new(Source::App, unix, at, err)
}
fn rtc(unix: i64, at: i64) -> Offer {
    Offer::new(Source::HwRtc, unix, at, S)
}

#[test]
fn invalid_until_first_offer() {
    let mut wc = WallClock::default();
    assert!(!wc.is_valid());
    assert_eq!(wc.now_us(M0), None);
    assert_eq!(wc.uncertainty_us(M0), None);
    assert_eq!(wc.carry_record(M0), None);
    let st = wc.status(M0);
    assert_eq!((st.unix_us, st.source, st.uncertainty_us), (None, None, 0));

    assert_eq!(wc.offer(app(T0, M0, 5 * MS), M0), Ok(Applied::Initial));
    assert!(wc.is_valid());
    assert_eq!(wc.source(), Some(Source::App));
    assert_eq!(wc.now_us(M0), Some(T0));
    assert_eq!(wc.now_us(M0 + 90 * MIN), Some(T0 + 90 * MIN));
    let at = wc.now_datetime(M0 + 13 * HOUR + 5 * MIN).unwrap();
    assert_eq!(
        (at.year, at.month, at.day, at.hour, at.minute),
        (2026, 11, 25, 13, 5)
    );
    let local = wc
        .now_local(M0, &FixedOffset::new(-5 * 3600).unwrap())
        .unwrap();
    assert_eq!((local.day, local.hour), (24, 19));
    assert_eq!(wc.status(M0).steps, 1);
}

#[test]
fn a_late_sample_is_carried_forward_to_now() {
    // The sample was measured 40 ms before it is processed.
    let mut wc = WallClock::default();
    wc.offer(app(T0, M0, 5 * MS), M0 + 40 * MS).unwrap();
    assert_eq!(wc.now_us(M0 + 40 * MS), Some(T0 + 40 * MS));
}

#[test]
fn error_grows_with_age_at_the_source_drift() {
    // App push, ±5 ms, carried by the C6 crystal (40 ppm).
    let o = app(T0, M0, 5 * MS);
    assert_eq!(o.drift_ppm, 40);
    assert_eq!(o.uncertainty_us(M0), 5 * MS);
    assert_eq!(o.uncertainty_us(M0 + HOUR), 5 * MS + 144 * MS);
    assert_eq!(o.uncertainty_us(M0 + DAY), 5 * MS + 3_456 * MS);
    assert_eq!(o.uncertainty_us(M0 - HOUR), 5 * MS, "no negative growth");
    // A DS3231 (2 ppm) read: 1 s + 172.8 ms after a day.
    let ds = rtc(T0, M0).with_drift_ppm(2);
    assert_eq!(ds.uncertainty_us(M0 + DAY), S + 172_800);
    // The clock reports the same, floored at 1 ms.
    let mut wc = WallClock::default();
    wc.offer(sntp(T0, M0, 200), M0).unwrap();
    assert_eq!(wc.uncertainty_us(M0), Some(MS), "floor");
    assert_eq!(wc.uncertainty_us(M0 + HOUR), Some(200 + 144 * MS));
    assert_eq!(wc.status(M0 + HOUR).age_us, HOUR);
}

#[test]
fn picks_the_lowest_current_error_and_switches_sources() {
    let mut wc = WallClock::default();
    // Boot: the hardware RTC says T0 (±1 s).
    assert_eq!(wc.offer(rtc(T0, M0), M0), Ok(Applied::Initial));

    // The app connects 10 s later: ±5 ms beats the RTC's ~1 s. The RTC was
    // 300 ms slow, so the clock slews rather than steps.
    let m = M0 + 10 * S;
    let r = wc.offer(app(T0 + 10 * S + 300 * MS, m, 5 * MS), m);
    assert_eq!(r, Ok(Applied::Slew { delta_us: 300 * MS }));
    assert_eq!(wc.source(), Some(Source::App));

    // SNTP (±2 ms) beats the app's 5 ms + growth.
    let m = M0 + 20 * S;
    assert!(wc.offer(sntp(T0 + 20 * S + 300 * MS, m, 2 * MS), m).is_ok());
    assert_eq!(wc.source(), Some(Source::Sntp));

    // A minute later the app pushes again at ±5 ms: SNTP's sample is still
    // 2 ms + 2.4 ms (the slew still in progress doesn't count against the
    // source), so the push is refused...
    let m = M0 + 80 * S;
    let before = wc;
    let r = wc.offer(app(T0 + 80 * S + 300 * MS, m, 5 * MS), m);
    assert!(matches!(r, Err(Reject::NotBetter { .. })), "{r:?}");
    assert_eq!(wc, before, "a refused offer changes nothing");

    // ...but an hour on, SNTP's sample has grown past 144 ms and the push wins.
    let m = M0 + 80 * S + HOUR;
    assert!(wc
        .offer(app(T0 + 80 * S + HOUR + 300 * MS, m, 5 * MS), m)
        .is_ok());
    assert_eq!(wc.source(), Some(Source::App));
    assert_eq!(wc.status(m).gen, 4);
}

#[test]
fn rank_breaks_exact_ties() {
    let mut wc = WallClock::default();
    wc.offer(app(T0, M0, 5 * MS), M0).unwrap();
    // Same error, same instant: SNTP outranks the app...
    assert!(wc.offer(sntp(T0, M0, 5 * MS), M0).is_ok());
    assert_eq!(wc.source(), Some(Source::Sntp));
    // ...and the app does not displace SNTP at a tie.
    let r = wc.offer(app(T0, M0, 5 * MS), M0);
    assert!(matches!(r, Err(Reject::NotBetter { .. })), "{r:?}");
    // A same-source refresh needs to be strictly better.
    assert!(wc.offer(sntp(T0, M0, 5 * MS), M0).is_err());
    assert!(wc.offer(sntp(T0, M0, 3 * MS), M0).is_ok());
}

#[test]
fn small_corrections_slew_without_a_jump() {
    let mut wc = WallClock::default();
    wc.offer(app(T0, M0, 50 * MS), M0).unwrap();
    // 10 s later SNTP says the clock is 900 ms slow.
    let m1 = M0 + 10 * S;
    let shown = wc.now_us(m1).unwrap();
    let r = wc
        .offer(sntp(T0 + 10 * S + 900 * MS, m1, 2 * MS), m1)
        .unwrap();
    assert_eq!(r, Applied::Slew { delta_us: 900 * MS });
    assert_eq!(wc.now_us(m1), Some(shown), "no jump at the correction");
    assert_eq!(wc.status(m1).slewing_us, -900 * MS);
    assert_eq!(wc.status(m1).steps, 1, "a slew is not a step");
    // The residual counts in the error bound while it lasts.
    assert_eq!(wc.uncertainty_us(m1), Some(2 * MS + 900 * MS));

    // 500 ppm: 300 ms caught up after 600 s, all of it after 1800 s.
    assert_eq!(wc.status(m1 + 600 * S).slewing_us, -600 * MS);
    let reference = |m: i64| T0 + 900 * MS + (m - M0);
    assert_eq!(
        wc.now_us(m1 + 600 * S),
        Some(reference(m1 + 600 * S) - 600 * MS)
    );
    assert_eq!(wc.now_us(m1 + 1800 * S), Some(reference(m1 + 1800 * S)));
    assert_eq!(wc.status(m1 + 1800 * S).slewing_us, 0);
    assert_eq!(
        wc.now_us(m1 + 5000 * S),
        Some(reference(m1 + 5000 * S)),
        "no overshoot"
    );

    // Displayed time is strictly increasing through the slew, at 1 ± 500 ppm.
    let mut last = wc.now_us(m1).unwrap();
    for k in 1..=2000 {
        let m = m1 + k * S;
        let now = wc.now_us(m).unwrap();
        let adv = now - last;
        assert!((S..=S + 500).contains(&adv), "advance {adv} at {k} s");
        last = now;
    }
}

#[test]
fn a_clock_ahead_slews_back_without_running_backwards() {
    let mut wc = WallClock::default();
    wc.offer(app(T0, M0, 50 * MS), M0).unwrap();
    let m1 = M0 + 10 * S;
    let r = wc
        .offer(sntp(T0 + 10 * S - 700 * MS, m1, 2 * MS), m1)
        .unwrap();
    assert_eq!(
        r,
        Applied::Slew {
            delta_us: -700 * MS
        }
    );
    let mut last = wc.now_us(m1).unwrap();
    for k in 1..=1500 {
        let now = wc.now_us(m1 + k * S).unwrap();
        let adv = now - last;
        assert!((S - 500..=S).contains(&adv), "advance {adv} at {k} s");
        last = now;
    }
    assert_eq!(wc.status(m1 + 1400 * S).slewing_us, 0);
}

#[test]
fn large_corrections_step() {
    let mut wc = WallClock::default();
    wc.offer(rtc(T0, M0), M0).unwrap();
    let m1 = M0 + 5 * S;
    // Exactly 1 s still slews ("over 1 s" steps)...
    let mut a = wc;
    assert_eq!(
        a.offer(app(T0 + 6 * S, m1, 5 * MS), m1),
        Ok(Applied::Slew { delta_us: S })
    );
    // ...1.5 s steps, forwards or back, and leaves nothing to slew.
    let mut b = wc;
    assert_eq!(
        b.offer(app(T0 + 5 * S + 1_500 * MS, m1, 5 * MS), m1),
        Ok(Applied::Step {
            delta_us: 1_500 * MS
        })
    );
    assert_eq!(b.now_us(m1), Some(T0 + 5 * S + 1_500 * MS));
    assert_eq!(b.status(m1).slewing_us, 0);
    assert_eq!(b.status(m1).steps, 2);
    let mut c = wc;
    assert_eq!(
        c.offer(app(T0 + 2 * S, m1, 5 * MS), m1),
        Ok(Applied::Step { delta_us: -3 * S })
    );
    assert_eq!(c.now_us(m1), Some(T0 + 2 * S));
    // A step cancels a slew in progress.
    a.offer(sntp(T0 + 30 * S, m1 + 10 * S, MS), m1 + 10 * S)
        .unwrap();
    assert_eq!(a.status(m1 + 10 * S).slewing_us, 0);
    assert_eq!(a.now_us(m1 + 10 * S), Some(T0 + 30 * S));
}

#[test]
fn sanity_bounds() {
    let mut wc = WallClock::default();
    // Before the firmware's floor (2026-01-01 by default), or malformed.
    let old = DateTime::from_ymd(2025, 12, 31)
        .unwrap()
        .to_unix_us()
        .unwrap();
    assert_eq!(wc.offer(app(old, M0, 5 * MS), M0), Err(Reject::BeforeFloor));
    assert_eq!(wc.offer(app(T0, M0, -1), M0), Err(Reject::Malformed));
    assert!(!wc.is_valid());
    let floor = Config {
        min_unix_us: 0,
        ..Config::DEFAULT
    };
    assert!(WallClock::new(floor)
        .offer(app(old, M0, 5 * MS), M0)
        .is_ok());

    // A fresh SNTP time vetoes a worse-ranked source more than 60 s away, even
    // one that claims a smaller error...
    wc.offer(sntp(T0, M0, 2 * MS), M0).unwrap();
    let m = M0 + HOUR;
    let r = wc.offer(app(T0 + HOUR + 61 * S, m, MS), m);
    assert_eq!(r, Err(Reject::Disagrees { delta_us: 61 * S }));
    let r = wc.offer(rtc(T0 + HOUR - 5 * MIN, m), m);
    assert_eq!(r, Err(Reject::Disagrees { delta_us: -5 * MIN }));
    // ...but not within the window...
    assert_eq!(
        wc.offer(app(T0 + HOUR + 59 * S, m, MS), m),
        Ok(Applied::Step { delta_us: 59 * S })
    );
    // ...and a worse-ranked source (now the app) never vetoes a better one.
    let r = wc.offer(sntp(T0 + HOUR + 10 * MIN, m, MS), m);
    assert_eq!(
        r,
        Ok(Applied::Step {
            delta_us: 10 * MIN - 59 * S
        })
    );
    // Once SNTP is stale (6 h) the veto lapses: the RTC may step it.
    let mut wc = WallClock::default();
    wc.offer(sntp(T0, M0, 2 * MS), M0).unwrap();
    let m = M0 + 6 * HOUR + S;
    let r = wc.offer(rtc(T0 + 6 * HOUR + S + 3 * MIN, m), m);
    assert_eq!(r, Ok(Applied::Step { delta_us: 3 * MIN }));
    assert_eq!(wc.source(), Some(Source::HwRtc));
}

#[test]
fn a_stale_sample_yields_to_a_worse_offer() {
    let mut wc = WallClock::default();
    wc.offer(Offer::new(Source::Mesh, T0, M0, MS), M0).unwrap();
    // 9 min: mesh is 1 + 21.6 ms and still fresh; a ±30 ms push is refused.
    let m = M0 + 9 * MIN;
    assert!(matches!(
        wc.offer(app(T0 + 9 * MIN, m, 30 * MS), m),
        Err(Reject::NotBetter { .. })
    ));
    // 11 min: mesh (10 min stale age) has gone quiet; the push is taken.
    let m = M0 + 11 * MIN;
    assert!(wc.offer(app(T0 + 11 * MIN, m, 30 * MS), m).is_ok());
    assert_eq!(wc.source(), Some(Source::App));
}

/// A simulated device crystal: true UTC at monotonic `m` when the monotonic
/// clock runs `ppm` slow.
fn truth(m: i64, ppm: i64) -> i64 {
    T0 + (m - M0) + (m - M0) * ppm / 1_000_000
}

#[test]
fn drift_fit_converges_on_a_40ppm_crystal() {
    // Hourly SNTP with ±2 ms of sample noise. Without a fit each poll would
    // find the clock 144 ms off; with it, a few ms.
    let mut wc = WallClock::default();
    let mut noise = 0x1234_5678u32;
    let mut worst_late = 0;
    for poll in 0..24 {
        let m = M0 + poll * HOUR;
        noise = noise.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let jitter = (noise >> 8) as i64 % (4 * MS) - 2 * MS;
        let before = wc.now_us(m);
        let r = wc.offer(sntp(truth(m, 40) + jitter, m, 2 * MS), m).unwrap();
        if let Some(shown) = before {
            let off = (truth(m, 40) - shown).abs();
            if poll >= 3 {
                worst_late = worst_late.max(off);
            }
            assert!(matches!(r, Applied::Slew { .. }), "poll {poll}: {r:?}");
        }
    }
    let ppm = wc.rate_ppb() as f64 / 1000.0;
    assert!((ppm - 40.0).abs() < 2.0, "fitted {ppm} ppm");
    assert!(
        worst_late < 10 * MS,
        "worst error after convergence {worst_late} µs"
    );
}

#[test]
fn drift_fit_tracks_a_fast_crystal_and_ignores_rtc_reads() {
    let mut wc = WallClock::default();
    for poll in 0..6 {
        let m = M0 + poll * HOUR;
        wc.offer(app(truth(m, -25), m, MS), m).unwrap();
    }
    assert!((wc.rate_ppb() + 25_000).abs() < 100, "{}", wc.rate_ppb());
    // A hardware RTC read (whole seconds) never moves the fit.
    let rate = wc.rate_ppb();
    let m = M0 + 30 * HOUR;
    wc.offer(rtc(truth(m, -25) + 400 * MS, m), m).unwrap();
    assert_eq!(wc.rate_ppb(), rate);
}

#[test]
fn drift_fit_is_clamped_and_rejects_outliers() {
    // A 500 ppm "crystal" fits to the 200 ppm clamp, never beyond.
    let mut wc = WallClock::default();
    for poll in 0..4 {
        let m = M0 + poll * 10 * MIN;
        wc.offer(sntp(truth(m, 300), m, MS), m).unwrap();
    }
    assert_eq!(wc.rate_ppb(), 200_000);
    // A 5 s jump inside an hour (1389 ppm) is not a crystal: ignored.
    let mut wc = WallClock::default();
    wc.offer(sntp(truth(M0, 10), M0, MS), M0).unwrap();
    let m = M0 + HOUR;
    wc.offer(sntp(truth(m, 10), m, MS), m).unwrap();
    let rate = wc.rate_ppb();
    assert!((rate - 10_000).abs() < 100, "{rate}");
    let m = M0 + 2 * HOUR;
    wc.offer(sntp(truth(m, 10) + 5 * S, m, MS), m).unwrap();
    assert_eq!(wc.rate_ppb(), rate, "outlier left the rate alone");
    // Samples too close together or too noisy for their span don't fit either.
    let mut wc = WallClock::default();
    wc.offer(app(T0, M0, 10 * MS), M0).unwrap();
    let m = M0 + 30 * S;
    wc.offer(app(truth(m, 40), m, MS), m).unwrap();
    assert_eq!(wc.rate_ppb(), 0, "span under a minute");
    let m = M0 + 10 * MIN; // (10 + 1) ms over 600 s = 18 ppm noise: allowed
    wc.offer(app(truth(m, 40), m, MS), m).unwrap();
    assert_ne!(wc.rate_ppb(), 0);
}

#[test]
fn carry_record_round_trip_and_restore() {
    let mut wc = WallClock::default();
    wc.offer(sntp(T0, M0, 3 * MS), M0).unwrap();
    let m = M0 + 10 * MIN;
    let rec = wc.carry_record(m).unwrap();
    assert_eq!(rec.unix_us, T0 + 10 * MIN);
    assert_eq!(rec.err_us, 3 * MS + 24 * MS);
    assert_eq!(rec.source, Source::Sntp);
    let bytes = rec.encode();
    assert_eq!(bytes.len(), CARRY_BYTES);
    assert_eq!(CarryRecord::decode(&bytes), Some(rec));

    // Every single-bit flip is caught.
    for i in 0..CARRY_BYTES * 8 {
        let mut b = bytes;
        b[i / 8] ^= 1 << (i % 8);
        assert_eq!(CarryRecord::decode(&b), None, "bit {i}");
    }
    // Power-on garbage and zeroed RAM never decode.
    assert_eq!(CarryRecord::decode(&[0; CARRY_BYTES]), None);
    assert_eq!(CarryRecord::decode(&[0xff; CARRY_BYTES]), None);
    // zlib's check value.
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);

    // After the reboot: the record becomes a Carry offer at boot with the gap
    // added to its error, and the app's next push replaces it.
    let boot = 2 * S;
    let mut fresh = WallClock::default();
    let offer = CarryRecord::decode(&bytes).unwrap().to_offer(boot, S);
    assert_eq!(offer.source, Source::Carry);
    assert_eq!(offer.err_us, rec.err_us + S);
    assert_eq!(fresh.offer(offer, boot), Ok(Applied::Initial));
    assert_eq!(fresh.now_us(boot), Some(T0 + 10 * MIN));
    let m = boot + 5 * S;
    assert!(fresh
        .offer(app(T0 + 10 * MIN + 5 * S + 400 * MS, m, 5 * MS), m)
        .is_ok());
    assert_eq!(fresh.source(), Some(Source::App));
}

#[test]
fn invalidate_forgets_time_but_keeps_the_rate() {
    let mut wc = WallClock::default();
    for poll in 0..3 {
        let m = M0 + poll * HOUR;
        wc.offer(sntp(truth(m, 30), m, MS), m).unwrap();
    }
    let rate = wc.rate_ppb();
    assert_ne!(rate, 0);
    wc.invalidate();
    assert!(!wc.is_valid());
    assert_eq!(wc.rate_ppb(), rate);
    assert_eq!(wc.offer(app(T0, M0, MS), M0), Ok(Applied::Initial));
}

#[test]
fn source_table() {
    for s in Source::ALL {
        assert_eq!(Source::from_u8(s.to_u8()), Some(s));
    }
    assert_eq!(Source::from_u8(0), None);
    assert_eq!(Source::from_u8(6), None);
    let ranks: Vec<u8> = Source::ALL.iter().map(|s| s.rank()).collect();
    assert_eq!(ranks, [1, 2, 3, 4, 5]);
    assert!(Source::Sntp.feeds_drift_fit() && !Source::HwRtc.feeds_drift_fit());
    assert!(!Source::Carry.feeds_drift_fit());
}

#[test]
fn randomized_offers_never_run_time_backwards_except_by_a_step() {
    // Property: between offers the displayed time strictly increases; across
    // an accepted offer it only goes back by a reported Step; every Slew is
    // within the threshold; the error bound always covers the true error for
    // honest sources.
    let mut seed = 0xC10C_u64;
    let mut rnd = |n: u64| {
        seed = seed
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (seed >> 33) % n
    };
    let mut wc = WallClock::default();
    let mut m = M0;
    let mut last: Option<i64> = None;
    for _ in 0..20_000 {
        m += 1 + rnd(120 * S as u64) as i64;
        if let Some(prev) = last {
            let now = wc.now_us(m).unwrap();
            assert!(now > prev, "ran backwards between offers");
            let err = (now - truth(m, 20)).abs();
            assert!(err <= wc.uncertainty_us(m).unwrap(), "bound {err}");
        }
        let source = Source::ALL[rnd(4) as usize]; // not Carry
        let err = match source {
            Source::HwRtc => S,
            _ => (1 + rnd(20)) as i64 * MS,
        };
        // Honest samples: the true time ± their stated error.
        let jitter = rnd((2 * err + 1) as u64) as i64 - err;
        let o = Offer::new(source, truth(m, 20) + jitter, m, err);
        let before = wc.now_us(m);
        match wc.offer(o, m) {
            Ok(Applied::Slew { delta_us }) => {
                assert!(delta_us.abs() <= S);
                assert_eq!(wc.now_us(m), before, "a slew never jumps");
            }
            Ok(Applied::Step { delta_us }) => {
                assert!(delta_us.abs() > S);
                assert_eq!(wc.now_us(m), Some(before.unwrap() + delta_us));
            }
            Ok(Applied::Initial) => assert!(before.is_none()),
            Err(Reject::NotBetter { .. }) => assert_eq!(wc.now_us(m), before),
            Err(e) => panic!("honest offer refused: {e:?}"),
        }
        last = wc.now_us(m);
    }
}
