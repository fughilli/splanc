//! Video present-at scheduling through the C ABI (SetTexture.seq / present_at_ms,
//! TextureAck, lm_tex_present): frames scheduled on the shared time base are held
//! in the jitter buffer and shown at a render frame boundary once due; the newest
//! due frame wins; late frames are dropped but still decoded (delta chain holds);
//! without a time base / present_at the old show-on-arrival behaviour stands.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update, lm_player_handle, lm_player_init,
    lm_tex_ingest, lm_tex_present, FEATURES,
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

fn handle_at(msg: CMsg, now_ms: i64) -> Option<SMsg> {
    let frame = encode(msg);
    let mut out = vec![0u8; 4096];
    let n = unsafe {
        lm_player_handle(frame.as_ptr(), frame.len(), now_ms, now_ms, out.as_mut_ptr(), out.len())
    };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

/// A uniform 2x2 GRAY8 frame of `v` (keyframe unless `delta`), seq + present_at.
fn frame(v: u8, delta: bool, seq: u32, present_at: u32) -> CMsg {
    CMsg::SetTexture(pb::SetTexture {
        r#tex_index: 0,
        r#format: 3, // GRAY8
        r#width: 2,
        r#height: 2,
        r#flags: u32::from(delta),
        r#data: micropb::heapless::Vec::from_slice(&[v; 4]).unwrap(),
        r#seq: seq,
        r#present_at_ms: present_at,
        ..Default::default()
    })
}

fn shown() -> u8 {
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 4) });
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    rgb[0]
}

fn ack(r: Option<SMsg>) -> pb::TextureAck {
    match r {
        Some(SMsg::TextureAck(a)) => a,
        other => panic!("expected texture_ack, got {other:?}"),
    }
}

#[test]
fn present_at_holds_frames_until_due_and_shows_the_newest() {
    lm_player_init(64);
    assert!(FEATURES.contains(&"texture_ack"));
    let fxb = ledmapper_fx_compiler::compile(
        "texture vec3 v(2, 2);\nvoid update() {}\nvec3 shade(Led led) { return sample(v, led.uv); }\n",
    )
    .expect("compiles")
    .fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };

    // No seq, no time base: shown on arrival, no reply (the old contract).
    assert!(handle_at(frame(10, false, 0, 0), 1000).is_none());
    assert_eq!(shown(), 10);
    // A seq asks for an ack; present_at without a time base still shows at once.
    let a = ack(handle_at(frame(20, false, 1, 5000), 1000));
    assert_eq!((a.r#seq, a.r#shown_seq, a.r#queued), (1, 1, 0));
    assert_eq!(shown(), 20);

    // Shared time base: epoch at device ms 10_000 -> effect time = now - 10_000.
    handle_at(CMsg::SetTimeBase(pb::SetTimeBase { r#epoch_ms: 10_000, ..Default::default() }), 10_000);
    // Frames for effect time 100 / 133 / 166 arrive early (at effect time 40..60).
    let a = ack(handle_at(frame(30, false, 2, 100), 10_040));
    assert_eq!(a.r#queued, 1);
    ack(handle_at(frame(40 ^ 30, true, 3, 133), 10_050)); // delta vs 30 -> 40
    let a = ack(handle_at(frame(50 ^ 40, true, 4, 166), 10_060)); // -> 50
    assert_eq!(a.r#queued, 3);
    assert_eq!(shown(), 20, "nothing due yet: the old frame stays");
    unsafe { lm_tex_present(10_099) };
    assert_eq!(shown(), 20, "1 ms early");
    unsafe { lm_tex_present(10_100) };
    assert_eq!(shown(), 30, "frame 2 shown exactly at its present time");
    // A render that comes late (both 3 and 4 due): the newest wins, 3 is dropped.
    unsafe { lm_tex_present(10_170) };
    assert_eq!(shown(), 50);
    let a = ack(handle_at(frame(0, true, 5, 300), 10_171)); // zero delta, queued
    assert_eq!((a.r#shown_seq, a.r#shown_late_ms, a.r#dropped, a.r#queued), (4, 4, 1, 1));
    assert_eq!(a.r#shown_at_ms, 170);

    // A frame arriving > 66 ms after its present time is decoded but not shown
    // (the queued one before it is stale too)...
    unsafe { lm_tex_present(10_300) }; // show seq 5 (still 50)
    let a = ack(handle_at(frame(60 ^ 50, true, 6, 310), 10_400));
    assert_eq!(a.r#shown_seq, 5, "seq 6 was 90 ms late: dropped");
    assert_eq!(shown(), 50);
    // ...but the delta chain held: the next on-time delta decodes against 60.
    ack(handle_at(frame(70 ^ 60, true, 7, 420), 10_410));
    unsafe { lm_tex_present(10_420) };
    assert_eq!(shown(), 70);
    // A stream that is late everywhere still plays once nothing was shown for 250 ms.
    let a = ack(handle_at(frame(80 ^ 70, true, 8, 500), 10_700));
    assert_eq!((a.r#shown_seq, a.r#shown_late_ms), (8, 200));
    assert_eq!(shown(), 80);
}

#[test]
fn lock_free_ingest_queues_every_frame_for_the_next_frame_boundary() {
    lm_player_init(64);
    let fxb = ledmapper_fx_compiler::compile(
        "texture vec3 v(2, 2);\nvoid update() {}\nvec3 shade(Led led) { return sample(v, led.uv); }\n",
    )
    .expect("compiles")
    .fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    let ingest = |msg: CMsg, now: i64| -> i32 {
        let f = encode(msg);
        let mut out = vec![0u8; 512];
        unsafe { lm_tex_ingest(f.as_ptr(), f.len(), now, out.as_mut_ptr(), out.len()) }
    };
    // Not a set_texture: refused, for the normal dispatch.
    assert_eq!(ingest(CMsg::GetEffectUniforms(Default::default()), 5), -2);
    // No present time, no seq: queued (not shown yet), no reply.
    assert_eq!(ingest(frame(10, false, 0, 0), 100), 0);
    assert_eq!(shown(), 0, "the arena is only written at a frame boundary");
    unsafe { lm_tex_present(101) };
    assert_eq!(shown(), 10);
    // Two frames between renders: the newer one wins at the boundary.
    assert!(ingest(frame(20 ^ 10, true, 1, 0), 110) > 0, "seq -> ack");
    assert!(ingest(frame(30 ^ 20, true, 2, 0), 115) > 0);
    unsafe { lm_tex_present(120) };
    assert_eq!(shown(), 30);
    // INDEXED8 (per-frame palette) can't be queued: back to the locked path.
    let idx = CMsg::SetTexture(pb::SetTexture {
        r#tex_index: 0,
        r#format: 4,
        r#width: 2,
        r#height: 2,
        r#data: micropb::heapless::Vec::from_slice(&[0; 4]).unwrap(),
        ..Default::default()
    });
    assert_eq!(ingest(idx, 130), -3);
}
