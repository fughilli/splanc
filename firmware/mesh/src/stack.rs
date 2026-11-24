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
use crate::blob::{BlobDone, BlobStore, Blobs, Fetch, Hash, NoBlobs, SceneMsg};
use crate::crypto::{key_hash, DeviceKey, Entropy, KeyHash};
use crate::envelope::{Header, MicLen};
use crate::gateway::{self, Fanout, ReplyMsg, StatusMsg, STATUS_EVERY_US, T_STATUS};
use crate::topo::{self, Link, PoseKnown, Topo, TopoLocal, TopoMsg, T_TOPO};
#[cfg(feature = "open_mode")]
use crate::guest::{FollowEvent, Follower};
#[cfg(feature = "open_mode")]
use crate::membership::Follow;
use crate::membership::{Credentials, Groups, MeshState, Membership, Mode, Note, Out, Phase, ProvisionSource};
use crate::meshtime::{MeshTime, ShowEpoch, TimeBeacon, BEACON_MAX};
#[cfg(feature = "open_mode")]
use crate::msg::GuestHello;
use crate::msg::{Advert, Capacity, Class, Command as MemberCommand, PendingJoin, T_ADVERT, T_PENDING_JOIN, T_PROBE};
use crate::node::{MtuTooSmall, Node, NodeConfig, Rx};
use crate::ports::{ControlHeader, Inbound, Port, Role, RouteCtx, RouteReject, Router, Targets, SESSION_ENVELOPE};
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

/// Who may start a show epoch (owner desk #79). Mesh time is shared by every member, and a
/// new epoch re-times every scheduled change on all of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochPolicy {
    /// Only a fixture an admin session is open on (the gateway), for a time base that
    /// session's own connection set (or its own console); members only follow. Desk #79's
    /// recommended option. Locked and open modes later need a signed epoch (`TIME_BASE`).
    GatewaySession,
    /// Any member whose app (or console) sets a time base (M4's behaviour).
    AnyMember,
}

/// The one switch desk #79 decides ([`MeshStack::originate_epoch`] applies it). On a mesh
/// with an admin key (mesh M7) the epoch is always the admin session's: only a connection
/// that presented a grant may start one, and members take it only from that session's
/// signed `TIME_BASE` (beacon gossip of any other epoch is ignored, [`MeshTime::authorise`]).
pub const EPOCH_POLICY: EpochPolicy = EpochPolicy::GatewaySession;

/// Where a request to start a show epoch came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EpochSource {
    /// The app's `set_time_base` on this device's connection `conn`.
    Connection(usize),
    /// The device's serial console (physical access; tests).
    Console,
}

/// Default time a gateway collects member answers to a relayed control.
pub const REPLY_TIMEOUT_US: i64 = 2_000_000;

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
    /// The time beacon period (M4, [`crate::meshtime`]); 0: no mesh time.
    pub time_beacon_us: i64,
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
            time_beacon_us: crate::meshtime::BEACON_US,
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
    /// A newer show epoch (§6.3, M4) arrived in a time beacon: map it onto this device's
    /// time base.
    ShowEpoch(ShowEpoch),
    /// An admin session's gateway confirmed our freshness: its commands are accepted.
    SessionSynced { session: u32, gateway: NodeId },
    /// Gateway: this session's grant expires at `not_after` (mesh seconds); the app should
    /// sign a renewal (same session, later expiry) and present it with `unlock`.
    GrantRenewalDue { session: u32, not_after: u32 },
    /// The admin ejected this device (mesh M7, issue #571's seam): its mesh state is gone;
    /// the firmware forgets the persisted state and turns the mesh off.
    Ejected,
    /// Member (M6): every blob `msg` names is held (fetched and hash-checked): apply it as
    /// the scene says (at `apply_at`, at once, or only hold it) and answer the gateway when
    /// it asked ([`MeshStack::reply`]).
    Scene { origin: NodeId, msg: SceneMsg },
    /// Member (M6): a scene's blob could not be had (code: [`SceneFail`]); answered already.
    SceneFailed { origin: NodeId, op_id: u32, code: u16 },
    /// A blob fetch finished (M6; logging).
    Blob(BlobDone),
    /// Gateway (M6): the first phase of [`MeshStack::distribute`] is over: `have` of `of`
    /// targets hold the blob. The device now picks the show-clock time and calls
    /// [`MeshStack::distribute_apply`].
    Fetched { op_id: u32, have: usize, of: usize },
    /// Gateway (M6): `node` (re)joined the session after the scene changed: send it the
    /// current scene (a catch-up share, [`SceneMsg::CATCH_UP`]).
    CatchUp { node: NodeId },
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
    /// The channel its advert announces (§4.2: where the mesh is).
    pub channel: u8,
    pub last_us: i64,
}

/// Why a member could not have a scene's blob (the code in its `REPLY`).
pub mod scene_fail {
    pub const TOO_BIG: u16 = 0xb001;
    pub const NO_ROOM: u16 = 0xb002;
    pub const BAD_HASH: u16 = 0xb003;
    pub const STALLED: u16 = 0xb004;
}
pub use scene_fail as SceneFail;

/// A scene a member works on (fetching its blobs).
#[derive(Clone, Copy, Debug)]
struct PendingScene {
    origin: NodeId,
    msg: SceneMsg,
}

/// A gateway's two-phase share (M6): fetch everywhere, then apply on one frame.
#[derive(Clone, Copy, Debug)]
pub struct Distribution {
    pub conn: usize,
    pub op_id: u32,
    pub fetch_op: u32,
    pub targets: Targets,
    pub blob: (Hash, u16),
    pub fetched: bool,
}

