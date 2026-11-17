//! The mesh envelope (design §5.1, §7.5): every mesh frame on every backhaul.
//!
//! ```text
//! short header (14 B), most frames        long header (18 B), at least once a second
//!  0  2  magic "SM"                         0  2  magic "SL"
//!  2  1  version (1)                        2  1  version (1)
//!  3  4  mesh id                            3  4  mesh id
//!  7  1  key epoch                          7  1  key epoch
//!  8  2  source node id                     8  2  source node id
//! 10  4  frame counter, low 32 bits        10  8  frame counter, all 64 bits
//!    n  body (a LinkFrame, AES-128-CCM; plain frames: a membership message)
//!       MIC: 8 bytes on 802.11, 4 on UWB; plain frames (epoch 0) have none
//! ```
//!
//! Epochs: 0 = plain (join, advert, guest hello), 0xFF = the open follow stream, 1..=254 =
//! the mesh key's epoch. The header is the CCM AAD.
//!
//! **The counter never rolls over.** Each sender keeps a 64-bit logical counter
//! ([`TxCounter`]) and the CCM nonce uses all of it: source ‖ counter (64) ‖ epoch ‖ version ‖
//! MIC length = 13 bytes (unique per key for as long as a counter never repeats; the mesh id
//! is in the key's derivation and the AAD). The short header carries only the low 32 bits;
//! a receiver rebuilds the rest from the highest counter it has seen from that sender
//! ([`reconstruct`], SRTP's rollover-counter guess). A wrong guess makes the nonce wrong, so
//! the MIC fails: a guess can lose a frame, never accept a forged or replayed one. A
//! receiver with no state for a sender learns the full value from a long header (the sender
//! sends one at least once a second when the frame has room) and, for anything
//! security-relevant, from an authenticated freshness exchange ([`crate::admin`]).
//!
//! Persistence ([`TxCounter`]): the device stores a high-water mark (every counter below it
//! may have been used) once per 2^16 frames, ahead of use; at boot it jumps to the stored
//! mark. No counter is ever reused, and flash sees one small write per 65,536 frames.
//!
//! Splanc framing: nothing here is Espressif's (no ESP-NOW header, no OUI).

use core::ops::Range;

use ledmapper_netstack::ccmp::{ccm_open, ccm_seal};

use crate::backhaul::NodeId;
use crate::crypto::hkdf16;

pub const MAGIC: [u8; 2] = *b"SM";
pub const MAGIC_LONG: [u8; 2] = *b"SL";
pub const VERSION: u8 = 1;
pub const HEADER_LEN: usize = 14;
pub const HEADER_LONG_LEN: usize = 18;

/// Plain frames: join requests and accepts, mesh adverts, guest hellos (§7.3). No MIC; what
/// they carry authenticates itself (proofs, wrapped keys) or is public.
pub const EPOCH_PLAIN: u8 = 0;
/// The open-mode follow stream under `K_open` (§7.4): integrity, not authenticity.
pub const EPOCH_OPEN: u8 = 0xFF;
/// The first member epoch (the key a site secret derives, §7.3).
pub const EPOCH_FIRST: u8 = 1;

/// The epoch after `e` in the member range 1..=254.
pub const fn next_epoch(e: u8) -> u8 {
    if e >= 254 {
        EPOCH_FIRST
    } else {
        e + 1
    }
}

/// The CCM tag length: 8 bytes on 802.11, 4 on UWB where every byte counts (§7.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MicLen {
    M4,
    M8,
}

impl MicLen {
    pub const fn bytes(self) -> usize {
        match self {
            MicLen::M4 => 4,
            MicLen::M8 => 8,
        }
    }

    /// Bytes a short-header frame adds (14 + MIC): 22 on 802.11, 18 on UWB (§5.2). Packets
    /// are sized for this; the long header is used only when the frame has 4 bytes to spare.
    pub const fn overhead(self) -> usize {
        HEADER_LEN + self.bytes()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub mesh_id: u32,
    pub epoch: u8,
    pub src: NodeId,
    /// The full counter (long header), or only its low 32 bits as received (short header,
    /// before [`reconstruct`]).
    pub counter: u64,
    pub long: bool,
}

/// Why a frame is not a mesh envelope we can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvReject {
    /// Shorter than a header, or not "SM"/"SL".
    NotEnvelope,
    /// An envelope version this firmware does not speak (counted; §5.7 reports it).
    Version(u8),
    /// The MIC did not verify (wrong key, wrong counter guess, tampering, corruption).
    BadMic,
}

