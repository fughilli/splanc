//! Heapless 802.11 RX parse/reassembly, allocation-free and bounded:
//!
//!   * [`reconstruct_mbssid`] synthesizes a beacon per non-transmitted BSSID
//!     profile from a Multiple-BSSID element. It appends into a capacity-typed
//!     [`Buf`], so an over-long reconstruction returns `Err(Overflow)` and is
//!     never written past the buffer.
//!   * [`Defrag`] reassembles fragmented frames into a fixed buffer, with an
//!     explicit `accumulated + frag <= CAP` check on every append.
//!
//! Zero allocation; every parser is bounded by the input slice.

use crate::rx::{Buf, Ie, IeReader, Overflow, MAX_FRAME};

/// 802.11 element IDs we care about here.
pub const EID_SSID: u8 = 0x00;
pub const EID_MBSSID: u8 = 0x47;
pub const EID_MBSSID_INDEX: u8 = 0x53;
const SUBELEM_NONTX_PROFILE: u8 = 0x00;

/// A parsed beacon view: the fixed prefix split off, IEs left as a bounded slice.
pub struct Beacon<'a> {
    pub ies: &'a [u8],
}

impl<'a> Beacon<'a> {
    /// Split a beacon *body* (the 12-byte fixed params + IEs, i.e. the bytes
    /// after the 24-byte MAC header) into its IE list. Returns `None` if the
    /// fixed params don't fit — never reads past `body`.
    pub fn parse(body: &'a [u8]) -> Option<Beacon<'a>> {
        // timestamp(8) + beacon interval(2) + capability(2) = 12 fixed bytes.
        if body.len() < 12 {
            return None;
        }
        Some(Beacon { ies: &body[12..] })
    }

    pub fn ssid(&self) -> Option<&'a [u8]> {
        IeReader::new(self.ies).find(|ie| ie.id == EID_SSID).map(|ie| ie.body)
    }
}

/// Find the non-transmitted-BSSID profile inside an MBSSID (0x47) element body.
/// The inner subelement id 0 must lead with a Multiple-BSSID-Index element
/// (`0x53,len`); every access is bounds-checked.
fn find_nontx_profile(mbssid_body: &[u8]) -> Option<&[u8]> {
    if mbssid_body.is_empty() {
        return None;
    }
    // mbssid_body = [MaxBSSIDIndicator][subelements...]
    let subelems = &mbssid_body[1..];
    for sub in IeReader::new(subelems) {
        if sub.id == SUBELEM_NONTX_PROFILE
            && sub.body.len() >= 2
            && sub.body[0] == EID_MBSSID_INDEX
        {
            return Some(sub.body);
        }
    }
    None
}

/// Reconstruct the standalone beacon IEs for a non-transmitted BSSID. Walk the
/// transmitted IEs; for each, emit the profile's override if present, else the
/// transmitted IE; the MBSSID element itself is consumed. Every emit is
/// bounds-checked against `out`, so an over-long result is refused (`Overflow`),
/// never written past the buffer.
pub fn reconstruct_mbssid<const N: usize>(
    transmitted_ies: &[u8],
    out: &mut Buf<N>,
) -> Result<(), Overflow> {
    // The profile IEs (from the nontransmitted profile subelement) override
    // matching transmitted IEs. Find it first (bounded).
    let profile: &[u8] = IeReader::new(transmitted_ies)
        .find(|ie| ie.id == EID_MBSSID)
        .and_then(|mbssid| find_nontx_profile(mbssid.body))
        .map(|p| &p[..])
        .unwrap_or(&[]);

    let profile_ie = |id: u8| -> Option<Ie<'_>> {
        // Skip the leading Multiple-BSSID-Index element; search the rest.
        IeReader::new(profile).find(|ie| ie.id == id)
    };

    for ie in IeReader::new(transmitted_ies) {
        if ie.id == EID_MBSSID {
            continue; // consumed, not copied
        }
        match profile_ie(ie.id) {
            Some(over) => out.push_ie(over.id, over.body)?, // profile override
            None => out.push_ie(ie.id, ie.body)?,           // transmitted as-is
        }
    }
    Ok(())
}

