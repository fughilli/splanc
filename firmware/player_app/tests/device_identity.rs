//! Device-visible identity through the player's C ABI — the seam main.cpp
//! drives. At boot the firmware hands the core the factory MAC + the configured
//! (NVS-persisted) display name via `lm_player_set_identity`; every `welcome`
//! the app reads must report exactly that identity. A `set_device_name` rename
//! must show up in the reply `welcome` AND in what the firmware reads back with
//! `lm_device_name` after each message (the bytes it persists to NVS and
//! advertises over BLE), so the app, the persisted name and the advertisement
//! never disagree — including after a reboot that restores the persisted name.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_device_name, lm_player_handle, lm_player_init, lm_player_set_identity,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

/// main.cpp's rename poll reads the name into `char buf[33]` and passes
/// `sizeof buf - 1` (poll_device_rename); the persisted / advertised name is
/// whatever fits there.
const FW_NAME_POLL_CAP: usize = 32;

const MAC: &str = "F0:F5:BD:01:23:45";

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "lm_player_handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

/// Boot the player the way setup() does: init, then the identity resolved from
/// the factory MAC + the persisted (or default) name.
fn boot_with(name: &str) {
    lm_player_init(64);
    unsafe { lm_player_set_identity(MAC.as_ptr(), MAC.len(), name.as_ptr(), name.len()) };
}

fn hello_welcome() -> pb::Welcome {
    match handle(&encode(CMsg::Hello(pb::Hello::default()))) {
        Some(SMsg::Welcome(w)) => w,
        other => panic!("hello must reply welcome, got {other:?}"),
    }
}

fn rename(name: &str) -> pb::Welcome {
    let mut m = pb::SetDeviceName::default();
    m.r#name = name.parse().expect("name fits the wire string cap");
    match handle(&encode(CMsg::SetDeviceName(m))) {
        Some(SMsg::Welcome(w)) => w,
        other => panic!("set_device_name must reply welcome, got {other:?}"),
    }
}

/// What the firmware's post-message rename poll sees (the name it persists to
/// NVS and re-advertises over BLE), or None when the poll yields nothing.
fn firmware_polled_name() -> Option<String> {
    let mut buf = [0u8; FW_NAME_POLL_CAP];
    let n = unsafe { lm_device_name(buf.as_mut_ptr(), buf.len()) };
    if n <= 0 {
        return None;
    }
    Some(String::from_utf8(buf[..n as usize].to_vec()).expect("polled name is UTF-8"))
}

#[test]
fn welcome_reports_the_identity_the_firmware_configured_at_boot() {
    rr::verifies!("PR-14");
    // The MAC-derived default name main.cpp builds on first boot.
    boot_with("Led Widget 1A2B3C");
    let w = hello_welcome();
    assert_eq!(w.r#device_name.as_str(), "Led Widget 1A2B3C");
    assert_eq!(w.r#mac.as_str(), MAC);
    // The firmware's own view of the name agrees with what the app was told.
    assert_eq!(firmware_polled_name().as_deref(), Some("Led Widget 1A2B3C"));
}

#[test]
fn a_rename_reaches_the_reply_the_next_session_and_the_firmware_poll() {
    rr::verifies!("PR-14");
    boot_with("Led Widget 1A2B3C");
    let reply = rename("Porch Arch");
    assert_eq!(reply.r#device_name.as_str(), "Porch Arch", "the rename reply echoes the new name");
    assert_eq!(reply.r#mac.as_str(), MAC, "a rename never changes the hardware identity");
    // What main.cpp persists + advertises after handling the message.
    assert_eq!(firmware_polled_name().as_deref(), Some("Porch Arch"));
    // A later session (a reconnecting app) is greeted with the renamed device.
    let w = hello_welcome();
    assert_eq!(w.r#device_name.as_str(), "Porch Arch");
    assert_eq!(w.r#mac.as_str(), MAC);
}

#[test]
fn the_last_of_several_renames_wins_on_every_surface() {
    rr::verifies!("PR-14");
    boot_with("Led Widget 1A2B3C");
    rename("Kitchen");
    rename("Kitchen Shelf");
    let last = rename("Shelf");
    assert_eq!(last.r#device_name.as_str(), "Shelf");
    assert_eq!(firmware_polled_name().as_deref(), Some("Shelf"));
    assert_eq!(hello_welcome().r#device_name.as_str(), "Shelf");
}

#[test]
fn a_renamed_identity_survives_a_reboot_through_the_persisted_name() {
    rr::verifies!("PR-14");
    // A non-ASCII name that still fits the firmware's 32-byte name buffer: the
    // bytes must round-trip exactly (no transcoding, no truncation).
    let name = "Küche – Regal";
    assert!(name.len() <= FW_NAME_POLL_CAP);
    boot_with("Led Widget 1A2B3C");
    assert_eq!(rename(name).r#device_name.as_str(), name);
    // main.cpp persists exactly what the poll returns (prefs.putString("name")).
    let persisted = firmware_polled_name().expect("a rename is visible to the firmware poll");
    assert_eq!(persisted, name);
    // Reboot: setup() restores the persisted name and hands it back to the core.
    boot_with(&persisted);
    let w = hello_welcome();
    assert_eq!(w.r#device_name.as_str(), name, "the renamed identity survives the reboot");
    assert_eq!(w.r#mac.as_str(), MAC);
    assert_eq!(firmware_polled_name().as_deref(), Some(name));
}
