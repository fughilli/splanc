//! #400: signed vec4 + mat4 uniforms through the C ABI. A mat4 starts at its
//! full identity default, a single 16-float UniformValue (set_uniforms, the
//! live mailbox) or a 16-arg OSC message sets it whole, and the current values
//! come back as <= 4-float chunks (so 4-float protocol readers keep working).
//! Own binary: the FFI state is process-global.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{lm_live_drain, lm_live_post, lm_osc_ingest, lm_player_handle, lm_player_init};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

const SRC: &str = r#"
uniform vec4 plane : -5 .. 5 = 0.0, 1.0, 0.0, 0.0;
uniform float width : 0.0 .. 1.0 = 0.1;
uniform vec3 glow = 1.0, 0.5, 0.1;
uniform mat4 pose;
vec3 shade(Led led) {
    vec3 p = transform(pose, led.pos);
    float d = abs(dot(plane.xyz, p) - plane.w);
    return glow * (1.0 - smoothstep(0.0, width, d));
}
"#;

fn varint(v: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        v.push((n as u8) | 0x80);
        n >>= 7;
    }
    v.push(n as u8);
}

fn len_field(f: u32, b: &[u8]) -> Vec<u8> {
    let mut v = Vec::new();
    varint(&mut v, ((f << 3) | 2) as u64);
    varint(&mut v, b.len() as u64);
    v.extend_from_slice(b);
    v
}

fn raw(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 8192];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes with the 4-float protocol types");
    reply.r#msg
}

fn handle(msg: CMsg) -> Option<SMsg> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 65536>::new());
    env.encode(&mut enc).unwrap();
    raw(&enc.into_writer())
}

/// set_uniforms{values: [{slot, value: vals}], commit?, seq?} hand-encoded: the
/// generated host type caps `value` at 4 floats, the device reads it in place.
fn set_uniforms_frame(values: &[(u32, &[f32])], commit: Option<bool>, seq: u32) -> Vec<u8> {
    let mut body = Vec::new();
    for (slot, vals) in values {
        let mut uv = Vec::new();
        uv.push(1 << 3);
        varint(&mut uv, *slot as u64);
        let floats: Vec<u8> = vals.iter().flat_map(|x| x.to_le_bytes()).collect();
        uv.extend(len_field(2, &floats));
        body.extend(len_field(1, &uv));
    }
    if let Some(c) = commit {
        body.extend([2 << 3, c as u8]);
    }
    if seq != 0 {
        body.push(4 << 3);
        varint(&mut body, seq as u64);
    }
    len_field(23, &body)
}

/// The deck-A uniform array as the device reports it (current values reassembled
/// from their <= 4-float chunks).
fn current() -> Vec<f32> {
    let Some(SMsg::EffectUniforms(e)) = handle(CMsg::GetEffectUniforms(pb::GetEffectUniforms::default())) else {
        panic!("expected effect_uniforms");
    };
    let mut u = vec![f32::NAN; 32];
    for cv in e.r#current.iter() {
        assert!(cv.r#value.len() <= 4, "a chunk is at most 4 floats");
        for (k, x) in cv.r#value.iter().enumerate() {
            u[cv.r#slot as usize + k] = *x;
        }
    }
    u
}

fn osc(addr: &str, vals: &[f32]) -> Vec<u8> {
    let pad = |mut v: Vec<u8>| {
        v.push(0);
        while v.len() % 4 != 0 {
            v.push(0);
        }
        v
    };
    let mut m = pad(addr.as_bytes().to_vec());
    m.extend(pad(format!(",{}", "f".repeat(vals.len())).into_bytes()));
    for x in vals {
        m.extend_from_slice(&x.to_be_bytes());
    }
    m
}

#[test]
fn wide_uniforms_end_to_end() {
    lm_player_init(1);
    let fxb = ledmapper_fx_compiler::compile(SRC).expect("compiles").fxb;
    let mut body = len_field(1, b"slice");
    body.extend(len_field(2, &fxb));
    body.extend([3 << 3, 1]);
    assert!(raw(&len_field(21, &body)).is_some());

    // Slots: plane 0..4, width 4, glow 5..8, pose 8..24 — the identity default.
    let u = current();
    assert_eq!(&u[0..4], &[0.0, 1.0, 0.0, 0.0]);
    let id: Vec<f32> = (0..16).map(|i| if i % 5 == 0 { 1.0 } else { 0.0 }).collect();
    assert_eq!(&u[8..24], &id[..], "the device starts a mat4 at its full 16-lane default");

    // One UniformValue carrying a whole mat4 + a negative vec4.
    let pose: Vec<f32> = (0..16).map(|i| i as f32 * 0.5 - 4.0).collect();
    let r = raw(&set_uniforms_frame(&[(8, &pose), (0, &[0.0, -0.6, 0.8, -1.5])], Some(false), 0));
    assert!(matches!(r, Some(SMsg::PlaybackState(_))));
    let u = current();
    assert_eq!(&u[8..24], &pose[..]);
    assert_eq!(&u[0..4], &[0.0, -0.6, 0.8, -1.5]);

    // The live channel (seq'd, uncommitted): stashed as 4-slot chunks, applied whole.
    let pose2: Vec<f32> = pose.iter().map(|x| -x).collect();
    let f = set_uniforms_frame(&[(8, &pose2), (4, &[0.25])], Some(false), 7);
    assert_eq!(unsafe { lm_live_post(f.as_ptr(), f.len()) }, 7);
    assert_eq!(unsafe { lm_live_drain() }, 5, "4 chunks + 1 scalar");
    let u = current();
    assert_eq!(&u[8..24], &pose2[..]);
    assert_eq!(u[4], 0.25);

    // OSC: the external API's addresses.
    let pkt = osc("/plane", &[0.0, 0.0, -1.0, 2.5]);
    assert_eq!(unsafe { lm_osc_ingest(pkt.as_ptr(), pkt.len()) }, 1);
    let pkt = osc("/pose", &id);
    assert_eq!(unsafe { lm_osc_ingest(pkt.as_ptr(), pkt.len()) }, 1);
    let pkt = osc("/pose/12", &[1.0, -2.0, 0.5]);
    assert_eq!(unsafe { lm_osc_ingest(pkt.as_ptr(), pkt.len()) }, 1);
    let pkt = osc("/pose/0/1", &[0.25]);
    assert_eq!(unsafe { lm_osc_ingest(pkt.as_ptr(), pkt.len()) }, 1);
    let u = current();
    assert_eq!(&u[0..4], &[0.0, 0.0, -1.0, 2.5]);
    let mut want = id.clone();
    want[12..15].copy_from_slice(&[1.0, -2.0, 0.5]);
    want[1] = 0.25;
    assert_eq!(&u[8..24], &want[..]);
}
