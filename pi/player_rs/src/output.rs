//! Swappable LED output drivers for the host player (`player_host`): the render
//! loop hands each driver a frame of RGB pixels, and the driver puts them on the
//! wire. The network drivers treat the controller as a dumb pixel sink (a WLED
//! board in realtime mode, a pixel bridge): every pattern, mapping and effect
//! decision stays in the player upstream.
//!
//! * `ddp://host[:port]` — DDP (port 4048), the protocol WLED and most pixel
//!   bridges take natively. 480 RGB pixels per packet, PUSH on the last.
//! * `artnet://host[:port][?universe=U][&sync=1]` — Art-Net ArtDmx (port 6454),
//!   170 RGB pixels per universe starting at `universe`; `sync=1` also sends an
//!   ArtSync after each frame for controllers that latch on it.
//! * `null` — drops frames (bench the render loop with nothing attached).
//!
//! Any spec may end with `#N` to give that output N pixels; several outputs
//! split one strip in order (`ddp://a#300 ddp://b#150`). An output without a
//! count takes whatever the strip has left.

use crate::wire::Rgb;
use std::io;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};

/// One output: a destination that takes a whole frame of pixels at a time.
pub trait Output: Send {
    fn send(&mut self, px: &[Rgb]) -> io::Result<()>;
    /// For logs: what and where.
    fn describe(&self) -> String;
}

/// DDP: 10-byte header + up to this many data bytes per packet (WLED's limit).
pub const DDP_PORT: u16 = 4048;
pub const DDP_MAX_DATA: usize = 1440;
const DDP_VER1: u8 = 0x40;
const DDP_PUSH: u8 = 0x01;
/// Data type: RGB, 8 bits per channel (WLED reads 3 channels per pixel from it).
const DDP_TYPE_RGB8: u8 = 0x0B;
/// Destination id 1 = the default output device.
const DDP_ID_DISPLAY: u8 = 0x01;

/// The DDP packets for one frame. `seq` is the 4-bit sequence number (1..=15;
/// 0 means "unsequenced" to receivers). Offsets are in bytes; the last packet
/// carries PUSH so the receiver shows the frame at once.
pub fn ddp_packets(px: &[Rgb], seq: u8) -> Vec<Vec<u8>> {
    let data: Vec<u8> = px.iter().flatten().copied().collect();
    if data.is_empty() {
        return Vec::new();
    }
    let chunks: Vec<&[u8]> = data.chunks(DDP_MAX_DATA).collect();
    let last = chunks.len() - 1;
    chunks
        .iter()
        .enumerate()
        .map(|(i, chunk)| {
            let offset = (i * DDP_MAX_DATA) as u32;
            let mut p = Vec::with_capacity(10 + chunk.len());
            p.push(DDP_VER1 | if i == last { DDP_PUSH } else { 0 });
            p.push(seq & 0x0F);
            p.push(DDP_TYPE_RGB8);
            p.push(DDP_ID_DISPLAY);
            p.extend_from_slice(&offset.to_be_bytes());
            p.extend_from_slice(&(chunk.len() as u16).to_be_bytes());
            p.extend_from_slice(chunk);
            p
        })
        .collect()
}

pub struct DdpOutput {
    sock: UdpSocket,
    to: SocketAddr,
    seq: u8,
}

impl DdpOutput {
    pub fn open(to: SocketAddr) -> io::Result<Self> {
        Ok(Self { sock: bind_for(to)?, to, seq: 0 })
    }
}

impl Output for DdpOutput {
    fn send(&mut self, px: &[Rgb]) -> io::Result<()> {
        self.seq = self.seq % 15 + 1;
        for p in ddp_packets(px, self.seq) {
            self.sock.send_to(&p, self.to)?;
        }
        Ok(())
    }
    fn describe(&self) -> String {
        format!("ddp {}", self.to)
    }
}

/// Art-Net: one universe carries 170 RGB pixels (510 of its 512 channels).
pub const ARTNET_PORT: u16 = 6454;
pub const ARTNET_PX_PER_UNIVERSE: usize = 170;
const ARTNET_ID: &[u8; 8] = b"Art-Net\0";
const OP_DMX: u16 = 0x5000;
const OP_SYNC: u16 = 0x5200;
const PROT_VER: u16 = 14;

