//! Membership (design §7.1–7.3, §7.6–7.8): what a device knows about its mesh and the join
//! state machines on both sides, as pure logic (no radio, no flash, no clock of its own).
//!
//! **Modes** (§7.1). Closed (default): a device with the site secret joins by itself; any
//! other is admitted by approval. Locked: only devices on the allow-list (device-key hashes).
//! Open: as closed for members, plus a follow stream for guests (§7.4, M7b; [`crate::guest`]).
//!
//! **Provisioning** (§7.3, §7.9): [`Membership::provision`] takes [`Credentials`] from either
//! path the owner may choose, pre-provisioned (factory) or set from the app on site; both go
//! through the same call and the same state.
//!
//! **Self-configuring formation** (§7.9): the site secret derives the mesh key of the first
//! epoch, `HKDF(site secret, mesh id, "mesh key 1")`. A provisioned fixture listens for its
//! mesh's adverts for 5 s; hearing none, it starts beaconing as a member. Every fixture with
//! the site secret already holds the epoch-1 key, so islands that formed apart merge by
//! hearing each other, with no founder election and no key agreement. After a rotation
//! (epoch > 1, M7c) a site-secret device asks to join instead ([`msg::JoinRequest`] with a
//! proof); the highest epoch heard wins.
//!
//! **Joining** (§7.3): a joiner answers one member's advert with a `JoinRequest`. That member
//! admits it if the proof checks (closed/open), its key hash is on the allow-list (locked), or
//! the admin admitted it (approval; [`msg::Command::Admit`]); otherwise it tells the gateways
//! ([`msg::PendingJoin`]). Admission wraps the mesh key and the admin public key for the joiner under
//! ECDH(member, joiner) and HKDF (with the admin public key, authenticated), salted with the site secret when the joiner proved it (so
//! the joiner knows the mesh is genuine) and with the mesh id otherwise (approval joins trust
//! on first use, as the app's device pinning does).

use ledmapper_netstack::ccmp::{ccm_open, ccm_seal};

use crate::backhaul::NodeId;
use crate::crypto::{ct_eq, hkdf16, hmac, key_hash, DeviceKey, Entropy, KeyHash, PublicKey};
use crate::rekey::Revocations;
use crate::envelope::{Header, EPOCH_FIRST, EPOCH_PLAIN};
pub use crate::groups::Groups;
#[cfg(feature = "open_mode")]
use crate::guest::{GuestTable, GUESTS};
#[cfg(feature = "open_mode")]
use crate::msg::GuestHello;
use crate::msg::{self, Advert, Capacity, Command, JoinAccept, JoinRequest, PendingJoin};
use crate::ports::Port;

/// How long a provisioned device listens for its mesh before beaconing itself (§7.9).
pub const SEARCH_US: i64 = 5_000_000;
/// A joiner repeats its request this often.
pub const JOIN_RETRY_US: i64 = 2_000_000;
/// Advert nonces a member honours (one per advert, ~4 s at the 1 s beacon).
pub const NONCES: usize = 4;
/// Join requests a member keeps while they wait for approval.
pub const PENDING: usize = 4;
/// How often a member re-tells gateways about the same pending join.
pub const PENDING_FORWARD_US: i64 = 10_000_000;
/// An admission waits this long for the admitted device's next request.
pub const ADMITTED_US: i64 = 120_000_000;
pub const ADMITTED: usize = 4;
/// Undecryptable frames of our mesh and epoch (and none that decrypt) during the search that
/// mark our key as wrong.
pub const SUSPECT_BAD: u32 = 3;
/// Pending joins a gateway lists for the app.
pub const GATEWAY_PENDING: usize = 8;

pub const SITE_SECRET_LEN: usize = 32;
/// Locked mode's allow-list: up to 64 device-key hashes (§7.2).
pub const ALLOW_MAX: usize = 64;

/// The mesh mode (§7.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Mode {
    /// Free association: guests follow (§7.4); members as in closed mode.
    Open = 0,
    /// Authenticated join: the site secret, or approval. The default.
    #[default]
    Closed = 1,
    /// Only approved devices (allow-list).
    Locked = 2,
}

impl Mode {
    pub const fn from_u8(v: u8) -> Option<Mode> {
        match v {
            0 => Some(Mode::Open),
            1 => Some(Mode::Closed),
            2 => Some(Mode::Locked),
            _ => None,
        }
    }

    /// A site-secret proof admits a device by itself.
    pub const fn site_secret_admits(self) -> bool {
        !matches!(self, Mode::Locked)
    }
}

/// What a mode change does (§7.6), for the gateway to carry out and the app to explain.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Transition {
    /// Rotate the mesh key to the members that stay (M7c distributes it).
    pub rotate_key: bool,
    /// The app proposes the current members as the allow-list and the owner confirms.
    pub propose_allow_list: bool,
    /// The allow-list is dropped (site-secret joins accepted again).
    pub drop_allow_list: bool,
    /// The open follow stream starts (`Some(true)`) or stops (`Some(false)`).
    pub follow_stream: Option<bool>,
    /// Former guests are listed with "Admit" (approval path).
    pub list_former_guests: bool,
}

/// §7.6's table.
pub fn transition(from: Mode, to: Mode) -> Transition {
    let mut t = Transition::default();
    match (from, to) {
        (a, b) if a == b => {}
        (Mode::Open, _) => {
            t.follow_stream = Some(false);
            t.list_former_guests = true;
            if to == Mode::Locked {
                t.propose_allow_list = true;
                t.rotate_key = true;
            }
        }
        (Mode::Closed, Mode::Locked) => {
            t.propose_allow_list = true;
            t.rotate_key = true;
        }
        (Mode::Locked, Mode::Closed) => t.drop_allow_list = true,
        (_, Mode::Open) => {
            t.follow_stream = Some(true);
            t.drop_allow_list = from == Mode::Locked;
        }
        _ => {}
    }
    t
}

/// Removing a member (§7.6): always a rotation; in closed (and open) mode the site secret
/// also needs rotating, or the removed device can rejoin with it (the app says so).
pub fn removal(mode: Mode) -> (Transition, bool) {
    (Transition { rotate_key: true, ..Transition::default() }, mode.site_secret_admits())
}

/// Where credentials came from (§7.9 step 1; the owner has not picked one, so both exist).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum ProvisionSource {
    /// Pre-provisioned before shipping (read from flash at boot).
    #[default]
    Factory = 0,
    /// Set from the app on site (BLE Improv at setup, or a direct wss/BLE `MeshJoin`).
    App = 1,
}

/// What provisioning hands a device: a mesh id, and any of the site secret, a mesh key, the
/// admin key. A device with only a mesh id joins by approval.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Credentials {
    pub mesh_id: u32,
    /// 0: derive from the mesh id (one of 1, 6, 11; §7.9) unless the venue AP sets it.
    pub channel: u8,
    pub mode: Mode,
    pub site_secret: Option<[u8; SITE_SECRET_LEN]>,
    /// (epoch, key): the app-provisioned path of §7.3 (`MeshJoin{key, epoch}`).
    pub mesh_key: Option<(u8, [u8; 16])>,
    /// The admin public key (§7.9): verifies session grants and rekey orders.
    pub admin_key: Option<PublicKey>,
    pub groups: Groups,
}

