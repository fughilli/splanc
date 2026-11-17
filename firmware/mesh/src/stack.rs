//! One device's mesh: [`Node`] (swarm_net over a backhaul) behind the envelope
//! ([`MeshSecurity`]), membership ([`Membership`]), admin sessions ([`Sessions`], and a
//! [`GatewaySession`] while an app is connected and unlocked), rotation ([`Rekeyer`],
//! [`RekeyMember`]), the port policy ([`Router`]) and the device's capacity class.
//!
//! This is the firmware-side runtime M3 drives from the netstack loop, a Pi runs in its std
//! build, and `meshsim` runs N of. It never blocks and never allocates: [`MeshStack::tick`]
//! does a bounded amount of work and reports through a callback ([`Event`]), so nothing here
//! can stall rendering (the owner's rule: effects keep running).
//!
//! **Capacity classes** (design §10.6): every advert carries the node's class (C6, P4 + C6,
//! Pi) and its relay credit (free relay slots). A C6 keeps `swarm_net`'s small queues, relays
//! bulk late (so a custodian's relay usually cancels its own) and drops bulk first under
//! pressure. A custodian (P4, Pi) relays bulk early, spills what its C6-side queue cannot hold
//! into a deep store on the P4 or in the Pi's RAM ([`CustodianStore`], [`MeshStack::pump_custodian`])
//! and releases it only while its neighbours advertise credit; page requests prefer
//! custodians as servers, so they carry the retransmissions.

#[cfg(feature = "custodian_spill")]
use swarm_net::mesh::Relay;
use swarm_net::mesh::BROADCAST;
use swarm_net::net::NetOf;
use swarm_net::update::Flash;

use crate::admin::{self, AdminGate, GatewaySession, Grant, SessionMsg, Sessions, UnlockError};
use crate::backhaul::{Backhaul, NodeId};
use crate::crypto::{key_hash, DeviceKey, Entropy, KeyHash};
use crate::envelope::{Header, MicLen};
#[cfg(feature = "open_mode")]
use crate::guest::{FollowEvent, Follower};
#[cfg(feature = "open_mode")]
use crate::membership::Follow;
use crate::membership::{Credentials, Groups, Membership, Mode, Note, Out, Phase, ProvisionSource};
#[cfg(feature = "open_mode")]
use crate::msg::GuestHello;
use crate::msg::{Advert, Capacity, Class, Command as MemberCommand, PendingJoin, T_ADVERT, T_PENDING_JOIN, T_PROBE};
use crate::node::{MtuTooSmall, Node, NodeConfig, Rx};
use crate::ports::{ControlHeader, Inbound, Port, Role, RouteCtx, RouteReject, Router, Targets};
use crate::rekey::{NewKeys, RekeyMember, RekeyMsg, RekeyOrder, Rekeyer};
use crate::security::{Domain, FrameGuard, MeshSecurity};

/// Largest plain frame (a `JoinAccept` in its envelope) plus room.
pub const PLAIN_MAX: usize = 192;
/// Neighbours whose class and credit a node tracks.
pub const NEIGHBOURS: usize = 8;
/// A gateway re-broadcasts its grant this often (members missing it also ask).
pub const GRANT_EVERY_US: i64 = 5_000_000;
/// Capacity-aware sources space bulk packets at least this far apart: credit in a 1 Hz advert
/// is far too slow to pace a burst (the stress sweep pushed 88 packets in 140 ms through a
/// 4-slot C6 cut vertex), so the pace itself is the backpressure.
pub const BULK_GAP_US: i64 = 20_000;
/// A gateway asks the app for a renewed grant this long before its grant expires, so a live
/// show never waits on a renewal (§7.9).
pub const RENEW_AHEAD_S: u32 = 600;
/// Session crypto jobs a gateway queues for its low-priority crypto task (member Acks; a
/// member that is not served re-acks).
pub const CRYPTO_ACKS: usize = 2;
/// A gateway sends under a rotation's new key once every member acked, or after this long.
pub const SWITCH_AFTER_US: i64 = 20_000_000;
/// The largest live update body (a compact batch of uniforms, §5.4 / Q13).
pub const LIVE_MAX: usize = 48;
/// The largest hop limit (the MeshPacket field's bound).
pub const MAX_HOPS: u8 = 15;
/// How often a node floods its diameter probe, and how long an observation counts.
pub const PROBE_EVERY_US: i64 = 60_000_000;
pub const DIAMETER_WINDOW_US: i64 = 300_000_000;
/// The first bulk port (`swarm_net` relays it at the lowest priority).
pub const BULK_FROM: u8 = Port::Bulk as u8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StackConfig {
    pub node: NodeConfig,
    pub mic: MicLen,
    /// How often a member sends its advert (§5.3 BEACON's public part).
    pub advert_us: i64,
    /// The persisted counter high-water mark (§7.5).
    pub counter_mark: u64,
    pub firmware: u32,
    /// The public key firmware and blob manifests are signed with (the page protocol).
    pub fw_key: [u8; 65],
    pub class: Class,
    /// Capacity-aware relaying (bulk bias, spill, page-server preference, credit-paced bulk).
    /// Off: every node behaves as a C6 (the uniform-small-queue baseline of the sweeps).
    pub capacity_aware: bool,
    /// Hops a packet this node originates may take when `adaptive_hops` is off (a
    /// per-install setting, up to 15; the swarm's 3 is too few for line venues).
    pub hop_limit: u8,
    /// Adapt the hop limit to the mesh's diameter (§10.6): the most hops any packet took to
    /// reach this node or its neighbours in the last 5 min, plus one (2..=15), discovered by
    /// a probe flood at the maximum limit once a minute.
    pub adaptive_hops: bool,
}

