//! Canned interpolation profiles through the C ABI (docs/design/ramps.md):
//! ramp_uniforms follows its ease on the device clock and lands exactly (event
//! + commit frame), a live set_uniforms cancels a ramp mid-way, start_at holds
//! then joins, the crossfade ramp + a live set_crossfade override, the 16-lane
//! cap, cancel_ramp, a keypoint morph as a ramp (ease + id + event), and the
//! error codes. One test: the FFI state is process-global.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Mutex;

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_shade, lm_fx_update, lm_kp_set_store, lm_player_handle, lm_player_init, lm_ramp_take_commit_frame,
    lm_ramp_take_event_frame, lm_ramp_tick, FEATURES,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

static NOW: AtomicI64 = AtomicI64::new(10_000);
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

fn now() -> i64 {
    NOW.load(Ordering::Relaxed)
}

fn raw(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), now(), now(), out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn handle(msg: CMsg) -> Option<SMsg> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 8192>::new());
    env.encode(&mut enc).unwrap();
    raw(&enc.into_writer())
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

fn submit(deck: u32, id: &str, src: &str) {
    let fxb = ledmapper_fx_compiler::compile(src).expect("compiles").fxb;
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, &fxb));
    body.extend([3 << 3, 1, 4 << 3, deck as u8]);
    assert!(matches!(raw(&len_field(21, &body)), Some(SMsg::ResultReady(_))));
}

fn uv(slot: u32, v: &[f32]) -> pb::UniformValue {
    let mut u = pb::UniformValue {
        r#slot: slot,
        ..Default::default()
    };
    u.r#value.extend_from_slice(v).unwrap();
    u
}

fn set_uniforms(deck: u32, vals: &[pb::UniformValue]) {
    let mut m = pb::SetUniforms {
        r#deck: deck,
        ..Default::default()
    };
    for v in vals {
        m.r#values.push(v.clone()).unwrap();
    }
    m.set_commit(false);
    assert!(matches!(handle(CMsg::SetUniforms(m)), Some(SMsg::PlaybackState(_))));
}

struct Ramp {
    deck: u32,
    targets: Vec<pb::UniformValue>,
    ms: u32,
    ease: u32,
    start_at: i64,
    id: u32,
    commit: Option<bool>,
}

impl Default for Ramp {
    fn default() -> Self {
        Ramp {
            deck: 0,
            targets: vec![],
            ms: 1000,
            ease: 0,
            start_at: 0,
            id: 0,
            commit: None,
        }
    }
}

fn ramp(r: Ramp) -> Option<SMsg> {
    let mut m = pb::RampUniforms {
        r#deck: r.deck,
        r#duration_ms: r.ms,
        r#ease: r.ease,
        r#start_at_ms: r.start_at,
        r#id: r.id,
        ..Default::default()
    };
    for t in r.targets {
        m.r#targets.push(t).unwrap();
    }
    if let Some(c) = r.commit {
        m.set_commit(c);
    }
    handle(CMsg::RampUniforms(m))
}

fn started(r: Option<SMsg>) -> pb::RampState {
    match r {
        Some(SMsg::RampState(s)) if s.r#state == 0 => s,
        other => panic!("expected ramp_state STARTED, got {other:?}"),
    }
}

/// Advance the device clock by `ms`, tick the ramps, render one frame and
/// return LED 0.
fn frame(ms: i64) -> [u8; 3] {
    let t = NOW.fetch_add(ms, Ordering::Relaxed) + ms;
    unsafe { lm_ramp_tick(t) };
    assert!(unsafe { lm_fx_update(0.0, ms as f32 / 1000.0, 0, 1) });
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    rgb
}