/// Fixed-capacity fragment reassembly. Every append is gated on
/// `len() + frag <= CAP`, where `CAP` is the RX buffer budget.
pub struct Defrag {
    buf: Buf<MAX_FRAME>,
    active: bool,
}

impl Defrag {
    pub const fn new() -> Self {
        Defrag { buf: Buf::new(), active: false }
    }
    pub fn reset(&mut self) {
        self.buf = Buf::new();
        self.active = false;
    }
    /// Add a fragment. Returns `Err(Overflow)` (and drops it) when the
    /// reassembled total would exceed the buffer, rather than overrunning it.
    pub fn push_fragment(&mut self, frag: &[u8], more_frags: bool) -> Result<(), Overflow> {
        self.buf.extend(frag)?;
        self.active = more_frags;
        Ok(())
    }
    pub fn is_complete(&self) -> bool {
        !self.active && !self.buf.is_empty()
    }
    pub fn assembled(&self) -> &[u8] {
        self.buf.as_slice()
    }
}

impl Default for Defrag {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beacon_parse_is_bounded() {
        assert!(Beacon::parse(&[0u8; 8]).is_none()); // fixed params don't fit
        let mut body = [0u8; 12 + 12];
        body[12] = EID_SSID;
        body[13] = 10;
        body[14..24].copy_from_slice(b"SEC-MBSSID");
        let b = Beacon::parse(&body).unwrap();
        assert_eq!(b.ssid(), Some(&b"SEC-MBSSID"[..]));
    }

    #[test]
    fn mbssid_reconstruct_valid_small() {
        // transmitted: SSID + an MBSSID elem w/ a nontx profile overriding SSID.
        let mut tx: Buf<256> = Buf::new();
        tx.push_ie(EID_SSID, b"tx-ssid").unwrap();
        tx.push_ie(0x01, &[0x82, 0x84]).unwrap();
        // MBSSID: [MaxBSSID=2][sub0: [MBSSID-Index 0x53,len2][SSID "ntx"]]
        let mut prof: Buf<64> = Buf::new();
        prof.push_ie(EID_MBSSID_INDEX, &[0x01, 0x00]).unwrap();
        prof.push_ie(EID_SSID, b"ntx").unwrap();
        let mut mbssid_body: Buf<80> = Buf::new();
        mbssid_body.extend(&[0x02]).unwrap(); // MaxBSSID indicator
        mbssid_body.push_ie(SUBELEM_NONTX_PROFILE, prof.as_slice()).unwrap();
        tx.push_ie(EID_MBSSID, mbssid_body.as_slice()).unwrap();

        let mut out: Buf<256> = Buf::new();
        reconstruct_mbssid(tx.as_slice(), &mut out).unwrap();
        // SSID was overridden to "ntx"; rates kept; MBSSID elem dropped.
        let got_ssid = Beacon { ies: out.as_slice() }
            .ies;
        let ssid = IeReader::new(got_ssid).find(|i| i.id == EID_SSID).unwrap();
        assert_eq!(ssid.body, b"ntx");
        assert!(IeReader::new(out.as_slice()).all(|i| i.id != EID_MBSSID));
    }

    #[test]
    fn mbssid_reconstruct_cannot_overflow() {
        // Fill transmitted IEs near MAX_FRAME; reconstruct into a smaller
        // buffer: must Err, never write past the destination.
        let mut tx: Buf<MAX_FRAME> = Buf::new();
        while tx.remaining() > 260 {
            tx.push_ie(0xdd, &[0x5a; 253]).unwrap();
        }
        let mut out: Buf<1200> = Buf::new();
        assert_eq!(reconstruct_mbssid(tx.as_slice(), &mut out), Err(Overflow));
    }

    #[test]
    fn defrag_bounds_the_reassembly() {
        let mut d = Defrag::new();
        let big = [0u8; 900];
        assert!(d.push_fragment(&big, true).is_ok()); // 900
        // 900 + 900 = 1800 > MAX_FRAME(1700) -> dropped, never overruns.
        assert_eq!(d.push_fragment(&big, false), Err(Overflow));
        assert!(d.assembled().len() <= MAX_FRAME);
    }
}
