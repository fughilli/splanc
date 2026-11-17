//! A mesh node over one backhaul: drives the ported `swarm_net` stack from the
//! [`Backhaul`] calls (design §3.1 item 1, §3.2).
//!
//! Upstream the UWB radio task called `Net::on_mesh` / `on_summary` / `on_fw_*` with each
//! frame it decoded and asked `Net::next_tx` for frames in its TDMA slot. A backhaul without
//! TDMA has no slots, so [`Node::tick`] runs a virtual slot timer (5 ms, the swarm's slot)
//! that drives the relay delays, and sends the node's Summary in a BEACON (the swarm sent it
//! in every POLL). The MAC's CSMA handles collisions.
//!
//! The backhaul's MTU sets the mesh payload limit ([`link::mesh_payload_for_mtu`]); the
//! mesh's capacity `P` (a const parameter of [`NetOf`]) sizes its buffers.
//!
//! Every frame passes a [`FrameGuard`] (M2): the security envelope ([`MeshSecurity`]) seals
//! each link frame on the way out and opens it on the way in, and its overhead comes off the
//! MTU before the payload is sized. [`Plain`] (no envelope) keeps M1's behaviour.
//!
//! [`MeshSecurity`]: crate::security::MeshSecurity

use swarm_net::net::NetOf;
use swarm_net::update::Flash;

use crate::backhaul::{Backhaul, RxMeta};
use crate::envelope::Header;
use crate::link::{self, Frame, Reject, MIN_MTU};
use crate::security::{FrameGuard, Opened, Plain};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NodeConfig {
    /// The virtual slot: relay delays count in these (the swarm's TDMA slot is 5 ms).
    pub slot_us: i64,
    /// Frames sent per slot at most (pacing; the swarm sent up to 3 per UWB slot).
    pub frames_per_slot: u8,
    /// How often the node's Summary goes out in a BEACON.
    pub beacon_us: i64,
    /// Bytes of each backhaul frame taken by anything around the link frame other than the
    /// guard (whose own overhead is added to this; the envelope is the guard's).
    pub frame_overhead: usize,
}

impl Default for NodeConfig {
    fn default() -> NodeConfig {
        NodeConfig { slot_us: 5_000, frames_per_slot: 3, beacon_us: 1_000_000, frame_overhead: 0 }
    }
}

/// The backhaul cannot carry the swarm's own frames.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MtuTooSmall {
    /// The backhaul's MTU less `frame_overhead`.
    pub mtu: usize,
    pub min: usize,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NodeStats {
    pub rx: u32,
    /// Malformed frames and other link versions.
    pub rx_rejected: u32,
    /// Well-formed frames that are not the mesh layer's (ranging).
    pub rx_not_mesh: u32,
    /// Our own frames heard back.
    pub rx_own: u32,
    pub tx: u32,
    pub beacons: u32,
    /// Frames dropped on `Busy` (see [`Backhaul::send`]).
    pub tx_busy: u32,
    /// Frames that did not encode (cannot happen within the MTU; counted, not panicked).
    pub tx_encode_failed: u32,
    /// Frames the guard would not seal (no key, counter spent).
    pub tx_unsealed: u32,
    /// Frames the guard dropped (bad MIC, replay, foreign mesh; the guard's stats say which).
    pub rx_guarded: u32,
    /// Plain frames handed to the caller ([`Node::poll_rx`]) or, from `tick`, dropped.
    pub rx_plain: u32,
    /// `tick` calls skipped because the scratch buffer was shorter than `scratch_len()`.
    pub scratch_short: u32,
}

/// What [`Node::poll_rx`] did with one received frame.
#[derive(Debug, PartialEq, Eq)]
pub enum Rx<'a> {
    /// Nothing received.
    Idle,
    /// A link frame, fed to the mesh (or dropped and counted).
    Handled,
    /// A plain frame (membership traffic) for the caller.
    Plain { meta: RxMeta, header: Header, body: &'a [u8] },
}

pub struct Node<B: Backhaul, const P: usize, G: FrameGuard = Plain> {
    pub net: NetOf<P>,
    pub backhaul: B,
    pub guard: G,
    pub cfg: NodeConfig,
    pub stats: NodeStats,
    /// The backhaul MTU less `frame_overhead` and the guard's overhead.
    mtu: usize,
    next_slot_us: Option<i64>,
    next_beacon_us: Option<i64>,
}

