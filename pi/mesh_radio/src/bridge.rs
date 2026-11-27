//! The Pi bridge as a mesh node (issue #697; docs/design/mesh-pi-transport.md §7): the full
//! per-device stack (`splanc_mesh::MeshStack`, the one the C6 runs) on a Linux backhaul,
//! with a device key in a file, the persisted mesh state, a RAM blob store and the member
//! side of relayed control. `pimesh serve` runs it as the bridge image's `splanc-mesh`
//! service; the agent reads and drives it over a Unix socket ([`Bridge::command`]).
//!
//! **Membership is the mesh's own** (mesh.md §7): the bridge is provisioned with the mesh id
//! and the admin public key only (no site secret), so it can only *ask* to join. A gateway
//! lists it as pending (`MeshState.pending`, its join's `firmware` is [`BRIDGE_FIRMWARE`]) and
//! the admin admits it from the app like any fixture. Holding an admin key, it re-provisions
//! or leaves only with the provisioner token it issued (D-324), as a C6 does. It never holds
//! the admin secret, signs nothing for the mesh, and starts no show epoch: it is a member,
//! not a gateway (the agent's LAN gateway path, agent/src/bridge/mesh.ts, unlocks a C6 with
//! a delegate's grant instead).
//!
//! **What it reports.** Its status broadcast carries `firmware` = [`BRIDGE_FIRMWARE`] (the
//! FNV-1a of "splanc-bridge", like a C6's hash of its version string), `fps` 0 and the Pi's
//! available memory, so the app draws it as a bridge (web/src/ui/screens/meshTopoModel.ts),
//! not a fixture that stopped rendering; its topology lists its radio neighbours with RSSI
//! and unicast delivery from the radio's ACK status ([`crate::WifiBackhaul`]).
//!
//! **A member with no LEDs.** Relayed control on the allow-list is answered OK (there is
//! nothing to apply, and a gateway waiting for its answer would list it missing); anything
//! else is refused, as on a C6. Scenes (effect shares, M6) are fetched into RAM and kept,
//! so the bridge is a custodian that can serve them on.
//!
//! **Channel.** AP-anchored, like every C6 (mesh.md §4.2): the bridge stays associated to
//! its Wi-Fi and its adverts announce the channel its interface is on. When the mesh's
//! adverts say another channel (the bridge is on a 5 GHz network, or a different AP), the
//! status says so (`channel_ok: false`) and the screens tell the user to put the bridge on
//! the lamps' 2.4 GHz network; it does not hop channels (that would drop its own Wi-Fi).

use std::collections::VecDeque;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use splanc_mesh::blob::{id_of, BlobId, BlobStore, Hash};
use splanc_mesh::crypto::{ct_eq, key_hash, DeviceKey, Entropy, PublicKey};
use splanc_mesh::gateway::{relay_arm, ReplyMsg, Status, StatusMsg};
use splanc_mesh::host_keys::HostKey;
use splanc_mesh::membership::{Credentials, MeshState, Mode, Phase, ProvisionSource, STATE_LEN};
use splanc_mesh::msg::Class;
use splanc_mesh::stack::{Event, StackConfig};
use splanc_mesh::topo::{Link, PoseKnown, TX_UNKNOWN};
use splanc_mesh::{Backhaul, MeshStack, NodeId};
use swarm_net::update::Flash;

/// Payload size, as on the C6 (`mesh_ffi.rs` P) and in meshsim.
pub const P: usize = 200;
/// What the bridge's status broadcasts and join requests carry as `firmware`: the FNV-1a of
/// "splanc-bridge" (C6s send the FNV-1a of their version string, main.cpp
/// `lm_mesh_status_fill`). The app tells a bridge from a fixture by it.
pub const BRIDGE_FIRMWARE: u32 = fnv1a(b"splanc-bridge");
/// Provisioner token bytes (D-324).
pub const TOKEN_LEN: usize = 16;
/// The persisted record: the mesh state, a token flag, the token.
pub const RECORD_LEN: usize = STATE_LEN + 1 + TOKEN_LEN;
/// Blobs kept in RAM (effects and their state blobs; the oldest goes first).
pub const BLOBS: usize = 16;
/// Largest blob taken (a C6 effect is at most tens of KB).
pub const BLOB_MAX: usize = 256 * 1024;
/// How often the status input is refreshed (the stack broadcasts it on its own schedule).
const STATUS_INPUT_US: i64 = 1_000_000;
/// Log lines kept for `status`.
const LOG_LINES: usize = 32;

pub const fn fnv1a(b: &[u8]) -> u32 {
    let mut h = 2_166_136_261u32;
    let mut i = 0;
    while i < b.len() {
        h = (h ^ b[i] as u32).wrapping_mul(16_777_619);
        i += 1;
    }
    h
}

/// Randomness from the kernel (`/dev/urandom`: getrandom's pool, never blocks after boot).
pub struct OsRng;

