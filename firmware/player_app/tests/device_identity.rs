//! Device-visible identity through the player's C ABI — the seam main.cpp
//! drives. At boot the firmware hands the core the factory MAC + the configured
//! (NVS-persisted) display name via `lm_player_set_identity`; every `welcome`
//! the app reads must report exactly that identity. A `set_device_name` rename
//! must show up in the reply `welcome` AND in what `lm_device_name` hands to
//! main.cpp's post-message rename poll (poll_device_rename).
//!
//! Partial PR-14 evidence, for the configured display-name surface only: the
//! welcome and the poll both read the core's one name field, so these cases
//! check that boot, rename and set_identity keep that field right. What main.cpp
//! then does with the polled name (persist it to NVS, push it to BLE, the soft-AP
//! name, the hostname) is not exercised here, and a reboot is simulated by
//! calling `lm_player_set_identity` again. Cross-surface consistency stays
//! under-verified. The netstack mDNS seam is: after a rename the firmware sends
//! `lm_mdns_goodbye` (TTL 0 for the name the last announcement carried), then
//! `lm_mdns_announce` under the new name.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_device_name, lm_mdns_announce, lm_mdns_goodbye, lm_mdns_respond, lm_player_handle, lm_player_init,
    lm_player_set_identity,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

/// main.cpp's rename poll reads the name into `char buf[33]` and passes
/// `sizeof buf - 1` (poll_device_rename); a longer name yields nothing there.
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

