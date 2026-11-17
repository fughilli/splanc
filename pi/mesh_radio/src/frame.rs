//! The Splanc 802.11 mesh frame (docs/design/mesh.md §4.1), as the C6 netstack will send it
//! (M3) and as a Linux radio sends and receives it.
//!
//! ```text
//! 802.11 header (24 B)
//!   FC 0xd0 0x00 (Action), duration 0, A1 = ff:ff:ff:ff:ff:ff or the peer's MAC,
//!   A2 = own MAC, A3 = ff:ff:ff:ff:ff:ff (no BSS), sequence control
//! Action body
//!   category 4 (Public Action), action 9 (vendor-specific): the mesh's frame since the
//!             owner's decision of 2026-11-17 (docs/design/mesh-pi-transport.md §3). Linux
//!             cfg80211/mac80211 accept it on a managed interface, TX and RX, associated
//!             or not; category 127 is refused both ways. [`Category::Vendor`] (127) stays
//!             parseable for the brcmfmac bench and old captures.
//!   Splanc CID (3 B, placeholder 0x0A 0x5C 0x4D until a registered CID, design Q4)
//!   frame kind (1 B): 0x01 = mesh v1
//!   mesh frame (the backhaul's opaque bytes: the envelope, §5.1)
//! FCS (hardware; stripped on receive)
//! ```
//!
//! No Espressif OUI and no ESP-NOW framing anywhere.

/// The CID-format placeholder (local bit set, so it never collides with an OUI; design §4.1).
pub const SPLANC_CID: [u8; 3] = [0x0A, 0x5C, 0x4D];
/// Frame kind: mesh v1.
pub const KIND_MESH_V1: u8 = 0x01;
pub const BROADCAST: [u8; 6] = [0xff; 6];
/// FC for an Action frame, no flags.
pub const FC_ACTION: [u8; 2] = [0xd0, 0x00];
pub const HDR_LEN: usize = 24;
pub const CAT_PUBLIC: u8 = 4;
pub const PUBLIC_VENDOR_SPECIFIC: u8 = 9;
pub const CAT_VENDOR: u8 = 127;

/// Which action category the frame uses: [`Category::PublicVendor`] is the mesh's (design
/// §4.1); [`Category::Vendor`] (127) was the first draft's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    /// Category 127, then the CID.
    Vendor,
    /// Category 4 (Public), action 9 (vendor-specific), then the CID.
    PublicVendor,
}

impl Category {
    /// The action-body prefix up to and including the frame kind: what a receiver matches
    /// (also the nl80211 `FRAME_MATCH` registration).
    pub fn prefix(self) -> &'static [u8] {
        const V: [u8; 5] = [CAT_VENDOR, SPLANC_CID[0], SPLANC_CID[1], SPLANC_CID[2], KIND_MESH_V1];
        const P: [u8; 6] =
            [CAT_PUBLIC, PUBLIC_VENDOR_SPECIFIC, SPLANC_CID[0], SPLANC_CID[1], SPLANC_CID[2], KIND_MESH_V1];
        match self {
            Category::Vendor => &V,
            Category::PublicVendor => &P,
        }
    }

    /// Action-body bytes before the mesh frame.
    pub fn body_overhead(self) -> usize {
        self.prefix().len()
    }
}

/// Bytes of 802.11 frame (without FCS) around a mesh frame.
pub fn overhead(cat: Category) -> usize {
    HDR_LEN + cat.body_overhead()
}

/// Build the frame: `seq` is the 12-bit sequence number. Returns the length, None if `out`
/// is too small.
pub fn encode(cat: Category, da: [u8; 6], sa: [u8; 6], seq: u16, mesh: &[u8], out: &mut [u8]) -> Option<usize> {
    let n = overhead(cat) + mesh.len();
    if out.len() < n {
        return None;
    }
    out[0..2].copy_from_slice(&FC_ACTION);
    out[2..4].fill(0); // duration: the hardware fills it for unicast
    out[4..10].copy_from_slice(&da);
    out[10..16].copy_from_slice(&sa);
    out[16..22].copy_from_slice(&BROADCAST);
    out[22..24].copy_from_slice(&((seq & 0x0fff) << 4).to_le_bytes());
    let p = cat.prefix();
    out[HDR_LEN..HDR_LEN + p.len()].copy_from_slice(p);
    out[HDR_LEN + p.len()..n].copy_from_slice(mesh);
    Some(n)
}

/// A received Splanc mesh frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Parsed<'a> {
    pub cat: Category,
    pub da: [u8; 6],
    pub sa: [u8; 6],
    pub seq: u16,
    /// Retry bit (a unicast retransmission).
    pub retry: bool,
    pub mesh: &'a [u8],
}

/// Parse an 802.11 frame (no FCS); None unless it is a Splanc mesh frame in either category.
pub fn parse(f: &[u8]) -> Option<Parsed<'_>> {
    if f.len() < HDR_LEN + 1 || f[0] != FC_ACTION[0] || f[1] & !0x08 != 0 {
        // Action, no ToDS/FromDS/protected/order; the retry bit (0x08) may be set.
        return None;
    }
    let body = &f[HDR_LEN..];
    let cat = [Category::Vendor, Category::PublicVendor].into_iter().find(|c| body.starts_with(c.prefix()))?;
    let mut da = [0u8; 6];
    let mut sa = [0u8; 6];
    da.copy_from_slice(&f[4..10]);
    sa.copy_from_slice(&f[10..16]);
    Some(Parsed {
        cat,
        da,
        sa,
        seq: u16::from_le_bytes([f[22], f[23]]) >> 4,
        retry: f[1] & 0x08 != 0,
        mesh: &body[cat.body_overhead()..],
    })
}

