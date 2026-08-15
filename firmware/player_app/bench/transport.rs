//! Transport profile: cost of applying ONE uniform update via the protobuf
//! `set_uniforms` path (`lm_player_handle`) vs the native OSC path
//! (`lm_osc_ingest`), FUG-121. Answers "is proto-for-transport significantly
//! better, i.e. worth keeping a bridge?" on the device-CPU axis.
//!
//! Both legs go through the SAME FFI against the host capacity profile, applying
//! the same slot-0 write to the same loaded effect, so the delta is the
//! per-update work each transport imposes on the player core:
//!
//! - proto: envelope arm-scan + micropb decode of `SetUniforms` + dispatch +
//!   encode the `playback_state` reply (the device answers every set_uniforms).
//! - OSC:   parse the datagram + resolve the address against the prebuilt table +
//!   apply.
//!
//! Caveat: the proto leg here EXCLUDES WebSocket framing and TLS record
//! encrypt/decrypt, which the real ws/wss path also pays per message — so the
//! measured proto cost is a LOWER BOUND. UDP/OSC has no such per-packet framing.
//! Host CPU, not the C6; the ratio is the portable signal.

use std::time::Instant;

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_load, lm_fx_set_active, lm_fx_update, lm_osc_ingest, lm_player_handle, lm_player_init,
};
use micropb::{MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn set_uniforms_frame(slot: u32, val: f32) -> Vec<u8> {
    let mut uv = pb::UniformValue::default();
    uv.r#slot = slot;
    uv.r#value.push(val).unwrap();
    let mut su = pb::SetUniforms::default();
    su.r#values.push(uv).unwrap();
    encode(CMsg::SetUniforms(su))
}

fn osc_packet(addr: &str, val: f32) -> Vec<u8> {
    let ostr = |s: &str| {
        let mut v = s.as_bytes().to_vec();
        v.push(0);
        while v.len() % 4 != 0 {
            v.push(0);
        }
        v
    };
    let mut v = ostr(addr);
    v.extend(ostr(",f"));
    v.extend_from_slice(&val.to_be_bytes());
    v
}

fn time<F: FnMut()>(iters: u32, mut f: F) -> f64 {
    let t = Instant::now();
    for _ in 0..iters {
        f();
    }
    t.elapsed().as_nanos() as f64 / iters as f64
}

fn main() {
    lm_player_init(64);
    let src = "uniform float k : 0.0 .. 1.0 = 0.5;\n\
               vec3 shade(Led led) { return vec3(k, 0.0, 0.0); }\n";
    let compiled = ledmapper_fx_compiler::compile(src).expect("compiles");
    assert!(unsafe { lm_fx_load(compiled.fxb.as_ptr(), compiled.fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 64) });

    let iters = 1_000_000u32;

    // proto set_uniforms via lm_player_handle (decode + dispatch + reply encode).
    let mut out = vec![0u8; 4096];
    let mut val = 0.0f32;
    let proto_ns = time(iters, || {
        val = if val >= 1.0 { 0.0 } else { val + 0.01 };
        let frame = set_uniforms_frame(0, val);
        let n = unsafe {
            lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len())
        };
        std::hint::black_box(n);
    });
    // The frame build itself (encode) is client-side, not device work — measure
    // it so we can subtract it from the proto figure for a fair device-only cost.
    let mut val2 = 0.0f32;
    let build_ns = time(iters, || {
        val2 = if val2 >= 1.0 { 0.0 } else { val2 + 0.01 };
        std::hint::black_box(set_uniforms_frame(0, val2));
    });

    // OSC via lm_osc_ingest (parse + resolve + apply).
    let mut val3 = 0.0f32;
    let osc_ns = time(iters, || {
        val3 = if val3 >= 1.0 { 0.0 } else { val3 + 0.01 };
        let pkt = osc_packet("/k", val3);
        let n = unsafe { lm_osc_ingest(pkt.as_ptr(), pkt.len()) };
        std::hint::black_box(n);
    });
    let mut val4 = 0.0f32;
    let osc_build_ns = time(iters, || {
        val4 = if val4 >= 1.0 { 0.0 } else { val4 + 0.01 };
        std::hint::black_box(osc_packet("/k", val4));
    });

    let proto_dev = proto_ns - build_ns;
    let osc_dev = osc_ns - osc_build_ns;
    println!("per uniform update (device-side work, host CPU; frame/packet build subtracted):");
    println!("  proto set_uniforms (lm_player_handle, decode+dispatch+reply):  {proto_dev:.1} ns");
    println!("      (+ WebSocket framing + TLS per message on the real path — NOT counted here)");
    println!("  osc   lm_osc_ingest (parse+resolve+apply):                     {osc_dev:.1} ns");
    println!("  proto / osc ratio: {:.1}x", proto_dev / osc_dev);
    println!("(includes client-side build: proto {build_ns:.1} ns, osc {osc_build_ns:.1} ns)");
}
