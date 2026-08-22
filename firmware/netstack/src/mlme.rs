//! Heapless 802.11 MLME — the STA and AP management state machines, allocation-
//! free with fixed-capacity tables. Drives the management-frame exchange
//! (auth/assoc) on top of the bounded parsers (`ieee80211`) and the RX ring
//! (`mac`). No dynamic allocation anywhere; the AP's station table is a fixed
//! array, so an association flood is bounded back-pressure, not memory growth.
//!
//! Scope: the management/MLME layer (roles). The data-plane crypto and the real
//! TX DMA are separate modules.

use crate::rx::{Buf, Overflow};

pub type Mac = [u8; 6];

/// 802.11 management frame subtypes we handle.
pub mod subtype {
    pub const ASSOC_REQ: u8 = 0x00;
    pub const ASSOC_RESP: u8 = 0x10;
    pub const PROBE_REQ: u8 = 0x40;
    pub const PROBE_RESP: u8 = 0x50;
    pub const BEACON: u8 = 0x80;
    pub const AUTH: u8 = 0xb0;
    pub const DEAUTH: u8 = 0xc0;
}

// --- STA role ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StaState {
    Idle,
    Scanning,
    Authenticating,
    Associating,
    Associated,
}

/// STA management state machine. Deterministic transitions on received mgmt
/// frames; no heap.
pub struct StaMlme {
    pub state: StaState,
    pub bssid: Mac,
}

impl StaMlme {
    pub const fn new() -> Self {
        StaMlme { state: StaState::Idle, bssid: [0; 6] }
    }

    /// Begin joining `bssid` (assumes it was found via scan). Emits the auth
    /// request into `out` (bounded).
    pub fn connect(&mut self, bssid: Mac, self_mac: Mac, out: &mut Buf<256>) -> Result<(), Overflow> {
        self.bssid = bssid;
        self.state = StaState::Authenticating;
        build_auth(self_mac, bssid, /*seq=*/1, /*status=*/0, out)
    }