impl Entropy for OsRng {
    fn fill(&mut self, out: &mut [u8]) {
        let mut f = fs::File::open("/dev/urandom").expect("/dev/urandom");
        f.read_exact(out).expect("/dev/urandom read");
    }
}

/// Swarm firmware updates do not apply to a Pi: no flash.
pub struct NoFlash;

impl Flash for NoFlash {
    fn capacity(&self) -> u32 {
        0
    }
    fn erase(&mut self, _: u32, _: u32) -> bool {
        false
    }
    fn write(&mut self, _: u32, _: &[u8]) -> bool {
        false
    }
    fn read(&mut self, _: u32, _: &mut [u8]) -> bool {
        false
    }
}

/// Complete blobs (served to members that ask, M6) and the one being received, in RAM.
#[derive(Default)]
pub struct RamBlobs {
    pub held: VecDeque<(Hash, Vec<u8>)>,
    rx: Option<(Hash, Vec<u8>)>,
}

impl BlobStore for RamBlobs {
    fn find(&mut self, id: &BlobId) -> Option<&[u8]> {
        self.held.iter().find(|(h, _)| id_of(h) == *id).map(|(_, b)| b.as_slice())
    }
    fn has(&mut self, hash: &Hash, size: usize) -> bool {
        self.held.iter().any(|(h, b)| h == hash && b.len() == size)
    }
    fn begin(&mut self, hash: &Hash, size: usize) -> bool {
        if size > BLOB_MAX {
            return false;
        }
        self.rx = Some((*hash, vec![0; size]));
        true
    }
    fn rx(&mut self) -> Option<&mut [u8]> {
        self.rx.as_mut().map(|(_, b)| b.as_mut_slice())
    }
    fn finish(&mut self, hash: &Hash, ok: bool) {
        if let Some((h, b)) = self.rx.take() {
            if ok && h == *hash && !self.held.iter().any(|(x, _)| *x == h) {
                if self.held.len() >= BLOBS {
                    self.held.pop_front();
                }
                self.held.push_back((h, b));
            }
        }
    }
}

/// Write `data` to `path` atomically (temp file, fsync, rename, fsync the directory): a
/// power cut leaves the old file or the new one, never a torn one.
pub fn write_atomic(path: &Path, data: &[u8], mode: u32) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let dir = path.parent().unwrap_or(Path::new("."));
    let tmp = dir.join(format!(".{}.tmp", path.file_name().and_then(|s| s.to_str()).unwrap_or("f")));
    {
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(mode).open(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

/// The bridge's device key: a P-256 secret in `path` (0600), made on first start. It is the
/// identity a grant or an admit names (`key_hash`); it never leaves the file.
pub fn load_or_create_key(path: &Path, rng: &mut dyn Entropy) -> io::Result<HostKey> {
    match fs::read(path) {
        Ok(b) if b.len() == 32 => {
            let d: [u8; 32] = b[..].try_into().unwrap();
            HostKey::from_secret(&d).ok_or_else(|| io::Error::other(format!("{}: not a P-256 key", path.display())))
        }
        Ok(b) => Err(io::Error::other(format!("{}: {} bytes, expected 32", path.display(), b.len()))),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let k = loop {
                let mut d = [0u8; 32];
                rng.fill(&mut d);
                if let Some(k) = HostKey::from_secret(&d) {
                    break k;
                }
            };
            write_atomic(path, &k.secret(), 0o600)?;
            Ok(k)
        }
        Err(e) => Err(e),
    }
}

fn hex(b: &[u8]) -> String {
    use std::fmt::Write as _;
    b.iter().fold(String::with_capacity(2 * b.len()), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    })
}

pub fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok()).collect()
}

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// What the host tells the node each pass besides the time.
#[derive(Clone, Copy, Debug, Default)]
pub struct HostInfo {
    /// The channel the interface is on (its AP's), if known.
    pub channel: Option<u8>,
    /// Available memory (bytes) and its low-water mark, for the status broadcast.
    pub mem_free: u32,
    pub mem_min: u32,
}

/// Counters for `status`.
#[derive(Clone, Copy, Debug, Default)]
pub struct BridgeStats {
    pub controls: u32,
    pub refused: u32,
    pub scenes: u32,
    pub persisted: u32,
    pub persist_failed: u32,
}

pub type Stack<B> = MeshStack<B, P, HostKey, OsRng>;

pub struct Bridge<B: Backhaul> {
    pub stack: Stack<B>,
    pub blobs: RamBlobs,
    scratch: Vec<u8>,
    /// Where the mesh state and the frame-counter mark live (None: RAM only, tests).
    dir: Option<PathBuf>,
    token: Option<[u8; TOKEN_LEN]>,
    dirty: bool,
    pub stats: BridgeStats,
    pub log: VecDeque<String>,
    started_us: i64,
    status_at_us: i64,
    pub host: HostInfo,
    /// How this node's radio was picked (`nl80211`, `brcm`, `udp`), for `status`.
    pub via: String,
    was_member: bool,
}

