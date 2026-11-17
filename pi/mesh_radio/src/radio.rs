//! Raw 802.11 radios on Linux: the ways a Pi can put a Splanc mesh frame on the air and get
//! one back (docs/design/mesh-pi-transport.md §2). [`crate::WifiBackhaul`] runs over any.
//!
//! | radio | TX | RX | needs |
//! |---|---|---|---|
//! | [`Monitor`] | radiotap injection on a monitor vif | AF_PACKET, radiotap RSSI + TSF | a mac80211 USB adapter (or nexmon) |
//! | [`Nl80211Mgmt`] | NL80211_CMD_FRAME | REGISTER_FRAME | mac80211 driver; category 4/9 only (cfg80211 refuses 127 from a station) |
//! | [`BrcmActframe`] | brcmfmac vendor DCMD, `actframe` iovar | REGISTER_FRAME (firmware decides) | the Pi's own radio, stock firmware |

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::time::Instant;

use crate::frame::{self, Category};
use crate::nl80211::Nl80211;
use crate::{radiotap, sys};

/// One received 802.11 frame (no FCS).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RawRx {
    pub len: usize,
    pub rssi_dbm: Option<i8>,
    /// Host receive time (µs since the radio opened), or the radio's TSF when it has one.
    pub rx_us: i64,
}

/// A radio that sends and receives whole 802.11 frames (header included, no FCS).
pub trait RawRadio {
    /// The radio's own MAC (A2 of what it sends).
    fn mac(&self) -> [u8; 6];
    /// Transmit one frame. Errors are the radio refusing it (a full queue is `WouldBlock`).
    fn send(&mut self, frame: &[u8]) -> io::Result<()>;
    /// The next received Splanc frame, without blocking. Radios may hand over other frames;
    /// the backhaul filters.
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>>;
    /// TX results the radio learned (acked, not acked) since the last call; (0, 0) when it
    /// cannot tell.
    fn take_tx_status(&mut self) -> (u32, u32) {
        (0, 0)
    }
}

fn now_us(t0: Instant) -> i64 {
    t0.elapsed().as_micros() as i64
}

/// Monitor-mode radio: injection and capture on an AF_PACKET socket bound to a monitor vif.
/// For mac80211 USB adapters (mt7921u, mt76x2u, ath9k_htc, rtl8xxxu, ...) and nexmon.
/// The managed vif can stay associated on the same channel when the driver allows both.
pub struct Monitor {
    fd: OwnedFd,
    mac: [u8; 6],
    rate_kbps: u32,
    t0: Instant,
    buf: Vec<u8>,
}

impl Monitor {
    /// `ifname` is a monitor interface (`iw phy phyN interface add mon0 type monitor`); `mac`
    /// is what we put in A2 (the managed vif's, or a locally administered one).
    pub fn open(ifname: &str, mac: [u8; 6], rate_kbps: u32) -> io::Result<Monitor> {
        let proto = sys::ETH_P_ALL.to_be();
        let fd = sys::sock(sys::AF_PACKET, sys::SOCK_RAW, proto as i32)?;
        let ll = sys::sockaddr_ll {
            sll_family: sys::AF_PACKET as u16,
            sll_protocol: proto,
            sll_ifindex: sys::ifindex(ifname)? as i32,
            sll_hatype: 0,
            sll_pkttype: 0,
            sll_halen: 0,
            sll_addr: [0; 8],
        };
        sys::bind_raw(fd.as_raw_fd(), &ll)?;
        Ok(Monitor { fd, mac, rate_kbps, t0: Instant::now(), buf: vec![0; 4096] })
    }
}

