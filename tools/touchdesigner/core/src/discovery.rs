//! Fixture discovery on the local network.
//!
//! The player firmware does not (yet) advertise an mDNS service — it exposes a
//! stable `ledmapper.local` hostname and its WebSocket protocol on port 81. So
//! discovery here is active probing: for each candidate host we open a short
//! `ws://host:81/ws`, send `hello`, and read the `welcome` reply, which carries
//! the fixture's stable MAC and display name. Candidates come from an explicit
//! host list, the default `ledmapper.local`, and an optional /24 sweep of the
//! local subnet (probed concurrently).

use crate::proto::{decode_server, encode_hello, ServerMsg};
use crate::ws::WsClient;
use std::net::{IpAddr, UdpSocket};
use std::sync::mpsc;
use std::time::Duration;

pub const DEFAULT_WS_PORT: u16 = 81;
pub const DEFAULT_HOST: &str = "ledmapper.local";
pub const WS_PATH: &str = "/ws";
const SWEEP_THREADS: usize = 64;

/// A discovered (or reachable) fixture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fixture {
    /// `host:port` you can hand back to [`crate::client`].
    pub addr: String,
    /// Stable hardware MAC (`AA:BB:...`); empty on very old firmware.
    pub mac: String,
    /// Display name (e.g. "Led Widget abcdef").
    pub name: String,
}

/// Split a user-entered host that may include a port into `(host, port)`.
fn split_host_port(entry: &str, default_port: u16) -> (String, u16) {
    match entry.rsplit_once(':') {
        Some((h, p)) if p.parse::<u16>().is_ok() && !h.is_empty() => {
            (h.to_string(), p.parse().unwrap())
        }
        _ => (entry.to_string(), default_port),
    }
}

/// Probe one host: handshake and read `welcome`. Returns the fixture on
/// success, `None` if it isn't a reachable player within `timeout`.
pub fn probe(entry: &str, default_port: u16, timeout: Duration) -> Option<Fixture> {
    let (host, port) = split_host_port(entry, default_port);
    let mut ws = WsClient::connect((host.as_str(), port), &host, WS_PATH, timeout).ok()?;
    ws.send_binary(&encode_hello("touchdesigner", env!("CARGO_PKG_VERSION"))).ok()?;
    // Read until we see a welcome (the very first server message is welcome).
    for _ in 0..4 {
        let frame = ws.recv_message().ok()?;
        if let Some(ServerMsg::Welcome(w)) = decode_server(&frame) {
            return Some(Fixture {
                addr: format!("{host}:{port}"),
                mac: w.mac,
                name: if w.device_name.is_empty() {
                    format!("{host}:{port}")
                } else {
                    w.device_name
                },
            });
        }
    }
    None
}

/// Best-effort local IPv4 address (used to derive the /24 to sweep). Uses the
/// "connect a UDP socket and read its local address" trick — no packets are
/// sent. Returns `None` when there's no usable route.
fn local_ipv4() -> Option<[u8; 4]> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    match sock.local_addr().ok()?.ip() {
        IpAddr::V4(v4) => Some(v4.octets()),
        IpAddr::V6(_) => None,
    }
}

/// Discover fixtures. Always probes `explicit_hosts` and `ledmapper.local`;
/// when `sweep` is set, also probes every host on the local /24. Results are
/// de-duplicated by MAC (falling back to address when the MAC is empty).
pub fn discover(explicit_hosts: &[String], sweep: bool, port: u16, timeout: Duration) -> Vec<Fixture> {
    let mut candidates: Vec<String> = Vec::new();
    candidates.push(DEFAULT_HOST.to_string());
    candidates.extend(explicit_hosts.iter().filter(|h| !h.trim().is_empty()).cloned());

    if sweep {
        if let Some([a, b, c, _]) = local_ipv4() {
            for host in 1u16..=254 {
                candidates.push(format!("{a}.{b}.{c}.{host}"));
            }
        }
    }

    // Probe concurrently across a small thread pool.
    let (tx, rx) = mpsc::channel::<Fixture>();
    let mut workers = Vec::new();
    for chunk in candidates.chunks(candidates.len().div_ceil(SWEEP_THREADS).max(1)) {
        let chunk: Vec<String> = chunk.to_vec();
        let tx = tx.clone();
        workers.push(std::thread::spawn(move || {
            for entry in chunk {
                if let Some(f) = probe(&entry, port, timeout) {
                    let _ = tx.send(f);
                }
            }
        }));
    }
    drop(tx);
    for w in workers {
        let _ = w.join();
    }

    let mut out: Vec<Fixture> = Vec::new();
    for f in rx {
        let key_matches = |e: &Fixture| {
            if !f.mac.is_empty() {
                e.mac == f.mac
            } else {
                e.addr == f.addr
            }
        };
        if !out.iter().any(key_matches) {
            out.push(f);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_port_parsing() {
        assert_eq!(split_host_port("ledmapper.local", 81), ("ledmapper.local".into(), 81));
        assert_eq!(split_host_port("192.168.1.5:8080", 81), ("192.168.1.5".into(), 8080));
        assert_eq!(split_host_port("host:notaport", 81), ("host:notaport".into(), 81));
    }
}
