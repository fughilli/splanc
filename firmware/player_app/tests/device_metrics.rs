//! Opt-in device metrics (metrics_ffi.rs, docs/design/device-metrics.md):
//! get_device_metrics through the C ABI, decoded with the host bindings.
//!
//! - without a registered source (host / a board that registers none) the reply
//!   still carries the version, board and the autoscaler's frame rates;
//! - with one, every C++-side field lands in its proto field (sint32 RSSI
//!   included), and a zero mesh mode leaves every mesh field out;
//! - a locked kiosk refuses it like any arm it doesn't list;
//! - the reply is small (no by-value envelope; well inside one wss / BLE record).

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{kiosk_ffi, lm_metrics_set_source, lm_player_handle, lm_player_init, LmSysMetrics};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn ask() -> (pb::DeviceMetrics, usize) {
    let env = pb::ClientMessage { r#msg: Some(CMsg::GetDeviceMetrics(pb::GetDeviceMetrics::default())) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 64>::new());
    env.encode(&mut enc).unwrap();
    let frame = enc.into_writer().to_vec();
    let mut out = vec![0u8; 512];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n > 0, "handle returned {n}");
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    match reply.r#msg {
        Some(SMsg::DeviceMetrics(m)) => (m, n as usize),
        other => panic!("device_metrics expected, got {other:?}"),
    }
}

unsafe extern "C" fn fake(m: *mut LmSysMetrics) {
    *m = LmSysMetrics {
        uptime_s: 3600,
        reset_reason: 4,
        boot_count: 3,
        wdt_resets: 1,
        panic_resets: 1,
        brownout_resets: 0,
        heap_free: 81_000,
        heap_min_free: 54_000,
        heap_largest_free: 30_000,
        led_count: 512,
        wifi_joins: 2,
        wifi_link_losses: 1,
        wifi_rssi_dbm: -61,
        ble_drops: 2,
        mesh_mode: 0,
        mesh_members: 9, // ignored: no mesh
        ..LmSysMetrics::default()
    };
}

unsafe extern "C" fn fake_mesh(m: *mut LmSysMetrics) {
    fake(m);
    (*m).mesh_mode = 2;
    (*m).mesh_members = 24;
    (*m).mesh_delivery_permille = 998;
    (*m).mesh_mode_switches = 1;
}

// One test: the source pointer and the player are process-global.
#[test]
fn device_metrics_arm() {
    unsafe { lm_player_init(512) };

    let (m, n) = ask();
    assert_eq!(m.r#version, 1);
    assert_eq!(m.r#board.as_str(), "host");
    assert!(m.r#fps_max > 0, "the autoscaler's ceiling is always known");
    assert_eq!(m.r#uptime_s, 0, "nothing the C++ side owns without a source");
    assert!(n < 64, "small reply ({n} bytes)");

    unsafe { lm_metrics_set_source(Some(fake)) };
    let (m, n) = ask();
    assert_eq!(m.r#uptime_s, 3600);
    assert_eq!(m.r#reset_reason, 4);
    assert_eq!((m.r#boot_count, m.r#wdt_resets, m.r#panic_resets, m.r#brownout_resets), (3, 1, 1, 0));
    assert_eq!((m.r#heap_free, m.r#heap_min_free, m.r#heap_largest_free), (81_000, 54_000, 30_000));
    assert_eq!(m.r#led_count, 512);
    assert_eq!((m.r#wifi_joins, m.r#wifi_link_losses, m.r#wifi_rssi_dbm, m.r#ble_drops), (2, 1, -61, 2));
    assert_eq!((m.r#mesh_mode, m.r#mesh_members), (0, 0), "no mesh: no mesh fields");
    assert!(n < 128, "small reply ({n} bytes)");

    unsafe { lm_metrics_set_source(Some(fake_mesh)) };
    let (m, _) = ask();
    assert_eq!((m.r#mesh_mode, m.r#mesh_members, m.r#mesh_delivery_permille, m.r#mesh_mode_switches), (2, 24, 998, 1));

    unsafe { lm_metrics_set_source(None) };
    // Kiosk: not on a locked kiosk's list (an owner's device reports from the owner's app).
    assert_eq!(kiosk_ffi::classify(120, &[]), kiosk_ffi::Class::Refuse);
}
