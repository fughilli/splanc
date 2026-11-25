//! FTM-style fine timestamps from the C6 MAC (docs/design/mesh-ftm.md): the four stamps of
//! a two-way exchange, decoded from the hardware the vendor's 802.11mc FTM uses, under our
//! own MAC (no vendor Wi-Fi stack).
//!
//! An exchange is any ACKed unicast: A sends a frame, B's MAC ACKs it.
//!
//! | Stamp | Who | Where |
//! | --- | --- | --- |
//! | t1, frame TX | A | per-queue words `0x600A_54F0 - q*0x74` (+0, +4) after the ACK |
//! | t4, ACK RX   | A | the same block (+4, +8) |
//! | t2, frame RX | B | the frame's RX vector, bytes 11-15 and 34-35 |
//! | t3, ACK TX   | B | the same RX vector, bytes 76-80 (the MAC writes it back) |
//!
//! `RTT = (t4 - t1) - (t3 - t2)`; one raw unit of RTT is 1/640 µs = 1.5625 ns, which is
//! [`M_PER_RAW`] (0.234 m) of one-way range. The field map comes from the vendor blobs
//! (`libpp hal_mac_ftm_get_t3`, `wDev_record_ftm_data_local`, `lmac_record_txtime`,
//! `libnet80211 ftm_record_t2t3_cb`, `ftm_record_t1t4_cb`; IDF 5.5) and was checked on silicon
//! by the FTM spike (#638): every stamp is the MAC's 1 MHz counter (`0x600A_D000`), a 7-bit
//! 80 MHz sub-µs tick, and on receive an 11-bit fine field.
//!
//! **Nothing here touches the radio or waits.** Decoding is pure; the one MMIO read
//! ([`crate::tx::txq_ftm_words`]) is three loads in the completion poll that already runs.
//! A caller that does not range never calls either.
//!
//! **The per-boot phase state** ([`RxFtm::phase`]): `(t3 tick - t2 tick) mod 80` is 39 or 41
//! for a whole boot of the responding device, and a device in state 41 adds 7-11 raw (1.6-2.6
//! m) to every RTT it answers. Until that is calibrated (S2), consumers carry it as a flag.

/// Raw units per µs (the stamps' resolution: 1/640 µs).
pub const RAW_PER_US: i64 = 640;
/// One-way metres per raw unit of RTT: 1.5625 ns x c / 2.
pub const M_PER_RAW: f32 = 0.234_212_86;

/// A fine timestamp: the MAC's 32-bit µs counter and the sub-µs part in raw units (which
/// may be negative or exceed 640: the decode's constant offsets ride here). Differences
/// wrap with the counter ([`FtmStamp::minus`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FtmStamp {
    pub us: u32,
    pub sub: i32,
}

impl FtmStamp {
    /// `self - o` in raw units (the µs counters may have wrapped in between; the two must
    /// be within ~35 minutes of each other).
    pub fn minus(self, o: FtmStamp) -> i64 {
        (self.us.wrapping_sub(o.us) as i32 as i64) * RAW_PER_US + (self.sub as i64 - o.sub as i64)
    }
}

/// The blob's treatment of the 11-bit fine field (`ftm_get_phy_comp` neighbours): kept as
/// is up to 1023, else folded to `2048 - x`. On silicon the RTT regresses on it with
/// coefficient 1.0, so this is the right sign.
pub fn fold(x: u32) -> i32 {
    let x = (x & 0x7ff) as i32;
    if x <= 1023 {
        x
    } else {
        2048 - x
    }
}

/// The 80 MHz tick of a stamp word (bits 6:0, 0..79).
fn tick(b: u32) -> i32 {
    (b & 0x7f) as i32
}

/// The sender's half (A): t1 (its frame left) and t4 (the ACK arrived), from the queue's
/// three words ([`crate::tx::txq_ftm_words`]), valid once the frame completed with an ACK.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TxFtm {
    pub t1: FtmStamp,
    pub t4: FtmStamp,
}