/// The ArtDmx packets for one frame, one per universe from `universe` (a 15-bit
/// port address: net << 8 | subnet << 4 | universe). `seq` 1..=255 (0 disables
/// receiver reordering).
pub fn artnet_packets(px: &[Rgb], universe: u16, seq: u8) -> Vec<Vec<u8>> {
    px.chunks(ARTNET_PX_PER_UNIVERSE)
        .enumerate()
        .map(|(i, chunk)| {
            let addr = universe.wrapping_add(i as u16) & 0x7FFF;
            let mut data: Vec<u8> = chunk.iter().flatten().copied().collect();
            // The DMX length must be even and at least 2.
            if data.len() % 2 == 1 {
                data.push(0);
            }
            let mut p = Vec::with_capacity(18 + data.len());
            p.extend_from_slice(ARTNET_ID);
            p.extend_from_slice(&OP_DMX.to_le_bytes());
            p.extend_from_slice(&PROT_VER.to_be_bytes());
            p.push(seq);
            p.push(0); // physical input port (informational)
            p.push((addr & 0xFF) as u8); // SubUni
            p.push((addr >> 8) as u8); // Net
            p.extend_from_slice(&(data.len() as u16).to_be_bytes());
            p.extend_from_slice(&data);
            p
        })
        .collect()
}

/// ArtSync: tells sync-aware receivers to show the universes just sent.
pub fn artnet_sync() -> Vec<u8> {
    let mut p = Vec::with_capacity(14);
    p.extend_from_slice(ARTNET_ID);
    p.extend_from_slice(&OP_SYNC.to_le_bytes());
    p.extend_from_slice(&PROT_VER.to_be_bytes());
    p.extend_from_slice(&[0, 0]); // Aux1, Aux2
    p
}

pub struct ArtNetOutput {
    sock: UdpSocket,
    to: SocketAddr,
    universe: u16,
    sync: bool,
    seq: u8,
}

impl ArtNetOutput {
    pub fn open(to: SocketAddr, universe: u16, sync: bool) -> io::Result<Self> {
        let sock = bind_for(to)?;
        // A broadcast destination (x.x.x.255) needs SO_BROADCAST.
        sock.set_broadcast(true)?;
        Ok(Self { sock, to, universe, sync, seq: 0 })
    }
}

impl Output for ArtNetOutput {
    fn send(&mut self, px: &[Rgb]) -> io::Result<()> {
        self.seq = self.seq % 255 + 1;
        for p in artnet_packets(px, self.universe, self.seq) {
            self.sock.send_to(&p, self.to)?;
        }
        if self.sync {
            self.sock.send_to(&artnet_sync(), self.to)?;
        }
        Ok(())
    }
    fn describe(&self) -> String {
        format!("artnet {} universe {}{}", self.to, self.universe, if self.sync { " +sync" } else { "" })
    }
}

/// Drops every frame.
pub struct NullOutput;

impl Output for NullOutput {
    fn send(&mut self, _px: &[Rgb]) -> io::Result<()> {
        Ok(())
    }
    fn describe(&self) -> String {
        "null".into()
    }
}

/// An unconnected UDP socket on the wildcard address of the destination's family.
fn bind_for(to: SocketAddr) -> io::Result<UdpSocket> {
    UdpSocket::bind(if to.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" })
}

/// A parsed output spec (see the module docs), before any socket is opened.
#[derive(Clone, Debug, PartialEq)]
pub enum Spec {
    Ddp { host: String, port: u16 },
    ArtNet { host: String, port: u16, universe: u16, sync: bool },
    Null,
}

/// Parse one `--output` value into its spec and optional pixel count.
pub fn parse_spec(s: &str) -> Result<(Spec, Option<usize>), String> {
    let (body, count) = match s.rsplit_once('#') {
        Some((b, n)) => (b, Some(n.parse::<usize>().map_err(|_| format!("bad pixel count in {s:?}"))?)),
        None => (s, None),
    };
    if body == "null" {
        return Ok((Spec::Null, count));
    }
    let (scheme, rest) = body
        .split_once("://")
        .ok_or_else(|| format!("{s:?}: expected ddp://host, artnet://host or null"))?;
    let (hostport, query) = rest.split_once('?').unwrap_or((rest, ""));
    let default_port = match scheme {
        "ddp" => DDP_PORT,
        "artnet" => ARTNET_PORT,
        _ => return Err(format!("{s:?}: unknown output {scheme:?} (ddp, artnet, null)")),
    };
    let (host, port) = split_host_port(hostport, default_port).map_err(|e| format!("{s:?}: {e}"))?;
    let mut universe = 0u16;
    let mut sync = false;
    for kv in query.split('&').filter(|kv| !kv.is_empty()) {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        match (scheme, k) {
            ("artnet", "universe") => {
                universe = v.parse().map_err(|_| format!("{s:?}: bad universe {v:?}"))?;
                if universe > 0x7FFF {
                    return Err(format!("{s:?}: universe must be < 32768"));
                }
            }
            ("artnet", "sync") => sync = matches!(v, "" | "1" | "true"),
            _ => return Err(format!("{s:?}: unknown option {k:?}")),
        }
    }
    Ok((
        match scheme {
            "ddp" => Spec::Ddp { host, port },
            _ => Spec::ArtNet { host, port, universe, sync },
        },
        count,
    ))
}

fn split_host_port(s: &str, default_port: u16) -> Result<(String, u16), String> {
    if s.is_empty() {
        return Err("missing host".into());
    }
    // [v6]:port, [v6], host:port, host
    if let Some(rest) = s.strip_prefix('[') {
        let (h, tail) = rest.split_once(']').ok_or("unclosed [")?;
        let port = match tail.strip_prefix(':') {
            Some(p) => p.parse().map_err(|_| format!("bad port {p:?}"))?,
            None => default_port,
        };
        return Ok((h.to_string(), port));
    }
    match s.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => Ok((h.to_string(), p.parse().map_err(|_| format!("bad port {p:?}"))?)),
        _ => Ok((s.to_string(), default_port)),
    }
}

