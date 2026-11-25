//! Host tests for the lamp power state machine, its envelopes, the touch
//! debouncer / gestures and the config record (docs/design/lamp-power.md).

use ledmapper_power::*;

fn req(on: bool) -> Request {
    Request { on, instant: false, duration_ms: 0, source: SOURCE_CLIENT }
}

fn cfg_with(style: u8, ms: u32) -> Config {
    let mut c = Config::DEFAULT;
    c.on.style = style;
    c.on.duration_ms = ms;
    c.off.style = style;
    c.off.duration_ms = ms;
    c
}

// -- state machine -----------------------------------------------------------

#[test]
fn starts_in_the_boot_state() {
    let mut m = Machine::new(true);
    assert_eq!(m.phase(), PHASE_ON);
    let f = m.frame(0);
    assert!(f.render);
    assert_eq!(f.level_q8, LEVEL_ONE);
    let mut m = Machine::new(false);
    let f = m.frame(0);
    assert!(!f.render);
    assert_eq!(f.level_q8, 0);
}

#[test]
fn fade_off_ramps_down_then_settles_dark() {
    let cfg = cfg_with(STYLE_FADE, 1000);
    let mut m = Machine::new(true);
    assert_eq!(m.request(req(false), &cfg, false, 100), Start::Started);
    assert_eq!(m.phase(), PHASE_TURNING_OFF);
    assert!(!m.target());
    let mut last = LEVEL_ONE + 1;
    for t in (100..1100).step_by(50) {
        let f = m.frame(t);
        assert!(f.render, "still rendering mid-fade at {t}");
        assert!(f.level_q8 <= last, "monotonic down at {t}");
        assert!(f.crossfade.is_none());
        last = f.level_q8;
    }
    let f = m.frame(1100);
    assert!(f.settled);
    assert!(!f.render);
    assert_eq!(m.phase(), PHASE_OFF);
    assert_eq!(m.left_ms(1100), 0);
    // Settled off stays off.
    assert!(!m.frame(5000).render);
}

#[test]
fn fade_on_ramps_up_and_midpoint_is_half() {
    let cfg = cfg_with(STYLE_FADE, 1000);
    let mut m = Machine::new(false);
    m.request(req(true), &cfg, false, 0);
    let mid = m.frame(500);
    assert!((mid.level_q8 as i32 - 128).abs() <= 2, "smoothstep(0.5) = 0.5, got {}", mid.level_q8);
    assert_eq!(m.left_ms(500), 500);
    let end = m.frame(1000);
    assert!(end.settled && end.render);
    assert_eq!(end.level_q8, LEVEL_ONE);
    assert_eq!(m.phase(), PHASE_ON);
}

#[test]
fn same_target_is_unchanged_and_does_not_bump_seq() {
    let cfg = Config::DEFAULT;
    let mut m = Machine::new(true);
    let s0 = m.seq;
    assert_eq!(m.request(req(true), &cfg, false, 0), Start::Unchanged);
    assert_eq!(m.seq, s0);
}

#[test]
fn cut_and_instant_are_immediate() {
    let cfg = cfg_with(STYLE_CUT, 1000);
    let mut m = Machine::new(true);
    assert_eq!(m.request(req(false), &cfg, false, 0), Start::Started);
    assert_eq!(m.phase(), PHASE_OFF);
    let cfg = cfg_with(STYLE_FADE, 1000);
    let mut r = req(true);
    r.instant = true;
    m.request(r, &cfg, false, 0);
    assert_eq!(m.phase(), PHASE_ON);
    // Instant while already transitioning toward the target finishes it.
    m.request(req(false), &cfg, false, 10);
    assert_eq!(m.phase(), PHASE_TURNING_OFF);
    let mut r = req(false);
    r.instant = true;
    m.request(r, &cfg, false, 20);
    assert_eq!(m.phase(), PHASE_OFF);
}