impl RawRadio for Monitor {
    fn mac(&self) -> [u8; 6] {
        self.mac
    }
    fn send(&mut self, f: &[u8]) -> io::Result<()> {
        let unicast = f.len() > 4 && f[4] & 1 == 0;
        let h = radiotap::tx_header(self.rate_kbps, if unicast { 0 } else { radiotap::TXF_NOACK });
        let mut b = Vec::with_capacity(h.len() + f.len());
        b.extend_from_slice(&h);
        b.extend_from_slice(f);
        sys::send_raw(self.fd.as_raw_fd(), &b).map(|_| ())
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        loop {
            let Some(n) = sys::recv_raw(self.fd.as_raw_fd(), &mut self.buf, false)? else { return Ok(None) };
            let Some(i) = radiotap::parse(&self.buf[..n]) else { continue };
            if i.bad_fcs || i.frame_len > buf.len() {
                continue;
            }
            let f = &self.buf[i.hdr_len..i.hdr_len + i.frame_len];
            // Our own injected frames come back on the monitor socket: skip them.
            if frame::parse(f).is_none_or(|p| p.sa == self.mac) {
                continue;
            }
            buf[..f.len()].copy_from_slice(f);
            let rx_us = i.tsft_us.map(|t| t as i64).unwrap_or_else(|| now_us(self.t0));
            return Ok(Some(RawRx { len: f.len(), rssi_dbm: i.rssi_dbm, rx_us }));
        }
    }
}

/// Management-frame TX/RX through nl80211 on a managed interface (associated or not), no
/// monitor mode. cfg80211 (net/wireless/mlme.c, `cfg80211_mlme_mgmt_tx`) refuses any
/// non-Public action frame from a station unless it goes to its own AP, so this radio only
/// works with [`Category::PublicVendor`]. On brcmfmac the driver then refuses it too (p2p.c
/// "Unknown Frame"): use [`BrcmActframe`] there.
pub struct Nl80211Mgmt {
    nl: Nl80211,
    ifindex: u32,
    mac: [u8; 6],
    freq: Option<u32>,
    t0: Instant,
    acked: u32,
    unacked: u32,
}

impl Nl80211Mgmt {
    /// `freq`: transmit off-channel on this frequency (remain-on-channel); None = the
    /// interface's own channel (associated) .
    pub fn open(ifname: &str, cat: Category, freq: Option<u32>) -> io::Result<Nl80211Mgmt> {
        let ifindex = sys::ifindex(ifname)?;
        let mut nl = Nl80211::open()?;
        nl.register_action(ifindex, cat.prefix())?;
        Ok(Nl80211Mgmt { nl, ifindex, mac: sys::mac_of(ifname)?, freq, t0: Instant::now(), acked: 0, unacked: 0 })
    }
}

impl RawRadio for Nl80211Mgmt {
    fn mac(&self) -> [u8; 6] {
        self.mac
    }
    fn send(&mut self, f: &[u8]) -> io::Result<()> {
        let broadcast = f.len() > 4 && f[4] & 1 == 1;
        self.nl.tx_frame(self.ifindex, self.freq, f, broadcast).map(|_| ())
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        while let Some(e) = self.nl.poll_event()? {
            if let Some((_, ack)) = e.tx_status() {
                if ack { self.acked += 1 } else { self.unacked += 1 }
                continue;
            }
            let Some(r) = e.rx_frame() else { continue };
            if r.frame.len() > buf.len() {
                continue;
            }
            buf[..r.frame.len()].copy_from_slice(&r.frame);
            let rssi = r.rssi_dbm.filter(|&s| s != 0).map(|s| s.clamp(-128, 0) as i8);
            return Ok(Some(RawRx { len: r.frame.len(), rssi_dbm: rssi, rx_us: now_us(self.t0) }));
        }
        Ok(None)
    }
    fn take_tx_status(&mut self) -> (u32, u32) {
        let r = (self.acked, self.unacked);
        (self.acked, self.unacked) = (0, 0);
        r
    }
}

