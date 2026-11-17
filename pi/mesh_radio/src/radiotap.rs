//! Just enough radiotap (https://www.radiotap.org) for a monitor-mode radio: the TX header
//! mac80211 injection takes, and the RX fields the backhaul reports (TSF, RSSI, FCS flag).

/// Present bits used here.
const TSFT: u32 = 0;
const FLAGS: u32 = 1;
const RATE: u32 = 2;
const DBM_ANTSIGNAL: u32 = 5;
const TX_FLAGS: u32 = 15;
/// FLAGS: the frame ends with its 4-byte FCS.
const F_FCS: u8 = 0x10;
/// FLAGS: the FCS failed.
const F_BADFCS: u8 = 0x40;
/// TX_FLAGS: don't wait for an ACK (broadcast needs none anyway).
pub const TXF_NOACK: u16 = 0x0008;

/// The TX radiotap header: a fixed rate (500 kb/s units) and TX flags. 12 bytes.
pub fn tx_header(rate_kbps: u32, tx_flags: u16) -> [u8; 12] {
    let present: u32 = (1 << RATE) | (1 << TX_FLAGS);
    let mut h = [0u8; 12];
    h[2..4].copy_from_slice(&12u16.to_le_bytes());
    h[4..8].copy_from_slice(&present.to_le_bytes());
    h[8] = (rate_kbps / 500) as u8;
    // h[9] pad: TX_FLAGS is u16-aligned.
    h[10..12].copy_from_slice(&tx_flags.to_le_bytes());
    h
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RxInfo {
    /// Offset of the 802.11 frame.
    pub hdr_len: usize,
    /// The 802.11 frame's length without FCS.
    pub frame_len: usize,
    pub tsft_us: Option<u64>,
    pub rssi_dbm: Option<i8>,
    pub bad_fcs: bool,
}

/// (alignment, size) of the fields in the default namespace up to DBM_ANTSIGNAL.
const FIELDS: [(usize, usize); 6] = [(8, 8), (1, 1), (1, 1), (2, 4), (1, 2), (1, 1)];

/// Parse a received radiotap header; None if malformed.
pub fn parse(b: &[u8]) -> Option<RxInfo> {
    if b.len() < 8 || b[0] != 0 {
        return None;
    }
    let hdr_len = u16::from_le_bytes([b[2], b[3]]) as usize;
    if hdr_len > b.len() || hdr_len < 8 {
        return None;
    }
    let present = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
    // Skip extended presence words (bit 31 chains them).
    let mut off = 8;
    let mut p = present;
    while p & (1 << 31) != 0 {
        if off + 4 > hdr_len {
            return None;
        }
        p = u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]);
        off += 4;
    }
    let mut info = RxInfo { hdr_len, ..RxInfo::default() };
    let mut flags = 0u8;
    for (bit, &(align, size)) in FIELDS.iter().enumerate() {
        if present & (1 << bit) == 0 {
            continue;
        }
        off = off.next_multiple_of(align);
        if off + size > hdr_len {
            return None;
        }
        match bit as u32 {
            TSFT => info.tsft_us = Some(u64::from_le_bytes(b[off..off + 8].try_into().unwrap())),
            FLAGS => flags = b[off],
            DBM_ANTSIGNAL => info.rssi_dbm = Some(b[off] as i8),
            _ => {}
        }
        off += size;
    }
    let fcs = if flags & F_FCS != 0 { 4 } else { 0 };
    info.frame_len = (b.len() - hdr_len).checked_sub(fcs)?;
    info.bad_fcs = flags & F_BADFCS != 0;
    Some(info)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tx_header_layout() {
        let h = tx_header(6_000, TXF_NOACK);
        assert_eq!(h, [0, 0, 12, 0, 0x04, 0x80, 0, 0, 12, 0, 0x08, 0]);
    }

    /// A typical mac80211 RX header: TSFT, FLAGS (FCS), RATE, CHANNEL, ANTSIGNAL, then an
    /// extended bitmap (per-antenna signal), as ath9k/mt76 send them.
    #[test]
    fn parses_mac80211_rx_header() {
        let present: u32 = (1 << 0) | (1 << 1) | (1 << 2) | (1 << 3) | (1 << 5) | (1 << 31);
        let mut b = vec![0u8, 0, 0, 0];
        b.extend_from_slice(&present.to_le_bytes());
        b.extend_from_slice(&0x20u32.to_le_bytes()); // second presence word
        // offset 12: TSFT aligned to 8 -> 16
        b.extend_from_slice(&[0; 4]);
        b.extend_from_slice(&123_456_789u64.to_le_bytes());
        b.push(F_FCS); // flags
        b.push(12); // rate 6 Mb/s
        b.extend_from_slice(&2412u16.to_le_bytes());
        b.extend_from_slice(&0x00a0u16.to_le_bytes());
        b.push((-57i8) as u8);
        b.push(0); // pad to keep it simple
        let hl = b.len() as u16;
        b[2..4].copy_from_slice(&hl.to_le_bytes());
        let frame = [0xd0u8; 30];
        b.extend_from_slice(&frame);
        b.extend_from_slice(&[1, 2, 3, 4]); // FCS
        let i = parse(&b).unwrap();
        assert_eq!(i.hdr_len, hl as usize);
        assert_eq!(i.frame_len, 30);
        assert_eq!(i.tsft_us, Some(123_456_789));
        assert_eq!(i.rssi_dbm, Some(-57));
        assert!(!i.bad_fcs);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse(&[1, 0, 8, 0, 0, 0, 0, 0]).is_none());
        assert!(parse(&[0, 0, 200, 0, 0, 0, 0, 0]).is_none());
        // TSFT promised but the header ends.
        assert!(parse(&[0, 0, 8, 0, 1, 0, 0, 0]).is_none());
    }
}
