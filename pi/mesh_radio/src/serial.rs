//! A USB-attached ESP32-C6 as the Pi's mesh radio (docs/design/mesh-pi-transport.md §2.3):
//! the C6 runs the netstack's 802.11 backhaul (M3) and passes whole Splanc 802.11 frames to
//! and from the Pi over its USB-Serial/JTAG CDC port. This is the host side and the wire
//! format; the C6 side is the M3 backhaul plus a ~150-line bridge task.
//!
//! Framing: SLIP (RFC 1055) — trivially resynchronising after a reset or a dropped byte,
//! and cheap on the C6. Each SLIP frame is one message:
//!
//! ```text
//! host → C6   0x01 TX        802.11 frame (no FCS)
//!             0x02 CHANNEL   u8 channel (the C6 stays associated if it is on that channel)
//! C6 → host   0x81 RX        i8 rssi, u32 LE rx timestamp (µs, C6 clock), 802.11 frame
//!             0x82 TX_DONE   u8 status (0 = sent/acked, 1 = no ack, 2 = dropped)
//!             0x83 HELLO     u8 version, 6 B MAC
//! ```

use std::collections::VecDeque;
use std::io::{self, Read, Write};

use crate::radio::{RawRadio, RawRx};

pub const END: u8 = 0xC0;
const ESC: u8 = 0xDB;
const ESC_END: u8 = 0xDC;
const ESC_ESC: u8 = 0xDD;

pub const MSG_TX: u8 = 0x01;
pub const MSG_CHANNEL: u8 = 0x02;
pub const MSG_RX: u8 = 0x81;
pub const MSG_TX_DONE: u8 = 0x82;
pub const MSG_HELLO: u8 = 0x83;

/// SLIP-encode `msg` into `out` (END before and after).
pub fn slip_encode(msg: &[u8], out: &mut Vec<u8>) {
    out.push(END);
    for &b in msg {
        match b {
            END => out.extend_from_slice(&[ESC, ESC_END]),
            ESC => out.extend_from_slice(&[ESC, ESC_ESC]),
            _ => out.push(b),
        }
    }
    out.push(END);
}

/// Incremental SLIP decoder.
#[derive(Default)]
pub struct SlipDecoder {
    cur: Vec<u8>,
    esc: bool,
    bad: bool,
    pub dropped: u32,
}

impl SlipDecoder {
    /// Feed bytes; complete messages go to `out`.
    pub fn feed(&mut self, bytes: &[u8], out: &mut VecDeque<Vec<u8>>) {
        for &b in bytes {
            match (self.esc, b) {
                (_, END) => {
                    if !self.cur.is_empty() && !self.bad {
                        out.push_back(std::mem::take(&mut self.cur));
                    } else if self.bad {
                        self.dropped += 1;
                    }
                    self.cur.clear();
                    self.esc = false;
                    self.bad = false;
                }
                (false, ESC) => self.esc = true,
                (true, ESC_END) => (self.cur.push(END), self.esc = false).1,
                (true, ESC_ESC) => (self.cur.push(ESC), self.esc = false).1,
                (true, _) => (self.bad = true, self.esc = false).1,
                (false, _) => {
                    if self.cur.len() < 4096 {
                        self.cur.push(b)
                    } else {
                        self.bad = true
                    }
                }
            }
        }
    }
}

/// The host side of the coprocessor link over any non-blocking byte stream (the CDC tty
/// opened O_NONBLOCK after `stty raw`, or a socket in tests).
pub struct SerialRadio<S: Read + Write> {
    io: S,
    mac: [u8; 6],
    dec: SlipDecoder,
    msgs: VecDeque<Vec<u8>>,
    acked: u32,
    unacked: u32,
    rbuf: [u8; 2048],
    wbuf: Vec<u8>,
}

impl<S: Read + Write> SerialRadio<S> {
    /// `mac`: the C6's MAC (from its HELLO, or configured).
    pub fn new(io: S, mac: [u8; 6]) -> SerialRadio<S> {
        SerialRadio { io, mac, dec: SlipDecoder::default(), msgs: VecDeque::new(), acked: 0, unacked: 0, rbuf: [0; 2048], wbuf: Vec::new() }
    }

    pub fn set_channel(&mut self, ch: u8) -> io::Result<()> {
        self.write_msg(&[MSG_CHANNEL, ch])
    }

    fn write_msg(&mut self, m: &[u8]) -> io::Result<()> {
        self.wbuf.clear();
        slip_encode(m, &mut self.wbuf);
        self.io.write_all(&self.wbuf)
    }

    fn pump(&mut self) -> io::Result<()> {
        loop {
            match self.io.read(&mut self.rbuf) {
                Ok(0) => return Ok(()),
                Ok(n) => self.dec.feed(&self.rbuf[..n], &mut self.msgs),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(()),
                Err(e) => return Err(e),
            }
        }
    }
}

impl<S: Read + Write> RawRadio for SerialRadio<S> {
    fn mac(&self) -> [u8; 6] {
        self.mac
    }
    fn send(&mut self, f: &[u8]) -> io::Result<()> {
        let mut m = Vec::with_capacity(1 + f.len());
        m.push(MSG_TX);
        m.extend_from_slice(f);
        self.write_msg(&m)
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        self.pump()?;
        while let Some(m) = self.msgs.pop_front() {
            match m.first() {
                Some(&MSG_RX) if m.len() > 6 && m.len() - 6 <= buf.len() => {
                    let f = &m[6..];
                    buf[..f.len()].copy_from_slice(f);
                    let rx_us = u32::from_le_bytes(m[2..6].try_into().unwrap()) as i64;
                    return Ok(Some(RawRx { len: f.len(), rssi_dbm: Some(m[1] as i8), rx_us }));
                }
                Some(&MSG_TX_DONE) if m.len() == 2 => {
                    if m[1] == 0 { self.acked += 1 } else { self.unacked += 1 }
                }
                Some(&MSG_HELLO) if m.len() == 8 => self.mac.copy_from_slice(&m[2..8]),
                _ => {}
            }
        }
        Ok(None)
    }
    fn take_tx_status(&mut self) -> (u32, u32) {
        let r = (self.acked, self.unacked);
        (self.acked, self.unacked) = (0, 0);
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slip_round_trip_and_resync() {
        let msgs: [&[u8]; 3] = [&[1, END, 2, ESC, 3], &[MSG_RX], &[0; 300]];
        let mut wire = Vec::new();
        for m in msgs {
            slip_encode(m, &mut wire);
        }
        // Garbage before the first END and a bad escape in the middle are dropped.
        let mut stream = vec![0x55, 0x66];
        stream.extend_from_slice(&wire[..wire.len() / 2]);
        let mut d = SlipDecoder::default();
        let mut out = VecDeque::new();
        // Byte by byte, as a UART delivers it.
        for b in stream.iter().chain(&wire[wire.len() / 2..]) {
            d.feed(&[*b], &mut out);
        }
        let got: Vec<_> = out.into_iter().collect();
        // The leading garbage forms one bogus message before the first END; the rest is exact.
        assert_eq!(&got[got.len() - 3..], &msgs.map(|m| m.to_vec()));
        let mut out = VecDeque::new();
        d.feed(&[END, ESC, 0x01, 7, END, 9, END], &mut out);
        assert_eq!(out, VecDeque::from([vec![9]]));
        assert_eq!(d.dropped, 1);
    }
}
