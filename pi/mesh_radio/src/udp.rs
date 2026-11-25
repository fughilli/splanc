//! The IP backhaul (design §15 M10): the same Splanc 802.11 frames, carried in UDP
//! datagrams on the LAN. Using the radio framing keeps one codec, one peer table and one
//! dedup path for both; the 802.11 addresses become the nodes' link addresses (a Pi uses
//! its wlan or eth MAC, a C6 its own).
//!
//! Broadcast goes to a multicast group (or, where multicast is filtered, such as a routed
//! container network, to a fixed peer list); unicast goes to the address a peer's frames
//! came from.

use std::collections::HashMap;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, UdpSocket};
use std::time::Instant;

use crate::frame;
use crate::radio::{RawRadio, RawRx};

/// Default group and port for the IP backhaul.
pub const GROUP: Ipv4Addr = Ipv4Addr::new(239, 83, 77, 1);
pub const PORT: u16 = 47_811;
/// UDP payloads stay under a 1500-byte Ethernet MTU: 1400 B mesh frames (design §5.2).
pub const MAX_DATAGRAM: usize = 1472;

pub enum Fanout {
    /// Join and send to this multicast group:port.
    Multicast(SocketAddrV4),
    /// Send each broadcast to every address listed.
    Peers(Vec<SocketAddr>),
}

pub struct UdpRadio {
    sock: UdpSocket,
    mac: [u8; 6],
    fanout: Fanout,
    peers: HashMap<[u8; 6], SocketAddr>,
    t0: Instant,
}

impl UdpRadio {
    pub fn new(sock: UdpSocket, mac: [u8; 6], fanout: Fanout) -> io::Result<UdpRadio> {
        sock.set_nonblocking(true)?;
        if let Fanout::Multicast(g) = &fanout {
            sock.join_multicast_v4(g.ip(), &Ipv4Addr::UNSPECIFIED)?;
            sock.set_multicast_loop_v4(false)?;
        }
        Ok(UdpRadio { sock, mac, fanout, peers: HashMap::new(), t0: Instant::now() })
    }

    /// Bind `0.0.0.0:PORT` and use the default multicast group.
    pub fn multicast(mac: [u8; 6]) -> io::Result<UdpRadio> {
        let s = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, PORT))?;
        UdpRadio::new(s, mac, Fanout::Multicast(SocketAddrV4::new(GROUP, PORT)))
    }

    pub fn local_addr(&self) -> io::Result<SocketAddr> {
        self.sock.local_addr()
    }
}

impl RawRadio for UdpRadio {
    fn mac(&self) -> [u8; 6] {
        self.mac
    }

    fn send(&mut self, f: &[u8]) -> io::Result<()> {
        let da: [u8; 6] = f.get(4..10).and_then(|d| d.try_into().ok()).unwrap_or(frame::BROADCAST);
        if let Some(a) = self.peers.get(&da) {
            self.sock.send_to(f, a)?;
            return Ok(());
        }
        match &self.fanout {
            Fanout::Multicast(g) => {
                self.sock.send_to(f, g)?;
            }
            Fanout::Peers(list) => {
                for a in list {
                    // A peer that is down must not stop the others.
                    let _ = self.sock.send_to(f, a);
                }
            }
        }
        Ok(())
    }

    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        loop {
            let (n, from) = match self.sock.recv_from(buf) {
                Ok(x) => x,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => return Ok(None),
                // ICMP port unreachable from a peer that went away, reported on Linux.
                Err(e) if e.kind() == io::ErrorKind::ConnectionRefused => continue,
                Err(e) => return Err(e),
            };
            if let Some(p) = frame::parse(&buf[..n]) {
                if p.sa != self.mac {
                    self.peers.insert(p.sa, from);
                }
            }
            return Ok(Some(RawRx { len: n, rssi_dbm: None, rx_us: self.t0.elapsed().as_micros() as i64 }));
        }
    }
}