/// Catch-ups a gateway queues (members that synced after a scene change).
pub const CATCHUPS: usize = 4;
/// How long a gateway collects "have" answers before applying anyway.
pub const FETCH_TIMEOUT_US: i64 = 12_000_000;

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
    /// Mesh time (M4): time beacons, the neighbour fits, the show epoch.
    pub time: MeshTime,
    next_time_us: Option<i64>,
    /// Gateway (M5): the member table and the relayed controls it collects answers for.
    pub fanout: Fanout<R>,
    /// This device's status as the firmware last reported it, and what was last broadcast.
    status_local: Option<StatusMsg>,
    status_sent: Option<StatusMsg>,
    next_status_us: Option<i64>,
    /// This device's room pose and when its topology goes out ([`crate::topo`]), and the hops
    /// of the application packet being delivered.
    pub topo: TopoLocal,
    rx_hops: u8,
    /// Epoch requests refused by [`EPOCH_POLICY`].
    pub epochs_refused: u32,
    /// Gateway on a signed mesh (M7): the epoch it originated still has to go out as the
    /// session's `TIME_BASE` (it is also re-sent with every grant broadcast).
    epoch_announce: bool,
    /// Signed `TIME_BASE` commands sent (gateway) and taken (member).
    pub epochs_sent: u32,
    pub epochs_signed: u32,
    /// Blobs and scenes (M6): the bulk side, the scene this member works on, the gateway's
    /// share in progress, its scene generation and the members to catch up.
    pub blobs: Blobs,
    scene: Option<PendingScene>,
    pub dist: Option<Distribution>,
    pub scene_gen: u32,
    catchup: [Option<NodeId>; CATCHUPS],
    pub scenes_in: u32,
    pub scenes_failed: u32,
    pub catchups: u32,
}

impl<B: Backhaul, const P: usize, K: DeviceKey, E: Entropy, const R: usize> MeshStack<B, P, K, E, R> {
    pub fn new(me: NodeId, mac: [u8; 6], backhaul: B, dev: K, rng: E, cfg: StackConfig) -> Result<Self, MtuTooSmall> {
        let mut m = core::mem::MaybeUninit::<Self>::uninit();
        // SAFETY: init_in writes every field on Ok; on Err it wrote nothing.
        unsafe {
            Self::init_in(m.as_mut_ptr(), me, mac, backhaul, dev, rng, cfg)?;
            Ok(m.assume_init())
        }
    }

    /// [`MeshStack::new`] built in place at `dst` (firmware: in its heap block, with ~a
    /// tenth of the stack a by-value build needs; mesh M3).
    ///
    /// # Safety
    /// `dst` is valid for writes. On `Ok` every field is initialised; on `Err` none is.
    pub unsafe fn init_in(dst: *mut Self, me: NodeId, mac: [u8; 6], backhaul: B, dev: K, rng: E, cfg: StackConfig) -> Result<(), MtuTooSmall> {
        Self::init_in_with(dst, me, mac, |p| p.write(backhaul), |p| p.write(dev), rng, cfg)
    }

    /// [`MeshStack::init_in`] with the backhaul and the device key built in place too
    /// (`backhaul` and `dev` initialise their slots), and every field built in its own
    /// frame ([`put`]): the stack this needs is the largest single field's, not the sum of
    /// all of them. The firmware builds the mesh on the tick's 14 KB stack this way, with
    /// no separate ~26 KB create stack to find in the heap.
    ///
    /// # Safety
    /// As [`MeshStack::init_in`]; `backhaul` and `dev` must initialise their slots. On
    /// `Err` nothing is left initialised (`dev` was not called).
    pub unsafe fn init_in_with(
        dst: *mut Self,
        me: NodeId,
        mac: [u8; 6],
        backhaul: impl FnOnce(*mut B),
        dev: impl FnOnce(*mut K),
        mut rng: E,
        mut cfg: StackConfig,
    ) -> Result<(), MtuTooSmall> {
        use core::ptr::addr_of_mut;
        if !cfg.capacity_aware {
            cfg.class = Class::C6;
        }
        let seed = rng.u32();
        let c = cfg;
        Node::init_in_with(
            addr_of_mut!((*dst).node),
            |np: *mut NetOf<P>| {
                NetOf::<P>::init_in(np, me, None, c.fw_key, c.firmware, seed);
                let net = &mut *np;
                net.mesh.cfg.high_ports = Port::HIGH_PRIORITY;
                net.mesh.cfg.hop_limit = c.hop_limit.clamp(1, MAX_HOPS);
                net.mesh.cfg.bulk_from = BULK_FROM;
                // No relay-delay bias by class (`bulk_relay_bias` stays 0): the stress sweep
                // showed a custodian relaying early makes a C6 cut vertex hear the duplicate
                // and cancel the only relay toward the far side (far-cluster delivery 3 %).
                // The flood's RSSI-based delay is what gives coverage; capacity must not
                // override it.
                #[cfg(feature = "custodian_spill")]
                if c.capacity_aware {
                    net.mesh.spill = c.class.custodian();
                }
            },
            backhaul,
            |gp: *mut MeshSecurity, mtu| put(gp, || MeshSecurity::new(me, c.mic, mtu, c.counter_mark)),
            cfg.node,
        )?;
        dev(addr_of_mut!((*dst).dev));
        #[cfg(feature = "open_mode")]
        let kh = key_hash(&(*dst).dev.public_key());
        macro_rules! w {
            ($f:ident, $v:expr) => {
                put(addr_of_mut!((*dst).$f), || $v)
            };
        }
        w!(membership, Membership::new(me, mac, cfg.firmware));
        w!(router, Router::new());
        w!(sessions, Sessions::new());
        w!(gateway, None);
        w!(rekeyer, None);
        w!(rekey_member, RekeyMember::default());
        #[cfg(feature = "open_mode")]
        w!(follower, Follower::new(Follow::Off, me, kh, cfg.firmware));
        w!(gate, AdminGate::new());
        w!(rng, rng);
        w!(neighbours, [None; NEIGHBOURS]);
        w!(cfg, cfg);
        w!(next_advert_us, None);
        w!(next_grant_us, None);
        w!(last_bulk_us, None);
        w!(installed, None);
        w!(held, None);
        w!(live, None);
        w!(live_coalesced, 0);
        w!(live_sent, 0);
        w!(live_last_op, 0);
        w!(hops_seen, (0, 0));
        MeshTime::init_in(addr_of_mut!((*dst).time), me);
        w!(next_time_us, None);
        w!(next_probe_us, None);
        w!(pending_grant, None);
        w!(pending_acks, [None; CRYPTO_ACKS]);
        w!(renewal_asked, None);
        w!(crypto_jobs, 0);
        w!(plain_tx, [0; PLAIN_MAX]);
        w!(plain_sealed, [0; PLAIN_MAX + 32]);
        w!(fanout, Fanout::new());
        w!(status_local, None);
        w!(status_sent, None);
        w!(next_status_us, None);
        w!(topo, TopoLocal::new());
        w!(rx_hops, 0);
        w!(epochs_refused, 0);
        w!(epoch_announce, false);
        w!(epochs_sent, 0);
        w!(epochs_signed, 0);
        w!(blobs, Blobs::new());
        w!(scene, None);
        w!(dist, None);
        w!(scene_gen, 0);
        w!(catchup, [None; CATCHUPS]);
        w!(scenes_in, 0);
        w!(scenes_failed, 0);
        w!(catchups, 0);
        Ok(())
    }

