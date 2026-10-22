//! The hand-coded OTA codec (src/wire.rs) against the generated host bindings of
//! ledmapper.proto: every field number and wire type, both directions. If someone
//! renumbers an OTA arm in the .proto, this fails instead of the loader.

use ledmapper_pb::ledmapper_::v1_ as pb;
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;
use splanc_ota::wire::{self, ClientArm, LoaderWelcome, RebootTarget, Status};

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 16384>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

/// The bytes of length-delimited field `num` in a protobuf message (test helper).
fn raw_field(b: &[u8], num: u32) -> Option<&[u8]> {
    let mut o = 0;
    let varint = |o: &mut usize| -> u64 {
        let mut v = 0u64;
        for i in 0.. {
            let c = b[*o];
            *o += 1;
            v |= ((c & 0x7f) as u64) << (7 * i);
            if c & 0x80 == 0 {
                break;
            }
        }
        v
    };
    while o < b.len() {
        let key = varint(&mut o);
        match key & 7 {
            0 => {
                varint(&mut o);
            }
            1 => o += 8,
            5 => o += 4,
            2 => {
                let n = varint(&mut o) as usize;
                if (key >> 3) as u32 == num {
                    return Some(&b[o..o + n]);
                }
                o += n;
            }
            _ => return None,
        }
    }
    None
}

fn decode_server(b: &[u8]) -> SMsg {
    let mut m = pb::ServerMessage::default();
    m.decode_from_bytes(b).expect("decodes with the generated bindings");
    m.r#msg.expect("an arm")
}

