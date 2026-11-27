//! Raw 802.11 radios on Linux: the ways a Pi can put a Splanc mesh frame on the air and get
//! one back (docs/design/mesh-pi-transport.md §2). [`crate::WifiBackhaul`] runs over any.
//!
//! | radio | TX | RX | needs |
//! |---|---|---|---|
//! | [`Monitor`] | radiotap injection on a monitor vif | AF_PACKET, radiotap RSSI + TSF | a mac80211 USB adapter (or nexmon) |
//! | [`Nl80211Mgmt`] | NL80211_CMD_FRAME | REGISTER_FRAME | mac80211 driver; category 4/9 only (cfg80211 refuses 127 from a station) |
//! | [`BrcmActframe`] | brcmfmac vendor DCMD, `actframe` iovar | REGISTER_FRAME (firmware decides) | the Pi's own radio, stock firmware |
//!
//! [`auto_via`] picks between the last two on a Pi: [`Nl80211Mgmt`] when the loaded brcmfmac
//! is the image's patched one (pi/provisioning/nix/brcmfmac-actframe.nix), else
//! [`BrcmActframe`] with the kprobe tap.

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
    /// Per-send records the radio kept (brcmfmac: call time, CPU, completion, ACK).
    fn take_tx_log(&mut self) -> Vec<TxRecord> {
        Vec::new()
    }
    /// The unicast sends whose outcome the radio learned since the last call, as
    /// (destination MAC, acked): what a backhaul's per-neighbour delivery rate is made of.
    /// Radios that cannot tell add nothing.
    fn take_tx_results(&mut self, _out: &mut Vec<([u8; 6], bool)>) {}
    /// Re-read the interface's channel (the AP may have moved). Called now and then by a
    /// long-running node; radios with nothing to re-read ignore it.
    fn retune(&mut self) {}
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

/// The raw radio for a managed interface: what `pimesh --via auto` uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    /// [`Nl80211Mgmt`]: plain `NL80211_CMD_FRAME` + registration.
    Nl80211,
    /// [`BrcmActframe`]: firmware passthrough + the kprobe tap.
    Brcm,
}

/// The patched brcmfmac's source version, written by the Pi image
/// (pi/provisioning/nix/brcmfmac-actframe.nix).
pub const BRCMFMAC_ACTFRAME_SRCVERSION: &str = "/etc/splanc/brcmfmac-actframe.srcversion";

/// Pick the radio from the interface's driver and brcmfmac's source versions: the loaded
/// module's (`/sys/module/brcmfmac/srcversion`) and the patched one the image carries.
/// mac80211 drivers send and receive Public Action through nl80211 as they are. brcmfmac
/// drops it ("Unknown Frame") and reports no RSSI unless it is the patched module, so it
/// gets nl80211 only when the two versions match: a stock kernel, or a patched module that
/// did not load, keeps the passthrough + tap.
pub fn choose_via(driver: &str, loaded_srcversion: Option<&str>, patched_srcversion: Option<&str>) -> Via {
    if driver != "brcmfmac" {
        return Via::Nl80211;
    }
    match (loaded_srcversion.map(str::trim), patched_srcversion.map(str::trim)) {
        (Some(l), Some(p)) if !l.is_empty() && l == p => Via::Nl80211,
        _ => Via::Brcm,
    }
}

/// [`choose_via`] for `ifname` on this host.
pub fn auto_via(ifname: &str) -> Via {
    let driver = std::fs::read_link(format!("/sys/class/net/{ifname}/device/driver"))
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let loaded = std::fs::read_to_string("/sys/module/brcmfmac/srcversion").ok();
    let patched = std::fs::read_to_string(BRCMFMAC_ACTFRAME_SRCVERSION).ok();
    choose_via(&driver, loaded.as_deref(), patched.as_deref())
}