/// Open the driver for `spec` (resolving its host once, at startup).
pub fn open(spec: &Spec) -> io::Result<Box<dyn Output>> {
    let resolve = |host: &str, port: u16| -> io::Result<SocketAddr> {
        (host, port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{host}: no address")))
    };
    Ok(match spec {
        Spec::Ddp { host, port } => Box::new(DdpOutput::open(resolve(host, *port)?)?),
        Spec::ArtNet { host, port, universe, sync } => {
            Box::new(ArtNetOutput::open(resolve(host, *port)?, *universe, *sync)?)
        }
        Spec::Null => Box::new(NullOutput),
    })
}

/// Pixel ranges for outputs that each want `counts[i]` pixels (None = the rest)
/// of a `total`-pixel strip, in order. Outputs without a count share what the
/// counted ones leave, the first of them taking any remainder.
pub fn layout(counts: &[Option<usize>], total: usize) -> Vec<std::ops::Range<usize>> {
    let fixed: usize = counts.iter().flatten().sum();
    let open = counts.iter().filter(|c| c.is_none()).count();
    let spare = total.saturating_sub(fixed);
    let (each, extra) = if open > 0 { (spare / open, spare % open) } else { (0, 0) };
    let mut at = 0;
    let mut first_open = true;
    counts
        .iter()
        .map(|c| {
            let n = match c {
                Some(n) => *n,
                None => {
                    let n = each + if first_open { extra } else { 0 };
                    first_open = false;
                    n
                }
            };
            let r = at..at + n;
            at += n;
            r
        })
        .collect()
}

/// A strip fanned out over several outputs.
pub struct Outputs {
    outs: Vec<(Box<dyn Output>, std::ops::Range<usize>)>,
}

impl Outputs {
    pub fn new(outs: Vec<(Box<dyn Output>, std::ops::Range<usize>)>) -> Self {
        Self { outs }
    }

    /// Total pixels across every output.
    pub fn len(&self) -> usize {
        self.outs.iter().map(|(_, r)| r.end).max().unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Send `frame` (one strip) to every output; pixels past the frame go dark.
    /// Every output is tried; the first error is returned.
    pub fn send(&mut self, frame: &[Rgb]) -> io::Result<()> {
        let mut first_err = None;
        for (out, r) in &mut self.outs {
            let px: Vec<Rgb> = r.clone().map(|i| frame.get(i).copied().unwrap_or([0, 0, 0])).collect();
            if let Err(e) = out.send(&px) {
                first_err.get_or_insert(e);
            }
        }
        first_err.map_or(Ok(()), Err)
    }

    pub fn describe(&self) -> Vec<String> {
        self.outs
            .iter()
            .map(|(o, r)| format!("{} [pixels {}..{}]", o.describe(), r.start, r.end))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(n: usize) -> Vec<Rgb> {
        (0..n).map(|i| [i as u8, (i >> 8) as u8, 0xAA]).collect()
    }

    #[test]
    fn ddp_single_packet_header() {
        let p = ddp_packets(&strip(3), 5);
        assert_eq!(p.len(), 1);
        assert_eq!(&p[0][..10], &[0x41, 5, 0x0B, 0x01, 0, 0, 0, 0, 0, 9]);
        assert_eq!(&p[0][10..], &[0, 0, 0xAA, 1, 0, 0xAA, 2, 0, 0xAA]);
    }

    #[test]
    fn ddp_splits_at_480_pixels_and_pushes_last() {
        let p = ddp_packets(&strip(1000), 1);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0][0], 0x40, "no PUSH before the last packet");
        assert_eq!(p[1][0], 0x40);
        assert_eq!(p[2][0], 0x41);
        let off = |q: &Vec<u8>| u32::from_be_bytes([q[4], q[5], q[6], q[7]]);
        let len = |q: &Vec<u8>| u16::from_be_bytes([q[8], q[9]]) as usize;
        assert_eq!((off(&p[0]), len(&p[0])), (0, 1440));
        assert_eq!((off(&p[1]), len(&p[1])), (1440, 1440));
        assert_eq!((off(&p[2]), len(&p[2])), (2880, 120));
        // Reassembling the payloads gives the strip back.
        let back: Vec<u8> = p.iter().flat_map(|q| q[10..].to_vec()).collect();
        assert_eq!(back, strip(1000).concat());
    }

    #[test]
    fn ddp_empty_frame_sends_nothing() {
        assert!(ddp_packets(&[], 1).is_empty());
    }

    #[test]
    fn artnet_universes_of_170() {
        let p = artnet_packets(&strip(171), 0x0102, 7);
        assert_eq!(p.len(), 2);
        let h = &p[0];
        assert_eq!(&h[..8], b"Art-Net\0");
        assert_eq!(&h[8..10], &[0x00, 0x50], "OpDmx, little-endian");
        assert_eq!(&h[10..12], &[0, 14], "protocol 14, big-endian");
        assert_eq!(h[12], 7);
        assert_eq!((h[14], h[15]), (0x02, 0x01), "SubUni, Net");
        assert_eq!(u16::from_be_bytes([h[16], h[17]]), 510);
        assert_eq!(h.len(), 18 + 510);
        // The second universe: one pixel, padded to an even length.
        let t = &p[1];
        assert_eq!((t[14], t[15]), (0x03, 0x01));
        assert_eq!(u16::from_be_bytes([t[16], t[17]]), 4);
        assert_eq!(&t[18..], &[170, 0, 0xAA, 0]);
    }

    #[test]
    fn artnet_sync_packet() {
        assert_eq!(artnet_sync(), b"Art-Net\0\x00\x52\x00\x0e\x00\x00".to_vec());
    }

    #[test]
    fn parses_specs() {
        assert_eq!(
            parse_spec("ddp://wled-desk.local").unwrap(),
            (Spec::Ddp { host: "wled-desk.local".into(), port: 4048 }, None)
        );
        assert_eq!(
            parse_spec("ddp://10.0.0.5:5000#300").unwrap(),
            (Spec::Ddp { host: "10.0.0.5".into(), port: 5000 }, Some(300))
        );
        assert_eq!(
            parse_spec("artnet://10.0.0.255?universe=3&sync=1").unwrap(),
            (Spec::ArtNet { host: "10.0.0.255".into(), port: 6454, universe: 3, sync: true }, None)
        );
        assert_eq!(
            parse_spec("ddp://[fe80::1]:4048").unwrap().0,
            Spec::Ddp { host: "fe80::1".into(), port: 4048 }
        );
        assert_eq!(parse_spec("null#64").unwrap(), (Spec::Null, Some(64)));
        assert!(parse_spec("e131://x").is_err());
        assert!(parse_spec("ddp://x?universe=1").is_err());
        assert!(parse_spec("ddp://x#lots").is_err());
        assert!(parse_spec("wled.local").is_err());
    }

    #[test]
    fn layout_splits_the_strip() {
        assert_eq!(layout(&[None], 300), vec![0..300]);
        assert_eq!(layout(&[Some(100), None], 300), vec![0..100, 100..300]);
        assert_eq!(layout(&[None, Some(50), None], 151), vec![0..51, 51..101, 101..151]);
        assert_eq!(layout(&[Some(10), Some(20)], 0), vec![0..10, 10..30]);
    }

    struct Capture(std::sync::Arc<std::sync::Mutex<Vec<Vec<Rgb>>>>);
    impl Output for Capture {
        fn send(&mut self, px: &[Rgb]) -> io::Result<()> {
            self.0.lock().unwrap().push(px.to_vec());
            Ok(())
        }
        fn describe(&self) -> String {
            "capture".into()
        }
    }

    #[test]
    fn outputs_fan_out_and_pad() {
        let a = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let b = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let mut outs = Outputs::new(vec![
            (Box::new(Capture(a.clone())), 0..2),
            (Box::new(Capture(b.clone())), 2..5),
        ]);
        assert_eq!(outs.len(), 5);
        outs.send(&[[1, 1, 1], [2, 2, 2], [3, 3, 3]]).unwrap();
        assert_eq!(a.lock().unwrap()[0], vec![[1, 1, 1], [2, 2, 2]]);
        assert_eq!(b.lock().unwrap()[0], vec![[3, 3, 3], [0, 0, 0], [0, 0, 0]]);
    }

    #[test]
    fn ddp_reaches_a_udp_listener() {
        let rx = UdpSocket::bind("127.0.0.1:0").unwrap();
        rx.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
        let mut out = DdpOutput::open(rx.local_addr().unwrap()).unwrap();
        out.send(&strip(2)).unwrap();
        let mut buf = [0u8; 1500];
        let n = rx.recv(&mut buf).unwrap();
        assert_eq!(n, 16);
        assert_eq!(buf[0], 0x41);
        assert_eq!(&buf[10..16], &[0, 0, 0xAA, 1, 0, 0xAA]);
    }
}
