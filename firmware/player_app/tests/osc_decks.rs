//! Native OSC follows the VISIBLE FX deck (#402) through the C ABI: before a
//! crossfade it drives deck A; once a crossfade to deck B starts it drives B
//! (the incoming deck), resolving names against B's manifest; a per-axis or
//! per-element message (`/tint/y`, `/pose/12`) writes only the components it
//! names into B, so B keeps its own values in the rest and nothing of A's is
//! carried over; a 16-float `/pose` lands on B's mat4; a fade back (rollback) returns it
//! to A; two copies of the same effect are driven together; and a deploy onto
//! deck A while B shows brings OSC back to A. One test: the FFI state is
//! process-global.

use std::collections::HashMap;

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_osc_ingest, lm_player_handle, lm_player_init, osc_visible_deck, osc_xf_toward,
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

fn handle_frame(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 8192];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn handle(msg: CMsg) -> Option<SMsg> {
    handle_frame(&encode(msg))
}

/// A raw protobuf LEN field (SubmitEffect.fxb is hand-encoded: the generated
/// field keeps a 64 B default cap).
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

/// submit_effect(id, fxb, activate=true, deck).
fn submit(deck: u32, id: &str, src: &str) {
    let fxb = ledmapper_fx_compiler::compile(src).expect("compiles").fxb;
    let mut body = len_field(1, id.as_bytes());
    body.extend(len_field(2, &fxb));
    body.extend([3 << 3, 1, 4 << 3, deck as u8]);
    assert!(matches!(handle_frame(&len_field(21, &body)), Some(SMsg::ResultReady(_))));
}