impl Header {
    pub fn len(&self) -> usize {
        if self.long {
            HEADER_LONG_LEN
        } else {
            HEADER_LEN
        }
    }

    pub fn is_empty(&self) -> bool {
        false
    }

    /// The header bytes (the first `len()` of the array).
    pub fn encode(&self) -> [u8; HEADER_LONG_LEN] {
        let mut b = [0u8; HEADER_LONG_LEN];
        b[0..2].copy_from_slice(if self.long { &MAGIC_LONG } else { &MAGIC });
        b[2] = VERSION;
        b[3..7].copy_from_slice(&self.mesh_id.to_be_bytes());
        b[7] = self.epoch;
        b[8..10].copy_from_slice(&self.src.to_be_bytes());
        if self.long {
            b[10..18].copy_from_slice(&self.counter.to_be_bytes());
        } else {
            b[10..14].copy_from_slice(&(self.counter as u32).to_be_bytes());
        }
        b
    }

    pub fn decode(b: &[u8]) -> Result<Header, EnvReject> {
        if b.len() < HEADER_LEN {
            return Err(EnvReject::NotEnvelope);
        }
        let long = match [b[0], b[1]] {
            MAGIC => false,
            MAGIC_LONG if b.len() >= HEADER_LONG_LEN => true,
            _ => return Err(EnvReject::NotEnvelope),
        };
        if b[2] != VERSION {
            return Err(EnvReject::Version(b[2]));
        }
        let counter = if long {
            u64::from_be_bytes([b[10], b[11], b[12], b[13], b[14], b[15], b[16], b[17]])
        } else {
            u32::from_be_bytes([b[10], b[11], b[12], b[13]]) as u64
        };
        Ok(Header {
            mesh_id: u32::from_be_bytes([b[3], b[4], b[5], b[6]]),
            epoch: b[7],
            src: u16::from_be_bytes([b[8], b[9]]),
            counter,
            long,
        })
    }

    /// The CCM nonce (13 bytes) for the full counter `counter`.
    pub fn nonce(&self, counter: u64, mic: MicLen) -> [u8; 13] {
        let mut n = [0u8; 13];
        n[0..2].copy_from_slice(&self.src.to_be_bytes());
        n[2..10].copy_from_slice(&counter.to_be_bytes());
        n[10] = self.epoch;
        n[11] = VERSION;
        n[12] = mic.bytes() as u8;
        n
    }
}

/// The full counter for a short header's low 32 bits `low`, given the highest full counter
/// `last` seen from that sender: the candidate nearest `last` among the three 2^32-blocks
/// around it (SRTP's rollover guess). A wrong guess only fails the MIC.
pub fn reconstruct(last: u64, low: u32) -> u64 {
    let hi = last >> 32;
    let mut best = (u64::MAX, 0u64);
    for h in [hi.wrapping_sub(1), hi, hi.wrapping_add(1)] {
        if h > u32::MAX as u64 && h != hi {
            continue; // below zero or past the top
        }
        let c = (h << 32) | low as u64;
        let d = c.abs_diff(last);
        if d < best.0 {
            best = (d, c);
        }
    }
    best.1
}

/// The frame key for a mesh key and epoch: `HKDF(mesh key, epoch, "frame")` (§7.5), salted
/// with the mesh id.
pub fn frame_key(mesh_id: u32, mesh_key: &[u8; 16], epoch: u8) -> [u8; 16] {
    hkdf16(&mesh_id.to_be_bytes(), mesh_key, &[b"splanc mesh frame", &[epoch]])
}

/// The open follow stream's key, `K_open = HKDF(mesh id, "open")` (§7.4). Anyone can compute
/// it: it protects against corruption, not forgery.
pub fn open_key(mesh_id: u32) -> [u8; 16] {
    hkdf16(b"splanc mesh open", &mesh_id.to_be_bytes(), &[b"open"])
}

