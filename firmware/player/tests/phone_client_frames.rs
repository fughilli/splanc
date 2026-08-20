//! The player core vs REAL phone-client wire bytes.
//!
//! Every client frame in web/tests/golden_proto_frames.json is a canonical
//! encoding the phone's wire layer is verified to produce (Python-generated,
//! TS round-tripped, micropb byte-checked). Feeding them straight into the
//! player pins the firmware server to the phone client at the byte level:
//! each frame must decode, produce a reply from the documented contract for
//! its arm (or the documented silence), and every reply must ENCODE — a
//! bounded response to anything a phone can say, never a panic.

use base64::Engine;
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::Player;
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn client_frames() -> Vec<Vec<u8>> {
    let path = std::env::var("GOLDEN_PROTO_FRAMES").expect("GOLDEN_PROTO_FRAMES not set");
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let b64 = base64::engine::general_purpose::STANDARD;
    json["frames"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["direction"] == "client")
        .map(|f| b64.decode(f["frameB64"].as_str().unwrap()).unwrap())
        .collect()
}

/// The §7 / player-profile contract: which reply arms a request arm allows.
/// State-dependent arms list every legal outcome (e.g. configure before or
/// after start_mapping).
fn reply_allowed(req: &CMsg, reply: &Option<SMsg>) -> bool {
    let is_err = |code: &str| {
        matches!(reply, Some(SMsg::Error(e)) if e.r#code.as_str() == code)
    };
    match req {
        CMsg::Hello(_) => matches!(reply, Some(SMsg::Welcome(_))),
        CMsg::TimeSyncPing(_) => matches!(reply, Some(SMsg::TimeSyncPong(_))),
        CMsg::StartMapping(_) => matches!(reply, Some(SMsg::MappingStarted(_))),
        CMsg::Configure(_) => {
            matches!(reply, Some(SMsg::PatternState(s)) if s.r#active) || is_err("no_session")
        }
        // No solver on this player: only solveOnHost=false stops.
        CMsg::StopMapping(m) => {
            if m.r#solve_on_host().copied() == Some(false) {
                matches!(reply, Some(SMsg::MappingStopped(_))) || is_err("no_session")
            } else {
                is_err("unsupported") || is_err("no_session")
            }
        }
        CMsg::GetPattern(_) => matches!(reply, Some(SMsg::PatternState(_))),
        CMsg::SetCountingPattern(_) => matches!(reply, Some(SMsg::CountingState(_))),
        CMsg::SetLedCount(_) => matches!(reply, Some(SMsg::LedCountState(_))),
        CMsg::SubmitMap(_) => matches!(reply, Some(SMsg::ResultReady(_))),
        CMsg::SubmitTopology(_) => {
            matches!(reply, Some(SMsg::ResultReady(_))) || is_err("unknown_map")
        }
        CMsg::SetPlayback(m) => {
            if m.r#effect.as_str() == "off" {
                matches!(reply, Some(SMsg::PlaybackState(_)))
            } else {
                matches!(reply, Some(SMsg::PlaybackState(_))) || is_err("unsupported_effect")
            }
        }
        CMsg::GetPlayback(_) => matches!(reply, Some(SMsg::PlaybackState(_))),
        CMsg::GetFrameTiming(_) => matches!(reply, Some(SMsg::FrameTiming(_))),
        // Fire-and-forget Pi telemetry + set_texture (a video frame) + set_jit
        // (the JIT debug/bench toggle), all handled by the ffi fx layer: silence.
        CMsg::Detections(_)
        | CMsg::ImuBatch(_)
        | CMsg::ExposureReport(_)
        | CMsg::SetTexture(_)
        | CMsg::SetJit(_) => reply.is_none(),
        // Pi-only request arms: bounded refusal.
        CMsg::GetStatus(_) | CMsg::GetLiveMap(_) | CMsg::GetSolveStatus(_) => is_err("unsupported"),
        // The map dump and sharded uploads are handled by the ffi arena /
        // transport layer, not the session core.
        CMsg::GetStoredMap(_) | CMsg::UploadChunk(_) => is_err("unsupported"),
        // Effects arms are handled by the ffi fx layer, not the session core;
        // perf arms are not implemented on this player.
        CMsg::SubmitEffect(_)
        | CMsg::SetEffect(_)
        | CMsg::SetUniforms(_)
        | CMsg::GetEffectUniforms(_)
        | CMsg::SetPerf(_)
        | CMsg::GetPerfReport(_) => is_err("unsupported"),
        // Rename, color correction, and output brightness all reply welcome.
        CMsg::SetDeviceName(_) | CMsg::SetColorCorrection(_) | CMsg::SetBrightness(_) => {
            matches!(reply, Some(SMsg::Welcome(_)))
        }
    }
}

