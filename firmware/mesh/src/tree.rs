//! Two-tier distribution tree (design §5.8): the gateway reaches N relays (L2) over UWB where
//! it can, and each relay reaches up to M fixtures (L3) over 802.11, N × M ≥ the mesh.
//!
//! The structure is an RPL-style DODAG rooted at whichever node is the gateway, built and
//! repaired cooperatively from what every node already hears (no central planner, no single
//! point of failure):
//!
//! - **Link quality**: per neighbour and per radio, an ETX estimate from advert reception
//!   (EWMA over 1 s windows), bootstrapped from positions (localization) while there are fewer
//!   than 3 windows of history, and reset when a neighbour moves.
//! - **Cost**: a node's rank is its path cost to the root, `rank(parent) + w(radio) · ETX`, with
//!   UWB links weighted below 802.11 (no contention, its own airtime), so the gateway's UWB
//!   neighbours become the L2 tier. Joining a parent that has no children yet costs
//!   [`NEW_RELAY_COST`] more (HEED-like consolidation: fewer relays, fewer 802.11
//!   rebroadcasts). A parent at its child cap (M, by capacity class) is skipped.
//! - **Hysteresis**: switch parent only for a cost gain of [`SWITCH_GAIN`], at most once per
//!   [`DWELL_US`]; a parent counts as lost only after [`LOST_US`] of silence. Walking people
//!   (seconds of shadowing) do not flap the tree; a dead relay is replaced within ~3 s.
//! - **Loops**: a node only picks parents whose rank is below its own (or any, when orphaned);
//!   when its rank rises it advertises it at once.
//! - **Roles**: root (the gateway), relay (has children), leaf, orphan. Relays rebroadcast
//!   tree packets on 802.11 once; leaves never relay. Orphans and nodes without a tree fall
//!   back to the managed flood.
//!
//! Security is unchanged: the tree only decides who forwards. Per-receiver MACs and
//! freshness are end to end (gateway → member), so a relay can drop but not forge.
//!
//! Pure, no allocation. RAM: [`Tree`] is ~0.5 KB with 16 neighbours.

use crate::backhaul::NodeId;
use crate::msg::Class;

/// Neighbours tracked (the best by link quality are kept).
pub const NBRS: usize = 16;
/// ETX fixed point: 1.0 = 256.
pub const ONE: u16 = 256;
/// Weight of a link in the path cost, ×256: UWB below 802.11.
pub const W_UWB: u32 = 128;
pub const W_WIFI: u32 = 256;
/// Extra cost of a parent that would become a new relay (×256).
pub const NEW_RELAY_COST: u16 = 128;
/// Switch to a better parent only for this much (×256), at most once per dwell.
pub const SWITCH_GAIN: u16 = 128;
pub const DWELL_US: i64 = 5_000_000;
/// A parent silent this long is lost (local repair).
pub const LOST_US: i64 = 3_000_000;
/// A parent that advertises no route (it lost its own) is given this long to recover before
/// its children move: a relay's brief repair must not cascade down its subtree.
pub const HOLD_US: i64 = 2_000_000;
/// A neighbour silent this long is forgotten.
pub const FORGET_US: i64 = 10_000_000;
/// Rank of a node with no path.
pub const INFINITE: u16 = u16::MAX;
/// Links worse than this ETX are not used for the tree.
pub const MAX_LINK_ETX: u16 = 3 * ONE;
/// A neighbour that moved more than this (decimetres) has its link history reset.
pub const MOVED_DM: i32 = 20;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum Radio {
    #[default]
    Wifi = 0,
    Uwb = 1,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum Role {
    #[default]
    Orphan = 0,
    Root = 1,
    Relay = 2,
    Leaf = 3,
}

/// Neighbour-table slots kept free of children: the parent plus candidate parents.
pub const CANDIDATE_SLOTS: usize = 4;

/// Children a relay advertises it accepts (M). It is a join filter, so a soft cap: joiners that
/// race on a stale count can overshoot it, and children with no other eligible parent stay.
/// With the full-MAC broadcast data plane a relay's child count costs no airtime (it
/// rebroadcasts once either way). Shedding excess children was tried and removed: at 32
/// fixtures it raised parent changes from 1.7-5.3 to 4.3-7.4 per node-minute without bounding
/// the excess. The class target is clamped so the children and
/// the parent candidates fit in the neighbour table (a child must stay in the table to be
/// counted). With 16 slots: C6 8, P4 12, Pi 12; a larger table on P4/Pi lifts the clamp.
pub const fn advertised_cap(class: Class) -> u8 {
    let c = child_cap(class) as usize;
    let room = NBRS - CANDIDATE_SLOTS;
    (if c < room { c } else { room }) as u8
}

/// Children a relay would accept (M) by capacity class, before the table clamp.
pub const fn child_cap(class: Class) -> u8 {
    match class {
        Class::C6 => 8,
        Class::P4 => 16,
        Class::Pi => 32,
    }
}

/// What a node puts in its adverts (both radios): 12 bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TreeAd {
    pub root: NodeId,
    /// The root's tree version: bumped by the root to clear stale state.
    pub version: u8,
    pub rank: u16,
    pub role: Role,
    pub parent: NodeId,
    pub children: u8,
    pub cap: u8,
    pub uwb: bool,
    /// Its link to its parent is UWB (multi-hop UWB, §5.8: a relay forwards over UWB to the
    /// children that name it over UWB, over 802.11 to the rest).
    pub parent_uwb: bool,
    /// The last tree packet sequence this node has from the root (gap detection by children).
    pub seq: u16,
}

