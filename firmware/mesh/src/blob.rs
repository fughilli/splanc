//! Content-addressed blobs and scenes (design §5.5–5.6, mesh M6): how an effect program of
//! any size (up to the player's effect limit) reaches every member, and how a member that
//! joins or reboots later catches up with the mesh's look.
//!
//! **Blobs.** A blob is an encoded `ClientMessage` (a `submit_effect` frame with its `.fxb`, or
//! a few small frames: the uniform values, brightness, crossfade), named by its SHA-256. On
//! the wire it is `BULK` traffic (non-admin, lowest relay priority, inside the mesh envelope),
//! one hop at a time, pulled the way the swarm's page protocol pulls pages
//! (`swarm_net::update`), generalised to one page per blob:
//!
//! - a node that wants blob `H` sends `REQ{id, size, missing bitmap}` to a node that holds it
//!   (one that announced it with `HAVE`, else the scene's origin, the gateway) when nothing
//!   useful arrived for [`Blobs::req_quiet_us`];
//! - a holder answers with the missing chunks, one `DATA{id, size, chunk, bytes}` per paced
//!   bulk slot (`MeshStack::send_bulk`'s 20 ms gap and credit gate). A chunk to a neighbour is
//!   a one-hop broadcast, so every other node fetching the same blob takes it too;
//! - once every chunk is in, the receiver checks the SHA-256 against the scene's hash (the
//!   signed one, below) and only then keeps it ([`BlobStore::finish`]), announces `HAVE` and
//!   serves it in turn. A blob whose hash does not match is dropped and counted.
//!
//! Blobs are not authenticated by who sends them (any member could): the hash is, because the
//! scene that names it is admin-class.
//!
//! **Scenes** ([`SceneMsg`], `SCENE` port, admin-class: the session's per-receiver MACs, M7)
//! name up to [`SCENE_BLOBS`] blobs by full hash and say when to apply them: hold only (the
//! first phase of a share: fetch, answer "have"), at `apply_at` on the show clock (the
//! second: every member switches on the same frame), or at once (catch-up). Members take
//! scenes only from the session, never from gossip.
//!
//! Fixed-size, no allocation (the receive buffer is the device's, [`BlobStore`]); wire formats
//! big-endian like the rest of the layer.

use crate::backhaul::NodeId;
use crate::ports::Targets;
use swarm_net::crypto::Sha256;
use swarm_net::mesh::BROADCAST;

pub type Hash = [u8; 32];
/// A blob's id on the bulk wire: the first 8 bytes of its SHA-256.
pub type BlobId = [u8; 8];

pub fn id_of(h: &Hash) -> BlobId {
    let mut id = [0u8; 8];
    id.copy_from_slice(&h[..8]);
    id
}

pub fn sha256(b: &[u8]) -> Hash {
    let mut h = Sha256::new();
    h.update(b);
    h.finish()
}

/// Bytes per `DATA` chunk (a 200 B 802.11 mesh payload holds 12 B of header and this).
pub const CHUNK: usize = 160;
/// Chunks per blob (one bit each in a request's bitmap).
pub const MAX_CHUNKS: usize = 64;
/// The largest blob: 10 KiB (a C6 player's effect frame is at most 4.5 KiB).
pub const BLOB_MAX: usize = CHUNK * MAX_CHUNKS;

pub const T_REQ: u8 = b'q';
pub const T_DATA: u8 = b'd';
pub const T_HAVE: u8 = b'h';
pub const REQ_LEN: usize = 19;
pub const HAVE_LEN: usize = 11;
pub const DATA_HEAD: usize = 12;
/// The longest bulk body this module sends.
pub const BULK_MAX: usize = DATA_HEAD + CHUNK;

/// A fetch with no progress for this long is given up.
pub const FETCH_STALL_US: i64 = 15_000_000;

/// Where the device keeps blobs: the one being received, and complete ones it can serve and
/// apply. Firmware: heap buffers that exist only while a blob is in use; meshsim: vectors.
pub trait BlobStore {
    /// A complete, hash-checked blob this device holds, by id (to serve it).
    fn find(&mut self, id: &BlobId) -> Option<&[u8]>;
    /// Does the device hold `hash` complete? It may bring it in from elsewhere (firmware:
    /// its persisted effect frame, when that is the blob).
    fn has(&mut self, hash: &Hash, size: usize) -> bool;
    /// Make a receive buffer of `size` bytes for `hash` (any earlier one is dropped).
    /// False: no room.
    fn begin(&mut self, hash: &Hash, size: usize) -> bool;
    /// The receive buffer.
    fn rx(&mut self) -> Option<&mut [u8]>;
    /// The receive ended: `ok` (complete, hash checked) keeps it as a complete blob; else
    /// the buffer is dropped.
    fn finish(&mut self, hash: &Hash, ok: bool);
}

