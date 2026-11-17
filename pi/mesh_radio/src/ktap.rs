//! RSSI and TX status from brcmfmac without a kernel patch: tracefs kprobes on the driver's
//! own event handlers (docs/design/mesh-pi-transport.md §2.1).
//!
//! On SDIO the firmware's events arrive on the bus's event channel and the driver consumes
//! them (sdio.c → `brcmf_rx_event`), so no packet socket sees them; the driver then drops
//! the RSSI on the way to nl80211 (p2p.c passes signal 0) and never reports TX status for
//! frames it did not send itself. Both values are still in the handlers' arguments:
//!
//! - `brcmf_p2p_notify_action_frame_rx(ifp, e, data)`: `data` is `brcmf_rx_mgmt_data`
//!   (be16 version, be16 chanspec, **be32 rssi**, be32 mactime, be32 rate) then the body;
//! - `brcmf_p2p_notify_action_tx_complete(ifp, e, data)`: `e->status` is SUCCESS (0) or
//!   NO_ACK (5) — called for every ACTION_FRAME_COMPLETE, including our `actframe`s.
//!
//! A kprobe on each, fetching those fields, is written to `kprobe_events` and enabled in a
//! private tracefs instance (`instances/pimesh`, trace clock `mono`, so timestamps share
//! `Instant`'s CLOCK_MONOTONIC). Needs root, CONFIG_KPROBE_EVENTS (NixOS and Raspberry Pi
//! OS kernels have it) and the brcmfmac symbols in kallsyms. Everything is removed on drop.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;

const TRACEFS: &str = "/sys/kernel/tracing";
const INST: &str = "/sys/kernel/tracing/instances/pimesh";
const O_NONBLOCK: i32 = 0o4000;

/// `brcmf_event_msg` (host order): status at +8, addr at +24.
pub const PROBES: [&str; 2] = [
    "p:pimesh/afrx brcmf_p2p_notify_action_frame_rx cs=+2($arg3):u16 rssi=+4($arg3):u32 mt=+8($arg3):u32 a0=+24($arg2):u32 a1=+28($arg2):u16 len=+20($arg2):u32 b=+16($arg3):x32[64]",
    "p:pimesh/aftx brcmf_p2p_notify_action_tx_complete code=+4($arg2):u32 st=+8($arg2):u32",
];

/// The longest action body the tap carries whole (6 bytes of Splanc prefix + a 250-byte
/// mesh frame).
pub const MAX_BODY: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rec {
    /// A received action frame: RSSI, firmware µs clock, control channel, sender, and the
    /// action body (up to [`MAX_BODY`] bytes: a kprobe array holds 64 words).
    Rx { ts_us: i64, rssi_dbm: i32, mactime_us: u32, channel: u8, sa: [u8; 6], body: Vec<u8> },
    /// ACTION_FRAME_COMPLETE (60) or OFF_CHAN_COMPLETE (70), status 0 = ACK/sent, 5 = no ACK.
    TxDone { ts_us: i64, code: u32, status: u32 },
}

fn field(line: &str, key: &str) -> Option<u64> {
    let i = line.find(&format!(" {key}="))? + key.len() + 2;
    let v = line[i..].split_whitespace().next()?;
    match v.strip_prefix("0x") {
        Some(h) => u64::from_str_radix(h, 16).ok(),
        None => v.parse().ok(),
    }
}

/// Parse one trace_pipe line, e.g.
/// `  kworker/0:1-123 [000] ..... 1234.567890: afrx: (brcmf_p2p_notify_action_frame_rx+0x0/0x3b0 [brcmfmac]) cs=0x1001 rssi=0xd1ffffff ...`
pub fn parse_line(line: &str) -> Option<Rec> {
    let colon = line.find(": aftx:").or_else(|| line.find(": afrx:"))?;
    let ts = line[..colon].rsplit(' ').next()?;
    let (s, us) = ts.split_once('.')?;
    let ts_us = s.parse::<i64>().ok()? * 1_000_000 + format!("{us:0<6}")[..6].parse::<i64>().ok()?;
    if line[colon..].starts_with(": aftx:") {
        return Some(Rec::TxDone { ts_us, code: field(line, "code")? as u32, status: field(line, "st")? as u32 });
    }
    // Big-endian fields read as host (little-endian) u32: swap back.
    let rssi = (field(line, "rssi")? as u32).swap_bytes() as i32;
    let mt = (field(line, "mt")? as u32).swap_bytes();
    let cs = (field(line, "cs")? as u16).swap_bytes();
    let mut sa = [0u8; 6];
    sa[..4].copy_from_slice(&(field(line, "a0")? as u32).to_le_bytes());
    sa[4..].copy_from_slice(&(field(line, "a1")? as u16).to_le_bytes());
    // datalen counts the 16-byte brcmf_rx_mgmt_data in front of the body.
    let len = (field(line, "len")? as usize).saturating_sub(16).min(MAX_BODY);
    let i = line.find(" b={")? + 4;
    let words = &line[i..i + line[i..].find('}')?];
    let mut body = Vec::with_capacity(MAX_BODY);
    for w in words.split(',') {
        let w = w.trim();
        let v = match w.strip_prefix("0x") {
            Some(h) => u32::from_str_radix(h, 16).ok()?,
            None => w.parse().ok()?,
        };
        body.extend_from_slice(&v.to_le_bytes());
    }
    body.truncate(len);
    Some(Rec::Rx { ts_us, rssi_dbm: rssi, mactime_us: mt, channel: (cs & 0xff) as u8, sa, body })
}