fn arm_name(req: &CMsg) -> &'static str {
    match req {
        CMsg::Hello(_) => "hello",
        CMsg::TimeSyncPing(_) => "time_sync_ping",
        CMsg::StartMapping(_) => "start_mapping",
        CMsg::Configure(_) => "configure",
        CMsg::StopMapping(_) => "stop_mapping",
        CMsg::GetPattern(_) => "get_pattern",
        CMsg::SetCountingPattern(_) => "set_counting_pattern",
        CMsg::SetLedCount(_) => "set_led_count",
        CMsg::SubmitMap(_) => "submit_map",
        CMsg::SubmitTopology(_) => "submit_topology",
        CMsg::SetPlayback(_) => "set_playback",
        CMsg::GetPlayback(_) => "get_playback",
        CMsg::GetFrameTiming(_) => "get_frame_timing",
        CMsg::Detections(_) => "detections",
        CMsg::ImuBatch(_) => "imu_batch",
        CMsg::ExposureReport(_) => "exposure_report",
        CMsg::GetStatus(_) => "get_status",
        CMsg::GetLiveMap(_) => "get_live_map",
        CMsg::GetSolveStatus(_) => "get_solve_status",
        CMsg::GetStoredMap(_) => "get_stored_map",
        CMsg::SubmitEffect(_) => "submit_effect",
        CMsg::SetEffect(_) => "set_effect",
        CMsg::SetUniforms(_) => "set_uniforms",
        CMsg::GetEffectUniforms(_) => "get_effect_uniforms",
        CMsg::SetPerf(_) => "set_perf",
        CMsg::GetPerfReport(_) => "get_perf_report",
        CMsg::SetDeviceName(_) => "set_device_name",
        CMsg::SetTexture(_) => "set_texture",
        CMsg::UploadChunk(_) => "upload_chunk",
        CMsg::SetColorCorrection(_) => "set_color_correction",
        CMsg::SetBrightness(_) => "set_brightness",
        CMsg::SetJit(_) => "set_jit",
    }
}

fn run_frames_through(player: &mut Player, frames: &[Vec<u8>]) {
    for (i, bytes) in frames.iter().enumerate() {
        let mut req = pb::ClientMessage::default();
        req.decode_from_bytes(bytes)
            .unwrap_or_else(|e| panic!("frame[{i}]: phone frame must decode: {e:?}"));
        let arm = req.r#msg.clone().expect("golden frames always have an arm");
        let now = 1000 + i as i64;
        let reply = player.handle(req, now, now).map(|r| {
            // Every reply must fit and encode — bounded output is part of
            // the firmware contract.
            let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 16384>::new());
            r.encode(&mut enc)
                .unwrap_or_else(|e| panic!("frame[{i}]: reply must encode: {e:?}"));
            r.r#msg.expect("player replies always carry an arm")
        });
        assert!(
            reply_allowed(&arm, &reply),
            "frame[{i}] ({}): reply {reply:?} violates the player contract",
            arm_name(&arm),
        );
    }
}

/// The golden sequence in order — a coherent session (start_mapping appears
/// before configure/stop), exercising the stateful paths.
#[test]
fn golden_client_frames_in_order() {
    let frames = client_frames();
    assert!(frames.len() >= 20, "expected the full client golden, got {}", frames.len());
    let mut player = Player::new("esp32-golden", 1024);
    run_frames_through(&mut player, &frames);
}

/// Every frame against a FRESH player (no prior state): the player must
/// still answer every phone byte-sequence with something bounded — the
/// no-session error paths included.
#[test]
fn golden_client_frames_stateless() {
    for (i, bytes) in client_frames().iter().enumerate() {
        let mut player = Player::new("esp32-cold", 1024);
        run_frames_through(&mut player, core::slice::from_ref(bytes));
        let _ = i;
    }
}
