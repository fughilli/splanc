//! FX decks + crossfade + uniform keypoints through the C ABI
//! (docs/design/uniform-keypoints.md): deck B loads beside deck A and the
//! crossfade blends them; keypoints save the live uniforms by name into the
//! (here: in-memory) store, list/get/delete, recall by name across a recompiled
//! effect, blend in parameter space (RGB + HSV), morph per frame, and a
//! set_uniforms cancels the morph. One test: the FFI state is process-global.

use std::collections::HashMap;
use std::sync::Mutex;

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    encode_control_ack, lm_fx_last_deck, lm_fx_shade, lm_fx_update, lm_kp_commit, lm_kp_commit_frame,
    lm_kp_set_store, lm_last_was_live_control, lm_player_handle, lm_player_init, lm_set_uniforms_commit,
    lm_take_control_ack, FEATURES, FX_TOPO_CAP,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

static STORE: Mutex<Option<HashMap<String, Vec<u8>>>> = Mutex::new(None);

fn file_name(p: *const u8, n: usize) -> String {
    String::from_utf8(unsafe { std::slice::from_raw_parts(p, n) }.to_vec()).unwrap()
}

unsafe extern "C" fn st_read(name: *const u8, nl: usize, buf: *mut u8, cap: usize) -> i32 {
    let g = STORE.lock().unwrap();
    match g.as_ref().unwrap().get(&file_name(name, nl)) {
        Some(v) if v.len() <= cap => {
            std::ptr::copy_nonoverlapping(v.as_ptr(), buf, v.len());
            v.len() as i32
        }
        _ => -1,
    }
}

unsafe extern "C" fn st_write(name: *const u8, nl: usize, buf: *const u8, len: usize) -> bool {
    let v = std::slice::from_raw_parts(buf, len).to_vec();
    STORE.lock().unwrap().as_mut().unwrap().insert(file_name(name, nl), v);
    true
}