/// brcmfmac (the Pi's own CYW43430/43436/43455): TX through the driver's vendor command
/// (BROADCOM_OUI, BRCMF_VNDR_CMDS_DCMD) running the firmware's `actframe` iovar directly,
/// which bypasses both cfg80211's category check and the driver's P2P/GAS-only filter.
/// The firmware builds the 802.11 header (A1 = da, A2 = own MAC, A3 = the bssid we pass).
/// RX: an nl80211 registration; the firmware raises E_ACTION_FRAME_RX for what it chooses,
/// the driver rewrites A1 to our own MAC and reports no RSSI (p2p.c
/// `brcmf_p2p_notify_action_frame_rx`).
pub struct BrcmActframe {
    tx: Nl80211,
    rx: Nl80211,
    ifindex: u32,
    mac: [u8; 6],
    /// Channel number for the `actframe`.
    pub channel: u32,
    /// Off-channel dwell (ms) the firmware waits after TX; 0 on our own channel.
    pub dwell_ms: u32,
    t0: Instant,
    packet_id: u32,
}

pub const BROADCOM_OUI: u32 = 0x001018;
pub const BRCMF_VNDR_CMDS_DCMD: u32 = 1;
pub const BRCMF_C_SET_VAR: u32 = 263;
/// `BRCMF_FIL_ACTION_FRAME_SIZE`: the firmware's action-body limit.
pub const ACTFRAME_MAX_BODY: usize = 1800;

const EBADE: i32 = 52;

/// 802.11 channel number of a frequency (2.4 and 5 GHz).
pub fn freq_to_channel(mhz: u32) -> Option<u32> {
    match mhz {
        2484 => Some(14),
        2412..=2472 => Some((mhz - 2407) / 5),
        5000..=5900 => Some((mhz - 5000) / 5),
        _ => None,
    }
}

/// The DCMD for `actframe`: `brcmf_vndr_dcmd_hdr` + "actframe\0" + `brcmf_fil_af_params_le`.
/// `body` is the action body (from the category byte on).
pub fn brcm_actframe_dcmd(channel: u32, dwell_ms: u32, da: [u8; 6], bssid: [u8; 6], packet_id: u32, body: &[u8]) -> Vec<u8> {
    assert!(body.len() <= ACTFRAME_MAX_BODY);
    let mut p = Vec::with_capacity(16 + 12 + ACTFRAME_MAX_BODY);
    p.extend_from_slice(&channel.to_le_bytes());
    p.extend_from_slice(&dwell_ms.to_le_bytes());
    p.extend_from_slice(&bssid);
    p.extend_from_slice(&[0, 0]);
    p.extend_from_slice(&da);
    p.extend_from_slice(&(body.len() as u16).to_le_bytes());
    p.extend_from_slice(&packet_id.to_le_bytes());
    p.extend_from_slice(body);
    p.resize(16 + 12 + ACTFRAME_MAX_BODY, 0);
    let mut iovar = b"actframe\0".to_vec();
    iovar.extend_from_slice(&p);
    // The handler passes `len` (not the input length) to the firmware set: it must cover
    // the whole iovar buffer.
    let mut d = Vec::with_capacity(20 + iovar.len());
    d.extend_from_slice(&BRCMF_C_SET_VAR.to_ne_bytes());
    d.extend_from_slice(&(iovar.len() as i32).to_ne_bytes());
    d.extend_from_slice(&20u32.to_ne_bytes()); // offset of the buffer
    d.extend_from_slice(&1u32.to_ne_bytes()); // set
    d.extend_from_slice(&0u32.to_ne_bytes()); // magic (unchecked)
    d.extend_from_slice(&iovar);
    d
}

impl BrcmActframe {
    /// `channel` 0 means the interface's current channel, looked up here: passing 0 to the
    /// firmware itself delivered 1-18 % of frames on the bench, an explicit channel 93-99 %
    /// (docs/design/mesh-pi-transport.md §4).
    pub fn open(ifname: &str, cat: Category, channel: u32, dwell_ms: u32) -> io::Result<BrcmActframe> {
        let ifindex = sys::ifindex(ifname)?;
        let mut rx = Nl80211::open()?;
        rx.register_action(ifindex, cat.prefix())?;
        let channel = match channel {
            0 => rx.interface(ifindex)?.2.and_then(freq_to_channel).unwrap_or(0),
            c => c,
        };
        Ok(BrcmActframe {
            tx: Nl80211::open()?,
            rx,
            ifindex,
            mac: sys::mac_of(ifname)?,
            channel,
            dwell_ms,
            t0: Instant::now(),
            packet_id: 0,
        })
    }
}

