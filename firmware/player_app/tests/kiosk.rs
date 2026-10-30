//! Kiosk mode (kiosk_ffi.rs, docs/design/kiosk-mode.md): the lock gate's arm
//! table, the persisted record, the owner config rules, and the whole flow
//! through the C ABI — enable + capture, refusals, RAM-only visitor ops, owner
//! unlock (rate limited, per connection), the idle revert replaying the captured
//! attract frames, pushes, the console "kiosk off", and the boot seed. One flow
//! test: the FFI state is process-global.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::kiosk_ffi::{
    self as k, apply, classify, decode, encode, lm_kiosk_apply_runtime, lm_kiosk_build_push, lm_kiosk_console,
    lm_kiosk_enabled, lm_kiosk_encode_attract, lm_kiosk_gate, lm_kiosk_gen, lm_kiosk_msg_locked,
    lm_kiosk_push_done, lm_kiosk_record, lm_kiosk_reverted, lm_kiosk_seed, lm_kiosk_take_capture, lm_kiosk_tick,
    remaining_s, Class, Request, DEFAULT_CONFIG, RECORD_LEN, SRC_BLE, SRC_WSS, TICK_PUSH, TICK_REVERT,
};
use ledmapper_player_ffi::{lm_fx_shade, lm_fx_update, lm_player_handle, lm_player_init, FEATURES};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn encode_msg(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 8192>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn decode_reply(out: &[u8]) -> Option<SMsg> {
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(out).expect("reply decodes");
    reply.r#msg
}

/// What a transport does: gate first (on `src`), then the handler.
fn send_frame(src: u8, now: u32, frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let g = unsafe { lm_kiosk_gate(src, frame.as_ptr(), frame.len(), now, out.as_mut_ptr(), out.len()) };
    assert!(g >= 0);
    if g > 0 {
        return decode_reply(&out[..g as usize]);
    }
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), now as i64, now as i64, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    decode_reply(&out[..n as usize])
}

fn send(src: u8, now: u32, msg: CMsg) -> Option<SMsg> {
    send_frame(src, now, &encode_msg(msg))
}

fn status(r: Option<SMsg>) -> pb::KioskStatus {
    match r {
        Some(SMsg::KioskStatus(s)) => s,
        other => panic!("kiosk_status expected, got {other:?}"),
    }
}

fn err_code(r: Option<SMsg>) -> String {
    match r {
        Some(SMsg::Error(e)) => e.r#code.as_str().to_string(),
        other => panic!("expected an error, got {other:?}"),
    }
}

fn len_field(f: u32, b: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    let mut put = |mut n: usize| {
        while n >= 0x80 {
            v.push((n as u8) | 0x80);
            n >>= 7;
        }
        v.push(n as u8);
    };
    put(((f << 3) | 2) as usize);
    put(b.len());
    v.extend_from_slice(b);
    v
}

/// A submit_effect frame (hand-encoded: the generated fxb keeps a 64 B cap).
fn submit_frame(id: &str, src: &str) -> Vec<u8> {
    let fxb = ledmapper_fx_compiler::compile(src).expect("compiles").fxb;
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, &fxb));
    body.extend([3 << 3, 1]);
    len_field(21, &body)
}