/// A device that keeps no blobs.
pub struct NoBlobs;

impl BlobStore for NoBlobs {
    fn find(&mut self, _: &BlobId) -> Option<&[u8]> {
        None
    }
    fn has(&mut self, _: &Hash, _: usize) -> bool {
        false
    }
    fn begin(&mut self, _: &Hash, _: usize) -> bool {
        false
    }
    fn rx(&mut self) -> Option<&mut [u8]> {
        None
    }
    fn finish(&mut self, _: &Hash, _: bool) {}
}

fn chunks(size: usize) -> usize {
    size.div_ceil(CHUNK)
}

fn mask(size: usize) -> u64 {
    let n = chunks(size);
    if n >= 64 {
        u64::MAX
    } else {
        (1u64 << n) - 1
    }
}

fn chunk_range(size: usize, i: usize) -> core::ops::Range<usize> {
    let s = i * CHUNK;
    s..(s + CHUNK).min(size)
}

/// Servers a receiver remembers for the blob it fetches.
const SERVERS: usize = 4;

#[derive(Clone, Copy, Debug)]
struct Rx {
    hash: Hash,
    size: usize,
    have: u64,
    started_us: i64,
    last_data_us: i64,
    last_req_us: i64,
    reqs: u32,
    /// Who announced it (`HAVE`) or sent us a chunk of it, newest first.
    servers: [NodeId; SERVERS],
    /// The scene's origin (the gateway): asked when no one else is known.
    hint: NodeId,
}

#[derive(Clone, Copy, Debug)]
struct Serve {
    id: BlobId,
    size: usize,
    missing: u64,
    /// The requester, or BROADCAST when more than one asked.
    to: NodeId,
}

const SERVE_SLOTS: usize = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BlobStats {
    pub fetches: u32,
    pub fetched: u32,
    pub bad_hash: u32,
    pub stalled: u32,
    pub no_room: u32,
    pub reqs_sent: u32,
    pub reqs_heard: u32,
    pub chunks_in: u32,
    pub chunks_dup: u32,
    pub chunks_out: u32,
    pub haves: u32,
    pub malformed: u32,
}

/// What a fetch request came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fetch {
    /// The device already holds it.
    Have,
    /// Fetching (or already was).
    Started,
    /// Larger than [`BLOB_MAX`], or empty.
    TooBig,
    /// No buffer for it.
    NoRoom,
}

/// A fetch finished.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlobDone {
    /// Complete and its hash checked: the store keeps it.
    Ok(Hash),
    /// Its bytes did not hash to the name (dropped).
    BadHash(Hash),
    /// No progress for [`FETCH_STALL_US`] (dropped).
    Stalled(Hash),
}

/// The bulk side: one blob being fetched, up to two being served.
pub struct Blobs {
    rx: Option<Rx>,
    serve: [Option<Serve>; SERVE_SLOTS],
    /// A `HAVE` to announce (a blob just completed).
    announce: Option<(BlobId, usize)>,
    pub stats: BlobStats,
    /// Ask again when nothing useful arrived for this long.
    pub req_quiet_us: i64,
}

impl Default for Blobs {
    fn default() -> Self {
        Self::new()
    }
}

impl Blobs {
    pub const fn new() -> Blobs {
        Blobs {
            rx: None,
            serve: [None; SERVE_SLOTS],
            announce: None,
            stats: BlobStats { fetches: 0, fetched: 0, bad_hash: 0, stalled: 0, no_room: 0, reqs_sent: 0, reqs_heard: 0, chunks_in: 0, chunks_dup: 0, chunks_out: 0, haves: 0, malformed: 0 },
            req_quiet_us: 120_000,
        }
    }

    /// The blob being fetched, and how many of its chunks are in.
    pub fn fetching(&self) -> Option<(Hash, usize, usize)> {
        self.rx.map(|r| (r.hash, r.have.count_ones() as usize, chunks(r.size)))
    }

    pub fn serving(&self) -> bool {
        self.serve.iter().any(|s| s.is_some())
    }

