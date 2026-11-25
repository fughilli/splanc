//! The backhaul end to end without a radio: real `splanc_mesh::Node`s over
//! [`WifiBackhaul`] on real sockets (UDP on localhost, and the C6 coprocessor link over a
//! socket pair with a fake C6 relaying between two Pis).

use std::collections::VecDeque;
use std::io;
use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::os::unix::net::UnixStream;

use splanc_mesh::{Backhaul, Node, NodeConfig};
use swarm_net::crypto::signing::p256_public_key;
use swarm_net::crypto::HMAC_KEY_LEN;
use swarm_net::mesh::BROADCAST;
use swarm_net::net::{NetOf, PORT_APP};
use swarm_net::update::{Flash, PAGE_SIZE};

use crate::frame::{self, Category};
use crate::radio::{RawRadio, RawRx};
use crate::serial::{self, SerialRadio, SlipDecoder};
use crate::udp::{Fanout, UdpRadio};
use crate::wifi::{source_node, WifiBackhaul, WifiConfig};

const HMAC: [u8; HMAC_KEY_LEN] = [5; HMAC_KEY_LEN];
const FW_SECRET: [u8; 32] = [6; 32];
const P: usize = 200;

struct RamFlash(Vec<u8>);
impl Flash for RamFlash {
    fn capacity(&self) -> u32 {
        self.0.len() as u32
    }
    fn erase(&mut self, o: u32, l: u32) -> bool {
        self.0[o as usize..(o + l) as usize].fill(0xFF);
        true
    }
    fn write(&mut self, o: u32, d: &[u8]) -> bool {
        self.0[o as usize..o as usize + d.len()].copy_from_slice(d);
        true
    }
    fn read(&mut self, o: u32, b: &mut [u8]) -> bool {
        b.copy_from_slice(&self.0[o as usize..o as usize + b.len()]);
        true
    }
}

fn mac(i: usize) -> [u8; 6] {
    [0x02, 0x53, 0x50, 0, 0, i as u8]
}

fn net(id: u16) -> NetOf<P> {
    NetOf::<P>::new(id, Some(HMAC), p256_public_key(&FW_SECRET), 1, 77 + id as u32)
}

/// Run nodes in lockstep on a virtual clock (1 ms ticks); real sockets underneath.
fn run<R: RawRadio>(nodes: &mut [Node<WifiBackhaul<R>, P>], t: &mut i64, ms: usize) {
    let mut scratch = vec![0u8; nodes.iter().map(|n| n.scratch_len()).max().unwrap()];
    let mut flash = RamFlash(vec![0xFF; 8 * PAGE_SIZE]);
    for _ in 0..ms {
        *t += 1_000;
        for n in nodes.iter_mut() {
            n.backhaul.set_now(*t);
            n.tick(*t, &mut flash, &mut scratch);
        }
        // Let the loopback deliver.
        std::thread::yield_now();
    }
}

fn udp_mesh(n: usize, cfg: WifiConfig) -> Vec<Node<WifiBackhaul<UdpRadio>, P>> {
    let socks: Vec<UdpSocket> = (0..n).map(|_| UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap()).collect();
    let addrs: Vec<SocketAddr> = socks.iter().map(|s| s.local_addr().unwrap()).collect();
    socks
        .into_iter()
        .enumerate()
        .map(|(i, s)| {
            let others = addrs.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, a)| *a).collect();
            let radio = UdpRadio::new(s, mac(i), Fanout::Peers(others)).unwrap();
            let bh = WifiBackhaul::new(radio, WifiConfig { mtu: 1400, ..cfg });
            let ncfg = NodeConfig { beacon_us: 30_000, ..NodeConfig::default() };
            Node::new(net(10 + i as u16), bh, ncfg).unwrap()
        })
        .collect()
}

/// The IP backhaul: a 200-byte broadcast reaches all, a want-ack unicast is acked, and
/// every node learned every other's link address from its beacons.
#[test]
fn udp_backhaul_carries_the_mesh() {
    let mut nodes = udp_mesh(4, WifiConfig { max_duty: 1.0, ..WifiConfig::default() });
    let mut t = 0;
    run(&mut nodes, &mut t, 100);
    let body: Vec<u8> = (0..P).map(|i| i as u8).collect();
    nodes[0].net.send(BROADCAST, PORT_APP, &body, false).unwrap();
    nodes[1].net.send(13, PORT_APP + 1, b"cfg", true).unwrap();
    run(&mut nodes, &mut t, 300);
    for i in 1..4 {
        let a = nodes[i].net.next_app().unwrap_or_else(|| panic!("node {i}"));
        assert_eq!((a.origin, &a.payload[..a.len]), (10, &body[..]));
    }
    let a = nodes[3].net.next_app().expect("unicast");
    assert_eq!((a.origin, a.port, &a.payload[..a.len]), (11, PORT_APP + 1, &b"cfg"[..]));
    assert!(nodes[1].net.mesh.stats.acked >= 1);
    for (i, n) in nodes.iter().enumerate() {
        for j in 0..4 {
            if i != j {
                assert_eq!(n.backhaul.peer_mac(10 + j as u16), Some(mac(j)), "node {i} learned {j}");
            }
        }
        assert_eq!(n.stats.rx_rejected, 0);
    }
}

