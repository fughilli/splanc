//! The Wi-Fi rejoin policy (wifi_ffi.rs): validation, the OTA-pending refusal, the
//! NVS record, the console grammar, and set_wifi_policy / get_wifi_policy through the
//! C ABI (wss and the BLE player transport share lm_player_handle).

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    apply, decode, encode, lm_player_handle, lm_player_init, lm_wifi_console, lm_wifi_policy_gen,
    lm_wifi_policy_get, lm_wifi_policy_seed, lm_wifi_report, lm_wifi_set_ota_pending,
    lm_wifi_take_rejoin, parse_console, sanitize, Console, LmWifiPolicy, LmWifiStatus, Request,
    DEFAULT_POLICY, MODE_AUTO, MODE_FIXED, MODE_MANUAL, MODE_OFFLINE,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn handle(msg: CMsg) -> pb::WifiPolicyState {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 1024>::new());
    env.encode(&mut enc).unwrap();
    let frame = enc.into_writer().to_vec();
    let mut out = vec![0u8; 1024];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n > 0, "handle returned {n}");
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    match reply.r#msg {
        Some(SMsg::WifiPolicyState(s)) => s,
        other => panic!("wifi_policy_state expected, got {other:?}"),
    }
}

fn console(line: &str) -> Option<String> {
    let mut out = [0u8; 256];
    let n = unsafe { lm_wifi_console(line.as_ptr(), line.len(), out.as_mut_ptr(), out.len()) };
    (n >= 0).then(|| String::from_utf8_lossy(&out[..n as usize]).into_owned())
}

#[test]
fn defaults_and_sanitize() {
    assert_eq!(sanitize(DEFAULT_POLICY), DEFAULT_POLICY);
    let wild = LmWifiPolicy { mode: 9, scan_cap_s: 1, interval_s: 1 << 30, decay_after_h: 1 << 20, sparse_interval_s: 0 };
    assert_eq!(
        sanitize(wild),
        LmWifiPolicy { mode: MODE_AUTO, scan_cap_s: 10, interval_s: 86_400, decay_after_h: 8_760, sparse_interval_s: 60 }
    );
}

#[test]
fn offline_is_refused_while_an_update_is_unconfirmed() {
    let off = Request { mode: Some(MODE_OFFLINE), ..Default::default() };
    assert_eq!(apply(DEFAULT_POLICY, &off, true), Err("ota_pending"));
    let man = Request { mode: Some(MODE_MANUAL), ..Default::default() };
    assert_eq!(apply(DEFAULT_POLICY, &man, true), Err("ota_pending"));
    // force overrides; no pending update needs none; auto/fixed are always fine.
    assert_eq!(apply(DEFAULT_POLICY, &Request { force: true, ..off }, true).unwrap().mode, MODE_OFFLINE);
    assert_eq!(apply(DEFAULT_POLICY, &off, false).unwrap().mode, MODE_OFFLINE);
    let fixed = Request { mode: Some(MODE_FIXED), interval_s: Some(120), ..Default::default() };
    let p = apply(DEFAULT_POLICY, &fixed, true).unwrap();
    assert_eq!((p.mode, p.interval_s, p.scan_cap_s), (MODE_FIXED, 120, 60), "unset fields kept");
    // Already offline: re-asserting it (or tuning a field) isn't "leaving".
    let cur = LmWifiPolicy { mode: MODE_OFFLINE, ..DEFAULT_POLICY };
    assert!(apply(cur, &off, true).is_ok());
}

#[test]
fn record_round_trips_and_rejects_junk() {
    let p = LmWifiPolicy { mode: MODE_FIXED, scan_cap_s: 120, interval_s: 600, decay_after_h: 0, sparse_interval_s: 3600 };
    assert_eq!(decode(&encode(&p)), Some(p));
    assert_eq!(decode(&[]), None);
    let mut bad = encode(&p);
    bad[0] = 0;
    assert_eq!(decode(&bad), None);
    assert_eq!(decode(&encode(&p)[..17]), None);
    // An explicit decay chosen on this firmware (24 h included) persists.
    let on = LmWifiPolicy { decay_after_h: 24, ..DEFAULT_POLICY };
    assert_eq!(decode(&encode(&on)), Some(on));
}

#[test]
fn decay_is_opt_in_and_v1_records_migrate() {
    assert_eq!(DEFAULT_POLICY.decay_after_h, 0, "decay off by default");
    assert_eq!(DEFAULT_POLICY.sparse_interval_s, 900, "the sparse period is ready for when it is enabled");
    let v1 = |p: &LmWifiPolicy| {
        let mut r = encode(p);
        r[0] = 1;
        r
    };
    // A v1 record (pre-opt-in firmware) carries the old default 24 h whenever the user
    // never chose a decay: it reads back as off, the rest of the record intact.
    let old = LmWifiPolicy { mode: MODE_FIXED, interval_s: 120, decay_after_h: 24, ..DEFAULT_POLICY };
    assert_eq!(decode(&v1(&old)), Some(LmWifiPolicy { decay_after_h: 0, ..old }));
    // Any other v1 decay was an explicit choice: kept (off stays off).
    for h in [0, 1, 12, 48, 8_760] {
        let p = LmWifiPolicy { decay_after_h: h, ..DEFAULT_POLICY };
        assert_eq!(decode(&v1(&p)).unwrap().decay_after_h, h, "v1 decay {h}");
    }
    // Records are written as v2 from now on.
    assert_eq!(encode(&DEFAULT_POLICY)[0], 2);
    let mut v3 = encode(&DEFAULT_POLICY);
    v3[0] = 3;
    assert_eq!(decode(&v3), None, "an unknown future version keeps the defaults");
}