    /// Fetch `hash` (`size` bytes) unless the store holds it; `hint` is who to ask when no
    /// holder is known (the scene's origin). One fetch at a time: a different blob replaces
    /// the one in progress (the newest scene wins).
    pub fn fetch(&mut self, now_us: i64, hash: &Hash, size: usize, hint: NodeId, store: &mut dyn BlobStore) -> Fetch {
        if size == 0 || size > BLOB_MAX {
            return Fetch::TooBig;
        }
        if let Some(r) = self.rx.as_mut() {
            if r.hash == *hash && r.size == size {
                r.hint = hint;
                return Fetch::Started;
            }
        }
        if store.has(hash, size) {
            return Fetch::Have;
        }
        if let Some(r) = self.rx.take() {
            store.finish(&r.hash, false);
        }
        if !store.begin(hash, size) {
            self.stats.no_room += 1;
            return Fetch::NoRoom;
        }
        self.stats.fetches += 1;
        self.rx = Some(Rx { hash: *hash, size, have: 0, started_us: now_us, last_data_us: i64::MIN / 2, last_req_us: i64::MIN / 2, reqs: 0, servers: [BROADCAST; SERVERS], hint });
        Fetch::Started
    }

    /// Give up the fetch in progress (the device turns the mesh off, or the scene is gone).
    pub fn abort(&mut self, store: &mut dyn BlobStore) {
        if let Some(r) = self.rx.take() {
            store.finish(&r.hash, false);
        }
    }

    fn note_server(r: &mut Rx, from: NodeId) {
        if r.servers[0] == from {
            return;
        }
        let i = r.servers.iter().position(|&s| s == from).unwrap_or(SERVERS - 1);
        r.servers.copy_within(0..i, 1);
        r.servers[0] = from;
    }

    /// A `BULK` packet from `from`. Returns a finished fetch.
    pub fn on_packet(&mut self, now_us: i64, from: NodeId, body: &[u8], store: &mut dyn BlobStore) -> Option<BlobDone> {
        let (&t, rest) = body.split_first()?;
        let head = |b: &[u8]| -> Option<(BlobId, usize)> {
            let id: BlobId = b.get(..8)?.try_into().ok()?;
            let size = u16::from_be_bytes([*b.get(8)?, *b.get(9)?]) as usize;
            Some((id, size))
        };
        match t {
            T_REQ => {
                let Some((id, size)) = head(rest).filter(|_| body.len() == REQ_LEN) else {
                    self.stats.malformed += 1;
                    return None;
                };
                self.stats.reqs_heard += 1;
                let missing = u64::from_be_bytes(rest[10..18].try_into().ok()?) & mask(size);
                if missing == 0 || !store.find(&id).is_some_and(|b| b.len() == size) {
                    return None;
                }
                if let Some(s) = self.serve.iter_mut().flatten().find(|s| s.id == id) {
                    s.missing |= missing;
                    if s.to != from {
                        s.to = BROADCAST;
                    }
                    return None;
                }
                if let Some(slot) = self.serve.iter_mut().find(|s| s.is_none()) {
                    *slot = Some(Serve { id, size, missing, to: from });
                }
                None
            }
            T_HAVE => {
                let Some((id, size)) = head(rest).filter(|_| body.len() == HAVE_LEN) else {
                    self.stats.malformed += 1;
                    return None;
                };
                if let Some(r) = self.rx.as_mut().filter(|r| id_of(&r.hash) == id && r.size == size) {
                    Self::note_server(r, from);
                    // A fresh holder: ask it now rather than after the quiet time.
                    r.last_req_us = i64::MIN / 2;
                }
                None
            }
            T_DATA => {
                let Some((id, size)) = head(rest).filter(|_| body.len() > DATA_HEAD) else {
                    self.stats.malformed += 1;
                    return None;
                };
                let idx = rest[10] as usize;
                let data = &body[DATA_HEAD..];
                // Someone else serves this chunk to the same neighbourhood: don't repeat it.
                for s in self.serve.iter_mut().flatten().filter(|s| s.id == id && s.to == BROADCAST && idx < 64) {
                    s.missing &= !(1u64 << idx);
                }
                self.serve.iter_mut().for_each(|s| {
                    if s.is_some_and(|v| v.missing == 0) {
                        *s = None;
                    }
                });
                let r = self.rx.as_mut().filter(|r| id_of(&r.hash) == id && r.size == size)?;
                if idx >= chunks(size) || data.len() != chunk_range(size, idx).len() {
                    self.stats.malformed += 1;
                    return None;
                }
                Self::note_server(r, from);
                let bit = 1u64 << idx;
                if r.have & bit != 0 {
                    self.stats.chunks_dup += 1;
                    return None;
                }
                let range = chunk_range(size, idx);
                let buf = store.rx()?;
                buf.get_mut(range)?.copy_from_slice(data);
                r.have |= bit;
                r.last_data_us = now_us;
                self.stats.chunks_in += 1;
                if r.have != mask(size) {
                    return None;
                }
                let r = self.rx.take()?;
                let ok = store.rx().is_some_and(|b| b.len() >= r.size && sha256(&b[..r.size]) == r.hash);
                store.finish(&r.hash, ok);
                if ok {
                    self.stats.fetched += 1;
                    self.announce = Some((id, size));
                    Some(BlobDone::Ok(r.hash))
                } else {
                    self.stats.bad_hash += 1;
                    Some(BlobDone::BadHash(r.hash))
                }
            }
            _ => {
                self.stats.malformed += 1;
                None
            }
        }
    }