fn set_gain(src: u8, now: u32, gain: f32) -> Option<SMsg> {
    let mut u = pb::UniformValue { r#slot: 3, ..Default::default() };
    u.r#value.extend_from_slice(&[gain]).unwrap();
    let mut m = pb::SetUniforms::default();
    m.r#values.push(u).unwrap();
    send(src, now, CMsg::SetUniforms(m))
}

fn brightness(src: u8, now: u32, b: f64) -> Option<SMsg> {
    send(src, now, CMsg::SetBrightness(pb::SetBrightness { r#brightness: b }))
}

fn cfg(enabled: Option<bool>, timeout: Option<u32>, capture: bool, secret: Option<&str>) -> CMsg {
    let mut m = pb::SetKioskConfig { r#capture_attract_from_current: capture, ..Default::default() };
    if let Some(e) = enabled {
        m.set_enabled(e);
    }
    if let Some(t) = timeout {
        m.set_idle_timeout_s(t);
    }
    if let Some(s) = secret {
        m.set_owner_secret(micropb::heapless::String::try_from(s).unwrap());
    }
    CMsg::SetKioskConfig(m)
}

fn unlock(src: u8, now: u32, secret: &str) -> Option<SMsg> {
    let mut m = pb::KioskUnlock::default();
    m.r#secret = secret.parse().unwrap();
    send(src, now, CMsg::KioskUnlock(m))
}

fn get(src: u8, now: u32) -> pb::KioskStatus {
    status(send(src, now, CMsg::GetKioskStatus(pb::GetKioskStatus::default())))
}

fn rename(src: u8, now: u32) -> Option<SMsg> {
    let mut m = pb::SetDeviceName::default();
    m.r#name = "Pwned".parse().unwrap();
    send(src, now, CMsg::SetDeviceName(m))
}

/// One frame, then LED 0's colour.
fn led0() -> [u8; 3] {
    assert!(unsafe { lm_fx_update(0.0, 0.016, 0, 1) });
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    rgb
}

fn near(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (*x as i32 - y as i32).abs() <= 2)
}

const SOLID: &str = r#"uniform vec3 tint : color = 1.0, 0.0, 0.0;
uniform float gain : 0.0 .. 1.0 = 1.0;
void update() {}
vec3 shade(Led led) { return tint * gain; }"#;

const GREEN: &str = r#"void update() {}
vec3 shade(Led led) { return vec3(0.0, 1.0, 0.0); }"#;

#[test]
fn arm_table() {
    // Visitor play ops.
    for arm in [17, 21, 22, 23, 28, 31, 39, 44] {
        assert_eq!(classify(arm, &[]), Class::Play, "arm {arm}");
    }
    // Read-only queries (incl. the kiosk's own status + unlock, the OTA status).
    for arm in [1, 2, 18, 19, 20, 24, 26, 34, 35, 36, 42, 43, 45, 74, 91, 92, 94] {
        assert_eq!(classify(arm, &[]), Class::Read, "arm {arm}");
    }
    // Refused: mapping, map/topology/led count, rename, colour, hw config, set_jit,
    // pose, keypoint writes, set_fps, sensors/drivers, OTA writes, fx debugger,
    // Wi-Fi policy, kiosk config, and anything unknown.
    for arm in [3, 4, 5, 13, 14, 15, 16, 27, 30, 32, 33, 37, 40, 41, 46, 49, 51, 52, 54, 55, 70, 71, 72, 73, 75, 80, 81, 82, 90, 93, 200] {
        assert_eq!(classify(arm, &[]), Class::Refuse, "arm {arm}");
    }
    // upload_chunk: an effect window plays, a map window is refused.
    let chunk = |kind: u32| {
        let mut m = pb::UploadChunk { r#upload_id: 1, r#seq: 0, r#last: true, ..Default::default() };
        m.r#kind = pb::UploadChunk_::Kind(kind as i32);
        encode_msg(CMsg::UploadChunk(m))
    };
    assert_eq!(classify(29, &chunk(2)), Class::Play);
    assert_eq!(classify(29, &chunk(0)), Class::Refuse);
    assert_eq!(classify(29, &chunk(1)), Class::Refuse);
}

#[test]
fn record_and_rules() {
    assert_eq!(RECORD_LEN, 112, "player_ffi.h LM_KIOSK_RECORD_LEN");
    let mut c = DEFAULT_CONFIG;
    c.enabled = true;
    c.has_attract = true;
    c.timeout_s = 90;
    c.brightness = 0.25;
    c.secret[..3].copy_from_slice(b"boo");
    c.secret_len = 3;
    c.name[..4].copy_from_slice(b"glow");
    c.name_len = 4;
    assert_eq!(decode(&encode(&c)), Some(c));
    assert_eq!(decode(&encode(&c)[..RECORD_LEN - 1]), None);
    let mut bad = encode(&c);
    bad[0] = b'X';
    assert_eq!(decode(&bad), None);
    // Enabled without a secret never decodes enabled.
    let mut nos = c;
    nos.secret_len = 0;
    assert!(!decode(&encode(&nos)).unwrap().enabled);

    let d = DEFAULT_CONFIG;
    let en = Request { enabled: Some(true), ..Default::default() };
    assert_eq!(apply(&d, &en, true), Err("kiosk_secret_required"));
    let en_s = Request { enabled: Some(true), secret: Some(b"boo"), ..Default::default() };
    assert_eq!(apply(&d, &en_s, false), Err("kiosk_no_effect"));
    let (n, cap) = apply(&d, &en_s, true).unwrap();
    assert!(n.enabled && cap, "enabling with no snapshot captures implicitly");
    let long = [b'x'; 33];
    assert_eq!(apply(&d, &Request { secret: Some(&long), ..Default::default() }, true), Err("kiosk_bad_config"));
    assert_eq!(apply(&d, &Request { secret: Some(b""), ..Default::default() }, true), Err("kiosk_bad_config"));
    let (n, cap) = apply(&d, &Request { timeout_s: Some(1), ..Default::default() }, false).unwrap();
    assert_eq!((n.timeout_s, cap), (10, false));

    // Remaining: from the last activity, 0 while the attract show runs, held while unlocked.
    let mut e = DEFAULT_CONFIG;
    e.enabled = true;
    assert_eq!(remaining_s(&e, true, false, 1000, 1000), 120);
    assert_eq!(remaining_s(&e, true, false, 1000, 1500), 120);
    assert_eq!(remaining_s(&e, true, false, 1000, 2001), 119);
    assert_eq!(remaining_s(&e, true, false, 1000, 200_000), 0);
    assert_eq!(remaining_s(&e, false, false, 1000, 2000), 0);
    assert_eq!(remaining_s(&e, true, true, 1000, 200_000), 120);
}

#[test]
fn kiosk_flow() {
    lm_player_init(1);
    assert!(FEATURES.contains(&"kiosk"), "kiosk advertised");
    let w = SRC_WSS;
    let b = SRC_BLE;
    let mut now = 1_000u32;
    unsafe { lm_kiosk_tick(now, true, true) };

    // Disabled: everything passes, nothing is locked.
    let s = get(w, now);
    assert!(!s.r#enabled && !s.r#has_attract && !s.r#has_secret);
    assert_eq!(s.r#idle_timeout_s, 120);

    // The owner sets the attract show up: red at half gain, brightness 0.4.
    let f = submit_frame("attract", SOLID);
    assert!(matches!(send_frame(w, now, &f), Some(SMsg::ResultReady(_))));
    assert!(matches!(set_gain(w, now, 0.5), Some(SMsg::PlaybackState(_))));
    assert!(matches!(brightness(w, now, 0.4), Some(SMsg::Welcome(_))));
    assert!(!unsafe { lm_kiosk_msg_locked() });
    let attract_rgb = led0();
    assert!(near(attract_rgb, [128, 0, 0]), "{attract_rgb:?}");

    // Enabling needs a secret.
    assert_eq!(err_code(send(w, now, cfg(Some(true), None, false, None))), "kiosk_secret_required");
    let g0 = unsafe { lm_kiosk_gen() };
    let s = status(send(w, now, cfg(Some(true), Some(10), false, Some("boo"))));
    assert!(s.r#enabled && s.r#has_attract && s.r#has_secret && s.r#attract_active);
    assert_eq!(s.r#attract_name.as_str(), "attract");
    assert!((s.r#attract_brightness - 0.4).abs() < 1e-3);
    assert_eq!((s.r#idle_timeout_s, s.r#idle_remaining_s, s.r#owner_unlocked), (10, 0, false));
    assert_ne!(unsafe { lm_kiosk_gen() }, g0, "the record is persisted");
    assert!(unsafe { lm_kiosk_enabled() });
    assert!(unsafe { lm_kiosk_take_capture() }, "implicit capture");
    assert!(!unsafe { lm_kiosk_take_capture() });
    // The config push (to every connection).
    assert_eq!(unsafe { lm_kiosk_tick(now, true, true) } & TICK_PUSH, TICK_PUSH);
    let mut out = vec![0u8; 512];
    let n = unsafe { lm_kiosk_build_push(b, now, out.as_mut_ptr(), out.len()) };
    assert_eq!(status(decode_reply(&out[..n as usize])).r#event.0, k::EVENT_CONFIG as i32);
    unsafe { lm_kiosk_push_done() };

    // The captured frames (what main.cpp writes to /lfs/kiosk_fx.pb + kiosk_un.pb).
    let mut fx = vec![0u8; 8192];
    let fxn = unsafe { lm_kiosk_encode_attract(0, fx.as_mut_ptr(), fx.len()) };
    assert!(fxn > 0);
    fx.truncate(fxn as usize);
    assert_eq!(fx, f, "the attract effect re-encodes exactly as uploaded");
    let mut un = vec![0u8; 1024];
    let unn = unsafe { lm_kiosk_encode_attract(1, un.as_mut_ptr(), un.len()) };
    assert!(unn > 0);
    un.truncate(unn as usize);
    let mut rec = [0u8; RECORD_LEN];
    unsafe { lm_kiosk_record(rec.as_mut_ptr()) };
    assert!(decode(&rec).unwrap().enabled);

    // Locked (both connections). Refused ops never reach a handler.
    now += 1_000;
    assert_eq!(err_code(rename(b, now)), "kiosk_locked");
    assert!(unsafe { lm_kiosk_msg_locked() });
    assert_eq!(err_code(send(w, now, cfg(Some(false), None, false, None))), "kiosk_locked");
    assert_eq!(err_code(send(b, now, CMsg::SetHardwareConfig(pb::SetHardwareConfig::default()))), "kiosk_locked");
    assert_eq!(err_code(send(b, now, CMsg::SaveKeypoint(pb::SaveKeypoint::default()))), "kiosk_locked");
    assert_eq!(err_code(send(b, now, CMsg::OtaBegin(pb::OtaBegin::default()))), "kiosk_locked");
    assert_eq!(err_code(send(b, now, CMsg::SetWifiPolicy(pb::SetWifiPolicy::default()))), "kiosk_locked");
    assert!(get(b, now).r#attract_active, "reads are not activity");

    // A visitor plays: allowed, locked (not persisted), and starts the timer.
    assert!(matches!(send_frame(b, now, &submit_frame("visitor", GREEN)), Some(SMsg::ResultReady(_))));
    assert!(unsafe { lm_kiosk_msg_locked() }, "visitor effect: RAM only");
    assert!(near(led0(), [0, 255, 0]));
    assert!(matches!(brightness(b, now, 1.0), Some(SMsg::Welcome(_))), "no brightness cap");
    let s = get(b, now);
    assert!(!s.r#attract_active);
    assert_eq!(s.r#idle_remaining_s, 10);
    assert_eq!(unsafe { lm_kiosk_tick(now, true, true) }, TICK_PUSH, "activity after the attract show");
    let n = unsafe { lm_kiosk_build_push(b, now, out.as_mut_ptr(), out.len()) };
    assert_eq!(status(decode_reply(&out[..n as usize])).r#event.0, k::EVENT_ACTIVITY as i32);
    unsafe { lm_kiosk_push_done() };
    now += 4_000;
    assert!(matches!(set_gain(b, now, 0.9), Some(SMsg::PlaybackState(_))), "activity again");
    assert_eq!(unsafe { lm_kiosk_tick(now, true, true) }, 0, "no push per op");
    assert_eq!(get(w, now + 3_000).r#idle_remaining_s, 7);

    // Owner unlock: a wrong secret, then the lockout, then the right one.
    assert_eq!(err_code(unlock(w, now, "nope")), "kiosk_bad_secret");
    assert_eq!(err_code(unlock(w, now + 500, "boo")), "kiosk_bad_secret");
    let s = status(unlock(w, now + 2_500, "boo"));
    assert!(s.r#owner_unlocked);
    now += 2_500;
    // Per connection: wss is unlocked, BLE is not.
    assert!(!get(b, now).r#owner_unlocked);
    assert_eq!(err_code(rename(b, now)), "kiosk_locked");
    assert!(matches!(rename(w, now), Some(SMsg::Welcome(_))));
    assert!(!unsafe { lm_kiosk_msg_locked() }, "the owner's ops persist");
    // The timer is held while the owner is unlocked.
    assert_eq!(unsafe { lm_kiosk_tick(now + 60_000, true, true) }, 0);
    now += 60_000;
    assert_eq!(get(b, now).r#idle_remaining_s, 10);
    // The owner's connection drops: locked again.
    unsafe { lm_kiosk_tick(now, false, true) };
    unsafe { lm_kiosk_tick(now, true, true) };
    assert!(!get(w, now).r#owner_unlocked);
    assert_eq!(err_code(rename(w, now)), "kiosk_locked");

    // The idle revert: due after the timeout, and replaying the captured frames
    // brings the attract show back (effect, uniforms, brightness, deck A).
    assert_eq!(unsafe { lm_kiosk_tick(now + 9_000, true, true) }, 0);
    assert_eq!(unsafe { lm_kiosk_tick(now + 10_000, true, true) } & TICK_REVERT, TICK_REVERT);
    now += 10_000;
    let mut o = vec![0u8; 4096];
    for frame in [&fx, &un] {
        assert!(unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, o.as_mut_ptr(), o.len()) } > 0);
    }
    unsafe { lm_kiosk_apply_runtime() };
    unsafe { lm_kiosk_reverted(now) };
    assert!(near(led0(), attract_rgb), "attract restored");
    assert_eq!(unsafe { lm_kiosk_tick(now, true, true) }, TICK_PUSH);
    let n = unsafe { lm_kiosk_build_push(w, now, out.as_mut_ptr(), out.len()) };
    let s = status(decode_reply(&out[..n as usize]));
    assert_eq!(s.r#event.0, k::EVENT_REVERTED as i32);
    assert!(s.r#attract_active && s.r#idle_remaining_s == 0);
    unsafe { lm_kiosk_push_done() };
    // Brightness came back to the snapshot's (welcome echoes it).
    match send(w, now, CMsg::Hello(pb::Hello::default())) {
        Some(SMsg::Welcome(wl)) => assert!((wl.brightness().copied().unwrap() - 0.4).abs() < 1e-3),
        other => panic!("welcome expected, got {other:?}"),
    }
    // No second revert without new activity.
    assert_eq!(unsafe { lm_kiosk_tick(now + 60_000, true, true) }, 0);

    // The console recovery path.
    let mut reply = [0u8; 160];
    let line = b" off";
    let g1 = unsafe { lm_kiosk_gen() };
    let rn = unsafe { lm_kiosk_console(line.as_ptr(), line.len(), reply.as_mut_ptr(), reply.len()) };
    assert!(rn > 0);
    assert!(String::from_utf8_lossy(&reply[..rn as usize]).contains("disabled"));
    assert_ne!(unsafe { lm_kiosk_gen() }, g1);
    assert!(!unsafe { lm_kiosk_enabled() });
    assert!(matches!(rename(b, now), Some(SMsg::Welcome(_))), "unlocked for everyone");
    let bad = b" bogus";
    assert_eq!(unsafe { lm_kiosk_console(bad.as_ptr(), bad.len(), reply.as_mut_ptr(), reply.len()) }, -1);

    // Boot: the enabled record seeds the kiosk and asks for the attract boot.
    assert!(unsafe { lm_kiosk_seed(rec.as_ptr(), rec.len()) });
    assert!(unsafe { lm_kiosk_enabled() });
    assert!(!unsafe { lm_kiosk_seed(core::ptr::null(), 0) } || unsafe { lm_kiosk_enabled() });
    let _ = k::EVENT_NONE;
}