/// What `lm_device_name` hands main.cpp's post-message rename poll (into a
/// buffer of the poll's size), or None when the poll yields nothing.
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
    // What lm_device_name hands main.cpp's rename poll after the message.
    assert_eq!(firmware_polled_name().as_deref(), Some("Porch Arch"));
    // A later session (a reconnecting app) is greeted with the renamed device.
    let w = hello_welcome();
    assert_eq!(w.r#device_name.as_str(), "Porch Arch");
    assert_eq!(w.r#mac.as_str(), MAC);
}

#[test]
fn the_last_of_several_renames_wins_in_the_reply_the_poll_and_the_next_welcome() {
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
fn a_non_ascii_name_round_trips_byte_exact_through_the_rename_poll_and_set_identity() {
    rr::verifies!("PR-14");
    // A non-ASCII name that still fits the firmware's 32-byte name buffer: the
    // bytes must round-trip exactly (no transcoding, no truncation). (Names of
    // 33-64 bytes, which the wire accepts, don't fit the poll at all: not
    // covered here.)
    let name = "Küche – Regal";
    assert!(name.len() <= FW_NAME_POLL_CAP);
    boot_with("Led Widget 1A2B3C");
    assert_eq!(rename(name).r#device_name.as_str(), name);
    // The bytes the poll hands main.cpp (which it would persist with
    // prefs.putString("name"); NVS itself is not exercised).
    let polled = firmware_polled_name().expect("a rename is visible to the firmware poll");
    assert_eq!(polled, name);
    // A simulated reboot: hand those bytes back through set_identity, as setup()
    // would after reading NVS.
    boot_with(&polled);
    let w = hello_welcome();
    assert_eq!(w.r#device_name.as_str(), name, "the name comes back byte-exact");
    assert_eq!(w.r#mac.as_str(), MAC);
    assert_eq!(firmware_polled_name().as_deref(), Some(name));
}

/// One DNS resource record of an mDNS message: (owner name, type, class, TTL).
type Rr = (String, u16, u16, u32);

/// Read a (possibly compressed) DNS name at `off`; returns it and the offset after it.
fn dns_name(m: &[u8], mut off: usize) -> (String, usize) {
    let mut labels = Vec::new();
    let mut end = None;
    loop {
        let l = m[off] as usize;
        if l == 0 {
            off += 1;
            break;
        }
        if l & 0xc0 == 0xc0 {
            end.get_or_insert(off + 2);
            off = ((l & 0x3f) << 8) | m[off + 1] as usize;
            continue;
        }
        labels.push(String::from_utf8_lossy(&m[off + 1..off + 1 + l]).into_owned());
        off += 1 + l;
    }
    (labels.join("."), end.unwrap_or(off))
}

/// The flags and answer records of an mDNS response (no questions, as the firmware sends).
fn dns_answers(m: &[u8]) -> (u16, Vec<Rr>) {
    let be16 = |o: usize| u16::from_be_bytes([m[o], m[o + 1]]);
    assert_eq!(be16(4), 0, "a response carries no questions");
    let n = be16(6) + be16(8) + be16(10);
    let mut off = 12;
    let mut rrs = Vec::new();
    for _ in 0..n {
        let (name, o) = dns_name(m, off);
        let ttl = u32::from_be_bytes([m[o + 4], m[o + 5], m[o + 6], m[o + 7]]);
        rrs.push((name, be16(o), be16(o + 2), ttl));
        off = o + 10 + be16(o + 8) as usize;
    }
    assert_eq!(off, m.len(), "records span the whole message");
    (be16(2), rrs)
}

fn mdns(f: unsafe extern "C" fn(*const u8, *mut u8, usize) -> i32) -> Option<Vec<u8>> {
    let ip = [192u8, 168, 4, 23];
    let mut out = [0u8; 1024];
    let n = unsafe { f(ip.as_ptr(), out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "mDNS render returned {n}");
    (n > 0).then(|| out[..n as usize].to_vec())
}

/// A `_splanc._tcp` PTR query answered by the responder (what a browsing phone sends).
fn mdns_query_reply() -> Vec<u8> {
    let mut q = vec![0u8, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
    for l in ["_splanc", "_tcp", "local"] {
        q.push(l.len() as u8);
        q.extend_from_slice(l.as_bytes());
    }
    q.extend([0, 0, 12, 0, 1]);
    let ip = [192u8, 168, 4, 23];
    let mut out = [0u8; 1024];
    let mut unicast = false;
    let n = unsafe { lm_mdns_respond(q.as_ptr(), q.len(), 5353, ip.as_ptr(), out.as_mut_ptr(), out.len(), &mut unicast) };
    assert!(n > 0, "the responder answers ({n})");
    out[..n as usize].to_vec()
}

fn instance_of(rrs: &[Rr]) -> Vec<&str> {
    rrs.iter().filter(|r| r.1 == 33).map(|r| r.0.as_str()).collect()
}

// The goodbye tracks the name the last *announcement* carried (process-global, like
// the device), so the whole sequence lives in one test.
#[test]
fn a_rename_withdraws_the_announced_name_from_mdns_and_announces_the_new_one() {
    rr::verifies!("PR-14");
    boot_with("Led Widget 1A2B3C");
    // Nothing announced yet: nothing for browsers to forget.
    assert_eq!(mdns(lm_mdns_goodbye), None, "no goodbye before the first announcement");

    let (_, ann) = dns_answers(&mdns(lm_mdns_announce).expect("announcement"));
    assert_eq!(instance_of(&ann), vec!["Led Widget 1A2B3C._splanc._tcp.local"]);
    // Same name since the announcement: a rename poll that changed nothing withdraws nothing.
    assert_eq!(mdns(lm_mdns_goodbye), None, "unchanged name, no goodbye");

    rename("Porch Arch");
    // A browser query lands between the rename and the firmware's idle tick: the reply
    // already carries the new name, and must not count as having withdrawn the old one.
    let (_, reply) = dns_answers(&mdns_query_reply());
    assert!(reply.iter().any(|r| r.1 == 12), "PTR answered");
    let reply_names: Vec<_> = reply.iter().map(|r| r.0.as_str()).collect();
    assert!(!reply_names.iter().any(|n| n.starts_with("Led Widget")), "the reply is under the new name: {reply_names:?}");

    let (flags, bye) = dns_answers(&mdns(lm_mdns_goodbye).expect("a goodbye after the rename"));
    assert_eq!(flags, 0x8400, "authoritative response");
    assert!(bye.iter().all(|r| r.3 == 0), "every goodbye record has TTL 0: {bye:?}");
    assert!(bye.iter().all(|r| r.2 == 1), "no cache-flush bit on a goodbye: {bye:?}");
    assert_eq!(instance_of(&bye), vec!["Led Widget 1A2B3C._splanc._tcp.local"], "withdraws the OLD instance");
    let types: Vec<u16> = bye.iter().map(|r| r.1).collect();
    assert!(types.contains(&12) && types.contains(&16), "PTR and TXT withdrawn too: {types:?}");
    assert!(
        !bye.iter().any(|r| r.0.starts_with("splanc-")),
        "the MAC host record stays (it doesn't change with the name): {bye:?}"
    );

    // Until the firmware re-announces, a repeated goodbye is still about the old name.
    assert_eq!(instance_of(&dns_answers(&mdns(lm_mdns_goodbye).unwrap()).1), instance_of(&bye));
    let (_, ann) = dns_answers(&mdns(lm_mdns_announce).expect("re-announcement"));
    assert_eq!(instance_of(&ann), vec!["Porch Arch._splanc._tcp.local"]);
    assert!(ann.iter().all(|r| r.3 > 0), "the announcement carries live TTLs");
    // Announced under the new name: nothing left to withdraw.
    assert_eq!(mdns(lm_mdns_goodbye), None, "no goodbye once the new name is announced");

    // Two renames between idle ticks: one goodbye, for the name browsers actually have.
    rename("Kitchen");
    rename("Kitchen Shelf");
    let (_, bye) = dns_answers(&mdns(lm_mdns_goodbye).unwrap());
    assert_eq!(instance_of(&bye), vec!["Porch Arch._splanc._tcp.local"]);
    // Renamed back to the announced name before the tick: nothing to withdraw.
    rename("Porch Arch");
    assert_eq!(mdns(lm_mdns_goodbye), None, "renamed back to what browsers have cached");
}