/// The device's own node id from its MAC (`wifi_p2p::node_id_from_mac`).
pub fn node_id(mac: &[u8; 6]) -> NodeId {
    splanc_mesh::wifi_p2p::node_id_from_mac(mac)
}

impl<B: Backhaul> Bridge<B> {
    /// The node for `backhaul` (`mac` is its radio's), keyed by `key`; with `dir`, the
    /// persisted state and counter mark are restored from it and kept there.
    pub fn new(mac: [u8; 6], backhaul: B, key: HostKey, dir: Option<PathBuf>, now_us: i64) -> io::Result<Bridge<B>> {
        let counter_mark = dir.as_ref().and_then(|d| fs::read(d.join("counter")).ok()).and_then(|b| b.get(..8).map(|x| u64::from_be_bytes(x.try_into().unwrap()))).unwrap_or(0);
        let cfg = StackConfig { counter_mark, firmware: BRIDGE_FIRMWARE, class: Class::Pi, ..StackConfig::default() };
        let mut stack = MeshStack::new(node_id(&mac), mac, backhaul, key, OsRng, cfg).map_err(|e| io::Error::other(format!("{e:?}")))?;
        // No room pose: the topology still goes out ("not placed").
        stack.set_pose(PoseKnown::Unposed);
        let scratch = vec![0u8; stack.scratch_len()];
        let mut b = Bridge {
            stack,
            blobs: RamBlobs::default(),
            scratch,
            dir,
            token: None,
            dirty: false,
            stats: BridgeStats::default(),
            log: VecDeque::new(),
            started_us: now_us,
            status_at_us: i64::MIN / 2,
            host: HostInfo::default(),
            via: String::new(),
            was_member: false,
        };
        b.restore(now_us);
        Ok(b)
    }

    fn note(&mut self, s: String) {
        eprintln!("[mesh] {s}");
        if self.log.len() >= LOG_LINES {
            self.log.pop_front();
        }
        self.log.push_back(s);
    }

    fn restore(&mut self, now_us: i64) {
        let Some(d) = self.dir.as_ref() else { return };
        let Ok(b) = fs::read(d.join("mesh.bin")) else { return };
        if b.len() != RECORD_LEN {
            self.note(format!("stored state unusable ({} B): not restored", b.len()));
            return;
        }
        let Some(s) = MeshState::decode(&b[..STATE_LEN]) else {
            self.note("stored state does not decode: not restored".into());
            return;
        };
        self.token = (b[STATE_LEN] == 1).then(|| b[STATE_LEN + 1..].try_into().unwrap());
        self.stack.restore(now_us, s);
        self.note(format!("restored mesh_id={:08x} epoch={} admin_key={}", s.mesh_id, s.epoch, s.admin_key.is_some() as u8));
    }

    fn persist(&mut self) {
        self.dirty = false;
        let Some(d) = self.dir.clone() else { return };
        let path = d.join("mesh.bin");
        let r = match self.stack.membership.state {
            None => match fs::remove_file(&path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            },
            Some(s) => {
                let mut rec = vec![0u8; RECORD_LEN];
                s.encode_into(&mut rec[..STATE_LEN]);
                rec[STATE_LEN] = self.token.is_some() as u8;
                rec[STATE_LEN + 1..].copy_from_slice(&self.token.unwrap_or([0; TOKEN_LEN]));
                write_atomic(&path, &rec, 0o600)
            }
        };
        match r {
            Ok(()) => self.stats.persisted += 1,
            Err(e) => {
                self.stats.persist_failed += 1;
                self.note(format!("persist failed: {e}"));
                self.dirty = true;
            }
        }
    }

    /// One pass: the stack's tick (receive, timers, adverts, sessions), one crypto job, the
    /// events, persistence, the status input. Bounded; call every few ms.
    pub fn step(&mut self, now_us: i64) {
        if let Some(ch) = self.host.channel {
            self.stack.set_channel(ch);
        }
        if now_us - self.status_at_us >= STATUS_INPUT_US {
            self.status_at_us = now_us;
            let t = &self.stack.time;
            self.stack.set_status(StatusMsg {
                firmware: BRIDGE_FIRMWARE,
                uptime_s: ((now_us - self.started_us) / 1_000_000).clamp(0, u32::MAX as i64) as u32,
                heap_free: self.host.mem_free,
                heap_min: self.host.mem_min,
                fps: 0,
                brightness: 0,
                sync: t.state as u8,
                time_err_us: t.err_us.clamp(0, u16::MAX as i64) as u16,
                last_error: 0,
                last_error_op: 0,
            });
        }
        let mut evs: Vec<Ev> = Vec::new();
        let mut scratch = std::mem::take(&mut self.scratch);
        self.stack.tick_blobs(now_us, &mut NoFlash, &mut self.blobs, &mut scratch, &mut |e| evs.push(Ev::from(e)));
        self.scratch = scratch;
        if self.stack.crypto_pending() {
            self.stack.run_crypto(now_us);
        }
        for e in evs {
            self.on_event(now_us, e);
        }
        let member = self.stack.membership.is_member();
        if member && !self.was_member {
            self.note(format!("member id={:04x}", self.stack.me()));
        }
        self.was_member = member;
        if self.dirty {
            self.persist();
        }
    }

