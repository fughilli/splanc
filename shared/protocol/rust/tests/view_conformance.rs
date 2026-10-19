//! The pbview leg of the cross-language golden (web/tests/golden_proto_frames.json):
//! every Python-encoded frame parses as a zero-copy view and lands on the oneof
//! arm the golden names, and the field-level spot checks read back what the
//! golden `decoded` JSON says — straight from the frame bytes.

use base64::Engine as _;
use ledmapper_view::ledmapper::v1::{client_message, server_message, ClientMessageView, ServerMessageView};
use serde_json::Value;

fn frames() -> Vec<(String, Vec<u8>, Value)> {
    let path = std::env::var("GOLDEN_PROTO_FRAMES").expect("GOLDEN_PROTO_FRAMES");
    let j: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    j["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            let b = base64::engine::general_purpose::STANDARD
                .decode(f["frameB64"].as_str().unwrap())
                .unwrap();
            (f["direction"].as_str().unwrap().to_string(), b, f["decoded"].clone())
        })
        .collect()
}

/// `time_sync_ping` -> `TimeSyncPing` (the generated oneof variant name).
fn camel(s: &str) -> String {
    s.split('_').map(|p| p[..1].to_ascii_uppercase() + &p[1..]).collect()
}

#[test]
fn every_golden_frame_parses_onto_its_arm() {
    let mut n = 0;
    for (dir, bytes, decoded) in frames() {
        let want = camel(decoded["type"].as_str().unwrap());
        let arm = if dir == "client" {
            let v = ClientMessageView::parse(&bytes).expect("client frame validates");
            format!("{:?}", v.msg().expect("an arm is set"))
        } else {
            let v = ServerMessageView::parse(&bytes).expect("server frame validates");
            format!("{:?}", v.msg().expect("an arm is set"))
        };
        assert!(arm.starts_with(&format!("{want}(")), "{dir} frame: arm {arm}, golden {want}");
        n += 1;
    }
    assert!(n > 40, "the golden has {n} frames");
}

fn f64s(v: &Value) -> Vec<f64> {
    v.as_array().unwrap().iter().map(|x| x.as_f64().unwrap()).collect()
}

#[test]
fn spot_checks_read_the_golden_values_in_place() {
    for (dir, bytes, d) in frames() {
        if dir == "client" {
            let Some(msg) = ClientMessageView::parse(&bytes).unwrap().msg() else { continue };
            match msg {
                client_message::Msg::Hello(h) => {
                    assert_eq!(h.client(), d["client"].as_str().unwrap());
                    assert_eq!(h.app_version(), d["appVersion"].as_str().unwrap());
                }
                client_message::Msg::TimeSyncPing(p) => assert_eq!(p.t0(), d["t0"].as_f64().unwrap()),
                client_message::Msg::SubmitMap(s) => {
                    let m = s.map().unwrap();
                    let jm = &d["map"];
                    assert_eq!(m.map_id(), jm["mapId"].as_str().unwrap());
                    assert_eq!(m.led_count() as i64, jm["ledCount"].as_i64().unwrap());
                    let led = m.leds().next().unwrap();
                    assert_eq!(led.xyz().collect::<Vec<_>>(), f64s(&jm["leds"][0]["xyz"]));
                    assert_eq!(led.n_views() as i64, jm["leds"][0]["nViews"].as_i64().unwrap());
                    assert_eq!(m.unmapped().collect::<Vec<_>>(), [1]);
                    assert_eq!(m.trajectory().count(), 2);
                }
                client_message::Msg::SetCountingPattern(p) => {
                    let blocks: Vec<_> = p.blocks().collect();
                    let jb = d["blocks"].as_array().unwrap();
                    assert_eq!(blocks.len(), jb.len());
                    for (b, j) in blocks.iter().zip(jb) {
                        assert_eq!(b.start() as i64, j["start"].as_i64().unwrap_or(0));
                        assert_eq!(b.count() as i64, j["count"].as_i64().unwrap());
                        assert_eq!(b.rgb().collect::<Vec<_>>(), f64s(&j["rgb"]));
                    }
                    assert_eq!(p.channel().map(i64::from), d["channel"].as_i64());
                }
                client_message::Msg::SubmitTopology(t) => {
                    let t = t.topology().unwrap();
                    let seg = t.segments().next().unwrap();
                    assert_eq!(seg.a(), 0);
                    assert_eq!(seg.b(), -1);
                    assert_eq!(seg.polyline().count(), 3);
                    let a = t.associations().next().unwrap();
                    assert_eq!(a.foot_arclength(), 0.25);
                }
                _ => {}
            }
        } else if let Some(server_message::Msg::Welcome(w)) = ServerMessageView::parse(&bytes).unwrap().msg() {
            assert_eq!(w.session_id(), d["sessionId"].as_str().unwrap());
            assert_eq!(w.device_name(), d["deviceName"].as_str().unwrap());
            assert_eq!(w.fw_git_dirty(), d["fwGitDirty"].as_bool().unwrap());
            let cp = w.code_params().unwrap();
            assert_eq!(cp.bits() as i64, d["codeParams"]["bits"].as_i64().unwrap());
            assert_eq!(cp.fec(), d["codeParams"]["fec"].as_str().unwrap());
        }
    }
}
