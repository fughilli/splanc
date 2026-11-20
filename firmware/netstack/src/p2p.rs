//! Splanc 802.11 peer-to-peer frames on the heapless MAC (docs/design/mesh.md §4.1, §4.4).
//!
//! The mesh backhaul sends **Public Action** frames (category 4, action 9: vendor-specific)
//! carrying Splanc's CID. No Espressif OUI and no ESP-NOW framing anywhere (owner rule).
//!
//! ```text
//! 802.11 header (24 B)
//!   FC 0xd0 0x00 (Action), duration, A1 = ff:ff:ff:ff:ff:ff or the peer's MAC,
//!   A2 = own MAC, A3 = ff:ff:ff:ff:ff:ff (no BSS), sequence control
//! Action body
//!   category 4, action 9, Splanc CID (3 B), frame kind (1 B), kind payload
//! FCS (hardware)
//! ```
//!
//! This module is pure: the frame codec (byte-identical to `pi/mesh_radio/src/frame.rs`,
//! the Pi transport's golden vector), the decode of the C6 MAC's 92-byte RX vector, the
//! per-queue TX register words for a PHY rate, and the TX completion status. It holds no
//! state, so a build that does not call it pays nothing for it.

/// The CID-format placeholder (local bit set, so it never collides with an assigned OUI;
/// design §4.1, Q4). Swapping in a registered CID is this constant plus a version bump.
pub const SPLANC_CID: [u8; 3] = [0x0A, 0x5C, 0x4D];
/// Frame kind: the mesh envelope, v1 (design §5.1).
pub const KIND_MESH_V1: u8 = 0x01;
/// Frame kind: the netstack link probe (M3a spike; test-only, never on a shipping image).
/// Kinds 0xF0..0xFF are diagnostic (the field kit's vendor-stack node uses 0xF1).
pub const KIND_LINK_PROBE: u8 = 0xF3;

pub const BROADCAST: [u8; 6] = [0xff; 6];
/// FC byte 0 of an Action frame.
pub const FC_ACTION: u8 = 0xd0;
/// FC byte 1: the Retry bit.
pub const FC1_RETRY: u8 = 0x08;
pub const HDR_LEN: usize = 24;
pub const CAT_PUBLIC: u8 = 4;
pub const PUBLIC_VENDOR_SPECIFIC: u8 = 9;
/// Action-body bytes before the kind payload: category, action, CID, kind.
pub const PREFIX_LEN: usize = 6;
/// 802.11 bytes (no FCS) around a kind payload.
pub const OVERHEAD: usize = HDR_LEN + PREFIX_LEN;

/// Build a Splanc Public Action frame into `out`: `seq` is the 12-bit sequence number
/// (the transmit path may restamp it). Returns the length, or None if `out` is too small.
pub fn encode(da: &[u8; 6], sa: &[u8; 6], seq: u16, kind: u8, payload: &[u8], out: &mut [u8]) -> Option<usize> {
    let n = OVERHEAD + payload.len();
    if out.len() < n {
        return None;
    }
    out[0] = FC_ACTION;
    out[1] = 0;
    out[2] = 0; // duration: left to the hardware / zero for group frames
    out[3] = 0;
    out[4..10].copy_from_slice(da);
    out[10..16].copy_from_slice(sa);
    out[16..22].copy_from_slice(&BROADCAST);
    out[22..24].copy_from_slice(&((seq & 0x0fff) << 4).to_le_bytes());
    out[24] = CAT_PUBLIC;
    out[25] = PUBLIC_VENDOR_SPECIFIC;
    out[26..29].copy_from_slice(&SPLANC_CID);
    out[29] = kind;
    out[OVERHEAD..n].copy_from_slice(payload);
    Some(n)
}

/// A received Splanc frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Parsed<'a> {
    pub da: [u8; 6],
    pub sa: [u8; 6],
    /// 12-bit 802.11 sequence number.
    pub seq: u16,
    /// Retry bit: a MAC retransmission of an earlier attempt.
    pub retry: bool,
    pub kind: u8,
    pub payload: &'a [u8],
}

