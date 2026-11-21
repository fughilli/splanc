//! The C6 front end's relay staticlib (relay_ffi.rs): routing reads (the arm, a rename's
//! name), the arms it answers itself (the Wi-Fi policy), and its mDNS identity.

use std::ffi::CString;

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_relay_ffi::{
    lm_envelope_arm, lm_mdns_announce, lm_relay_device_name, lm_relay_local, lm_relay_set_identity,
    MODE_FIXED,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn frame(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 1024>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn arm(f: &[u8]) -> i32 {
    unsafe { lm_envelope_arm(f.as_ptr(), f.len()) }
}

#[test]
fn reads_the_arm_of_any_message() {
    assert_eq!(arm(&frame(CMsg::Hello(Default::default()))), 1);
    assert_eq!(arm(&frame(CMsg::GetTlsInfo(Default::default()))), 45);
    assert_eq!(arm(&frame(CMsg::GetOtaStatus(Default::default()))), 74);
    assert_eq!(arm(&frame(CMsg::GetWifiPolicy(Default::default()))), 91);
    assert_eq!(arm(&[]), -1);
    assert_eq!(arm(&[0x80, 0x80, 0x80, 0x80, 0x80, 0x80]), -1, "an unterminated key");
}

#[test]
fn takes_a_renames_name_and_nothing_else() {
    let mut name = pb::SetDeviceName::default();
    name.r#name.push_str("Kitchen \"lamp\"").unwrap();
    let f = frame(CMsg::SetDeviceName(name));
    let mut out = [0u8; 33];
    let n = unsafe { lm_relay_device_name(f.as_ptr(), f.len(), out.as_mut_ptr(), out.len()) };
    assert_eq!(&out[..n as usize], b"Kitchen \"lamp\"");
    assert_eq!(out[n as usize], 0, "NUL-terminated");

    // Truncated to the buffer, still terminated.
    let mut small = [0xffu8; 8];
    let n = unsafe { lm_relay_device_name(f.as_ptr(), f.len(), small.as_mut_ptr(), small.len()) };
    assert_eq!((n, &small[..]), (7, &b"Kitchen\0"[..]));

    let hello = frame(CMsg::Hello(Default::default()));
    assert_eq!(unsafe { lm_relay_device_name(hello.as_ptr(), hello.len(), out.as_mut_ptr(), out.len()) }, -1);
}

fn local(f: &[u8]) -> Option<pb::WifiPolicyState> {
    let mut out = vec![0u8; 512];
    let n = unsafe { lm_relay_local(f.as_ptr(), f.len(), out.as_mut_ptr(), out.len()) };
    if n == -1 {
        return None;
    }
    assert!(n > 0, "lm_relay_local returned {n}");
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    match reply.r#msg {
        Some(SMsg::WifiPolicyState(s)) => Some(s),
        other => panic!("wifi_policy_state expected, got {other:?}"),
    }
}

#[test]
fn answers_the_wifi_policy_and_forwards_the_rest() {
    let get = frame(CMsg::GetWifiPolicy(Default::default()));
    assert!(local(&get).is_some(), "get_wifi_policy is the front end's");

    let mut set = pb::SetWifiPolicy::default();
    set.set_mode(pb::WifiMode::Fixed);
    set.set_interval_s(120);
    let s = local(&frame(CMsg::SetWifiPolicy(set))).expect("set_wifi_policy is the front end's");
    assert_eq!((s.r#mode.0, s.r#interval_s), (MODE_FIXED as i32, 120));

    // Everything else (here: player messages) is the P4's.
    for m in [
        CMsg::Hello(Default::default()),
        CMsg::GetTlsInfo(Default::default()),
        CMsg::GetOtaStatus(Default::default()),
        CMsg::SetDeviceName(Default::default()),
        CMsg::ListEffects(Default::default()),
    ] {
        assert!(local(&frame(m)).is_none());
    }
}

#[test]
fn mdns_announces_the_identity_it_was_given() {
    let (mac, name, fw, tls) = (
        CString::new("AA:BB:CC:DD:EE:FF").unwrap(),
        CString::new("Hall Lamp").unwrap(),
        CString::new("1.2.3").unwrap(),
        CString::new("ready").unwrap(),
    );
    unsafe { lm_relay_set_identity(mac.as_ptr(), name.as_ptr(), fw.as_ptr(), tls.as_ptr()) };
    let mut out = vec![0u8; 1024];
    let n = unsafe { lm_mdns_announce([192, 168, 1, 7].as_ptr(), out.as_mut_ptr(), out.len()) };
    assert!(n > 0, "announce returned {n}");
    let a = &out[..n as usize];
    let has = |needle: &[u8]| a.windows(needle.len()).any(|w| w == needle);
    assert!(has(b"Hall Lamp"), "instance name");
    assert!(has(b"id=AA:BB:CC:DD:EE:FF"), "TXT id");
    assert!(has(b"fw=1.2.3"), "TXT fw");
    assert!(has(b"tls=ready"), "TXT tls");
    assert!(has(&[192, 168, 1, 7]), "A record");

    // A rename keeps the rest.
    let renamed = CString::new("Den Lamp").unwrap();
    unsafe { lm_relay_set_identity(std::ptr::null(), renamed.as_ptr(), std::ptr::null(), std::ptr::null()) };
    let n = unsafe { lm_mdns_announce([192, 168, 1, 7].as_ptr(), out.as_mut_ptr(), out.len()) };
    let a = &out[..n as usize];
    let has = |needle: &[u8]| a.windows(needle.len()).any(|w| w == needle);
    assert!(has(b"Den Lamp") && !has(b"Hall Lamp") && has(b"fw=1.2.3"));
}