impl<B: Backhaul, const P: usize> Node<B, P, Plain> {
    /// Wrap `net` around `backhaul` without an envelope (M1).
    pub fn new(net: NetOf<P>, backhaul: B, cfg: NodeConfig) -> Result<Node<B, P, Plain>, MtuTooSmall> {
        Self::with_guard(net, backhaul, Plain, cfg)
    }
}

impl<B: Backhaul, const P: usize, G: FrameGuard> Node<B, P, G> {
    /// The largest body `Net::next_tx` produces at capacity `P`.
    pub const BODY_MAX: usize = NetOf::<P>::MAX_FRAME;
    /// The largest link frame this node builds.
    pub const FRAME_MAX: usize = link::link_overhead(true, Self::BODY_MAX) + Self::BODY_MAX;

    /// Wrap `net` around `backhaul` behind `guard`: the mesh payload limit comes from the
    /// backhaul's MTU less the guard's overhead.
    pub fn with_guard(mut net: NetOf<P>, backhaul: B, guard: G, cfg: NodeConfig) -> Result<Node<B, P, G>, MtuTooSmall> {
        let mtu = backhaul.mtu().saturating_sub(cfg.frame_overhead + guard.overhead());
        if mtu < MIN_MTU {
            return Err(MtuTooSmall { mtu, min: MIN_MTU });
        }
        net.mesh.set_max_payload(link::mesh_payload_for_mtu(mtu));
        Ok(Node { net, backhaul, guard, cfg, stats: NodeStats::default(), mtu, next_slot_us: None, next_beacon_us: None })
    }

    /// The link-frame MTU this node sizes frames for (the backhaul's, less overheads).
    pub fn mtu(&self) -> usize {
        self.mtu
    }

    /// The largest app payload this node sends or relays: the smaller of the mesh capacity
    /// `P` and what the backhaul MTU carries.
    pub fn max_payload(&self) -> usize {
        self.net.mesh.max_payload()
    }

    /// Bytes of scratch [`Node::tick`] needs: a received frame (up to the backhaul's MTU) or
    /// a body, its link frame and the sealed frame.
    pub fn scratch_len(&self) -> usize {
        let tx = Self::BODY_MAX + Self::FRAME_MAX + self.backhaul.mtu();
        let rx = self.backhaul.mtu();
        if rx > tx {
            rx
        } else {
            tx
        }
    }