pub struct KprobeTap {
    pipe: Option<File>,
    buf: Vec<u8>,
    partial: String,
}

fn write(path: &str, s: &str, append: bool) -> io::Result<()> {
    let mut f = OpenOptions::new().write(true).append(append).truncate(!append).open(path)?;
    f.write_all(s.as_bytes())
}

impl KprobeTap {
    pub fn open() -> io::Result<KprobeTap> {
        let _ = Self::cleanup();
        for p in PROBES {
            write(&format!("{TRACEFS}/kprobe_events"), &format!("{p}\n"), true)
                .map_err(|e| io::Error::new(e.kind(), format!("kprobe_events ({p:.40}...): {e}")))?;
        }
        fs::create_dir_all(INST)?;
        write(&format!("{INST}/trace_clock"), "mono", false)?;
        write(&format!("{INST}/buffer_size_kb"), "1024", false)?;
        for n in ["afrx", "aftx"] {
            write(&format!("{INST}/events/pimesh/{n}/enable"), "1", false)?;
        }
        let pipe = OpenOptions::new().read(true).custom_flags(O_NONBLOCK).open(format!("{INST}/trace_pipe"))?;
        Ok(KprobeTap { pipe: Some(pipe), buf: vec![0; 1 << 16], partial: String::new() })
    }

    /// Everything traced since the last call.
    pub fn drain(&mut self, out: &mut Vec<Rec>) -> io::Result<()> {
        let Some(pipe) = self.pipe.as_mut() else { return Ok(()) };
        loop {
            match pipe.read(&mut self.buf) {
                Ok(0) => return Ok(()),
                Ok(n) => {
                    self.partial.push_str(&String::from_utf8_lossy(&self.buf[..n]));
                    while let Some(i) = self.partial.find('\n') {
                        let line: String = self.partial.drain(..=i).collect();
                        out.extend(parse_line(&line));
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    }

    fn cleanup() -> io::Result<()> {
        for n in ["afrx", "aftx"] {
            let _ = write(&format!("{INST}/events/pimesh/{n}/enable"), "0", false);
        }
        let _ = fs::remove_dir(INST);
        for n in ["afrx", "aftx"] {
            let _ = write(&format!("{TRACEFS}/kprobe_events"), &format!("-:pimesh/{n}\n"), true);
        }
        Ok(())
    }
}

impl Drop for KprobeTap {
    fn drop(&mut self) {
        // The instance cannot be removed while its trace_pipe is open.
        self.pipe = None;
        let _ = Self::cleanup();
    }
}

/// Monotonic clock (µs), the tap's `mono` trace clock.
pub use crate::sys::mono_us;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_trace_lines() {
        let words: Vec<String> = std::iter::once("0x5c0a0904".to_string())
            .chain(std::iter::once("0x5250014d".into()))
            .chain((0..62).map(|_| "0x0".to_string()))
            .collect();
        let rx = format!("  kworker/u8:2-77 [001] ...1. 98765.432101: afrx: (brcmf_p2p_notify_action_frame_rx+0x0/0x3b0 [brcmfmac]) cs=0x110 rssi=0xd1ffffff mt=0x40e20100 a0=0xeb27b8 a1=0x40e0 len=25 b={{{}}}", words.join(","));
        match parse_line(&rx).unwrap() {
            Rec::Rx { ts_us, rssi_dbm, mactime_us, channel, sa, body } => {
                assert_eq!(ts_us, 98_765_432_101);
                assert_eq!(rssi_dbm, -47);
                assert_eq!(mactime_us, 0x0001e240);
                assert_eq!(channel, 1);
                assert_eq!(sa, [0xb8, 0x27, 0xeb, 0x00, 0xe0, 0x40]);
                assert_eq!(body.len(), 9);
                assert_eq!(&body[..8], &[4, 9, 0x0a, 0x5c, 0x4d, 1, 0x50, 0x52]);
            }
            r => panic!("{r:?}"),
        }
        let tx = "  kworker/0:2-12 [000] ..... 98765.5: aftx: (brcmf_p2p_notify_action_tx_complete+0x0/0x90 [brcmfmac]) code=0x3c st=0x5";
        assert_eq!(parse_line(tx), Some(Rec::TxDone { ts_us: 98_765_500_000, code: 60, status: 5 }));
        assert_eq!(parse_line("# tracer: nop"), None);
    }
}