#[test]
fn duration_override_and_defaults_and_clamp() {
    assert_eq!(effective_ms(0, true), DEFAULT_ON_MS);
    assert_eq!(effective_ms(0, false), DEFAULT_OFF_MS);
    assert_eq!(effective_ms(5, true), MIN_MS);
    assert_eq!(effective_ms(1_000_000, true), MAX_MS);
    let cfg = cfg_with(STYLE_FADE, 1000);
    let mut m = Machine::new(true);
    let mut r = req(false);
    r.duration_ms = 200;
    m.request(r, &cfg, false, 0);
    assert_eq!(m.left_ms(0), 200);
    assert!(m.frame(200).settled);
}

#[test]
fn reversal_mid_fade_is_continuous() {
    let cfg = cfg_with(STYLE_FADE, 1000);
    let mut m = Machine::new(true);
    m.request(req(false), &cfg, false, 0);
    let before = m.frame(500).level_q8;
    // Tap again: back on, from the current level, no jump.
    assert_eq!(m.request(req(true), &cfg, false, 500), Start::Started);
    assert_eq!(m.phase(), PHASE_TURNING_ON);
    let after = m.frame(500).level_q8;
    assert!((before as i32 - after as i32).abs() <= 1, "{before} -> {after}");
    // The remaining distance (half) takes about half the duration.
    let left = m.left_ms(500);
    assert!((450..=550).contains(&left), "left {left}");
    let f = m.frame(500 + left);
    assert!(f.settled && f.render);
}

#[test]
fn effect_transition_loads_then_runs_the_envelope() {
    let cfg = cfg_with(STYLE_EFFECT, 1000);
    let mut m = Machine::new(false);
    assert_eq!(m.request(req(true), &cfg, true, 0), Start::LoadEffect(true));
    // While loading, the lamp holds its look (dark here).
    let hold = m.frame(1);
    assert!(hold.render);
    assert_eq!(hold.level_q8, 0);
    assert!(m.effect_loaded(true, 10));
    assert!(m.owns_deck_b());
    let f0 = m.frame(10);
    assert_eq!(f0.level_q8, 0, "starts from dark");
    assert_eq!(f0.crossfade, Some(1.0), "the effect alone at first");
    let f = m.frame(10 + 500);
    assert_eq!(f.level_q8, LEVEL_ONE, "faded in after 15%");
    assert_eq!(f.crossfade, Some(1.0));
    assert!((f.power - 0.5).abs() < 0.01 && (f.progress - 0.5).abs() < 0.01);
    let late = m.frame(10 + 900);
    let xf = late.crossfade.unwrap();
    assert!(xf > 0.0 && xf < 0.5, "crossfading into the show: {xf}");
    let end = m.frame(10 + 1000);
    assert!(end.settled && end.release_deck_b && end.render);
    assert!(!m.owns_deck_b());
    assert_eq!(m.frame(2000).crossfade, None);
}

#[test]
fn effect_off_crossfades_in_then_fades_to_dark() {
    let cfg = cfg_with(STYLE_EFFECT, 1000);
    let mut m = Machine::new(true);
    assert_eq!(m.request(req(false), &cfg, true, 0), Start::LoadEffect(false));
    m.effect_loaded(true, 0);
    let f = m.frame(0);
    assert_eq!(f.crossfade, Some(0.0));
    assert_eq!(f.level_q8, LEVEL_ONE);
    assert!((f.power - 1.0).abs() < 1e-6);
    assert_eq!(m.frame(500).crossfade, Some(1.0));
    assert!(m.frame(950).level_q8 < 128);
    let end = m.frame(1000);
    assert!(end.settled && !end.render && end.release_deck_b);
}