    fn on_event(&mut self, _now_us: i64, e: Ev) {
        match e {
            Ev::Control { origin, op_id, want_reply, inner } => {
                self.stats.controls += 1;
                let (status, arm, code) = match relay_arm(&inner) {
                    Ok(a) => (Status::Ok, a, 0),
                    Err(r) => {
                        self.stats.refused += 1;
                        let a = splanc_mesh::gateway::client_arm(&inner).map_or(0, |(a, _)| a);
                        self.note(format!("refused relayed control op={op_id} from={origin:04x}: {r:?}"));
                        (Status::Refused, a, a.min(0xffff) as u16)
                    }
                };
                if want_reply {
                    let _ = self.stack.reply(origin, &ReplyMsg { op_id, status, arm: arm.min(255) as u8, code });
                }
            }
            Ev::Scene { origin, op_id, want_reply } => {
                self.stats.scenes += 1;
                if want_reply {
                    let _ = self.stack.reply(origin, &ReplyMsg { op_id, status: Status::Ok, arm: 21, code: 0 });
                }
            }
            Ev::PersistCounter(c) => {
                let ok = match self.dir.as_ref() {
                    Some(d) => write_atomic(&d.join("counter"), &c.to_be_bytes(), 0o600).is_ok(),
                    None => true,
                };
                if ok {
                    self.stack.node.guard.counter_reserved(c);
                } else {
                    self.note("counter mark not persisted: holding back".into());
                }
            }
            Ev::Joined(ep) => {
                self.note(format!("joined epoch={ep}"));
                self.dirty = true;
            }
            Ev::Rekeyed(ep) => {
                self.note(format!("rekeyed epoch={ep}"));
                self.dirty = true;
            }
            Ev::StateChanged => self.dirty = true,
            Ev::Ejected => {
                self.note("ejected by the admin: left the mesh".into());
                self.token = None;
                self.dirty = true;
            }
            Ev::Other => {}
        }
    }

