//! Splanc mesh (docs/design/mesh.md): one app connection manages every fixture.
//!
//! This crate is the Splanc layer over the ported swarm stack (`swarm_net`,
//! //firmware/mesh/swarm, from fughilli/indoor_localization): the backhaul seam
//! ([`Backhaul`], §3.2), the link frame Splanc backhauls carry ([`link`]) and a node that
//! drives `swarm_net` over one backhaul ([`Node`]), with the mesh payload sized from the
//! backhaul's MTU (§5.2). M1 of the PR plan (§15).
//!
//! M2 adds the Splanc layer's security and membership, as pure logic tested on the host:
//!
//! - [`envelope`]: the §5.1 envelope, AES-128-CCM on the netstack's CCM (`ccmp.rs`), a 64-bit
//!   per-sender counter that never rolls over (low 32 bits on the wire, rebuilt by the
//!   receiver), reserved ahead in flash once per 2^16 frames; [`replay`]: the per-source
//!   window with synced/unsynced sources; [`security`]: both as the [`Node`]'s frame guard.
//! - [`admin`]: insider-resistant administration: admin-signed session grants, freshness by
//!   challenge-response (not time), per-receiver MACs under pairwise keys.
//! - [`rekey`]: rotation on removal (signed order, one broadcast, 26 B per member).
//! - [`membership`]: closed / locked / open modes, provisioning (either path), the
//!   self-configuring formation, joins by site secret or approval, revocations, groups, mode
//!   transitions; [`msg`]: their messages and the capacity classes; [`guest`]: open mode
//!   (feature `open_mode`, off until M7b).
//! - [`ports`]: §5.3's ports and the dispatch policy in front of them.
//! - [`timesync`]: mesh time aggregated over many peers; [`meshtime`] (M4): the time beacons
//!   (two-step completion stamps, two-way over broadcasts), per-neighbour clock fits, sync
//!   states and the show epoch; [`interp`]: members interpolate live updates on their own
//!   render clock.
//! - [`topo`]: each member's room pose and radio neighbours, gossiped for the app's mesh map.
//! - [`stack`]: one device's mesh, all of the above around a [`Node`], with capacity classes
//!   and the custodian store hook.
//!
//! no_std, no allocation. The std build (feature `host`) adds the in-memory [`loopback`]
//! backhaul and [`host_keys`]; it is also what a Linux node (a Pi) runs.
#![cfg_attr(not(any(test, feature = "loopback", feature = "host")), no_std)]

pub mod admin;
pub mod backhaul;
pub mod blob;
pub mod codec;
pub mod crypto;
pub mod envelope;
pub mod gateway;
pub mod groups;
#[cfg(feature = "open_mode")]
pub mod guest;
#[cfg(any(test, feature = "host"))]
pub mod host_keys;
pub mod interp;
pub mod link;
#[cfg(any(test, feature = "loopback", feature = "host"))]
pub mod loopback;
pub mod membership;
pub mod meshtime;
pub mod msg;
pub mod node;
pub mod ports;
pub mod ranging;
pub mod rekey;
pub mod replay;
pub mod security;
pub mod stack;
pub mod timesync;
pub mod wallclock;
pub mod topo;
pub mod wifi_p2p;

pub use backhaul::{Backhaul, BackhaulId, Busy, NodeId, RxMeta, TxClass, TxStamp};
pub use node::{MtuTooSmall, Node, NodeConfig, NodeStats};
pub use stack::{Event, MeshStack, StackConfig};

#[cfg(test)]
mod tests {
    use super::loopback::{Air, Port};
    use super::*;
    use swarm_net::crypto::signing::p256_public_key;
    use swarm_net::crypto::HMAC_KEY_LEN;
    use swarm_net::mesh::BROADCAST;
    use swarm_net::net::{NetOf, PORT_APP};
    use swarm_net::settings::{make_bundle, Layer, MAX_BUNDLE};
    use swarm_net::update::{self, Flash, Status, PAGE_SIZE};
    use swarm_net::Manifest;

    const HMAC: [u8; HMAC_KEY_LEN] = [5; HMAC_KEY_LEN];
    const FW_SECRET: [u8; 32] = [6; 32];
    /// An 802.11-sized mesh: 200-byte payloads (design §5.2).
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

    struct Sim {
        air: Air,
        nodes: Vec<Node<Port, P>>,
        flash: Vec<RamFlash>,
        scratch: Vec<u8>,
        t_us: i64,
    }

