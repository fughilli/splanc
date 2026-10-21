//! Host tests for the canned interpolation profiles: the Q16 eases against the
//! f64 reference, timing (start_at, joining late, frame-rate independence),
//! cancellation (live set, take-over, deck, id), completion (exact target,
//! events, commit) and the concurrency cap.

use ledmapper_ramp::*;

const EASES: [Ease; 5] = [
    Ease::Linear,
    Ease::InOutCubic,
    Ease::InCubic,
    Ease::OutCubic,
    Ease::Smoothstep,
];

#[test]
fn ease_fixed_point_matches_reference() {
    for e in EASES {
        assert_eq!(ease_q16(e, 0), 0, "{e:?} starts at 0");
        assert_eq!(ease_q16(e, Q16_ONE), Q16_ONE, "{e:?} ends at 1");
        let mut prev = 0;
        let mut worst = 0.0f64;
        for t in 0..=Q16_ONE {
            let q = ease_q16(e, t);
            assert!(q >= prev, "{e:?} monotonic at t={t}");
            assert!(q <= Q16_ONE);
            prev = q;
            let r = e.eval_f64(t as f64 / Q16_ONE as f64);
            worst = worst.max((q as f64 / Q16_ONE as f64 - r).abs());
        }
        assert!(worst <= 2.0 / Q16_ONE as f64, "{e:?} worst error {worst}");
    }
    // Past the end clamps.
    assert_eq!(ease_q16(Ease::InCubic, Q16_ONE * 3), Q16_ONE);
}

#[test]
fn ease_shapes() {
    let half = Q16_ONE / 2;
    assert_eq!(ease_q16(Ease::Linear, half), half);
    assert_eq!(ease_q16(Ease::InOutCubic, half), half);
    assert_eq!(ease_q16(Ease::Smoothstep, half), half);
    assert!(ease_q16(Ease::InCubic, half) < half / 3); // 0.125
    assert!(ease_q16(Ease::OutCubic, half) > half + half / 2); // 0.875
    assert_eq!(Ease::from_wire(9), None);
    for (i, e) in EASES.iter().enumerate() {
        assert_eq!(Ease::from_wire(i as u32), Some(*e));
    }
}

#[test]
fn progress_and_schedule() {
    assert_eq!(progress_q16(-5, 100), 0);
    assert_eq!(progress_q16(0, 100), 0);
    assert_eq!(progress_q16(50, 100), Q16_ONE / 2);
    assert_eq!(progress_q16(100, 100), Q16_ONE);
    assert_eq!(progress_q16(0, 0), Q16_ONE); // a zero-length ramp is a jump
    let s = Schedule::resolve(1000, 0, 500, 0).unwrap();
    assert_eq!((s.start_ms, s.end_ms()), (1000, 1500));
    let s = Schedule::resolve(1000, 1200, 500, 1).unwrap();
    assert_eq!(s.start_ms, 1200);
    assert_eq!(s.at(1199), None);
    assert_eq!(s.at(1200), Some(0));
    assert_eq!(s.at(1700), Some(Q16_ONE));
    assert_eq!(Schedule::resolve(0, 0, 1, 7), Err(RampError::BadEase));
    assert_eq!(Schedule::resolve(0, 0, MAX_DURATION_MS + 1, 0), Err(RampError::TooLong));
    assert_eq!(Schedule::resolve(0, MAX_LEAD_MS + 1, 1, 0), Err(RampError::TooFarAhead));
    assert_eq!(RampError::TooMany.code(), "too_many_ramps");
    assert_eq!(RampError::BadTarget.code(), "bad_ramp");
}

fn t1(slot: u16, from: f32, to: f32) -> Target {
    Target {
        slot,
        width: 1,
        discrete: false,
        from: [from, 0.0, 0.0, 0.0],
        to: [to, 0.0, 0.0, 0.0],
    }
}

/// (deck, slot, values) written by one tick.
type Writes = Vec<(u8, u16, Vec<f32>)>;

/// Tick and collect (deck, slot) -> values written this frame.
fn tick(e: &mut Engine, now: i64) -> (Writes, Option<(f32, u32)>) {
    let mut w = Vec::new();
    let mut xf = None;
    e.tick(now, |d, s, v| w.push((d, s, v.to_vec())), |p, m| xf = Some((p, m)));
    (w, xf)
}