/// Management-frame TX/RX through nl80211 on a managed interface (associated or not), no
/// monitor mode. cfg80211 (net/wireless/mlme.c, `cfg80211_mlme_mgmt_tx`) refuses any
/// non-Public action frame from a station unless it goes to its own AP, so this radio only
/// works with [`Category::PublicVendor`]. Stock brcmfmac then refuses it too (p2p.c
/// "Unknown Frame") and reports no RSSI: use [`BrcmActframe`] there. The Pi images carry a
/// patched brcmfmac that sends it with a real ACK status and reports RSSI ([`auto_via`]).
pub struct Nl80211Mgmt {
    nl: Nl80211,
    ifindex: u32,
    mac: [u8; 6],
    freq: Option<u32>,
    t0: Instant,
    acked: u32,
    unacked: u32,
    /// Unicast sends awaiting their TX status: (cookie, destination), oldest first.
    cookies: std::collections::VecDeque<(u64, [u8; 6])>,
    results: Vec<([u8; 6], bool)>,
}

impl Nl80211Mgmt {
    /// `freq`: transmit off-channel on this frequency (remain-on-channel); None = the
    /// interface's own channel (associated) .
    pub fn open(ifname: &str, cat: Category, freq: Option<u32>) -> io::Result<Nl80211Mgmt> {
        let ifindex = sys::ifindex(ifname)?;
        let mut nl = Nl80211::open()?;
        nl.register_action(ifindex, cat.prefix())?;
        Ok(Nl80211Mgmt {
            nl,
            ifindex,
            mac: sys::mac_of(ifname)?,
            freq,
            t0: Instant::now(),
            acked: 0,
            unacked: 0,
            cookies: Default::default(),
            results: Vec::new(),
        })
    }
}

impl RawRadio for Nl80211Mgmt {
    fn mac(&self) -> [u8; 6] {
        self.mac
    }
    fn send(&mut self, f: &[u8]) -> io::Result<()> {
        let broadcast = f.len() > 4 && f[4] & 1 == 1;
        let cookie = self.nl.tx_frame(self.ifindex, self.freq, f, broadcast)?;
        if let (Some(c), false) = (cookie, broadcast) {
            let mut da = [0u8; 6];
            da.copy_from_slice(&f[4..10]);
            if self.cookies.len() >= 64 {
                self.cookies.pop_front();
            }
            self.cookies.push_back((c, da));
        }
        Ok(())
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        while let Some(e) = self.nl.poll_event()? {
            if let Some((cookie, ack)) = e.tx_status() {
                if ack { self.acked += 1 } else { self.unacked += 1 }
                if let Some(i) = self.cookies.iter().position(|&(c, _)| c == cookie) {
                    let (_, da) = self.cookies.remove(i).unwrap();
                    self.results.push((da, ack));
                }
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
    fn take_tx_results(&mut self, out: &mut Vec<([u8; 6], bool)>) {
        out.append(&mut self.results);
    }
}

/// brcmfmac (the Pi's own CYW43430/43436/43455): TX through the driver's vendor command
/// (BROADCOM_OUI, BRCMF_VNDR_CMDS_DCMD) running the firmware's `actframe` iovar directly,
/// which bypasses both cfg80211's category check and the driver's P2P/GAS-only filter.
/// The firmware builds the 802.11 header (A1 = da, A2 = own MAC, A3 = the bssid we pass).
///
/// RX is an nl80211 registration. With [`BrcmRx::Tap`], kprobes on the driver's event
/// handlers ([`crate::ktap`]) add what the driver drops: the RSSI and the firmware's µs
/// receive time of each frame, and the ACK status (ACTION_FRAME_COMPLETE) of each send.
pub struct BrcmActframe {
    tx: Nl80211,
    rx: Nl80211,
    /// We hold the nl80211 registration (else the tap's whole frames are the RX path).
    registered: bool,
    tap: Option<KprobeTap>,
    tap_rx: std::collections::VecDeque<Rec>,
    ifindex: u32,
    mac: [u8; 6],
    /// Channel number for the `actframe`.
    pub channel: u32,
    /// Off-channel dwell (ms) the firmware waits after TX; 0 on our own channel.
    pub dwell_ms: u32,
    t0: Instant,
    packet_id: u32,
    /// Sends awaiting their ACTION_FRAME_COMPLETE, oldest first (the firmware takes one at
    /// a time, so completions arrive in order).
    in_flight: std::collections::VecDeque<TxRecord>,
    /// Completed sends, for callers that log them (`take_tx_log`); bounded.
    pub tx_log: Vec<TxRecord>,
    acked: u32,
    unacked: u32,
    recs: Vec<Rec>,
    results: Vec<([u8; 6], bool)>,
}

/// How [`BrcmActframe`] learns RSSI and TX status.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrcmRx {
    /// nl80211 plus the kprobe tap: RSSI, firmware timestamps, ACK status.
    Tap,
    /// nl80211 registration only (no RSSI, no TX status).
    Nl80211,
}

/// One `actframe` send.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TxRecord {
    pub packet_id: u32,
    /// CLOCK_MONOTONIC (µs) when the call started.
    pub start_us: i64,
    /// Wall time of the vendor-command round trip.
    pub call_us: u32,
    /// CPU time this thread spent in it.
    pub cpu_us: u32,
    /// From the call's start to ACTION_FRAME_COMPLETE (0 if none came).
    pub complete_us: u32,
    /// Event status: 0 = sent (unicast: ACKed), 5 = no ACK; u32::MAX = no event.
    pub status: u32,
    /// The frame's destination (A1).
    pub da: [u8; 6],
}

pub const BROADCOM_OUI: u32 = 0x001018;
pub const BRCMF_VNDR_CMDS_DCMD: u32 = 1;
pub const BRCMF_C_GET_VAR: u32 = 262;
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
    brcm_actframe_dcmd_ext(channel, dwell_ms, da, bssid, packet_id, body, true)
}

