//! Helpers to drive the reused `Player` core from the platform layer without
//! callers touching the protobuf envelope types directly. The transport (WS,
//! Phase 3) decodes real client frames straight into `player.handle`; this is
//! the local self-drive path (the free-run render binary) that synthesises a
//! `start_mapping` so the wire is active for the HITL probe.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::Player;
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

/// Start a mapping capture on the core (as if a client sent `start_mapping`) and
/// return the pattern-clock epoch it latched (`== epoch_ms`), or `None` if the
/// core rejected it.
pub fn start_mapping(
    player: &mut Player,
    led_count: u32,
    bit_period_ms: f64,
    brightness: f64,
    epoch_ms: i64,
) -> Option<i64> {
    let mut opts = pb::StartMappingOptions::default();
    opts.r#led_count = led_count as i32;
    opts.set_bit_period_ms(bit_period_ms);
    opts.set_brightness(brightness);

    let mut start = pb::StartMapping::default();
    start.set_options(opts);

    let req = pb::ClientMessage {
        r#msg: Some(CMsg::StartMapping(start)),
    };
    match player.handle(req, epoch_ms, epoch_ms).and_then(|r| r.r#msg) {
        Some(SMsg::MappingStarted(_)) => player.pattern_epoch_ms(),
        _ => None,
    }
}
