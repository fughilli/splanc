// Ported from fughilli/indoor_localization swarm/net/src/budget.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! The byte budgets of firmware/mesh/swarm/docs/swarm-wire.md, asserted: every message built at its worst case
//! (ids at 16 bits, versions / sizes / generations at u32::MAX, 96 settings with 14-bit keys
//! ...) fits the frame it rides in. A frame is at most 125 bytes (DW3000 127 - 2 FCS).
//!
//! Note on `FooEnc::MAX_ENCODED_LEN` (pbview): it treats every `uint32` as a 5-byte varint,
//! which is pessimistic for fields the protocol keeps small (node ids and packet ids are 16
//! bits, registry keys 14 bits, pages 16 bits). Those budgets are asserted here on worst-case
//! values instead; the bounded envelopes (Bundle, Override) match their MAX_ENCODED_LEN
//! exactly and are asserted at compile time in settings.rs.

// Splanc (clippy): the constant asserts document the frame budgets next to the measured ones.
#![allow(clippy::assertions_on_constants, clippy::useless_vec)]

use crate::crypto::{self, TAG_MSG_MAX};
use crate::manifest::{self, Manifest};
use crate::mesh::{Header, Packet, MAX_PACKET, MAX_PAYLOAD};
use crate::net::{MAX_FRAME_PAYLOAD, SUMMARY_LEN_MAX};
use crate::settings::{self, make_bundle, make_override, Entry, Layer, Settings, CMD_MAX_ENTRIES, FRAG_DATA, MAX_BUNDLE, MAX_KEYS};
use crate::update::{self, Summary, CHUNK, DATA_MAX, REQUEST_MAX};
use crate::wire::{self, pb, SettingRec, MAX_KEY};

const FRAME: usize = 125;

#[test]
fn constants() {
    assert_eq!(MAX_PAYLOAD, 88);
    assert_eq!(FRAG_DATA, 72);
    assert_eq!(CMD_MAX_ENTRIES, 7);
    assert_eq!(CHUNK, 96);
    assert_eq!(update::PAGE_SIZE, 4096);
    assert_eq!(MAX_KEYS, 96);
    assert_eq!(TAG_MSG_MAX, 1024);
    assert_eq!(MAX_FRAME_PAYLOAD, 114);
}

#[test]
fn summary_in_a_poll() {
    let s = Summary { running: u32::MAX, staged: u32::MAX, pages: u16::MAX, total: u16::MAX, generation: u32::MAX };
    let mut b = [0u8; 64];
    let n = s.encode(&mut b).unwrap();
    assert_eq!(n, 26);
    assert_eq!(n, SUMMARY_LEN_MAX);
    // POLL: ver 2 + type 2 + src 4 + seq 3 + slot 2 = 13, advert 2 + 64, summary 2 + 26.
    assert_eq!(13 + (2 + 64) + (2 + n), 107);
    assert!(107 <= FRAME);
}

#[test]
fn manifest_frame() {
    let sha = [0xA5u8; 32];
    let mut body = [0u8; 64];
    let bn = wire::manifest_body(u32::MAX, u32::MAX, &sha, 0, &mut body).unwrap();
    assert_eq!(bn, 46);
    let mut raw = [0u8; 128];
    let n = wire::manifest(&body[..bn], &[0xEE; 64], &mut raw).unwrap();
    assert_eq!(n, 114);
    assert_eq!(n, manifest::MAX_ENCODED);
    assert!(Manifest::decode(&raw[..n]).is_some());
    // Link header of the manifest frame: ver 2 + type 2 + src 4 + payload tag/len 2 = 10.
    assert_eq!(10 + n, 124);
    assert!(10 + n <= FRAME);

    // The reserved `flags` would push the envelope to 116 and the frame to 126, so the bounds
    // file caps it at 0 and the encoder refuses it; MAX_ENCODED_LEN is the exact worst case.
    assert!(wire::manifest_body(u32::MAX, u32::MAX, &sha, 1, &mut body).is_none());
    assert_eq!(pb::ManifestEnc::MAX_ENCODED_LEN, 114);
}

#[test]
fn firmware_request_and_data_frames() {
    let mut b = [0u8; 64];
    let n = wire::fw_request(u32::MAX, u16::MAX as u32, u64::MAX, &mut b).unwrap();
    assert_eq!(n, 19);
    assert!(n <= REQUEST_MAX);
    assert!(14 + n <= FRAME, "unicast link header 14");
    // A u32 page would make it 21 (what the schema alone allows); the bounds cap pages at u16.
    assert!(wire::fw_request(u32::MAX, u32::MAX, u64::MAX, &mut b).is_none());

    let data = [0x5Au8; CHUNK];
    let mut b = [0u8; 128];
    let n = wire::fw_data(u32::MAX, u16::MAX as u32, 42, &data, &mut b).unwrap();
    assert_eq!(n, 110);
    assert_eq!(n, DATA_MAX);
    assert!(10 + n <= FRAME);
    // With pages below 16384 (images up to 64 MB) it is the 109 of firmware/mesh/swarm/docs/swarm-wire.md.
    assert_eq!(wire::fw_data(u32::MAX, 16383, 42, &data, &mut b).unwrap(), 109);
    assert!(wire::fw_data(1, 1, 1, &[0u8; CHUNK + 1], &mut b).is_none(), "bound: data <= 96");
}