/// As [`brcm_actframe_dcmd`]; `pad = false` sends only the bytes used instead of the
/// struct's full 1800-byte body.
pub fn brcm_actframe_dcmd_ext(channel: u32, dwell_ms: u32, da: [u8; 6], bssid: [u8; 6], packet_id: u32, body: &[u8], pad: bool) -> Vec<u8> {
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
    if pad {
        p.resize(16 + 12 + ACTFRAME_MAX_BODY, 0);
    }
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
    pub fn open(ifname: &str, cat: Category, channel: u32, dwell_ms: u32, rx: BrcmRx) -> io::Result<BrcmActframe> {
        let ifindex = sys::ifindex(ifname)?;
        let mut tx = Nl80211::open()?;
        let channel = match channel {
            0 => tx.interface(ifindex)?.2.and_then(freq_to_channel).unwrap_or(0),
            c => c,
        };
        let mut nl = Nl80211::open()?;
        // In AP mode hostapd/wpa_supplicant hold every action registration (EALREADY); so
        // does a second process on the same prefix. The tap then carries whole frames.
        let registered = match nl.register_action(ifindex, cat.prefix()) {
            Ok(()) => true,
            Err(e) if e.raw_os_error() == Some(114) && rx == BrcmRx::Tap => false,
            Err(e) => return Err(e),
        };
        let tap = match rx {
            BrcmRx::Tap => match KprobeTap::open() {
                Ok(t) => Some(t),
                Err(e) => {
                    eprintln!("mesh_radio: no kprobe tap ({e}); RSSI and TX status unavailable");
                    None
                }
            },
            BrcmRx::Nl80211 => None,
        };
        if !registered && tap.is_none() {
            return Err(io::Error::other("action frames already registered and no kprobe tap"));
        }
        Ok(BrcmActframe {
            tx,
            rx: nl,
            registered,
            tap,
            tap_rx: Default::default(),
            ifindex,
            mac: sys::mac_of(ifname)?,
            channel,
            dwell_ms,
            t0: Instant::now(),
            packet_id: 0,
            in_flight: Default::default(),
            tx_log: Vec::new(),
            acked: 0,
            unacked: 0,
            recs: Vec::new(),
            results: Vec::new(),
        })
    }

    /// Run a firmware ioctl (`set`) or get through the DCMD; returns the reply bytes.
    pub fn dcmd(&mut self, cmd: u32, set: bool, buf: &[u8], reply_len: usize) -> io::Result<Vec<u8>> {
        let len = if set { buf.len() } else { reply_len.max(buf.len()) };
        let mut d = Vec::with_capacity(20 + buf.len());
        d.extend_from_slice(&cmd.to_ne_bytes());
        d.extend_from_slice(&(len as i32).to_ne_bytes());
        d.extend_from_slice(&20u32.to_ne_bytes());
        d.extend_from_slice(&(set as u32).to_ne_bytes());
        d.extend_from_slice(&0u32.to_ne_bytes());
        d.extend_from_slice(buf);
        Ok(self.tx.vendor(self.ifindex, BROADCOM_OUI, BRCMF_VNDR_CMDS_DCMD, &d)?.concat())
    }

    /// Get an iovar by name (`counters`, `ver`, ...).
    pub fn iovar_get(&mut self, name: &str, reply_len: usize) -> io::Result<Vec<u8>> {
        let mut b = name.as_bytes().to_vec();
        b.push(0);
        self.dcmd(BRCMF_C_GET_VAR, false, &b, reply_len)
    }

    /// Set an iovar by name.
    pub fn iovar_set(&mut self, name: &str, val: &[u8]) -> io::Result<()> {
        let mut b = name.as_bytes().to_vec();
        b.push(0);
        b.extend_from_slice(val);
        self.dcmd(BRCMF_C_SET_VAR, true, &b, 0).map(|_| ())
    }

    fn on_complete(&mut self, status: u32, ts_us: i64) {
        if let Some(mut r) = self.in_flight.pop_front() {
            r.complete_us = (ts_us - r.start_us).max(0) as u32;
            r.status = status;
            if r.da[0] & 1 == 0 && self.results.len() < 1024 {
                self.results.push((r.da, status == 0));
            }
            if self.tx_log.len() < 100_000 {
                self.tx_log.push(r);
            }
        }
        if status == 0 { self.acked += 1 } else { self.unacked += 1 }
    }

    /// Pull what the tap traced: completions settle sends, RX records wait for their frame.
    fn pump_tap(&mut self) {
        let Some(t) = self.tap.as_mut() else { return };
        let mut recs = std::mem::take(&mut self.recs);
        if t.drain(&mut recs).is_err() {
            self.tap = None;
        }
        for r in recs.drain(..) {
            match r {
                Rec::TxDone { ts_us, code: 60, status } => self.on_complete(status, ts_us),
                Rec::TxDone { .. } => {}
                rx @ Rec::Rx { .. } => {
                    if self.tap_rx.len() >= 256 {
                        self.tap_rx.pop_front();
                    }
                    self.tap_rx.push_back(rx);
                }
            }
        }
        self.recs = recs;
    }

    /// The traced RSSI and firmware time of a frame nl80211 delivered (matched on sender
    /// and body; older unmatched records are dropped).
    fn tap_meta(&mut self, f: &[u8]) -> Option<(i32, u32)> {
        let body = f.get(frame::HDR_LEN..)?;
        let k = body.len().min(MAX_BODY);
        let i = self.tap_rx.iter().position(|r| match r {
            Rec::Rx { sa, body: b, .. } => *sa == f[10..16] && b.len() >= k.min(b.len()) && b[..k.min(b.len())] == body[..k.min(b.len())],
            _ => false,
        })?;
        let r = self.tap_rx.drain(..=i).last()?;
        match r {
            Rec::Rx { rssi_dbm, mactime_us, .. } => Some((rssi_dbm, mactime_us)),
            _ => None,
        }
    }

    /// Sends whose completion never came within 1 s are logged with status u32::MAX.
    fn expire(&mut self) {
        let now = mono_us();
        while self.in_flight.front().is_some_and(|r| now - r.start_us > 1_000_000) {
            let r = self.in_flight.pop_front().unwrap();
            if self.tx_log.len() < 100_000 {
                self.tx_log.push(TxRecord { status: u32::MAX, ..r });
            }
        }
    }
}

