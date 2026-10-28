//! The agent-facing protocol surface through the C ABI: welcome.features, a full
//! get_effect_uniforms (manifest + live values), list_effects, set_uniforms'
//! commit flag, and the /.well-known/splanc.json manifest.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_agent_manifest, lm_mdns_announce, lm_mdns_respond, lm_player_handle, lm_player_init,
    lm_player_set_build_info, lm_player_set_identity, lm_set_tls_info, lm_set_uniforms_commit,
    FEATURES,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

const SRC: &str = "// How heavy the rain is, 0 = dry.\n\
                   uniform float rain : 0..1 = 0.2;\n\
                   uniform vec3 tint : color = 0.2, 0.6, 1.0; // Canopy light colour.\n\
                   vec3 shade(Led led) { return tint * rain; }\n";

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 16384>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle(msg: CMsg) -> Option<SMsg> {
    let frame = encode(msg);
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn set_uniform(slot: u32, vals: &[f32], commit: Option<bool>) {
    let mut v = pb::UniformValue { r#slot: slot, ..Default::default() };
    v.r#value.extend_from_slice(vals).unwrap();
    let mut m = pb::SetUniforms::default();
    m.r#values.push(v).unwrap();
    if let Some(c) = commit {
        m.set_commit(c);
    }
    let _ = handle(CMsg::SetUniforms(m));
}

fn boot_with_effect() -> Vec<u8> {
    lm_player_init(64);
    unsafe {
        let (mac, name) = ("AA:BB:CC:DD:EE:FF", "Led Widget DDEEFF");
        lm_player_set_identity(mac.as_ptr(), mac.len(), name.as_ptr(), name.len());
        let (commit, version) = ("0123456789abcdef0123456789abcdef01234567", "1.2.0");
        lm_player_set_build_info(commit.as_ptr(), commit.len(), false, version.as_ptr(), version.len());
    }
    let fxb = ledmapper_fx_compiler::compile(SRC).expect("compiles").fxb;
    // SubmitEffect{effect_id=1, fxb=2, activate=3}, hand-encoded: the generated
    // SubmitEffect.fxb keeps the 64 B default cap (the firmware walks it zero-copy).
    let field = |f: u8, b: &[u8]| -> Vec<u8> {
        let mut v = vec![(f << 3) | 2];
        let mut n = b.len();
        while n >= 0x80 {
            v.push((n as u8) | 0x80);
            n >>= 7;
        }
        v.push(n as u8);
        v.extend_from_slice(b);
        v
    };
    let mut body = field(1, b"rainforest");
    body.extend(field(2, &fxb));
    body.extend([3 << 3, 1]);
    let mut frame = vec![0xaa, 0x01]; // ClientMessage.submit_effect = 21, LEN
    let mut n = body.len();
    while n >= 0x80 {
        frame.push((n as u8) | 0x80);
        n >>= 7;
    }
    frame.push(n as u8);
    frame.extend(body);
    let mut out = vec![0u8; 4096];
    let r = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..r as usize]).expect("reply decodes");
    assert!(matches!(reply.r#msg, Some(SMsg::ResultReady(_))), "{:?}", reply.r#msg);
    fxb
}

#[test]
fn the_agent_surface() {
    let fxb = boot_with_effect();

    // welcome: the explicit feature list + the .fxb format.
    let Some(SMsg::Welcome(w)) = handle(CMsg::Hello(pb::Hello::default())) else { panic!("welcome") };
    let feats: Vec<&str> = w.r#features.iter().map(|f| f.as_str()).collect();
    assert_eq!(feats, FEATURES);
    assert_eq!(w.r#fxb_format, ledmapper_fx_vm::FORMAT_VERSION as u32);

    // get_effect_uniforms: the WHOLE manifest (far past the firmware profile's
    // inline cap), the effect id, and each uniform's live value.
    set_uniform(0, &[0.75], None);
    let Some(SMsg::EffectUniforms(eu)) = handle(CMsg::GetEffectUniforms(pb::GetEffectUniforms::default()))
    else {
        panic!("effect_uniforms");
    };
    assert_eq!(eu.r#effect_id.as_str(), "rainforest");
    let prog = ledmapper_fx_vm::Program::parse(&fxb).unwrap();
    assert!(prog.manifest.len() > 64, "a real manifest exceeds the old 64 B cap");
    assert_eq!(&eu.r#manifest[..], prog.manifest);
    let m: serde_json::Value = serde_json::from_slice(&eu.r#manifest).unwrap();
    assert_eq!(m[0]["doc"], "How heavy the rain is, 0 = dry.");
    let cur: Vec<(u32, Vec<f32>)> = eu.r#current.iter().map(|v| (v.r#slot, v.r#value.to_vec())).collect();
    // The VM's live values: the load seeds every uniform with its manifest
    // default (R7), so the untouched tint reads back as its default.
    assert_eq!(cur, vec![(0, vec![0.75]), (1, vec![0.2, 0.6, 1.0])]);

    // set_uniforms.commit: unset or true persists, false is live-only.
    set_uniform(0, &[0.5], None);
    assert!(unsafe { lm_set_uniforms_commit() });
    set_uniform(0, &[0.6], Some(false));
    assert!(!unsafe { lm_set_uniforms_commit() });
    set_uniform(0, &[0.7], Some(true));
    assert!(unsafe { lm_set_uniforms_commit() });

    // list_effects: the single stored slot.
    let Some(SMsg::EffectList(list)) = handle(CMsg::ListEffects(pb::ListEffects::default())) else {
        panic!("effect_list");
    };
    assert_eq!(list.r#effects.len(), 1);
    let e = &list.r#effects[0];
    assert_eq!((e.r#effect_id.as_str(), e.r#fxb_bytes as usize, e.r#active), ("rainforest", fxb.len(), true));

    // The manifest, through the C ABI.
    let mut buf = [0u8; 2048];
    let (sha, url) = ("ab".repeat(32), "");
    let n = unsafe {
        lm_agent_manifest(buf.as_mut_ptr(), buf.len(), sha.as_ptr(), sha.len(), url.as_ptr(), 0, url.as_ptr(), 0)
    };
    assert!(n > 0, "manifest renders ({n})");
    let mf: serde_json::Value = serde_json::from_slice(&buf[..n as usize]).unwrap();
    assert_eq!(mf["device"]["id"], w.r#mac.as_str());
    assert_eq!(mf["protocol"]["features"], serde_json::json!(FEATURES));
    assert_eq!(mf["tls"]["cert_sha256"], sha);
    assert!(unsafe { lm_agent_manifest(buf.as_mut_ptr(), 32, sha.as_ptr(), 0, url.as_ptr(), 0, url.as_ptr(), 0) } == -2);
    // Nothing published yet (firmware without per-device certs): no tls.state.
    assert!(mf["tls"].get("state").is_none());

    // The per-device TLS identity: get_tls_info answers what the firmware published
    // (lm_set_tls_info) — "generating" with no pin, then "ready" with the pin.
    let tls_info = || {
        let Some(SMsg::TlsInfo(t)) = handle(CMsg::GetTlsInfo(pb::GetTlsInfo::default())) else {
            panic!("tls_info");
        };
        (t.r#state.to_string(), t.r#cert_sha256.to_string(), t.r#persisted)
    };
    assert_eq!(tls_info(), (String::new(), String::new(), false));
    let st = "generating";
    unsafe { lm_set_tls_info(st.as_ptr(), st.len(), sha.as_ptr(), 0, false) };
    assert_eq!(tls_info(), ("generating".into(), String::new(), false));
    let st = "ready";
    unsafe { lm_set_tls_info(st.as_ptr(), st.len(), sha.as_ptr(), sha.len(), true) };
    assert_eq!(tls_info(), ("ready".into(), sha.clone(), true));
    let n = unsafe {
        lm_agent_manifest(buf.as_mut_ptr(), buf.len(), sha.as_ptr(), sha.len(), url.as_ptr(), 0, url.as_ptr(), 0)
    };
    let mf: serde_json::Value = serde_json::from_slice(&buf[..n as usize]).unwrap();
    assert_eq!(mf["tls"], serde_json::json!({"cert_sha256": sha, "state": "ready", "persisted": true}));
    assert!(FEATURES.contains(&"tls_info"));
    assert!(FEATURES.contains(&"group_capture"));

    // mDNS: the service carries the player's live identity.
    let ip = [192u8, 168, 4, 23];
    let mut q = vec![0u8, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for l in ["_splanc", "_tcp", "local"] {
        q.push(l.len() as u8);
        q.extend_from_slice(l.as_bytes());
    }
    q.extend([0, 0, 12, 0, 1]);
    let mut out = [0u8; 1024];
    let mut unicast = true;
    let n = unsafe { lm_mdns_respond(q.as_ptr(), q.len(), 5353, ip.as_ptr(), out.as_mut_ptr(), out.len(), &mut unicast) };
    assert!(n > 0 && !unicast, "multicast reply ({n})");
    let reply = &out[..n as usize];
    let has = |needle: &[u8]| reply.windows(needle.len()).any(|w| w == needle);
    assert!(has(b"\x11Led Widget DDEEFF\x07_splanc"), "instance = device name");
    assert!(has(b"\x0dsplanc-ddeeff\x05local"), "host from the MAC");
    assert!(has(b"path=/.well-known/splanc.json") && has(b"fw=1.2.0") && has(&ip));
    assert!(has(b"\x09tls=ready"), "TXT carries the TLS identity state");
    assert!(unsafe { lm_mdns_announce(ip.as_ptr(), out.as_mut_ptr(), out.len()) } > n);
}