    /// One received backhaul frame (for backhauls that hand frames over themselves; `tick`
    /// drains [`Backhaul::recv`] through this). The guard opens it in place; a link frame
    /// goes to the mesh, a plain frame comes back to the caller.
    pub fn on_rx<'f>(&mut self, now_us: i64, frame: &'f mut [u8], meta: &RxMeta, flash: &mut dyn Flash) -> Option<(Header, &'f [u8])> {
        match self.guard.open(now_us, frame) {
            Opened::Link(r) => {
                self.on_link(&frame[r], meta, flash);
                None
            }
            Opened::Plain { header, body } => {
                self.stats.rx_plain += 1;
                Some((header, &frame[body]))
            }
            Opened::Dropped => {
                self.stats.rx_guarded += 1;
                None
            }
        }
    }

    /// One link frame (already opened).
    pub fn on_link(&mut self, frame: &[u8], meta: &RxMeta, flash: &mut dyn Flash) {
        let r = match link::decode(frame) {
            Ok(r) => r,
            Err(Reject::NotMesh) => {
                self.stats.rx_not_mesh += 1;
                return;
            }
            Err(_) => {
                self.stats.rx_rejected += 1;
                return;
            }
        };
        let me = self.net.me();
        if r.src == me {
            self.stats.rx_own += 1;
            return;
        }
        self.stats.rx += 1;
        let t = meta.rx_us;
        match r.frame {
            Frame::Mesh(b) => self.net.on_mesh(t, b, meta.rssi_dbm as f32, flash),
            Frame::FwRequest { dest, payload } => {
                if dest == me {
                    self.net.on_fw_request(t, payload);
                }
            }
            Frame::FwData(b) => self.net.on_fw_data(t, b, flash),
            Frame::FwManifest(b) => self.net.on_fw_manifest(b, flash),
            Frame::Summary(s) => self.net.on_summary(t, r.src, s),
        }
    }

    /// Receive one frame from the backhaul: a link frame goes to the mesh, a plain frame is
    /// returned (its bytes in `scratch`). `scratch` must hold the backhaul's MTU.
    pub fn poll_rx<'s>(&mut self, now_us: i64, flash: &mut dyn Flash, scratch: &'s mut [u8]) -> Rx<'s> {
        let Some(meta) = self.backhaul.recv(scratch) else { return Rx::Idle };
        let len = meta.len.min(scratch.len());
        match self.on_rx(now_us, &mut scratch[..len], &meta, flash) {
            Some((header, body)) => Rx::Plain { meta, header, body },
            None => Rx::Handled,
        }
    }

    /// Send a plain frame (membership traffic, one hop, broadcast) through the guard.
    pub fn send_plain(&mut self, body: &[u8], scratch: &mut [u8]) -> bool {
        let Some(n) = self.guard.seal_plain(body, scratch) else {
            self.stats.tx_unsealed += 1;
            return false;
        };
        match self.backhaul.send(&scratch[..n], None) {
            Ok(()) => {
                self.stats.tx += 1;
                true
            }
            Err(_) => {
                self.stats.tx_busy += 1;
                false
            }
        }
    }

    /// Run the node: drain received frames (plain frames are counted and dropped: use
    /// [`Node::poll_rx`] to handle them), then [`Node::run_slot`]. Call often (every slot or
    /// faster). `scratch` must hold `scratch_len()` bytes.
    pub fn tick(&mut self, now_us: i64, flash: &mut dyn Flash, scratch: &mut [u8]) {
        if scratch.len() < self.scratch_len() {
            self.stats.scratch_short += 1;
            return;
        }
        while self.poll_rx(now_us, flash, scratch) != Rx::Idle {}
        self.run_slot(now_us, flash, scratch);
    }

    /// At each virtual slot boundary: advance the mesh's slot, do its housekeeping, send a
    /// due beacon and up to `frames_per_slot` frames, each sealed by the guard. Between
    /// boundaries only the mesh's timers run.
    pub fn run_slot(&mut self, now_us: i64, flash: &mut dyn Flash, scratch: &mut [u8]) {
        if scratch.len() < self.scratch_len() {
            self.stats.scratch_short += 1;
            return;
        }
        let next = *self.next_slot_us.get_or_insert(now_us);
        if now_us < next {
            self.net.poll(now_us, flash);
            return;
        }
        // Late by more than a slot (a long tick gap): restart the timer instead of bursting.
        let late = now_us - next >= self.cfg.slot_us;
        self.next_slot_us = Some(if late { now_us } else { next } + self.cfg.slot_us);
        self.net.on_my_slot();
        self.net.poll(now_us, flash);

        let me = self.net.me();
        let (body, rest) = scratch.split_at_mut(Self::BODY_MAX);
        let (frame, sealed) = rest.split_at_mut(Self::FRAME_MAX);
        let beacon_due = now_us >= *self.next_beacon_us.get_or_insert(now_us);
        if beacon_due && self.backhaul.may_send(now_us) && self.guard.can_seal() {
            let (s, n) = self.net.summary();
            if let Some(m) = link::encode(me, Frame::Summary(&s[..n]), frame) {
                if let Some(k) = self.guard.seal(now_us, &frame[..m], sealed) {
                    if self.backhaul.send(&sealed[..k], None).is_ok() {
                        self.stats.beacons += 1;
                        // Up to a quarter of the period early, varying per node and beacon, so
                        // nodes that powered up together never beacon in step.
                        let j = (me as u32).wrapping_mul(2_654_435_761).wrapping_add(self.stats.beacons.wrapping_mul(40_503)) as i64;
                        let jitter = j.rem_euclid((self.cfg.beacon_us / 4).max(1));
                        self.next_beacon_us = Some(now_us + self.cfg.beacon_us - jitter);
                    }
                }
            }
        }
        for _ in 0..self.cfg.frames_per_slot {
            if !self.backhaul.may_send(now_us) {
                break;
            }
            let Some((kind, n)) = self.net.next_tx(now_us, body, flash) else { break };
            let f = Frame::from_tx(kind, &body[..n]);
            let Some(m) = link::encode(me, f, frame) else {
                self.stats.tx_encode_failed += 1;
                continue;
            };
            let Some(k) = self.guard.seal(now_us, &frame[..m], sealed) else {
                self.stats.tx_unsealed += 1;
                continue;
            };
            match self.backhaul.send(&sealed[..k], f.dst()) {
                Ok(()) => self.stats.tx += 1,
                Err(_) => self.stats.tx_busy += 1,
            }
        }
    }
}