    /// Timers: a stalled fetch is given up.
    pub fn poll(&mut self, now_us: i64, store: &mut dyn BlobStore) -> Option<BlobDone> {
        let r = self.rx?;
        if now_us - r.last_data_us.max(r.started_us) < FETCH_STALL_US {
            return None;
        }
        self.rx = None;
        store.finish(&r.hash, false);
        self.stats.stalled += 1;
        Some(BlobDone::Stalled(r.hash))
    }

    /// The next bulk packet to send, into `out` (≥ [`BULK_MAX`] bytes): a chunk being served,
    /// a `HAVE`, or a request. (destination, length).
    pub fn next(&mut self, now_us: i64, store: &mut dyn BlobStore, out: &mut [u8]) -> Option<(NodeId, usize)> {
        if out.len() < BULK_MAX {
            return None;
        }
        // 1. Serve: the lowest missing chunk of the first slot that still has one.
        while let Some(i) = self.serve.iter().position(|s| s.is_some()) {
            let mut s = self.serve[i].expect("some");
            let idx = s.missing.trailing_zeros() as usize;
            s.missing &= !(1u64 << idx);
            self.serve[i] = (s.missing != 0).then_some(s);
            let Some(b) = store.find(&s.id).filter(|b| b.len() == s.size) else {
                self.serve[i] = None;
                continue;
            };
            let range = chunk_range(s.size, idx);
            let n = range.len();
            out[0] = T_DATA;
            out[1..9].copy_from_slice(&s.id);
            out[9..11].copy_from_slice(&(s.size as u16).to_be_bytes());
            out[11] = idx as u8;
            out[DATA_HEAD..DATA_HEAD + n].copy_from_slice(&b[range]);
            self.stats.chunks_out += 1;
            return Some((s.to, DATA_HEAD + n));
        }
        // 2. A blob just completed: say so (one hop), so neighbours fetching it ask us too.
        if let Some((id, size)) = self.announce.take() {
            out[0] = T_HAVE;
            out[1..9].copy_from_slice(&id);
            out[9..11].copy_from_slice(&(size as u16).to_be_bytes());
            self.stats.haves += 1;
            return Some((BROADCAST, HAVE_LEN));
        }
        // 3. Ask for what is missing, when nothing came for a while.
        let r = self.rx.as_mut()?;
        if now_us - r.last_data_us < self.req_quiet_us || now_us - r.last_req_us < self.req_quiet_us {
            return None;
        }
        let known: [NodeId; SERVERS] = r.servers;
        let n = known.iter().take_while(|&&s| s != BROADCAST).count();
        // Rotate over the known holders (one may have gone), the origin among them.
        let dest = if n == 0 || r.reqs % (n as u32 + 1) == n as u32 { r.hint } else { known[r.reqs as usize % n] };
        r.reqs += 1;
        r.last_req_us = now_us;
        let missing = mask(r.size) & !r.have;
        out[0] = T_REQ;
        out[1..9].copy_from_slice(&id_of(&r.hash));
        out[9..11].copy_from_slice(&(r.size as u16).to_be_bytes());
        out[11..19].copy_from_slice(&missing.to_be_bytes());
        self.stats.reqs_sent += 1;
        Some((dest, REQ_LEN))
    }
}