    /// Mesh seconds (grant expiry, M5): mesh time once synced, the local clock before.
    pub fn mesh_s(&self, now_us: i64) -> u32 {
        let t = if self.time.synced() { self.time.mesh_us(now_us) } else { now_us };
        (t.max(0) / 1_000_000) as u32
    }

    /// No admin key is provisioned: a dev closed mesh (desk #67), where relayed control is
    /// trusted on the envelope ([`crate::ports`]).
    pub fn envelope_trust(&self) -> bool {
        self.membership.admin_key().is_none()
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

    /// The persisted mesh state at boot (mesh M7): as provisioned, searching first.
    pub fn restore(&mut self, now_us: i64, s: MeshState) {
        self.membership.restore(s, now_us);
        self.sync_keys(now_us);
    }

    /// Leave the mesh (the app's `mesh_admin.leave`, or the admin's eject): every credential,
    /// session and key is dropped; nothing is sealed or accepted until provisioned again.
    pub fn leave(&mut self) {
        let id = self.node.guard.mesh_id;
        self.membership.leave();
        self.node.guard.set_none(id);
        self.installed = None;
        self.sessions = Sessions::new();
        self.gateway = None;
        self.rekeyer = None;
        self.rekey_member = RekeyMember::default();
        self.gate = AdminGate::new();
        self.held = None;
        self.live = None;
        self.pending_grant = None;
        self.pending_acks = [None; CRYPTO_ACKS];
        self.epoch_announce = false;
        self.time.epoch_allowed = None;
        self.scene = None;
        self.dist = None;
        self.catchup = [None; CATCHUPS];
    }

    /// Connection `conn` holds a grant for this gateway's live session (not envelope trust).
    pub fn signing_session(&self, conn: usize) -> bool {
        match (self.gate.session(conn), self.gateway.as_ref()) {
            (Some(s), Some(g)) => s != SESSION_ENVELOPE && g.grant.session == s,
            _ => false,
        }
    }

    /// A connection holding a signing session, if any (the console's epochs go out under it).
    pub fn signing_conn(&self) -> Option<usize> {
        // Live connections first; then the grant an app left behind (D-534).
        (0..admin::MAX_CONNECTIONS).chain(core::iter::once(admin::DETACHED)).find(|&c| self.signing_session(c))
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

    fn note_neighbour(&mut self, now_us: i64, id: NodeId, capacity: Capacity, diameter: u8, channel: u8) {
        self.fanout.touch(now_us, id);
        let i = self
            .neighbours
            .iter()
            .position(|n| n.is_some_and(|n| n.id == id))
            .or_else(|| self.neighbours.iter().position(|n| n.is_none()))
            .unwrap_or_else(|| (0..NEIGHBOURS).min_by_key(|&i| self.neighbours[i].map_or(i64::MIN, |n| n.last_us)).unwrap_or(0));
        self.neighbours[i] = Some(Neighbour { id, capacity, diameter, channel, last_us: now_us });
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

    /// The channel the freshest advert of our mesh announces (§4.2), if any in 10 s.
    pub fn heard_channel(&self, now_us: i64) -> Option<u8> {
        self.neighbours.iter().flatten().filter(|n| now_us - n.last_us < 10_000_000).max_by_key(|n| n.last_us).map(|n| n.channel)
    }

    /// Set the channel this member's adverts announce (AP-anchored: the AP's, §4.2).
    pub fn set_channel(&mut self, ch: u8) {
        if let Some(s) = self.membership.state.as_mut() {
            s.channel = ch;
        }
    }

    /// The lowest relay credit any recently heard neighbour advertises (custodians release
    /// stored bulk only while it is positive).
    pub fn min_neighbour_credit(&self, now_us: i64) -> u8 {
        self.neighbours.iter().flatten().filter(|n| now_us - n.last_us < 3_000_000 && !n.capacity.class.custodian()).map(|n| n.capacity.credit).min().unwrap_or(u8::MAX)
    }

    /// Run the device's mesh for one step: receive, timers, adverts, sessions, the mesh slot,
    /// deliver. `scratch` must hold `scratch_len()` bytes. Bounded work; never blocks.
    pub fn tick(&mut self, now_us: i64, flash: &mut dyn Flash, scratch: &mut [u8], on: &mut dyn FnMut(Event<'_>)) {
        self.tick_blobs(now_us, flash, &mut NoBlobs, scratch, on);
    }

    /// [`MeshStack::tick`] for a device that keeps blobs (M6: effect sharing, catch-up).
    pub fn tick_blobs(&mut self, now_us: i64, flash: &mut dyn Flash, store: &mut dyn BlobStore, scratch: &mut [u8], on: &mut dyn FnMut(Event<'_>)) {
        // Signed epochs (M7): with an admin key, only the session's TIME_BASE sets the epoch.
        self.time.epoch_signed = !self.envelope_trust();
        // 0. The last time beacon's completion (two-step stamp, M4).
        if let Some(st) = self.node.backhaul.take_tx_stamp() {
            self.time.on_stamp(st.done_us, st.err_us);
        }
        // 1. Receive: link frames into the mesh, plain frames to membership, time beacons
        // to mesh time.
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
                Rx::Time { meta, src, body } => match TimeBeacon::decode(body) {
                    Some(b) => {
                        if let Some(e) = self.time.on_beacon(now_us, src, meta.rx_us, &b) {
                            on(Event::ShowEpoch(e));
                        }
                    }
                    None => self.time.stats.bad += 1,
                },
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
        // 3b. The time beacon (M4): one hop, broadcast, its completion stamped.
        let period = self.cfg.time_beacon_us;
        if period > 0 && self.membership.is_member() && now_us >= *self.next_time_us.get_or_insert(now_us) {
            let jitter = (self.rng.u32() as i64).rem_euclid((period / 4).max(1));
            self.next_time_us = Some(now_us + period - jitter);
            let b = self.time.beacon(now_us);
            let mut body = [0u8; BEACON_MAX];
            let sent = match b.encode(&mut body) {
                Some(n) => self.node.send_time(now_us, &body[..n], &mut self.plain_tx, &mut self.plain_sealed),
                None => false,
            };
            if !sent {
                self.time.cancel_pending();
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
                let now_s = self.mesh_s(now_us);
                if g.not_after.saturating_sub(now_s) <= RENEW_AHEAD_S && self.renewal_asked != Some((g.session, g.not_after)) {
                    self.renewal_asked = Some((g.session, g.not_after));
                    on(Event::GrantRenewalDue { session: g.session, not_after: g.not_after });
                }
                // Due, or the clock stepped back past the period (admin.rs due_ack).
                let next = *self.next_grant_us.get_or_insert(now_us);
                if now_us >= next || next - now_us > GRANT_EVERY_US {
                    self.next_grant_us = Some(now_us + GRANT_EVERY_US);
                    self.send_session(BROADCAST, &SessionMsg::Grant(g), false);
                    // The epoch this gateway originated goes again with the grant, for
                    // members that joined or rebooted since (M7).
                    self.epoch_announce |= self.time.epoch.is_some_and(|e| e.origin == self.me());
                }
            }
            if self.epoch_announce && self.node.net.mesh.can_send() {
                self.announce_epoch(now_us);
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
        // 5c. Blobs (M6): the next request, chunk or announcement, paced like all bulk (one
        // hop: every holder serves its neighbours), and a stalled fetch given up.
        if let Some(d) = self.blobs.poll(now_us, store) {
            self.on_blob_done(d, on);
        }
        if self.membership.is_member() && self.bulk_clear_to_send(now_us) {
            let mut b = [0u8; crate::blob::BULK_MAX];
            if let Some((dest, n)) = self.blobs.next(now_us, store, &mut b) {
                let hops = if dest == BROADCAST || self.is_neighbour(now_us, dest) { 0 } else { self.node.net.mesh.cfg.hop_limit };
                if self.node.net.mesh.send_with_hops(dest, Port::Bulk as u8, &b[..n], false, hops).is_some() {
                    self.last_bulk_us = Some(now_us);
                }
            }
        }
        // 6. The mesh slot.
        if self.may_transmit() {
            self.node.run_slot(now_us, flash, scratch);
        }
        if let Some(m) = self.node.guard.wants_counter_reservation() {
            on(Event::PersistCounter(m));
        }
        // 6b. Member status (M5): every 10 s and on a change, once the firmware reported one.
        let mut sent_status = false;
        if self.membership.is_member() && self.node.net.mesh.can_send() {
            if let Some(st) = self.status_local {
                let due = self.next_status_us.is_none_or(|t| now_us >= t) || self.status_sent.is_none_or(|s| st.differs(&s));
                if due {
                    let mut b = [0u8; gateway::STATUS_LEN];
                    if let Some(n) = st.encode(&mut b) {
                        if self.node.net.send(BROADCAST, Port::Status as u8, &b[..n], false).is_some() {
                            self.status_sent = Some(st);
                            let jitter = (self.rng.u32() as i64).rem_euclid(STATUS_EVERY_US / 4);
                            self.next_status_us = Some(now_us + STATUS_EVERY_US - jitter);
                            sent_status = true;
                        }
                    }
                }
            }
        }
        // 6c. Topology (room pose + neighbours, crate::topo): not in the same pass as a status.
        if !sent_status && self.membership.is_member() && self.node.net.mesh.can_send() && self.topo.due(now_us) {
            let mut links = [Link::EMPTY; topo::NEIGHBOURS];
            let n = self.node.backhaul.links(now_us, &mut links);
            let m = self.topo.message(now_us, &links[..n]);
            let mut b = [0u8; topo::TOPO_MAX];
            if let Some(len) = m.encode(&mut b) {
                if self.node.net.send(BROADCAST, Port::Status as u8, &b[..len], false).is_some() {
                    let jitter = (self.rng.u32() as i64).rem_euclid(topo::TOPO_EVERY_US / 4);
                    self.topo.sent(now_us, &m, topo::TOPO_EVERY_US - jitter);
                }
            }
        }
        self.fanout.poll(now_us);
        // 7. Deliver application packets through the port policy.
        while let Some(pkt) = self.node.net.next_app() {
            if pkt.hops >= self.hops_seen.0 || now_us - self.hops_seen.1 >= DIAMETER_WINDOW_US {
                self.hops_seen = (pkt.hops, now_us);
            }
            self.rx_hops = pkt.hops;
            self.deliver(now_us, pkt.origin, pkt.port, &pkt.payload[..pkt.len], store, on);
        }
        // 8. Scenes (M6): the member's blobs, the gateway's share and its catch-ups.
        self.scene_step(now_us, store, on);
        if let Some(d) = self.dist.as_mut().filter(|d| !d.fetched) {
            if let Some(r) = self.fanout.take_done_op(d.fetch_op) {
                d.fetched = true;
                let have = r.status[..r.n].iter().filter(|s| **s == gateway::Status::Ok).count();
                on(Event::Fetched { op_id: d.op_id, have, of: r.n });
            }
        }
        if self.dist.is_none() {
            if let Some(node) = self.catchup.iter_mut().find_map(|c| c.take()) {
                self.catchups += 1;
                on(Event::CatchUp { node });
            }
        }
    }

    fn is_neighbour(&self, now_us: i64, id: NodeId) -> bool {
        self.neighbours.iter().flatten().any(|n| n.id == id && now_us - n.last_us < 5_000_000)
    }

    // ---- Blobs and scenes (M6, crate::blob) ----

    fn on_blob_done(&mut self, d: BlobDone, on: &mut dyn FnMut(Event<'_>)) {
        on(Event::Blob(d));
        let (BlobDone::BadHash(h) | BlobDone::Stalled(h)) = d else { return };
        if self.scene.is_some_and(|p| p.msg.blobs().iter().any(|b| b.0 == h)) {
            let code = if matches!(d, BlobDone::BadHash(_)) { SceneFail::BAD_HASH } else { SceneFail::STALLED };
            self.fail_scene(code, on);
        }
    }

    fn fail_scene(&mut self, code: u16, on: &mut dyn FnMut(Event<'_>)) {
        let Some(p) = self.scene.take() else { return };
        self.scenes_failed += 1;
        if p.msg.want_reply() {
            let _ = self.reply(p.origin, &ReplyMsg { op_id: p.msg.op_id, status: gateway::Status::Failed, arm: gateway::arm::SUBMIT_EFFECT as u8, code });
        }
        on(Event::SceneFailed { origin: p.origin, op_id: p.msg.op_id, code });
    }

    /// The member's scene: fetch the first blob it lacks; once all are held, hand it over.
    fn scene_step(&mut self, now_us: i64, store: &mut dyn BlobStore, on: &mut dyn FnMut(Event<'_>)) {
        let Some(p) = self.scene else { return };
        for &(h, size) in p.msg.blobs() {
            match self.blobs.fetch(now_us, &h, size as usize, p.origin, store) {
                Fetch::Have => continue,
                Fetch::Started => return,
                Fetch::TooBig => return self.fail_scene(SceneFail::TOO_BIG, on),
                Fetch::NoRoom => return self.fail_scene(SceneFail::NO_ROOM, on),
            }
        }
        self.scene = None;
        on(Event::Scene { origin: p.origin, msg: p.msg });
    }

    /// The scene this member is fetching blobs for: (op id, blobs held, blobs named).
    pub fn scene_pending(&self) -> Option<(u32, usize)> {
        self.scene.map(|p| (p.msg.op_id, p.msg.n as usize))
    }

    /// Gateway: send scene `msg` under connection `conn`'s session to its targets (all synced
    /// members, or `msg.targets`' nodes), and collect their answers for `timeout_us` when it
    /// wants replies. Returns the packets sent.
    pub fn share(&mut self, now_us: i64, conn: usize, msg: &SceneMsg, timeout_us: i64) -> Result<usize, SendError> {
        let mut b = [0u8; SceneMsg::MAX_LEN];
        let n = msg.encode(&mut b).ok_or(SendError::TooBig)?;
        let only = match msg.targets {
            Targets::Nodes { ids, n } => Some((ids, n as usize)),
            _ => None,
        };
        let only_slice = only.as_ref().map(|(ids, n)| &ids[..*n]);
        let sent = self.send_admin(now_us, conn, Port::Scene, &b[..n], only_slice)?;
        if msg.want_reply() {
            let me = self.me();
            self.fanout.begin(now_us, conn, msg.op_id, gateway::arm::SUBMIT_EFFECT as u8, &msg.targets, timeout_us, me);
        }
        Ok(sent)
    }

    /// Gateway: share blob `blob` (it is in this device's store) with `targets` in two
    /// phases. First every target fetches it and answers "have" (up to `fetch_timeout_us`);
    /// then [`Event::Fetched`] asks the device for the show-clock time, and
    /// [`MeshStack::distribute_apply`] tells every target to apply it then, so all switch on
    /// one frame. A member that had no blob by then applies it as soon as it does (late).
    pub fn distribute(&mut self, now_us: i64, conn: usize, op_id: u32, targets: Targets, blob: (Hash, u16), fetch_timeout_us: i64) -> Result<usize, SendError> {
        let fetch_op = op_id ^ 0x8000_0000;
        let msg = SceneMsg::new(fetch_op, SceneMsg::WANT_REPLY, 0, targets, &[blob]).ok_or(SendError::TooBig)?;
        let n = self.share(now_us, conn, &msg, fetch_timeout_us)?;
        self.dist = Some(Distribution { conn, op_id, fetch_op, targets, blob, fetched: false });
        self.scene_changed();
        Ok(n)
    }

    /// Gateway: the second phase: apply at `apply_at` on the show clock (None: at once),
    /// collecting answers for `timeout_us`. The share is over (its result is `op_id`'s).
    pub fn distribute_apply(&mut self, now_us: i64, apply_at: Option<u32>, timeout_us: i64) -> Result<SceneMsg, SendError> {
        let d = self.dist.take().ok_or(SendError::NoRecipients)?;
        let flags = SceneMsg::APPLY | SceneMsg::WANT_REPLY | if apply_at.is_none() { SceneMsg::NOW } else { 0 };
        let msg = SceneMsg::new(d.op_id, flags, apply_at.unwrap_or(0), d.targets, &[d.blob]).ok_or(SendError::TooBig)?;
        self.share(now_us, d.conn, &msg, timeout_us)?;
        Ok(msg)
    }

    /// Gateway: the look changed through this session (a share, or relayed control that is
    /// part of the scene: an effect, committed uniforms, brightness, crossfade). Members that
    /// sync with the session from now on get a catch-up.
    pub fn scene_changed(&mut self) {
        self.scene_gen = self.scene_gen.wrapping_add(1).max(1);
    }

    /// Gateway: send `node` a catch-up (a member that missed a change: it failed or was away).
    pub fn queue_catch_up(&mut self, node: NodeId) {
        if node == self.me() || self.catchup.contains(&Some(node)) {
            return;
        }
        if let Some(slot) = self.catchup.iter_mut().find(|c| c.is_none()) {
            *slot = Some(node);
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

    /// The time beacon period (µs; 0 stops mesh time beacons).
    pub fn set_time_beacon_us(&mut self, us: i64) {
        self.cfg.time_beacon_us = us.max(0);
        self.next_time_us = None;
    }

    /// A show epoch (set, or cleared) for this device (§6.3), from `by`: originate the next
    /// generation in mesh time if [`EPOCH_POLICY`] lets `by` start one; every member's beacons
    /// gossip it from then on. None: refused (the device keeps following the mesh's epoch).
    /// The one seam owner desk #79 decides.
    pub fn originate_epoch(&mut self, by: EpochSource, epoch_mesh_us: Option<i64>) -> Option<ShowEpoch> {
        // A mesh with an admin key (M7): only a grant's session, and the epoch goes out as
        // its signed TIME_BASE (members ignore any other). The console, too, needs one.
        let signed = !self.envelope_trust();
        let allowed = match (signed, EPOCH_POLICY, by) {
            (true, _, EpochSource::Connection(conn)) => self.signing_session(conn),
            (true, _, EpochSource::Console) => self.signing_conn().is_some(),
            (false, EpochPolicy::AnyMember, _) | (false, _, EpochSource::Console) => true,
            (false, EpochPolicy::GatewaySession, EpochSource::Connection(conn)) => self.gate.is_unlocked(conn),
        };
        if !allowed {
            self.epochs_refused += 1;
            return None;
        }
        let e = self.time.originate(epoch_mesh_us);
        self.epoch_announce = signed;
        Some(e)
    }

    /// Send the epoch this gateway originated as its session's signed `TIME_BASE`.
    /// Send this gateway's show epoch now, if it originated one (a catch-up goes right
    /// after it, so the member's clock is on the mesh's before the scene's state lands).
    pub fn announce_epoch_now(&mut self, now_us: i64) {
        if self.time.epoch.is_some_and(|e| e.origin == self.me()) && self.node.net.mesh.can_send() {
            self.announce_epoch(now_us);
        }
    }

    fn announce_epoch(&mut self, now_us: i64) {
        let (Some(conn), Some(e)) = (self.signing_conn(), self.time.epoch) else {
            self.epoch_announce = false;
            return;
        };
        if e.origin != self.me() {
            self.epoch_announce = false;
            return;
        }
        let mut b = [0u8; ShowEpoch::LEN];
        let Some(n) = e.encode(&mut b) else { return };
        match self.send_admin(now_us, conn, Port::TimeBase, &b[..n], None) {
            Ok(_) => {
                self.epochs_sent += 1;
                self.epoch_announce = false;
            }
            // No member confirmed yet: the next grant round tries again.
            Err(SendError::NoRecipients) => self.epoch_announce = false,
            Err(_) => {}
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
                    self.note_neighbour(now_us, h.src, a.capacity, a.diameter, a.channel);
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

    fn deliver(&mut self, now_us: i64, origin: NodeId, port: u8, payload: &[u8], store: &mut dyn BlobStore, on: &mut dyn FnMut(Event<'_>)) {
        #[cfg(feature = "open_mode")]
        let role = if self.node.guard.domain() == Domain::Guest { Role::Guest } else { Role::Member };
        #[cfg(not(feature = "open_mode"))]
        let role = Role::Member;
        let ctx = RouteCtx {
            mesh_id: self.node.guard.mesh_id,
            me: self.me(),
            role,
            groups: self.membership.groups(),
            mesh_time_s: self.mesh_s(now_us),
            envelope_trust: self.envelope_trust(),
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
            Port::Freshness => self.on_freshness(now_us, origin, body, store, on),
            Port::Bulk => {
                if let Some(d) = self.blobs.on_packet(now_us, origin, body, store) {
                    self.on_blob_done(d, on);
                }
            }
            Port::Scene if admin => {
                // The admin session's scene (M6): authoritative; one at a time, the newest.
                if let Some(msg) = SceneMsg::decode(body) {
                    if msg.targets.includes(self.me(), &self.membership.groups()) {
                        self.scenes_in += 1;
                        self.scene = Some(PendingScene { origin, msg });
                    }
                }
            }
            Port::Membership => {
                if let Some(c) = MemberCommand::decode(body) {
                    if let MemberCommand::Eject { node, key_hash } = c {
                        // Only an authenticated command reaches here (admin session, or
                        // envelope trust on a dev mesh); it names this device by id and key.
                        if node == self.me() && key_hash == self.key_hash() {
                            self.leave();
                            on(Event::Ejected);
                        }
                        return;
                    }
                    let note = self.membership.on_command(now_us, &c);
                    self.handle_note(now_us, note, on);
                }
            }
            Port::TimeBase if admin => {
                // The admin session's show epoch (M7, desk #79): authoritative.
                if let Some(e) = ShowEpoch::decode(body) {
                    self.epochs_signed += 1;
                    if let Some(e) = self.time.authorise(e) {
                        on(Event::ShowEpoch(e));
                    }
                }
            }
            Port::Status if body.first() == Some(&T_PROBE) => {}
            Port::Status if body.first() == Some(&T_PENDING_JOIN) => {
                if let Some(p) = PendingJoin::decode(body) {
                    let note = self.membership.on_pending(&p);
                    self.handle_note(now_us, note, on);
                }
            }
            Port::Status if body.first() == Some(&T_STATUS) => {
                if let Some(st) = StatusMsg::decode(body) {
                    self.fanout.on_status(now_us, origin, st);
                    self.fanout.note_hops(origin, self.rx_hops.saturating_add(1));
                }
            }
            Port::Status if body.first() == Some(&T_TOPO) => {
                if let Some(t) = TopoMsg::decode(body) {
                    self.fanout.on_topo(now_us, origin, &t);
                    self.fanout.note_hops(origin, self.rx_hops.saturating_add(1));
                }
            }
            Port::Reply if body.first() == Some(&gateway::T_REPLY) => {
                if let Some(r) = ReplyMsg::decode(body) {
                    self.fanout.on_reply(now_us, origin, &r);
                }
            }
            Port::Control => {
                if let Some((header, inner)) = ControlHeader::decode(body) {
                    self.fanout.touch(now_us, origin);
                    on(Event::Control { origin, header, inner });
                }
            }
            _ => on(Event::Packet { origin, port, body, admin }),
        }
    }

    fn on_freshness(&mut self, now_us: i64, origin: NodeId, body: &[u8], store: &mut dyn BlobStore, on: &mut dyn FnMut(Event<'_>)) {
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
                    if let Ok(Some(ack)) = self.sessions.on_grant(now_us, self.mesh_s(now_us), &g, admin_key.as_ref(), mesh_id, me, &self.dev, &mut self.rng) {
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
                            self.deliver(now_us, h.origin, h.port, &buf[..h.len], store, on);
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
            if let Ok(Some(ack)) = self.sessions.on_grant(now_us, self.mesh_s(now_us), &g, admin_key.as_ref(), mesh_id, me, &self.dev, &mut self.rng) {
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
                    // A member synced after the look changed (it joined, or rebooted): it
                    // gets the current scene (M6).
                    if self.scene_gen != 0 {
                        self.queue_catch_up(to);
                    }
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
        self.gate.unlock(now_us, self.mesh_s(now_us), conn, grant, admin_key.as_ref(), mesh_id, self.me(), &my_key)?;
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
        if session == SESSION_ENVELOPE {
            // Envelope trust (a dev closed mesh): one packet, no per-receiver MACs; targets
            // are in the control header. Refused here if an admin key appeared since.
            if !self.envelope_trust() {
                return Err(SendError::Locked);
            }
            let seq = self.node.guard.next_sequence().ok_or(SendError::Counter)?;
            let mut buf = [0u8; 256];
            let len = admin::seal_command(self.node.guard.mesh_id, SESSION_ENVELOPE, seq, port as u8, body, &[], &mut buf).ok_or(SendError::TooBig)?;
            if len > self.node.max_payload() {
                return Err(SendError::TooBig);
            }
            self.node.net.send(BROADCAST, port as u8, &buf[..len], false).ok_or(SendError::QueueFull)?;
            if port == Port::Membership {
                if let Some(c) = MemberCommand::decode(body) {
                    self.membership.on_command(now_us, &c);
                }
            }
            return Ok(1);
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
        self.send_control_with(now_us, conn, ControlHeader::new(op_id, targets), inner)
    }

    /// Relayed control that collects the targets' answers (M5): sent like
    /// [`MeshStack::send_control`] with the want-reply flag, and an operation in
    /// [`MeshStack::fanout`] that finishes when every live target answered or `timeout_us`
    /// passed ([`Fanout::take_done`]). Returns the members it expects answers from.
    #[allow(clippy::too_many_arguments)]
    pub fn send_control_collect(&mut self, now_us: i64, conn: usize, op_id: u32, targets: Targets, inner: &[u8], arm: u8, timeout_us: i64) -> Result<usize, SendError> {
        let h = ControlHeader { op_id, flags: ControlHeader::WANT_REPLY, targets };
        self.send_control_with(now_us, conn, h, inner)?;
        let me = self.me();
        Ok(self.fanout.begin(now_us, conn, op_id, arm, &targets, timeout_us, me))
    }

    /// Open the gateway's admin session on connection `conn` without a grant: only on a mesh
    /// with no admin key (envelope trust, desk #67). With an admin key the app must present a
    /// grant ([`MeshStack::unlock`], M7).
    pub fn open_gateway(&mut self, conn: usize) -> Result<(), UnlockError> {
        if !self.envelope_trust() {
            return Err(UnlockError::BadGrant);
        }
        self.gate.open_envelope(conn)
    }

    /// Connection `conn` opened or closed: whatever session it held is gone.
    pub fn connection_changed(&mut self, conn: usize) {
        // The app went away, but the grant it unlocked is still good (members keep its
        // session until it expires). Keep it on the detached slot so this gateway still
        // catches up a member that reboots or rejoins, and re-announces its show epoch,
        // while no app is connected. Nothing else can use that slot; a new unlock
        // replaces the gateway session, and the old one then signs nothing.
        if conn != admin::DETACHED && self.signing_session(conn) {
            self.gate.detach(conn);
        } else {
            self.gate.connection_changed(conn);
        }
    }

    /// A member's answer to relayed control `op_id` from `gateway` (ACKed unicast, desk #70).
    pub fn reply(&mut self, gateway: NodeId, r: &ReplyMsg) -> Result<u16, SendError> {
        let mut b = [0u8; gateway::REPLY_LEN];
        let n = r.encode(&mut b).ok_or(SendError::TooBig)?;
        self.send(gateway, Port::Reply, &b[..n], true)
    }

    /// The firmware's view of this device for its status broadcasts (M5).
    pub fn set_status(&mut self, st: StatusMsg) {
        self.status_local = Some(st);
    }

    /// This device's room pose for its topology broadcasts ([`crate::topo`]); nothing goes
    /// out until the firmware reports one (`Unposed` counts). A change goes out at once.
    pub fn set_pose(&mut self, p: PoseKnown) {
        self.topo.set_pose(p);
    }

    /// A peer's latest topology (room pose, neighbours, hops) as this node heard it: every
    /// member keeps every live member's, not only the gateway.
    pub fn peer_topo(&self, now_us: i64, node: NodeId) -> Option<&Topo> {
        self.fanout.member(now_us, node).map(|m| &m.topo)
    }

    /// This node's own radio links (what its topology reports), strongest first.
    pub fn links(&self, now_us: i64, out: &mut [Link]) -> usize {
        self.node.backhaul.links(now_us, out)
    }

    fn send_control_with(&mut self, now_us: i64, conn: usize, h: ControlHeader, inner: &[u8]) -> Result<usize, SendError> {
        let targets = h.targets;
        let mut b = [0u8; 256];
        let n = h.encode(inner, &mut b).ok_or(SendError::TooBig)?;
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

    /// Eject one member (M7; issue #571's seam): it leaves the mesh. Not a removal (no
    /// rotation): use [`MeshStack::rotate`] with a revocation to keep it out.
    pub fn eject(&mut self, now_us: i64, conn: usize, node: NodeId, key_hash: KeyHash) -> Result<usize, SendError> {
        let n = self.command(now_us, conn, &MemberCommand::Eject { node, key_hash })?;
        // It leaves on receipt: the app's member list drops it now (the e2e saw it listed
        // for the 30 s MEMBER_STALE_US), and the session's commands stop MAC'ing for it.
        self.fanout.forget(node);
        if let Some(gs) = self.gateway.as_mut() {
            gs.remove(node);
        }
        Ok(n)
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
        // The removed get no wrap, and no command MACs from now on (M7).
        if let Some(gs) = self.gateway.as_mut() {
            for &n in exclude {
                gs.remove(n);
            }
        }
        for &n in exclude {
            self.fanout.forget(n);
        }
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

/// Write `f()` into `dst` from a frame of its own (never inlined): a by-value temporary of
/// a big field lives only as long as this call, so building a struct field by field through
/// it needs the stack of its largest field, not of all of them at once.
///
/// # Safety
/// `dst` is valid for writes.
#[inline(never)]
pub(crate) unsafe fn put<T>(dst: *mut T, f: impl FnOnce() -> T) {
    dst.write(f())
}