fn events(e: &mut Engine) -> Vec<Event> {
    core::iter::from_fn(|| e.take_event()).collect()
}

#[test]
fn uniform_ramp_follows_curve_and_lands_exactly() {
    let mut e = Engine::new();
    let s = Schedule::resolve(1000, 0, 1000, Ease::InOutCubic as u32).unwrap();
    let vec3 = Target {
        slot: 4,
        width: 3,
        discrete: false,
        from: [0.0, 1.0, 2.0, 0.0],
        to: [1.0, 0.0, 2.0, 0.0],
    };
    e.start_uniforms(7, 0, &[t1(0, 10.0, 20.0), vec3], s, true).unwrap();
    assert_eq!(e.active_lanes(), 2);
    for now in [1000i64, 1100, 1250, 1500, 1800, 1999] {
        let (w, _) = tick(&mut e, now);
        assert_eq!(w.len(), 2);
        let f = Ease::InOutCubic.eval_f64((now - 1000) as f64 / 1000.0) as f32;
        assert!((w[0].2[0] - (10.0 + 10.0 * f)).abs() < 1e-3, "t={now}: {:?}", w[0]);
        assert!((w[1].2[0] - f).abs() < 1e-4 && (w[1].2[1] - (1.0 - f)).abs() < 1e-4);
        assert_eq!(w[1].2[2], 2.0);
    }
    assert!(events(&mut e).is_empty());
    let (w, _) = tick(&mut e, 2000);
    assert_eq!(w[0], (0, 0, vec![20.0]));
    assert_eq!(w[1], (0, 4, vec![1.0, 0.0, 2.0]));
    assert_eq!(e.active_lanes(), 0);
    assert!(e.idle());
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 7,
            kind: Kind::Uniforms,
            end: End::Done
        }]
    );
    assert!(e.take_commit(), "a committed deck-A ramp asks to persist");
    assert!(!e.take_commit());
    let (w, _) = tick(&mut e, 2100);
    assert!(w.is_empty(), "nothing after landing");
}

#[test]
fn time_based_whatever_the_frame_rate() {
    // The same ramp ticked at 80 fps and at 25 fps lands on the same value at
    // the same instant, and on the target at the same end time.
    let s = Schedule::resolve(0, 0, 2000, Ease::Linear as u32).unwrap();
    for fps in [80i64, 25] {
        let mut e = Engine::new();
        e.start_uniforms(1, 0, &[t1(0, 0.0, 1.0)], s, false).unwrap();
        let mut last = (0, 0.0f32);
        let mut now = 0;
        while !e.idle() {
            let (w, _) = tick(&mut e, now);
            if let Some(x) = w.first() {
                last = (now, x.2[0]);
            }
            if now == 1000 {
                assert!((last.1 - 0.5).abs() < 1e-4, "{fps} fps at 1 s: {}", last.1);
            }
            now += 1000 / fps;
        }
        assert!(
            last.0 >= 2000 && last.0 < 2000 + 1000 / fps,
            "{fps} fps landed at {}",
            last.0
        );
        assert_eq!(last.1, 1.0);
        assert!(!e.take_commit(), "commit=false never persists");
    }
}

#[test]
fn start_at_holds_then_joins_in_step() {
    // Two fixtures: one got the request on time, one 300 ms late; both run the
    // same start_at, so they agree on the value at every instant.
    let s = Schedule::resolve(1000, 1500, 1000, Ease::Smoothstep as u32).unwrap();
    let mut a = Engine::new();
    let mut b = Engine::new();
    a.start_uniforms(1, 0, &[t1(0, 0.0, 1.0)], s, false).unwrap();
    assert!(tick(&mut a, 1200).0.is_empty(), "holds before start_at");
    let late = Schedule::resolve(1800, 1500, 1000, Ease::Smoothstep as u32).unwrap();
    b.start_uniforms(1, 0, &[t1(0, 0.0, 1.0)], late, false).unwrap();
    for now in [1800i64, 2000, 2300] {
        assert_eq!(tick(&mut a, now).0, tick(&mut b, now).0);
    }
    // Joining after the end jumps straight to the target.
    let mut c = Engine::new();
    let gone = Schedule::resolve(9000, 1500, 1000, 0).unwrap();
    c.start_uniforms(1, 0, &[t1(0, 0.0, 1.0)], gone, false).unwrap();
    assert_eq!(tick(&mut c, 9000).0, vec![(0, 0, vec![1.0])]);
}