/// Seal `body` under `key` (full counter in `h.counter`): header ‖ ciphertext ‖ MIC into
/// `out`. None if `out` is short.
pub fn seal(key: &[u8; 16], mic: MicLen, h: &Header, body: &[u8], out: &mut [u8]) -> Option<usize> {
    let hl = h.len();
    let total = hl + body.len() + mic.bytes();
    if out.len() < total || body.len() > u16::MAX as usize {
        return None;
    }
    let hdr = h.encode();
    out[..hl].copy_from_slice(&hdr[..hl]);
    let (_, rest) = out.split_at_mut(hl);
    rest[..body.len()].copy_from_slice(body);
    let nonce = h.nonce(h.counter, mic);
    let n = match mic {
        MicLen::M4 => ccm_seal::<4>(key, &nonce, &hdr[..hl], rest, body.len()),
        MicLen::M8 => ccm_seal::<8>(key, &nonce, &hdr[..hl], rest, body.len()),
    };
    Some(hl + n)
}

/// A plain frame (epoch 0): short header ‖ body, no MIC.
pub fn seal_plain(mesh_id: u32, src: NodeId, counter: u64, body: &[u8], out: &mut [u8]) -> Option<usize> {
    let total = HEADER_LEN + body.len();
    if out.len() < total {
        return None;
    }
    let h = Header { mesh_id, epoch: EPOCH_PLAIN, src, counter, long: false };
    out[..HEADER_LEN].copy_from_slice(&h.encode()[..HEADER_LEN]);
    out[HEADER_LEN..total].copy_from_slice(body);
    Some(total)
}

/// Open a sealed frame in place with the full counter `counter` (from the long header, or
/// [`reconstruct`]ed): on success the plaintext body is `frame[range]`.
pub fn open(key: &[u8; 16], mic: MicLen, h: &Header, counter: u64, frame: &mut [u8]) -> Result<Range<usize>, EnvReject> {
    let hl = h.len();
    if frame.len() < hl + mic.bytes() {
        return Err(EnvReject::BadMic);
    }
    let mut hdr = [0u8; HEADER_LONG_LEN];
    hdr[..hl].copy_from_slice(&frame[..hl]);
    let nonce = h.nonce(counter, mic);
    let clen = frame.len() - hl;
    let body = &mut frame[hl..];
    let plen = match mic {
        MicLen::M4 => ccm_open::<4>(key, &nonce, &hdr[..hl], body, clen),
        MicLen::M8 => ccm_open::<8>(key, &nonce, &hdr[..hl], body, clen),
    };
    match plen {
        Some(p) => Ok(hl..hl + p),
        None => Err(EnvReject::BadMic),
    }
}

/// Frames per reserved counter block: the high-water mark is written once per block.
pub const COUNTER_BLOCK: u64 = 1 << 16;

/// The per-sender 64-bit frame counter (§7.5). `next` never repeats: the device persists a
/// high-water mark (every counter below it may have been used) a block ahead of use, and at
/// boot starts at the persisted mark.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TxCounter {
    next: u64,
    /// Counters below this are covered by a persisted mark.
    limit: u64,
    /// A reservation was asked for and not yet confirmed.
    asked: Option<u64>,
}

/// No counter may be used until the persisted mark covers it (only before the first
/// reservation of a boot lands, or if flash writes fail for 2^15 frames).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CounterNotReserved;

impl TxCounter {
    /// At boot, `mark` is the persisted high-water mark (0 on a fresh device).
    pub fn new(mark: u64) -> TxCounter {
        TxCounter { next: mark, limit: mark, asked: None }
    }

    pub fn take(&mut self) -> Result<u64, CounterNotReserved> {
        if self.next >= self.limit {
            return Err(CounterNotReserved);
        }
        let c = self.next;
        self.next += 1;
        Ok(c)
    }

    /// The mark to persist next, if one is due: at boot, and when half the current block is
    /// spent (so the write lands long before the block runs out: no stall).
    pub fn wants_reservation(&mut self) -> Option<u64> {
        if self.asked.is_some() {
            return None;
        }
        if self.limit.saturating_sub(self.next) <= COUNTER_BLOCK / 2 {
            let m = self.limit.max(self.next) + COUNTER_BLOCK;
            self.asked = Some(m);
            return Some(m);
        }
        None
    }

    /// The device persisted `mark` (from [`TxCounter::wants_reservation`]).
    pub fn reserved(&mut self, mark: u64) {
        if mark > self.limit {
            self.limit = mark;
        }
        if self.asked.is_some_and(|a| a <= mark) {
            self.asked = None;
        }
    }