/// The airtime budget: at 1 Mb/s a 250-byte frame is ~2.3 ms of air; 10 % duty over a 50 ms
/// window leaves room for two, then `may_send` goes false and `send` is back-pressure.
#[test]
fn airtime_budget_paces_sends() {
    let cfg = WifiConfig { rate_kbps: 1_000, max_duty: 0.1, burst_us: 50_000, ..WifiConfig::default() };
    let mut nodes = udp_mesh(2, cfg);
    let bh = &mut nodes[0].backhaul;
    bh.cfg.mtu = 250;
    bh.set_now(0);
    let f = vec![0u8; 250];
    assert!(bh.may_send(0));
    assert!(bh.send(&f, None).is_ok());
    assert!(bh.send(&f, None).is_ok());
    assert!(!bh.may_send(0));
    assert!(bh.send(&f, None).is_err());
    assert_eq!(bh.stats.tx_paced, 1);
    bh.set_now(25_000); // 2.5 ms of budget back
    assert!(bh.send(&f, None).is_ok());
}

/// A scripted radio for the receive filters.
struct Script {
    rx: VecDeque<Vec<u8>>,
    tx: Vec<Vec<u8>>,
}
impl RawRadio for Script {
    fn mac(&self) -> [u8; 6] {
        mac(0)
    }
    fn send(&mut self, f: &[u8]) -> io::Result<()> {
        self.tx.push(f.to_vec());
        Ok(())
    }
    fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
        Ok(self.rx.pop_front().map(|f| {
            buf[..f.len()].copy_from_slice(&f);
            RawRx { len: f.len(), rssi_dbm: Some(-71), rx_us: 0 }
        }))
    }
}

#[test]
fn receive_filters_and_unicast_addressing() {
    let env = |src: u16| {
        let mut e = b"SM\x01\0\0\0\x07\x01".to_vec();
        e.extend_from_slice(&src.to_be_bytes());
        e.extend_from_slice(&[0, 0, 0, 1, 0xaa]);
        e
    };
    let f = |cat, da, sa, seq, retry: bool, m: &[u8]| {
        let mut b = vec![0u8; 400];
        let n = frame::encode(cat, da, sa, seq, m, &mut b).unwrap();
        if retry {
            b[1] |= 0x08;
        }
        b.truncate(n);
        b
    };
    let peer = mac(5);
    let rx = VecDeque::from([
        f(Category::PublicVendor, frame::BROADCAST, peer, 1, false, &env(42)), // ok, learns 42
        f(Category::PublicVendor, frame::BROADCAST, peer, 1, true, &env(42)),  // retry of seq 1: dup
        f(Category::PublicVendor, mac(9), peer, 2, false, &env(42)),           // unicast to someone else
        f(Category::Vendor, frame::BROADCAST, peer, 3, false, &env(42)), // other category
        f(Category::PublicVendor, frame::BROADCAST, mac(0), 4, false, &env(1)), // our own echo
        vec![0x80, 0, 0, 0],                                              // not ours at all
        f(Category::PublicVendor, mac(0), peer, 5, true, &env(42)),             // unicast to us, retry of a new seq
    ]);
    let mut bh = WifiBackhaul::new(Script { rx, tx: vec![] }, WifiConfig::default());
    let mut buf = [0u8; 300];
    let m = bh.recv(&mut buf).unwrap();
    assert_eq!((m.len, m.rssi_dbm, m.src_mac), (15, -71, peer));
    assert_eq!(source_node(&buf[..m.len]), Some(42));
    let m = bh.recv(&mut buf).unwrap();
    assert_eq!(m.src_mac, peer);
    assert!(bh.recv(&mut buf).is_none());
    assert_eq!((bh.stats.rx, bh.stats.rx_dup, bh.stats.rx_other), (2, 1, 4));
    // Unicast to a learned node uses its MAC; to an unknown one, broadcast.
    bh.send(b"x", Some(42)).unwrap();
    bh.send(b"y", Some(43)).unwrap();
    bh.send(b"z", None).unwrap();
    let da: Vec<[u8; 6]> = bh.radio.tx.iter().map(|t| t[4..10].try_into().unwrap()).collect();
    assert_eq!(da, vec![peer, frame::BROADCAST, frame::BROADCAST]);
    assert_eq!((bh.stats.tx_unicast, bh.stats.tx_unknown_peer), (1, 1));
    // The frames carry our MAC, the Splanc prefix and increasing sequence numbers.
    let p: Vec<_> = bh.radio.tx.iter().map(|t| frame::parse(t).unwrap().seq).collect();
    assert_eq!(p, vec![1, 2, 3]);
}

