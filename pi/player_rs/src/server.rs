//! WS + TLS transport for the Pi player (Phase 3) — the network face the phone
//! and the HITL harness (via `res.forward`) talk to, wrapping the reused Player
//! core. Same contract the ESP32 firmware exposes: TLS 1.2 + RFC6455 WebSocket +
//! protobuf.
//!
//! The Player is shared with the render loop behind a Mutex (the firmware's
//! `player_mutex`): the WS task mutates it on each decoded client frame, the
//! render task reads pattern/colour state each tick. This module currently
//! provides the TLS setup + protobuf frame codec; the async accept loop builds
//! on top.

use std::sync::{Arc, Mutex};

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::Player;
use micropb::{MessageDecode, MessageEncode, PbDecoder, PbEncoder};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::rustls::ServerConfig;

/// The Player shared between the WS handler and the render loop.
pub type SharedPlayer = Arc<Mutex<Player>>;

/// Cap for an encoded ServerMessage. The host protobuf profile's replies (incl.
/// pattern_state / welcome) fit comfortably; live_map (a full OutputMap) will
/// need a larger/streamed buffer — revisit when that path lands.
const REPLY_CAP: usize = 16 * 1024;

/// A rustls server config with a fresh in-memory self-signed cert (rcgen over
/// the ring provider) covering `sans`. Both TLS 1.2 and 1.3 stay enabled so the
/// phone + firmware clients (TLS 1.2) negotiate cleanly.
pub fn self_signed_config(
    sans: Vec<String>,
) -> Result<ServerConfig, Box<dyn std::error::Error + Send + Sync>> {
    let ck = rcgen::generate_simple_self_signed(sans)?;
    let cert: CertificateDer<'static> = ck.cert.der().clone();
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(ck.key_pair.serialize_der()));
    let cfg = ServerConfig::builder_with_provider(Arc::new(
        tokio_rustls::rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(vec![cert], key)?;
    Ok(cfg)
}

/// Decode one binary WS frame (a protobuf ClientMessage), run it through the
/// shared Player, and encode the reply (a ServerMessage), if any. This is the
/// exact transport contract the C++ `lm_player_handle` implements — done
/// natively here. Returns `Ok(None)` for fire-and-forget arms (no reply).
pub fn handle_frame(
    player: &SharedPlayer,
    frame: &[u8],
    recv_ms: i64,
    send_ms: i64,
) -> Result<Option<Vec<u8>>, &'static str> {
    let mut dec = PbDecoder::new(frame);
    let mut req = pb::ClientMessage::default();
    if req.decode(&mut dec, frame.len()).is_err() {
        return Err("decode");
    }
    let reply = {
        let mut p = player.lock().expect("player mutex poisoned");
        p.handle(req, recv_ms, send_ms)
    };
    let Some(reply) = reply else {
        return Ok(None);
    };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, REPLY_CAP>::new());
    if reply.encode(&mut enc).is_err() {
        return Err("reply too large");
    }
    Ok(Some(enc.into_writer().to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_self_signed_config() {
        // Exercises rcgen + rustls over the ring provider end-to-end.
        self_signed_config(vec!["localhost".into(), "ledmapper.local".into()])
            .expect("self-signed TLS config should build");
    }

    #[test]
    fn hello_frame_roundtrips_through_the_core() {
        // Encode a hello ClientMessage, run it through handle_frame, and confirm
        // the reply decodes as a welcome — the whole WS transport contract minus
        // the socket.
        let player: SharedPlayer = Arc::new(Mutex::new(Player::new("pi-0001", 64)));
        let hello = pb::ClientMessage {
            r#msg: Some(pb::ClientMessage_::Msg::Hello(pb::Hello::default())),
        };
        let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 512>::new());
        hello.encode(&mut enc).unwrap();
        let frame = enc.into_writer().to_vec();

        let out = handle_frame(&player, &frame, 1, 1).unwrap().expect("welcome");
        let mut dec = PbDecoder::new(out.as_slice());
        let mut reply = pb::ServerMessage::default();
        reply.decode(&mut dec, out.len()).unwrap();
        assert!(
            matches!(reply.r#msg, Some(pb::ServerMessage_::Msg::Welcome(_))),
            "hello must produce welcome"
        );
    }
}