#[test]
fn live_set_cancels_only_its_uniform() {
    let mut e = Engine::new();
    let s = Schedule::resolve(0, 0, 1000, 0).unwrap();
    e.start_uniforms(3, 0, &[t1(0, 0.0, 1.0), t1(1, 0.0, 1.0)], s, true)
        .unwrap();
    tick(&mut e, 400);
    assert!(e.cancel_slot(0, 0));
    assert!(!e.cancel_slot(1, 1), "deck B's slot 1 isn't ramping");
    let (w, _) = tick(&mut e, 500);
    assert_eq!(w.len(), 1);
    assert_eq!(w[0].1, 1);
    assert!(events(&mut e).is_empty(), "the request still has a running lane");
    tick(&mut e, 1000);
    // Partly overridden: reports cancelled, and doesn't persist the half-landed state.
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 3,
            kind: Kind::Uniforms,
            end: End::Cancelled
        }]
    );
    assert!(!e.take_commit());
}

#[test]
fn discrete_uniforms_hold_then_land() {
    let mut e = Engine::new();
    let s = Schedule::resolve(0, 0, 1000, 0).unwrap();
    let mut toggle = t1(5, 0.0, 1.0);
    toggle.discrete = true;
    e.start_uniforms(4, 0, &[t1(0, 0.0, 1.0), toggle], s, false).unwrap();
    let (w, _) = tick(&mut e, 500);
    assert_eq!(w, vec![(0, 0, vec![0.5])], "the toggle holds mid-ramp");
    let (w, _) = tick(&mut e, 1000);
    assert_eq!(w, vec![(0, 0, vec![1.0]), (0, 5, vec![1.0])]);
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 4,
            kind: Kind::Uniforms,
            end: End::Done
        }]
    );
}

#[test]
fn newer_ramp_takes_over_a_uniform() {
    let mut e = Engine::new();
    let s = Schedule::resolve(0, 0, 1000, 0).unwrap();
    e.start_uniforms(1, 0, &[t1(0, 0.0, 1.0)], s, false).unwrap();
    e.start_uniforms(2, 0, &[t1(0, 0.5, 0.0)], s, false).unwrap();
    assert_eq!(e.active_lanes(), 1);
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 1,
            kind: Kind::Uniforms,
            end: End::Cancelled
        }]
    );
    // Same slot on the OTHER deck is a different uniform.
    e.start_uniforms(3, 1, &[t1(0, 0.0, 1.0)], s, false).unwrap();
    assert_eq!(e.active_lanes(), 2);
    e.cancel_deck(1);
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 3,
            kind: Kind::Uniforms,
            end: End::Cancelled
        }]
    );
    assert_eq!(e.cancel_id(2), 1);
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 2,
            kind: Kind::Uniforms,
            end: End::Cancelled
        }]
    );
    assert!(e.idle());
}

