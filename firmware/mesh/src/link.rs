//! The link frame on a Splanc backhaul: the swarm's `LinkFrame` (swarm_wire.proto), which
//! upstream only the C++ UWB radio built. One frame per backhaul frame; the security envelope
//! (design §5.1, M2) will wrap these bytes.
//!
//! Splanc's own framing: nothing here (or anywhere in the mesh) uses Espressif's ESP-NOW
//! header or OUI. The 802.11 backhaul (M3) carries these bytes in its own frames.

use swarm_net::mesh::{max_packet, MAX_PAYLOAD};
use swarm_net::net::{FrameKind, MAX_FRAME_PAYLOAD};
use swarm_net::wire::pb;

use crate::backhaul::NodeId;

/// `LinkFrame.ver`: frames with any other value are dropped.
pub const VERSION: u32 = 1;

/// The smallest MTU the swarm's own frames need: its manifest frame, 10 + 114 bytes (the
/// UWB frame is 125).
pub const MIN_MTU: usize = link_overhead(false, MAX_FRAME_PAYLOAD) + MAX_FRAME_PAYLOAD;
const _: () = assert!(MIN_MTU == 124);

const fn varint_len(v: usize) -> usize {
    let mut n = 1;
    let mut v = v >> 7;
    while v != 0 {
        n += 1;
        v >>= 7;
    }
    n
}

/// Worst-case LinkFrame bytes around a `payload`-byte body: type 2 + src 4 (+ dst 4 when
/// unicast) + payload tag and length + ver 2.
pub const fn link_overhead(unicast: bool, payload: usize) -> usize {
    2 + 4 + if unicast { 4 } else { 0 } + 1 + varint_len(payload) + 2
}

/// The largest mesh payload a backhaul frame of `mtu` bytes carries: the MeshPacket header
/// and the broadcast link header come off. 91 for the swarm's 125-byte UWB frame (upstream
/// used 88, keeping 3 bytes of slack).
pub const fn mesh_payload_for_mtu(mtu: usize) -> usize {
    let mut p = mtu.saturating_sub(link_overhead(false, 0) + max_packet(0));
    while p > 0 && link_overhead(false, max_packet(p)) + max_packet(p) > mtu {
        p -= 1;
    }
    p
}
const _: () = assert!(mesh_payload_for_mtu(125) == 91);
const _: () = assert!(mesh_payload_for_mtu(MIN_MTU) >= MAX_PAYLOAD);