/// The mesh key a site secret gives at epoch 1.
pub fn site_mesh_key(site_secret: &[u8; SITE_SECRET_LEN], mesh_id: u32) -> [u8; 16] {
    hkdf16(&mesh_id.to_be_bytes(), site_secret, &[b"splanc mesh key 1"])
}

/// The channel a mesh id derives (1, 6 or 11) when there is no venue AP to follow.
pub const fn derived_channel(mesh_id: u32) -> u8 {
    [1, 6, 11][(mesh_id % 3) as usize]
}

/// The site-secret proof in a [`JoinRequest`]. Binds the advert nonce (freshness), the node
/// and its key (a captured proof is useless with another key).
pub fn join_proof(site_secret: &[u8; SITE_SECRET_LEN], mesh_id: u32, advert_nonce: u32, node: NodeId, kh: &KeyHash) -> [u8; 16] {
    let h = hmac(site_secret, &[b"SMjoin1", &mesh_id.to_be_bytes(), &advert_nonce.to_be_bytes(), &node.to_be_bytes(), kh]);
    let mut p = [0u8; 16];
    p.copy_from_slice(&h[..16]);
    p
}

/// Locked mode's allow-list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AllowList {
    h: [KeyHash; ALLOW_MAX],
    n: u8,
}

impl Default for AllowList {
    fn default() -> Self {
        AllowList { h: [[0; 8]; ALLOW_MAX], n: 0 }
    }
}

impl AllowList {
    pub fn contains(&self, kh: &KeyHash) -> bool {
        self.h[..self.n as usize].iter().any(|h| ct_eq(h, kh))
    }
    /// False if full (the hash is not added).
    pub fn add(&mut self, kh: KeyHash) -> bool {
        if self.contains(&kh) {
            return true;
        }
        if self.n as usize >= ALLOW_MAX {
            return false;
        }
        self.h[self.n as usize] = kh;
        self.n += 1;
        true
    }
    pub fn remove(&mut self, kh: &KeyHash) {
        if let Some(i) = self.h[..self.n as usize].iter().position(|h| h == kh) {
            self.h[i] = self.h[self.n as usize - 1];
            self.n -= 1;
        }
    }
    pub fn clear(&mut self) {
        self.n = 0;
    }
    pub fn len(&self) -> usize {
        self.n as usize
    }
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
}

/// The persisted mesh state (§7.2): one small littlefs file, written only on membership
/// changes ([`MeshState::encode`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MeshState {
    pub mesh_id: u32,
    pub channel: u8,
    pub mode: Mode,
    /// The mode generation: orders `SetMode`s (a gateway sends the next one; an older or
    /// equal one with a different mode is ignored).
    pub generation: u32,
    /// [`EPOCH_PLAIN`] (0): no mesh key yet.
    pub epoch: u8,
    pub mesh_key: [u8; 16],
    pub site_secret: Option<[u8; SITE_SECRET_LEN]>,
    pub admin_key: Option<PublicKey>,
    /// Device keys the admin removed (signed list, checked at join; §7.6).
    pub revoked: Revocations,
    /// The pairwise key from this device's join and the member it was made with (for a
    /// `RekeyRequest`, M7c).
    pub pairwise: Option<(NodeId, [u8; 16])>,
    pub groups: Groups,
    pub allow: AllowList,
    /// The mesh owner's public key (§7.4, M7b: learned at join, trust on first use).
    pub owner_key: Option<PublicKey>,
    pub source: ProvisionSource,
}

/// Bytes of [`MeshState::encode`].
pub const STATE_LEN: usize = 1 + 4 + 1 + 1 + 4 + 1 + 16 + 1 + 1 + 32 + 65 + Revocations::LEN + 2 + 16 + 1 + 8 + 1 + ALLOW_MAX * 8 + 65 + 4;
const STATE_VERSION: u8 = 1;

fn crc32(b: &[u8]) -> u32 {
    let mut c = !0u32;
    for &x in b {
        c ^= x as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

impl MeshState {
    pub fn has_key(&self) -> bool {
        self.epoch != EPOCH_PLAIN
    }

    pub fn encode(&self) -> [u8; STATE_LEN] {
        let mut b = [0u8; STATE_LEN];
        self.encode_into(&mut b);
        b
    }

    /// [`MeshState::encode`] into `b` (at least [`STATE_LEN`] bytes; firmware: a heap buffer,
    /// not an 0.8 KB stack temporary). Returns [`STATE_LEN`], or 0 if `b` is too small.
    pub fn encode_into(&self, out: &mut [u8]) -> usize {
        let Some(b) = out.get_mut(..STATE_LEN) else { return 0 };
        b.fill(0);
        let flags = (self.site_secret.is_some() as u8)
            | ((self.admin_key.is_some() as u8) << 1)
            | ((self.pairwise.is_some() as u8) << 2)
            | ((self.owner_key.is_some() as u8) << 3);
        let (pw_peer, pw_key) = self.pairwise.unwrap_or((0, [0; 16]));
        let mut w = msg::W::new(b);
        w.u8(STATE_VERSION).u32(self.mesh_id).u8(self.channel).u8(self.mode as u8).u32(self.generation).u8(self.epoch);
        w.put(&self.mesh_key).u8(flags).u8(self.source as u8);
        w.put(&self.site_secret.unwrap_or([0; 32])).put(&self.admin_key.unwrap_or([0; 65]));
        self.revoked.encode_into(&mut w);
        w.u16(pw_peer).put(&pw_key);
        w.u8(self.groups.n).put(&self.groups.ids).u8(self.allow.n).put(self.allow.h.as_flattened());
        w.put(&self.owner_key.unwrap_or([0; 65]));
        let n = w.done().unwrap_or(0);
        debug_assert_eq!(n, STATE_LEN - 4);
        let crc = crc32(&b[..STATE_LEN - 4]);
        b[STATE_LEN - 4..].copy_from_slice(&crc.to_be_bytes());
        STATE_LEN
    }

    pub fn decode(b: &[u8]) -> Option<MeshState> {
        if b.len() != STATE_LEN || crc32(&b[..STATE_LEN - 4]).to_be_bytes() != b[STATE_LEN - 4..] {
            return None;
        }
        let mut r = msg::R::new(&b[..STATE_LEN - 4]);
        (r.u8()? == STATE_VERSION).then_some(())?;
        let mesh_id = r.u32()?;
        let channel = r.u8()?;
        let mode = Mode::from_u8(r.u8()?)?;
        let generation = r.u32()?;
        let epoch = r.u8()?;
        let mesh_key = r.arr()?;
        let flags = r.u8()?;
        let source = if r.u8()? == 1 { ProvisionSource::App } else { ProvisionSource::Factory };
        let site: [u8; 32] = r.arr()?;
        let admin: [u8; 65] = r.arr()?;
        let revoked = Revocations::decode_from(&mut r)?;
        let pw_peer = r.u16()?;
        let pw_key: [u8; 16] = r.arr()?;
        let gn = r.u8()?;
        let gids: [u8; 8] = r.arr()?;
        let an = r.u8()?;
        if gn as usize > Groups::MAX || an as usize > ALLOW_MAX {
            return None;
        }
        let mut allow = AllowList { n: an, ..AllowList::default() };
        allow.h.as_flattened_mut().copy_from_slice(r.take(ALLOW_MAX * 8)?);
        let owner: [u8; 65] = r.arr()?;
        r.end()?;
        Some(MeshState {
            mesh_id,
            channel,
            mode,
            generation,
            epoch,
            mesh_key,
            site_secret: (flags & 1 != 0).then_some(site),
            admin_key: (flags & 2 != 0).then_some(admin),
            revoked,
            pairwise: (flags & 4 != 0).then_some((pw_peer, pw_key)),
            groups: Groups { ids: gids, n: gn },
            allow,
            owner_key: (flags & 8 != 0).then_some(owner),
            source,
        })
    }
}

/// Where this device is in joining its mesh.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// No mesh credentials (a guest may still follow an open mesh, [`crate::guest`]).
    Unprovisioned,
    /// Provisioned; listening for the mesh before acting (§7.9 step 2).
    Searching { until_us: i64 },
    /// Needs the mesh key for the epoch it heard: sending `JoinRequest`s.
    Joining,
    /// Holds the mesh key: sends and relays, answers joins.
    Member,
}

/// The device setting `mesh_follow` (§7.2).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Follow {
    /// Default for a device already in a mesh.
    #[default]
    Off,
    /// Follow any open mesh it hears (what a home-built fixture ships with).
    Open,
}