#[test]
fn effect_unavailable_or_failed_falls_back_to_fade() {
    let cfg = cfg_with(STYLE_EFFECT, 1000);
    let mut m = Machine::new(true);
    assert_eq!(m.request(req(false), &cfg, false, 0), Start::Started);
    assert!(m.frame(500).crossfade.is_none());
    let mut m = Machine::new(true);
    assert_eq!(m.request(req(false), &cfg, true, 0), Start::LoadEffect(false));
    assert!(!m.effect_loaded(false, 0));
    assert!(!m.owns_deck_b());
    let f = m.frame(500);
    assert!(f.crossfade.is_none() && f.render);
    assert!(m.frame(1000).settled);
}

#[test]
fn reversal_mid_effect_holds_the_mix_and_still_releases_deck_b() {
    let cfg = cfg_with(STYLE_EFFECT, 1000);
    let mut m = Machine::new(true);
    m.request(req(false), &cfg, true, 0);
    m.effect_loaded(true, 0);
    let f = m.frame(200);
    let xf = f.crossfade.unwrap();
    m.request(req(true), &cfg, true, 200);
    let g = m.frame(200);
    assert_eq!(g.crossfade, Some(xf), "mix held");
    let left = m.left_ms(200);
    let end = m.frame(200 + left);
    assert!(end.settled && end.release_deck_b && end.render);
}

#[test]
fn a_late_load_after_a_reversal_is_refused() {
    let cfg = cfg_with(STYLE_EFFECT, 1000);
    let mut m = Machine::new(true);
    m.request(req(false), &cfg, true, 0);
    // Reversed before the effect loaded.
    m.request(req(true), &cfg, true, 1);
    assert!(!m.effect_loaded(true, 2), "caller must unload deck B");
}

#[test]
fn boot_fade_in_starts_on_the_first_frame() {
    let mut m = Machine::new(false);
    m.boot_fade_in(400);
    assert!(m.target());
    let f = m.frame(50_000);
    assert_eq!(f.level_q8, 0, "clock starts at the first frame");
    assert!(m.frame(50_200).level_q8 > 0);
    assert!(m.frame(50_400).settled);
    assert_eq!(m.source, SOURCE_BOOT);
}

#[test]
fn clock_wrap_is_harmless() {
    let cfg = cfg_with(STYLE_FADE, 1000);
    let mut m = Machine::new(true);
    let t0 = u32::MAX - 300;
    m.request(req(false), &cfg, false, t0);
    let f = m.frame(t0.wrapping_add(500));
    assert!(f.render && f.level_q8 > 0 && f.level_q8 < LEVEL_ONE);
    assert!(m.frame(t0.wrapping_add(1000)).settled);
}

#[test]
fn seq_bumps_on_start_and_settle() {
    let cfg = cfg_with(STYLE_FADE, 100);
    let mut m = Machine::new(true);
    let s = m.seq;
    m.request(req(false), &cfg, false, 0);
    assert_eq!(m.seq, s + 1);
    m.frame(100);
    assert_eq!(m.seq, s + 2);
}

#[test]
fn boot_state_policy() {
    assert!(boot_state(BOOT_LAST, None), "never saved: on");
    assert!(!boot_state(BOOT_LAST, Some(false)));
    assert!(boot_state(BOOT_LAST, Some(true)));
    assert!(boot_state(BOOT_ON, Some(false)));
    assert!(!boot_state(BOOT_OFF, Some(true)));
    assert_eq!(sanitize_boot(9), BOOT_LAST);
    assert_eq!(sanitize_style(9), STYLE_FADE);
}

// -- envelope ------------------------------------------------------------------

#[test]
fn envelopes_hit_their_endpoints() {
    for style in [STYLE_FADE, STYLE_EFFECT] {
        let (l0, _) = envelope(style, true, 0.0, 0.0);
        let (l1, x1) = envelope(style, true, 0.0, 1.0);
        assert!(l0.abs() < 1e-6 && (l1 - 1.0).abs() < 1e-6);
        if style == STYLE_EFFECT {
            assert!(x1.unwrap().abs() < 1e-6, "ON ends on the show");
        }
        let (l0, x0) = envelope(style, false, 1.0, 0.0);
        let (l1, _) = envelope(style, false, 1.0, 1.0);
        assert!((l0 - 1.0).abs() < 1e-6 && l1.abs() < 1e-6);
        if style == STYLE_EFFECT {
            assert!(x0.unwrap().abs() < 1e-6, "OFF starts on the show");
        }
    }
    assert_eq!(envelope(STYLE_CUT, true, 0.0, 0.3), (1.0, None));
}