/// One check on the receive path, before any STA processing: is this a Splanc frame
/// (Action, no ToDS/FromDS/Protected/Order; category 4, action 9, the Splanc CID)? Returns
/// it, else None. The Retry bit may be set.
pub fn parse(f: &[u8]) -> Option<Parsed<'_>> {
    if f.len() < OVERHEAD || f[0] != FC_ACTION || f[1] & !FC1_RETRY != 0 {
        return None;
    }
    if f[24] != CAT_PUBLIC || f[25] != PUBLIC_VENDOR_SPECIFIC || f[26..29] != SPLANC_CID {
        return None;
    }
    let mut da = [0u8; 6];
    let mut sa = [0u8; 6];
    da.copy_from_slice(&f[4..10]);
    sa.copy_from_slice(&f[10..16]);
    Some(Parsed {
        da,
        sa,
        seq: u16::from_le_bytes([f[22], f[23]]) >> 4,
        retry: f[1] & FC1_RETRY != 0,
        kind: f[29],
        payload: &f[OVERHEAD..],
    })
}

// ---- RX vector ------------------------------------------------------------------------

/// Bytes of hardware RX vector the C6 MAC writes ahead of every received MPDU
/// ([`crate::mac::RX_VECTOR_HDR`]). It is the same size as the vendor's
/// `esp_wifi_rxctrl_t` for this MAC (`SOC_WIFI_MAC_VERSION_NUM == 2`, 92 bytes packed),
/// and the vendor hands that struct to its promiscuous callback straight from the DMA
/// buffer, so the vector IS that struct. Field offsets below are the struct's (computed
/// from the packed bitfields) and are checked on silicon by the M3a spike
/// (`mesh_smoke`): `channel` equals the tuned channel, `sig_len` = MPDU + FCS,
/// `dump_len` = MPDU, the timestamp advances at 1 MHz with the sender's spacing.
pub const RXV_LEN: usize = 92;

/// The receive metadata the mesh uses, decoded from the RX vector.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RxVector {
    /// RSSI, dBm (byte 0, signed).
    pub rssi: i8,
    /// Rate field (byte 1 bits 0-4): the 802.11b rate code for DSSS/CCK, else the L-SIG
    /// RATE field.
    pub rate: u8,
    /// Reception end state (byte 8; 0 = success).
    pub rxend_state: u8,
    /// Group-addressed reception (byte 11 bit 7).
    pub is_group: bool,
    /// The local time the frame was received, µs (bytes 12-15, little-endian).
    pub timestamp_us: u32,
    /// Noise floor, dBm (byte 20, signed).
    pub noise_floor: i8,
    /// Primary channel (byte 21 bits 0-3).
    pub channel: u8,
    /// PPDU format (byte 39 bits 0-3): 0 = 11b, 1 = 11g/a (legacy OFDM), 2 = HT, 4.. = HE.
    pub bb_format: u8,
    /// MPDU length including the FCS (bytes 84-85, 14 bits).
    pub sig_len: u16,
    /// MPDU length excluding the FCS (bytes 86-87, 14 bits).
    pub dump_len: u16,
    /// Reception state (byte 88; 0 = success).
    pub rx_state: u8,
}

/// The `bb_format` value for 802.11b DSSS/CCK.
pub const BB_FORMAT_11B: u8 = 0;
/// The `bb_format` value for legacy OFDM (11a/g).
pub const BB_FORMAT_11G: u8 = 1;

