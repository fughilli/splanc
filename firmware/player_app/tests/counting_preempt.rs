//! Regression: the color-order counting probe must take over the strip with NO
//! map configured and while a user effect is loaded and active.
//!
//! The color-order check is the FIRST thing a user does — before any mapping —
//! so it can't depend on a stored map, and it has to completely override the FX
//! engine's output. render_once() (main.cpp) enforces this by checking
//! `lm_counting_color(0, …)` in a branch ABOVE `lm_fx_active()`; this test locks
//! the seam that branch order relies on — that the counting gate reports active
//! regardless of map presence or an armed effect.
//!
//! Own test binary (not folded into ffi.rs) so this scenario runs against fresh,
//! uncontended process-global FFI state — the same reason ffi.rs keeps ONE test.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_counting_color, lm_counting_color_order, lm_counting_len, lm_fx_active, lm_fx_load,
    lm_fx_set_active, lm_hw_color_order_perm, lm_map_len, lm_player_handle, lm_player_init,
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

fn handle(frame: &[u8], now: f64) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe {
        lm_player_handle(frame.as_ptr(), frame.len(), now as i64, now as i64, out.as_mut_ptr(),
                         out.len())
    };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    Some(reply.r#msg.expect("reply has an arm"))
}

// N pixels of each primary anchored at the strip start — the shape the phone
// sends for the color-order check (web/src/ui/screens/hardwareSetup.ts). `order`
// is the probe's own wire order (None -> unset -> identity "RGB").
fn counting_pattern(n: u32, order: Option<&str>) -> CMsg {
    let mut counting = pb::SetCountingPattern::default();
    for (i, rgb) in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]].iter().enumerate() {
        let mut block = pb::ColorBlock::default();
        block.r#start = i as i32 * n as i32;
        block.r#count = n as i32;
        block.r#rgb.extend_from_slice(rgb).unwrap();
        counting.r#blocks.push(block).unwrap();
    }
    if let Some(o) = order {
        counting.set_color_order(o.parse().unwrap());
    }
    CMsg::SetCountingPattern(counting)
}

fn probe_order() -> [u8; 3] {
    let mut perm = [0u8; 3];
    unsafe { lm_counting_color_order(perm.as_mut_ptr()) };
    perm
}

#[test]
fn counting_probe_overrides_fx_with_no_map() {
    lm_player_init(64);

    // Arm a user effect: a constant-red shader, loaded and set active. This is the
    // FX-engine output the counting probe has to preempt.
    let src = "vec3 shade(Led led) {\n  return vec3(1.0, 0.0, 0.0);\n}\n";
    let compiled = ledmapper_fx_compiler::compile(src).expect("shader compiles");
    assert!(unsafe { lm_fx_load(compiled.fxb.as_ptr(), compiled.fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    assert!(unsafe { lm_fx_active() }, "effect is armed");

    // No map has ever been submitted — the color-order check runs pre-mapping.
    assert_eq!(unsafe { lm_map_len() }, 0, "no map configured");

    // Latch the color-order probe (3 pixels each of R/G/B at the strip start),
    // driven raw (identity "RGB") — the identify phase.
    let Some(SMsg::CountingState(cs)) = handle(&encode(counting_pattern(3, Some("RGB"))), 2000.0)
    else {
        panic!("counting_state expected");
    };
    assert!(cs.r#active, "counting pattern latched");
    // Identify phase drives the probe raw: identity source permutation.
    assert_eq!(probe_order(), [0, 1, 2], "identity 'RGB' -> raw wire bytes");

    // The gate render_once() checks BEFORE lm_fx_active(): it fires despite the
    // armed effect and with no map, and paints the raw R/G/B blocks.
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_counting_color(0, rgb.as_mut_ptr()) }, "probe drives LED 0");
    assert_eq!(rgb, [255, 0, 0], "first run is red");
    assert!(unsafe { lm_counting_color(3, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [0, 255, 0], "second run is green");
    assert!(unsafe { lm_counting_color(6, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [0, 0, 255], "third run is blue");
    assert_eq!(unsafe { lm_counting_len() }, 9, "3 runs * 3 pixels");

    // The effect stays armed and unmapped underneath — the probe overrode output
    // without disturbing FX/map state.
    assert!(unsafe { lm_fx_active() }, "effect still armed under the probe");
    assert_eq!(unsafe { lm_map_len() }, 0, "still no map");

    // Shrinking "pixels each" (3 -> 1) narrows the lit extent: lm_counting_len,
    // which render_once() uses to blank the freed tail, tracks the smaller run so
    // the strip clears from N back down to M rather than leaving stale color.
    let Some(SMsg::CountingState(_)) = handle(&encode(counting_pattern(1, Some("RGB"))), 2100.0)
    else {
        panic!("counting_state expected");
    };
    assert_eq!(unsafe { lm_counting_len() }, 3, "narrowed to 3 runs * 1 pixel");
    assert!(unsafe { lm_counting_color(2, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [0, 0, 255], "LED 2 still lit (blue run)");
    // LED 3 falls past the narrowed run — it reads black, and render_once() drives
    // only lm_counting_len() (3) LEDs, blanking the tail the wider run had lit.
    assert!(unsafe { lm_counting_color(3, rgb.as_mut_ptr()) });
    assert_eq!(rgb, [0, 0, 0], "LED 3 past the narrowed run reads black");

    // Preview phase: the user taps a candidate order (GRB). The probe reorders
    // through it — WITHOUT touching the committed per-channel color order, which
    // stays at its GRB [1,0,2] default. This is the whole point of a probe-only
    // order: the color-order test never mutates the persisted hardware config.
    let committed_before = unsafe {
        let mut p = [0u8; 3];
        lm_hw_color_order_perm(0, p.as_mut_ptr());
        p
    };
    let Some(SMsg::CountingState(_)) = handle(&encode(counting_pattern(3, Some("GRB"))), 2200.0)
    else {
        panic!("counting_state expected");
    };
    assert_eq!(probe_order(), [1, 0, 2], "probe now drives the previewed GRB order");
    let committed_after = unsafe {
        let mut p = [0u8; 3];
        lm_hw_color_order_perm(0, p.as_mut_ptr());
        p
    };
    assert_eq!(committed_after, committed_before, "committed order untouched by the probe");

    // Clearing the probe resets its order back to raw identity.
    let empty = pb::SetCountingPattern::default();
    let Some(SMsg::CountingState(_)) = handle(&encode(CMsg::SetCountingPattern(empty)), 2300.0)
    else {
        panic!("counting_state expected");
    };
    assert_eq!(probe_order(), [0, 1, 2], "cleared probe -> identity");
}