    /// `provision`: join mesh `mesh_id` by approval (no site secret: a gateway lists it as
    /// pending and the admin admits it). On a bridge that already holds an admin key this
    /// needs the provisioner token it issued. Returns the token (a fresh one, or the
    /// holder's).
    pub fn provision(&mut self, now_us: i64, mesh_id: u32, admin_key: Option<PublicKey>, channel: u8, token: Option<&[u8]>) -> Result<[u8; TOKEN_LEN], &'static str> {
        let by_token = self.by_token(token);
        if self.stack.membership.admin_key().is_some() && !by_token {
            return Err("locked: this bridge is in a mesh with an admin key; give its provisioner token");
        }
        if mesh_id == 0 || channel > 14 {
            return Err("bad request");
        }
        if admin_key.is_some_and(|k| k[0] != 0x04) {
            return Err("bad admin key");
        }
        let c = Credentials { mesh_id, channel, mode: Mode::Closed, site_secret: None, mesh_key: None, admin_key, ..Credentials::default() };
        self.stack.leave();
        self.stack.provision(now_us, &c, ProvisionSource::App);
        if !by_token || self.token.is_none() {
            let mut t = [0u8; TOKEN_LEN];
            OsRng.fill(&mut t);
            self.token = Some(t);
        }
        self.dirty = true;
        self.note(format!("provisioned mesh_id={mesh_id:08x} admin_key={} channel={channel}", admin_key.is_some() as u8));
        Ok(self.token.unwrap())
    }

    /// `leave`: out of the mesh, state erased. Needs the token when it holds an admin key.
    pub fn leave(&mut self, token: Option<&[u8]>) -> Result<(), &'static str> {
        if self.stack.membership.admin_key().is_some() && !self.by_token(token) {
            return Err("locked: give this bridge's provisioner token");
        }
        self.stack.leave();
        self.token = None;
        self.dirty = true;
        self.note("left the mesh".into());
        Ok(())
    }

    fn by_token(&self, t: Option<&[u8]>) -> bool {
        match (t, self.token.as_ref()) {
            (Some(t), Some(o)) => t.len() == TOKEN_LEN && ct_eq(t, o),
            _ => false,
        }
    }

    pub fn phase_name(&self) -> &'static str {
        match self.stack.membership.phase() {
            Phase::Unprovisioned => "off",
            Phase::Searching { .. } => "searching",
            Phase::Joining => "joining",
            Phase::Member => "member",
        }
    }

    /// The node as JSON (the agent's `mesh` status; one line).
    pub fn status_json(&self, now_us: i64) -> String {
        let s = &self.stack;
        let pk = s.dev.public_key();
        let mut links = [Link::EMPTY; 8];
        let n = s.links(now_us, &mut links);
        let nb: Vec<String> = links[..n]
            .iter()
            .map(|l| {
                let mut o = format!("{{\"node\":{},\"rssi\":{}", l.node, l.rssi);
                if l.tx_pct != TX_UNKNOWN {
                    o.push_str(&format!(",\"tx_ok_pct\":{}", l.tx_pct));
                }
                o.push('}');
                o
            })
            .collect();
        let st = s.membership.state.as_ref();
        let heard = s.heard_channel(now_us);
        let ch = self.host.channel;
        let channel_ok = match (heard, ch) {
            (Some(h), Some(c)) => h == c,
            _ => true,
        };
        let members = s.fanout.live(now_us).count();
        let log: Vec<String> = self.log.iter().map(|l| json_str(l)).collect();
        let opt = |v: Option<u8>| v.map_or("null".to_string(), |x| x.to_string());
        format!(
            "{{\"v\":1,\"node\":{},\"phase\":\"{}\",\"member\":{},\"mesh_id\":{},\"admin_key\":{},\"key_hash\":\"{}\",\"device_key\":\"{}\",\"firmware\":{},\"channel\":{},\"heard_channel\":{},\"channel_ok\":{},\"sync\":{},\"neighbours\":[{}],\"members_heard\":{},\"via\":{},\"uptime_s\":{},\"stats\":{{\"controls\":{},\"refused\":{},\"scenes\":{},\"blobs\":{},\"persisted\":{},\"persist_failed\":{}}},\"log\":[{}]}}",
            s.me(),
            self.phase_name(),
            s.membership.is_member(),
            st.map_or(0, |x| x.mesh_id),
            st.is_some_and(|x| x.admin_key.is_some()),
            hex(&key_hash(&pk)),
            hex(&pk),
            BRIDGE_FIRMWARE,
            opt(ch),
            opt(heard),
            channel_ok,
            s.time.state as u8,
            nb.join(","),
            members,
            json_str(&self.via),
            (now_us - self.started_us) / 1_000_000,
            self.stats.controls,
            self.stats.refused,
            self.stats.scenes,
            self.blobs.held.len(),
            self.stats.persisted,
            self.stats.persist_failed,
            log.join(",")
        )
    }

    /// One control-socket line: `status`, `provision <mesh_id hex> <admin_key hex|-> [channel]
    /// [token hex]`, `leave [token hex]`. The reply is one JSON line.
    pub fn command(&mut self, now_us: i64, line: &str) -> String {
        let w: Vec<&str> = line.split_whitespace().collect();
        let err = |e: &str| format!("{{\"ok\":false,\"error\":{}}}", json_str(e));
        match w.first().copied() {
            Some("status") | None => self.status_json(now_us),
            Some("provision") => {
                let Some(mesh_id) = w.get(1).and_then(|x| u32::from_str_radix(x, 16).ok()) else { return err("provision <mesh_id hex> <admin_key hex|-> [channel] [token hex]") };
                let admin_key: Option<PublicKey> = match w.get(2).copied() {
                    None | Some("-") => None,
                    Some(h) => match unhex(h).and_then(|b| <[u8; 65]>::try_from(b.as_slice()).ok()) {
                        Some(k) => Some(k),
                        None => return err("bad admin key"),
                    },
                };
                let channel = w.get(3).and_then(|x| x.parse::<u8>().ok()).unwrap_or(0);
                let token = w.get(4).and_then(|h| unhex(h));
                match self.provision(now_us, mesh_id, admin_key, channel, token.as_deref()) {
                    Ok(t) => format!("{{\"ok\":true,\"token\":\"{}\",\"node\":{}}}", hex(&t), self.stack.me()),
                    Err(e) => err(e),
                }
            }
            Some("leave") => {
                let token = w.get(1).and_then(|h| unhex(h));
                match self.leave(token.as_deref()) {
                    Ok(()) => "{\"ok\":true}".into(),
                    Err(e) => err(e),
                }
            }
            Some(c) => err(&format!("unknown command {c:?}")),
        }
    }
}

/// The events the bridge acts on, copied out of the tick's callback.
enum Ev {
    Control { origin: NodeId, op_id: u32, want_reply: bool, inner: Vec<u8> },
    Scene { origin: NodeId, op_id: u32, want_reply: bool },
    PersistCounter(u64),
    Joined(u8),
    Rekeyed(u8),
    StateChanged,
    Ejected,
    Other,
}

impl From<Event<'_>> for Ev {
    fn from(e: Event<'_>) -> Ev {
        match e {
            Event::Control { origin, header, inner } => Ev::Control { origin, op_id: header.op_id, want_reply: header.want_reply(), inner: inner.to_vec() },
            Event::Scene { origin, msg } => Ev::Scene { origin, op_id: msg.op_id, want_reply: msg.want_reply() },
            Event::PersistCounter(c) => Ev::PersistCounter(c),
            Event::Joined { epoch } => Ev::Joined(epoch),
            Event::Rekeyed { epoch } => Ev::Rekeyed(epoch),
            Event::StateChanged => Ev::StateChanged,
            Event::Ejected => Ev::Ejected,
            _ => Ev::Other,
        }
    }
}