use crate::ktap::{mono_us, KprobeTap, Rec, MAX_BODY};

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
        let pad = std::env::var_os("PIMESH_NOPAD").is_none();
        let d = brcm_actframe_dcmd_ext(self.channel, self.dwell_ms, da, bssid, self.packet_id, &f[frame::HDR_LEN..], pad);
        let (start, cpu0) = (mono_us(), sys::thread_cpu_us());
        let r = self.tx.vendor(self.ifindex, BROADCOM_OUI, BRCMF_VNDR_CMDS_DCMD, &d);
        let rec = TxRecord {
            packet_id: self.packet_id,
            start_us: start,
            call_us: (mono_us() - start) as u32,
            cpu_us: (sys::thread_cpu_us() - cpu0) as u32,
            complete_us: 0,
            status: u32::MAX,
            da,
        };
        match r {
            Ok(_) => {
                if self.tap.is_some() {
                    self.in_flight.push_back(rec);
                }
                Ok(())
            }
            // -EBADE: the firmware still has the previous action frame in flight (one at a
            // time; ~300 frames/s back to back on a Pi 3B+). Back-pressure, not a fault.
            Err(e) if e.raw_os_error() == Some(EBADE) => Err(io::Error::from(io::ErrorKind::WouldBlock)),
            Err(e) => Err(e),
        }
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        self.pump_tap();
        self.expire();
        if !self.registered {
            // Tap-only: rebuild the frame around the traced body (A1 reads as ours).
            while let Some(r) = self.tap_rx.pop_front() {
                let Rec::Rx { rssi_dbm, mactime_us, sa, body, .. } = r else { continue };
                let n = frame::HDR_LEN + body.len();
                if n > buf.len() {
                    continue;
                }
                buf[0..2].copy_from_slice(&frame::FC_ACTION);
                buf[2..4].fill(0);
                buf[4..10].copy_from_slice(&self.mac);
                buf[10..16].copy_from_slice(&sa);
                buf[16..22].copy_from_slice(&frame::BROADCAST);
                buf[22..24].fill(0);
                buf[frame::HDR_LEN..n].copy_from_slice(&body);
                let rssi = (-127..0).contains(&rssi_dbm).then_some(rssi_dbm as i8);
                return Ok(Some(RawRx { len: n, rssi_dbm: rssi, rx_us: mactime_us as i64 }));
            }
            return Ok(None);
        }
        while let Some(e) = self.rx.poll_event()? {
            let Some(r) = e.rx_frame() else { continue };
            if r.frame.len() > buf.len() {
                continue;
            }
            buf[..r.frame.len()].copy_from_slice(&r.frame);
            // The kprobe fired before the driver handed the frame to cfg80211.
            self.pump_tap();
            let (rssi, rx_us) = match self.tap_meta(&r.frame) {
                Some((rssi, mt)) => ((-127..0).contains(&rssi).then_some(rssi as i8), mt as i64),
                None => (None, now_us(self.t0)),
            };
            return Ok(Some(RawRx { len: r.frame.len(), rssi_dbm: rssi, rx_us }));
        }
        Ok(None)
    }
    fn take_tx_status(&mut self) -> (u32, u32) {
        let r = (self.acked, self.unacked);
        (self.acked, self.unacked) = (0, 0);
        r
    }
    fn take_tx_log(&mut self) -> Vec<TxRecord> {
        self.expire();
        std::mem::take(&mut self.tx_log)
    }
    fn take_tx_results(&mut self, out: &mut Vec<([u8; 6], bool)>) {
        out.append(&mut self.results);
    }
    fn retune(&mut self) {
        if let Ok((_, _, Some(f))) = self.tx.interface(self.ifindex) {
            if let Some(c) = freq_to_channel(f) {
                self.channel = c;
            }
        }
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
    fn take_tx_log(&mut self) -> Vec<TxRecord> {
        (**self).take_tx_log()
    }
    fn take_tx_results(&mut self, out: &mut Vec<([u8; 6], bool)>) {
        (**self).take_tx_results(out)
    }
    fn retune(&mut self) {
        (**self).retune()
    }
}

