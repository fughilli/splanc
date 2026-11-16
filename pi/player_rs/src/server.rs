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
use ledmapper_player::Player;
use ledmapper_view::ledmapper::v1::ClientMessageView;
use tokio::net::{TcpListener, TcpStream};
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio_rustls::rustls::ServerConfig;
use tokio_rustls::TlsAcceptor;
use tokio_tungstenite::tungstenite::Message;

/// The Player shared between the WS handler and the render loop.
pub type SharedPlayer = Arc<Mutex<Player>>;

/// The OTA arms' handler (docs/design/max-ota.md), set once at startup on a Pi.
/// Unset (tests, a dev host): OTA arms reach the core, which answers "unsupported".
pub static OTA: std::sync::OnceLock<crate::ota::Ota> = std::sync::OnceLock::new();

/// The host player's effects layer (crate::fx), set once at startup by
/// `player_host`. Unset (the Pi): the effect arms reach the core, which answers
/// "unsupported".
pub static HOST_FX: std::sync::OnceLock<Arc<Mutex<crate::fx::HostFx>>> = std::sync::OnceLock::new();

/// Static files served on the WSS port for plain HTTPS GETs (`player_host
/// --web-root`, e.g. the virtual LED wall), set once at startup. Unset: only the
/// certificate-trust page at `/` (crate::http).
pub static WEB_ROOT: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

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

/// A rustls server config with a fresh in-memory self-signed P-256 cert, over the
/// PURE-RUST RustCrypto provider (no ring / no C, so the whole binary
/// cross-compiles with rustc alone). TLS 1.2 + 1.3 both enabled so the phone +
/// firmware clients (TLS 1.2) negotiate cleanly. The cert has no SANs — the phone
/// bypasses validation (a self-signed device cert), so identity isn't asserted.
pub fn self_signed_config() -> Result<ServerConfig, Box<dyn std::error::Error + Send + Sync>> {
    use p256::ecdsa::{DerSignature, SigningKey};
    use p256::pkcs8::EncodePrivateKey;
    use x509_cert::builder::{Builder, CertificateBuilder, Profile};
    use x509_cert::der::Encode;
    use x509_cert::name::Name;
    use x509_cert::serial_number::SerialNumber;
    use x509_cert::spki::SubjectPublicKeyInfoOwned;
    use x509_cert::time::Validity;

    use std::str::FromStr;

    let signing_key = SigningKey::random(&mut p256::elliptic_curve::rand_core::OsRng);
    let spki = SubjectPublicKeyInfoOwned::from_key(*signing_key.verifying_key())?;
    let name = Name::from_str("CN=ledmapper")?;
    // A self-signed END-ENTITY cert (issuer == subject, signed by its own key), not
    // Profile::Root: Root marks it a CA with KeyUsage keyCertSign|cRLSign only, and
    // Chrome refuses a TLS server cert without digitalSignature with the
    // non-bypassable ERR_SSL_KEY_USAGE_INCOMPATIBLE, so a browser could never get
    // as far as accepting the self-signed warning. Leaf gives CA:FALSE +
    // digitalSignature (what an ECDSA server key needs).
    let cert = CertificateBuilder::new(
        Profile::Leaf {
            issuer: name.clone(),
            enable_key_agreement: false,
            enable_key_encipherment: false,
        },
        SerialNumber::from(1u32),
        Validity::from_now(std::time::Duration::from_secs(3650 * 24 * 3600))?,
        name,
        spki,
        &signing_key,
    )?
    .build::<DerSignature>()?;

    let cert = CertificateDer::from(cert.to_der()?);
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
        signing_key.to_pkcs8_der()?.as_bytes().to_vec(),
    ));
    let cfg = ServerConfig::builder_with_provider(Arc::new(rustls_rustcrypto::provider()))
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
    // Decoded in place (pbview views over `frame`): a frame that doesn't parse is a
    // decode error for the caller, not a reply.
    if ClientMessageView::parse(frame).is_err() {
        return Err("decode");
    }
    // OTA arms: answered here from the MAX updater's state (crate::ota), not by the
    // shared core (which has no updater).
    if let Some(ota) = OTA.get() {
        if crate::ota::Ota::is_ota_frame(frame) {
            return Ok(ota.handle(frame));
        }
    }
    // Effect / map / chunked-upload arms: the host effects layer, when there is
    // one. Lock order: the effects layer, then the player (the render loop never
    // holds both).
    let mut forwarded = None;
    if let Some(fx) = HOST_FX.get() {
        if crate::fx::HostFx::intercepts(frame) {
            let mut fx = fx.lock().expect("fx mutex poisoned");
            let mut p = player.lock().expect("player mutex poisoned");
            match fx.handle(&mut p, frame) {
                crate::fx::Handled::Raw(out) => return Ok(Some(out)),
                crate::fx::Handled::Reply(reply) => return encode(&p, &reply).map(Some),
                crate::fx::Handled::Forward(whole) => forwarded = Some(whole),
            }
        }
    }
    let frame = forwarded.as_deref().unwrap_or(frame);
    let mut p = player.lock().expect("player mutex poisoned");
    let Some(reply) = p.handle_frame(frame, recv_ms, send_ms) else {
        return Ok(None);
    };
    encode(&p, &reply).map(Some)
}