// -- toggle trigger --------------------------------------------------------

#[test]
fn trigger_step_toggles_on_increments_only() {
    assert_eq!(trigger_step(None, 5.0), Some(false), "first sight: adopt");
    assert_eq!(trigger_step(Some(5.0), 5.0), None);
    assert_eq!(trigger_step(Some(5.0), 6.0), Some(true));
    assert_eq!(trigger_step(Some(6.0), 8.0), Some(true), "two fires between looks: one toggle");
    assert_eq!(trigger_step(Some(6.0), 0.0), Some(false), "driver reloaded: reset, no toggle");
}

// -- config record -----------------------------------------------------------

#[test]
fn config_record_round_trips() {
    let mut c = Config::DEFAULT;
    c.boot = BOOT_OFF;
    c.on.style = STYLE_EFFECT;
    c.on.duration_ms = 1500;
    assert!(c.on.push_uniform(3, &[0.1, 0.2, 0.3]));
    assert!(c.on.push_uniform(7, &[2.5]));
    c.on.set_label("sunrise".as_bytes());
    c.on.set_effect_id("lib-bloom".as_bytes());
    c.off.style = STYLE_CUT;
    assert!(c.set_trigger(b"touch_tap"));
    let mut r = [0u8; RECORD_LEN];
    encode_config(&c, &mut r);
    let d = decode_config(&r).expect("decodes");
    assert_eq!(d, c);
    assert_eq!(d.on.uniforms()[0].values(), &[0.1, 0.2, 0.3]);
    assert_eq!(d.on.label(), b"sunrise");
    assert_eq!(d.on.effect_id(), b"lib-bloom");
    assert_eq!(d.trigger(), b"touch_tap");
}

#[test]
fn trigger_names_are_identifiers() {
    let mut c = Config::DEFAULT;
    assert!(c.set_trigger(b"touch_tap"));
    assert!(!c.set_trigger(b"9lives"));
    assert_eq!(c.trigger(), b"", "an invalid name unbinds");
    assert!(!c.set_trigger(b"has space"));
    assert!(!c.set_trigger(&[b'a'; 25]));
    assert!(c.set_trigger(b""), "empty unbinds");
}

#[test]
fn config_record_rejects_junk() {
    assert!(decode_config(&[0u8; 10]).is_none());
    let mut r = [0u8; RECORD_LEN];
    encode_config(&Config::DEFAULT, &mut r);
    let mut bad = r;
    bad[0] = b'X';
    assert!(decode_config(&bad).is_none());
    let mut bad = r;
    bad[4] = 99;
    assert!(decode_config(&bad).is_none());
    // Too many uniforms.
    let mut bad = r;
    bad[6 + 5] = 9;
    assert!(decode_config(&bad).is_none());
}

#[test]
fn uniform_preset_is_bounded() {
    let mut t = Transition::DEFAULT;
    for i in 0..MAX_UNIFORMS as u32 {
        assert!(t.push_uniform(i, &[1.0]));
    }
    assert!(!t.push_uniform(99, &[1.0]));
    let mut t = Transition::DEFAULT;
    assert!(!t.push_uniform(0, &[]));
    assert!(!t.push_uniform(0, &[1.0; 5]));
    assert!(!t.push_uniform(70_000, &[1.0]));
}

#[test]
fn labels_clip_on_a_char_boundary() {
    let mut t = Transition::DEFAULT;
    let s = "ééééééééééééééééé"; // 34 bytes
    t.set_label(s.as_bytes());
    assert!(t.label().len() <= MAX_LABEL);
    assert!(core::str::from_utf8(t.label()).is_ok());
}