impl TxFtm {
    /// `w0` = t1 µs; `w1` = t1 tick (6:0) | t4 µs bits 31:14 (31:14); `w2` = t4 tick (6:0)
    /// | t4 fine (17:7) | t4 µs bits 13:0 (31:18).
    pub fn decode(w: [u32; 3]) -> TxFtm {
        let [w0, w1, w2] = w;
        let t1 = FtmStamp { us: w0, sub: (tick(w1) - 640) * 8 };
        let us4 = (w1 & 0xffff_c000) | (w2 >> 18);
        let t4 = FtmStamp { us: us4, sub: -13312 + tick(w2) * 8 + fold(w2 >> 7) };
        TxFtm { t1, t4 }
    }

    /// t4 - t1, raw units: the frame's airtime + SIFS + the RTT.
    pub fn span(&self) -> i64 {
        self.t4.minus(self.t1)
    }
}

/// The responder's half (B), from the RX vector of the frame it ACKed: t2 (the frame
/// arrived) and t3 (its ACK left), and the boot's phase state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RxFtm {
    pub t2: FtmStamp,
    pub t3: FtmStamp,
    /// `(t3 tick - t2 tick) mod 80`: 39 or 41 per boot on every board measured (see the
    /// module doc); anything else is a stamp to distrust.
    pub phase: u8,
}

/// Bytes of RX vector [`RxFtm::decode`] reads.
pub const RXV_FTM_LEN: usize = 81;

impl RxFtm {
    /// From the 92-byte RX vector ([`crate::p2p::RXV_LEN`]). t3 is meaningful only for a
    /// frame this MAC ACKed (a unicast to it), read at least ~50 µs after the frame ended
    /// (the vendor's wait; every reap is later).
    pub fn decode(v: &[u8]) -> Option<RxFtm> {
        if v.len() < RXV_FTM_LEN {
            return None;
        }
        let us2 = u32::from_le_bytes([v[12], v[13], v[14], v[15]]);
        let fine = (((v[35] & 0x7f) as u32) << 4) | (v[34] >> 4) as u32;
        let t2 = FtmStamp { us: us2, sub: -13312 + tick(v[11] as u32) * 8 + fold(fine) };
        let us3 = u32::from_le_bytes([v[76], v[77], v[78], v[79]]);
        let t3 = FtmStamp { us: us3, sub: (tick(v[80] as u32) - 640) * 8 };
        let phase = (tick(v[80] as u32) - tick(v[11] as u32)).rem_euclid(80) as u8;
        Some(RxFtm { t2, t3, phase })
    }

    /// t3 - t2, raw units on the responder's clock: the frame's airtime + SIFS.
    pub fn turnaround(&self) -> i64 {
        self.t3.minus(self.t2)
    }
}

/// Pulse the Wi-Fi baseband's reset to put this device's tick phase into the 41 state
/// ([`PHASE_HIGH`]) without a reboot (S2, hitl-rig-1: 39 -> 41 in 5 of 5 JTAG pulses, 41
/// stayed 41 in 11 of 11, the link and its calibration survived). Every device forced the
/// same way shares one pair constant. False (nothing done) while `queue` has a frame armed:
/// call it again later. A frame being received at that instant is lost, nothing more.
///
/// # Safety
/// MMIO; the MAC must be initialized.
pub unsafe fn force_phase(queue: usize) -> bool {
    use crate::regs::{mmio, modem_syscon as ms};
    if crate::tx::TxRing::<4>::arm_pending(queue) {
        return false;
    }
    let v = mmio::read32(ms::RST_CONF);
    mmio::write32(ms::RST_CONF, v | ms::RST_WIFIBB);
    mmio::write32(ms::RST_CONF, v & !ms::RST_WIFIBB);
    true
}

/// The two phase states seen on silicon (39 is the lower-offset one).
pub const PHASE_LOW: u8 = 39;
pub const PHASE_HIGH: u8 = 41;

