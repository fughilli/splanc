// Ported from fughilli/indoor_localization swarm/net/src/golden.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! Golden vectors (firmware/mesh/swarm/proto/testdata/swarm_wire_golden.txt, made by an encoder independent
//! of pbview, micropb and protoc: firmware/mesh/swarm/proto/gen_golden.py): every message decodes to the
//! documented fields and, where deterministic, re-encodes to the same bytes. The Bundle and
//! Override tags are checked against the golden key 0x42 * 32.

use crate::crypto::{self, HMAC_KEY_LEN};
use crate::manifest::Manifest;
use crate::mesh::{max_packet, Header, Packet, PacketOf, BROADCAST, FLAG_WANT_ACK};
use crate::settings::{make_bundle, make_override, Entry, Layer, Settings, CMD_SET, MAX_BUNDLE, PORT_BUNDLE_DATA, PORT_OVERRIDE};
use crate::wire::{self, pb, SettingRec};

const KEY: [u8; HMAC_KEY_LEN] = [0x42; HMAC_KEY_LEN];

fn golden(name: &str) -> Vec<u8> {
    let path = std::env::var("SWARM_WIRE_GOLDEN").expect("SWARM_WIRE_GOLDEN");
    let text = std::fs::read_to_string(path).expect("golden file");
    for line in text.lines() {
        let Some((n, hex)) = line.split_once(" = ") else { continue };
        if n == name {
            return (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect();
        }
    }
    panic!("no golden vector {}", name);
}

const SM: SettingRec = SettingRec { key: 106, value: 0x0000_E040, source: 0 };
const SM2: SettingRec = SettingRec { key: 300, value: 0x3E4C_CCCD, source: 0 };

#[test]
fn summary() {
    let g = golden("summary");
    let s = crate::update::Summary::decode(&g).unwrap();
    assert_eq!(s, crate::update::Summary { running: 7, staged: 8, pages: 5, total: 12, generation: 300 });
    let mut b = [0u8; 32];
    let n = s.encode(&mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);
}

/// The link frames are encoded and decoded in C++ only; they must still parse, and the
/// summary rider is what swarm_net decodes.
#[test]
fn link_frames_parse_and_the_poll_carries_the_summary() {
    for name in ["link_poll", "link_response", "link_report", "link_result", "link_mesh"] {
        let g = golden(name);
        let f = pb::LinkFrameView::parse(&g).unwrap_or_else(|e| panic!("{}: {:?}", name, e));
        assert_eq!(f.ver(), 1, "{}", name);
    }
    let g = golden("link_poll");
    let f = pb::LinkFrameView::parse(&g).unwrap();
    assert_eq!((f.src(), f.seq(), f.slot()), (3, 9, 2));
    assert_eq!(f.summary(), &golden("summary")[..]);
    assert_eq!(f.advert(), &[1, 2, 3]);
    let m = golden("link_mesh");
    let f = pb::LinkFrameView::parse(&m).unwrap();
    assert_eq!(f.dst(), None, "a broadcast has no dst");
    assert_eq!(f.payload(), &[0xaa, 0xbb]);
}

#[test]
fn mesh_packet() {
    let g = golden("mesh_packet");
    let p = Packet::decode(&g).unwrap();
    assert_eq!(
        p.header,
        Header { origin: 3, id: 7, dest: 2, hop_limit: 2, hop_start: 3, flags: FLAG_WANT_ACK, attempt: 2, port: 4 }
    );
    assert_eq!(p.payload(), &[1, 2, 3, 4]);
    let mut b = [0u8; 128];
    let n = p.encode(&mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);
}

/// Splanc: an 802.11-sized packet (200-byte payload, two-byte length varint) round-trips
/// through a 200-byte instance and is refused by the swarm's 88-byte one.
#[test]
fn mesh_packet_200() {
    let g = golden("mesh_packet_200");
    let p = PacketOf::<200>::decode(&g).unwrap();
    assert_eq!(p.header, Header { origin: 3, id: 8, dest: BROADCAST, hop_limit: 3, hop_start: 3, flags: 0, attempt: 0, port: 16 });
    let want: Vec<u8> = (0..200).map(|i| i as u8).collect();
    assert_eq!(p.payload(), &want[..]);
    let mut b = [0u8; max_packet(200)];
    let n = p.encode(&mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);
    assert!(Packet::decode(&g).is_none());
}

/// A broadcast has no dest on the wire; an explicit dest of 0 is a real destination.
#[test]
fn mesh_dest_presence() {
    let mut h = Header { origin: 1, id: 2, dest: BROADCAST, hop_limit: 0, hop_start: 0, flags: 0, attempt: 0, port: 9 };
    let mut b = [0u8; 128];
    let n = Packet::new(h, b"x").unwrap().encode(&mut b).unwrap();
    assert_eq!(pb::MeshPacketView::parse(&b[..n]).unwrap().dest(), None);
    assert_eq!(Packet::decode(&b[..n]).unwrap().header.dest, BROADCAST);
    h.dest = 0;
    let n = Packet::new(h, b"x").unwrap().encode(&mut b).unwrap();
    assert_eq!(pb::MeshPacketView::parse(&b[..n]).unwrap().dest(), Some(0));
    assert_eq!(Packet::decode(&b[..n]).unwrap().header.dest, 0);
}

#[test]
fn ack() {
    let g = golden("ack");
    assert_eq!(pb::AckView::parse(&g).unwrap().id(), 7);
    let mut b = [0u8; 8];
    let n = wire::ack(7, &mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);
}

#[test]
fn bundle_body_and_bundle_with_the_golden_key() {
    let body = golden("bundle_body");
    let v = pb::BundleBodyView::parse(&body).unwrap();
    assert_eq!(v.generation(), 3);
    let s: Vec<_> = v.settings().map(|s| (s.key(), s.value(), s.source())).collect();
    assert_eq!(s, vec![(106, 0xE040, 0), (300, 0x3E4C_CCCD, 0)]);
    let mut b = [0u8; 64];
    let n = wire::bundle_body(3, &[SM, SM2], &mut b).unwrap();
    assert_eq!(&b[..n], &body[..]);

    let g = golden("bundle");
    let env = pb::BundleView::parse(&g).unwrap();
    assert_eq!(env.body(), &body[..]);
    assert_eq!(env.tag().len(), 4);
    assert!(crypto::check_tag(&KEY, crypto::DOMAIN_BUNDLE, &[env.body()], env.tag()), "golden tag");

    // A node takes it (tag verified over the body bytes as sent) and keeps the bytes.
    let mut node = Settings::new(1, Some(KEY));
    assert!(node.host_bundle(&g).swarm);
    assert_eq!(node.generation(), 3);
    assert_eq!(node.swarm.get(106), Some(0xE040));
    assert_eq!(node.swarm.get(300), Some(0x3E4C_CCCD));
    assert_eq!(node.bundle(), &g[..]);

    // ... and our encoder produces the same envelope.
    let mut l = Layer::default();
    l.set(106, 0xE040);
    l.set(300, 0x3E4C_CCCD);
    let mut out = [0u8; MAX_BUNDLE];
    let n = make_bundle(&l, 3, &KEY, &mut out);
    assert_eq!(&out[..n], &g[..]);

    // A wrong key rejects it.
    let mut other = Settings::new(1, Some([0x43; HMAC_KEY_LEN]));
    assert!(!other.host_bundle(&g).swarm);
    assert_eq!(other.stats.rejected_tag, 1);
}

#[test]
fn override_body_and_override_with_the_golden_key() {
    let body = golden("override_body");
    let v = pb::OverrideBodyView::parse(&body).unwrap();
    assert_eq!((v.kind(), v.seq()), (1, 1));
    assert_eq!(v.settings().map(|s| (s.key(), s.value())).collect::<Vec<_>>(), vec![(300, 0x3E4C_CCCD)]);
    let mut b = [0u8; 64];
    let n = wire::override_body(1, 1, &[SM2], &mut b).unwrap();
    assert_eq!(&b[..n], &body[..]);

    let g = golden("override");
    let env = pb::OverrideView::parse(&g).unwrap();
    assert_eq!(env.body(), &body[..]);
    assert!(crypto::check_tag(&KEY, crypto::DOMAIN_OVERRIDE, &[&1u16.to_le_bytes(), env.body()], env.tag()));
    assert!(!crypto::check_tag(&KEY, crypto::DOMAIN_OVERRIDE, &[&2u16.to_le_bytes(), env.body()], env.tag()), "bound to dest 1");

    let (o, n) = make_override(1, CMD_SET, 1, &[Entry { key: 300, value: 0x3E4C_CCCD }], &KEY).unwrap();
    assert_eq!(&o[..n], &g[..]);

    let mut node = Settings::new(1, Some(KEY));
    assert!(node.on_packet(1, PORT_OVERRIDE, &g).overrides);
    assert_eq!(node.overrides.get(300), Some(0x3E4C_CCCD));
    let mut wrong = Settings::new(2, Some(KEY));
    assert!(!wrong.on_packet(2, PORT_OVERRIDE, &g).overrides, "tagged for node 1");
}

#[test]
fn bundle_fragment_request_and_report() {
    let g = golden("bundle_fragment");
    let v = pb::BundleFragmentView::parse(&g).unwrap();
    assert_eq!((v.generation(), v.total_len(), v.offset(), v.data()), (3, 20, 0, &[0x11, 0x22, 0x33, 0x44][..]));
    let mut b = [0u8; 64];
    let n = wire::bundle_fragment(3, 20, 0, &[0x11, 0x22, 0x33, 0x44], &mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);
    // The same bytes arriving on the bundle port are a fragment (too short to complete).
    let mut node = Settings::new(1, Some(KEY));
    assert_eq!(node.on_packet(BROADCAST, PORT_BUNDLE_DATA, &g), Default::default());

    let g = golden("bundle_request");
    assert_eq!(pb::BundleRequestView::parse(&g).unwrap().generation(), 3);
    let n = wire::bundle_request(3, &mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);

    let g = golden("settings_report");
    let v = pb::SettingsReportView::parse(&g).unwrap();
    assert_eq!((v.part(), v.parts(), v.generation(), v.override_seq()), (0, 2, 3, 1));
    let s: Vec<_> = v.settings().map(|s| (s.key(), s.value(), s.source())).collect();
    assert_eq!(s, vec![(106, 0xE040, 1), (300, 0x3E4C_CCCD, 2)]);
    let n = wire::settings_report(
        0,
        2,
        3,
        1,
        &[SettingRec { source: 1, ..SM }, SettingRec { source: 2, ..SM2 }],
        &mut b,
    )
    .unwrap();
    assert_eq!(&b[..n], &g[..]);
}

#[test]
fn firmware_messages() {
    let sha = crypto::sha256(b"image");
    let body = golden("manifest_body");
    let v = pb::ManifestBodyView::parse(&body).unwrap();
    assert_eq!((v.version(), v.size(), v.sha256(), v.flags()), (5, 100000, &sha[..], 0));
    let mut b = [0u8; 128];
    let n = wire::manifest_body(5, 100000, &sha, 0, &mut b).unwrap();
    assert_eq!(&b[..n], &body[..]);

    // Structure only: the signature is a dummy.
    let g = golden("manifest_dummy_signature");
    let m = Manifest::decode(&g).unwrap();
    assert_eq!((m.version, m.size, m.sha256, m.flags), (5, 100000, sha, 0));
    assert_eq!(m.body_bytes(), &body[..]);
    let want: Vec<u8> = (0..64).collect();
    assert_eq!(&m.signature[..], &want[..]);
    assert_eq!(m.raw(), &g[..]);
    assert!(!m.verify(&crate::crypto::signing::p256_public_key(&[7; 32])));
    let n = wire::manifest(&body, &m.signature, &mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);

    let g = golden("fw_request");
    let v = pb::FwRequestView::parse(&g).unwrap();
    assert_eq!((v.version(), v.page(), v.missing()), (5, 3, 0xFF));
    let n = wire::fw_request(5, 3, 0xFF, &mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);

    let g = golden("fw_data");
    let v = pb::FwDataView::parse(&g).unwrap();
    let data: Vec<u8> = (0..10).collect();
    assert_eq!((v.version(), v.page(), v.chunk(), v.data()), (5, 3, 2, &data[..]));
    let n = wire::fw_data(5, 3, 2, &data, &mut b).unwrap();
    assert_eq!(&b[..n], &g[..]);
}
