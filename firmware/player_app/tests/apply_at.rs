//! Scheduled control changes through the C ABI (apply_at_ms on set_uniforms /
//! set_effect / set_crossfade / set_brightness, lm_sched_apply): a change for a
//! time still ahead on the shared time base is answered at once but applied only
//! at the first frame boundary at/after it, in order; late, unscheduled and
//! no-time-base changes apply on arrival; a full queue applies its earliest early
//! (nothing dropped); a scheduled live move skips the unlocked mailbox. Own binary:
//! the FFI state is process-global.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_brightness_u8, lm_clock_observe, lm_fx_active, lm_fx_load, lm_fx_set_active, lm_fx_shade,
    lm_fx_update, lm_live_post, lm_player_handle, lm_player_init, lm_sched_apply, lm_sched_len,
    lm_set_uniforms_commit, lm_take_control_ack, FEATURES,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn raw_at(frame: &[u8], now_ms: i64) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), now_ms, now_ms, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn handle_at(msg: CMsg, now_ms: i64) -> Option<SMsg> {
    raw_at(&encode(msg), now_ms)
}

fn varint(out: &mut Vec<u8>, mut v: u64) {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        if v == 0 {
            out.push(b);
            return;
        }
        out.push(b | 0x80);
    }
}

fn len_field(field: u32, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    varint(&mut out, (field as u64) << 3 | 2);
    varint(&mut out, body.len() as u64);
    out.extend_from_slice(body);
    out
}

/// ClientMessage{set_uniforms{values: [{slot 0, [v]}], commit?, seq?, apply_at_ms?}}.
fn set_v(v: f32, commit: Option<bool>, seq: u32, apply_at: Option<u32>) -> Vec<u8> {
    let mut uv = vec![1 << 3, 0];
    uv.extend(len_field(2, &v.to_le_bytes()));
    let mut body = len_field(1, &uv);
    if let Some(c) = commit {
        body.extend([2 << 3, c as u8]);
    }
    if seq != 0 {
        body.push(4 << 3);
        varint(&mut body, seq as u64);
    }
    if let Some(t) = apply_at {
        body.push(5 << 3);
        varint(&mut body, t as u64);
    }
    len_field(23, &body)
}

/// The effect's output (red channel, LED 0) after one update.
fn shown() -> u8 {
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 1) });
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    rgb[0]
}

#[track_caller]
fn assert_shown(v: f32, why: &str) {
    let got = shown() as f32;
    assert!((got - v * 255.0).abs() <= 1.0, "{why}: shown {got}, want {v}");
}

fn crossfade(now_ms: i64) -> f64 {
    match handle_at(CMsg::Hello(pb::Hello::default()), now_ms) {
        Some(SMsg::Welcome(w)) => *w.crossfade().unwrap_or(&0.0),
        other => panic!("expected welcome, got {other:?}"),
    }
}

