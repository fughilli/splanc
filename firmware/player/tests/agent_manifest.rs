//! The agent-discovery surface of the session core: welcome.features /
//! fxb_format (spliced in at encode time) and the /.well-known/splanc.json
//! manifest renderer.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::{ManifestExtras, Player};
use micropb::{MessageDecode, MessageEncode, PbDecoder, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

const FEATURES: &[&str] = &["effects", "perf", "uniform_commit", "list_effects"];

fn wire(player: &mut Player, msg: CMsg) -> Option<SMsg> {
    let req = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 65536>::new());
    req.encode(&mut enc).expect("request encodes");
    let reply = player.handle_frame(&enc.into_writer(), 0, 0)?;
    let mut buf = vec![0u8; 16 * 1024];
    let n = player.encode_reply(&reply, &mut buf).expect("reply fits");
    let mut back = pb::ServerMessage::default();
    back.decode(&mut PbDecoder::new(&buf[..n]), n).expect("reply decodes");
    back.r#msg
}

fn player() -> Player {
    let mut p = Player::new("esp32-0001", 64);
    p.set_identity("AA:BB:CC:DD:EE:FF", "Led \"Widget\" EEFF");
    p.set_build_info("0123456789abcdef0123456789abcdef01234567", false, "1.2.0");
    p.set_features(FEATURES, 1);
    p
}

fn manifest(p: &Player, x: &ManifestExtras) -> serde_json::Value {
    let mut buf = [0u8; 2048];
    let n = p.agent_manifest(&mut buf, x).expect("manifest fits");
    serde_json::from_slice(&buf[..n]).expect("manifest is valid JSON")
}

#[test]
fn welcome_carries_features_and_fxb_format() {
    let mut p = player();
    let Some(SMsg::Welcome(w)) = wire(&mut p, CMsg::Hello(pb::Hello::default())) else {
        panic!("welcome");
    };
    let feats: Vec<&str> = w.r#features.iter().map(|f| f.as_str()).collect();
    assert_eq!(feats, FEATURES);
    assert_eq!(w.r#fxb_format, 1);
    // The splice keeps every other welcome field intact.
    assert_eq!(w.r#mac.as_str(), "AA:BB:CC:DD:EE:FF");
    assert_eq!(w.r#fw_version.as_str(), "1.2.0");
}

#[test]
fn list_effects_is_the_fx_layers_arm() {
    let mut p = player();
    match wire(&mut p, CMsg::ListEffects(pb::ListEffects::default())) {
        Some(SMsg::Error(e)) => assert_eq!(e.r#code.as_str(), "unsupported"),
        other => panic!("expected the core to refuse list_effects, got {other:?}"),
    }
}

#[test]
fn manifest_mirrors_the_welcome_and_names_the_release_bundle() {
    let mut p = player();
    let mut caps = pb::BoardCapabilities::default();
    caps.r#board = micropb::heapless::String::try_from("ESP32-C6 SuperMini").unwrap();
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
    caps.encode(&mut enc).unwrap();
    assert!(p.set_board_caps(Vec::leak(enc.into_writer().to_vec())));
    let x = ManifestExtras { tls_cert_sha256: "ab12", bundle_url: "", bundle_sha256: "", ..Default::default() };
    let m = manifest(&p, &x);
    assert_eq!(m["schema"], "splanc-agent/1");
    assert_eq!(m["device"]["id"], "AA:BB:CC:DD:EE:FF");
    assert_eq!(m["device"]["name"], "Led \"Widget\" EEFF", "names are JSON-escaped");
    assert_eq!(m["device"]["board"], "ESP32-C6 SuperMini");
    assert_eq!(m["firmware"]["version"], "1.2.0");
    assert_eq!(m["firmware"]["dirty"], false);
    assert_eq!(m["protocol"]["ws_path"], "/ws");
    assert_eq!(m["protocol"]["features"], serde_json::json!(FEATURES));
    assert_eq!(m["protocol"]["fxb_format"], 1);
    assert_eq!(m["tls"]["cert_sha256"], "ab12");
    assert_eq!(
        m["bundle"]["url"],
        "https://github.com/fughilli/splanc/releases/download/firmware-v1.2.0/splanc-agent-1.2.0.tgz"
    );
    assert_eq!(m["bundle"]["mcp"]["command"], "npx");
    assert_eq!(m["bundle"]["mcp"]["args"], serde_json::json!(["-y", "@splanc/agent@1.2.0", "--host", "{host}"]));
    // The release pipeline's explicit URL + hash win over the derived URL.
    let x = ManifestExtras { tls_cert_sha256: "", bundle_url: "https://x/b.tgz", bundle_sha256: "ff", ..Default::default() };
    let m = manifest(&p, &x);
    assert_eq!(m["bundle"]["url"], "https://x/b.tgz");
    assert_eq!(m["bundle"]["sha256"], "ff");
    // The welcome agrees with the manifest's device fields.
    let Some(SMsg::Welcome(w)) = wire(&mut p, CMsg::Hello(pb::Hello::default())) else {
        panic!("welcome");
    };
    assert_eq!(m["device"]["id"], w.r#mac.as_str());
    assert_eq!(m["firmware"]["version"], w.r#fw_version.as_str());
}

#[test]
fn manifest_reports_the_tls_identity_state_when_published() {
    let p = player();
    let x = ManifestExtras { tls_cert_sha256: "ab12", tls_state: "ready", tls_persisted: true, ..Default::default() };
    let m = manifest(&p, &x);
    assert_eq!(m["tls"], serde_json::json!({"cert_sha256": "ab12", "state": "ready", "persisted": true}));
    let x = ManifestExtras { tls_state: "generating", ..Default::default() };
    let m = manifest(&p, &x);
    assert_eq!(m["tls"], serde_json::json!({"cert_sha256": "", "state": "generating", "persisted": false}));
    // Unpublished (older firmware shape): only the pin.
    let m = manifest(&p, &ManifestExtras::default());
    assert_eq!(m["tls"], serde_json::json!({"cert_sha256": ""}));
}

#[test]
fn dev_and_dirty_builds_publish_no_bundle() {
    let x = ManifestExtras { tls_cert_sha256: "", bundle_url: "https://x/b.tgz", bundle_sha256: "", ..Default::default() };
    for (version, dirty) in [("0.0.0-dev", false), ("1.2.0-3-gabcdef0", false), ("1.2.0", true)] {
        let mut p = player();
        p.set_build_info("c0ffee", dirty, version);
        let m = manifest(&p, &x);
        assert!(m["bundle"].is_null(), "{version} dirty={dirty} must have no bundle");
    }
}

#[test]
fn manifest_refuses_a_buffer_too_small() {
    let p = player();
    let x = ManifestExtras { tls_cert_sha256: "", bundle_url: "", bundle_sha256: "", ..Default::default() };
    let mut small = [0u8; 64];
    assert!(p.agent_manifest(&mut small, &x).is_none());
}