impl RxVector {
    /// Decode the first [`RXV_LEN`] bytes of a reaped RX buffer; None if it is shorter.
    pub fn decode(v: &[u8]) -> Option<Self> {
        if v.len() < RXV_LEN {
            return None;
        }
        let u16le = |i: usize| u16::from_le_bytes([v[i], v[i + 1]]) & 0x3fff;
        Some(RxVector {
            rssi: v[0] as i8,
            rate: v[1] & 0x1f,
            rxend_state: v[8],
            is_group: v[11] & 0x80 != 0,
            timestamp_us: u32::from_le_bytes([v[12], v[13], v[14], v[15]]),
            noise_floor: v[20] as i8,
            channel: v[21] & 0x0f,
            bb_format: v[39] & 0x0f,
            sig_len: u16le(84),
            dump_len: u16le(86),
            rx_state: v[88],
        })
    }

    /// PHY rate in kb/s from `bb_format` + `rate`, or 0 if unknown. 11b rate codes: 0 =
    /// 1 Mb/s, 1 = 2, 2 = 5.5, 3 = 11 (long preamble), 5..7 = 2..11 short preamble. L-SIG
    /// RATE codes (IEEE 802.11 Table 17-6): 0xB = 6, 0xF = 9, 0xA = 12, 0xE = 18, 0x9 = 24,
    /// 0xD = 36, 0x8 = 48, 0xC = 54.
    pub fn rate_kbps(&self) -> u32 {
        match (self.bb_format, self.rate) {
            (BB_FORMAT_11B, 0) => 1_000,
            (BB_FORMAT_11B, 1 | 5) => 2_000,
            (BB_FORMAT_11B, 2 | 6) => 5_500,
            (BB_FORMAT_11B, 3 | 7) => 11_000,
            (BB_FORMAT_11G, 0xB) => 6_000,
            (BB_FORMAT_11G, 0xF) => 9_000,
            (BB_FORMAT_11G, 0xA) => 12_000,
            (BB_FORMAT_11G, 0xE) => 18_000,
            (BB_FORMAT_11G, 0x9) => 24_000,
            (BB_FORMAT_11G, 0xD) => 36_000,
            (BB_FORMAT_11G, 0x8) => 48_000,
            (BB_FORMAT_11G, 0xC) => 54_000,
            _ => 0,
        }
    }
}

// ---- TX rate words ----------------------------------------------------------------------

/// TX rate code: PLCP1 bits 12-16. Measured on silicon (wifi_tx_rate_probe: the vendor's
/// own queue registers for each `esp_wifi_config_80211_tx` rate) it is the vendor's
/// `wifi_phy_rate_t`: DSSS/CCK 0..3 = 1, 2, 5.5, 11 Mb/s (long preamble), and the legacy
/// OFDM rates by their L-SIG RATE code. The receiver's RX vector reports the same codes.
pub const RATE_1M: u8 = 0x00;
pub const RATE_2M: u8 = 0x01;
pub const RATE_5M5: u8 = 0x02;
pub const RATE_11M: u8 = 0x03;
pub const RATE_48M: u8 = 0x08;
pub const RATE_24M: u8 = 0x09;
pub const RATE_12M: u8 = 0x0A;
pub const RATE_6M: u8 = 0x0B;
pub const RATE_54M: u8 = 0x0C;
pub const RATE_36M: u8 = 0x0D;
pub const RATE_18M: u8 = 0x0E;
pub const RATE_9M: u8 = 0x0F;

/// Whether `rate` is a legacy OFDM code (8..=15).
pub fn is_ofdm(rate: u8) -> bool {
    (RATE_48M..=RATE_9M).contains(&rate)
}

/// PHY rate in kb/s for a TX rate code (0 if not a legacy rate).
pub fn rate_kbps(rate: u8) -> u32 {
    match rate {
        RATE_1M => 1_000,
        RATE_2M => 2_000,
        RATE_5M5 => 5_500,
        RATE_11M => 11_000,
        RATE_6M => 6_000,
        RATE_9M => 9_000,
        RATE_12M => 12_000,
        RATE_18M => 18_000,
        RATE_24M => 24_000,
        RATE_36M => 36_000,
        RATE_48M => 48_000,
        RATE_54M => 54_000,
        _ => 0,
    }
}