#[test]
fn client_arms_decode() {
    let manifest: Vec<u8> = (0..108u8).collect();
    let mut begin = pb::OtaBegin::default();
    begin.r#manifest.extend_from_slice(&manifest).unwrap();
    begin.r#allow_downgrade = true;
    let epoch: Vec<u8> = (100..180u8).collect();
    begin.r#key_epoch.extend_from_slice(&epoch).unwrap();
    let f = encode(CMsg::OtaBegin(begin));
    assert_eq!(
        wire::decode_client(&f).unwrap(),
        ClientArm::OtaBegin { manifest: &manifest, allow_downgrade: true, key_epoch: &epoch }
    );

    let data: Vec<u8> = (0..4096u32).map(|i| i as u8).collect();
    let mut chunk = pb::OtaChunk::default();
    chunk.r#offset = 0x1234_5000;
    chunk.r#data.extend_from_slice(&data).unwrap();
    let f = encode(CMsg::OtaChunk(chunk));
    assert_eq!(wire::decode_client(&f).unwrap(), ClientArm::OtaChunk { offset: 0x1234_5000, data: &data });

    assert_eq!(wire::decode_client(&encode(CMsg::OtaFinish(Default::default()))).unwrap(), ClientArm::OtaFinish);
    assert_eq!(wire::decode_client(&encode(CMsg::OtaAbort(Default::default()))).unwrap(), ClientArm::OtaAbort);
    assert_eq!(
        wire::decode_client(&encode(CMsg::GetOtaStatus(Default::default()))).unwrap(),
        ClientArm::GetOtaStatus
    );
    let mut rb = pb::OtaReboot::default();
    rb.r#target = pb::OtaReboot_::Target::Loader;
    assert_eq!(
        wire::decode_client(&encode(CMsg::OtaReboot(rb))).unwrap(),
        ClientArm::OtaReboot { target: RebootTarget::Loader }
    );
    assert_eq!(
        wire::decode_client(&encode(CMsg::OtaReboot(Default::default()))).unwrap(),
        ClientArm::OtaReboot { target: RebootTarget::App }
    );
    assert_eq!(wire::decode_client(&encode(CMsg::Hello(Default::default()))).unwrap(), ClientArm::Hello);
    let ping = pb::TimeSyncPing { r#t0: 1234.5 };
    assert_eq!(wire::decode_client(&encode(CMsg::TimeSyncPing(ping))).unwrap(), ClientArm::TimeSyncPing { t0: 1234.5 });
    assert_eq!(wire::decode_client(&encode(CMsg::GetTlsInfo(Default::default()))).unwrap(), ClientArm::GetTlsInfo);
    // Any other arm is identified by number, never misread.
    assert_eq!(
        wire::decode_client(&encode(CMsg::ListEffects(Default::default()))).unwrap(),
        ClientArm::Other(36)
    );
    assert_eq!(wire::decode_client(&[]).unwrap(), ClientArm::Empty);
}

#[test]
fn malformed_frames_are_refused_not_misread() {
    let mut chunk = pb::OtaChunk::default();
    chunk.r#data.extend_from_slice(&[1; 100]).unwrap();
    let f = encode(CMsg::OtaChunk(chunk));
    for cut in 1..f.len() {
        // Every truncation is either malformed or (at a field boundary) a shorter arm.
        if let Ok(ClientArm::OtaChunk { data, .. }) = wire::decode_client(&f[..cut]) {
            assert!(data.len() < 100);
        }
    }
    assert!(wire::decode_client(&[0x0a, 0xff, 0xff, 0xff, 0xff, 0x0f]).is_err(), "length past the end");
    assert!(wire::decode_client(&[0x07]).is_err(), "field 0");
}

fn sample_status<'a>() -> Status<'a> {
    Status {
        mode: wire::Mode::Loader as u8,
        state: wire::State::Receiving as u8,
        version: 1_009_000,
        size: 2_057_008,
        offset: 65536,
        error: "out_of_order",
        app_version: 1_008_002,
        app_fw_version: "1.8.2",
        loader_reason: "update",
        last_result: "ok",
        loader_version: 1_009_000,
        max_chunk: 4096,
        slot_size: 0x240000,
        key_epoch: 3,
        revoked_keys: 0b1,
        security_floor: 2,
    }
}

fn check_status(st: &pb::OtaStatus) {
    assert_eq!(st.r#mode, pb::OtaStatus_::Mode::Loader);
    assert_eq!(st.r#state, pb::OtaStatus_::State::Receiving);
    assert_eq!(st.r#version, 1_009_000);
    assert_eq!(st.r#size, 2_057_008);
    assert_eq!(st.r#offset, 65536);
    assert_eq!(st.r#error.as_str(), "out_of_order");
    assert_eq!(st.r#app_version, 1_008_002);
    assert_eq!(st.r#app_fw_version.as_str(), "1.8.2");
    assert_eq!(st.r#loader_reason.as_str(), "update");
    assert_eq!(st.r#last_result.as_str(), "ok");
    assert_eq!(st.r#loader_version, 1_009_000);
    assert_eq!(st.r#max_chunk, 4096);
    assert_eq!(st.r#slot_size, 0x240000);
    assert_eq!((st.r#key_epoch, st.r#revoked_keys, st.r#security_floor), (3, 1, 2));
}

#[test]
fn ota_status_encodes() {
    let mut out = [0u8; 512];
    let n = wire::encode_status(&sample_status(), &mut out).unwrap();
    match decode_server(&out[..n]) {
        SMsg::OtaStatus(st) => check_status(&st),
        other => panic!("{other:?}"),
    }
    assert!(wire::encode_status(&sample_status(), &mut out[..20]).is_none(), "overflow is reported");
}

#[test]
fn the_state_enums_match_the_proto() {
    use pb::OtaStatus_::{Mode, State};
    assert_eq!(Mode::App.0, wire::Mode::App as i32);
    assert_eq!(Mode::Loader.0, wire::Mode::Loader as i32);
    for (p, w) in [
        (State::Idle, wire::State::Idle),
        (State::Rebooting, wire::State::Rebooting),
        (State::Receiving, wire::State::Receiving),
        (State::Verifying, wire::State::Verifying),
        (State::Installed, wire::State::Installed),
        (State::Failed, wire::State::Failed),
    ] {
        assert_eq!(p.0, w as i32);
    }
}

#[test]
fn loader_welcome_error_pong_and_tls_info_encode() {
    let mut out = [0u8; 1024];
    let wl = LoaderWelcome {
        mac: "AA:BB:CC:DD:EE:FF",
        device_name: "Led Widget DDEEFF",
        fw_git_commit: "0123456789abcdef0123456789abcdef01234567",
        fw_git_dirty: true,
        fw_version: "loader-1.9.0",
        status: sample_status(),
    };
    let n = wire::encode_loader_welcome(&wl, &mut out).unwrap();
    // welcome.ota (field 16) isn't in the generated Welcome (skipped: it would sit
    // inline in every ServerMessage), so decode it from the raw welcome bytes.
    let ota = raw_field(raw_field(&out[..n], 1).expect("welcome"), wire::WELCOME_OTA).expect("welcome.ota");
    let mut st = pb::OtaStatus::default();
    st.decode_from_bytes(ota).unwrap();
    check_status(&st);
    match decode_server(&out[..n]) {
        SMsg::Welcome(w) => {
            assert_eq!(w.r#mac.as_str(), wl.mac);
            assert_eq!(w.r#device_name.as_str(), wl.device_name);
            assert_eq!(w.r#fw_git_commit.as_str(), wl.fw_git_commit);
            assert!(w.r#fw_git_dirty);
            assert_eq!(w.r#fw_version.as_str(), "loader-1.9.0");
            let feats: Vec<&str> = w.r#features.iter().map(|f| f.as_str()).collect();
            assert_eq!(feats, wire::LOADER_FEATURES);
        }
        other => panic!("{other:?}"),
    }

    let n = wire::encode_error("unsupported", "the device is in its update loader", &mut out).unwrap();
    match decode_server(&out[..n]) {
        SMsg::Error(e) => {
            assert_eq!(e.r#code.as_str(), "unsupported");
            assert_eq!(e.r#message.as_str(), "the device is in its update loader");
        }
        other => panic!("{other:?}"),
    }

    let n = wire::encode_time_sync_pong(1234.5, 99.0, 100.25, &mut out).unwrap();
    match decode_server(&out[..n]) {
        SMsg::TimeSyncPong(p) => assert_eq!((p.r#t0, p.r#t1, p.r#t2), (1234.5, 99.0, 100.25)),
        other => panic!("{other:?}"),
    }

    let n = wire::encode_tls_info("ready", "ab".repeat(32).as_str(), true, &mut out).unwrap();
    match decode_server(&out[..n]) {
        SMsg::TlsInfo(t) => {
            assert_eq!(t.r#state.as_str(), "ready");
            assert_eq!(t.r#cert_sha256.as_str(), "ab".repeat(32));
            assert!(t.r#persisted);
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn an_idle_status_is_still_a_present_arm() {
    // Every field default: the envelope must still carry the arm (a client
    // waiting for ota_status would otherwise see "no message set").
    let mut out = [0u8; 64];
    let n = wire::encode_status(&Status::default(), &mut out).unwrap();
    assert!(matches!(decode_server(&out[..n]), SMsg::OtaStatus(_)));
}
