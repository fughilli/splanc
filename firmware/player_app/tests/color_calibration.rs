//! Visual output calibration on the device: a `set_color_correction` from the
//! app becomes the per-channel calibration main.cpp builds its LED lookup tables
//! from. After each handled message main.cpp polls lm_color_correction_gen; on a
//! change it reads lm_color_correction_params (gamma R,G,B + luminance R,G,B) and
//! lm_color_correction_commit, then regenerates the LUT (cc::build_lut, pinned
//! by //firmware/player_app:color_correction_test) and persists it to flash or
//! applies it from RAM only. These tests pin the player half of that pipeline.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_color_correction_commit, lm_color_correction_gen, lm_color_correction_params,
    lm_player_handle, lm_player_init,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

/// WS2812B datasheet calibration (color_correction.h kWs2812b): gamma 2.8 and
/// the middle of each channel's luminance bin (R 550-700, G 1100-1400, B 200-400 mcd).
const WS2812B: [f32; 6] = [2.8, 2.8, 2.8, 625.0, 1250.0, 300.0];

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 1024>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn send(cc: pb::SetColorCorrection) {
    let frame = encode(CMsg::SetColorCorrection(cc));
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n > 0, "set_color_correction replies ({n})");
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    assert!(matches!(reply.r#msg, Some(SMsg::Welcome(_))), "set_color_correction replies welcome");
}

/// What main.cpp's poll_color_correction reads: (gen, params, commit).
fn firmware_view() -> (u32, [f32; 6], bool) {
    let mut p = [0.0f32; 6];
    assert_eq!(unsafe { lm_color_correction_params(p.as_mut_ptr()) }, 0);
    unsafe { (lm_color_correction_gen(), p, lm_color_correction_commit() != 0) }
}

#[test]
fn a_named_led_profile_becomes_its_datasheet_calibration() {
    rr::verifies!("PR-20");
    lm_player_init(64);
    // Start from a custom calibration so the profile has something to replace.
    let mut custom = pb::SetColorCorrection::default();
    custom.set_gamma_r(1.6);
    custom.set_lum_b(900.0);
    send(custom);
    let (gen0, _, _) = firmware_view();
    // A named profile wins over any per-channel fields sent alongside it.
    let mut cc = pb::SetColorCorrection::default();
    cc.set_profile("ws2812b".parse().unwrap());
    cc.set_gamma_r(1.0);
    cc.set_lum_g(1.0);
    send(cc);
    let (gen, params, commit) = firmware_view();
    assert_eq!(gen, gen0 + 1, "one request -> exactly one LUT regeneration");
    assert_eq!(params, WS2812B);
    assert!(commit, "an unqualified request is persisted to flash");
}

#[test]
fn per_channel_calibration_overrides_layer_over_the_datasheet_defaults() {
    rr::verifies!("PR-20");
    lm_player_init(64);
    let mut cc = pb::SetColorCorrection::default();
    cc.set_gamma_r(2.2);
    cc.set_lum_g(1000.0);
    cc.set_lum_b(500.0);
    send(cc);
    let (_, params, commit) = firmware_view();
    assert_eq!(params, [2.2, 2.8, 2.8, 625.0, 1000.0, 500.0], "only the given channels change");
    assert!(commit);
}

#[test]
fn a_live_preview_is_applied_without_being_persisted_until_committed() {
    rr::verifies!("PR-20");
    lm_player_init(64);
    let (gen0, _, _) = firmware_view();
    // The UI streams previews while a slider drags...
    for g in [2.0f32, 2.1, 2.4] {
        let mut cc = pb::SetColorCorrection::default();
        cc.set_gamma_b(g);
        cc.set_commit(false);
        send(cc);
        let (_, params, commit) = firmware_view();
        assert_eq!(params[2], g, "the preview's calibration is applied live");
        assert!(!commit, "a preview stays in RAM (no flash write per drag step)");
    }
    // ...then commits once when it closes.
    let mut cc = pb::SetColorCorrection::default();
    cc.set_gamma_b(2.4);
    cc.set_commit(true);
    send(cc);
    let (gen, params, commit) = firmware_view();
    assert_eq!(gen, gen0 + 4, "every request is picked up exactly once");
    assert_eq!(params[2], 2.4);
    assert!(commit, "the closing commit persists the calibration");
}
