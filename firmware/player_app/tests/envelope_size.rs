//! Guards the firmware-profile protobuf envelope sizes. The by-value decode +
//! reply build in `lm_player_handle` puts these structs on the loop-task /
//! httpd-task stacks, and those stacks are heap-allocated — so envelope bloat is
//! heap pressure (FUG-71). A regression that re-inflates an arm (e.g. a big
//! inline `Vec` that should be encoded zero-copy) trips here.

use ledmapper_pb::ledmapper_::v1_ as pb;

#[test]
fn stored_map_chunk_stays_lean() {
    // StoredMapChunk carries a `bytes data` payload (1 KiB on host). On firmware
    // the player encodes this reply ZERO-COPY straight to the output (ffi.rs
    // handle_get_stored_map) and never materializes the struct, so `data` is
    // stubbed to 8 B (gen_main.rs). Guard the struct DIRECTLY: a ~1 KiB arm
    // would still fit server_message_stays_lean's envelope bound, so that
    // assertion alone can't catch a StoredMapChunk regression. If this jumps
    // back toward ~1 KiB, `data` regained its fat
    // inline buffer instead of being walked zero-copy.
    let sz = core::mem::size_of::<pb::StoredMapChunk>();
    assert!(sz <= 128, "StoredMapChunk grew to {sz} B (expected <= 128)");
}

#[test]
fn set_counting_pattern_stays_lean() {
    // SetCountingPattern.blocks (Vec<ColorBlock, 32>, each with an inline
    // Vec<f64,4>) is the ~1.5 KiB arm that used to size every ClientMessage; the
    // firmware decodes it ZERO-COPY (ffi.rs handle_set_counting_pattern) and the
    // firmware profile stubs `blocks` to 1 (gen_main.rs). A regression toward
    // ~1.5 KiB means the arm regained a fat inline buffer that should be walked.
    // (~136 B today: 1 ColorBlock + the optional 64-B color_order string.)
    let sz = core::mem::size_of::<pb::SetCountingPattern>();
    assert!(sz <= 192, "SetCountingPattern grew to {sz} B (expected <= 192)");
}

#[test]
fn client_message_stays_lean() {
    // With SetCountingPattern stubbed, no ClientMessage arm carries a fat inline
    // buffer, so the whole envelope collapses to a control-frame size. A jump
    // here means some arm regained inline storage that should be walked instead.
    let sz = core::mem::size_of::<pb::ClientMessage>();
    assert!(sz <= 560, "ClientMessage grew to {sz} B (expected <= 560)");
}

#[test]
fn server_message_stays_lean() {
    // HardwareConfigState's board descriptor (31-pin catalog, ~4 KiB) used to
    // size EVERY by-value ServerMessage — each handler frame holding a reply
    // paid it (lm_player_handle ~10 KiB, hardware_config_state ~10 KiB). The
    // firmware now splices the encoded descriptor in at encode time
    // (Player::encode_reply) and the profile drops the field (gen_main.rs), so
    // the envelope is sized by the largest real arm (Welcome, ~650 B).
    let sz = core::mem::size_of::<pb::ServerMessage>();
    assert!(sz <= 768, "ServerMessage grew to {sz} B (expected <= 768)");
}