/// One exchange's RTT, raw units: `(t4 - t1) - (t3 - t2)`, with the turnaround (timed on
/// the responder's clock) mapped onto the sender's by `ppb`, the responder's clock rate
/// against the sender's in parts per billion (`+` = the responder runs fast). The 49 ppm
/// two crystals differ by moves a 1000-byte frame's RTT by 10 raw (2.4 m) otherwise.
pub fn rtt_raw(tx: &TxFtm, rx: &RxFtm, ppb: i32) -> i64 {
    let turn = rx.turnaround();
    tx.span() - turn + (turn * ppb as i64) / 1_000_000_000
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    // Two exchanges from the spike's first run (hitl-rig-1, c6-123170 -> c6-711f48, ch 6,
    // 6 Mb/s, 64-byte body), and what the spike's Python decode (ftm_spike_core.py) made
    // of them.
    const W1: [u32; 3] = [0x0100_7ab4, 0x0100_4037, 0xee4b_aa24];
    const V1: &str = "ee0b7c90000000000000004c68a30401dff3ef39a0eee20d00000000000000000000e074000000010000000000000000000000000000000000000000000000000000000000000000000200002ba40401250000007c00800000000000";
    const W2: [u32; 3] = [0x0100_c8b2, 0x0100_c041, 0x2643_a42c];
    const V2: &str = "ee0b7c90000000000000000468f10401e873f439a0eee40d00000000000000000000e074000000010000000000000000000000000000000000000000000000000000000000000000000200002af204012d0000007c00800000000000";

    #[test]
    fn decodes_the_spike_stamps() {
        let tx = TxFtm::decode(W1);
        assert_eq!(tx.t1, FtmStamp { us: 16_808_628, sub: -4680 });
        assert_eq!(tx.t4, FtmStamp { us: 16_808_850, sub: -12_852 });
        let rx = RxFtm::decode(&hex(V1)).unwrap();
        assert_eq!(rx.t2, FtmStamp { us: 17_081_192, sub: -12_526 });
        assert_eq!(rx.t3, FtmStamp { us: 17_081_387, sub: -4824 });
        assert_eq!((tx.span(), rx.turnaround()), (133_908, 132_502));
        assert_eq!(rtt_raw(&tx, &rx, 0), 1406);
        // B (c6-711f48) was in phase state 41 that boot: tick3 37 - tick2 76 = -39 = 41 mod 80.
        assert_eq!(rx.phase, PHASE_HIGH);

        let (tx, rx) = (TxFtm::decode(W2), RxFtm::decode(&hex(V2)).unwrap());
        assert_eq!(rtt_raw(&tx, &rx, 0), 1402);
        assert_eq!(rx.phase, PHASE_HIGH);
    }

    /// The 48.8 ppm the spike fitted for this pair adds turnaround x ppm (132502 x 48.8e-6
    /// = 6.5 raw) to the RTT.
    #[test]
    fn drift_maps_the_turnaround() {
        let (tx, rx) = (TxFtm::decode(W1), RxFtm::decode(&hex(V1)).unwrap());
        assert_eq!(rtt_raw(&tx, &rx, 48_814), 1406 + 6);
        assert_eq!(rtt_raw(&tx, &rx, -48_814), 1406 - 6);
    }

    #[test]
    fn differences_wrap_with_the_counter() {
        let a = FtmStamp { us: 5, sub: 0 };
        let b = FtmStamp { us: u32::MAX - 4, sub: 100 };
        assert_eq!(a.minus(b), 10 * 640 - 100);
        assert_eq!(b.minus(a), -(10 * 640 - 100));
    }

    #[test]
    fn fine_field_folds_like_the_blob() {
        assert_eq!((fold(0), fold(1023), fold(1024), fold(1870), fold(2047)), (0, 1023, 1024, 178, 1));
    }

    #[test]
    fn short_vector_is_none() {
        assert_eq!(RxFtm::decode(&[0u8; 80]), None);
    }
}