impl Default for StackConfig {
    fn default() -> Self {
        StackConfig {
            node: NodeConfig::default(),
            mic: MicLen::M8,
            advert_us: 1_000_000,
            counter_mark: 0,
            firmware: 0,
            fw_key: [0; 65],
            class: Class::C6,
            capacity_aware: true,
            hop_limit: 5,
            adaptive_hops: true,
        }
    }
}

/// What happened, for the device (dispatch, persist, tell the app).
#[derive(Debug, PartialEq, Eq)]
pub enum Event<'a> {
    /// Relayed control for this node (§5.4): dispatch `inner` as a ClientMessage.
    Control { origin: NodeId, header: ControlHeader, inner: &'a [u8] },
    /// Another non-membership port's packet (reply, status, scene, time base, bulk).
    Packet { origin: NodeId, port: Port, body: &'a [u8], admin: bool },
    /// A device waits for approval (gateway: "New fixture nearby: admit?").
    Pending(PendingJoin),
    /// A guest said hello (open mode).
    #[cfg(feature = "open_mode")]
    Guest(GuestHello),
    /// This device joined (or re-keyed): persist the mesh state.
    Joined { epoch: u8 },
    /// A rotation installed a new epoch (and site secret): persist the mesh state.
    Rekeyed { epoch: u8 },
    /// Membership state changed (groups, mode, allow-list): persist it.
    StateChanged,
    /// Persist this frame-counter mark before it is needed (§7.5; once per 2^16 frames).
    PersistCounter(u64),
    /// An admin session's gateway confirmed our freshness: its commands are accepted.
    SessionSynced { session: u32, gateway: NodeId },
    /// Gateway: this session's grant expires at `not_after` (mesh seconds); the app should
    /// sign a renewal (same session, later expiry) and present it with `unlock`.
    GrantRenewalDue { session: u32, not_after: u32 },
    #[cfg(feature = "open_mode")]
    FollowStarted { mesh_id: u32 },
    #[cfg(feature = "open_mode")]
    FollowStopped,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendError {
    /// The connection has not presented a valid grant.
    Locked,
    /// Not a member (no key yet).
    NotMember,
    /// No member has acknowledged the session yet.
    NoRecipients,
    /// Too big for one mesh packet, or the mesh's TX queue is full.
    TooBig,
    QueueFull,
    /// The frame counter's reservation has not been persisted yet.
    Counter,
    /// The rekey order does not verify or does not match the keys.
    BadOrder,
}

/// Where a custodian keeps relays its C6-side queue cannot hold: P4 RAM over SDIO, or a Pi's
/// RAM. A standalone C6 has none ([`NoStore`]).
#[cfg(feature = "custodian_spill")]
pub trait CustodianStore<const P: usize> {
    /// Keep a relay; false if the store is full (the relay is dropped).
    fn push(&mut self, now_us: i64, r: Relay<P>) -> bool;
    /// The oldest relay ready to go back (its SDIO transfer, if any, done).
    fn pop(&mut self, now_us: i64) -> Option<Relay<P>>;
    fn len(&self) -> usize;
    fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// A standalone C6: no custodian store.
#[cfg(feature = "custodian_spill")]
pub struct NoStore;

#[cfg(feature = "custodian_spill")]
impl<const P: usize> CustodianStore<P> for NoStore {
    fn push(&mut self, _: i64, _: Relay<P>) -> bool {
        false
    }
    fn pop(&mut self, _: i64) -> Option<Relay<P>> {
        None
    }
    fn len(&self) -> usize {
        0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Neighbour {
    pub id: NodeId,
    pub capacity: Capacity,
    pub diameter: u8,
    pub last_us: i64,
}

/// A command waiting for its session to sync (one at a time: the newest wins).
struct Held<const P: usize> {
    origin: NodeId,
    port: u8,
    len: usize,
    buf: [u8; P],
}

pub struct MeshStack<B: Backhaul, const P: usize, K: DeviceKey, E: Entropy, const R: usize = 16> {
    pub node: Node<B, P, MeshSecurity>,
    pub membership: Membership,
    pub router: Router,
    pub sessions: Sessions,
    /// This device as a gateway: the session it holds a grant for, and its roster.
    pub gateway: Option<GatewaySession<R>>,
    pub rekeyer: Option<Rekeyer>,
    pub rekey_member: RekeyMember,
    #[cfg(feature = "open_mode")]
    pub follower: Follower,
    pub gate: AdminGate,
    pub dev: K,
    pub rng: E,
    pub neighbours: [Option<Neighbour>; NEIGHBOURS],
    cfg: StackConfig,
    next_advert_us: Option<i64>,
    next_grant_us: Option<i64>,
    last_bulk_us: Option<i64>,
    /// The (mesh id, epoch, key) installed in the envelope.
    installed: Option<(u32, u8, [u8; 16])>,
    held: Option<Held<P>>,
    /// The pending live update (coalesced: a newer one replaces it before it is sent).
    live: Option<(usize, u32, Targets, usize, [u8; LIVE_MAX])>,
    /// Live updates replaced before they could be sent (the airtime-bound rate).
    pub live_coalesced: u32,
    /// Live updates sent, and the op id of the last one (for measurement).
    pub live_sent: u32,
    pub live_last_op: u32,
    /// The most hops a packet took to reach us, and when (adaptive hop limit).
    hops_seen: (u8, i64),
    next_probe_us: Option<i64>,
    /// Session crypto waiting for [`MeshStack::run_crypto`]: the newest grant needing a
    /// verify, and member Acks needing an ECDH (gateway).
    pending_grant: Option<Grant>,
    pending_acks: [Option<SessionMsg>; CRYPTO_ACKS],
    renewal_asked: Option<(u32, u32)>,
    /// Session crypto jobs run so far (ECDSA verifies and ECDHs).
    pub crypto_jobs: u32,
    plain_tx: [u8; PLAIN_MAX],
    plain_sealed: [u8; PLAIN_MAX + 32],
}

fn mesh_time_s(now_us: i64) -> u32 {
    // TODO(M4): mesh time from `timesync::MeshClock`; until then the local clock.
    (now_us.max(0) / 1_000_000) as u32
}

impl<B: Backhaul, const P: usize, K: DeviceKey, E: Entropy, const R: usize> MeshStack<B, P, K, E, R> {
    pub fn new(me: NodeId, mac: [u8; 6], backhaul: B, dev: K, mut rng: E, mut cfg: StackConfig) -> Result<Self, MtuTooSmall> {
        let mut net = NetOf::<P>::new(me, None, cfg.fw_key, cfg.firmware, rng.u32());
        net.mesh.cfg.high_ports = Port::HIGH_PRIORITY;
        net.mesh.cfg.hop_limit = cfg.hop_limit.clamp(1, MAX_HOPS);
        net.mesh.cfg.bulk_from = BULK_FROM;
        if cfg.capacity_aware {
            // No relay-delay bias by class (`bulk_relay_bias` stays 0): the stress sweep showed
            // a custodian relaying early makes a C6 cut vertex hear the duplicate and cancel
            // the only relay toward the far side (far-cluster delivery 3 %). The flood's
            // RSSI-based delay is what gives coverage; capacity must not override it.
            #[cfg(feature = "custodian_spill")]
            {
                net.mesh.spill = cfg.class.custodian();
            }
        } else {
            cfg.class = Class::C6;
        }
        let guard = MeshSecurity::new(me, cfg.mic, backhaul.mtu(), cfg.counter_mark);
        let node = Node::with_guard(net, backhaul, guard, cfg.node)?;
        #[cfg(feature = "open_mode")]
        let kh = key_hash(&dev.public_key());
        Ok(MeshStack {
            node,
            membership: Membership::new(me, mac, cfg.firmware),
            router: Router::new(),
            sessions: Sessions::new(),
            gateway: None,
            rekeyer: None,
            rekey_member: RekeyMember::default(),
            #[cfg(feature = "open_mode")]
            follower: Follower::new(Follow::Off, me, kh, cfg.firmware),
            gate: AdminGate::new(),
            dev,
            rng,
            neighbours: [None; NEIGHBOURS],
            cfg,
            next_advert_us: None,
            next_grant_us: None,
            last_bulk_us: None,
            installed: None,
            held: None,
            live: None,
            live_coalesced: 0,
            live_sent: 0,
            live_last_op: 0,
            hops_seen: (0, 0),
            next_probe_us: None,
            pending_grant: None,
            pending_acks: [None; CRYPTO_ACKS],
            renewal_asked: None,
            crypto_jobs: 0,
            plain_tx: [0; PLAIN_MAX],
            plain_sealed: [0; PLAIN_MAX + 32],
        })
    }

    pub fn me(&self) -> NodeId {
        self.membership.me
    }

    pub fn class(&self) -> Class {
        self.cfg.class
    }

    pub fn key_hash(&self) -> KeyHash {
        key_hash(&self.dev.public_key())
    }

    pub fn scratch_len(&self) -> usize {
        self.node.scratch_len()
    }

    /// Provision (either path, §7.9) and start looking for the mesh.
    pub fn provision(&mut self, now_us: i64, c: &Credentials, source: ProvisionSource) {
        self.membership.provision(c, source, now_us);
        self.sync_keys(now_us);
    }

    /// The `mesh_follow` device setting (§7.2).
    #[cfg(feature = "open_mode")]
    pub fn set_follow(&mut self, f: Follow) {
        self.membership.follow = f;
        self.follower.setting = f;
    }

    fn sync_keys(&mut self, now_us: i64) {
        let Some(s) = self.membership.state else { return };
        let g = &mut self.node.guard;
        if s.has_key() {
            let want = (s.mesh_id, s.epoch, s.mesh_key);
            if self.installed != Some(want) {
                g.set_member(now_us, s.mesh_id, s.epoch, &s.mesh_key);
                self.installed = Some(want);
            }
        } else if g.domain() != Domain::Guest {
            g.set_none(s.mesh_id);
            self.installed = None;
        }
    }

    fn may_transmit(&self) -> bool {
        self.node.guard.domain() == Domain::Member && matches!(self.membership.phase(), Phase::Member | Phase::Joining)
    }

    fn send_plain_buf(&mut self, n: usize) {
        let body = self.plain_tx;
        self.node.send_plain(&body[..n], &mut self.plain_sealed);
    }

    fn handle_note(&mut self, now_us: i64, note: Note, on: &mut dyn FnMut(Event<'_>)) {
        match note {
            Note::None => {}
            Note::KeysChanged => {
                self.sync_keys(now_us);
                if let Some(s) = self.membership.state.filter(|_| self.membership.is_member()) {
                    on(Event::Joined { epoch: s.epoch });
                }
            }
            Note::StateChanged => on(Event::StateChanged),
            Note::Pending(p) => on(Event::Pending(p)),
            #[cfg(feature = "open_mode")]
            Note::Guest(g) => on(Event::Guest(g)),
        }
    }

    /// This node's estimate of the mesh diameter: its own and its neighbours' observations
    /// from the last 5 minutes.
    pub fn diameter(&self, now_us: i64) -> u8 {
        let own = if now_us - self.hops_seen.1 < DIAMETER_WINDOW_US { self.hops_seen.0 } else { 0 };
        self.neighbours.iter().flatten().filter(|n| now_us - n.last_us < DIAMETER_WINDOW_US).map(|n| n.diameter).fold(own.max(1), u8::max)
    }

    /// The hop limit this node originates with now.
    pub fn hop_limit(&self, now_us: i64) -> u8 {
        if self.cfg.adaptive_hops {
            (self.diameter(now_us) + 1).clamp(2, MAX_HOPS)
        } else {
            self.cfg.hop_limit.clamp(1, MAX_HOPS)
        }
    }

    fn note_neighbour(&mut self, now_us: i64, id: NodeId, capacity: Capacity, diameter: u8) {
        let i = self
            .neighbours
            .iter()
            .position(|n| n.is_some_and(|n| n.id == id))
            .or_else(|| self.neighbours.iter().position(|n| n.is_none()))
            .unwrap_or_else(|| (0..NEIGHBOURS).min_by_key(|&i| self.neighbours[i].map_or(i64::MIN, |n| n.last_us)).unwrap_or(0));
        self.neighbours[i] = Some(Neighbour { id, capacity, diameter, last_us: now_us });
        if self.cfg.capacity_aware {
            let mut pref = [0xFFFFu16; swarm_net::update::PREFERRED];
            for (p, n) in pref.iter_mut().zip(self.neighbours.iter().flatten().filter(|n| n.capacity.class.custodian() && now_us - n.last_us < 5_000_000)) {
                *p = n.id;
            }
            self.node.net.updater.set_preferred(&pref);
        }
    }

    /// May this node originate the next bulk packet now? Room in its outbox, and (capacity-
    /// aware) every constrained neighbour advertising at least two free relay slots: a source
    /// holds bulk back (in its own deep store, on a custodian) instead of overrunning the C6s
    /// that must relay it.
    pub fn bulk_clear_to_send(&self, now_us: i64) -> bool {
        let paced = self.last_bulk_us.is_none_or(|t| now_us - t >= BULK_GAP_US);
        self.node.net.mesh.can_send() && (!self.cfg.capacity_aware || (paced && self.min_neighbour_credit(now_us) >= 2))
    }

    /// Originate one bulk packet (broadcast on `BULK`) if [`MeshStack::bulk_clear_to_send`].
    pub fn send_bulk(&mut self, now_us: i64, body: &[u8]) -> Result<u16, SendError> {
        if !self.bulk_clear_to_send(now_us) {
            return Err(SendError::QueueFull);
        }
        let id = self.send(BROADCAST, Port::Bulk, body, false)?;
        self.last_bulk_us = Some(now_us);
        Ok(id)
    }

    /// The lowest relay credit any recently heard neighbour advertises (custodians release
    /// stored bulk only while it is positive).
    pub fn min_neighbour_credit(&self, now_us: i64) -> u8 {
        self.neighbours.iter().flatten().filter(|n| now_us - n.last_us < 3_000_000 && !n.capacity.class.custodian()).map(|n| n.capacity.credit).min().unwrap_or(u8::MAX)
    }

    /// Run the device's mesh for one step: receive, timers, adverts, sessions, the mesh slot,
    /// deliver. `scratch` must hold `scratch_len()` bytes. Bounded work; never blocks.
    pub fn tick(&mut self, now_us: i64, flash: &mut dyn Flash, scratch: &mut [u8], on: &mut dyn FnMut(Event<'_>)) {
        // 1. Receive: link frames into the mesh, plain frames to membership.
        loop {
            let before = self.node.guard.stats;
            match self.node.poll_rx(now_us, flash, scratch) {
                Rx::Idle => break,
                Rx::Handled => {
                    let after = self.node.guard.stats;
                    if after.opened > before.opened {
                        self.membership.note_rx(true);
                    } else if after.bad_mic > before.bad_mic {
                        self.membership.note_rx(false);
                    }
                }
                Rx::Plain { header, body, .. } => {
                    let mut buf = [0u8; PLAIN_MAX];
                    let n = body.len().min(PLAIN_MAX);
                    buf[..n].copy_from_slice(&body[..n]);
                    self.on_plain(now_us, &header, &buf[..n], on);
                }
            }
        }
        // 2. Membership timers (bounded).
        for _ in 0..4 {
            let was = self.membership.phase();
            let out = self.membership.poll(now_us, &self.dev, &mut self.rng, &mut self.plain_tx);
            if self.membership.phase() != was {
                self.sync_keys(now_us);
                if self.membership.is_member() {
                    on(Event::Joined { epoch: self.membership.state.map(|s| s.epoch).unwrap_or(0) });
                }
            }
            match out {
                None => break,
                Some(Out::Plain(n)) => self.send_plain_buf(n),
                Some(Out::Mesh { port, len }) => {
                    let body = self.plain_tx;
                    self.node.net.send(BROADCAST, port as u8, &body[..len], false);
                }
            }
        }
        // 3. Adverts while a member, with this node's capacity.
        if self.membership.is_member() && now_us >= *self.next_advert_us.get_or_insert(now_us) {
            // Jittered like the beacon (a quarter of the period), so adverts never fall in step.
            let jitter = (self.rng.u32() as i64).rem_euclid((self.cfg.advert_us / 4).max(1));
            self.next_advert_us = Some(now_us + self.cfg.advert_us - jitter);
            let mtu = (self.node.mtu() + self.node.guard.overhead()) as u16;
            let capacity = Capacity { class: self.cfg.class, credit: self.node.net.mesh.relay_room() as u8 };
            let epoch = self.node.guard.epoch().unwrap_or(0);
            let diameter = self.diameter(now_us);
            if let Some(n) = self.membership.advert(&mut self.rng, 0, mtu, capacity, epoch, diameter, &mut self.plain_tx) {
                self.send_plain_buf(n);
            }
        }
        // 4. The follower (guests).
        #[cfg(feature = "open_mode")]
        match self.follower.poll(now_us) {
            FollowEvent::Stopped => self.follow_stopped(on),
            FollowEvent::Hello(h) => {
                if let Some(n) = h.encode(&mut self.plain_tx) {
                    self.send_plain_buf(n);
                }
            }
            _ => {}
        }
        // 5. Sessions: unconfirmed acks; the gateway's grant; a rotation in progress.
        if self.membership.is_member() {
            if let Some((gw, ack)) = self.sessions.due_ack(now_us, self.me(), &self.dev) {
                self.send_session(gw, &ack, false);
            }
            if let Some(g) = self.gateway.as_ref().map(|g| g.grant) {
                // Ask for a renewal well before expiry, once per expiry.
                let now_s = mesh_time_s(now_us);
                if g.not_after.saturating_sub(now_s) <= RENEW_AHEAD_S && self.renewal_asked != Some((g.session, g.not_after)) {
                    self.renewal_asked = Some((g.session, g.not_after));
                    on(Event::GrantRenewalDue { session: g.session, not_after: g.not_after });
                }
                if now_us >= *self.next_grant_us.get_or_insert(now_us) {
                    self.next_grant_us = Some(now_us + GRANT_EVERY_US);
                    self.send_session(BROADCAST, &SessionMsg::Grant(g), false);
                }
            }
            // Only when the outbox has room: a packet the mesh can't queue would be lost
            // until the next round (a C6 gateway's outbox holds 4).
            if let (Some(rk), Some(gs), true) = (self.rekeyer.as_mut(), self.gateway.as_ref(), self.node.net.mesh.can_send()) {
                let mut b = [0u8; 200];
                if let Some(n) = rk.next_packet(now_us, gs, &mut b) {
                    self.node.net.send(BROADCAST, Port::Freshness as u8, &b[..n], false);
                }
            }
        }
        // 5. (cont.) The pending live update goes out as soon as the mesh can queue it.
        if self.live.is_some() && self.node.net.mesh.can_send() {
            if let Some((conn, op, targets, n, buf)) = self.live.take() {
                if self.send_control(now_us, conn, op, targets, &buf[..n]).is_ok() {
                    self.live_sent += 1;
                    self.live_last_op = op;
                }
            }
        }
        // 5a. The adaptive hop limit, and its probe flood (the first within 10 s of joining).
        if self.membership.is_member() {
            self.node.net.mesh.cfg.hop_limit = self.hop_limit(now_us);
            if self.cfg.adaptive_hops {
                let first = now_us + (self.rng.u32() % 10_000_000) as i64;
                if now_us >= *self.next_probe_us.get_or_insert(first) {
                    self.next_probe_us = Some(now_us + PROBE_EVERY_US);
                    self.node.net.mesh.send_with_hops(BROADCAST, Port::Status as u8, &[T_PROBE], false, MAX_HOPS);
                }
            }
        }
        // 5b. The rotation's switch: a gateway once everyone acked (or after 20 s), others as
        // soon as they hear a frame under the new key (only its holders can make one).
        let gw_ready = self.rekeyer.as_ref().is_some_and(|rk| rk.done_us.is_some() || now_us - rk.started_us >= SWITCH_AFTER_US);
        if self.node.guard.next_epoch().is_some() && (self.node.guard.take_heard_next() || gw_ready) {
            self.node.guard.switch_to_next(now_us);
        }
        // 6. The mesh slot.
        if self.may_transmit() {
            self.node.run_slot(now_us, flash, scratch);
        }
        if let Some(m) = self.node.guard.wants_counter_reservation() {
            on(Event::PersistCounter(m));
        }
        // 7. Deliver application packets through the port policy.
        while let Some(pkt) = self.node.net.next_app() {
            if pkt.hops >= self.hops_seen.0 || now_us - self.hops_seen.1 >= DIAMETER_WINDOW_US {
                self.hops_seen = (pkt.hops, now_us);
            }
            self.deliver(now_us, pkt.origin, pkt.port, &pkt.payload[..pkt.len], on);
        }
    }

    #[cfg(feature = "custodian_spill")]
    /// A custodian's queue pump (P4 + C6, Pi): move what the drop policy evicted into the
    /// store, and put stored relays back while there is room here and credit next door.
    /// Call every tick on a custodian; a C6 doesn't.
    pub fn pump_custodian(&mut self, now_us: i64, store: &mut dyn CustodianStore<P>) {
        let mesh = &mut self.node.net.mesh;
        if let Some(r) = mesh.take_spilled() {
            if !store.push(now_us, r) {
                mesh.stats.dropped_full += 1;
            }
        }
        let credit = self.min_neighbour_credit(now_us);
        let mesh = &mut self.node.net.mesh;
        if credit > 0 && mesh.relay_room() > 1 {
            if let Some(r) = store.pop(now_us) {
                if !mesh.requeue_relay(r) {
                    store.push(now_us, r);
                }
            }
        }
    }

    fn send_session(&mut self, to: NodeId, m: &SessionMsg, want_ack: bool) {
        let mut b = [0u8; 200];
        if let Some(n) = m.encode(&mut b) {
            self.node.net.send(to, Port::Freshness as u8, &b[..n], want_ack && to != BROADCAST);
        }
    }

    fn on_plain(&mut self, now_us: i64, h: &Header, body: &[u8], on: &mut dyn FnMut(Event<'_>)) {
        if body.first() == Some(&T_ADVERT) {
            if let Some(a) = Advert::decode(body) {
                if Some(h.mesh_id) == self.membership.mesh_id() {
                    self.note_neighbour(now_us, h.src, a.capacity, a.diameter);
                }
                #[cfg(feature = "open_mode")]
                if self.membership.state.is_none() {
                    match self.follower.on_advert(now_us, h, &a) {
                        FollowEvent::Started { mesh_id, open_key } => {
                            self.node.guard.set_guest(mesh_id, open_key);
                            on(Event::FollowStarted { mesh_id });
                        }
                        FollowEvent::Stopped => self.follow_stopped(on),
                        _ => {}
                    }
                    return;
                }
            }
        }
        let (out, note) = self.membership.on_plain(now_us, h, body, &self.dev, &mut self.plain_tx);
        if let Some(Out::Plain(n)) = out {
            self.send_plain_buf(n);
        }
        self.handle_note(now_us, note, on);
    }

    #[cfg(feature = "open_mode")]
    fn follow_stopped(&mut self, on: &mut dyn FnMut(Event<'_>)) {
        let id = self.node.guard.mesh_id;
        self.node.guard.set_none(id);
        on(Event::FollowStopped);
    }

    fn deliver(&mut self, now_us: i64, origin: NodeId, port: u8, payload: &[u8], on: &mut dyn FnMut(Event<'_>)) {
        #[cfg(feature = "open_mode")]
        let role = if self.node.guard.domain() == Domain::Guest { Role::Guest } else { Role::Member };
        #[cfg(not(feature = "open_mode"))]
        let role = Role::Member;
        let ctx = RouteCtx {
            mesh_id: self.node.guard.mesh_id,
            me: self.me(),
            role,
            groups: self.membership.groups(),
            mesh_time_s: mesh_time_s(now_us),
        };
        let r = self.router.route(&ctx, &mut self.sessions, origin, port, payload);
        let Inbound { origin, port, body, admin } = match r {
            Ok(i) => i,
            Err(RouteReject::Held { session }) => {
                // Hold it (the newest wins) and ask the gateway for the grant if we lack it.
                if payload.len() <= P {
                    let mut buf = [0u8; P];
                    buf[..payload.len()].copy_from_slice(payload);
                    self.held = Some(Held { origin, port, len: payload.len(), buf });
                }
                if self.sessions.get(session).is_none() {
                    self.send_session(origin, &SessionMsg::Request { session, node: self.me() }, false);
                }
                return;
            }
            Err(_) => return,
        };
        match port {
            Port::Freshness => self.on_freshness(now_us, origin, body, on),
            Port::Membership => {
                if let Some(c) = MemberCommand::decode(body) {
                    let note = self.membership.on_command(now_us, &c);
                    self.handle_note(now_us, note, on);
                }
            }
            Port::Status if body.first() == Some(&T_PROBE) => {}
            Port::Status if body.first() == Some(&T_PENDING_JOIN) => {
                if let Some(p) = PendingJoin::decode(body) {
                    let note = self.membership.on_pending(&p);
                    self.handle_note(now_us, note, on);
                }
            }
            Port::Control => {
                if let Some((header, inner)) = ControlHeader::decode(body) {
                    on(Event::Control { origin, header, inner });
                }
            }
            _ => on(Event::Packet { origin, port, body, admin }),
        }
    }

    fn on_freshness(&mut self, now_us: i64, origin: NodeId, body: &[u8], on: &mut dyn FnMut(Event<'_>)) {
        let me = self.me();
        let mesh_id = self.node.guard.mesh_id;
        if let Some(m) = SessionMsg::decode(body) {
            match m {
                SessionMsg::Grant(g) => {
                    if g.gateway == me {
                        return;
                    }
                    if self.sessions.needs_crypto(&g) {
                        // A new session or a renewal: verify off this path (run_crypto).
                        self.pending_grant = Some(g);
                        return;
                    }
                    let admin_key = self.membership.admin_key().copied();
                    if let Ok(Some(ack)) = self.sessions.on_grant(now_us, mesh_time_s(now_us), &g, admin_key.as_ref(), mesh_id, me, &self.dev, &mut self.rng) {
                        self.send_session(g.gateway, &ack, false);
                    }
                }
                SessionMsg::Ack { .. } => {
                    // The Ack's MAC needs an ECDH with the member's key: queue it for
                    // run_crypto (a member whose Ack is dropped here re-acks).
                    if self.gateway.is_some() {
                        if let Some(slot) = self.pending_acks.iter_mut().find(|a| a.is_none()) {
                            *slot = Some(m);
                        }
                    }
                }
                SessionMsg::Confirm { session, .. } => {
                    if let Some((gw, ctr)) = self.sessions.on_confirm(origin, &m, me) {
                        // The gateway's counter, vouched for by its device key: this also
                        // re-syncs its per-hop replay state (undoing any insider's inflation).
                        self.node.guard.sync_source(now_us, gw, ctr);
                        on(Event::SessionSynced { session, gateway: gw });
                        if let Some(h) = self.held.take() {
                            let buf = h.buf;
                            self.deliver(now_us, h.origin, h.port, &buf[..h.len], on);
                        }
                    }
                }
                SessionMsg::Request { session, .. } => {
                    if let Some(g) = self.gateway.as_ref().map(|g| g.grant).filter(|g| g.session == session) {
                        self.send_session(BROADCAST, &SessionMsg::Grant(g), false);
                    }
                }
            }
            return;
        }
        if let Some(m) = RekeyMsg::decode(body) {
            if let RekeyMsg::Ack { .. } = m {
                if let (Some(rk), Some(gs)) = (self.rekeyer.as_mut(), self.gateway.as_ref()) {
                    rk.on_ack(now_us, &m, gs);
                }
                return;
            }
            let admin_key = self.membership.admin_key().copied();
            let (keys, ack) = self.rekey_member.on_msg(&m, origin, me, mesh_id, &self.sessions, admin_key.as_ref());
            if let Some(k) = keys {
                self.install(now_us, &k, on);
            }
            if let Some(a) = ack {
                let mut b = [0u8; 32];
                if let Some(n) = a.encode(&mut b) {
                    self.node.net.send(origin, Port::Freshness as u8, &b[..n], false);
                }
            }
        }
    }

    /// New keys from a rotation: persisted at once, accepted on receive at once, used to
    /// send only at the switch (§7.6).
    fn install(&mut self, _now_us: i64, k: &NewKeys, on: &mut dyn FnMut(Event<'_>)) {
        self.membership.install_rekey(k);
        if let Some(s) = self.membership.state {
            self.node.guard.stage_next(s.mesh_id, k.epoch, &k.mesh_key);
            self.installed = Some((s.mesh_id, k.epoch, k.mesh_key));
        }
        on(Event::Rekeyed { epoch: k.epoch });
    }

    /// Session crypto waiting (a grant to verify, Acks to check).
    pub fn crypto_pending(&self) -> bool {
        self.pending_grant.is_some() || self.pending_acks.iter().any(|a| a.is_some())
    }

    /// Run one session crypto job (an ECDSA verify plus an ECDH, or one ECDH). Firmware
    /// calls this from a low-priority task, never from the render path: it costs
    /// milliseconds on a C6 (estimated; measured in M3a) and only happens at unlock, on a
    /// gateway switch, at grant renewal and when a member (re)joins a session — never per
    /// command (design §7.9). Returns whether it did anything.
    pub fn run_crypto(&mut self, now_us: i64) -> bool {
        let me = self.me();
        let mesh_id = self.node.guard.mesh_id;
        if let Some(g) = self.pending_grant.take() {
            self.crypto_jobs += 1;
            let admin_key = self.membership.admin_key().copied();
            if let Ok(Some(ack)) = self.sessions.on_grant(now_us, mesh_time_s(now_us), &g, admin_key.as_ref(), mesh_id, me, &self.dev, &mut self.rng) {
                self.send_session(g.gateway, &ack, false);
            }
            return true;
        }
        if let Some(m) = self.pending_acks.iter_mut().find_map(|a| a.take()) {
            self.crypto_jobs += 1;
            let counter = self.node.guard.current_counter();
            if let Some(gs) = self.gateway.as_mut() {
                if let Some((to, conf)) = gs.on_ack(&m, &self.dev, mesh_id, me, counter) {
                    self.send_session(to, &conf, false);
                }
            }
            return true;
        }
        false
    }

    // ---- Gateway side (any fixture an app or bridge is connected to, §8.2) ----

    /// `mesh_unlock{grant}` on connection `conn` (§7.9): the app signed a grant for this
    /// gateway. The grant is broadcast; members ack, and are commanded once confirmed.
    pub fn unlock(&mut self, now_us: i64, conn: usize, grant: &Grant) -> Result<(), UnlockError> {
        let mesh_id = self.membership.mesh_id().unwrap_or(0);
        let admin_key = self.membership.admin_key().copied();
        let my_key = self.dev.public_key();
        self.gate.unlock(now_us, mesh_time_s(now_us), conn, grant, admin_key.as_ref(), mesh_id, self.me(), &my_key)?;
        match self.gateway.as_mut() {
            // A renewal keeps the roster and its pairwise keys; members verify the new expiry.
            Some(gs) if gs.grant.session == grant.session => {
                if gs.renew(*grant) {
                    self.next_grant_us = Some(now_us);
                }
            }
            _ => {
                self.gateway = Some(GatewaySession::new(*grant));
                self.next_grant_us = Some(now_us);
            }
        }
        Ok(())
    }

    /// Originate an admin-class packet for an unlocked connection: MAC'd for each recipient
    /// in the session roster (all of it, or `only`), split over as many packets as needed.
    /// `MEMBERSHIP` commands also apply here. Returns the number of packets sent.
    pub fn send_admin(&mut self, now_us: i64, conn: usize, port: Port, body: &[u8], only: Option<&[NodeId]>) -> Result<usize, SendError> {
        let session = self.gate.session(conn).ok_or(SendError::Locked)?;
        if !self.membership.is_member() {
            return Err(SendError::NotMember);
        }
        let gs = self.gateway.as_ref().filter(|g| g.grant.session == session).ok_or(SendError::Locked)?;
        let mut rec = [(0u16, [0u8; 16]); R];
        let mut n = 0;
        for e in gs.roster().filter(|e| only.is_none_or(|o| o.contains(&e.node))) {
            rec[n] = (e.node, e.key);
            n += 1;
        }
        if n == 0 {
            return Err(SendError::NoRecipients);
        }
        let per = admin::recipients_per_packet(self.node.max_payload(), body.len());
        if per == 0 {
            return Err(SendError::TooBig);
        }
        let mesh_id = self.node.guard.mesh_id;
        let mut packets = 0;
        for chunk in rec[..n].chunks(per) {
            let seq = self.node.guard.next_sequence().ok_or(SendError::Counter)?;
            let mut buf = [0u8; 256];
            let len = admin::seal_command(mesh_id, session, seq, port as u8, body, chunk, &mut buf).ok_or(SendError::TooBig)?;
            self.node.net.send(BROADCAST, port as u8, &buf[..len], false).ok_or(SendError::QueueFull)?;
            packets += 1;
        }
        if port == Port::Membership {
            if let Some(c) = MemberCommand::decode(body) {
                self.membership.on_command(now_us, &c);
            }
        }
        Ok(packets)
    }

    /// Relayed control (§8.2 fan-out).
    pub fn send_control(&mut self, now_us: i64, conn: usize, op_id: u32, targets: Targets, inner: &[u8]) -> Result<usize, SendError> {
        let mut b = [0u8; 256];
        let n = ControlHeader { op_id, targets }.encode(inner, &mut b).ok_or(SendError::TooBig)?;
        let only = match targets {
            Targets::Nodes { ids, n } => Some((ids, n as usize)),
            _ => None,
        };
        let only_slice = only.as_ref().map(|(ids, n)| &ids[..*n]);
        self.send_admin(now_us, conn, Port::Control, &b[..n], only_slice)
    }

    /// A live update (a fader drag: uncommitted uniforms, §5.4). Coalesced: it replaces any
    /// live update not yet sent, so the mesh always carries the newest value at whatever
    /// rate its airtime allows, and live traffic never queues behind itself. Members
    /// interpolate between the updates they get on their own render clock
    /// ([`crate::interp`]). `inner` is a compact batch of uniforms (≤ [`LIVE_MAX`] bytes).
    pub fn send_live(&mut self, now_us: i64, conn: usize, op_id: u32, targets: Targets, inner: &[u8]) -> Result<(), SendError> {
        if !self.gate.is_unlocked(conn) {
            return Err(SendError::Locked);
        }
        if inner.len() > LIVE_MAX {
            return Err(SendError::TooBig);
        }
        let mut buf = [0u8; LIVE_MAX];
        buf[..inner.len()].copy_from_slice(inner);
        if self.live.replace((conn, op_id, targets, inner.len(), buf)).is_some() {
            self.live_coalesced += 1;
        }
        if self.node.net.mesh.can_send() {
            if let Some((conn, op, targets, n, buf)) = self.live.take() {
                self.send_control(now_us, conn, op, targets, &buf[..n])?;
                self.live_sent += 1;
                self.live_last_op = op;
            }
        }
        Ok(())
    }

    pub fn command(&mut self, now_us: i64, conn: usize, c: &MemberCommand) -> Result<usize, SendError> {
        let mut b = [0u8; 200];
        let n = c.encode(&mut b).ok_or(SendError::TooBig)?;
        self.send_admin(now_us, conn, Port::Membership, &b[..n], None)
    }

    pub fn admit(&mut self, now_us: i64, conn: usize, p: &PendingJoin) -> Result<usize, SendError> {
        self.command(now_us, conn, &MemberCommand::Admit { node: p.node, key_hash: p.key_hash })
    }

    pub fn assign_groups(&mut self, now_us: i64, conn: usize, node: NodeId, groups: &[u8]) -> Result<usize, SendError> {
        self.command(now_us, conn, &MemberCommand::AssignGroups { node, groups: Groups::from_slice(groups) })
    }

    pub fn set_mode(&mut self, now_us: i64, conn: usize, mode: Mode) -> Result<usize, SendError> {
        let generation = self.membership.state.map(|s| s.generation).unwrap_or(0).wrapping_add(1);
        self.command(now_us, conn, &MemberCommand::SetMode { mode, generation })
    }

    /// Rotate the mesh key and the site secret (§7.6): the app's signed `order` for these
    /// keys; every roster member except `exclude` gets them. The gateway installs them too.
    #[allow(clippy::too_many_arguments)]
    pub fn rotate(&mut self, now_us: i64, conn: usize, order: RekeyOrder, mesh_key: &[u8; 16], site_secret: &[u8; 32], exclude: &[NodeId], on: &mut dyn FnMut(Event<'_>)) -> Result<(), SendError> {
        let session = self.gate.session(conn).ok_or(SendError::Locked)?;
        let gs = self.gateway.as_ref().filter(|g| g.grant.session == session).ok_or(SendError::Locked)?;
        let admin_key = self.membership.admin_key().copied().ok_or(SendError::BadOrder)?;
        let rk = Rekeyer::start(now_us, gs, order, mesh_key, site_secret, &admin_key, exclude, &mut self.rng).ok_or(SendError::BadOrder)?;
        self.rekeyer = Some(rk);
        let keys = NewKeys { epoch: order.epoch, mesh_key: *mesh_key, site_secret: *site_secret, rev_version: order.rev_version, revoked: order.revoked, n_revoked: order.n_revoked };
        self.install(now_us, &keys, on);
        Ok(())
    }

    /// A non-admin packet (reply, status, bulk) to `dest` (BROADCAST for all).
    pub fn send(&mut self, dest: NodeId, port: Port, body: &[u8], want_ack: bool) -> Result<u16, SendError> {
        if !self.membership.is_member() {
            return Err(SendError::NotMember);
        }
        if body.len() > self.node.max_payload() {
            return Err(SendError::TooBig);
        }
        self.node.net.send(dest, port as u8, body, want_ack).ok_or(SendError::QueueFull)
    }
}