/// The blob's `mac_tx_get_rts_rate`: the response (ACK/CTS) rate index for a data rate.
/// Faithful port of the jump table (okhsunrog/esp32c6-open-mac `cr_mac_tx_get_rts_rate`).
pub fn response_rate(rate: u8) -> u8 {
    let p = rate as i32;
    if (p.wrapping_sub(0x10) as u32) < 0x14 {
        let b = if p > 0x19 { p == 0x1a } else { p == 0x10 };
        if b {
            return 0xb;
        }
        let iv = if p < 0x1a { 0x12 } else { 0x1c };
        if p <= iv {
            return 10;
        }
        let b2 = if p < 0x1a { p < 0x13 } else { p < 0x1d };
        if !b2 {
            return 9;
        }
    } else if p < 8 {
        if p == 0 {
            return 0;
        }
    } else if (p.wrapping_sub(8) as u32) < 8 {
        let u = 1u32 << ((p as u32).wrapping_sub(8) & 0x1f);
        if u & 0x33 != 0 {
            return 9;
        }
        if u & 0x88 != 0 {
            return 0xb;
        }
        if u & 0x44 != 0 {
            return 10;
        }
    }
    if (p.wrapping_sub(1) as u32) < 3 {
        return 1;
    }
    if (p.wrapping_sub(5) as u32) > 2 {
        return 0;
    }
    5
}

/// The per-queue rate registers for one frame: PLCP1 (`0x600a5488 - q*0x74`), TXLEN
/// (`0x600a54b8 - q*0x74`) and RESP_DUR (`0x600a54bc - q*0x74`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TxWords {
    pub plcp1: u32,
    pub txlen: u32,
    pub resp_dur: u32,
}

/// Rate words for an 802.11 frame of `frame_len` bytes (no FCS) at TX rate code `rate`, as
/// the vendor programs them (wifi_tx_rate_probe, every legacy rate, on silicon):
/// * PLCP1 = rate code << 12 | on-air length (frame + 4-byte FCS), DSSS and OFDM alike;
/// * TXLEN stays 0x0040_0000;
/// * RESP_DUR = 0x0040_0004 | response rate << 6 (the ACK rate the MAC expects back).
///
/// For 1 Mb/s this is exactly what `TxRing::set_rate` has always written.
pub fn tx_words(rate: u8, frame_len: usize) -> TxWords {
    let air = (frame_len as u32 + 4) & 0xfff;
    TxWords {
        plcp1: ((rate as u32 & 0x1f) << 12) | air,
        txlen: 1 << 22,
        resp_dur: (1 << 22) | ((response_rate(rate) as u32) << 6) | 4,
    }
}

/// PLCP0 ack-type field (bits 24-26): 0 = no ACK expected (group frames, and everything
/// the netstack sent before M3a), 1 = normal ACK. With 1 the MAC waits for the peer's ACK
/// and reports the outcome in the queue's PMD word ([`tx_status`]).
pub const PLCP0_ACK_NORMAL: u32 = 1 << 24;

/// Outcome of one transmit attempt, from the queue's PMD word (`0x600a54e8 - q*0x74`,
/// status nibble bits 12-15), as `lmacProcessTxComplete` dispatches it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxStatus {
    /// Sent (and ACKed, when an ACK was expected).
    Ok,
    /// No ACK from the peer within the ACK timeout.
    AckTimeout,
    /// Any other completion code (1 RTS error, 2 CTS timeout, 4 TX error, ...).
    Other(u8),
}

pub fn tx_status(pmd: u32) -> TxStatus {
    match ((pmd >> 12) & 0xf) as u8 {
        0 => TxStatus::Ok,
        5 => TxStatus::AckTimeout,
        n => TxStatus::Other(n),
    }
}