/// Available memory from /proc/meminfo (bytes, saturating).
pub fn mem_available() -> u32 {
    fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|s| s.lines().find(|l| l.starts_with("MemAvailable:")).and_then(|l| l.split_whitespace().nth(1)).and_then(|k| k.parse::<u64>().ok()))
        .map_or(0, |kb| (kb * 1024).min(u32::MAX as u64) as u32)
}

#[cfg(test)]
mod tests {
    //! The bridge against a C6-like gateway (the same `MeshStack` the C6 runs, over an
    //! in-memory radio with ACKs and RSSI): it joins only by the admin's admit, is listed with
    //! the bridge marker and its links, answers relayed control, and keeps its state.
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    use super::*;
    use crate::radio::{RawRadio, RawRx};
    use crate::wifi::{WifiBackhaul, WifiConfig};
    use splanc_mesh::host_keys::{AdminSigner, TestRng};
    use splanc_mesh::membership::Credentials;
    use splanc_mesh::ports::Targets;
    use splanc_mesh::stack::Event;

    #[derive(Default)]
    struct Air {
        macs: Vec<[u8; 6]>,
        q: Vec<VecDeque<Vec<u8>>>,
        results: Vec<Vec<([u8; 6], bool)>>,
    }

    struct FakeRadio {
        air: Rc<RefCell<Air>>,
        i: usize,
        rssi: i8,
    }

    impl FakeRadio {
        fn join(air: &Rc<RefCell<Air>>, mac: [u8; 6], rssi: i8) -> FakeRadio {
            let mut a = air.borrow_mut();
            a.macs.push(mac);
            a.q.push(VecDeque::new());
            a.results.push(Vec::new());
            FakeRadio { air: air.clone(), i: a.macs.len() - 1, rssi }
        }
    }

    impl RawRadio for FakeRadio {
        fn mac(&self) -> [u8; 6] {
            self.air.borrow().macs[self.i]
        }
        fn send(&mut self, f: &[u8]) -> io::Result<()> {
            let mut a = self.air.borrow_mut();
            let da: [u8; 6] = f[4..10].try_into().unwrap();
            let mut delivered = false;
            for j in 0..a.macs.len() {
                if j != self.i && (da == [0xff; 6] || da == a.macs[j]) {
                    a.q[j].push_back(f.to_vec());
                    delivered = true;
                }
            }
            if da[0] & 1 == 0 {
                let i = self.i;
                a.results[i].push((da, delivered));
            }
            Ok(())
        }
        fn recv(&mut self, buf: &mut [u8]) -> io::Result<Option<RawRx>> {
            let Some(f) = self.air.borrow_mut().q[self.i].pop_front() else { return Ok(None) };
            buf[..f.len()].copy_from_slice(&f);
            Ok(Some(RawRx { len: f.len(), rssi_dbm: Some(self.rssi), rx_us: 0 }))
        }
        fn take_tx_results(&mut self, out: &mut Vec<([u8; 6], bool)>) {
            out.append(&mut self.air.borrow_mut().results[self.i]);
        }
    }

    type Gw = MeshStack<WifiBackhaul<FakeRadio>, P, HostKey, TestRng>;

    const MESH: u32 = 0x5350_4c42;
    const SECRET: [u8; 32] = [9; 32];
    const GW_MAC: [u8; 6] = [0x02, 0, 0, 0, 0x10, 0x01];
    const BR_MAC: [u8; 6] = [0xb8, 0x27, 0xeb, 0, 0x20, 0x02];

    fn cfg() -> WifiConfig {
        WifiConfig { rate_kbps: 54_000, max_duty: 0.9, ..WifiConfig::default() }
    }

    struct Bench {
        t: i64,
        gw: Gw,
        br: Bridge<WifiBackhaul<FakeRadio>>,
        admin: AdminSigner,
        pending: Vec<splanc_mesh::msg::PendingJoin>,
        replies: Vec<ReplyMsg>,
    }

    fn bench(dir: Option<PathBuf>) -> Bench {
        let air = Rc::new(RefCell::new(Air::default()));
        let g = WifiBackhaul::new(FakeRadio::join(&air, GW_MAC, -48), cfg());
        let b = WifiBackhaul::new(FakeRadio::join(&air, BR_MAC, -55), cfg());
        let mut gw: Gw = MeshStack::new(node_id(&GW_MAC), GW_MAC, g, HostKey::from_seed(1), TestRng(7), StackConfig::default()).unwrap();
        let admin = AdminSigner::from_secret(&[3; 16], MESH);
        gw.provision(0, &Credentials { mesh_id: MESH, channel: 6, site_secret: Some(SECRET), admin_key: Some(admin.public()), ..Credentials::default() }, ProvisionSource::App);
        let br = Bridge::new(BR_MAC, b, HostKey::from_seed(2), dir, 0).unwrap();
        Bench { t: 0, gw, br, admin, pending: Vec::new(), replies: Vec::new() }
    }

