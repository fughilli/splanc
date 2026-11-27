//! The step-back guard, with the C6's observed esp_timer jumps (whole multiples
//! of 2^24 systimer ticks = 1 048 576 µs), and its effect on the wall clock.

use ledmapper_clock::{MonoClock, Offer, Source, StepGuard, WallClock};

const TICK_STEP_US: i64 = 1 << 20; // 2^24 ticks at 16 MHz = 1 048 576 µs
const FRAME_US: i64 = 50_000;
const T0_UNIX: i64 = 1_795_564_800_000_000; // 2026-11-25T00:00:00Z

#[test]
fn matches_lm_clock_observe_vector() {
    // The player's own test (firmware/player_app/tests/apply_at.rs), in µs:
    // 12_100 -> 12_133 -> 2_133 ms shifts by -10_033 ms.
    let mut g = StepGuard::default();
    assert_eq!(g.observe(12_100_000), 0);
    assert_eq!(g.observe(12_133_000), 0);
    assert_eq!(g.observe(2_133_000), -10_033_000);
    assert_eq!(g.jumps(), 1);
    assert_eq!(g.observe(2_166_000), 0, "steady after the step");
}

#[test]
fn first_observation_never_shifts() {
    let mut g = StepGuard::default();
    assert_eq!(g.observe(-5), 0);
    assert_eq!(g.observe(-4), 0);
    let mut g = StepGuard::default();
    assert_eq!(g.observe(0), 0);
    assert_eq!(
        g.observe(-1_000),
        -1_000 - 33_000,
        "a step back from 0 still counts"
    );
}

#[test]
fn forward_gaps_are_real_and_not_learnt() {
    let mut g = StepGuard::new(FRAME_US);
    g.observe(0);
    g.observe(FRAME_US);
    assert_eq!(
        g.observe(FRAME_US + 600_000_000),
        0,
        "a 10 min stall is elapsed time"
    );
    // The long gap was not learnt as the usual advance: a step now absorbs as
    // one frame, not ten minutes.
    let at = FRAME_US + 600_000_000;
    assert_eq!(g.observe(at - TICK_STEP_US), -TICK_STEP_US - FRAME_US);
}

#[test]
fn mono_clock_never_goes_backwards_through_2pow24_steps() {
    // 1, 3 and 82 whole-multiple steps, as seen in CI, across a run of frames.
    let mut mono = MonoClock::new(FRAME_US);
    let mut raw = 5_000_000;
    let mut last = i64::MIN;
    let mut total_back = 0;
    for frame in 0..3_000 {
        raw += FRAME_US;
        let k = match frame {
            500 => 1,
            1200 => 3,
            2500 => 82,
            _ => 0,
        };
        raw -= k * TICK_STEP_US;
        total_back += k * TICK_STEP_US;
        let t = mono.read(raw);
        assert!(t > last, "frame {frame}: {t} <= {last}");
        if last != i64::MIN {
            // Steady frames advance by exactly one frame, and so does a step.
            assert_eq!(t - last, FRAME_US, "frame {frame}");
        }
        last = t;
    }
    assert_eq!(mono.jumps(), 3);
    // Each step was absorbed as one frame of advance instead of `-k*step`.
    assert_eq!(mono.correction(), total_back);
}

/// Drives a wall clock off a raw esp_timer that steps back, both ways the
/// firmware can wire it: shifting anchors with `shift_mono` (raw domain), or
/// reading through `MonoClock` (corrected domain).
#[test]
fn wall_clock_stays_continuous_across_a_step_back() {
    let mut g = StepGuard::new(FRAME_US);
    let mut wc_raw = WallClock::default();
    let mut mono = MonoClock::new(FRAME_US);
    let mut wc_cor = WallClock::default();

    let mut raw = 10_000_000;
    g.observe(raw);
    let corrected = mono.read(raw);
    wc_raw
        .offer(Offer::new(Source::App, T0_UNIX, raw, 5_000), raw)
        .unwrap();
    wc_cor
        .offer(
            Offer::new(Source::App, T0_UNIX, corrected, 5_000),
            corrected,
        )
        .unwrap();

    let mut prev_raw = wc_raw.now_us(raw).unwrap();
    let mut prev_cor = wc_cor.now_us(corrected).unwrap();
    for frame in 1..400 {
        raw += FRAME_US;
        if frame == 100 || frame == 300 {
            raw -= 7 * TICK_STEP_US;
        }
        let shift = g.observe(raw);
        wc_raw.shift_mono(shift);
        let a = wc_raw.now_us(raw).unwrap();
        let corrected = mono.read(raw);
        let b = wc_cor.now_us(corrected).unwrap();
        assert_eq!(a - prev_raw, FRAME_US, "raw-domain wiring, frame {frame}");
        assert_eq!(
            b - prev_cor,
            FRAME_US,
            "corrected-domain wiring, frame {frame}"
        );
        assert_eq!(a, b);
        prev_raw = a;
        prev_cor = b;
    }
    // 399 frames of wall time, although the raw timer ended 14.7 s short.
    assert_eq!(prev_raw, T0_UNIX + 399 * FRAME_US);
    assert_eq!(raw, 10_000_000 + 399 * FRAME_US - 14 * TICK_STEP_US);
}

#[test]
fn shift_keeps_a_slew_and_the_drift_fit_in_step() {
    // A slew in progress and a fitted rate both survive a shift unchanged.
    let mut wc = WallClock::default();
    let m0 = 1_000_000_000;
    wc.offer(Offer::new(Source::Sntp, T0_UNIX, m0, 2_000), m0)
        .unwrap();
    let m1 = m0 + 3_600_000_000;
    // The crystal ran 40 ppm slow over the hour: 144 ms behind, so slew.
    wc.offer(
        Offer::new(Source::Sntp, T0_UNIX + 3_600_000_000 + 144_000, m1, 2_000),
        m1,
    )
    .unwrap();
    let probe = m1 + 60_000_000;
    let before = wc.status(probe);
    let mut shifted = wc;
    shifted.shift_mono(-5 * TICK_STEP_US);
    let after = shifted.status(probe - 5 * TICK_STEP_US);
    assert_eq!(before, after);
    assert!(before.slewing_us != 0);
    assert!(before.rate_ppb != 0);
}