fn events() -> Vec<(u32, u32, u32)> {
    let mut v = Vec::new();
    loop {
        let mut out = [0u8; 256];
        let n = unsafe { lm_ramp_take_event_frame(out.as_mut_ptr(), out.len()) };
        if n == 0 {
            return v;
        }
        assert!(n > 0);
        let mut m = pb::ServerMessage::default();
        m.decode_from_bytes(&out[..n as usize]).unwrap();
        match m.r#msg {
            Some(SMsg::RampState(s)) => v.push((s.r#id, s.r#state, s.r#kind)),
            other => panic!("event is ramp_state, got {other:?}"),
        }
    }
}

fn near(a: [u8; 3], b: [u8; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (*x as i32 - y as i32).abs() <= 2)
}

/// tint slots 0..2, gain 3.
const SOLID: &str = r#"uniform vec3 tint : color = 1.0, 1.0, 1.0;
uniform float gain : 0.0 .. 1.0 = 1.0;
void update() {}
vec3 shade(Led led) { return tint * gain; }"#;

const GREEN: &str = r#"void update() {}
vec3 shade(Led led) { return vec3(0.0, 1.0, 0.0); }"#;

const DONE: u32 = 1;
const CANCELLED: u32 = 2;

#[test]
fn ramps_through_the_c_abi() {
    *STORE.lock().unwrap() = Some(HashMap::new());
    lm_player_init(1);
    assert!(FEATURES.contains(&"ramps"));
    unsafe { lm_kp_set_store(Some(st_read), Some(st_write), Some(st_remove)) };

    // No effect yet: refused.
    assert_eq!(
        err_code(ramp(Ramp {
            targets: vec![uv(3, &[1.0])],
            ..Default::default()
        })),
        "no_effect"
    );
    submit(0, "solid", SOLID);
    set_uniforms(0, &[uv(0, &[1.0, 1.0, 1.0]), uv(3, &[0.0])]);
    assert!(near(frame(10), [0, 0, 0]));

    // -- a linear ramp of gain 0 -> 1 over 1 s lands exactly, reports, commits --
    let s = started(ramp(Ramp {
        targets: vec![uv(3, &[1.0])],
        id: 7,
        ..Default::default()
    }));
    assert_eq!(
        (s.r#id, s.r#kind, s.r#start_at_ms, s.r#end_at_ms),
        (7, 0, now(), now() + 1000)
    );
    assert_eq!(s.r#active, 1);
    let quarter = frame(250);
    assert!(near(quarter, [64, 64, 64]), "{quarter:?}");
    assert!(near(frame(250), [128, 128, 128]));
    assert!(events().is_empty());
    let mut fr = [0u8; 512];
    assert_eq!(
        unsafe { lm_ramp_take_commit_frame(fr.as_mut_ptr(), fr.len()) },
        0,
        "nothing landed yet"
    );
    assert_eq!(frame(500), [255, 255, 255]);
    assert_eq!(events(), vec![(7, DONE, 0)]);
    // Landed + commit unset (= persist): deck A's uniforms as a set_uniforms frame.
    let n = unsafe { lm_ramp_take_commit_frame(fr.as_mut_ptr(), fr.len()) };
    assert!(n > 0);
    let mut env = pb::ClientMessage::default();
    env.decode_from_bytes(&fr[..n as usize]).unwrap();
    match env.r#msg {
        Some(CMsg::SetUniforms(m)) => {
            assert_eq!(&m.r#values.iter().find(|v| v.r#slot == 3).unwrap().r#value[..], &[1.0]);
            assert_eq!(
                &m.r#values.iter().find(|v| v.r#slot == 0).unwrap().r#value[..],
                &[1.0, 1.0, 1.0]
            );
        }
        other => panic!("commit frame is set_uniforms, got {other:?}"),
    }
    assert_eq!(
        unsafe { lm_ramp_take_commit_frame(fr.as_mut_ptr(), fr.len()) },
        0,
        "once"
    );

    // -- a live set cancels the ramp on its uniform mid-way (last writer wins) --
    started(ramp(Ramp {
        targets: vec![uv(3, &[0.0]), uv(0, &[1.0, 0.0, 0.0])],
        id: 8,
        ..Default::default()
    }));
    frame(500); // gain .5, tint (1, .5, .5)
    set_uniforms(0, &[uv(3, &[0.9])]);
    let after = frame(250); // gain stays .9; tint still ramping (.75 of the way)
    assert!(near(after, [230, 57, 57]), "{after:?}");
    assert!(events().is_empty(), "tint is still running");
    assert!(near(frame(500), [230, 0, 0]));
    assert_eq!(events(), vec![(8, CANCELLED, 0)], "partly overridden");
    assert_eq!(
        unsafe { lm_ramp_take_commit_frame(fr.as_mut_ptr(), fr.len()) },
        0,
        "a cancelled ramp doesn't persist"
    );

    // -- start_at: holds until then, eases from there; commit=false never persists --
    set_uniforms(0, &[uv(0, &[1.0, 1.0, 1.0]), uv(3, &[0.0])]);
    let at = now() + 500;
    let s = started(ramp(Ramp {
        targets: vec![uv(3, &[1.0])],
        start_at: at,
        ease: 1, // ease (cubic in-out)
        id: 9,
        commit: Some(false),
        ..Default::default()
    }));
    assert_eq!((s.r#start_at_ms, s.r#end_at_ms), (at, at + 1000));
    assert!(near(frame(400), [0, 0, 0]), "holds before start_at");
    assert!(near(frame(350), [16, 16, 16]), "ease(0.25) = 0.0625"); // t = 250 ms
    assert!(near(frame(250), [128, 128, 128]), "ease(0.5) = 0.5");
    frame(600);
    assert_eq!(events(), vec![(9, DONE, 0)]);
    assert_eq!(unsafe { lm_ramp_take_commit_frame(fr.as_mut_ptr(), fr.len()) }, 0);

    // -- errors + the 16-lane cap (all or nothing) --
    let r1 = |slot: u32| Ramp {
        targets: vec![uv(slot, &[0.5])],
        ms: 10_000,
        ..Default::default()
    };
    assert_eq!(err_code(ramp(Ramp { ease: 9, ..r1(3) })), "bad_ramp");
    assert_eq!(
        err_code(ramp(Ramp {
            start_at: now() + 700_000,
            ..r1(3)
        })),
        "bad_ramp"
    );
    assert_eq!(
        err_code(ramp(Ramp {
            targets: vec![],
            ..Default::default()
        })),
        "bad_ramp"
    );
    assert_eq!(
        err_code(ramp(Ramp {
            targets: vec![uv(127, &[1.0, 2.0])],
            ..Default::default()
        })),
        "bad_ramp"
    );
    assert_eq!(err_code(ramp(Ramp { deck: 1, ..r1(3) })), "no_effect");
    for slot in 0..16 {
        started(ramp(Ramp {
            id: 100 + slot,
            ..r1(10 + slot)
        }));
    }
    assert_eq!(err_code(ramp(r1(40))), "too_many_ramps");
    // Re-targeting a ramping uniform needs no new lane.
    let s = started(ramp(Ramp { id: 200, ..r1(10) }));
    assert_eq!(s.r#active, 16);
    assert_eq!(events(), vec![(100, CANCELLED, 0)]);
    // cancel_ramp id 0: everything stops, each reports.
    match handle(CMsg::CancelRamp(pb::CancelRamp { r#id: 0 })) {
        Some(SMsg::RampState(s)) => assert_eq!((s.r#state, s.r#active), (CANCELLED, 0)),
        other => panic!("{other:?}"),
    }
    assert_eq!(events().len(), 16);

    // -- keypoint morph as a ramp: ease + id + event; a uniform ramp takes over --
    set_uniforms(0, &[uv(0, &[1.0, 0.0, 0.0]), uv(3, &[1.0])]);
    assert!(matches!(
        handle(CMsg::SaveKeypoint({
            let mut m = pb::SaveKeypoint::default();
            m.r#name = "red".parse().unwrap();
            m
        })),
        Some(SMsg::KeypointList(_))
    ));
    set_uniforms(0, &[uv(0, &[0.0, 0.0, 1.0])]);
    let blend = |ease: Option<u32>, id: u32, seconds: f32| {
        let mut m = pb::BlendKeypoints {
            r#seconds: seconds,
            r#id: id,
            ..Default::default()
        };
        let mut kw = pb::KeypointWeight {
            r#weight: 1.0,
            ..Default::default()
        };
        kw.r#name = "red".parse().unwrap();
        m.r#weights.push(kw).unwrap();
        if let Some(e) = ease {
            m.set_ease(e);
        }
        assert!(matches!(handle(CMsg::BlendKeypoints(m)), Some(SMsg::PlaybackState(_))));
    };
    blend(Some(2), 21, 1.0); // ease_in: 0.125 at half time
    let q = frame(500);
    assert!(near(q, [32, 0, 223]), "{q:?}");
    assert!(near(frame(500), [255, 0, 0]));
    assert_eq!(events(), vec![(21, DONE, 2)]);
    set_uniforms(0, &[uv(0, &[0.0, 0.0, 1.0])]);
    blend(None, 22, 1.0); // unset ease = smoothstep (the original morph)
    assert!(near(frame(500), [128, 0, 128]));
    started(ramp(Ramp {
        targets: vec![uv(3, &[0.0])],
        id: 23,
        ..Default::default()
    }));
    assert_eq!(events(), vec![(22, CANCELLED, 2)], "the ramp took the deck over");
    frame(1000);
    assert_eq!(events(), vec![(23, DONE, 0)]);
    // An instant blend with an id reports at once.
    blend(None, 24, 0.0);
    assert_eq!(events(), vec![(24, DONE, 2)]);
    set_uniforms(0, &[uv(3, &[1.0])]);

    // -- crossfade ramp + a live set_crossfade overriding it --
    submit(1, "green", GREEN);
    let xf = |position: f64, ms: u32, id: u32| {
        handle(CMsg::RampCrossfade(pb::RampCrossfade {
            r#position: position,
            r#duration_ms: ms,
            r#id: id,
            ..Default::default()
        }))
    };
    let s = started(xf(1.0, 1000, 31));
    assert_eq!(s.r#kind, 1);
    assert_eq!(s.r#active, 1);
    assert!(near(frame(10), [252, 3, 0]));
    assert!(near(frame(490), [128, 128, 0]), "half way");
    match handle(CMsg::SetCrossfade(pb::SetCrossfade {
        r#position: 0.25,
        r#mode: 0,
    })) {
        Some(SMsg::Welcome(w)) => assert_eq!(w.crossfade(), Some(&0.25)),
        other => panic!("{other:?}"),
    }
    assert_eq!(events(), vec![(31, CANCELLED, 1)]);
    assert!(near(frame(250), [191, 64, 0]), "the live position holds");
    started(xf(0.0, 500, 32));
    assert!(near(frame(250), [223, 32, 0]), "0.25 -> 0 linearly");
    assert!(near(frame(250), [255, 0, 0]));
    assert_eq!(events(), vec![(32, DONE, 1)]);
    // Loading a new effect on a deck cancels its ramps.
    started(ramp(Ramp {
        targets: vec![uv(3, &[0.0])],
        id: 41,
        ..Default::default()
    }));
    submit(0, "solid", SOLID);
    assert_eq!(events(), vec![(41, CANCELLED, 0)]);
}