unsafe extern "C" fn st_remove(name: *const u8, nl: usize) {
    STORE.lock().unwrap().as_mut().unwrap().remove(&file_name(name, nl));
}

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle(msg: CMsg) -> Option<SMsg> {
    let frame = encode(msg);
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn err_code(r: Option<SMsg>) -> String {
    match r {
        Some(SMsg::Error(e)) => e.r#code.as_str().to_string(),
        other => panic!("expected an error, got {other:?}"),
    }
}

/// A raw protobuf LEN field (the generated SubmitEffect.fxb keeps the 64 B
/// default cap — the firmware walks it zero-copy — so submit is hand-encoded).
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

fn submit(deck: u32, id: &str, src: &str) -> Option<SMsg> {
    let fxb = ledmapper_fx_compiler::compile(src).expect("compiles").fxb;
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, &fxb));
    body.extend([3 << 3, 1, 4 << 3, deck as u8]);
    let frame = len_field(21, &body);
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n > 0);
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn uv(slot: u32, v: &[f32]) -> pb::UniformValue {
    let mut u = pb::UniformValue { r#slot: slot, ..Default::default() };
    u.r#value.extend_from_slice(v).unwrap();
    u
}

fn set_uniforms(deck: u32, vals: &[pb::UniformValue], commit: Option<bool>) {
    let mut m = pb::SetUniforms { r#deck: deck, ..Default::default() };
    for v in vals {
        m.r#values.push(v.clone()).unwrap();
    }
    if let Some(c) = commit {
        m.set_commit(c);
    }
    assert!(matches!(handle(CMsg::SetUniforms(m)), Some(SMsg::PlaybackState(_))));
}

fn save(deck: u32, name: &str) -> Option<SMsg> {
    let mut m = pb::SaveKeypoint { r#deck: deck, ..Default::default() };
    m.r#name = name.parse().unwrap();
    handle(CMsg::SaveKeypoint(m))
}

fn list(deck: u32) -> pb::KeypointList {
    match handle(CMsg::ListKeypoints(pb::ListKeypoints { r#deck: deck, ..Default::default() })) {
        Some(SMsg::KeypointList(l)) => l,
        other => panic!("expected keypoint_list, got {other:?}"),
    }
}

fn names(l: &pb::KeypointList) -> Vec<(u32, String, bool)> {
    l.r#keypoints.iter().map(|k| (k.r#index, k.r#name.as_str().to_string(), k.r#stale)).collect()
}

fn blend(deck: u32, w: &[(&str, f32)], seconds: f32, color_mode: u32, commit: bool) -> Option<SMsg> {
    let mut m = pb::BlendKeypoints { r#deck: deck, r#seconds: seconds, r#color_mode: color_mode, ..Default::default() };
    for (n, x) in w {
        let mut kw = pb::KeypointWeight { r#weight: *x, ..Default::default() };
        kw.r#name = n.parse().unwrap();
        m.r#weights.push(kw).unwrap();
    }
    if commit {
        m.set_commit(true);
    }
    handle(CMsg::BlendKeypoints(m))
}

fn crossfade(pos: f64, mode: u32) {
    match handle(CMsg::SetCrossfade(pb::SetCrossfade { r#position: pos, r#mode: mode, ..Default::default() })) {
        Some(SMsg::Welcome(w)) => {
            assert_eq!(w.crossfade(), Some(&pos.clamp(0.0, 1.0)));
            assert_eq!(w.crossfade_mode(), Some(&mode));
        }
        other => panic!("expected welcome, got {other:?}"),
    }
}

/// One frame (dt seconds), then LED 0's colour.
fn frame(dt: f32) -> [u8; 3] {
    assert!(unsafe { lm_fx_update(0.0, dt, 0, 1) });
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

/// SOLID recompiled with the uniforms reordered (slots move).
const SOLID_V2: &str = r#"uniform float gain : 0.0 .. 1.0 = 1.0;
uniform vec3 tint : color = 1.0, 0.0, 0.0;
void update() {}
vec3 shade(Led led) { return tint * gain; }"#;

const GREEN: &str = r#"void update() {}
vec3 shade(Led led) { return vec3(0.0, 1.0, 0.0); }"#;

#[test]
fn decks_crossfade_and_keypoints() {
    *STORE.lock().unwrap() = Some(HashMap::new());
    lm_player_init(1);
    for f in ["decks", "crossfade", "keypoints"] {
        assert!(FEATURES.contains(&f), "{f} advertised");
    }

    // Without store hooks the keypoint arms refuse cleanly.
    assert!(matches!(submit(0, "solid", SOLID), Some(SMsg::ResultReady(_))));
    assert_eq!(err_code(save(0, "red")), "no_store");
    unsafe { lm_kp_set_store(Some(st_read), Some(st_write), Some(st_remove)) };

    // -- keypoints on deck A ---------------------------------------------------
    // (The device doesn't apply manifest defaults; the client sends uniforms.)
    set_uniforms(0, &[uv(0, &[1.0, 0.0, 0.0]), uv(3, &[1.0])], None);
    assert!(unsafe { lm_set_uniforms_commit() });
    assert!(near(frame(0.03), [255, 0, 0]));
    let l = match save(0, "red") {
        Some(SMsg::KeypointList(l)) => l,
        other => panic!("save replies keypoint_list, got {other:?}"),
    };
    assert_eq!(l.r#effect_id.as_str(), "solid");
    assert_eq!(l.r#capacity, 16);
    assert_eq!(names(&l), vec![(0, "red".into(), false)]);
    // tint is slot 0..2, gain 3.
    set_uniforms(0, &[uv(0, &[0.0, 0.0, 1.0])], Some(false));
    assert!(!unsafe { lm_set_uniforms_commit() });
    assert!(near(frame(0.03), [0, 0, 255]));
    save(0, "blue");
    // Re-saving a name overwrites in place (same index).
    set_uniforms(0, &[uv(0, &[0.0, 0.0, 1.0]), uv(3, &[0.5])], Some(false));
    save(0, "blue");
    set_uniforms(0, &[uv(3, &[1.0])], Some(false));
    assert_eq!(names(&list(0)), vec![(0, "red".into(), false), (1, "blue".into(), false)]);
    assert_eq!(err_code(save(0, "")), "bad_keypoint");

    // get_keypoint: by name + resolved to slots.
    let mut g = pb::GetKeypoint::default();
    g.r#name = "blue".parse().unwrap();
    match handle(CMsg::GetKeypoint(g)) {
        Some(SMsg::Keypoint(k)) => {
            assert_eq!((k.r#index, k.r#name.as_str(), k.r#stale), (1, "blue", false));
            let tint = k.r#values.iter().find(|v| v.r#uniform.as_str() == "tint").unwrap();
            assert_eq!(&tint.r#value[..], &[0.0, 0.0, 1.0]);
            let gain = k.r#slots.iter().find(|v| v.r#slot == 3).unwrap();
            assert_eq!(&gain.r#value[..], &[0.5]);
        }
        other => panic!("expected keypoint, got {other:?}"),
    }

    // Recall at once (the fader path).
    assert!(matches!(blend(0, &[("red", 1.0)], 0.0, 0, false), Some(SMsg::PlaybackState(_))));
    assert!(near(frame(0.03), [255, 0, 0]));
    // A 50/50 blend in linear RGB: tint (0.5, 0, 0.5), gain 0.75.
    blend(0, &[("red", 1.0), ("blue", 1.0)], 0.0, 0, false);
    assert!(near(frame(0.03), [96, 0, 96]), "{:?}", frame(0.0));
    // In HSV the hue takes the short arc red -> magenta -> blue: full saturation.
    blend(0, &[("red", 1.0), ("blue", 1.0)], 0.0, 1, false);
    assert!(near(frame(0.03), [191, 0, 191]), "{:?}", frame(0.0));
    assert_eq!(err_code(blend(0, &[("nope", 1.0)], 0.0, 0, false)), "no_keypoint");
    assert_eq!(err_code(blend(0, &[("red", 0.0)], 0.0, 0, false)), "bad_keypoint");

    // A morph: red -> blue over 1 s, advanced per frame by lm_fx_update.
    blend(0, &[("red", 1.0)], 0.0, 0, false);
    frame(0.03);
    blend(0, &[("blue", 1.0)], 1.0, 0, false);
    let mid = frame(0.5); // smoothstep(0.5) = 0.5 → tint (.5,0,.5), gain .75
    assert!(near(mid, [96, 0, 96]), "{mid:?}");
    let end = frame(0.6);
    assert!(near(end, [0, 0, 128]), "{end:?}");
    // set_uniforms cancels a running morph (the slider wins).
    blend(0, &[("red", 1.0)], 1.0, 0, false);
    frame(0.25);
    set_uniforms(0, &[uv(0, &[0.0, 1.0, 0.0]), uv(3, &[1.0])], Some(false));
    assert!(near(frame(0.5), [0, 255, 0]));

    // commit: the blend's target becomes a deck-A set_uniforms frame.
    blend(0, &[("red", 1.0)], 0.0, 0, true);
    assert!(unsafe { lm_kp_commit() });
    let mut fr = [0u8; 512];
    let n = unsafe { lm_kp_commit_frame(fr.as_mut_ptr(), fr.len()) };
    assert!(n > 0);
    let mut env = pb::ClientMessage::default();
    env.decode_from_bytes(&fr[..n as usize]).unwrap();
    match env.r#msg {
        Some(CMsg::SetUniforms(m)) => {
            let tint = m.r#values.iter().find(|v| v.r#slot == 0).unwrap();
            assert_eq!(&tint.r#value[..], &[1.0, 0.0, 0.0]);
        }
        other => panic!("commit frame is set_uniforms, got {other:?}"),
    }
    blend(0, &[("red", 1.0)], 0.0, 0, false);
    assert!(!unsafe { lm_kp_commit() });

    // A recompiled effect under the same id: keypoints survive, reported stale,
    // and still recall by NAME although the slots moved.
    assert!(matches!(submit(0, "solid", SOLID_V2), Some(SMsg::ResultReady(_))));
    assert_eq!(names(&list(0)), vec![(0, "red".into(), true), (1, "blue".into(), true)]);
    blend(0, &[("blue", 1.0)], 0.0, 0, false);
    assert!(near(frame(0.03), [0, 0, 128]));
    // Delete.
    let mut del = pb::DeleteKeypoint::default();
    del.r#name = "red".parse().unwrap();
    match handle(CMsg::DeleteKeypoint(del.clone())) {
        Some(SMsg::KeypointList(l)) => assert_eq!(names(&l), vec![(1, "blue".into(), true)]),
        other => panic!("{other:?}"),
    }
    assert_eq!(err_code(handle(CMsg::DeleteKeypoint(del))), "no_keypoint");
    // The cache must not serve a deleted keypoint.
    assert_eq!(err_code(blend(0, &[("red", 1.0)], 0.0, 0, false)), "no_keypoint");
    // Capacity: 16 per effect.
    for i in 0..15 {
        assert!(matches!(save(0, &format!("k{i}")), Some(SMsg::KeypointList(_))));
    }
    assert_eq!(err_code(save(0, "one-too-many")), "keypoint_full");
    // Listing another effect's keypoints by id (not loaded): none yet.
    let lo = match handle(CMsg::ListKeypoints({
        let mut m = pb::ListKeypoints::default();
        m.set_effect_id("other".parse().unwrap());
        m
    })) {
        Some(SMsg::KeypointList(l)) => l,
        other => panic!("{other:?}"),
    };
    assert_eq!((lo.r#effect_id.as_str(), lo.r#keypoints.len()), ("other", 0));

    // -- deck B + crossfade ------------------------------------------------------
    assert!(matches!(submit(0, "solid", SOLID), Some(SMsg::ResultReady(_))));
    blend(0, &[("blue", 1.0)], 0.0, 0, false); // tint (0,0,1) gain .5 → (0,0,128)
    assert!(near(frame(0.03), [0, 0, 128]));
    assert!(matches!(submit(1, "green", GREEN), Some(SMsg::ResultReady(_))));
    assert_eq!(unsafe { lm_fx_last_deck() }, 1);
    crossfade(0.0, 0);
    assert!(near(frame(0.03), [0, 0, 128]));
    crossfade(1.0, 0);
    assert!(near(frame(0.03), [0, 255, 0]));
    crossfade(0.5, 0);
    assert!(near(frame(0.03), [0, 128, 64]));
    crossfade(7.0, 1); // clamps to 1

    // -- live-control acks (docs/design/live-control.md) -------------------------
    // A seq'd set_crossfade / set_uniforms is still applied (and its legacy reply
    // computed, for persistence), then swapped for a tiny ControlAck{seq}.
    assert!(FEATURES.contains(&"control_ack"));
    let ack = |msg: CMsg, seq: u32| {
        let r = handle(msg);
        assert!(unsafe { lm_last_was_live_control() });
        let mut out = [0u8; 64];
        let n = unsafe { lm_take_control_ack(out.as_mut_ptr(), out.len()) };
        if seq == 0 {
            assert_eq!(n, 0, "a legacy update keeps its reply");
            return r;
        }
        assert!(n > 0 && n <= 8, "ack is tiny ({n} B)");
        let mut reply = pb::ServerMessage::default();
        reply.decode_from_bytes(&out[..n as usize]).unwrap();
        match reply.r#msg {
            Some(SMsg::ControlAck(a)) => assert_eq!(a.r#seq, seq),
            other => panic!("expected control_ack, got {other:?}"),
        }
        // Taken once: the next call has nothing to swap.
        assert_eq!(unsafe { lm_take_control_ack(out.as_mut_ptr(), out.len()) }, 0);
        r
    };
    assert!(matches!(
        ack(CMsg::SetCrossfade(pb::SetCrossfade { r#position: 0.25, r#seq: 7, ..Default::default() }), 7),
        Some(SMsg::Welcome(_))
    ));
    assert!(near(frame(0.03), [0, 64, 96]), "the seq'd crossfade applied");
    ack(CMsg::SetCrossfade(pb::SetCrossfade { r#position: 1.0, ..Default::default() }), 0);
    let mut su = pb::SetUniforms { r#deck: 0, r#seq: 0xfffff, ..Default::default() };
    su.r#values.push(uv(3, &[0.5])).unwrap();
    su.set_commit(false);
    assert!(matches!(ack(CMsg::SetUniforms(su), 0xfffff), Some(SMsg::PlaybackState(_))));
    assert!(!unsafe { lm_set_uniforms_commit() });
    // Not a live control: no flag, no ack.
    handle(CMsg::ListEffects(pb::ListEffects::default()));
    assert!(!unsafe { lm_last_was_live_control() });
    let mut tiny = [0u8; 3];
    assert_eq!(encode_control_ack(1 << 20, &mut tiny), None, "too small a buffer is refused");

    match handle(CMsg::ListEffects(pb::ListEffects::default())) {
        Some(SMsg::EffectList(l)) => {
            let decks: Vec<_> = l.r#effects.iter().map(|e| (e.r#effect_id.as_str().to_string(), e.r#deck)).collect();
            assert_eq!(decks, vec![("solid".into(), 0), ("green".into(), 1)]);
        }
        other => panic!("{other:?}"),
    }
    // get_effect_uniforms per deck.
    match handle(CMsg::GetEffectUniforms(pb::GetEffectUniforms { r#deck: 1, ..Default::default() })) {
        Some(SMsg::EffectUniforms(u)) => assert_eq!((u.r#effect_id.as_str(), u.r#deck), ("green", 1)),
        other => panic!("{other:?}"),
    }
    // Parking deck B leaves deck A at full whatever the crossfade says.
    handle(CMsg::SetEffect(pb::SetEffect { r#deck: 1, ..Default::default() }));
    assert!(near(frame(0.03), [0, 0, 128]));
    handle(CMsg::SetEffect({
        let mut m = pb::SetEffect { r#deck: 1, ..Default::default() };
        m.r#effect_id = "green".parse().unwrap();
        m
    }));
    assert!(near(frame(0.03), [0, 255, 0]));
    // A second "off" frees deck B; deck A carries on.
    handle(CMsg::SetEffect(pb::SetEffect { r#deck: 1, ..Default::default() }));
    handle(CMsg::SetEffect(pb::SetEffect { r#deck: 1, ..Default::default() }));
    match handle(CMsg::ListEffects(pb::ListEffects::default())) {
        Some(SMsg::EffectList(l)) => assert_eq!(l.r#effects.len(), 1),
        other => panic!("{other:?}"),
    }
    assert!(near(frame(0.03), [0, 0, 128]));

    // The shared arena: two decks whose buffers don't fit together are refused.
    let big = "buffer vec4 a; buffer vec4 b; void update() {} vec3 shade(Led led) { a[led.idx] = vec4(1.0,0.0,0.0,1.0); b[led.idx] = a[led.idx]; return b[led.idx].xyz; }";
    if 2 * 2 * 16 * FX_TOPO_CAP > 24 * 1024 {
        assert!(matches!(submit(0, "bigA", big), Some(SMsg::ResultReady(_))));
        assert_eq!(err_code(submit(1, "bigB", big)), "effect_too_large");
        assert!(near(frame(0.03), [255, 0, 0]), "deck A unharmed");
    }
}