fn set_effect(deck: u32, id: &str) {
    let mut m = pb::SetEffect { r#deck: deck, ..Default::default() };
    m.r#effect_id = id.parse().unwrap();
    assert!(handle(CMsg::SetEffect(m)).is_some());
}

fn crossfade(pos: f64) {
    let m = pb::SetCrossfade { r#position: pos, ..Default::default() };
    assert!(matches!(handle(CMsg::SetCrossfade(m)), Some(SMsg::Welcome(_))));
}

fn effect_uniforms(deck: u32) -> pb::EffectUniforms {
    let m = pb::GetEffectUniforms { r#deck: deck, ..Default::default() };
    match handle(CMsg::GetEffectUniforms(m)) {
        Some(SMsg::EffectUniforms(eu)) => eu,
        other => panic!("expected effect_uniforms, got {other:?}"),
    }
}

/// Deck `deck`'s live uniform values, by slot (get_effect_uniforms.current; a
/// value wider than 4 floats arrives as 4-float chunks at slot, slot+4, ...).
fn uniforms(deck: u32) -> HashMap<u32, Vec<f32>> {
    effect_uniforms(deck).r#current.iter().map(|v| (v.r#slot, v.r#value.to_vec())).collect()
}

/// `n` consecutive slots of deck `deck` from `slot`, joined across the chunks.
fn read(deck: u32, slot: u32, n: usize) -> Vec<f32> {
    let u = uniforms(deck);
    let mut out = Vec::new();
    let mut s = slot;
    while out.len() < n {
        let c = u.get(&s).unwrap_or_else(|| panic!("deck {deck} slot {s} not reported: {u:?}"));
        out.extend_from_slice(c);
        s += c.len() as u32;
    }
    out
}

/// A uniform's slot, from deck `deck`'s manifest.
fn slot_of(deck: u32, name: &str) -> u32 {
    let m: serde_json::Value = serde_json::from_slice(&effect_uniforms(deck).r#manifest).unwrap();
    let u = m.as_array().unwrap().iter().find(|u| u["name"] == name).unwrap();
    u["slot"].as_u64().unwrap() as u32
}

fn osc_str(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    while v.len() % 4 != 0 {
        v.push(0);
    }
    v
}

/// One OSC message of float args.
fn osc(addr: &str, args: &[f32]) -> u32 {
    let mut v = osc_str(addr);
    v.extend(osc_str(&format!(",{}", "f".repeat(args.len()))));
    for a in args {
        v.extend_from_slice(&a.to_be_bytes());
    }
    unsafe { lm_osc_ingest(v.as_ptr(), v.len()) }
}

// Deck A's effect: col = slots 0..2, k = slot 3.
const FX_A: &str = r#"uniform vec3 col : color = 0.0, 0.0, 0.0;
uniform float k : 0.0 .. 1.0 = 0.5;
void update() {}
vec3 shade(Led led) { return col * k; }"#;

// Deck B's: a different layout — tint = slots 0..2, gain = 3, k = 4, then a mat4
// pose (the tracker's 16 floats).
const FX_B: &str = r#"uniform vec3 tint : color = 0.1, 0.2, 0.3;
uniform float gain : 0.0 .. 1.0 = 1.0;
uniform float k : 0.0 .. 1.0 = 0.5;
uniform mat4 pose;
void update() {}
vec3 shade(Led led) { return tint * gain * k * transform(pose, led.pos).x; }"#;

#[test]
fn visible_deck_rule() {
    // A lone rendering deck is visible whatever the position.
    assert_eq!(osc_visible_deck(false, false, 0.5, 1), None);
    assert_eq!(osc_visible_deck(true, false, 1.0, 1), Some(0));
    assert_eq!(osc_visible_deck(false, true, 0.0, 0), Some(1));
    // Both: the endpoint's deck, mid-fade the incoming one.
    assert_eq!(osc_visible_deck(true, true, 0.0, 1), Some(0));
    assert_eq!(osc_visible_deck(true, true, 1.0, 0), Some(1));
    assert_eq!(osc_visible_deck(true, true, 0.3, 1), Some(1));
    assert_eq!(osc_visible_deck(true, true, 0.7, 0), Some(0));
    // The incoming deck: the way the position moves; unchanged when it holds.
    assert_eq!(osc_xf_toward(0.2, 0.3, 0), 1);
    assert_eq!(osc_xf_toward(0.3, 0.2, 1), 0);
    assert_eq!(osc_xf_toward(0.3, 0.3, 1), 1);
}

#[test]
fn osc_follows_the_visible_deck() {
    lm_player_init(1);

    // -- deck A alone: OSC drives it (today's behaviour) ----------------------
    submit(0, "fx-a", FX_A);
    assert_eq!(osc("/col", &[0.9, 0.8, 0.7]), 1);
    assert_eq!(osc("/k", &[1.0]), 1);
    let a = uniforms(0);
    assert_eq!(a[&0], vec![0.9, 0.8, 0.7]);
    assert_eq!(a[&3], vec![1.0]);

    // -- crossfade_to: cue B (loaded + running, not yet shown) ----------------
    submit(1, "fx-b", FX_B);
    // Still at position 0: A is fully shown, so OSC stays on A.
    assert_eq!(osc("/k", &[0.25]), 1);
    assert_eq!(uniforms(0)[&3], vec![0.25]);
    assert_eq!(uniforms(1)[&4], vec![0.5], "B untouched before the fade");
    // The fade starts: B is incoming, OSC names resolve against B's manifest.
    crossfade(0.1);
    assert_eq!(osc("/k", &[0.75]), 1);
    let b = uniforms(1);
    assert_eq!(b[&4], vec![0.75], "B.k (slot 4) driven by name");
    assert_eq!(b[&3], vec![1.0], "B.gain (slot 3, A's k slot) untouched");
    assert_eq!(uniforms(0)[&3], vec![0.25], "A.k untouched once B is incoming");
    // A per-axis patch on B writes only B's tint.y: x/z keep B's own values
    // (.1, .3), nothing of A's /col (.9, .8, .7 — also slot 0) carries over.
    assert_eq!(osc("/tint/y", &[0.5]), 1);
    assert_eq!(uniforms(1)[&0], vec![0.1, 0.5, 0.3], "no carry-over from deck A");
    assert_eq!(uniforms(0)[&0], vec![0.9, 0.8, 0.7]);
    // A 16-float mat4 by name lands on the incoming deck B.
    let pose = slot_of(1, "pose");
    // Pinned: the HITL gate (osc_deck_follow_core.POSE_SLOT_B) reads it there.
    assert_eq!(pose, 5, "B's mat4 slot");
    let m: Vec<f32> = (0..16).map(|i| i as f32 * 0.25 - 2.0).collect();
    assert_eq!(osc("/pose", &m), 1);
    assert_eq!(read(1, pose, 16), m, "/pose ,f*16 on deck B mid-fade");
    assert_eq!(read(0, 0, 4), vec![0.9, 0.8, 0.7, 0.25], "deck A untouched by /pose");
    // A's names mean nothing on B now (col isn't in B's manifest).
    assert_eq!(osc("/col", &[0.1, 0.1, 0.1]), 0);
    assert_eq!(uniforms(0)[&0], vec![0.9, 0.8, 0.7]);
    // The fade completes: B fully shown.
    crossfade(0.6);
    crossfade(1.0);
    assert_eq!(osc("/k", &[0.6]), 1);
    assert_eq!(uniforms(1)[&4], vec![0.6]);
    assert_eq!(uniforms(0)[&3], vec![0.25]);
    // Per-element: /pose/12 ,fff writes elements 12..14 only (the rest keep B's).
    assert_eq!(osc("/pose/12", &[1.0, -2.0, 0.5]), 1);
    let mut want = m.clone();
    want[12..15].copy_from_slice(&[1.0, -2.0, 0.5]);
    assert_eq!(read(1, pose, 16), want, "/pose/12 on the visible deck B");
    assert_eq!(read(0, 0, 4), vec![0.9, 0.8, 0.7, 0.25]);

    // -- rollback: re-activate A and fade back --------------------------------
    set_effect(0, "fx-a");
    // At position 1, B is still fully shown.
    assert_eq!(osc("/k", &[0.65]), 1);
    assert_eq!(uniforms(1)[&4], vec![0.65]);
    crossfade(0.8);
    assert_eq!(osc("/k", &[0.4]), 1);
    assert_eq!(uniforms(0)[&3], vec![0.4], "A incoming on the way back");
    assert_eq!(uniforms(1)[&4], vec![0.65]);
    crossfade(0.0);
    assert_eq!(osc("/k", &[0.3]), 1);
    assert_eq!(uniforms(0)[&3], vec![0.3]);
    assert_eq!(uniforms(1)[&4], vec![0.65]);
    // /col/x writes A's x only: y/z keep A's own (.8, .7), not B's tint.
    assert_eq!(osc("/col/x", &[0.2]), 1);
    assert_eq!(uniforms(0)[&0], vec![0.2, 0.8, 0.7]);
    assert_eq!(uniforms(1)[&0], vec![0.1, 0.5, 0.3]);
    // B's names are dead on A (no pose there): dropped.
    assert_eq!(osc("/pose", &m), 0);

    // -- two copies of the same effect: both driven ---------------------------
    submit(1, "fx-a", FX_A);
    crossfade(0.5);
    assert_eq!(osc("/k", &[0.9]), 1);
    assert_eq!(uniforms(0)[&3], vec![0.9]);
    assert_eq!(uniforms(1)[&3], vec![0.9]);
    crossfade(1.0);
    assert_eq!(osc("/k", &[0.1]), 1);
    assert_eq!(uniforms(0)[&3], vec![0.1]);
    assert_eq!(uniforms(1)[&3], vec![0.1]);

    // -- deploy_effect while B shows: A gets the new effect, the crossfade snaps
    // back to 0, and OSC drives A's new manifest ------------------------------
    submit(1, "fx-b", FX_B);
    crossfade(1.0);
    submit(0, "fx-a2", FX_A);
    crossfade(0.0);
    assert_eq!(osc("/k", &[0.55]), 1);
    assert_eq!(uniforms(0)[&3], vec![0.55]);
    assert_eq!(uniforms(1)[&4], vec![0.5]);
    // Deck B dropped entirely: OSC stays on A.
    set_effect(1, "off");
    set_effect(1, "off");
    assert_eq!(osc("/k", &[0.45]), 1);
    assert_eq!(uniforms(0)[&3], vec![0.45]);
}