/// Something membership wants sent; the bytes are in the caller's `out` buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Out {
    /// A plain (epoch 0) frame body, one hop, broadcast.
    Plain(usize),
    /// A mesh packet (under the mesh key) on `port`, broadcast.
    Mesh { port: Port, len: usize },
}

/// What happened, for the stack to act on (re-key the envelope, tell the app).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Note {
    None,
    /// The mesh key or epoch changed (install it in the envelope); persist the state.
    KeysChanged,
    /// The state changed (groups, mode, allow-list): persist it.
    StateChanged,
    /// A gateway heard of a device waiting for approval.
    Pending(PendingJoin),
    /// A guest said hello (gateways list it).
    #[cfg(feature = "open_mode")]
    Guest(GuestHello),
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MembershipStats {
    pub adverts_heard: u32,
    pub join_requests_heard: u32,
    pub joins_admitted: u32,
    /// Requests with a proof that did not verify (wrong secret, stale nonce).
    pub bad_proofs: u32,
    /// Locked mode: a device not on the allow-list.
    pub not_allowed: u32,
    pub joins_pending: u32,
    pub accepts_ignored: u32,
    pub accepts_bad: u32,
    pub joined: u32,
    pub foreign_plain: u32,
    /// Join requests from a revoked device key.
    pub revoked: u32,
    pub malformed: u32,
}

#[derive(Clone, Copy, Debug)]
struct PendingReq {
    req: JoinRequest,
    forwarded_us: Option<i64>,
}

#[derive(Clone, Copy, Debug)]
struct HeardAdvert {
    from: NodeId,
    advert: Advert,
}

#[derive(Clone, Copy, Debug)]
struct MyRequest {
    req_nonce: u32,
    advert_nonce: u32,
    with_proof: bool,
    sent_us: i64,
}

/// One device's membership.
pub struct Membership {
    pub me: NodeId,
    pub mac: [u8; 6],
    pub firmware: u32,
    pub state: Option<MeshState>,
    pub follow: Follow,
    phase: Phase,
    nonces: [u32; NONCES],
    nonce_i: usize,
    best: Option<HeardAdvert>,
    request: Option<MyRequest>,
    pending: [Option<PendingReq>; PENDING],
    rx_ok: u32,
    rx_bad: u32,
    key_suspect: bool,
    admitted: [Option<(KeyHash, i64)>; ADMITTED],
    /// Pending joins a gateway lists for the app ("New fixture nearby: admit?").
    pub gateway_pending: [Option<PendingJoin>; GATEWAY_PENDING],
    #[cfg(feature = "open_mode")]
    pub guests: GuestTable<GUESTS>,
    pub stats: MembershipStats,
}

impl Membership {
    pub fn new(me: NodeId, mac: [u8; 6], firmware: u32) -> Membership {
        Membership {
            me,
            mac,
            firmware,
            state: None,
            follow: Follow::Off,
            phase: Phase::Unprovisioned,
            nonces: [0; NONCES],
            nonce_i: 0,
            best: None,
            request: None,
            pending: [None; PENDING],
            rx_ok: 0,
            rx_bad: 0,
            key_suspect: false,
            admitted: [None; ADMITTED],
            gateway_pending: [None; GATEWAY_PENDING],
            #[cfg(feature = "open_mode")]
            guests: GuestTable::new(),
            stats: MembershipStats::default(),
        }
    }