/// Airtime of one frame of `bytes` (with FCS) at `rate_kbps`, µs: long-preamble DSSS at 1
/// and 2 Mb/s, OFDM (20 µs preamble + 4 µs symbols) at 6 Mb/s and up. Excludes contention.
pub fn airtime_us(bytes: usize, rate_kbps: u32) -> u32 {
    let bits = (bytes as u32 + 4) * 8;
    if rate_kbps <= 2_000 || rate_kbps == 5_500 || rate_kbps == 11_000 {
        192 + (bits * 1000).div_ceil(rate_kbps)
    } else {
        let bits_per_sym = rate_kbps * 4 / 1000;
        20 + 4 * (16 + 6 + bits).div_ceil(bits_per_sym)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ME: [u8; 6] = [0x02, 0, 0, 0, 0, 1];

    /// The exact bytes a C6 (M3) must produce for the same inputs: the interop vector
    /// (design §4.1).
    #[test]
    fn golden_public_vendor_frame() {
        let mut b = [0u8; 64];
        let n = encode(Category::PublicVendor, BROADCAST, ME, 0x123, b"SM\x01", &mut b).unwrap();
        let want: [u8; 33] = [
            0xd0, 0x00, 0x00, 0x00, // FC, duration
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // A1
            0x02, 0x00, 0x00, 0x00, 0x00, 0x01, // A2
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // A3
            0x30, 0x12, // seq 0x123 << 4
            0x04, 0x09, 0x0a, 0x5c, 0x4d, 0x01, // Public, vendor-specific, CID, kind
            b'S', b'M', 0x01,
        ];
        assert_eq!(&b[..n], &want);
        let p = parse(&b[..n]).unwrap();
        assert_eq!((p.cat, p.da, p.sa, p.seq, p.retry, p.mesh), (Category::PublicVendor, BROADCAST, ME, 0x123, false, &b"SM\x01"[..]));
    }

    /// The first draft's category-127 frame still parses.
    #[test]
    fn golden_vendor_frame() {
        let mut b = [0u8; 64];
        let n = encode(Category::Vendor, BROADCAST, ME, 0x123, b"SM\x01", &mut b).unwrap();
        let want: [u8; 32] = [
            0xd0, 0x00, 0x00, 0x00, // FC, duration
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // A1
            0x02, 0x00, 0x00, 0x00, 0x00, 0x01, // A2
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, // A3
            0x30, 0x12, // seq 0x123 << 4
            0x7f, 0x0a, 0x5c, 0x4d, 0x01, // cat 127, CID, kind
            b'S', b'M', 0x01,
        ];
        assert_eq!(&b[..n], &want);
        let p = parse(&b[..n]).unwrap();
        assert_eq!((p.cat, p.da, p.sa, p.seq, p.retry, p.mesh), (Category::Vendor, BROADCAST, ME, 0x123, false, &b"SM\x01"[..]));
    }

    #[test]
    fn public_vendor_round_trip_and_retry_bit() {
        let mut b = [0u8; 300];
        let peer = [0x02, 9, 9, 9, 9, 9];
        let body = [0x5a; 250];
        let n = encode(Category::PublicVendor, peer, ME, 4095, &body, &mut b).unwrap();
        assert_eq!(n, 24 + 6 + 250);
        assert_eq!(&b[24..30], &[4, 9, 0x0a, 0x5c, 0x4d, 1]);
        b[1] |= 0x08;
        let p = parse(&b[..n]).unwrap();
        assert_eq!((p.cat, p.da, p.seq, p.retry, p.mesh.len()), (Category::PublicVendor, peer, 4095, true, 250));
    }

    #[test]
    fn rejects_other_frames() {
        let mut b = [0u8; 64];
        let n = encode(Category::Vendor, BROADCAST, ME, 1, b"x", &mut b).unwrap();
        let mut c = b;
        c[26] ^= 1; // another CID
        assert!(parse(&c[..n]).is_none());
        let mut c = b;
        c[28] = 2; // another kind
        assert!(parse(&c[..n]).is_none());
        let mut c = b;
        c[1] = 0x40; // protected
        assert!(parse(&c[..n]).is_none());
        let mut c = b;
        c[0] = 0x80; // a beacon
        assert!(parse(&c[..n]).is_none());
        assert!(parse(&b[..20]).is_none());
        assert!(encode(Category::Vendor, BROADCAST, ME, 1, &[0; 40], &mut b).is_none());
    }

    #[test]
    fn airtime() {
        // A 250-byte mesh frame + 29 B of header: ~2.4 ms at 1 Mb/s, ~0.4 ms at 6 Mb/s (§4.1).
        let n = overhead(Category::Vendor) + 250;
        assert_eq!(airtime_us(n, 1_000), 192 + (n as u32 + 4) * 8);
        let ofdm = airtime_us(n, 6_000);
        assert!((380..420).contains(&ofdm), "{ofdm}");
    }
}