#[test]
fn mesh_packet_frame() {
    let h = Header { origin: u16::MAX, id: u16::MAX, dest: u16::MAX - 1, hop_limit: 15, hop_start: 15, flags: 3, attempt: 15, port: 127 };
    let p = Packet::new(h, &[0xC3; MAX_PAYLOAD]).unwrap();
    let mut b = [0u8; 256];
    let n = p.encode(&mut b).unwrap();
    assert_eq!(n, 112);
    assert_eq!(n, MAX_PACKET);
    assert_eq!(Packet::decode(&b[..n]).unwrap(), p);
    // ver 2 + type 2 + src 4 + payload tag/len 2.
    assert!(10 + n <= FRAME);
    assert!(Packet::new(h, &[0; MAX_PAYLOAD + 1]).is_none());
    // The header alone, with every field at width: 24 including the payload tag/len.
    assert_eq!(n - MAX_PAYLOAD, 24);
    // Frames from the other mesh ports are never larger than a full payload.
    assert!(10 + MAX_PACKET <= FRAME);
}

#[test]
fn bundle_and_fragments() {
    let key = [9u8; 32];
    let mut l = Layer::default();
    for k in 0..MAX_KEYS as u16 {
        assert!(l.set(MAX_KEY - k, u32::MAX - k as u32));
    }
    let mut out = [0u8; MAX_BUNDLE];
    let n = make_bundle(&l, u32::MAX, &key, &mut out);
    assert_eq!(n, 975);
    assert_eq!(n, MAX_BUNDLE);
    assert_eq!(n.div_ceil(FRAG_DATA), 14);
    assert!(1 + 2 + (n - 3 - 6) <= TAG_MSG_MAX, "tag message: 'B' + body");

    // Worst fragment: generation MAX, total_len 975, offset 936, 72 bytes of data.
    let mut f = [0u8; 128];
    let m = wire::bundle_fragment(u32::MAX, 975, 13 * FRAG_DATA as u32, &[0u8; FRAG_DATA], &mut f).unwrap();
    assert_eq!(m, 86);
    assert!(m <= MAX_PAYLOAD);

    // More than 96 settings do not fit a bundle.
    let many: Vec<SettingRec> = (0..MAX_KEYS as u16 + 1).map(|k| SettingRec { key: k, value: 1, source: 0 }).collect();
    let mut b = [0u8; 2048];
    assert!(wire::bundle_body(1, &many, &mut b).is_none(), "bound: settings <= 96");
}

#[test]
fn override_and_report() {
    let key = [3u8; 32];
    let e = vec![Entry { key: MAX_KEY, value: u32::MAX }; CMD_MAX_ENTRIES];
    let (o, n) = make_override(u16::MAX, settings::CMD_SET, u32::MAX, &e, &key).unwrap();
    assert_eq!(n, 86);
    assert!(n <= MAX_PAYLOAD);
    assert!(pb::OverrideView::parse(&o[..n]).is_ok());
    assert!(make_override(1, settings::CMD_SET, 1, &vec![Entry { key: 1, value: 1 }; CMD_MAX_ENTRIES + 1], &key).is_none());

    let r: Vec<SettingRec> = (0..6).map(|_| SettingRec { key: MAX_KEY, value: u32::MAX, source: 2 }).collect();
    let mut b = [0u8; 128];
    let n = wire::settings_report(31, 32, u32::MAX, u32::MAX, &r, &mut b).unwrap();
    assert_eq!(n, 88);
    assert!(n <= MAX_PAYLOAD);
    let seven: Vec<SettingRec> = (0..7).map(|_| SettingRec { key: MAX_KEY, value: u32::MAX, source: 2 }).collect();
    assert!(wire::settings_report(31, 32, u32::MAX, u32::MAX, &seven, &mut b).is_none(), "bound: 6 settings");
}

#[test]
fn ack_and_tag_messages() {
    let mut b = [0u8; 16];
    assert_eq!(wire::ack(u16::MAX as u32, &mut b).unwrap(), 4);
    // The tag covers 'O' || dest || body: at most 1 + 2 + 78.
    assert!(1 + 2 + 78 <= TAG_MSG_MAX);
    let _ = crypto::TAG_LEN;
    let _ = Settings::new(1, None);
}

// ---- compile-time budgets: the bounds file (firmware/mesh/swarm/proto/swarm_wire_bounds.txt) makes every
// message's MAX_ENCODED_LEN an exact worst case, so a schema or bounds change that breaks a
// frame budget fails the build, not a test.
// Splanc: MeshPacket.payload is bounded at PAYLOAD_CAP (the largest backhaul), so the swarm's
// UWB budget is asserted on the 88-byte instance instead of on MAX_ENCODED_LEN.
const _: () = assert!(crate::mesh::max_packet(MAX_PAYLOAD) <= 115, "MeshPacket in a mesh link frame (10 + 115)");
const _: () = assert!(
    pb::MeshPacketEnc::MAX_ENCODED_LEN == crate::mesh::max_packet(crate::mesh::PAYLOAD_CAP),
    "max_packet() is the encoder's exact worst case"
);
const _: () = assert!(pb::ManifestEnc::MAX_ENCODED_LEN <= 115, "Manifest in its link frame (10 + 115)");
const _: () = assert!(pb::SummaryEnc::MAX_ENCODED_LEN <= 26, "Summary in a POLL");
const _: () = assert!(pb::FwDataEnc::MAX_ENCODED_LEN <= 115, "FwData in a broadcast link frame");
const _: () = assert!(pb::FwRequestEnc::MAX_ENCODED_LEN <= 111, "FwRequest in a unicast link frame");
const _: () = assert!(pb::SettingsReportEnc::MAX_ENCODED_LEN <= 88, "SettingsReport in a mesh payload");
const _: () = assert!(pb::BundleFragmentEnc::MAX_ENCODED_LEN <= 88, "BundleFragment in a mesh payload");
const _: () = assert!(pb::OverrideEnc::MAX_ENCODED_LEN <= 88, "Override in a mesh payload");
const _: () = assert!(pb::AckEnc::MAX_ENCODED_LEN <= 88);