    impl Sim {
        /// Node i has id 10 + i and MTU `mtus[i]`; a 30 ms beacon (the swarm's superframe).
        fn new(air: Air, mtus: &[usize]) -> Sim {
            let cfg = NodeConfig { beacon_us: 30_000, ..NodeConfig::default() };
            let nodes: Vec<Node<Port, P>> = mtus
                .iter()
                .enumerate()
                .map(|(i, &mtu)| {
                    let id = 10 + i as u16;
                    let net = NetOf::<P>::new(id, Some(HMAC), p256_public_key(&FW_SECRET), 1, 77 + i as u32);
                    Node::new(net, air.port(i, id, mtu), cfg).unwrap()
                })
                .collect();
            let scratch = vec![0u8; nodes.iter().map(|n| n.scratch_len()).max().unwrap()];
            let flash = (0..mtus.len()).map(|_| RamFlash(vec![0xFF; 32 * PAGE_SIZE])).collect();
            Sim { air, nodes, flash, scratch, t_us: 0 }
        }

        /// Advance `ms` milliseconds in 1 ms ticks, nodes in turn.
        fn run_ms(&mut self, ms: usize) {
            for _ in 0..ms {
                self.t_us += 1_000;
                self.air.set_now(self.t_us);
                for (n, f) in self.nodes.iter_mut().zip(self.flash.iter_mut()) {
                    n.tick(self.t_us, f, &mut self.scratch);
                }
                // Simulated install of a ready image, then a healthy boot.
                for n in self.nodes.iter_mut() {
                    let u = &mut n.net.updater;
                    if u.status() == Status::Ready {
                        u.running = u.manifest().unwrap().version;
                        u.set_validated(true);
                    }
                }
            }
        }
    }

    #[test]
    fn mtu_sets_the_mesh_payload_and_too_small_is_refused() {
        let air = Air::new(1);
        let net = NetOf::<P>::new(1, None, p256_public_key(&FW_SECRET), 1, 1);
        let n = Node::new(net, air.port(0, 1, 250), NodeConfig::default()).unwrap();
        assert_eq!(n.max_payload(), P, "250-byte frames carry more than the capacity");
        let net = NetOf::<P>::new(1, None, p256_public_key(&FW_SECRET), 1, 1);
        let n = Node::new(net, air.port(0, 1, 160), NodeConfig::default()).unwrap();
        assert_eq!(n.max_payload(), link::mesh_payload_for_mtu(160));
        // The envelope's bytes (M2) come off the MTU first.
        let net = NetOf::<P>::new(1, None, p256_public_key(&FW_SECRET), 1, 1);
        let cfg = NodeConfig { frame_overhead: 22, ..NodeConfig::default() };
        let n = Node::new(net, air.port(0, 1, 250), cfg).unwrap();
        assert_eq!((n.mtu(), n.max_payload()), (228, link::mesh_payload_for_mtu(228)));
        let net = NetOf::<P>::new(1, None, p256_public_key(&FW_SECRET), 1, 1);
        assert_eq!(
            Node::new(net, air.port(0, 1, 123), NodeConfig::default()).err(),
            Some(MtuTooSmall { mtu: 123, min: link::MIN_MTU })
        );
    }

    /// A 200-byte app broadcast reaches everyone in one room, once each.
    #[test]
    fn app_broadcast_with_an_80211_sized_payload() {
        let mut s = Sim::new(Air::full(5, -50), &[250; 5]);
        let body: Vec<u8> = (0..P).map(|i| i as u8).collect();
        s.nodes[0].net.send(BROADCAST, PORT_APP, &body, false).unwrap();
        s.run_ms(200);
        for i in 1..5 {
            let a = s.nodes[i].net.next_app().unwrap_or_else(|| panic!("node {i}"));
            assert_eq!((a.origin, a.port, &a.payload[..a.len]), (10, PORT_APP, &body[..]));
            assert!(s.nodes[i].net.next_app().is_none(), "node {i}: delivered once");
        }
        assert_eq!(s.nodes.iter().map(|n| n.stats.rx_rejected).sum::<u32>(), 0);
    }

    /// Unicast with ack over a lossy line of four: multi-hop relays on the virtual slot timer.
    #[test]
    fn unicast_is_acked_across_hops_despite_loss() {
        let air = Air::line(4);
        air.set_loss(0.2);
        let mut s = Sim::new(air, &[250; 4]);
        let id = s.nodes[0].net.send(13, PORT_APP + 1, b"cfg", true).unwrap();
        s.run_ms(3_000);
        let a = s.nodes[3].net.next_app().expect("delivered");
        assert_eq!((a.origin, a.port, &a.payload[..a.len]), (10, PORT_APP + 1, &b"cfg"[..]));
        for i in 1..3 {
            assert!(s.nodes[i].net.next_app().is_none(), "node {i} isn't the destination");
        }
        assert!(s.nodes[0].net.mesh.stats.acked >= 1, "acked: {:?} (id {id})", s.nodes[0].net.mesh.stats);
    }

