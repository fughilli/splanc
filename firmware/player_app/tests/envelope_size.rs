//! Guards the firmware-profile protobuf envelope sizes. These structs land on
//! the loop-task / httpd-task stacks in `lm_player_handle` (by-value decode +
//! reply build), and those stacks are heap-allocated — so envelope bloat is
//! heap pressure (FUG-71). A regression that re-inflates an arm (e.g. a big
//! inline `Vec` that should be encoded zero-copy) trips here.

use ledmapper_pb::ledmapper_::v1_ as pb;

#[test]
fn server_message_stays_lean() {
    // ServerMessage is a `oneof` sized to its largest arm. StoredMapChunk.data
    // (1 KiB on host) is encoded ZERO-COPY on firmware (ffi.rs
    // handle_get_stored_map) and stubbed to 8 B here, so Welcome (~488 B) is the
    // ceiling. If this jumps back toward ~1 KiB, an arm regained a fat inline buf.
    let sz = core::mem::size_of::<pb::ServerMessage>();
    assert!(sz <= 512, "ServerMessage grew to {sz} B (expected <= 512)");
}

#[test]
fn client_message_stays_lean() {
    // SetCountingPattern.blocks (Vec<ColorBlock, 32>, each with an inline
    // Vec<f64,4>) used to make this ~1.5 KiB; the firmware decodes that arm
    // zero-copy (ffi.rs handle_set_counting_pattern) and stubs the field, so a
    // control-frame arm is the ceiling. A regression toward ~1.5 KiB means an arm
    // regained a fat inline buffer that should be walked instead.
    let sz = core::mem::size_of::<pb::ClientMessage>();
    assert!(sz <= 560, "ClientMessage grew to {sz} B (expected <= 560)");
}