#[test]
fn scheduled_changes_apply_at_their_frame_boundary_in_order() {
    lm_player_init(16);
    assert!(FEATURES.contains(&"apply_at"));
    let fxb = ledmapper_fx_compiler::compile(
        "uniform float v : 0.0 .. 1.0 = 0.0;\nvoid update() {}\nvec3 shade(Led led) { return vec3(v); }\n",
    )
    .expect("compiles")
    .fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };

    // No time base yet: an apply_at is meaningless, so it applies on arrival.
    assert!(matches!(raw_at(&set_v(0.2, Some(false), 0, Some(500)), 1000), Some(SMsg::PlaybackState(_))));
    assert_eq!(unsafe { lm_sched_len() }, 0);
    assert_shown(0.2, "");

    // Shared time base: epoch at device ms 10_000.
    handle_at(CMsg::SetTimeBase(pb::SetTimeBase { r#epoch_ms: 10_000, ..Default::default() }), 10_000);
    // Scheduled for effect time 200: answered now, held.
    let r = raw_at(&set_v(1.0, Some(false), 0, Some(200)), 10_050);
    assert!(matches!(r, Some(SMsg::PlaybackState(_))));
    assert!(!unsafe { lm_set_uniforms_commit() }, "persist flags are recorded on arrival");
    assert_eq!(unsafe { lm_sched_len() }, 1);
    assert_shown(0.2, "not yet");
    assert_eq!(unsafe { lm_sched_apply(10_199) }, 0, "1 ms early");
    assert_shown(0.2, "");
    assert_eq!(unsafe { lm_sched_apply(10_200) }, 1);
    assert_shown(1.0, "applied exactly at its frame boundary");
    assert_eq!(unsafe { lm_sched_len() }, 0);

    // Unscheduled: on arrival (today's behaviour), even with a time base.
    raw_at(&set_v(0.0, Some(false), 0, None), 10_300);
    assert_shown(0.0, "");
    // Late (already past due): applied on arrival, never dropped.
    raw_at(&set_v(0.6, Some(false), 0, Some(250)), 10_300);
    assert_eq!(unsafe { lm_sched_len() }, 0);
    assert_shown(0.6, "");

    // Two scheduled out of order + a boundary that comes late: due order wins.
    raw_at(&set_v(0.4, Some(false), 0, Some(420)), 10_310); // applied 2nd
    raw_at(&set_v(0.8, Some(false), 0, Some(410)), 10_311); // applied 1st
    assert_eq!(unsafe { lm_sched_len() }, 2);
    assert_eq!(unsafe { lm_sched_apply(10_500) }, 1);
    assert_shown(0.4, "the later-due value is the one left");

    // A scheduled live move (seq, commit:false) is not taken by the unlocked
    // mailbox (which applies at the very next frame): it is queued like the rest.
    let live = set_v(0.2, Some(false), 9, Some(700));
    assert_eq!(unsafe { lm_live_post(live.as_ptr(), live.len()) }, 0);
    assert!(matches!(raw_at(&live, 10_600), Some(SMsg::PlaybackState(_))));
    let mut out = [0u8; 16];
    assert!(unsafe { lm_take_control_ack(out.as_mut_ptr(), out.len()) } > 0, "acked on arrival");
    assert_shown(0.4, "");
    unsafe { lm_sched_apply(10_700) };
    assert_shown(0.2, "");

    // Full queue: the earliest is applied early, in order, the rest still wait.
    for k in 0..8u32 {
        raw_at(&set_v(k as f32 / 10.0, Some(false), 0, Some(1000 + k)), 10_800);
    }
    assert_eq!(unsafe { lm_sched_len() }, 8);
    raw_at(&set_v(1.0, Some(false), 0, Some(2000)), 10_801);
    assert_eq!(unsafe { lm_sched_len() }, 8);
    assert_shown(0.0, "the earliest (0.0) went early to make room");
    unsafe { lm_sched_apply(11_007) };
    assert_shown(0.7, "0.7 is the last due by 1007");
    unsafe { lm_sched_apply(12_000) };
    assert_shown(1.0, "");

    // A device-clock step back moves the queue with the time base.
    raw_at(&set_v(0.0, Some(false), 0, Some(2500)), 12_100);
    unsafe {
        lm_clock_observe(12_100);
        lm_clock_observe(12_133);
        assert_eq!(lm_clock_observe(2_133), -10_033);
    }
    assert_eq!(unsafe { lm_sched_apply(2_400) }, 0, "still ahead after the shift");
    assert_eq!(unsafe { lm_sched_apply(2_500) }, 1);
    assert_shown(0.0, "");
    // Time base is now 10_000 - 10_033 = -33: effect time t is device ms t - 33.

    // Brightness: scheduled, applied at its boundary (bit 2 asks to re-read it).
    let mut b = pb::SetBrightness { r#brightness: 0.5, ..Default::default() };
    b.set_apply_at_ms(3_000);
    assert!(matches!(handle_at(CMsg::SetBrightness(b), 2_600), Some(SMsg::Welcome(_))));
    assert_eq!(unsafe { lm_brightness_u8() }, 255);
    assert_eq!(unsafe { lm_sched_apply(2_967) }, 3);
    assert_eq!(unsafe { lm_brightness_u8() }, 128);

    // Crossfade + effect off, scheduled for the same instant: both at one boundary.
    let mut x = pb::SetCrossfade { r#position: 0.75, ..Default::default() };
    x.set_apply_at_ms(3_500);
    handle_at(CMsg::SetCrossfade(x), 3_000);
    let mut e = pb::SetEffect::default();
    e.r#effect_id = "off".parse().unwrap();
    e.set_apply_at_ms(3_500);
    assert!(matches!(handle_at(CMsg::SetEffect(e), 3_001), Some(SMsg::PlaybackState(_))));
    assert_eq!(crossfade(3_002), 0.0);
    assert!(unsafe { lm_fx_active() });
    assert_eq!(unsafe { lm_sched_apply(3_466) }, 0);
    assert_eq!(unsafe { lm_sched_apply(3_467) }, 1);
    assert_eq!(crossfade(3_468), 0.75);
    assert!(!unsafe { lm_fx_active() });

    // Implausibly far ahead (a stale epoch): applied on arrival, not stuck.
    let mut b = pb::SetBrightness { r#brightness: 1.0, ..Default::default() };
    b.set_apply_at_ms(60_000);
    handle_at(CMsg::SetBrightness(b), 3_500);
    assert_eq!(unsafe { lm_sched_len() }, 0);
}