/// Airtime of one frame of `bytes` (no FCS) at `rate_kbps`, µs: long-preamble DSSS/CCK
/// (192 µs PLCP), legacy OFDM (20 µs preamble + 4 µs symbols, 16 service + 6 tail bits).
/// Excludes contention. Same formula as `pi/mesh_radio/src/frame.rs`.
pub fn airtime_us(bytes: usize, rate_kbps: u32) -> u32 {
    if rate_kbps == 0 {
        return 0;
    }
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

    /// Byte-identical to `pi/mesh_radio/src/frame.rs::golden_public_vendor_frame`: the
    /// interop vector the Pi transport (PR #533) is built against (design §4.1).
    #[test]
    fn golden_public_vendor_frame() {
        let mut b = [0u8; 64];
        let n = encode(&BROADCAST, &ME, 0x123, KIND_MESH_V1, b"SM\x01", &mut b).unwrap();
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
        assert_eq!((p.da, p.sa, p.seq, p.retry, p.kind, p.payload), (BROADCAST, ME, 0x123, false, KIND_MESH_V1, &b"SM\x01"[..]));
    }

    #[test]
    fn no_espressif_oui_anywhere() {
        // Espressif's OUIs (ESP-NOW uses 18:fe:34 in a category-127 frame) never appear.
        let mut b = [0u8; 300];
        let n = encode(&[0x0a, 0x5c, 0x4d, 0xf3, 0, 2], &ME, 7, KIND_LINK_PROBE, &[0; 200], &mut b).unwrap();
        assert!(!b[..n].windows(3).any(|w| w == [0x18, 0xfe, 0x34]));
        assert_eq!(b[24], 4); // Public Action, never category 127
    }

    #[test]
    fn unicast_round_trip_and_retry_bit() {
        let peer = [0x0a, 0x5c, 0x4d, 0xf3, 9, 9];
        let mut b = [0u8; 300];
        let n = encode(&peer, &ME, 4095, KIND_LINK_PROBE, &[0x5a; 250], &mut b).unwrap();
        assert_eq!(n, OVERHEAD + 250);
        b[1] |= FC1_RETRY;
        let p = parse(&b[..n]).unwrap();
        assert_eq!((p.da, p.seq, p.retry, p.kind, p.payload.len()), (peer, 4095, true, KIND_LINK_PROBE, 250));
    }

    #[test]
    fn rejects_other_frames() {
        let mut b = [0u8; 64];
        let n = encode(&BROADCAST, &ME, 1, KIND_MESH_V1, b"x", &mut b).unwrap();
        for (i, v) in [(26, 0x0b), (24, 127), (25, 4), (1, 0x40), (1, 0x01), (0, 0x80)] {
            let mut c = b;
            c[i] = v;
            assert!(parse(&c[..n]).is_none(), "byte {i} = {v:#x} accepted");
        }
        assert!(parse(&b[..OVERHEAD - 1]).is_none());
        assert!(encode(&BROADCAST, &ME, 1, KIND_MESH_V1, &[0; 40], &mut b).is_none());
    }

    /// A vector laid out like the vendor's packed `esp_wifi_rxctrl_t` (MAC v2): the
    /// offsets computed from its bitfields with the target's packing rules.
    fn vendor_layout(rssi: i8, rate: u8, ts: u32, nf: i8, ch: u8, fmt: u8, sig: u16, dump: u16) -> [u8; RXV_LEN] {
        let mut v = [0u8; RXV_LEN];
        v[0] = rssi as u8;
        v[1] = rate;
        v[11] = 0x80; // is_group
        v[12..16].copy_from_slice(&ts.to_le_bytes());
        v[20] = nf as u8;
        v[21] = ch | 0x00;
        v[39] = fmt;
        v[84..86].copy_from_slice(&sig.to_le_bytes());
        v[86..88].copy_from_slice(&dump.to_le_bytes());
        v
    }

    #[test]
    fn rx_vector_fields() {
        let v = vendor_layout(-47, 0xB, 0xdead_beef, -96, 11, BB_FORMAT_11G, 254, 250);
        let r = RxVector::decode(&v).unwrap();
        assert_eq!((r.rssi, r.rate, r.timestamp_us, r.noise_floor, r.channel), (-47, 0xB, 0xdead_beef, -96, 11));
        assert_eq!((r.bb_format, r.sig_len, r.dump_len, r.is_group), (BB_FORMAT_11G, 254, 250, true));
        assert_eq!(r.rate_kbps(), 6_000);
        assert!(RxVector::decode(&v[..91]).is_none());
        let b = RxVector::decode(&vendor_layout(-80, 0, 0, -97, 6, BB_FORMAT_11B, 100, 96)).unwrap();
        assert_eq!(b.rate_kbps(), 1_000);
    }

    #[test]
    fn rate_zero_matches_the_legacy_template() {
        // What TxRing::set_rate has written for every direct-path frame since M1b.
        let w = tx_words(RATE_1M, 100);
        assert_eq!(w, TxWords { plcp1: 104, txlen: 0x0040_0000, resp_dur: 0x0040_0004 });
    }

    /// The vendor's own words for a 230-byte frame at each rate, read off silicon by
    /// wifi_tx_rate_probe (c6-711130, 2026-11-19): (rate, PLCP1, RESP_DUR).
    #[test]
    fn rate_words_match_the_vendor_on_silicon() {
        let golden = [
            (RATE_1M, 0x0000_00ea, 0x0040_0004),
            (RATE_2M, 0x0000_10ea, 0x0040_0044),
            (RATE_5M5, 0x0000_20ea, 0x0040_0044),
            (RATE_11M, 0x0000_30ea, 0x0040_0044),
            (RATE_6M, 0x0000_b0ea, 0x0040_02c4),
            (RATE_9M, 0x0000_f0ea, 0x0040_02c4),
            (RATE_12M, 0x0000_a0ea, 0x0040_0284),
            (RATE_18M, 0x0000_e0ea, 0x0040_0284),
            (RATE_24M, 0x0000_90ea, 0x0040_0244),
            (RATE_36M, 0x0000_d0ea, 0x0040_0244),
        ];
        for (rate, plcp1, resp) in golden {
            let w = tx_words(rate, 230);
            assert_eq!((w.plcp1, w.txlen, w.resp_dur), (plcp1, 0x0040_0000, resp), "rate {rate:#x}");
        }
        assert!(is_ofdm(RATE_6M) && is_ofdm(RATE_54M) && !is_ofdm(RATE_11M));
        assert_eq!(rate_kbps(RATE_6M), 6_000);
    }

    #[test]
    fn response_rates() {
        assert_eq!(response_rate(RATE_1M), RATE_1M);
        assert_eq!([RATE_2M, RATE_5M5, RATE_11M].map(response_rate), [RATE_2M; 3]);
        assert_eq!([RATE_6M, RATE_9M].map(response_rate), [RATE_6M; 2]);
        assert_eq!([RATE_12M, RATE_18M].map(response_rate), [RATE_12M; 2]);
        assert_eq!([RATE_24M, RATE_36M, RATE_48M, RATE_54M].map(response_rate), [RATE_24M; 4]);
    }

    #[test]
    fn completion_status() {
        assert_eq!(tx_status(0x0000_0000), TxStatus::Ok);
        assert_eq!(tx_status(0x0000_5000), TxStatus::AckTimeout);
        assert_eq!(tx_status(0x0001_4300), TxStatus::Other(4));
    }

    #[test]
    fn airtime() {
        // 280 B on air: ~2.4 ms at 1 Mb/s, ~0.4 ms at 6 Mb/s (design §4.1).
        assert_eq!(airtime_us(280, 1_000), 192 + 284 * 8);
        assert!((380..420).contains(&airtime_us(280, 6_000)));
        assert_eq!(airtime_us(10, 0), 0);
    }
}