    /// The envelope's verdict on a frame of our mesh at our epoch: it decrypted (`ok`) or
    /// its MIC failed. Counts during the search only.
    pub fn note_rx(&mut self, ok: bool) {
        if matches!(self.phase, Phase::Searching { .. }) {
            if ok {
                self.rx_ok += 1;
            } else {
                self.rx_bad += 1;
            }
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn is_member(&self) -> bool {
        self.phase == Phase::Member
    }

    pub fn mesh_id(&self) -> Option<u32> {
        self.state.map(|s| s.mesh_id)
    }

    pub fn mode(&self) -> Option<Mode> {
        self.state.map(|s| s.mode)
    }

    pub fn groups(&self) -> Groups {
        self.state.map(|s| s.groups).unwrap_or_default()
    }

    /// The revocation list (device keys and delegates the admin removed); empty with no mesh.
    pub fn revoked(&self) -> crate::rekey::Revocations {
        self.state.map(|s| s.revoked).unwrap_or_default()
    }

    pub fn admin_key(&self) -> Option<&PublicKey> {
        self.state.as_ref().and_then(|s| s.admin_key.as_ref())
    }

    /// Provision this device (either path) and start looking for the mesh. A site secret
    /// without a mesh key gives the epoch-1 key; a mesh key from the app is used as given.
    pub fn provision(&mut self, c: &Credentials, source: ProvisionSource, now_us: i64) -> Note {
        let (epoch, mesh_key) = match (c.mesh_key, c.site_secret) {
            (Some((e, k)), _) if e != EPOCH_PLAIN => (e, k),
            (_, Some(s)) => (EPOCH_FIRST, site_mesh_key(&s, c.mesh_id)),
            _ => (EPOCH_PLAIN, [0; 16]),
        };
        let channel = if c.channel == 0 { derived_channel(c.mesh_id) } else { c.channel };
        self.state = Some(MeshState {
            mesh_id: c.mesh_id,
            channel,
            mode: c.mode,
            generation: 0,
            epoch,
            mesh_key,
            site_secret: c.site_secret,
            admin_key: c.admin_key,
            revoked: Revocations::default(),
            pairwise: None,
            groups: c.groups,
            allow: AllowList::default(),
            owner_key: None,
            source,
        });
        self.best = None;
        self.request = None;
        (self.rx_ok, self.rx_bad, self.key_suspect) = (0, 0, false);
        // An app-provisioned key is the app saying "you are a member": no need to search.
        self.phase = if c.mesh_key.is_some() && epoch != EPOCH_PLAIN {
            Phase::Member
        } else {
            Phase::Searching { until_us: now_us + SEARCH_US }
        };
        Note::KeysChanged
    }

    /// Leave the mesh (the app's `mesh_admin.leave`, or the admin's `Eject`, mesh M7): forget
    /// every credential; the device is unprovisioned again.
    pub fn leave(&mut self) {
        self.state = None;
        self.phase = Phase::Unprovisioned;
        self.best = None;
        self.request = None;
        self.pending = [None; PENDING];
        self.admitted = [None; ADMITTED];
        self.gateway_pending = [None; GATEWAY_PENDING];
        (self.rx_ok, self.rx_bad, self.key_suspect) = (0, 0, false);
    }

    /// Restore persisted state at boot (as if provisioned; searching first).
    pub fn restore(&mut self, s: MeshState, now_us: i64) {
        self.state = Some(s);
        (self.rx_ok, self.rx_bad, self.key_suspect) = (0, 0, false);
        self.phase = Phase::Searching { until_us: now_us + SEARCH_US };
    }

    /// The advert this member sends with each beacon (a fresh join nonce each time).
    /// `epoch` is the epoch this node sends under (during a rotation, the old one until the
    /// switch, so members without the new key don't take the advert for a newer mesh).
    #[allow(clippy::too_many_arguments)]
    pub fn advert(&mut self, rng: &mut dyn Entropy, members: u8, mtu: u16, capacity: Capacity, epoch: u8, diameter: u8, out: &mut [u8]) -> Option<usize> {
        let s = self.state.as_ref()?;
        if self.phase != Phase::Member {
            return None;
        }
        let nonce = rng.u32();
        self.nonces[self.nonce_i] = nonce;
        self.nonce_i = (self.nonce_i + 1) % NONCES;
        let epoch = if epoch == 0 { s.epoch } else { epoch };
        Advert { epoch, mode: s.mode, nonce, members, mtu, channel: s.channel, capacity, diameter }.encode(out)
    }

    /// Timers: the end of the search, join retries, forwarding pending joins. Call each tick
    /// until it returns None.
    pub fn poll(&mut self, now_us: i64, dev: &dyn DeviceKey, rng: &mut dyn Entropy, out: &mut [u8]) -> Option<Out> {
        let s = self.state?;
        if let Phase::Searching { until_us } = self.phase {
            if now_us < until_us {
                return None;
            }
            let newer = self.best.is_some_and(|b| b.advert.epoch > s.epoch);
            // Our epoch's frames heard but none decrypted: the key (so the site secret) is
            // wrong. Ask by approval instead of proving a secret that does not match.
            self.key_suspect = self.rx_bad >= SUSPECT_BAD && self.rx_ok == 0;
            self.phase = if s.has_key() && !newer && !self.key_suspect { Phase::Member } else { Phase::Joining };
        }
        if self.phase == Phase::Joining {
            let best = self.best?;
            let due = self.request.is_none_or(|r| now_us - r.sent_us >= JOIN_RETRY_US);
            if !due {
                return None;
            }
            let pk = dev.public_key();
            let kh = key_hash(&pk);
            let proof = s.site_secret.filter(|_| !self.key_suspect).map(|ss| join_proof(&ss, s.mesh_id, best.advert.nonce, self.me, &kh));
            let req_nonce = self.request.map(|r| r.req_nonce).unwrap_or_else(|| rng.u32());
            let req = JoinRequest {
                node: self.me,
                mac: self.mac,
                public_key: pk,
                firmware: self.firmware,
                req_nonce,
                advert_from: best.from,
                advert_nonce: best.advert.nonce,
                proof,
            };
            self.request = Some(MyRequest {
                req_nonce,
                advert_nonce: best.advert.nonce,
                with_proof: proof.is_some(),
                sent_us: now_us,
            });
            return req.encode(out).map(Out::Plain);
        }
        if self.phase == Phase::Member {
            // Forward one join waiting for approval that the gateways have not heard lately.
            for p in self.pending.iter_mut().flatten() {
                if p.forwarded_us.is_none_or(|t| now_us - t >= PENDING_FORWARD_US) {
                    p.forwarded_us = Some(now_us);
                    let pj = PendingJoin {
                        node: p.req.node,
                        mac: p.req.mac,
                        key_hash: key_hash(&p.req.public_key),
                        firmware: p.req.firmware,
                        heard_by: self.me,
                    };
                    return pj.encode(out).map(|len| Out::Mesh { port: Port::Status, len });
                }
            }
        }
        None
    }

    /// A plain frame (epoch 0) arrived.
    pub fn on_plain(
        &mut self,
        now_us: i64,
        h: &Header,
        body: &[u8],
        dev: &dyn DeviceKey,
        out: &mut [u8],
    ) -> (Option<Out>, Note) {
        let Some(s) = self.state else {
            return (None, Note::None);
        };
        if h.mesh_id != s.mesh_id {
            self.stats.foreign_plain += 1;
            return (None, Note::None);
        }
        match body.first() {
            Some(&msg::T_ADVERT) => {
                let Some(a) = Advert::decode(body) else { return self.malformed() };
                self.stats.adverts_heard += 1;
                // Keep the newest epoch's advert, and the latest nonce from that sender.
                if self.best.is_none_or(|b| a.epoch >= b.advert.epoch) {
                    self.best = Some(HeardAdvert { from: h.src, advert: a });
                }
                if self.phase == Phase::Member && a.epoch > s.epoch {
                    // The mesh moved on (a rotation while we were away, or another island at
                    // a later epoch): ask for its key; keep running on ours until then.
                    self.phase = Phase::Joining;
                    self.request = None;
                }
                (None, Note::None)
            }
            Some(&msg::T_JOIN_REQUEST) => {
                let Some(r) = JoinRequest::decode(body) else { return self.malformed() };
                self.on_join_request(now_us, &s, &r, dev, out)
            }
            Some(&msg::T_JOIN_ACCEPT) => {
                let Some(a) = JoinAccept::decode(body) else { return self.malformed() };
                (None, self.on_join_accept(h, &a, dev))
            }
            #[cfg(feature = "open_mode")]
            Some(&msg::T_GUEST_HELLO) => {
                let Some(g) = GuestHello::decode(body) else { return self.malformed() };
                if self.phase == Phase::Member && s.mode == Mode::Open && self.guests.hello(now_us, &g, body.len()) {
                    return (None, Note::Guest(g));
                }
                (None, Note::None)
            }
            _ => self.malformed(),
        }
    }

    fn malformed(&mut self) -> (Option<Out>, Note) {
        self.stats.malformed += 1;
        (None, Note::None)
    }

    fn proof_ok(&self, s: &MeshState, r: &JoinRequest, kh: &KeyHash) -> bool {
        let (Some(ss), Some(p)) = (s.site_secret, r.proof) else { return false };
        r.advert_from == self.me
            && self.nonces.contains(&r.advert_nonce)
            && r.advert_nonce != 0
            && ct_eq(&join_proof(&ss, s.mesh_id, r.advert_nonce, r.node, kh), &p)
    }

    fn on_join_request(&mut self, now_us: i64, s: &MeshState, r: &JoinRequest, dev: &dyn DeviceKey, out: &mut [u8]) -> (Option<Out>, Note) {
        // Only the member whose advert the joiner answered handles it (one reply, one
        // forward), and only members hold keys to give.
        if self.phase != Phase::Member || r.advert_from != self.me || r.node == self.me {
            return (None, Note::None);
        }
        self.stats.join_requests_heard += 1;
        let kh = key_hash(&r.public_key);
        if s.revoked.contains(&kh) {
            self.stats.revoked += 1;
            return (None, Note::None);
        }
        let proof = self.proof_ok(s, r, &kh);
        if r.proof.is_some() && !proof {
            self.stats.bad_proofs += 1;
        }
        let admitted = self.admitted.iter().flatten().any(|(h, until)| ct_eq(h, &kh) && now_us < *until);
        let ok = match s.mode {
            Mode::Locked => {
                let ok = s.allow.contains(&kh);
                if !ok {
                    self.stats.not_allowed += 1;
                }
                ok
            }
            Mode::Open | Mode::Closed => proof || admitted,
        };
        if !ok {
            // New to us: list it here too (this member may be the gateway the app is on).
            let note = if self.remember_pending(r) { self.on_pending(&self.pending_of(r)) } else { Note::None };
            return (None, note);
        }
        let salt = if proof { s.site_secret } else { None };
        match wrap_keys(dev, s, self.me, r, salt.as_ref(), out) {
            Some(n) => {
                self.stats.joins_admitted += 1;
                self.pending.iter_mut().for_each(|p| {
                    if p.is_some_and(|p| p.req.node == r.node) {
                        *p = None;
                    }
                });
                (Some(Out::Plain(n)), Note::None)
            }
            None => (None, Note::None),
        }
    }

    fn pending_of(&self, r: &JoinRequest) -> PendingJoin {
        PendingJoin { node: r.node, mac: r.mac, key_hash: key_hash(&r.public_key), firmware: r.firmware, heard_by: self.me }
    }

    /// Keep a join waiting for approval; true if it is new.
    fn remember_pending(&mut self, r: &JoinRequest) -> bool {
        if let Some(p) = self.pending.iter_mut().flatten().find(|p| p.req.node == r.node) {
            p.req = *r;
            return false;
        }
        self.stats.joins_pending += 1;
        let slot = match self.pending.iter().position(|p| p.is_none()) {
            Some(i) => i,
            None => {
                // Replace the one forwarded longest ago.
                let mut best = 0;
                for (i, p) in self.pending.iter().enumerate() {
                    if p.and_then(|p| p.forwarded_us) < self.pending[best].and_then(|p| p.forwarded_us) {
                        best = i;
                    }
                }
                best
            }
        };
        self.pending[slot] = Some(PendingReq { req: *r, forwarded_us: None });
        true
    }

    fn on_join_accept(&mut self, h: &Header, a: &JoinAccept, dev: &dyn DeviceKey) -> Note {
        let Some(mut s) = self.state else { return Note::None };
        let mine = self.request.filter(|r| r.req_nonce == a.req_nonce);
        let (Some(r), true, true) = (mine, a.joiner == self.me, self.phase == Phase::Joining) else {
            self.stats.accepts_ignored += 1;
            return Note::None;
        };
        // A joiner that proved the site secret takes the reply only under it (the mesh is
        // genuine); an approval join takes the mesh-id salt (trust on first use).
        let salt = if r.with_proof { s.site_secret } else { None };
        let got = unwrap_keys(dev, &s, self.me, h.src, a, r.advert_nonce, salt.as_ref());
        let Some((mesh_key, admin, wrap)) = got else {
            self.stats.accepts_bad += 1;
            return Note::None;
        };
        s.epoch = a.epoch;
        s.mesh_key = mesh_key;
        s.mode = a.mode;
        if admin.is_some() {
            s.admin_key = admin;
        }
        s.pairwise = Some((h.src, wrap));
        self.state = Some(s);
        self.phase = Phase::Member;
        self.request = None;
        self.key_suspect = false;
        self.stats.joined += 1;
        Note::KeysChanged
    }

    /// An authenticated admin command (the `MEMBERSHIP` port, tag checked by the router).
    pub fn on_command(&mut self, now_us: i64, c: &Command) -> Note {
        let Some(s) = self.state.as_mut() else { return Note::None };
        match *c {
            Command::Admit { node: _, key_hash } => {
                if s.mode == Mode::Locked {
                    s.allow.add(key_hash);
                }
                let slot = self.admitted.iter().position(|a| a.is_none_or(|(_, until)| now_us >= until)).unwrap_or(0);
                self.admitted[slot] = Some((key_hash, now_us + ADMITTED_US));
                self.gateway_pending.iter_mut().for_each(|p| {
                    if p.is_some_and(|p| p.key_hash == key_hash) {
                        *p = None;
                    }
                });
                Note::StateChanged
            }
            Command::AssignGroups { node, groups } => {
                if node != self.me {
                    return Note::None;
                }
                s.groups = groups;
                Note::StateChanged
            }
            Command::SetMode { mode, generation } => {
                if generation <= s.generation {
                    return Note::None; // an older (or repeated) change
                }
                let t = transition(s.mode, mode);
                if t.drop_allow_list {
                    s.allow.clear();
                }
                s.mode = mode;
                s.generation = generation.max(s.generation);
                // TODO(M7c): `t.rotate_key` makes the gateway rotate the mesh key to the
                // members that stay (Rekey, §7.6); members accept both epochs for 60 s.
                Note::StateChanged
            }
            Command::AllowListAdd { hashes, n } => {
                for h in &hashes[..n as usize] {
                    s.allow.add(*h);
                }
                Note::StateChanged
            }
            // The stack acts on an eject for this device (it knows its own key).
            Command::Eject { .. } => Note::None,
        }
    }

    /// New keys from a rotation (verified by [`crate::rekey::RekeyMember`]): the new epoch's
    /// mesh key, the new site secret, and the revocation list.
    pub fn install_rekey(&mut self, k: &crate::rekey::NewKeys) -> Note {
        let Some(s) = self.state.as_mut() else { return Note::None };
        s.epoch = k.epoch;
        s.mesh_key = k.mesh_key;
        s.site_secret = Some(k.site_secret);
        s.revoked.apply(k.rev_version, &k.revoked[..k.n_revoked as usize]);
        Note::KeysChanged
    }

    /// A `PendingJoin` on the `STATUS` port: list it for the app (gateway side).
    pub fn on_pending(&mut self, p: &PendingJoin) -> Note {
        if self.admitted.iter().flatten().any(|(h, _)| *h == p.key_hash) {
            return Note::None;
        }
        let slot = self
            .gateway_pending
            .iter()
            .position(|g| g.is_some_and(|g| g.node == p.node))
            .or_else(|| self.gateway_pending.iter().position(|g| g.is_none()))
            .unwrap_or(0);
        self.gateway_pending[slot] = Some(*p);
        Note::Pending(*p)
    }
}

/// The 13-byte CCM nonce of a key wrap: unique per (joiner, member, epoch, request, advert).
fn wrap_nonce(joiner: NodeId, member: NodeId, epoch: u8, req_nonce: u32, advert_nonce: u32) -> [u8; 13] {
    let mut n = [0u8; 13];
    n[0..2].copy_from_slice(&joiner.to_be_bytes());
    n[2..4].copy_from_slice(&member.to_be_bytes());
    n[4] = epoch;
    n[5..9].copy_from_slice(&req_nonce.to_be_bytes());
    n[9..13].copy_from_slice(&advert_nonce.to_be_bytes());
    n
}

fn wrap_key(shared: &[u8; 32], mesh_id: u32, salt: Option<&[u8; 32]>, joiner: NodeId, member: NodeId, req_nonce: u32) -> [u8; 16] {
    let mid = mesh_id.to_be_bytes();
    let salt: &[u8] = match salt {
        Some(s) => s,
        None => &mid,
    };
    hkdf16(salt, shared, &[b"SMwrap1", &mid, &joiner.to_be_bytes(), &member.to_be_bytes(), &req_nonce.to_be_bytes()])
}

fn wrap_aad(mesh_id: u32, joiner: NodeId, epoch: u8, mode: Mode) -> [u8; 8] {
    let mut a = [0u8; 8];
    a[..4].copy_from_slice(&mesh_id.to_be_bytes());
    a[4..6].copy_from_slice(&joiner.to_be_bytes());
    a[6] = epoch;
    a[7] = mode as u8;
    a
}

/// Member side: a `JoinAccept` with the mesh key and the admin public key wrapped for the joiner.
fn wrap_keys(dev: &dyn DeviceKey, s: &MeshState, me: NodeId, r: &JoinRequest, salt: Option<&[u8; 32]>, out: &mut [u8]) -> Option<usize> {
    let shared = dev.ecdh(&r.public_key)?;
    let k = wrap_key(&shared, s.mesh_id, salt, r.node, me, r.req_nonce);
    let mut w = [0u8; msg::WRAPPED_PLAIN + msg::WRAP_TAG];
    w[..16].copy_from_slice(&s.mesh_key);
    if let Some(a) = s.admin_key {
        w[16..81].copy_from_slice(&a);
        w[81] = 1;
    }
    let nonce = wrap_nonce(r.node, me, s.epoch, r.req_nonce, r.advert_nonce);
    ccm_seal::<8>(&k, &nonce, &wrap_aad(s.mesh_id, r.node, s.epoch, s.mode), &mut w, msg::WRAPPED_PLAIN);
    JoinAccept { joiner: r.node, public_key: dev.public_key(), epoch: s.epoch, mode: s.mode, req_nonce: r.req_nonce, wrapped: w }.encode(out)
}

/// Joiner side: the mesh key, the admin public key (if sent) and the pairwise key.
fn unwrap_keys(
    dev: &dyn DeviceKey,
    s: &MeshState,
    me: NodeId,
    member: NodeId,
    a: &JoinAccept,
    advert_nonce: u32,
    salt: Option<&[u8; 32]>,
) -> Option<([u8; 16], Option<PublicKey>, [u8; 16])> {
    let shared = dev.ecdh(&a.public_key)?;
    let k = wrap_key(&shared, s.mesh_id, salt, me, member, a.req_nonce);
    let mut w = a.wrapped;
    let nonce = wrap_nonce(me, member, a.epoch, a.req_nonce, advert_nonce);
    let wlen = w.len();
    ccm_open::<8>(&k, &nonce, &wrap_aad(s.mesh_id, me, a.epoch, a.mode), &mut w, wlen)?;
    if a.epoch == EPOCH_PLAIN || a.epoch == crate::envelope::EPOCH_OPEN {
        return None;
    }
    let mut mk = [0u8; 16];
    mk.copy_from_slice(&w[..16]);
    let admin = (w[81] == 1).then(|| {
        let mut ak = [0u8; 65];
        ak.copy_from_slice(&w[16..81]);
        ak
    });
    Some((mk, admin, k))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_keys::{AdminSigner, HostKey, TestRng};

    const MESH: u32 = 0x5EED_0001;
    const SITE: [u8; 32] = [0x51; 32];

    fn creds(site: bool) -> Credentials {
        Credentials {
            mesh_id: MESH,
            site_secret: site.then_some(SITE),
            admin_key: Some(AdminSigner::from_secret(b"0123456789abcdef", MESH).public()),
            ..Credentials::default()
        }
    }

    struct Dev {
        m: Membership,
        k: HostKey,
        rng: TestRng,
    }

    impl Dev {
        fn new(id: NodeId) -> Dev {
            Dev { m: Membership::new(id, [2, 0, 0, 0, 0, id as u8], 0x0100), k: HostKey::from_seed(id as u64 + 1), rng: TestRng(id as u64 * 7 + 3) }
        }
        fn poll(&mut self, now: i64) -> Option<Vec<u8>> {
            let mut out = [0u8; 256];
            match self.m.poll(now, &self.k, &mut self.rng, &mut out)? {
                Out::Plain(n) | Out::Mesh { len: n, .. } => Some(out[..n].to_vec()),
            }
        }
        fn advert(&mut self) -> Vec<u8> {
            let mut out = [0u8; 64];
            let n = self.m.advert(&mut self.rng, 2, 250, Capacity::default(), 0, 1, &mut out).unwrap();
            out[..n].to_vec()
        }
        fn hear(&mut self, now: i64, from: NodeId, body: &[u8]) -> (Option<Vec<u8>>, Note) {
            let h = Header { mesh_id: MESH, epoch: 0, src: from, counter: 0, long: false };
            let mut out = [0u8; 256];
            let (o, n) = self.m.on_plain(now, &h, body, &self.k, &mut out);
            (o.map(|o| match o {
                Out::Plain(n) | Out::Mesh { len: n, .. } => out[..n].to_vec(),
            }), n)
        }
    }

    #[test]
    fn transitions_follow_the_design_table() {
        let t = transition(Mode::Open, Mode::Closed);
        assert_eq!((t.follow_stream, t.list_former_guests, t.rotate_key), (Some(false), true, false));
        let t = transition(Mode::Closed, Mode::Locked);
        assert!(t.propose_allow_list && t.rotate_key && t.follow_stream.is_none());
        let t = transition(Mode::Locked, Mode::Closed);
        assert!(t.drop_allow_list && !t.rotate_key);
        for from in [Mode::Closed, Mode::Locked] {
            let t = transition(from, Mode::Open);
            assert_eq!((t.follow_stream, t.rotate_key), (Some(true), false));
        }
        assert_eq!(transition(Mode::Closed, Mode::Closed), Transition::default());
        assert_eq!(removal(Mode::Closed), (Transition { rotate_key: true, ..Transition::default() }, true));
        assert!(!removal(Mode::Locked).1);
    }

    #[test]
    fn state_persists_byte_exact() {
        let mut d = Dev::new(3);
        d.m.provision(&Credentials { groups: Groups::from_slice(&[4, 9]), mode: Mode::Locked, ..creds(true) }, ProvisionSource::App, 0);
        let mut s = d.m.state.unwrap();
        s.allow.add([7; 8]);
        s.pairwise = Some((9, [3; 16]));
        let b = s.encode();
        assert_eq!(MeshState::decode(&b), Some(s));
        let mut bad = b;
        bad[10] ^= 1;
        assert_eq!(MeshState::decode(&bad), None, "crc");
        assert_eq!(MeshState::decode(&b[..STATE_LEN - 1]), None);
    }

    /// Two fixtures with the site secret and nobody else: both search 5 s, hear nothing
    /// (or each other at the same epoch) and are members on the same derived key.
    #[test]
    fn self_configuring_formation() {
        let (mut a, mut b) = (Dev::new(1), Dev::new(2));
        a.m.provision(&creds(true), ProvisionSource::Factory, 0);
        b.m.provision(&creds(true), ProvisionSource::App, 1_000_000);
        assert_eq!(a.m.phase(), Phase::Searching { until_us: SEARCH_US });
        assert_eq!(a.poll(SEARCH_US), None);
        assert!(a.m.is_member(), "nobody heard: a starts the mesh");
        let adv = a.advert();
        b.hear(2_000_000, 1, &adv);
        assert_eq!(b.poll(SEARCH_US + 1_000_000), None);
        assert!(b.m.is_member(), "same epoch: no join exchange needed");
        assert_eq!(a.m.state.unwrap().mesh_key, b.m.state.unwrap().mesh_key);
        assert_eq!(a.m.state.unwrap().epoch, EPOCH_FIRST);
    }

    /// The mesh has rotated to epoch 2; a newcomer with the site secret proves it and gets
    /// the key (and the admin public key) from the member whose advert it answered.
    #[test]
    fn site_secret_join_after_a_rotation() {
        let mut m = Dev::new(1);
        m.m.provision(&Credentials { mesh_key: Some((2, [0x77; 16])), ..creds(true) }, ProvisionSource::App, 0);
        assert!(m.m.is_member());
        let mut j = Dev::new(2);
        j.m.provision(&Credentials { admin_key: None, ..creds(true) }, ProvisionSource::Factory, 0);
        let adv = m.advert();
        j.hear(100, 1, &adv);
        let req = j.poll(SEARCH_US).expect("the search ends in a request");
        assert_eq!(j.m.phase(), Phase::Joining, "epoch 2 > its derived epoch 1");
        let r = JoinRequest::decode(&req).unwrap();
        assert!(r.proof.is_some());
        let (acc, _) = m.hear(SEARCH_US + 2, 2, &req);
        let acc = acc.expect("admitted by its proof");
        let (_, note) = j.hear(SEARCH_US + 3, 1, &acc);
        assert_eq!(note, Note::KeysChanged);
        let js = j.m.state.unwrap();
        assert_eq!((js.epoch, js.mesh_key), (2, [0x77; 16]));
        assert_eq!(js.admin_key, m.m.state.unwrap().admin_key, "the admin key delivered with the mesh key");
        assert!(j.m.is_member());
        assert_eq!(m.m.stats.joins_admitted, 1);
    }

    /// Without the secret: the member forwards a PendingJoin; nothing until an admin admits.
    /// A wrong site secret is noticed (nothing decrypts) and also goes by approval.
    #[test]
    fn approval_join() {
        let mut m = Dev::new(1);
        m.m.provision(&creds(true), ProvisionSource::Factory, 0);
        m.poll(SEARCH_US);
        for wrong_secret in [false, true] {
            let mut j = Dev::new(if wrong_secret { 3 } else { 2 });
            let c = if wrong_secret { Credentials { site_secret: Some([9; 32]), mesh_key: None, ..creds(true) } } else { creds(false) };
            j.m.provision(&c, ProvisionSource::Factory, 0);
            let adv = m.advert();
            j.hear(10, 1, &adv);
            if wrong_secret {
                // Same epoch, so it would believe itself a member; but the members' frames
                // do not decrypt under its key, so it asks by approval, without a proof.
                for _ in 0..SUSPECT_BAD {
                    j.m.note_rx(false);
                }
            }
            let req = j.poll(SEARCH_US).expect("the search ends in a request");
            assert_eq!(j.m.phase(), Phase::Joining);
            assert_eq!(JoinRequest::decode(&req).unwrap().proof, None);
            let (o, note) = m.hear(SEARCH_US + 2, j.m.me, &req);
            assert_eq!(o, None, "not admitted yet");
            assert!(matches!(note, Note::Pending(p) if p.node == j.m.me), "listed on this member too");
            let fwd = m.poll(SEARCH_US + 3).expect("pending forwarded to the gateways");
            let pj = PendingJoin::decode(&fwd).unwrap();
            assert_eq!((pj.node, pj.heard_by), (j.m.me, 1));
            assert_eq!(m.poll(SEARCH_US + 4), None, "once per 10 s");
            // The gateway lists it; the admin admits; the joiner's next request is accepted.
            assert_eq!(m.m.on_pending(&pj), Note::Pending(pj));
            assert_eq!(m.m.on_command(SEARCH_US + 5, &Command::Admit { node: pj.node, key_hash: pj.key_hash }), Note::StateChanged);
            assert!(m.m.gateway_pending.iter().all(|p| p.is_none()));
            let adv = m.advert();
            j.hear(SEARCH_US + 6, 1, &adv);
            assert_eq!(j.poll(SEARCH_US + 7), None, "retries every 2 s");
            let t = SEARCH_US + 1 + JOIN_RETRY_US;
            let req = j.poll(t).expect("asks again, with the newest nonce");
            let acc = m.hear(t + 1, j.m.me, &req).0.expect("admitted");
            assert_eq!(j.hear(t + 2, 1, &acc).1, Note::KeysChanged);
            assert_eq!(j.m.state.unwrap().mesh_key, m.m.state.unwrap().mesh_key);
        }
    }

    /// Locked: a valid site-secret proof is not enough; the allow-list is.
    #[test]
    fn locked_mode_admits_only_the_allow_list() {
        let mut m = Dev::new(1);
        m.m.provision(&Credentials { mode: Mode::Locked, mesh_key: Some((3, [0x33; 16])), ..creds(true) }, ProvisionSource::App, 0);
        let mut j = Dev::new(2);
        j.m.provision(&creds(true), ProvisionSource::Factory, 0);
        let adv = m.advert();
        j.hear(10, 1, &adv);
        let req = j.poll(SEARCH_US).unwrap();
        assert_eq!(m.hear(SEARCH_US + 2, 2, &req).0, None);
        assert_eq!(m.m.stats.not_allowed, 1);
        // Approve it: Admit in locked mode puts it on the allow-list (persisted).
        let kh = key_hash(&j.k.public_key());
        m.m.on_command(SEARCH_US + 3, &Command::Admit { node: 2, key_hash: kh });
        assert!(m.m.state.unwrap().allow.contains(&kh));
        let adv = m.advert();
        j.hear(SEARCH_US + 4, 1, &adv);
        let t = SEARCH_US + 1 + JOIN_RETRY_US;
        let req = j.poll(t).unwrap();
        let acc = m.hear(t + 1, 2, &req).0.expect("on the allow-list");
        assert_eq!(j.hear(t + 2, 1, &acc).1, Note::KeysChanged);
        assert_eq!(j.m.state.unwrap().mode, Mode::Locked);
    }

    /// Replayed, stale and misdirected join traffic does nothing.
    #[test]
    fn join_replays_and_forgeries() {
        let mut m = Dev::new(1);
        m.m.provision(&Credentials { mesh_key: Some((2, [0x77; 16])), ..creds(true) }, ProvisionSource::App, 0);
        let mut j = Dev::new(2);
        j.m.provision(&creds(true), ProvisionSource::Factory, 0);
        let adv = m.advert();
        j.hear(10, 1, &adv);
        let req = j.poll(SEARCH_US).unwrap();
        // The nonce ages out after NONCES more adverts: the same proof is then refused.
        for _ in 0..NONCES {
            m.advert();
        }
        assert_eq!(m.hear(SEARCH_US + 2, 2, &req).0, None);
        assert_eq!(m.m.stats.bad_proofs, 1);
        // A request naming another member's advert is not ours to answer.
        let mut r = JoinRequest::decode(&req).unwrap();
        r.advert_from = 9;
        let mut b = [0u8; 200];
        let n = r.encode(&mut b).unwrap();
        assert_eq!(m.hear(SEARCH_US + 3, 2, &b[..n]).0, None);
        // A JoinAccept for someone else, or with the wrong request nonce, is ignored.
        let adv = m.advert();
        j.hear(SEARCH_US + 4, 1, &adv);
        let req = j.poll(SEARCH_US + 1 + JOIN_RETRY_US).unwrap();
        let acc = m.hear(SEARCH_US + 6, 2, &req).0.unwrap();
        let mut a = JoinAccept::decode(&acc).unwrap();
        a.req_nonce ^= 1;
        let n = a.encode(&mut b).unwrap();
        assert_eq!(j.hear(SEARCH_US + 7, 1, &b[..n]).1, Note::None);
        // A forged accept from an outsider (its own key, so the wrap does not verify under
        // the site-secret salt).
        let mut evil = Dev::new(66);
        evil.m.provision(&Credentials { site_secret: Some([0xEE; 32]), mesh_key: Some((2, [0xEE; 16])), ..creds(true) }, ProvisionSource::App, 0);
        let r = JoinRequest::decode(&req).unwrap();
        let mut b2 = [0u8; 200];
        let es = evil.m.state.unwrap();
        let n = wrap_keys(&evil.k, &es, 1, &r, es.site_secret.as_ref(), &mut b2).unwrap();
        assert_eq!(j.hear(SEARCH_US + 8, 1, &b2[..n]).1, Note::None);
        assert_eq!(j.m.stats.accepts_bad, 1);
        // The real one still works.
        assert_eq!(j.hear(SEARCH_US + 9, 1, &acc).1, Note::KeysChanged);
    }

    #[test]
    fn a_member_hearing_a_newer_epoch_asks_to_join() {
        let mut a = Dev::new(1);
        a.m.provision(&creds(true), ProvisionSource::Factory, 0);
        a.poll(SEARCH_US);
        assert!(a.m.is_member());
        let mut b = Dev::new(2);
        b.m.provision(&Credentials { mesh_key: Some((4, [4; 16])), ..creds(true) }, ProvisionSource::App, 0);
        let adv = b.advert();
        a.hear(SEARCH_US + 1, 2, &adv);
        assert_eq!(a.m.phase(), Phase::Joining);
        let req = a.poll(SEARCH_US + 2).expect("asks at once (no request yet)");
        let acc = b.hear(SEARCH_US + 3, 1, &req).0.unwrap();
        a.hear(SEARCH_US + 4, 2, &acc);
        assert_eq!((a.m.state.unwrap().epoch, a.m.is_member()), (4, true));
    }

    #[test]
    fn commands() {
        let mut d = Dev::new(5);
        d.m.provision(&creds(true), ProvisionSource::Factory, 0);
        assert_eq!(d.m.on_command(0, &Command::AssignGroups { node: 6, groups: Groups::from_slice(&[1]) }), Note::None);
        assert_eq!(d.m.on_command(0, &Command::AssignGroups { node: 5, groups: Groups::from_slice(&[1, 2]) }), Note::StateChanged);
        assert_eq!(d.m.groups().as_slice(), &[1, 2]);
        let g = d.m.state.unwrap().generation;
        assert_eq!(d.m.on_command(0, &Command::SetMode { mode: Mode::Locked, generation: g + 1 }), Note::StateChanged);
        assert_eq!(d.m.mode(), Some(Mode::Locked));
        assert_eq!(d.m.on_command(0, &Command::SetMode { mode: Mode::Open, generation: g }), Note::None, "stale");
        let mut hashes = [[0u8; 8]; Command::ALLOW_BATCH];
        hashes[0] = [1; 8];
        d.m.on_command(0, &Command::AllowListAdd { hashes, n: 1 });
        assert!(d.m.state.unwrap().allow.contains(&[1; 8]));
        let g = d.m.state.unwrap().generation;
        d.m.on_command(0, &Command::SetMode { mode: Mode::Closed, generation: g + 1 });
        assert!(d.m.state.unwrap().allow.is_empty(), "locked -> closed drops the allow-list");
    }
}