    /// The next counter this sender will use (its "current full counter" for freshness).
    pub fn current(&self) -> u64 {
        self.next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 16] = [0x11; 16];

    fn hdr(long: bool) -> Header {
        Header { mesh_id: 0x5150_4c41, epoch: 3, src: 0x0102, counter: (7 << 32) | 5, long }
    }

    /// Golden: both header layouts and the nonce, byte for byte (a regression vector for the
    /// firmware and any other implementation; the CCM under it is RFC 3610-checked in the
    /// netstack).
    #[test]
    fn golden_envelope() {
        let h = hdr(false);
        assert_eq!(h.encode()[..14], [b'S', b'M', 1, 0x51, 0x50, 0x4c, 0x41, 3, 0x01, 0x02, 0, 0, 0, 5]);
        assert_eq!(hdr(true).encode(), [b'S', b'L', 1, 0x51, 0x50, 0x4c, 0x41, 3, 0x01, 0x02, 0, 0, 0, 7, 0, 0, 0, 5]);
        assert_eq!(h.nonce(h.counter, MicLen::M8), [0x01, 0x02, 0, 0, 0, 7, 0, 0, 0, 5, 3, 1, 8]);
        let mut out = [0u8; 64];
        let n = seal(&KEY, MicLen::M8, &h, b"link frame", &mut out).unwrap();
        assert_eq!(n, 14 + 10 + 8);
        let mut hex = String::new();
        for b in &out[..n] {
            use std::fmt::Write;
            write!(hex, "{b:02x}").unwrap();
        }
        assert_eq!(hex.len(), 64);
        // The short frame's MIC is over the full counter: opening with the wrong high bits
        // fails.
        let mut f = out;
        let got = Header::decode(&f[..n]).unwrap();
        assert_eq!(got.counter, 5, "short header: low bits only");
        let mut g = f;
        assert!(open(&KEY, MicLen::M8, &got, 5, &mut g[..n]).is_err());
        assert!(open(&KEY, MicLen::M8, &got, (7 << 32) | 5, &mut f[..n]).is_ok());
    }

    #[test]
    fn seal_open_both_headers_and_mic_lengths() {
        for long in [false, true] {
            for mic in [MicLen::M4, MicLen::M8] {
                let h = hdr(long);
                let mut f = [0u8; 64];
                let n = seal(&KEY, mic, &h, b"hello mesh", &mut f).unwrap();
                assert_eq!(n, h.len() + 10 + mic.bytes());
                let got = Header::decode(&f[..n]).unwrap();
                let full = if long { got.counter } else { reconstruct(7 << 32, got.counter as u32) };
                assert_eq!(full, h.counter);
                let mut g = f;
                let r = open(&KEY, mic, &got, full, &mut g[..n]).unwrap();
                assert_eq!(&g[r], b"hello mesh");
                for i in 0..n {
                    let mut bad = f;
                    bad[i] ^= 1;
                    let res = Header::decode(&bad[..n]).and_then(|h2| {
                        let c = if h2.long { h2.counter } else { reconstruct(7 << 32, h2.counter as u32) };
                        open(&KEY, mic, &h2, c, &mut bad[..n])
                    });
                    assert!(res.is_err(), "{long} {mic:?} byte {i}");
                }
            }
        }
    }

    /// Reconstruction across 2^32 boundaries, both ways, and at the ends of the range.
    #[test]
    fn reconstruction_across_boundaries() {
        let b = 1u64 << 32;
        // Forward across a boundary: last just below, frame just above.
        assert_eq!(reconstruct(b - 3, 2), b + 2);
        // A late frame from before the boundary.
        assert_eq!(reconstruct(b + 2, 0xFFFF_FFFE), b - 2);
        // Far into the block.
        assert_eq!(reconstruct(5 * b + 100, 50), 5 * b + 50);
        assert_eq!(reconstruct(5 * b + 100, 0x8000_0000), 5 * b + 0x8000_0000);
        // Nothing below zero, nothing past the top.
        assert_eq!(reconstruct(3, 0xFFFF_FFFF), 0xFFFF_FFFF);
        assert_eq!(reconstruct(u64::MAX - 2, 1), (u64::MAX & !0xFFFF_FFFF) | 1);
        // Every distance below 2^31 round-trips.
        for last in [0u64, b - 1, b, 7 * b + 12345] {
            for d in [0i64, 1, -1, 1_000_000, -1_000_000, (1 << 31) - 1, -(1 << 31) + 1] {
                let c = last as i64 + d;
                if c < 0 {
                    continue;
                }
                assert_eq!(reconstruct(last, c as u32), c as u64, "last {last} d {d}");
            }
        }
    }