/// What a link frame carries for the mesh layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Frame<'a> {
    /// A MeshPacket (link broadcast).
    Mesh(&'a [u8]),
    /// A firmware page request, link unicast to `dest`.
    FwRequest { dest: NodeId, payload: &'a [u8] },
    /// A firmware data chunk (link broadcast).
    FwData(&'a [u8]),
    /// A signed manifest (link broadcast, never relayed).
    FwManifest(&'a [u8]),
    /// The sender's Summary: a BEACON (backhauls without TDMA), or a UWB POLL's rider.
    Summary(&'a [u8]),
    /// A time beacon ([`crate::meshtime::TimeBeacon`], M4): one hop, link broadcast, never
    /// relayed.
    Time(&'a [u8]),
    /// A ranging message ([`crate::ranging::RangeMsg`]): one hop, link unicast to `dest`,
    /// never relayed.
    Range { dest: NodeId, payload: &'a [u8] },
}

impl<'a> Frame<'a> {
    /// The frame for what `swarm_net::Net::next_tx` produced.
    pub fn from_tx(kind: FrameKind, payload: &'a [u8]) -> Frame<'a> {
        match kind {
            FrameKind::Mesh => Frame::Mesh(payload),
            FrameKind::FwRequest { dest } => Frame::FwRequest { dest, payload },
            FrameKind::FwData => Frame::FwData(payload),
            FrameKind::FwManifest => Frame::FwManifest(payload),
        }
    }

    /// The link-layer destination (None: broadcast).
    pub fn dst(&self) -> Option<NodeId> {
        match *self {
            Frame::FwRequest { dest, .. } | Frame::Range { dest, .. } => Some(dest),
            _ => None,
        }
    }
}

/// A decoded link frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Received<'a> {
    pub src: NodeId,
    /// The link destination, if unicast.
    pub dst: Option<NodeId>,
    pub frame: Frame<'a>,
}

/// Why a received frame is not for the mesh layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    /// Not a LinkFrame, or a field out of range.
    Malformed,
    /// `ver` is not [`VERSION`].
    Version,
    /// A frame type the mesh layer does not handle (ranging).
    NotMesh,
}

/// Encode `frame` from `src` into `out`; its length, None if `out` is too small or a field
/// is out of range.
pub fn encode(src: NodeId, frame: Frame<'_>, out: &mut [u8]) -> Option<usize> {
    let (ty, body) = match frame {
        Frame::Mesh(b) => (pb::FrameType::Mesh, b),
        Frame::FwRequest { payload, .. } => (pb::FrameType::FwRequest, payload),
        Frame::FwData(b) => (pb::FrameType::FwData, b),
        Frame::FwManifest(b) => (pb::FrameType::FwManifest, b),
        Frame::Summary(b) => (pb::FrameType::Beacon, b),
        Frame::Time(b) => (pb::FrameType::Time, b),
        Frame::Range { payload, .. } => (pb::FrameType::Range, payload),
    };
    let dst = frame.dst();
    pb::LinkFrameEnc::encode(out, |m| {
        m.r#type(ty as i32)?.src(src as u32)?;
        if let Some(d) = dst {
            m.dst(d as u32)?;
        }
        if let Frame::Summary(s) = frame {
            m.summary(s)?;
        } else {
            m.payload(body)?;
        }
        m.ver(VERSION)?;
        Ok(())
    })
    .ok()
}

/// Decode a received link frame.
pub fn decode(b: &[u8]) -> Result<Received<'_>, Reject> {
    let f = pb::LinkFrameView::parse(b).map_err(|_| Reject::Malformed)?;
    if f.ver() != VERSION {
        return Err(Reject::Version);
    }
    let src = NodeId::try_from(f.src()).map_err(|_| Reject::Malformed)?;
    let dst = match f.dst() {
        Some(d) => Some(NodeId::try_from(d).map_err(|_| Reject::Malformed)?),
        None => None,
    };
    let frame = match pb::FrameType::try_from(f.r#type()) {
        Ok(pb::FrameType::Mesh) => Frame::Mesh(f.payload()),
        Ok(pb::FrameType::FwRequest) => Frame::FwRequest { dest: dst.ok_or(Reject::Malformed)?, payload: f.payload() },
        Ok(pb::FrameType::FwData) => Frame::FwData(f.payload()),
        Ok(pb::FrameType::FwManifest) => Frame::FwManifest(f.payload()),
        Ok(pb::FrameType::Beacon) => Frame::Summary(f.summary()),
        Ok(pb::FrameType::Poll) if !f.summary().is_empty() => Frame::Summary(f.summary()),
        Ok(pb::FrameType::Time) => Frame::Time(f.payload()),
        Ok(pb::FrameType::Range) => Frame::Range { dest: dst.ok_or(Reject::Malformed)?, payload: f.payload() },
        _ => return Err(Reject::NotMesh),
    };
    Ok(Received { src, dst, frame })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden(name: &str) -> Vec<u8> {
        let path = std::env::var("SWARM_WIRE_GOLDEN").expect("SWARM_WIRE_GOLDEN");
        let text = std::fs::read_to_string(path).expect("golden file");
        for line in text.lines() {
            let Some((n, hex)) = line.split_once(" = ") else { continue };
            if n == name {
                return (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap()).collect();
            }
        }
        panic!("no golden vector {name}");
    }

    /// The encoder writes the golden bytes (field-number order, ver last) and the decoder
    /// reads them back.
    #[test]
    fn golden_link_frames() {
        let summary = golden("summary");
        let cases: [(&str, NodeId, Frame<'_>); 3] = [
            ("link_mesh", 3, Frame::Mesh(&[0xaa, 0xbb])),
            ("link_beacon", 3, Frame::Summary(&summary)),
            ("link_fw_request", 3, Frame::FwRequest { dest: 20000, payload: &[1] }),
        ];
        for (name, src, frame) in cases {
            let g = golden(name);
            let mut b = [0u8; 64];
            let n = encode(src, frame, &mut b).unwrap();
            assert_eq!(&b[..n], &g[..], "{name}");
            let r = decode(&g).unwrap();
            assert_eq!((r.src, r.frame), (src, frame), "{name}");
            assert_eq!(r.dst, frame.dst(), "{name}");
        }
        // A UWB POLL's summary rider reads as a Summary; the ranging frames are not ours.
        assert_eq!(decode(&golden("link_poll")).unwrap().frame, Frame::Summary(&summary));
        for name in ["link_response", "link_report", "link_result"] {
            assert_eq!(decode(&golden(name)), Err(Reject::NotMesh), "{name}");
        }
    }

    #[test]
    fn time_frames_round_trip() {
        let mut b = [0u8; 64];
        let n = encode(0x1130, Frame::Time(&[1, 2, 3]), &mut b).unwrap();
        assert!(n <= link_overhead(false, 3) + 3);
        let r = decode(&b[..n]).unwrap();
        assert_eq!((r.src, r.dst, r.frame), (0x1130, None, Frame::Time(&[1, 2, 3])));
    }

    #[test]
    fn rejects_other_versions_and_garbage() {
        let mut b = [0u8; 32];
        let n = encode(3, Frame::Mesh(b"x"), &mut b).unwrap();
        assert!(decode(&b[..n]).is_ok());
        // ver is the last field: 0x78 0x01 -> 0x78 0x02.
        assert_eq!(&b[n - 2..n], &[0x78, 0x01]);
        b[n - 1] = 2;
        assert_eq!(decode(&b[..n]), Err(Reject::Version));
        assert_eq!(decode(&[0xff, 0xff, 0xff]), Err(Reject::Malformed));
        // A FW_REQUEST without a destination is malformed.
        let mut c = [0u8; 32];
        let m = encode(3, Frame::FwData(b"x"), &mut c).unwrap();
        c[1] = pb::FrameType::FwRequest as u8;
        assert_eq!(decode(&c[..m]), Err(Reject::Malformed));
    }

    #[test]
    fn overhead_matches_the_encoder_at_full_width() {
        for len in [1usize, 88, 127, 128, 200, 1425] {
            let body = vec![0x5a; len];
            let mut b = vec![0u8; len + 32];
            let n = encode(u16::MAX - 1, Frame::Mesh(&body), &mut b).unwrap();
            assert_eq!(n, link_overhead(false, len) + len, "broadcast {len}");
            let n = encode(u16::MAX - 1, Frame::FwRequest { dest: u16::MAX - 1, payload: &body }, &mut b).unwrap();
            assert_eq!(n, link_overhead(true, len) + len, "unicast {len}");
        }
        // Bounded by the bounds file: a body over max_packet(PAYLOAD_CAP) does not encode.
        let big = vec![0u8; max_packet(swarm_net::mesh::PAYLOAD_CAP) + 1];
        let mut b = vec![0u8; big.len() + 32];
        assert!(encode(1, Frame::Mesh(&big), &mut b).is_none());
    }

    #[test]
    fn payload_for_mtu() {
        // UWB (125), ESP-NOW-v1-sized (250) and IP-sized (1400) frames, before the envelope.
        assert_eq!(mesh_payload_for_mtu(125), 91);
        assert_eq!(mesh_payload_for_mtu(250), 250 - 11 - 25);
        assert_eq!(mesh_payload_for_mtu(1400), 1400 - 11 - 25);
        for mtu in MIN_MTU..1500 {
            let p = mesh_payload_for_mtu(mtu);
            assert!(link_overhead(false, max_packet(p)) + max_packet(p) <= mtu, "{mtu}");
            assert!(link_overhead(false, max_packet(p + 1)) + max_packet(p + 1) > mtu, "{mtu}");
        }
    }
}