/// Two Pis, each with a USB C6 as its radio; the "C6s" here are the test, relaying TX
/// messages from one host as RX messages to the other over socket pairs (the CDC link).
#[test]
fn c6_coprocessor_link_carries_the_mesh() {
    let (a_host, a_c6) = UnixStream::pair().unwrap();
    let (b_host, b_c6) = UnixStream::pair().unwrap();
    for s in [&a_host, &a_c6, &b_host, &b_c6] {
        s.set_nonblocking(true).unwrap();
    }
    let ncfg = NodeConfig { beacon_us: 30_000, ..NodeConfig::default() };
    let mk = |s, i: usize| {
        let bh = WifiBackhaul::new(SerialRadio::new(s, mac(i)), WifiConfig { max_duty: 1.0, ..WifiConfig::default() });
        Node::new(net(10 + i as u16), bh, ncfg).unwrap()
    };
    let mut nodes = vec![mk(a_host, 0), mk(b_host, 1)];
    // The fake C6 pair: decode SLIP TX from one host, encode RX to the other.
    let mut c6 = [(a_c6, SlipDecoder::default()), (b_c6, SlipDecoder::default())];
    let relay = |c6: &mut [(UnixStream, SlipDecoder); 2]| {
        use std::io::{Read, Write};
        for from in 0..2 {
            let mut buf = [0u8; 4096];
            let mut msgs = VecDeque::new();
            while let Ok(n) = c6[from].0.read(&mut buf) {
                if n == 0 {
                    break;
                }
                c6[from].1.feed(&buf[..n], &mut msgs);
            }
            for m in msgs {
                assert_eq!(m[0], serial::MSG_TX);
                let mut rx = vec![serial::MSG_RX, (-48i8) as u8, 1, 0, 0, 0];
                rx.extend_from_slice(&m[1..]);
                let mut w = Vec::new();
                serial::slip_encode(&rx, &mut w);
                c6[1 - from].0.write_all(&w).unwrap();
                let mut done = Vec::new();
                serial::slip_encode(&[serial::MSG_TX_DONE, 0], &mut done);
                c6[from].0.write_all(&done).unwrap();
            }
        }
    };
    let mut t = 0;
    let body = [0x42u8; P];
    nodes[0].net.send(BROADCAST, PORT_APP, &body, false).unwrap();
    for _ in 0..20 {
        run(&mut nodes, &mut t, 5);
        relay(&mut c6);
    }
    let a = nodes[1].net.next_app().expect("delivered over the C6 link");
    assert_eq!((a.origin, &a.payload[..a.len]), (10, &body[..]));
    let s = nodes[1].backhaul.stats;
    assert!(s.rx > 0 && s.rx_other == 0, "{s:?}");
    assert!(nodes[0].backhaul.stats.acked > 0);
}

#[test]
fn auto_via_uses_nl80211_only_on_the_patched_brcmfmac() {
    use crate::radio::{choose_via, Via};
    let patched = Some("A1B2C3D4E5F60718293A4B5\n");
    // The image's patched module is loaded: plain nl80211.
    assert_eq!(choose_via("brcmfmac", Some("A1B2C3D4E5F60718293A4B5\n"), patched), Via::Nl80211);
    // Stock module (another source version), no image marker, or brcmfmac not loaded.
    assert_eq!(choose_via("brcmfmac", Some("0F0E0D0C0B0A090807060504\n"), patched), Via::Brcm);
    assert_eq!(choose_via("brcmfmac", Some("A1B2C3D4E5F60718293A4B5"), None), Via::Brcm);
    assert_eq!(choose_via("brcmfmac", None, patched), Via::Brcm);
    assert_eq!(choose_via("brcmfmac", Some(""), Some("")), Via::Brcm);
    // mac80211 drivers carry Public Action through nl80211 as they are.
    assert_eq!(choose_via("mt7921u", None, None), Via::Nl80211);
}