/// `SCENE` port tag of a [`SceneMsg`].
pub const T_SCENE: u8 = b'S';
/// Blobs one scene names (deck A's effect, deck B's effect, the state frames: a catch-up,
/// desk D-465).
pub const SCENE_BLOBS: usize = 3;

/// An admin's instruction about blobs: fetch these, and apply them (or only hold them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SceneMsg {
    pub op_id: u32,
    pub flags: u8,
    /// On the show clock (ms on the time base every member follows), with [`SceneMsg::APPLY`].
    pub apply_at: u32,
    pub targets: Targets,
    pub n: u8,
    pub blobs: [(Hash, u16); SCENE_BLOBS],
}

impl SceneMsg {
    /// Apply once held: at `apply_at` (or at once when that has passed, or with `NOW`).
    pub const APPLY: u8 = 1;
    /// Apply as soon as the blobs are in (catch-up), whatever `apply_at` says.
    pub const NOW: u8 = 2;
    /// Each target answers on `REPLY` (fetched / applied, or why not).
    pub const WANT_REPLY: u8 = 4;
    /// A catch-up: a blob equal to what the member already shows is not reloaded.
    pub const CATCH_UP: u8 = 8;
    /// The largest encoded scene.
    pub const MAX_LEN: usize = 1 + 4 + 1 + 4 + 18 + 1 + SCENE_BLOBS * 34;

    pub fn new(op_id: u32, flags: u8, apply_at: u32, targets: Targets, blobs: &[(Hash, u16)]) -> Option<SceneMsg> {
        if blobs.is_empty() || blobs.len() > SCENE_BLOBS {
            return None;
        }
        let mut b = [([0u8; 32], 0u16); SCENE_BLOBS];
        b[..blobs.len()].copy_from_slice(blobs);
        Some(SceneMsg { op_id, flags, apply_at, targets, n: blobs.len() as u8, blobs: b })
    }

    pub fn blobs(&self) -> &[(Hash, u16)] {
        &self.blobs[..self.n as usize]
    }

    pub fn want_reply(&self) -> bool {
        self.flags & Self::WANT_REPLY != 0
    }

    /// `'S' ‖ op_id (4) ‖ flags ‖ apply_at (4) ‖ targets ‖ n ‖ n × (sha256 ‖ size (2))`.
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        *out.get_mut(0)? = T_SCENE;
        out.get_mut(1..5)?.copy_from_slice(&self.op_id.to_be_bytes());
        *out.get_mut(5)? = self.flags;
        out.get_mut(6..10)?.copy_from_slice(&self.apply_at.to_be_bytes());
        let mut o = 10 + self.targets.encode(out.get_mut(10..)?)?;
        *out.get_mut(o)? = self.n;
        o += 1;
        for (h, s) in self.blobs() {
            out.get_mut(o..o + 32)?.copy_from_slice(h);
            out.get_mut(o + 32..o + 34)?.copy_from_slice(&s.to_be_bytes());
            o += 34;
        }
        Some(o)
    }

    pub fn decode(b: &[u8]) -> Option<SceneMsg> {
        if *b.first()? != T_SCENE {
            return None;
        }
        let op_id = u32::from_be_bytes(b.get(1..5)?.try_into().ok()?);
        let flags = *b.get(5)?;
        let apply_at = u32::from_be_bytes(b.get(6..10)?.try_into().ok()?);
        let (targets, t) = Targets::decode(b.get(10..)?)?;
        let mut o = 10 + t;
        let n = *b.get(o)? as usize;
        o += 1;
        if n == 0 || n > SCENE_BLOBS || b.len() != o + 34 * n {
            return None;
        }
        let mut blobs = [([0u8; 32], 0u16); SCENE_BLOBS];
        for bl in blobs.iter_mut().take(n) {
            bl.0.copy_from_slice(&b[o..o + 32]);
            bl.1 = u16::from_be_bytes([b[o + 32], b[o + 33]]);
            if bl.1 == 0 || bl.1 as usize > BLOB_MAX {
                return None;
            }
            o += 34;
        }
        Some(SceneMsg { op_id, flags, apply_at, targets, n: n as u8, blobs })
    }
}

/// The state blob of a scene: small `ClientMessage` frames (uniform values, brightness,
/// crossfade), each `len (2) ‖ frame`, applied in order after the effect.
pub fn frames(b: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut o = 0usize;
    core::iter::from_fn(move || {
        let n = u16::from_be_bytes([*b.get(o)?, *b.get(o + 1)?]) as usize;
        let f = b.get(o + 2..o + 2 + n)?;
        o += 2 + n;
        Some(f)
    })
}