#[test]
fn concurrency_cap_is_all_or_nothing() {
    let mut e = Engine::new();
    let s = Schedule::resolve(0, 0, 1000, 0).unwrap();
    for slot in 0..MAX_LANES as u16 {
        e.start_uniforms(100 + slot as u32, 0, &[t1(slot, 0.0, 1.0)], s, false)
            .unwrap();
    }
    assert_eq!(e.active_lanes(), MAX_LANES);
    // A 17th uniform is refused, and nothing running was disturbed.
    assert_eq!(
        e.start_uniforms(1, 0, &[t1(99, 0.0, 1.0)], s, false),
        Err(RampError::TooMany)
    );
    assert_eq!(
        e.start_uniforms(1, 1, &[t1(0, 0.0, 1.0)], s, false),
        Err(RampError::TooMany)
    );
    assert_eq!(e.active_lanes(), MAX_LANES);
    assert!(events(&mut e).is_empty());
    // Taking over ramping uniforms needs no new lanes.
    e.start_uniforms(2, 0, &[t1(0, 1.0, 0.0), t1(1, 1.0, 0.0)], s, false)
        .unwrap();
    assert_eq!(e.active_lanes(), MAX_LANES);
    // Bad requests.
    assert_eq!(e.start_uniforms(1, 0, &[], s, false), Err(RampError::NoTargets));
    assert_eq!(
        e.start_uniforms(1, 0, &[t1(3, 0.0, 1.0), t1(3, 0.0, 1.0)], s, false),
        Err(RampError::BadTarget)
    );
    let mut wide = t1(3, 0.0, 1.0);
    wide.width = 5;
    assert_eq!(e.start_uniforms(1, 0, &[wide], s, false), Err(RampError::BadTarget));
    let many = [t1(0, 0.0, 1.0); MAX_LANES + 1];
    assert_eq!(e.start_uniforms(1, 0, &many, s, false), Err(RampError::TooMany));
}

#[test]
fn crossfade_ramp() {
    let mut e = Engine::new();
    let s = Schedule::resolve(0, 0, 1000, Ease::Linear as u32).unwrap();
    e.start_crossfade(5, 0.0, 1.0, 1, s);
    assert!(e.crossfade_active());
    let (_, xf) = tick(&mut e, 250);
    assert_eq!(xf, Some((0.25, 1)));
    // A newer crossfade ramp takes over; a live set cancels.
    e.start_crossfade(6, 0.25, 0.0, 0, s);
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 5,
            kind: Kind::Crossfade,
            end: End::Cancelled
        }]
    );
    assert!(e.cancel_crossfade());
    assert!(!e.cancel_crossfade());
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 6,
            kind: Kind::Crossfade,
            end: End::Cancelled
        }]
    );
    assert_eq!(tick(&mut e, 300).1, None);
    e.start_crossfade(8, 0.0, 1.0, 0, s);
    assert_eq!(tick(&mut e, 1000).1, Some((1.0, 0)));
    assert_eq!(
        events(&mut e),
        vec![Event {
            id: 8,
            kind: Kind::Crossfade,
            end: End::Done
        }]
    );
    assert!(e.idle());
    // id 0 = fire-and-forget: no event.
    e.start_crossfade(0, 0.0, 1.0, 0, s);
    e.cancel_id(0);
    assert!(events(&mut e).is_empty());
}

#[test]
fn event_queue_keeps_the_newest() {
    let mut e = Engine::new();
    for id in 1..=(MAX_EVENTS as u32 + 3) {
        e.push_event(id, Kind::Keypoints, End::Done);
    }
    let ev = events(&mut e);
    assert_eq!(ev.len(), MAX_EVENTS);
    assert_eq!(ev[0].id, 4);
    assert_eq!(ev.last().unwrap().id, MAX_EVENTS as u32 + 3);
    assert_eq!(e.events_dropped, 3);
}

#[test]
fn per_frame_cost_is_bounded() {
    // Host proxy for the device measurement (the C6 number is in the [fx] serial
    // log, ramp_cyc): a full table of vec4 lanes, ticked per frame, writes at
    // most MAX_LANES uniforms — the work is per ramped float, never per LED.
    let mut e = Engine::new();
    let s = Schedule::resolve(0, 0, 10_000, Ease::InOutCubic as u32).unwrap();
    let ts: Vec<Target> = (0..MAX_LANES as u16)
        .map(|k| Target {
            slot: k * 4,
            width: 4,
            discrete: false,
            from: [0.0; 4],
            to: [1.0; 4],
        })
        .collect();
    e.start_uniforms(1, 0, &ts, s, false).unwrap();
    let mut floats = 0;
    let n = e.tick(5000, |_, _, v| floats += v.len(), |_, _| {});
    assert_eq!(n as usize, MAX_LANES);
    assert_eq!(floats, MAX_LANES * 4);
    let t0 = std::time::Instant::now();
    for f in 0..10_000 {
        e.tick(5000 + (f % 4000), |_, _, _| {}, |_, _| {});
    }
    eprintln!("host: {:?} per full-table tick", t0.elapsed() / 10_000);
}