impl RawRadio for BrcmActframe {
    fn mac(&self) -> [u8; 6] {
        self.mac
    }
    fn send(&mut self, f: &[u8]) -> io::Result<()> {
        if f.len() < frame::HDR_LEN + 1 {
            return Err(io::Error::from(io::ErrorKind::InvalidInput));
        }
        let mut da = [0u8; 6];
        da.copy_from_slice(&f[4..10]);
        let mut bssid = [0u8; 6];
        bssid.copy_from_slice(&f[16..22]);
        self.packet_id = self.packet_id.wrapping_add(1);
        let d = brcm_actframe_dcmd(self.channel, self.dwell_ms, da, bssid, self.packet_id, &f[frame::HDR_LEN..]);
        match self.tx.vendor(self.ifindex, BROADCOM_OUI, BRCMF_VNDR_CMDS_DCMD, &d) {
            Ok(_) => Ok(()),
            // -EBADE: the firmware still has the previous action frame in flight (one at a
            // time; ~300 frames/s back to back on a Pi 3B+). Back-pressure, not a fault.
            Err(e) if e.raw_os_error() == Some(EBADE) => Err(io::Error::from(io::ErrorKind::WouldBlock)),
            Err(e) => Err(e),
        }
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        while let Some(e) = self.rx.poll_event()? {
            let Some(r) = e.rx_frame() else { continue };
            if r.frame.len() > buf.len() {
                continue;
            }
            buf[..r.frame.len()].copy_from_slice(&r.frame);
            let rssi = r.rssi_dbm.filter(|&s| s != 0).map(|s| s.clamp(-128, 0) as i8);
            return Ok(Some(RawRx { len: r.frame.len(), rssi_dbm: rssi, rx_us: now_us(self.t0) }));
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channels() {
        assert_eq!(freq_to_channel(2412), Some(1));
        assert_eq!(freq_to_channel(2462), Some(11));
        assert_eq!(freq_to_channel(2484), Some(14));
        assert_eq!(freq_to_channel(5200), Some(40));
        assert_eq!(freq_to_channel(60_480), None);
    }

    #[test]
    fn actframe_dcmd_layout() {
        let da = [0xff; 6];
        let d = brcm_actframe_dcmd(6, 0, da, [0xff; 6], 7, &[0x7f, 0x0a, 0x5c, 0x4d, 1, 0xaa]);
        let iov_len = 9 + 16 + 12 + ACTFRAME_MAX_BODY;
        assert_eq!(d.len(), 20 + iov_len);
        assert_eq!(u32::from_ne_bytes(d[0..4].try_into().unwrap()), BRCMF_C_SET_VAR);
        assert_eq!(i32::from_ne_bytes(d[4..8].try_into().unwrap()) as usize, iov_len);
        assert_eq!(&d[20..29], b"actframe\0");
        let p = &d[29..];
        assert_eq!(u32::from_le_bytes(p[0..4].try_into().unwrap()), 6); // channel
        assert_eq!(&p[16..22], &da); // action_frame.da at offset 16
        assert_eq!(u16::from_le_bytes([p[22], p[23]]), 6); // len
        assert_eq!(u32::from_le_bytes(p[24..28].try_into().unwrap()), 7); // packet id
        assert_eq!(&p[28..34], &[0x7f, 0x0a, 0x5c, 0x4d, 1, 0xaa]);
    }
}

impl RawRadio for Box<dyn RawRadio> {
    fn mac(&self) -> [u8; 6] {
        (**self).mac()
    }
    fn send(&mut self, frame: &[u8]) -> io::Result<()> {
        (**self).send(frame)
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        (**self).recv(buf)
    }
    fn take_tx_status(&mut self) -> (u32, u32) {
        (**self).take_tx_status()
    }
}