    impl Bench {
        fn run_ms(&mut self, ms: i64) {
            let mut flash = NoFlash;
            let mut scratch = vec![0u8; self.gw.scratch_len()];
            for _ in 0..ms / 2 {
                self.t += 2_000;
                let t = self.t;
                self.gw.node.backhaul.set_now(t);
                self.br.stack.node.backhaul.set_now(t);
                let (pending, replies) = (&mut self.pending, &mut self.replies);
                let mut mark = None;
                self.gw.tick(t, &mut flash, &mut scratch, &mut |e| match e {
                    Event::Pending(p) => pending.push(p),
                    // The C6 persists the counter mark, then may seal under it (§7.5).
                    Event::PersistCounter(m) => mark = Some(m),
                    Event::Packet { body, .. } => {
                        if let Some(r) = ReplyMsg::decode(body) {
                            replies.push(r);
                        }
                    }
                    _ => {}
                });
                if let Some(m) = mark {
                    self.gw.node.guard.counter_reserved(m);
                }
                self.gw.run_crypto(t);
                self.br.host.channel = Some(6);
                self.br.step(t);
            }
        }

        fn run_until(&mut self, max_ms: i64, mut f: impl FnMut(&Bench) -> bool) -> bool {
            for _ in 0..max_ms / 100 {
                if f(self) {
                    return true;
                }
                self.run_ms(100);
            }
            f(self)
        }

        fn unlock(&mut self) {
            let not_after = self.gw.mesh_s(self.t) + 3600;
            let g = self.admin.grant(MESH, 77, self.gw.me(), self.gw.dev.public_key(), not_after);
            self.gw.unlock(self.t, 0, &g, None).expect("grant");
        }
    }

    #[test]
    fn marker_is_the_fnv1a_of_splanc_bridge() {
        // The app matches this constant (web/src/net/mesh.ts BRIDGE_FIRMWARE).
        assert_eq!(BRIDGE_FIRMWARE, 0x18d4_bfec);
    }

    #[test]
    fn the_bridge_joins_only_when_the_admin_admits_it() {
        let mut b = bench(None);
        assert!(b.run_until(30_000, |b| b.gw.membership.is_member()), "the gateway founded its mesh");
        let tok = b.br.provision(b.t, MESH, Some(b.admin.public()), 0, None).expect("provision");
        let got = b.run_until(30_000, |b| !b.pending.is_empty());
        assert!(got, "the gateway lists the bridge as pending");
        let p = b.pending[0];
        assert_eq!(p.node, node_id(&BR_MAC));
        assert_eq!(p.firmware, BRIDGE_FIRMWARE, "its join says it is a bridge");
        assert_eq!(p.key_hash, key_hash(&b.br.stack.dev.public_key()));
        // Without the admit nothing more happens: it keeps asking.
        b.run_ms(10_000);
        assert_eq!(b.br.phase_name(), "joining");
        assert!(!b.br.stack.membership.is_member());
        // The admin admits it through the gateway's session.
        b.unlock();
        let t = b.t;
        b.gw.admit(t, 0, &p).expect("admit");
        assert!(b.run_until(15_000, |b| b.br.stack.membership.is_member()), "admitted");
        assert_eq!(b.br.stack.membership.admin_key(), Some(&b.admin.public()));
        // Listed with its marker, its status and its links.
        assert!(b.run_until(25_000, |b| b.gw.fanout.member(b.t, node_id(&BR_MAC)).is_some_and(|m| m.status.is_some() && m.topo.n > 0)), "status and topology reach the gateway");
        let m = b.gw.fanout.member(b.t, node_id(&BR_MAC)).unwrap();
        assert_eq!(m.status.unwrap().firmware, BRIDGE_FIRMWARE);
        assert_eq!(m.status.unwrap().fps, 0);
        let l = m.topo.links()[0];
        assert_eq!(l.node, b.gw.me());
        assert_eq!(l.rssi, -55, "the bridge's RSSI of the gateway");
        // Its own status: the gateway as a neighbour, with delivery from ACKs.
        let js = b.br.status_json(b.t);
        assert!(js.contains("\"phase\":\"member\""), "{js}");
        assert!(js.contains(&format!("\"node\":{},\"rssi\":-55", b.gw.me())), "{js}");
        assert!(js.contains("\"channel_ok\":true"), "{js}");
        // A re-provision now needs the token it issued.
        assert!(b.br.provision(b.t, MESH + 1, None, 0, None).is_err());
        assert!(b.br.leave(Some(&[0; TOKEN_LEN])).is_err());
        assert!(b.br.leave(Some(&tok)).is_ok());
        assert_eq!(b.br.phase_name(), "off");
    }