/// Append one frame to a state blob being built in `out` at `*len`. False: no room.
pub fn push_frame(out: &mut [u8], len: &mut usize, frame: &[u8]) -> bool {
    let n = frame.len();
    if n > u16::MAX as usize || *len + 2 + n > out.len() {
        return false;
    }
    out[*len..*len + 2].copy_from_slice(&(n as u16).to_be_bytes());
    out[*len + 2..*len + 2 + n].copy_from_slice(frame);
    *len += 2 + n;
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec::Vec;

    /// A store of complete blobs and one receive buffer.
    #[derive(Default)]
    pub struct VecStore {
        pub held: Vec<(Hash, Vec<u8>)>,
        pub rx: Option<(Hash, Vec<u8>)>,
    }

    impl BlobStore for VecStore {
        fn find(&mut self, id: &BlobId) -> Option<&[u8]> {
            self.held.iter().find(|(h, _)| id_of(h) == *id).map(|(_, b)| b.as_slice())
        }
        fn has(&mut self, hash: &Hash, size: usize) -> bool {
            self.held.iter().any(|(h, b)| h == hash && b.len() == size)
        }
        fn begin(&mut self, hash: &Hash, size: usize) -> bool {
            self.rx = Some((*hash, vec![0; size]));
            true
        }
        fn rx(&mut self) -> Option<&mut [u8]> {
            self.rx.as_mut().map(|(_, b)| b.as_mut_slice())
        }
        fn finish(&mut self, hash: &Hash, ok: bool) {
            if let Some((h, b)) = self.rx.take() {
                if ok && h == *hash {
                    self.held.push((h, b));
                }
            }
        }
    }

    fn blob(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 7 + i / 300) as u8).collect()
    }

    /// Pump packets between a holder (id 1) and receivers until quiet; `lose` drops every
    /// k-th packet. Returns the finished fetches per receiver.
    fn run(size: usize, receivers: usize, lose: usize) -> (Vec<Option<BlobDone>>, Blobs) {
        let b = blob(size);
        let h = sha256(&b);
        let mut srv = Blobs::new();
        let mut srv_store = VecStore { held: vec![(h, b.clone())], rx: None };
        let mut rx: Vec<(Blobs, VecStore)> = (0..receivers).map(|_| (Blobs::new(), VecStore::default())).collect();
        let mut done = vec![None; receivers];
        let mut t = 0i64;
        for (r, s) in rx.iter_mut() {
            assert_eq!(r.fetch(t, &h, size, 1, s), Fetch::Started);
        }
        let mut sent = 0usize;
        let mut out = [0u8; BULK_MAX];
        for _ in 0..20_000 {
            t += 20_000;
            // Each receiver may send (a request); the server answers one chunk per slot.
            let mut air: Vec<(NodeId, NodeId, Vec<u8>)> = Vec::new();
            for (i, (r, s)) in rx.iter_mut().enumerate() {
                if let Some((d, n)) = r.next(t, s, &mut out) {
                    air.push((10 + i as NodeId, d, out[..n].to_vec()));
                }
            }
            if let Some((d, n)) = srv.next(t, &mut srv_store, &mut out) {
                air.push((1, d, out[..n].to_vec()));
            }
            for (from, to, p) in air {
                sent += 1;
                if lose > 0 && sent % lose == 0 {
                    continue;
                }
                if to == 1 || to == BROADCAST {
                    srv.on_packet(t, from, &p, &mut srv_store);
                }
                for (i, (r, s)) in rx.iter_mut().enumerate() {
                    if from != 10 + i as NodeId && (to == BROADCAST || to == 10 + i as NodeId) {
                        if let Some(d) = r.on_packet(t, from, &p, s) {
                            done[i] = Some(d);
                        }
                    }
                }
            }
            if done.iter().all(|d| d.is_some()) && !srv.serving() {
                break;
            }
        }
        for (i, (_, s)) in rx.iter_mut().enumerate() {
            if done[i] == Some(BlobDone::Ok(h)) {
                assert_eq!(s.held[0].1, b, "receiver {i}: the bytes");
            }
        }
        (done, srv)
    }

    #[test]
    fn fetch_one_and_many() {
        let size = 4321;
        let h = sha256(&blob(size));
        let (done, srv) = run(size, 1, 0);
        assert_eq!(done, [Some(BlobDone::Ok(h))]);
        assert_eq!(srv.stats.chunks_out as usize, chunks(size), "every chunk once");
        // Three receivers: broadcast chunks serve all of them.
        let (done, srv) = run(size, 3, 0);
        assert!(done.iter().all(|d| *d == Some(BlobDone::Ok(h))));
        assert!((srv.stats.chunks_out as usize) < 2 * chunks(size), "shared, not per receiver: {}", srv.stats.chunks_out);
    }

    #[test]
    fn fetch_with_loss() {
        let size = BLOB_MAX;
        let h = sha256(&blob(size));
        let (done, _) = run(size, 2, 5);
        assert!(done.iter().all(|d| *d == Some(BlobDone::Ok(h))), "{done:?}");
    }

    #[test]
    fn hash_checked_before_use() {
        let b = blob(500);
        let mut wrong = sha256(&b);
        wrong[31] ^= 1;
        // A holder serving bytes under a name they don't hash to (an id collision, or a liar).
        let mut srv = Blobs::new();
        let mut ss = VecStore { held: vec![(wrong, b.clone())], rx: None };
        let mut r = Blobs::new();
        let mut rs = VecStore::default();
        assert_eq!(r.fetch(0, &wrong, 500, 1, &mut rs), Fetch::Started);
        let mut out = [0u8; BULK_MAX];
        let mut t = 0;
        let mut res = None;
        for _ in 0..100 {
            t += 200_000;
            if let Some((_, n)) = r.next(t, &mut rs, &mut out) {
                srv.on_packet(t, 9, &out[..n], &mut ss);
            }
            while let Some((_, n)) = srv.next(t, &mut ss, &mut out) {
                if let Some(d) = r.on_packet(t, 1, &out[..n], &mut rs) {
                    res = Some(d);
                }
            }
            if res.is_some() {
                break;
            }
        }
        assert_eq!(res, Some(BlobDone::BadHash(wrong)));
        assert!(rs.held.is_empty(), "not kept");
        assert_eq!(r.stats.bad_hash, 1);
    }

    #[test]
    fn have_skips_and_stall_gives_up() {
        let b = blob(300);
        let h = sha256(&b);
        let mut s = VecStore { held: vec![(h, b)], rx: None };
        let mut r = Blobs::new();
        assert_eq!(r.fetch(0, &h, 300, 1, &mut s), Fetch::Have);
        assert_eq!(r.fetch(0, &h, BLOB_MAX + 1, 1, &mut s), Fetch::TooBig);
        let other = sha256(b"x");
        let mut e = VecStore::default();
        assert_eq!(r.fetch(0, &other, 10, 1, &mut e), Fetch::Started);
        assert_eq!(r.poll(FETCH_STALL_US - 1, &mut e), None);
        assert_eq!(r.poll(FETCH_STALL_US + 1, &mut e), Some(BlobDone::Stalled(other)));
        assert!(e.rx.is_none());
    }

    #[test]
    fn scene_and_frames_round_trip() {
        let h1 = sha256(b"a");
        let h2 = sha256(b"b");
        let m = SceneMsg::new(7, SceneMsg::APPLY | SceneMsg::WANT_REPLY, 12_345, Targets::nodes(&[3, 4]).unwrap(), &[(h1, 4000), (h2, 90)]).unwrap();
        let mut b = [0u8; SceneMsg::MAX_LEN];
        let n = m.encode(&mut b).unwrap();
        assert_eq!(SceneMsg::decode(&b[..n]), Some(m));
        assert_eq!(SceneMsg::decode(&b[..n - 1]), None);
        let all = SceneMsg::new(1, 0, 0, Targets::All, &[(h1, 1)]).unwrap();
        let n = all.encode(&mut b).unwrap();
        assert!(n <= SceneMsg::MAX_LEN);
        assert_eq!(SceneMsg::decode(&b[..n]), Some(all));
        let mut s = [0u8; 64];
        let mut len = 0;
        assert!(push_frame(&mut s, &mut len, b"one"));
        assert!(push_frame(&mut s, &mut len, b"three"));
        assert!(!push_frame(&mut s, &mut len, &[0; 60]));
        assert_eq!(frames(&s[..len]).collect::<Vec<_>>(), [b"one".as_slice(), b"three".as_slice()]);
    }
}