#[test]
fn console_parses_modes_and_fields() {
    assert_eq!(parse_console(b"REJOIN"), Console::Rejoin);
    assert_eq!(parse_console(b"status"), Console::Status);
    assert_eq!(
        parse_console(b"MODE offline"),
        Console::Set(Request { mode: Some(MODE_OFFLINE), ..Default::default() })
    );
    assert_eq!(
        parse_console(b"mode auto cap=120 decay=48 sparse=1800"),
        Console::Set(Request {
            mode: Some(MODE_AUTO),
            scan_cap_s: Some(120),
            decay_after_h: Some(48),
            sparse_interval_s: Some(1800),
            ..Default::default()
        })
    );
    assert_eq!(
        parse_console(b"MODE fixed every=30 force"),
        Console::Set(Request { mode: Some(MODE_FIXED), interval_s: Some(30), force: true, ..Default::default() })
    );
    for bad in [&b"MODE"[..], b"MODE sometimes", b"MODE auto cap=x", b"MODE auto bogus=1", b"SCAN", b""] {
        assert_eq!(parse_console(bad), Console::Unknown, "{:?}", core::str::from_utf8(bad));
    }
}


/// One process-global flow (the FFI state is global): seed, set over the protocol,
/// the OTA refusal, the console, the reported link state.
#[test]
fn policy_through_the_c_abi() {
    lm_player_init(64);
    // Boot: a persisted record wins over the defaults; junk keeps the defaults.
    let rec = encode(&LmWifiPolicy { mode: MODE_FIXED, interval_s: 120, ..DEFAULT_POLICY });
    let mut applied = DEFAULT_POLICY;
    unsafe { lm_wifi_policy_seed(rec.as_ptr(), rec.len(), &mut applied) };
    assert_eq!((applied.mode, applied.interval_s), (MODE_FIXED, 120));
    let gen0 = unsafe { lm_wifi_policy_gen() };

    // get_wifi_policy reports it, with the transport's live state.
    let mut st = LmWifiStatus { state: 4, radio_on: true, decayed: false, next_scan_s: 40, scans: 3, unseen_s: 95, ssid: [0; 33] };
    st.ssid[..6].copy_from_slice(b"Venue1");
    unsafe { lm_wifi_report(&st) };
    let s = handle(CMsg::GetWifiPolicy(pb::GetWifiPolicy::default()));
    assert_eq!((s.r#mode.0, s.r#interval_s, s.r#state.0, s.r#next_scan_s, s.r#scans), (1, 120, 4, 40, 3));
    assert_eq!(s.r#ssid.as_str(), "Venue1");
    assert!(s.r#radio_on && !s.r#ota_pending && s.r#refused.is_empty());

    // An unconfirmed update: going offline is refused (state says why), nothing changes.
    unsafe { lm_wifi_set_ota_pending(true) };
    let mut m = pb::SetWifiPolicy::default();
    m.set_mode(pb::WifiMode::Offline);
    let s = handle(CMsg::SetWifiPolicy(m.clone()));
    assert_eq!(s.r#refused.as_str(), "ota_pending");
    assert!(s.r#ota_pending && s.r#mode.0 == 1);
    assert_eq!(unsafe { lm_wifi_policy_gen() }, gen0, "a refusal applies nothing");
    // The refusal is reported once; a plain get afterwards is clean.
    assert!(handle(CMsg::GetWifiPolicy(pb::GetWifiPolicy::default())).r#refused.is_empty());
    // force goes through.
    m.r#force = true;
    let s = handle(CMsg::SetWifiPolicy(m));
    assert_eq!((s.r#mode.0, s.r#refused.as_str()), (3, ""));
    assert_ne!(unsafe { lm_wifi_policy_gen() }, gen0);
    let mut live = DEFAULT_POLICY;
    let mut rec = [0u8; 18];
    unsafe { lm_wifi_policy_get(&mut live, rec.as_mut_ptr()) };
    assert_eq!(live.mode, MODE_OFFLINE);
    assert_eq!(decode(&rec), Some(live), "the persisted record is the live policy");

    // Back to auto with a new cap + a rejoin request; unset fields keep their values.
    unsafe { lm_wifi_set_ota_pending(false) };
    let mut m = pb::SetWifiPolicy::default();
    m.set_mode(pb::WifiMode::Auto);
    m.set_scan_cap_s(300);
    m.r#rejoin_now = true;
    let s = handle(CMsg::SetWifiPolicy(m));
    assert_eq!((s.r#mode.0, s.r#scan_cap_s, s.r#interval_s), (0, 300, 120));
    assert!(unsafe { lm_wifi_take_rejoin() });
    assert!(!unsafe { lm_wifi_take_rejoin() }, "the rejoin request drains");

    // The console: same policy, same refusal, a one-line status.
    let r = console("MODE manual").expect("parsed");
    assert!(r.contains("mode=manual"), "{r}");
    unsafe { lm_wifi_set_ota_pending(true) };
    let r = console("MODE auto").expect("parsed");
    assert!(r.contains("mode=auto") && !r.contains("REFUSED"), "back online is never refused: {r}");
    let r = console("MODE offline").expect("parsed");
    assert!(r.contains("REFUSED") && r.contains("mode=auto"), "{r}");
    let r = console("MODE offline force").expect("parsed");
    assert!(r.contains("mode=offline"), "{r}");
    assert!(console("REJOIN").is_some());
    assert!(unsafe { lm_wifi_take_rejoin() });
    assert!(console("STATUS").unwrap().contains("state=4"));
    assert!(console("FROB").is_none());
}