    /// A wrong guess (the sender jumped 2^32 frames ahead and we only see a short header)
    /// fails the MIC: lost, never accepted.
    #[test]
    fn a_wrong_guess_is_rejected_not_accepted() {
        let real = (9u64 << 32) | 77;
        let h = Header { counter: real, ..hdr(false) };
        let mut f = [0u8; 64];
        let n = seal(&KEY, MicLen::M8, &h, b"x", &mut f).unwrap();
        let got = Header::decode(&f[..n]).unwrap();
        let guess = reconstruct(3u64 << 32, got.counter as u32);
        assert_ne!(guess, real);
        assert_eq!(open(&KEY, MicLen::M8, &got, guess, &mut f[..n]), Err(EnvReject::BadMic));
    }

    #[test]
    fn header_rejects() {
        assert_eq!(Header::decode(b"SM"), Err(EnvReject::NotEnvelope));
        let mut b = hdr(false).encode();
        b[0] = b'X';
        assert_eq!(Header::decode(&b[..14]), Err(EnvReject::NotEnvelope));
        let mut b = hdr(false).encode();
        b[2] = 2;
        assert_eq!(Header::decode(&b[..14]), Err(EnvReject::Version(2)));
        assert_eq!(Header::decode(&hdr(true).encode()[..16]), Err(EnvReject::NotEnvelope), "short long header");
    }

    #[test]
    fn keys_differ_by_epoch_and_mesh() {
        let k = [9u8; 16];
        assert_ne!(frame_key(1, &k, 1), frame_key(1, &k, 2));
        assert_ne!(frame_key(1, &k, 1), frame_key(2, &k, 1));
        assert_ne!(open_key(1), open_key(2));
        assert_eq!(next_epoch(254), EPOCH_FIRST);
    }

    #[test]
    fn plain_frames_have_no_mic() {
        let mut f = [0u8; 32];
        let n = seal_plain(7, 3, 9, b"join", &mut f).unwrap();
        let h = Header::decode(&f[..n]).unwrap();
        assert_eq!((n, h.epoch, h.src, h.counter, h.mesh_id), (HEADER_LEN + 4, EPOCH_PLAIN, 3, 9, 7));
    }

    /// Reservation: nothing before the first mark lands; a block per write; the next
    /// reservation is asked for half a block early (no stall); a reboot jumps to the mark
    /// so no counter is ever reused, even if the device used none of its block.
    #[test]
    fn counter_reservation_and_reboot_jumps() {
        let mut c = TxCounter::new(0);
        assert_eq!(c.take(), Err(CounterNotReserved));
        assert_eq!(c.wants_reservation(), Some(COUNTER_BLOCK));
        assert_eq!(c.wants_reservation(), None, "asked once");
        c.reserved(COUNTER_BLOCK);
        let mut used = Vec::new();
        for _ in 0..COUNTER_BLOCK / 2 - 1 {
            used.push(c.take().unwrap());
        }
        assert_eq!(c.wants_reservation(), None);
        used.push(c.take().unwrap());
        assert_eq!(c.wants_reservation(), Some(2 * COUNTER_BLOCK), "half a block early");
        c.reserved(2 * COUNTER_BLOCK);
        assert!(used.windows(2).all(|w| w[1] == w[0] + 1));
        // Power cut now: the stored mark is 2 blocks; the next boot starts there.
        let last = c.take().unwrap();
        let mut c2 = TxCounter::new(2 * COUNTER_BLOCK);
        assert_eq!(c2.wants_reservation(), Some(3 * COUNTER_BLOCK));
        c2.reserved(3 * COUNTER_BLOCK);
        assert!(c2.take().unwrap() > last);
        // Across 2^32 the counter just keeps counting.
        let mut c3 = TxCounter::new(u32::MAX as u64 - 1);
        c3.wants_reservation();
        c3.reserved(u32::MAX as u64 + COUNTER_BLOCK);
        assert_eq!((c3.take(), c3.take(), c3.take()), (Ok(0xFFFF_FFFE), Ok(0xFFFF_FFFF), Ok(1 << 32)));
    }
}