    /// A node whose backhaul has a smaller MTU still delivers a big packet it hears but does
    /// not relay it (it would not fit its frames); the next node over is reached only through
    /// a relay that can carry it.
    #[test]
    fn a_small_mtu_relay_does_not_forward_what_it_cannot_carry() {
        let body = [0x42u8; 180];
        // 0 - 1 - 2: node 1 has a 160-byte MTU.
        let mut s = Sim::new(Air::line(3), &[250, 160, 250]);
        s.nodes[0].net.send(BROADCAST, PORT_APP, &body, false).unwrap();
        s.run_ms(200);
        assert!(s.nodes[1].net.next_app().is_some());
        assert!(s.nodes[2].net.next_app().is_none());
        assert_eq!(s.nodes[1].net.mesh.stats.oversize, 1);
        // With a full-size middle node it gets through.
        let mut s = Sim::new(Air::line(3), &[250, 250, 250]);
        s.nodes[0].net.send(BROADCAST, PORT_APP, &body, false).unwrap();
        s.run_ms(200);
        assert!(s.nodes[2].net.next_app().is_some());
    }

    /// The swarm's live settings over beacons: a bundle entering at one node reaches a late
    /// joiner (out of range at first) through the generation in its neighbours' Summaries.
    #[test]
    fn settings_catch_up_through_beacon_summaries() {
        let air = Air::full(3, -60);
        air.link(0, 2, None);
        air.link(1, 2, None);
        air.link(2, 0, None);
        air.link(2, 1, None);
        let mut s = Sim::new(air.clone(), &[250; 3]);
        let mut l = Layer::default();
        l.set(106, 7.0f32.to_bits());
        let mut b = [0u8; MAX_BUNDLE];
        let n = make_bundle(&l, 3, &HMAC, &mut b);
        assert!(s.nodes[0].net.host_bundle(&b[..n]));
        s.run_ms(500);
        assert_eq!(s.nodes[1].net.settings.get(106), Some(7.0f32.to_bits()));
        assert_eq!(s.nodes[2].net.settings.get(106), None, "out of range");
        air.link(1, 2, Some(-70));
        air.link(2, 1, Some(-70));
        s.run_ms(2_000);
        assert_eq!(s.nodes[2].net.settings.get(106), Some(7.0f32.to_bits()));
        assert!(s.nodes.iter().all(|n| n.stats.beacons > 0));
    }

    /// The swarm's firmware distribution end to end over the seam: manifest broadcast, page
    /// requests as link unicasts, data broadcasts, progress in beacon Summaries.
    #[test]
    fn firmware_enters_at_one_node_and_reaches_all() {
        let mut s = Sim::new(Air::full(4, -60), &[250; 4]);
        let img: Vec<u8> = (0..3 * PAGE_SIZE + 77).map(|i| (i % 253) as u8).collect();
        let mut m = Manifest::for_image(&img, 2, 0);
        m.sign(&FW_SECRET);
        {
            let (n, f) = (&mut s.nodes[0], &mut s.flash[0]);
            assert!(n.net.host_manifest(m.raw(), f));
            for (page, p) in img.chunks(PAGE_SIZE).enumerate() {
                for (c, d) in p.chunks(update::CHUNK).enumerate() {
                    n.net.host_chunk(0, page as u16, c as u8, d, f);
                }
            }
            assert!(n.net.take_changes().fw_ready);
            n.net.updater.running = 2;
            n.net.updater.set_validated(true);
        }
        s.run_ms(60_000);
        for (i, n) in s.nodes.iter().enumerate() {
            assert_eq!(n.net.updater.status(), Status::Serving, "node {i}: {:?}", n.net.updater.summary());
        }
        assert!(s.nodes.iter().all(|n| n.stats.rx_rejected == 0 && n.stats.tx_busy == 0));
    }

    /// Frames from another link version or garbage are counted and dropped, not panicked on.
    #[test]
    fn garbage_is_counted() {
        let air = Air::full(2, -50);
        let mut s = Sim::new(air.clone(), &[250; 2]);
        let mut rogue = air.port(1, 99, 250);
        rogue.send(&[0xff; 40], None).unwrap();
        let mut f = [0u8; 32];
        let n = link::encode(99, link::Frame::Mesh(b"x"), &mut f).unwrap();
        f[n - 1] = 2; // ver 2
        rogue.send(&f[..n], None).unwrap();
        s.run_ms(2);
        assert_eq!(s.nodes[0].stats.rx_rejected, 2);
    }
}