    /// The agent may join knowing only the mesh id (read from a fixture's get_mesh on the
    /// LAN): the admin key then arrives in the admit's JoinAccept, authenticated.
    #[test]
    fn a_bridge_given_only_the_mesh_id_learns_the_admin_key_at_admit() {
        let mut b = bench(None);
        assert!(b.run_until(30_000, |b| b.gw.membership.is_member()));
        b.br.provision(b.t, MESH, None, 0, None).unwrap();
        assert!(b.run_until(30_000, |b| !b.pending.is_empty()), "pending");
        assert_eq!(b.br.stack.membership.admin_key(), None);
        b.unlock();
        let (t, p) = (b.t, b.pending[0]);
        b.gw.admit(t, 0, &p).unwrap();
        assert!(b.run_until(15_000, |b| b.br.stack.membership.is_member()), "admitted");
        assert_eq!(b.br.stack.membership.admin_key(), Some(&b.admin.public()));
    }

    #[test]
    fn relayed_control_is_answered_and_off_list_is_refused() {
        let mut b = bench(None);
        assert!(b.run_until(30_000, |b| b.gw.membership.is_member()));
        b.br.provision(b.t, MESH, Some(b.admin.public()), 0, None).unwrap();
        assert!(b.run_until(30_000, |b| !b.pending.is_empty()));
        b.unlock();
        let (t, p) = (b.t, b.pending[0]);
        b.gw.admit(t, 0, &p).unwrap();
        assert!(b.run_until(15_000, |b| b.br.stack.membership.is_member()));
        assert!(b.run_until(20_000, |b| b.br.stack.sessions.get(77).is_some_and(|s| s.floor.is_some())), "the bridge syncs the admin session");
        // set_brightness{brightness: 0.5} (arm 31) and set_device_name (27, never relayed).
        // (The field key is a two-byte varint: (arm << 3) | 2 > 127.)
        let ok = [0xfa, 0x01, 5, 0x0d, 0, 0, 0, 0x3f];
        let off = [0xda, 0x01, 3, 0x0a, 1, b'x'];
        let t = b.t;
        b.gw.send_control_collect(t, 0, 501, Targets::All, &ok, 31, 2_000_000).expect("send");
        b.run_ms(2_000);
        let t = b.t;
        b.gw.send_control_collect(t, 0, 502, Targets::All, &off, 27, 2_000_000).ok();
        b.run_ms(2_000);
        let r501 = b.gw.fanout.take_done_op(501).expect("op 501 done");
        assert_eq!(&r501.status[..r501.n as usize], &[Status::Ok], "answered OK");
        let r502 = b.gw.fanout.take_done_op(502).expect("op 502 done");
        assert_eq!(&r502.status[..r502.n as usize], &[Status::Refused], "off the allow-list: refused");
        assert_eq!((b.br.stats.controls, b.br.stats.refused), (2, 1));
    }

    #[test]
    fn the_mesh_state_and_token_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("pimesh-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let mut b = bench(Some(dir.clone()));
        b.run_ms(3_000);
        let tok = b.br.provision(b.t, MESH, Some(b.admin.public()), 0, None).unwrap();
        b.run_ms(10);
        assert_eq!(fs::read(dir.join("mesh.bin")).unwrap().len(), RECORD_LEN);
        // A new process: same key file, same state.
        let air = Rc::new(RefCell::new(Air::default()));
        let bh = WifiBackhaul::new(FakeRadio::join(&air, BR_MAC, -55), cfg());
        let mut br2 = Bridge::new(BR_MAC, bh, HostKey::from_seed(2), Some(dir.clone()), 0).unwrap();
        assert_eq!(br2.stack.membership.mesh_id(), Some(MESH));
        assert!(br2.leave(None).is_err(), "the restored admin key still needs the token");
        assert!(br2.leave(Some(&tok)).is_ok());
        br2.step(1_000);
        assert!(!dir.join("mesh.bin").exists(), "leaving erases the stored state");
        // The device key file: made once, then the same key.
        let k1 = load_or_create_key(&dir.join("device.key"), &mut TestRng(5)).unwrap();
        let k2 = load_or_create_key(&dir.join("device.key"), &mut TestRng(6)).unwrap();
        assert_eq!(k1.public_key(), k2.public_key());
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(dir.join("device.key")).unwrap().permissions().mode() & 0o777, 0o600);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn command_lines() {
        let mut b = bench(None);
        let pk = hex(&b.admin.public());
        let r = b.br.command(0, &format!("provision {MESH:08x} {pk}"));
        assert!(r.starts_with("{\"ok\":true,\"token\":\""), "{r}");
        assert!(b.br.command(0, "provision zz").contains("\"ok\":false"));
        assert!(b.br.command(0, "leave").contains("locked"));
        assert!(b.br.command(0, "status").contains("\"phase\":\"searching\""));
        assert!(b.br.command(0, "bogus").contains("unknown command"));
    }
}