impl TreeAd {
    pub const LEN: usize = 12;

    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let flags = (self.role as u8) | ((self.uwb as u8) << 2) | ((self.parent_uwb as u8) << 3);
        crate::codec::W::new(out).u16(self.root).u8(self.version).u16(self.rank).u8(flags).u16(self.parent).u8(self.children).u8(self.cap).u16(self.seq).done()
    }

    pub fn decode(b: &[u8]) -> Option<TreeAd> {
        let mut r = crate::codec::R::new(b);
        let root = r.u16()?;
        let version = r.u8()?;
        let rank = r.u16()?;
        let flags = r.u8()?;
        let role = match flags & 3 {
            0 => Role::Orphan,
            1 => Role::Root,
            2 => Role::Relay,
            _ => Role::Leaf,
        };
        let ad = TreeAd { root, version, rank, role, parent: r.u16()?, children: r.u8()?, cap: r.u8()?, uwb: flags & 4 != 0, parent_uwb: flags & 8 != 0, seq: r.u16()? };
        r.end()?;
        Some(ad)
    }
}

/// One radio's link estimate to a neighbour.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Link {
    /// ETX ×256 (0: no estimate yet).
    pub etx: u16,
    heard: u8,
    windows: u8,
}

impl Link {
    fn usable(&self) -> bool {
        self.etx != 0 && self.etx <= MAX_LINK_ETX
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Nbr {
    pub id: NodeId,
    pub ad: TreeAd,
    pub class_cap: u8,
    pub wifi: Link,
    pub uwb: Link,
    pub last_us: i64,
    /// Position from localization (decimetres), if known.
    pub pos: Option<(i16, i16)>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TreeStats {
    pub parent_changes: u32,
    pub local_repairs: u32,
    pub rank_raises: u32,
    /// Neighbour-table evictions (a new neighbour displaced an old one).
    pub evictions: u32,
    /// Newly heard neighbours not admitted (table full of better or protected entries).
    pub refused: u32,
    /// Why the parent was declared lost: silence, no route past HOLD_US, evicted from the table.
    pub lost_silent: u32,
    pub lost_no_route: u32,
    pub lost_evicted: u32,
}

/// One node's view of the tree.
pub struct Tree {
    pub me: NodeId,
    pub uwb: bool,
    pub class: Class,
    pub root: Option<NodeId>,
    pub version: u8,
    pub role: Role,
    pub rank: u16,
    pub parent: Option<(NodeId, Radio)>,
    pub children: u8,
    pub seq: u16,
    pub pos: Option<(i16, i16)>,
    nbrs: [Option<Nbr>; NBRS],
    switched_us: i64,
    parent_heard_us: i64,
    parent_bad_since: Option<i64>,
    pub stats: TreeStats,
}

/// The ETX a distance suggests before any history (802.11 at 6 Mb/s in an enclosure: good to
/// ~8 m; UWB line of sight: good to ~15 m).
pub fn prior_etx(radio: Radio, d_dm: i32) -> u16 {
    let good = if radio == Radio::Uwb { 150 } else { 80 };
    if d_dm <= good {
        ONE + ONE / 8
    } else if d_dm <= good * 2 {
        2 * ONE
    } else {
        0
    }
}

fn dist_dm(a: (i16, i16), b: (i16, i16)) -> i32 {
    let dx = a.0 as i32 - b.0 as i32;
    let dy = a.1 as i32 - b.1 as i32;
    // Integer sqrt (dm).
    let sq = (dx * dx + dy * dy) as u32;
    let mut r = 0u32;
    while (r + 1) * (r + 1) <= sq {
        r += 1;
    }
    r as i32
}

impl Tree {
    pub fn new(me: NodeId, uwb: bool, class: Class) -> Tree {
        Tree {
            me,
            uwb,
            class,
            root: None,
            version: 0,
            role: Role::Orphan,
            rank: INFINITE,
            parent: None,
            children: 0,
            seq: 0,
            pos: None,
            nbrs: [None; NBRS],
            switched_us: i64::MIN / 2,
            parent_heard_us: 0,
            parent_bad_since: None,
            stats: TreeStats::default(),
        }
    }

    /// This node becomes the root (it holds the app's session), or stops being it.
    pub fn set_root(&mut self, root: Option<NodeId>, version: u8) {
        self.root = root;
        self.version = version;
        if root == Some(self.me) {
            self.role = Role::Root;
            self.rank = 0;
            self.parent = None;
        } else if self.role == Role::Root {
            self.role = Role::Orphan;
            self.rank = INFINITE;
        }
    }

    pub fn ad(&self) -> TreeAd {
        TreeAd {
            root: self.root.unwrap_or(0xFFFF),
            version: self.version,
            rank: self.rank,
            role: self.role,
            parent: self.parent.map_or(0xFFFF, |p| p.0),
            children: self.children,
            cap: advertised_cap(self.class),
            uwb: self.uwb,
            parent_uwb: self.parent.is_some_and(|p| p.1 == Radio::Uwb),
            seq: self.seq,
        }
    }

    /// A slot for a newly heard neighbour, or None to ignore it (CTP-style table management).
    /// A free slot is used first. Otherwise the parent, our children and anyone heard in the
    /// last second are kept, and the newcomer displaces the worst remaining entry (highest
    /// advertised rank, then stalest) only if it names us as parent or would be a better
    /// parent than that entry. Admitting every newcomer by evicting the stalest thrashed the
    /// table once more neighbours were audible than it holds (32+ fixtures): the parent and
    /// children were evicted, with their link history, ~30 times a node a minute.
    fn admit(&self, ad: &TreeAd) -> Option<usize> {
        if let Some(i) = self.nbrs.iter().position(|n| n.is_none()) {
            return Some(i);
        }
        let parent = self.parent.map(|p| p.0);
        let root = self.root;
        let me = self.me;
        let (i, worst) = self
            .nbrs
            .iter()
            .enumerate()
            .filter_map(|(i, n)| n.map(|n| (i, n)))
            .filter(|(_, n)| Some(n.id) != parent && n.ad.parent != me && Some(n.id) != root)
            .max_by_key(|(_, n)| (n.ad.rank, core::cmp::Reverse(n.last_us)))?;
        let wants_us = ad.parent == me;
        let better = Some(ad.root) == self.root && ad.rank != INFINITE && ad.rank < worst.ad.rank;
        (wants_us || better).then_some(i)
    }

    pub fn neighbours(&self) -> impl Iterator<Item = &Nbr> {
        self.nbrs.iter().flatten()
    }

    /// An advert from `from` heard on `radio`. `pos` is its position from localization.
    pub fn heard(&mut self, now_us: i64, from: NodeId, radio: Radio, ad: &TreeAd, pos: Option<(i16, i16)>) {
        if from == self.me {
            return;
        }
        // Follow the root a neighbour knows if we have none (or it is a newer version).
        if ad.root != 0xFFFF && self.role != Role::Root && (self.root.is_none() || (Some(ad.root) == self.root && ad.version > self.version)) {
            self.root = Some(ad.root);
            self.version = ad.version;
        }
        let i = match self.nbrs.iter().position(|n| n.is_some_and(|n| n.id == from)) {
            Some(i) => i,
            None => match self.admit(ad) {
                Some(i) => {
                    if self.nbrs[i].is_some() {
                        self.stats.evictions += 1;
                    }
                    self.nbrs[i] = Some(Nbr { id: from, ..Nbr::default() });
                    i
                }
                None => {
                    self.stats.refused += 1;
                    return;
                }
            },
        };
        let my_pos = self.pos;
        let n = self.nbrs[i].as_mut().expect("slot");
        // A neighbour that moved: its link history no longer applies.
        if let (Some(old), Some(new)) = (n.pos, pos) {
            if dist_dm(old, new) > MOVED_DM {
                n.wifi = Link::default();
                n.uwb = Link::default();
            }
        }
        n.pos = pos.or(n.pos);
        n.ad = *ad;
        n.class_cap = ad.cap;
        n.last_us = now_us;
        let link = if radio == Radio::Uwb { &mut n.uwb } else { &mut n.wifi };
        link.heard = link.heard.saturating_add(1);
        if link.windows < 3 {
            if let (Some(a), Some(b)) = (my_pos, n.pos) {
                let p = prior_etx(radio, dist_dm(a, b));
                if p != 0 && link.etx == 0 {
                    link.etx = p;
                }
            }
        }
        if self.parent.is_some_and(|p| p.0 == from) {
            self.parent_heard_us = now_us;
            let bad = ad.rank == INFINITE || ad.role == Role::Orphan || Some(ad.root) != self.root;
            self.parent_bad_since = if bad { Some(self.parent_bad_since.unwrap_or(now_us)) } else { None };
        }
    }

    /// Close a 1 s link window: `expected_*` adverts were due from each neighbour per radio.
    pub fn window(&mut self, expected_wifi: u8, expected_uwb: u8) {
        for n in self.nbrs.iter_mut().flatten() {
            for (link, expected) in [(&mut n.wifi, expected_wifi), (&mut n.uwb, expected_uwb)] {
                if expected == 0 {
                    continue;
                }
                let got = link.heard.min(expected);
                // ETX of this window (cap at 8), then EWMA with weight 1/4.
                let w = if got == 0 { 8 * ONE as u32 } else { (expected as u32 * ONE as u32 / got as u32).min(8 * ONE as u32) };
                let old = if link.etx == 0 { w } else { link.etx as u32 };
                link.etx = ((old * 3 + w) / 4) as u16;
                link.heard = 0;
                link.windows = link.windows.saturating_add(1);
            }
        }
    }

    fn link_cost(&self, n: &Nbr) -> Option<(u32, Radio)> {
        let mut best: Option<(u32, Radio)> = None;
        if self.uwb && n.ad.uwb && n.uwb.usable() {
            best = Some((n.uwb.etx as u32 * W_UWB / 256, Radio::Uwb));
        }
        if n.wifi.usable() {
            let c = n.wifi.etx as u32 * W_WIFI / 256;
            if best.is_none_or(|b| c < b.0) {
                best = Some((c, Radio::Wifi));
            }
        }
        best
    }

    /// The cost of reaching the root through `n`, if it can be our parent.
    fn via(&self, n: &Nbr) -> Option<(u32, Radio)> {
        if Some(n.ad.root) != self.root || n.ad.rank == INFINITE || n.ad.role == Role::Orphan {
            return None;
        }
        // Never our own child (its subtree hangs off us).
        if n.ad.parent == self.me {
            return None;
        }
        let ours = self.parent.is_some_and(|p| p.0 == n.id);
        if !ours && n.ad.children >= n.ad.cap {
            return None;
        }
        // Loop avoidance: only lower-ranked parents (any, when orphaned).
        if self.rank != INFINITE && n.ad.rank >= self.rank && !ours {
            return None;
        }
        let (lc, radio) = self.link_cost(n)?;
        let consolidate = if n.ad.role == Role::Leaf && !ours { NEW_RELAY_COST as u32 } else { 0 };
        Some((n.ad.rank as u32 + lc + consolidate, radio))
    }

    /// Re-evaluate parent and role. Call every advert period. Returns whether anything changed.
    pub fn decide(&mut self, now_us: i64) -> bool {
        // Forget silent neighbours; count our children (neighbours naming us as parent).
        for slot in self.nbrs.iter_mut() {
            if slot.is_some_and(|n| now_us - n.last_us > FORGET_US) {
                *slot = None;
            }
        }
        let me = self.me;
        self.children = self.nbrs.iter().flatten().filter(|n| n.ad.parent == me && n.ad.root == self.root.unwrap_or(0xFFFF)).count() as u8;
        if self.role == Role::Root {
            return false;
        }
        let before = (self.parent, self.role, self.rank);
        // Is the current parent still usable? Silence beyond LOST_US, or no route for longer
        // than HOLD_US, makes it unusable; a moment of either is ridden out.
        let lost = self.parent.is_some_and(|(p, _)| {
            !self.nbrs.iter().flatten().any(|n| n.id == p)
                || now_us - self.parent_heard_us > LOST_US
                || self.parent_bad_since.is_some_and(|t| now_us - t > HOLD_US)
        });
        let old = self.parent.map(|p| p.0);
        if lost {
            // Local repair: our old rank no longer holds, so any non-child may be the parent.
            self.rank = INFINITE;
        }
        let best = self
            .nbrs
            .iter()
            .flatten()
            .filter(|n| !(lost && Some(n.id) == old))
            .filter_map(|n| self.via(n).map(|(c, r)| (c, n.id, r)))
            .min_by_key(|x| (x.0, x.1));
        let current = if lost {
            None
        } else {
            self.parent.and_then(|(p, _)| self.nbrs.iter().flatten().find(|n| n.id == p)).map(|n| {
                // While the parent is briefly without a route, keep it at its last cost.
                self.via(n).map(|(c, r)| (c, n.id, r)).unwrap_or((self.rank as u32, n.id, self.parent.map_or(Radio::Wifi, |p| p.1)))
            })
        };
        if lost {
            self.stats.local_repairs += 1;
            let p = self.parent.map(|p| p.0);
            if !self.nbrs.iter().flatten().any(|n| Some(n.id) == p) {
                self.stats.lost_evicted += 1;
            } else if now_us - self.parent_heard_us > LOST_US {
                self.stats.lost_silent += 1;
            } else {
                self.stats.lost_no_route += 1;
            }
            self.parent_bad_since = None;
        }
        let pick = match (current, best) {
            (Some(c), Some(b)) if b.1 != c.1 && b.0 + SWITCH_GAIN as u32 <= c.0 && now_us - self.switched_us >= DWELL_US => Some(b),
            (Some(c), _) => Some(c),
            (None, b) => b,
        };
        match pick {
            Some((cost, id, radio)) => {
                if self.parent.map(|p| p.0) != Some(id) {
                    self.parent = Some((id, radio));
                    self.switched_us = now_us;
                    self.parent_heard_us = now_us;
                    self.stats.parent_changes += 1;
                } else {
                    self.parent = Some((id, radio));
                }
                let r = cost.min(INFINITE as u32 - 1) as u16;
                if r > self.rank && self.rank != INFINITE {
                    self.stats.rank_raises += 1;
                }
                self.rank = r;
            }
            None => {
                self.parent = None;
                self.rank = INFINITE;
            }
        }
        self.role = match (self.parent, self.children) {
            (None, _) => Role::Orphan,
            (Some(_), 0) => Role::Leaf,
            (Some(_), _) => Role::Relay,
        };
        before != (self.parent, self.role, self.rank)
    }

    /// Forward tree packets on 802.11 (root, relays) or flood (orphans)?
    /// Our children by the radio they reached us on: (802.11, UWB). A relay forwards on each
    /// radio only if it has children there.
    pub fn child_radios(&self) -> (u8, u8) {
        let me = self.me;
        let root = self.root.unwrap_or(0xFFFF);
        self.nbrs.iter().flatten().filter(|n| n.ad.parent == me && n.ad.root == root).fold((0, 0), |(w, u), n| if n.ad.parent_uwb { (w, u + 1) } else { (w + 1, u) })
    }

    pub fn forwards(&self) -> bool {
        matches!(self.role, Role::Root | Role::Relay | Role::Orphan)
    }

    /// A tree packet `seq` arrived: returns the sequences missed just before it (≤ 4) so the
    /// caller can ask its parent for them.
    pub fn got(&mut self, seq: u16) -> core::ops::Range<u16> {
        let gap = seq.wrapping_sub(self.seq);
        let missed = if self.seq != 0 && gap > 1 && gap < 5 { self.seq.wrapping_add(1)..seq } else { seq..seq };
        if gap < 0x8000 {
            self.seq = seq;
        }
        missed
    }
}

/// Members at or above which the root moves the mesh to the tree (Q18), and at or below which
/// it returns to the flood; in between it keeps the current mode. The flood wins in small
/// meshes (path redundancy, airtime trivial); the tree from ~24-32 members (§5.8).
pub const TREE_ENTER: u16 = 24;
pub const TREE_EXIT: u16 = 16;
/// The member count must stay past a threshold this long before the mode changes (a fixture
/// rebooting near the threshold does not flip the mesh).
pub const SELECT_HOLD_US: i64 = 5_000_000;

/// How the root distributes: the managed flood, or the tree.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Dist {
    #[default]
    Flood,
    Tree,
}

/// The root's distribution mode by member count, with hysteresis (Q18). Every data packet
/// carries the mode the root chose for it, so the mesh switches packet by packet: the tree is
/// maintained in both modes (its fields ride on adverts anyway), so a switch is instant.
#[derive(Clone, Copy, Debug, Default)]
pub struct Selector {
    pub mode: Dist,
    since: Option<i64>,
    pub switches: u32,
}

impl Selector {
    pub const fn new() -> Selector {
        Selector { mode: Dist::Flood, since: None, switches: 0 }
    }

    pub fn update(&mut self, now_us: i64, members: u16) -> Dist {
        let want = match self.mode {
            Dist::Flood if members >= TREE_ENTER => Some(Dist::Tree),
            Dist::Tree if members <= TREE_EXIT => Some(Dist::Flood),
            _ => None,
        };
        match want {
            Some(m) => {
                let t = *self.since.get_or_insert(now_us);
                if now_us - t >= SELECT_HOLD_US {
                    self.mode = m;
                    self.since = None;
                    self.switches += 1;
                }
            }
            None => self.since = None,
        }
        self.mode
    }
}

/// Reliable packets a relay keeps for its children's repair requests (§5.8, Q21).
pub const CACHE_ENTRIES: usize = 4;
/// The 802.11 mesh payload (§5.2).
pub const CACHE_BYTES: usize = 200;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CacheStats {
    pub hits: u32,
    pub misses: u32,
}

/// The last `depth` (≤ N) reliable packets by sequence, B bytes each, oldest overwritten.
pub struct RelayCache<const N: usize, const B: usize> {
    seq: [u16; N],
    len: [u16; N],
    buf: [[u8; B]; N],
    next: u8,
    depth: u8,
    pub stats: CacheStats,
}

impl<const N: usize, const B: usize> Default for RelayCache<N, B> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize, const B: usize> RelayCache<N, B> {
    pub const fn new() -> Self {
        RelayCache { seq: [0; N], len: [0; N], buf: [[0; B]; N], next: 0, depth: N as u8, stats: CacheStats { hits: 0, misses: 0 } }
    }

    /// Use only the first `depth` entries (a sizing experiment; firmware keeps N).
    pub fn set_depth(&mut self, depth: usize) {
        self.depth = depth.clamp(1, N) as u8;
        self.next %= self.depth;
        self.len = [0; N];
    }

    /// Keep `bytes` as packet `seq` (0 is not a sequence). False if it does not fit.
    pub fn put(&mut self, seq: u16, bytes: &[u8]) -> bool {
        if seq == 0 || bytes.len() > B {
            return false;
        }
        let i = self.next as usize;
        self.seq[i] = seq;
        self.len[i] = bytes.len() as u16;
        self.buf[i][..bytes.len()].copy_from_slice(bytes);
        self.next = ((i + 1) % self.depth as usize) as u8;
        true
    }

    /// Packet `seq`, if still kept.
    pub fn get(&mut self, seq: u16) -> Option<&[u8]> {
        let i = (0..self.depth as usize).find(|&i| self.len[i] != 0 && self.seq[i] == seq);
        match i {
            Some(i) => {
                self.stats.hits += 1;
                Some(&self.buf[i][..self.len[i] as usize])
            }
            None => {
                self.stats.misses += 1;
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_selector_switches_with_hysteresis_and_hold() {
        let mut s = Selector::new();
        let mut t = 0;
        // 20 members: between the thresholds, stays on the flood.
        for _ in 0..20 {
            t += 1_000_000;
            assert_eq!(s.update(t, 20), Dist::Flood);
        }
        // 24 members: switches once the count has held for SELECT_HOLD_US (5 s).
        let start = t + 1_000_000;
        loop {
            t += 1_000_000;
            if s.update(t, 24) == Dist::Tree {
                break;
            }
        }
        assert_eq!(t - start, SELECT_HOLD_US);
        // A dip to 16 for 3 s does not switch back; 20 (between) never does.
        for m in [16, 16, 16, 20, 20, 20, 20, 20, 20, 20, 20] {
            t += 1_000_000;
            assert_eq!(s.update(t, m), Dist::Tree);
        }
        // 16 held for 5 s does.
        let start = t + 1_000_000;
        loop {
            t += 1_000_000;
            if s.update(t, 16) == Dist::Flood {
                break;
            }
        }
        assert_eq!(t - start, SELECT_HOLD_US);
        assert_eq!(s.switches, 2);
    }

    #[test]
    fn the_relay_cache_keeps_the_last_depth_packets() {
        let mut c: RelayCache<4, 200> = RelayCache::new();
        for q in 1..=6u16 {
            assert!(c.put(q, &[q as u8; 50]));
        }
        assert_eq!(c.get(1), None);
        assert_eq!(c.get(2), None);
        assert_eq!(c.get(3), Some(&[3u8; 50][..]));
        assert_eq!(c.get(6), Some(&[6u8; 50][..]));
        assert!(!c.put(7, &[0; 201]));
        c.set_depth(2);
        for q in 10..=12u16 {
            c.put(q, &[1]);
        }
        assert_eq!(c.get(10), None);
        assert!(c.get(11).is_some() && c.get(12).is_some());
        assert_eq!(c.stats, CacheStats { hits: 4, misses: 3 });
    }

    #[test]
    fn child_radios_split_by_the_childs_parent_link() {
        let mut now = 0;
        let mut t = Tree::new(5, true, Class::P4);
        t.set_root(Some(1), 1);
        let kid = |p_uwb| TreeAd { parent_uwb: p_uwb, ..ad(1, 900, Role::Leaf, 5, 0, true) };
        hear(&mut t, &mut now, 3, &[(1, Radio::Wifi, ad(1, 0, Role::Root, 0xFFFF, 3, true)), (20, Radio::Wifi, kid(true)), (21, Radio::Wifi, kid(false)), (22, Radio::Uwb, kid(true))]);
        assert_eq!(t.child_radios(), (1, 2));
        let a = t.ad();
        let mut b = [0u8; TreeAd::LEN];
        a.encode(&mut b).unwrap();
        assert_eq!(TreeAd::decode(&b), Some(a));
    }

    fn ad(root: NodeId, rank: u16, role: Role, parent: NodeId, children: u8, uwb: bool) -> TreeAd {
        TreeAd { root, version: 1, rank, role, parent, children, cap: 8, uwb, parent_uwb: false, seq: 0 }
    }

    /// Feed `t` adverts from its neighbours for `secs` seconds with perfect links.
    fn hear(t: &mut Tree, now: &mut i64, secs: usize, from: &[(NodeId, Radio, TreeAd)]) {
        for _ in 0..secs {
            *now += 1_000_000;
            for (id, radio, a) in from {
                t.heard(*now, *id, *radio, a, None);
            }
            t.window(1, if t.uwb { 1 } else { 0 });
            t.decide(*now);
        }
    }

    #[test]
    fn prefers_uwb_from_the_root_and_existing_relays() {
        let mut now = 0;
        // Node 5 hears the root (1) on UWB and wifi, and relay 2 on wifi.
        let mut t = Tree::new(5, true, Class::C6);
        t.set_root(Some(1), 1);
        hear(&mut t, &mut now, 4, &[(1, Radio::Uwb, ad(1, 0, Role::Root, 0xFFFF, 3, true)), (1, Radio::Wifi, ad(1, 0, Role::Root, 0xFFFF, 3, true))]);
        assert_eq!(t.parent, Some((1, Radio::Uwb)));
        assert_eq!(t.role, Role::Leaf);
        assert_eq!(t.rank, 128, "one UWB hop at ETX 1, weight 0.5");
        // A wifi-only node 6 near 5 and near a leaf 7: it joins 5 once 5 has a child (cheaper
        // than making 7 a new relay).
        let mut u = Tree::new(6, false, Class::C6);
        u.set_root(Some(1), 1);
        hear(&mut u, &mut now, 4, &[(5, Radio::Wifi, ad(1, 128, Role::Relay, 1, 2, true)), (7, Radio::Wifi, ad(1, 128, Role::Leaf, 1, 0, true))]);
        assert_eq!(u.parent.map(|p| p.0), Some(5));
        assert_eq!(u.rank, 128 + 256);
    }

    #[test]
    fn hysteresis_and_dwell_keep_it_stable() {
        let mut now = 0;
        let mut t = Tree::new(9, false, Class::C6);
        t.set_root(Some(1), 1);
        let a = ad(1, 256, Role::Relay, 1, 2, false);
        let b = ad(1, 256 + 64, Role::Relay, 1, 2, false);
        hear(&mut t, &mut now, 4, &[(2, Radio::Wifi, a), (3, Radio::Wifi, b)]);
        assert_eq!(t.parent.map(|p| p.0), Some(2));
        // 3 becomes slightly better (by less than SWITCH_GAIN): no switch.
        let b2 = ad(1, 256 - 64, Role::Relay, 1, 2, false);
        hear(&mut t, &mut now, 10, &[(2, Radio::Wifi, a), (3, Radio::Wifi, b2)]);
        assert_eq!(t.parent.map(|p| p.0), Some(2), "no flapping on a small gain");
        // Much better: switch (after the dwell).
        let b3 = ad(1, 0, Role::Root, 0xFFFF, 2, false);
        hear(&mut t, &mut now, 10, &[(2, Radio::Wifi, a), (3, Radio::Wifi, ad(1, 0, Role::Relay, 1, 2, false))]);
        let _ = b3;
        assert_eq!(t.parent.map(|p| p.0), Some(3));
        assert_eq!(t.stats.parent_changes, 2);
    }

    #[test]
    fn a_lost_parent_is_replaced_and_loops_are_avoided() {
        let mut now = 0;
        let mut t = Tree::new(9, false, Class::C6);
        t.set_root(Some(1), 1);
        hear(&mut t, &mut now, 4, &[(2, Radio::Wifi, ad(1, 256, Role::Relay, 1, 2, false)), (3, Radio::Wifi, ad(1, 512, Role::Relay, 1, 2, false))]);
        assert_eq!(t.parent.map(|p| p.0), Some(2));
        // 2 dies at t=4 s; only 3 is heard. The silent link's ETX goes 256 -> 704 -> 1040, so
        // the cost via 2 is 960 at t=5 (dwell still blocks: switched at t=1) and 1296 at t=6,
        // when 3 (768) wins by more than SWITCH_GAIN: the ETX path moves it 2 s after the
        // death, before LOST_US (which would only fire at t=8).
        hear(&mut t, &mut now, 1, &[(3, Radio::Wifi, ad(1, 512, Role::Relay, 1, 2, false))]);
        assert_eq!(t.parent.map(|p| p.0), Some(2));
        hear(&mut t, &mut now, 1, &[(3, Radio::Wifi, ad(1, 512, Role::Relay, 1, 2, false))]);
        assert_eq!(t.parent.map(|p| p.0), Some(3));
        assert_eq!(t.stats.parent_changes, 2);
        assert_eq!(t.stats.local_repairs, 0);
        // A neighbour that is our own child (higher rank) is never chosen as parent.
        let mut c = Tree::new(9, false, Class::C6);
        c.set_root(Some(1), 1);
        hear(&mut c, &mut now, 4, &[(2, Radio::Wifi, ad(1, 256, Role::Relay, 1, 2, false)), (4, Radio::Wifi, ad(1, 900, Role::Leaf, 9, 0, false))]);
        assert_eq!(c.parent.map(|p| p.0), Some(2));
        assert_eq!(c.children, 1);
        assert_eq!(c.role, Role::Relay);
    }

    /// The local-repair path: the parent is still heard but has lost its route (advertises
    /// INFINITE). Its last cost is kept for HOLD_US, so the rank does not rise and the
    /// equal-rank neighbour 3 stays ineligible (loop avoidance); after HOLD_US the parent is
    /// dropped, the rank reset, and 3 taken. Before the reset, 3 was never eligible and the node
    /// stayed on a parent without a route indefinitely.
    #[test]
    fn a_parent_without_a_route_is_held_then_repaired() {
        let mut now = 0;
        let mut t = Tree::new(9, false, Class::C6);
        t.set_root(Some(1), 1);
        let good2 = ad(1, 256, Role::Relay, 1, 2, false);
        let n3 = ad(1, 512, Role::Relay, 1, 2, false);
        hear(&mut t, &mut now, 6, &[(2, Radio::Wifi, good2), (3, Radio::Wifi, n3)]);
        assert_eq!((t.parent.map(|p| p.0), t.rank), (Some(2), 512));
        let lost2 = TreeAd { rank: INFINITE, ..good2 };
        // Bad since t=7; held while now - 7 s <= HOLD_US (t = 7, 8, 9).
        hear(&mut t, &mut now, 3, &[(2, Radio::Wifi, lost2), (3, Radio::Wifi, n3)]);
        assert_eq!((t.parent.map(|p| p.0), t.rank, t.stats.local_repairs), (Some(2), 512, 0));
        hear(&mut t, &mut now, 1, &[(2, Radio::Wifi, lost2), (3, Radio::Wifi, n3)]);
        assert_eq!(t.parent.map(|p| p.0), Some(3));
        assert_eq!(t.stats.local_repairs, 1);
        assert_eq!(t.rank, 768);
    }

    /// More audible neighbours than slots: the parent, children and the best candidates stay;
    /// worse newcomers are refused instead of evicting them.
    #[test]
    fn a_crowded_table_keeps_parent_children_and_best_candidates() {
        let mut now = 0;
        let mut t = Tree::new(9, false, Class::C6);
        t.set_root(Some(1), 1);
        let mut heard: Vec<(NodeId, Radio, TreeAd)> = vec![(2, Radio::Wifi, ad(1, 256, Role::Relay, 1, 2, false))];
        // Three children (they name 9 as parent).
        for c in 30..33 {
            heard.push((c, Radio::Wifi, ad(1, 1000, Role::Leaf, 9, 0, false)));
        }
        // Forty other leaves at rank 900..939, more than the table holds.
        for k in 0..40u16 {
            heard.push((100 + k, Radio::Wifi, ad(1, 900 + k, Role::Leaf, 2, 0, false)));
        }
        hear(&mut t, &mut now, 30, &heard);
        assert_eq!(t.parent.map(|p| p.0), Some(2));
        assert_eq!(t.children, 3);
        assert_eq!(t.stats.parent_changes, 1);
        assert_eq!(t.stats.local_repairs, 0);
        // The table fills with 2, the children and leaves 100..111 (rank 900..911); every later
        // leaf ranks worse than the worst kept one, so it is refused: no eviction at all.
        assert_eq!(t.stats.evictions, 0);
        assert_eq!(t.stats.refused, 28 * 30);
        let ids: Vec<NodeId> = t.neighbours().map(|n| n.id).collect();
        assert!(ids.contains(&2) && (30..33).all(|c| ids.contains(&c)));
        // The kept leaves are the best ranked of those heard.
        assert!(t.neighbours().filter(|n| n.id >= 100).all(|n| n.ad.rank < 900 + 12), "{ids:?}");
    }

    #[test]
    fn full_parents_are_skipped_and_gaps_are_reported() {
        let mut now = 0;
        let mut t = Tree::new(9, false, Class::C6);
        t.set_root(Some(1), 1);
        let full = TreeAd { cap: 2, children: 2, ..ad(1, 256, Role::Relay, 1, 2, false) };
        hear(&mut t, &mut now, 4, &[(2, Radio::Wifi, full), (3, Radio::Wifi, ad(1, 600, Role::Relay, 1, 1, false))]);
        assert_eq!(t.parent.map(|p| p.0), Some(3));
        assert_eq!(t.got(10), 10..10);
        assert_eq!(t.got(13), 11..13);
        assert_eq!(t.got(14), 14..14);
    }

    #[test]
    fn advert_roundtrip() {
        let a = TreeAd { root: 7, version: 3, rank: 300, role: Role::Relay, parent: 9, children: 4, cap: 16, uwb: true, parent_uwb: true, seq: 1234 };
        let mut b = [0u8; 16];
        let n = a.encode(&mut b).unwrap();
        assert_eq!(n, TreeAd::LEN);
        assert_eq!(TreeAd::decode(&b[..n]), Some(a));
    }

    #[test]
    fn positions_bootstrap_and_movement_resets() {
        let mut t = Tree::new(9, true, Class::C6);
        t.pos = Some((0, 0));
        t.set_root(Some(1), 1);
        t.heard(0, 1, Radio::Uwb, &ad(1, 0, Role::Root, 0xFFFF, 0, true), Some((100, 0)));
        let n = *t.neighbours().next().unwrap();
        assert_eq!(n.uwb.etx, ONE + ONE / 8, "10 m: a good UWB prior");
        t.decide(0);
        assert_eq!(t.parent, Some((1, Radio::Uwb)));
        // It moves 5 m: history reset, a new prior from the new distance.
        t.heard(1, 1, Radio::Uwb, &ad(1, 0, Role::Root, 0xFFFF, 0, true), Some((250, 0)));
        assert_eq!(t.neighbours().next().unwrap().uwb.etx, 2 * ONE);
    }
}