/// The interface's current channel (from its frequency), if it is on one.
pub fn iface_channel(ifname: &str) -> Option<u32> {
    let ifindex = sys::ifindex(ifname).ok()?;
    let mut nl = Nl80211::open().ok()?;
    nl.interface(ifindex).ok()?.2.and_then(freq_to_channel)
}

/// A radio on its own thread, so a node's loop never waits on it: the brcmfmac passthrough
/// is a 1-5 ms SDIO round trip per send, and the patched driver's plain nl80211 path sleeps
/// ~40 ms in the driver before each action frame (docs/design/mesh-pi-transport.md §2.1, §7).
/// `send` only queues (a full queue is `WouldBlock`, which the backhaul reports as
/// back-pressure); received frames, TX counters and per-destination results come back over
/// channels. The radio is opened on the thread (`open`), so it need not be `Send`.
pub struct ThreadedRadio {
    mac: [u8; 6],
    tx: std::sync::mpsc::SyncSender<Vec<u8>>,
    rx: std::sync::mpsc::Receiver<Up>,
    acked: u32,
    unacked: u32,
    results: Vec<([u8; 6], bool)>,
    /// Sends the thread refused or failed (after they were queued).
    pub tx_failed: std::sync::Arc<std::sync::atomic::AtomicU32>,
}

