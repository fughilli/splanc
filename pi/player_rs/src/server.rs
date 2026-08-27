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

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::{SinkExt, StreamExt};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::Player;
use micropb::{MessageDecode, MessageEncode, PbDecoder, PbEncoder};
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;

/// The Player shared between the WS handler and the render loop.
pub type SharedPlayer = Arc<Mutex<Player>>;

/// The player's monotonic clock: whole milliseconds since a shared epoch. The WS
/// task stamps recv/send with it (so a start_mapping's pattern epoch is on this
/// clock) and the render loop derives its frame index from the SAME epoch, so
/// the pattern the phone expects and the pattern the LEDs show stay phase-locked.
pub fn now_ms(epoch: Instant) -> i64 {
    epoch.elapsed().as_millis() as i64
}

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

/// Serve the player over TLS + WebSocket at `addr` forever, sharing `player`
/// with the render loop. Each connection is handled on its own task; a failing
/// connection is logged and dropped, never taking the listener down. `epoch` is
/// the shared monotonic clock (see [`now_ms`]).
pub async fn serve(
    player: SharedPlayer,
    addr: SocketAddr,
    config: ServerConfig,
    epoch: Instant,
) -> std::io::Result<()> {
    let listener = TcpListener::bind(addr).await?;
    serve_on(player, listener, config, epoch).await
}

/// Like [`serve`] but on an already-bound listener (so callers/tests can pick an
/// ephemeral port and learn it via `local_addr` before serving).
pub async fn serve_on(
    player: SharedPlayer,
    listener: TcpListener,
    config: ServerConfig,
    epoch: Instant,
) -> std::io::Result<()> {
    let acceptor = TlsAcceptor::from(Arc::new(config));
    eprintln!("player_rs: WSS listening on {}", listener.local_addr()?);
    loop {
        let (tcp, peer) = listener.accept().await?;
        let acceptor = acceptor.clone();
        let player = player.clone();
        tokio::spawn(async move {
            if let Err(e) = handle_conn(player, acceptor, tcp, epoch).await {
                eprintln!("player_rs: connection {peer} ended: {e}");
            }
        });
    }
}

async fn handle_conn(
    player: SharedPlayer,
    acceptor: TlsAcceptor,
    tcp: TcpStream,
    epoch: Instant,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let tls = acceptor.accept(tcp).await?;
    let mut ws = tokio_tungstenite::accept_async(tls).await?;
    while let Some(msg) = ws.next().await {
        match msg? {
            Message::Binary(data) => {
                let now = now_ms(epoch);
                match handle_frame(&player, &data, now, now_ms(epoch)) {
                    Ok(Some(reply)) => ws.send(Message::Binary(reply.into())).await?,
                    Ok(None) => {} // fire-and-forget arm (detections, imu, …)
                    Err(e) => eprintln!("player_rs: frame rejected ({e})"),
                }
            }
            // The phone speaks binary protobuf only; a text frame is a client bug.
            Message::Text(_) => eprintln!("player_rs: unexpected text frame, ignoring"),
            Message::Ping(p) => ws.send(Message::Pong(p)).await?,
            Message::Close(_) => break,
            Message::Pong(_) | Message::Frame(_) => {}
        }
    }
    Ok(())
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

    // A client cert verifier that trusts the server's self-signed cert (the phone
    // does the same). Signature checks still run via the ring provider.
    #[derive(Debug)]
    struct TrustAny(Arc<tokio_rustls::rustls::crypto::CryptoProvider>);
    impl tokio_rustls::rustls::client::danger::ServerCertVerifier for TrustAny {
        fn verify_server_cert(
            &self,
            _e: &CertificateDer,
            _i: &[CertificateDer],
            _s: &tokio_rustls::rustls::pki_types::ServerName,
            _o: &[u8],
            _n: tokio_rustls::rustls::pki_types::UnixTime,
        ) -> Result<tokio_rustls::rustls::client::danger::ServerCertVerified, tokio_rustls::rustls::Error>
        {
            Ok(tokio_rustls::rustls::client::danger::ServerCertVerified::assertion())
        }
        fn verify_tls12_signature(
            &self,
            m: &[u8],
            c: &CertificateDer,
            d: &tokio_rustls::rustls::DigitallySignedStruct,
        ) -> Result<
            tokio_rustls::rustls::client::danger::HandshakeSignatureValid,
            tokio_rustls::rustls::Error,
        > {
            tokio_rustls::rustls::crypto::verify_tls12_signature(
                m,
                c,
                d,
                &self.0.signature_verification_algorithms,
            )
        }
        fn verify_tls13_signature(
            &self,
            m: &[u8],
            c: &CertificateDer,
            d: &tokio_rustls::rustls::DigitallySignedStruct,
        ) -> Result<
            tokio_rustls::rustls::client::danger::HandshakeSignatureValid,
            tokio_rustls::rustls::Error,
        > {
            tokio_rustls::rustls::crypto::verify_tls13_signature(
                m,
                c,
                d,
                &self.0.signature_verification_algorithms,
            )
        }
        fn supported_verify_schemes(&self) -> Vec<tokio_rustls::rustls::SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    #[tokio::test]
    async fn hello_welcome_over_real_tls_websocket() {
        use tokio::net::{TcpListener, TcpStream};
        // Server: a real player on an ephemeral port.
        let player: SharedPlayer = Arc::new(Mutex::new(Player::new("pi-0001", 64)));
        let config = self_signed_config(vec!["localhost".into()]).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let epoch = Instant::now();
        tokio::spawn(serve_on(player, listener, config, epoch));

        // Client: TLS (trust-any) -> WS -> send a hello -> expect a welcome.
        let provider = Arc::new(tokio_rustls::rustls::crypto::ring::default_provider());
        let client_cfg = tokio_rustls::rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(TrustAny(provider)))
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(client_cfg));
        let tcp = TcpStream::connect(addr).await.unwrap();
        let name = tokio_rustls::rustls::pki_types::ServerName::try_from("localhost").unwrap();
        let tls = connector.connect(name, tcp).await.unwrap();
        let (mut ws, _resp) = tokio_tungstenite::client_async("ws://localhost/", tls)
            .await
            .unwrap();

        let hello = pb::ClientMessage {
            r#msg: Some(pb::ClientMessage_::Msg::Hello(pb::Hello::default())),
        };
        let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 512>::new());
        hello.encode(&mut enc).unwrap();
        ws.send(Message::Binary(enc.into_writer().to_vec().into()))
            .await
            .unwrap();

        let reply = ws.next().await.expect("a reply").unwrap();
        let Message::Binary(bytes) = reply else {
            panic!("expected a binary reply, got {reply:?}");
        };
        let mut dec = PbDecoder::new(bytes.as_ref());
        let mut sm = pb::ServerMessage::default();
        sm.decode(&mut dec, bytes.len()).unwrap();
        assert!(
            matches!(sm.r#msg, Some(pb::ServerMessage_::Msg::Welcome(_))),
            "hello over the wire must produce welcome"
        );
    }
}