/// Every reply goes out through Player::encode_reply (it splices the board
/// descriptor into hardware_config_state).
fn encode(p: &Player, reply: &ledmapper_pb::ledmapper_::v1_::ServerMessage) -> Result<Vec<u8>, &'static str> {
    let mut out = vec![0u8; REPLY_CAP];
    let n = p.encode_reply(reply, &mut out).ok_or("reply too large")?;
    out.truncate(n);
    Ok(out)
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
    crate::health::LISTENING.store(true, std::sync::atomic::Ordering::Relaxed);
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
    use crate::http;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut tls = acceptor.accept(tcp).await?;
    // Read the request head to route it: a WebSocket upgrade goes to the player,
    // anything else gets a plain HTTPS answer (the trust page, the web root).
    let mut buf = Vec::with_capacity(1024);
    let head_len = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let mut chunk = [0u8; 2048];
        loop {
            if let Some(n) = http::head_len(&buf) {
                return Ok::<_, std::io::Error>(Some(n));
            }
            if buf.len() > http::MAX_HEAD {
                return Ok(None);
            }
            let n = tls.read(&mut chunk).await?;
            if n == 0 {
                return Ok(None);
            }
            buf.extend_from_slice(&chunk[..n]);
        }
    })
    .await
    .map_err(|_| "request head timed out")??;
    let Some(head) = head_len.and_then(|n| http::parse_head(&buf[..n])) else {
        return Err("not an HTTP request".into());
    };
    if !head.websocket {
        // Drain a (small) request body first: closing with unread bytes makes the
        // kernel reset the connection before the browser reads the response.
        let mut left = head.content_length.min(1 << 20).saturating_sub(buf.len() - head_len.unwrap_or(0));
        let mut chunk = [0u8; 4096];
        while left > 0 {
            let n = tls.read(&mut chunk).await?;
            if n == 0 {
                break;
            }
            left = left.saturating_sub(n);
        }
        let resp = http::respond(&head, WEB_ROOT.get().map(|p| p.as_path()));
        tls.write_all(&resp).await?;
        tls.shutdown().await?;
        return Ok(());
    }
    let stream = http::Prefixed::new(buf, tls);
    let mut ws = tokio_tungstenite::accept_async(stream).await?;
    while let Some(msg) = ws.next().await {
        match msg? {
            Message::Binary(data) => {
                let now = now_ms(epoch);
                match handle_frame(&player, &data, now, now_ms(epoch)) {
                    Ok(Some(reply)) => ws.send(Message::Binary(reply)).await?,
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
    use ledmapper_pb::ledmapper_::v1_ as pb;
    use micropb::{MessageDecode, MessageEncode, PbDecoder, PbEncoder};

    #[test]
    fn builds_self_signed_config() {
        // Exercises x509-cert + p256 + rustls over the pure-Rust RustCrypto provider.
        self_signed_config().expect("self-signed TLS config should build");
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

    async fn tls_client(
        addr: SocketAddr,
    ) -> tokio_rustls::client::TlsStream<tokio::net::TcpStream> {
        let provider = Arc::new(rustls_rustcrypto::provider());
        let client_cfg = tokio_rustls::rustls::ClientConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(TrustAny(provider)))
            .with_no_client_auth();
        let connector = tokio_rustls::TlsConnector::from(Arc::new(client_cfg));
        let tcp = tokio::net::TcpStream::connect(addr).await.unwrap();
        let name = tokio_rustls::rustls::pki_types::ServerName::try_from("localhost").unwrap();
        connector.connect(name, tcp).await.unwrap()
    }

    #[tokio::test]
    async fn plain_https_get_is_answered_with_the_trust_page() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        // The app's cert-trust popup opens https://<player>/ and waits for the page
        // to postMessage 'ledmapper-cert-ok'; the WS port must answer it (it used to
        // close the connection: ERR_EMPTY_RESPONSE), and still take upgrades after.
        let player: SharedPlayer = Arc::new(Mutex::new(Player::new("pi-0001", 64)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(serve_on(player, listener, self_signed_config().unwrap(), Instant::now()));

        let mut tls = tls_client(addr).await;
        tls.write_all(b"GET /?from=app HTTP/1.1\r\nHost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut resp = Vec::new();
        tls.read_to_end(&mut resp).await.unwrap();
        let resp = String::from_utf8_lossy(&resp);
        assert!(resp.starts_with("HTTP/1.1 200 OK"), "{resp}");
        assert!(resp.contains("ledmapper-cert-ok"), "{resp}");

        // A POST with a body (the wall's /truth publish) is drained and answered.
        let mut tls = tls_client(addr).await;
        tls.write_all(b"POST /truth HTTP/1.1\r\nContent-Length: 2\r\n\r\n{}")
            .await
            .unwrap();
        let mut resp = Vec::new();
        tls.read_to_end(&mut resp).await.unwrap();
        assert!(String::from_utf8_lossy(&resp).starts_with("HTTP/1.1 204"));
    }

    #[tokio::test]
    async fn hello_welcome_over_real_tls_websocket() {
        use tokio::net::{TcpListener, TcpStream};
        // Server: a real player on an ephemeral port.
        let player: SharedPlayer = Arc::new(Mutex::new(Player::new("pi-0001", 64)));
        let config = self_signed_config().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let epoch = Instant::now();
        tokio::spawn(serve_on(player, listener, config, epoch));

        // Client: TLS (trust-any) -> WS -> send a hello -> expect a welcome.
        let provider = Arc::new(rustls_rustcrypto::provider());
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
        ws.send(Message::Binary(enc.into_writer().to_vec()))
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