enum Up {
    Frame(Vec<u8>, RawRx),
    Status(u32, u32, Vec<([u8; 6], bool)>),
}

/// Frames a [`ThreadedRadio`] queues for the thread.
pub const THREAD_TXQ: usize = 8;
/// How often the thread re-reads the channel ([`RawRadio::retune`]).
pub const RETUNE_US: i64 = 10_000_000;

impl ThreadedRadio {
    pub fn spawn<R: RawRadio, F: FnOnce() -> io::Result<R> + Send + 'static>(open: F) -> io::Result<ThreadedRadio> {
        use std::sync::atomic::{AtomicU32, Ordering};
        use std::sync::{mpsc, Arc};
        let (tx, txr) = mpsc::sync_channel::<Vec<u8>>(THREAD_TXQ);
        let (upt, rx) = mpsc::sync_channel::<Up>(256);
        let (mact, macr) = mpsc::channel::<io::Result<[u8; 6]>>();
        let failed = Arc::new(AtomicU32::new(0));
        let failed_t = failed.clone();
        std::thread::Builder::new().name("mesh-radio".into()).spawn(move || {
            let mut r = match open() {
                Ok(r) => r,
                Err(e) => {
                    let _ = mact.send(Err(e));
                    return;
                }
            };
            let _ = mact.send(Ok(r.mac()));
            let mut buf = vec![0u8; 2400];
            let mut results = Vec::new();
            let mut retune_at = mono_us() + RETUNE_US;
            loop {
                let mut busy = false;
                loop {
                    match txr.try_recv() {
                        Ok(f) => {
                            busy = true;
                            if r.send(&f).is_err() {
                                failed_t.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Err(mpsc::TryRecvError::Empty) => break,
                        Err(mpsc::TryRecvError::Disconnected) => return,
                    }
                }
                while let Ok(Some(m)) = r.recv(&mut buf) {
                    busy = true;
                    if upt.try_send(Up::Frame(buf[..m.len].to_vec(), m)).is_err() {
                        break; // the node is behind: drop, as a radio queue would
                    }
                }
                let (a, u) = r.take_tx_status();
                r.take_tx_results(&mut results);
                if a + u > 0 || !results.is_empty() {
                    let _ = upt.try_send(Up::Status(a, u, std::mem::take(&mut results)));
                }
                if mono_us() >= retune_at {
                    r.retune();
                    retune_at = mono_us() + RETUNE_US;
                }
                if !busy {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
        })?;
        let mac = macr.recv().map_err(|_| io::Error::other("radio thread died"))??;
        Ok(ThreadedRadio { mac, tx, rx, acked: 0, unacked: 0, results: Vec::new(), tx_failed: failed })
    }
}

impl RawRadio for ThreadedRadio {
    fn mac(&self) -> [u8; 6] {
        self.mac
    }
    fn send(&mut self, f: &[u8]) -> io::Result<()> {
        match self.tx.try_send(f.to_vec()) {
            Ok(()) => Ok(()),
            Err(std::sync::mpsc::TrySendError::Full(_)) => Err(io::Error::from(io::ErrorKind::WouldBlock)),
            Err(std::sync::mpsc::TrySendError::Disconnected(_)) => Err(io::Error::other("radio thread stopped")),
        }
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        loop {
            match self.rx.try_recv() {
                Ok(Up::Frame(f, m)) => {
                    if f.len() > buf.len() {
                        continue;
                    }
                    buf[..f.len()].copy_from_slice(&f);
                    return Ok(Some(RawRx { len: f.len(), ..m }));
                }
                Ok(Up::Status(a, u, mut r)) => {
                    self.acked += a;
                    self.unacked += u;
                    self.results.append(&mut r);
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => return Ok(None),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => return Err(io::Error::other("radio thread stopped")),
            }
        }
    }
    fn take_tx_status(&mut self) -> (u32, u32) {
        let r = (self.acked, self.unacked);
        (self.acked, self.unacked) = (0, 0);
        r
    }
    fn take_tx_results(&mut self, out: &mut Vec<([u8; 6], bool)>) {
        out.append(&mut self.results);
    }
}