    /// Handle a received management frame (already classified). Advances the
    /// state machine and, on success, emits the next request into `out`.
    pub fn on_mgmt(
        &mut self,
        st: u8,
        src: Mac,
        status: u16,
        self_mac: Mac,
        out: &mut Buf<256>,
    ) -> Result<(), Overflow> {
        if src != self.bssid {
            return Ok(()); // not our AP
        }
        match (self.state, st) {
            (StaState::Authenticating, subtype::AUTH) if status == 0 => {
                self.state = StaState::Associating;
                build_assoc_req(self_mac, self.bssid, out)
            }
            (StaState::Associating, subtype::ASSOC_RESP) if status == 0 => {
                self.state = StaState::Associated;
                Ok(())
            }
            (_, subtype::DEAUTH) => {
                self.state = StaState::Idle;
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub fn is_associated(&self) -> bool {
        self.state == StaState::Associated
    }
}

impl Default for StaMlme {
    fn default() -> Self {
        Self::new()
    }
}

// --- AP role ----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StaEntryState {
    Free,
    Authed,
    Assoc,
}

#[derive(Clone, Copy)]
struct StaEntry {
    mac: Mac,
    state: StaEntryState,
}

/// AP with a fixed-capacity station table (`N`). Handles auth/assoc; an
/// association flood fills the table and is refused (bounded), never allocates.
pub struct ApMlme<const N: usize> {
    stations: [StaEntry; N],
    pub bssid: Mac,
}

impl<const N: usize> ApMlme<N> {
    pub fn new(bssid: Mac) -> Self {
        ApMlme {
            stations: [StaEntry { mac: [0; 6], state: StaEntryState::Free }; N],
            bssid,
        }
    }

    fn find(&self, mac: &Mac) -> Option<usize> {
        self.stations.iter().position(|s| s.state != StaEntryState::Free && &s.mac == mac)
    }
    fn free_slot(&self) -> Option<usize> {
        self.stations.iter().position(|s| s.state == StaEntryState::Free)
    }

    /// Number of currently-known stations (auth or assoc).
    pub fn station_count(&self) -> usize {
        self.stations.iter().filter(|s| s.state != StaEntryState::Free).count()
    }

    /// Handle a received mgmt frame from `src`. On accept, emits the response
    /// into `out`. Returns `Ok(false)` if the frame was ignored/refused.
    pub fn on_mgmt(&mut self, st: u8, src: Mac, out: &mut Buf<256>) -> Result<bool, Overflow> {
        match st {
            subtype::AUTH => {
                let idx = self.find(&src).or_else(|| self.free_slot());
                match idx {
                    Some(i) => {
                        self.stations[i] = StaEntry { mac: src, state: StaEntryState::Authed };
                        build_auth(self.bssid, src, 2, 0, out)?;
                        Ok(true)
                    }
                    None => {
                        // table full -> refuse (status 17 = AP full), bounded.
                        build_auth(self.bssid, src, 2, 17, out)?;
                        Ok(false)
                    }
                }
            }
            subtype::ASSOC_REQ => match self.find(&src) {
                Some(i) if self.stations[i].state == StaEntryState::Authed => {
                    self.stations[i].state = StaEntryState::Assoc;
                    build_assoc_resp(self.bssid, src, 0, out)?;
                    Ok(true)
                }
                _ => Ok(false), // assoc without prior auth -> ignore
            },
            subtype::DEAUTH => {
                if let Some(i) = self.find(&src) {
                    self.stations[i].state = StaEntryState::Free;
                }
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    pub fn is_associated(&self, mac: &Mac) -> bool {
        self.find(mac).is_some_and(|i| self.stations[i].state == StaEntryState::Assoc)
    }
}

// --- bounded frame builders -------------------------------------------------

fn mgmt_header(subtype: u8, da: Mac, sa: Mac, bssid: Mac, out: &mut Buf<256>) -> Result<(), Overflow> {
    out.extend(&[subtype, 0x00])?; // frame control (subtype byte + flags)
    out.extend(&[0x00, 0x00])?; // duration
    out.extend(&da)?;
    out.extend(&sa)?;
    out.extend(&bssid)?;
    out.extend(&[0x00, 0x00]) // seq/frag
}

fn build_auth(sa: Mac, da: Mac, seq: u16, status: u16, out: &mut Buf<256>) -> Result<(), Overflow> {
    mgmt_header(subtype::AUTH, da, sa, sa, out)?;
    out.extend(&[0x00, 0x00])?; // auth algorithm = open
    out.extend(&seq.to_le_bytes())?;
    out.extend(&status.to_le_bytes())
}

fn build_assoc_req(sa: Mac, bssid: Mac, out: &mut Buf<256>) -> Result<(), Overflow> {
    mgmt_header(subtype::ASSOC_REQ, bssid, sa, bssid, out)?;
    out.extend(&[0x21, 0x04])?; // capability info
    out.extend(&[0x0a, 0x00])?; // listen interval
    out.push_ie(0x00, b"heapless")?; // SSID
    out.push_ie(0x01, &[0x82, 0x84, 0x8b, 0x96]) // supported rates
}

fn build_assoc_resp(sa: Mac, da: Mac, status: u16, out: &mut Buf<256>) -> Result<(), Overflow> {
    mgmt_header(subtype::ASSOC_RESP, da, sa, sa, out)?;
    out.extend(&[0x21, 0x04])?; // capability
    out.extend(&status.to_le_bytes())?;
    out.extend(&[0x01, 0xc0])?; // association id
    out.push_ie(0x01, &[0x82, 0x84, 0x8b, 0x96])
}

#[cfg(test)]
mod tests {
    use super::*;

    const AP: Mac = [0x02, 0, 0, 0, 0, 0xa0];
    const STA: Mac = [0x02, 0, 0, 0, 0, 0x01];

    #[test]
    fn sta_reaches_associated() {
        let mut sta = StaMlme::new();
        let mut out: Buf<256> = Buf::new();
        sta.connect(AP, STA, &mut out).unwrap();
        assert_eq!(sta.state, StaState::Authenticating);
        sta.on_mgmt(subtype::AUTH, AP, 0, STA, &mut out).unwrap();
        assert_eq!(sta.state, StaState::Associating);
        sta.on_mgmt(subtype::ASSOC_RESP, AP, 0, STA, &mut out).unwrap();
        assert!(sta.is_associated());
        // a deauth drops us back.
        sta.on_mgmt(subtype::DEAUTH, AP, 0, STA, &mut out).unwrap();
        assert_eq!(sta.state, StaState::Idle);
    }

    #[test]
    fn ap_auth_then_assoc() {
        let mut ap: ApMlme<4> = ApMlme::new(AP);
        let mut out: Buf<256> = Buf::new();
        assert!(ap.on_mgmt(subtype::ASSOC_REQ, STA, &mut out).unwrap() == false); // no auth yet
        assert!(ap.on_mgmt(subtype::AUTH, STA, &mut out).unwrap());
        assert_eq!(ap.station_count(), 1);
        assert!(ap.on_mgmt(subtype::ASSOC_REQ, STA, &mut out).unwrap());
        assert!(ap.is_associated(&STA));
    }

    #[test]
    fn ap_station_table_is_bounded() {
        let mut ap: ApMlme<2> = ApMlme::new(AP);
        let mut out: Buf<256> = Buf::new();
        assert!(ap.on_mgmt(subtype::AUTH, [0x02, 0, 0, 0, 0, 1], &mut out).unwrap());
        assert!(ap.on_mgmt(subtype::AUTH, [0x02, 0, 0, 0, 0, 2], &mut out).unwrap());
        // table full (N=2): a third auth is refused, not allocated.
        assert!(!ap.on_mgmt(subtype::AUTH, [0x02, 0, 0, 0, 0, 3], &mut out).unwrap());
        assert_eq!(ap.station_count(), 2);
    }
}
