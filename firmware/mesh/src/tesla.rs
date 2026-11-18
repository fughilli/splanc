//! Broadcast authentication for live updates in large meshes (design §7.9, Q19): TESLA with
//! delayed key disclosure, bootstrapped by challenge-response, not by mesh time.
//!
//! Per-receiver MACs (§7.9, [`crate::admin`]) cost 8 bytes per member, so past ~20 members a
//! live update takes several packets, and at 64-128 members and 30 Hz the bytes alone saturate
//! the air (§5.8). TESLA authenticates a broadcast with one constant-size tag whatever the
//! member count, and keeps insider resistance:
//!
//! - The gateway draws a one-way **key chain** `K_N → … → K_1 → K_0` (`K_i = F(K_{i+1})`) and
//!   splits its own clock into intervals of [`INTERVAL_US`]. Packets sent in interval `i` carry
//!   an 8-byte tag under a key derived from `K_i`, which only the gateway knows until it
//!   **discloses** `K_i` in packets from interval `i + d` on ([`DISCLOSE`] intervals later).
//! - A member accepts a packet only if, by its own clock, the gateway cannot yet have
//!   disclosed that interval's key (the **security condition**). It buffers the packet, and
//!   when the key arrives (any later packet carries the newest disclosable key) checks that
//!   the key hashes back to one it already trusts, then checks the tag.
//! - A member (an insider: it holds the mesh key and its own pairwise key) learns `K_i` only
//!   when every member's window for interval `i` has closed, so it can never forge a live
//!   update another member would accept. Only the gateway, which holds the chain, can.
//!
//! **Time without trusting time.** The security condition needs an upper bound on the
//! gateway's clock. It does not come from mesh time (§6.2) or from any peer: each member gets
//! it by challenge-response with the gateway, [`TeslaMsg::Req`] (a fresh nonce, the local time
//! `t0` it was sent) answered by [`TeslaMsg::Sync`] (the chain's commitment `K_0`, the gateway's
//! interval and offset at reply time, bound to the nonce by a MAC under the pairwise key of
//! the admin session, §7.9). The gateway's clock at any later local time `t` is then at most
//! `gateway_at_reply + (t - t0)·(1 + ρ)`. Delay anywhere on the path (an attacker holding the
//! Sync back) only makes this bound more conservative: more packets fail the condition and are
//! dropped, none is wrongly accepted. Replays are rejected by the per-chain sequence floor
//! (the gateway's 64-bit counter) and by the condition itself (an old interval's key is out).
//!
//! **Cost.** 30 bytes per packet (chain, interval, tag, disclosed interval and key), against
//! 8 per member; one HMAC to seal, one to verify, plus one hash per interval to follow the
//! chain. The price is latency: a packet is usable only once its key is disclosed, `d`
//! intervals later (Q19 sizes `d` and the interval; per-receiver MACs stay below the tree's
//! member threshold, where they cost no delay and few bytes).
//!
//! **Chain storage.** [`CHAIN_LEN`] intervals (21.8 min at 20 ms). The gateway keeps two
//! levels of checkpoints (16 every 4096 keys, 64 every 64 inside the current 4096-key block,
//! 1.3 KB) and hashes down at most 63 steps per key. Building a chain costs `CHAIN_LEN` hashes
//! once ([`Signer::new`], a background job: §7.9's crypto task), and a new block's level-2
//! checkpoints 4096 hashes every 82 s.

use crate::backhaul::NodeId;
use crate::codec::{R, W};
use crate::crypto::{ct_eq, hmac};
use swarm_net::crypto::sha256;

pub const KEY_LEN: usize = 16;
pub const TAG_LEN: usize = 8;
/// chain (2) ‖ interval (2) ‖ tag (8) ‖ disclosed interval (2) ‖ disclosed key (16).
pub const AUTH_LEN: usize = 2 + 2 + TAG_LEN + 2 + KEY_LEN;
/// Interval length and disclosure delay (`d`): a packet waits `d` to `d + 1` intervals for
/// its key. Sized by the §5.8 sweep (Q19): see the design doc for the trade-off.
pub const INTERVAL_US: u32 = 20_000;
pub const DISCLOSE: u8 = 3;
/// Keys per chain: interval indices 1..=CHAIN_LEN (index 0 is the commitment).
pub const CHAIN_LEN: u32 = 65_535;
const L1: u32 = 4096;
const L1_N: usize = 16;
const L2: u32 = 64;
const L2_N: usize = 64;
/// Recent keys the gateway keeps (≥ d + 1).
const MEMO: usize = 8;
/// Clock rate error assumed between a member and the gateway (two ±50 ppm crystals plus
/// margin), applied to the bound.
pub const DRIFT_PPM: i64 = 200;
/// The furthest a verifier hashes forward to check a disclosed key (82 s of missed
/// intervals); a member further behind re-syncs.
pub const MAX_STEP: u32 = 4096;
/// Packets a member holds waiting for their keys (d + 1 intervals of live updates).
pub const PENDING: usize = 6;
/// The largest body authenticated this way (`ControlHeader` + compact uniforms).
pub const BODY_MAX: usize = 64;
/// A member re-asks for the chain this often while it has none.
pub const REQ_RETRY_US: i64 = 1_000_000;

/// Challenges a member makes per chain, ~1 s apart, keeping the tightest bound (Q24).
pub const TRIES: u8 = 3;
/// The one-way delivery latency `d` must also cover (p99 at 64-128 fixtures, §5.8).
pub const LATENCY_MARGIN_US: u32 = 20_000;
pub const D_MIN: u8 = 2;
pub const D_MAX: u8 = 10;

/// The disclosure delay that covers a member whose best round trip is `rtt_us` (Q24): the
/// key of interval i must not be out before a packet from i reaches it, judged by its bound.
pub const fn needed_d(rtt_us: u32, interval_us: u32) -> u8 {
    let d = (rtt_us + LATENCY_MARGIN_US).div_ceil(interval_us) + 1;
    if d < D_MIN as u32 {
        D_MIN
    } else if d > D_MAX as u32 {
        D_MAX
    } else {
        d as u8
    }
}

pub const T_TESLA_REQ: u8 = 0x44;
pub const T_TESLA_SYNC: u8 = 0x45;

/// The chain step F and the MAC-key derivation F' (SHA-256, truncated; domain separated).
pub fn step(k: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    let mut m = [0u8; 4 + KEY_LEN];
    m[..4].copy_from_slice(b"SMtF");
    m[4..].copy_from_slice(k);
    let h = sha256(&m);
    let mut o = [0u8; KEY_LEN];
    o.copy_from_slice(&h[..KEY_LEN]);
    o
}

fn steps(mut k: [u8; KEY_LEN], n: u32) -> [u8; KEY_LEN] {
    for _ in 0..n {
        k = step(&k);
    }
    k
}

fn mac_key(k: &[u8; KEY_LEN]) -> [u8; KEY_LEN] {
    let mut m = [0u8; 4 + KEY_LEN];
    m[..4].copy_from_slice(b"SMtM");
    m[4..].copy_from_slice(k);
    let h = sha256(&m);
    let mut o = [0u8; KEY_LEN];
    o.copy_from_slice(&h[..KEY_LEN]);
    o
}

/// What a tag covers: the mesh, the session, the chain and interval, the gateway's sequence,
/// the port and the body.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Context {
    pub mesh_id: u32,
    pub session: u32,
}

#[allow(clippy::too_many_arguments)]
pub fn tag(k: &[u8; KEY_LEN], c: Context, chain: u16, interval: u16, seq: u64, port: u8, body: &[u8]) -> [u8; TAG_LEN] {
    let h = hmac(&mac_key(k), &[b"SMtl1", &c.mesh_id.to_be_bytes(), &c.session.to_be_bytes(), &chain.to_be_bytes(), &interval.to_be_bytes(), &seq.to_be_bytes(), &[port], body]);
    let mut t = [0u8; TAG_LEN];
    t.copy_from_slice(&h[..TAG_LEN]);
    t
}

/// The authentication trailer of one packet.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Auth {
    pub chain: u16,
    pub interval: u16,
    pub tag: [u8; TAG_LEN],
    pub disclosed: u16,
    pub key: [u8; KEY_LEN],
}

impl Auth {
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        W::new(out).u16(self.chain).u16(self.interval).put(&self.tag).u16(self.disclosed).put(&self.key).done()
    }

    pub fn decode(b: &[u8]) -> Option<Auth> {
        let mut r = R::new(b);
        let a = Auth { chain: r.u16()?, interval: r.u16()?, tag: r.arr()?, disclosed: r.u16()?, key: r.arr()? };
        r.end()?;
        Some(a)
    }
}

/// The gateway's chain.
pub struct Signer {
    pub chain: u16,
    /// Gateway-local time interval 1 starts.
    start_us: i64,
    interval_us: u32,
    d: u8,
    commit: [u8; KEY_LEN],
    /// l1[b] = K_{min((b + 1)·L1, N)}.
    l1: [[u8; KEY_LEN]; L1_N],
    /// l2[j] = K_{min(block·L1 + (j + 1)·L2, top of block)} for the block in `l2_block`.
    l2: [[u8; KEY_LEN]; L2_N],
    l2_block: u32,
    /// The last keys computed: the key disclosed now was the current key `d` intervals ago,
    /// so it costs nothing; only the current interval's key is walked (≤ 63 hashes).
    memo: [(u32, [u8; KEY_LEN]); MEMO],
    memo_next: u8,
    pub hashes: u64,
}

impl Signer {
    /// A chain from `seed` (16 random bytes), starting at gateway time `start_us`. Costs
    /// CHAIN_LEN hashes: run it in the crypto task ahead of need.
    pub fn new(seed: &[u8; KEY_LEN], chain: u16, start_us: i64, interval_us: u32, d: u8) -> Signer {
        let mut l1 = [[0u8; KEY_LEN]; L1_N];
        let mut k = step(seed); // K_N
        let mut idx = CHAIN_LEN;
        let mut hashes = 1u64;
        // Walk down from K_N, recording the checkpoints.
        for b in (0..L1_N).rev() {
            let at = ((b as u32 + 1) * L1).min(CHAIN_LEN);
            k = steps(k, idx - at);
            hashes += (idx - at) as u64;
            idx = at;
            l1[b] = k;
        }
        let commit = steps(k, idx);
        hashes += idx as u64;
        Signer { chain, start_us, interval_us, d, commit, l1, l2: [[0; KEY_LEN]; L2_N], l2_block: u32::MAX, memo: [(u32::MAX, [0; KEY_LEN]); MEMO], memo_next: 0, hashes }
    }

    pub fn commitment(&self) -> [u8; KEY_LEN] {
        self.commit
    }

    pub fn interval_us(&self) -> u32 {
        self.interval_us
    }

    pub fn disclose_delay(&self) -> u8 {
        self.d
    }

    /// The interval at gateway time `now_us` (1-based; 0 before the start) and the µs into it.
    pub fn interval_at(&self, now_us: i64) -> (u32, u32) {
        if now_us < self.start_us {
            return (0, 0);
        }
        let e = (now_us - self.start_us) as u64;
        ((e / self.interval_us as u64) as u32 + 1, (e % self.interval_us as u64) as u32)
    }

    /// Is the chain about to run out (the caller starts the next one)?
    pub fn ending(&self, now_us: i64) -> bool {
        self.interval_at(now_us).0 + 3000 > CHAIN_LEN
    }

    /// K_i (1 ≤ i ≤ N).
    pub fn key(&mut self, i: u32) -> [u8; KEY_LEN] {
        if i == 0 {
            return self.commit;
        }
        if let Some(m) = self.memo.iter().find(|m| m.0 == i) {
            return m.1;
        }
        let k = self.walk(i);
        self.memo[self.memo_next as usize] = (i, k);
        self.memo_next = ((self.memo_next as usize + 1) % MEMO) as u8;
        k
    }

    fn walk(&mut self, i: u32) -> [u8; KEY_LEN] {
        let b = ((i - 1) / L1).min(L1_N as u32 - 1);
        let top = ((b + 1) * L1).min(CHAIN_LEN);
        if self.l2_block != b {
            // Level-2 checkpoints for this block, from its top.
            let base = b * L1;
            let mut k = self.l1[b as usize];
            let mut idx = top;
            for j in (0..L2_N).rev() {
                let at = (base + (j as u32 + 1) * L2).min(top);
                k = steps(k, idx - at);
                self.hashes += (idx - at) as u64;
                idx = at;
                self.l2[j] = k;
            }
            self.l2_block = b;
        }
        let base = b * L1;
        let j = ((i - base - 1) / L2) as usize;
        let at = (base + (j as u32 + 1) * L2).min(top);
        self.hashes += (at - i) as u64;
        steps(self.l2[j], at - i)
    }

    /// Seal `body` (port, gateway sequence) at gateway time `now_us`.
    pub fn seal(&mut self, now_us: i64, c: Context, seq: u64, port: u8, body: &[u8]) -> Option<Auth> {
        let (i, _) = self.interval_at(now_us);
        if i == 0 || i > CHAIN_LEN {
            return None;
        }
        let k = self.key(i);
        let disclosed = i.saturating_sub(self.d as u32);
        let key = self.key(disclosed);
        Some(Auth { chain: self.chain, interval: i as u16, tag: tag(&k, c, self.chain, i as u16, seq, port, body), disclosed: disclosed as u16, key })
    }

    /// The Sync answering a member's Req, at gateway time `now_us`.
    pub fn sync(&self, now_us: i64, session: u32, node: NodeId, nonce: u64, pairwise: &[u8; 16]) -> TeslaMsg {
        let (gw_interval, gw_into_us) = self.interval_at(now_us);
        let s = SyncBody { session, node, nonce, chain: self.chain, commit: self.commit, interval_us: self.interval_us, d: self.d, gw_interval, gw_into_us };
        TeslaMsg::Sync(s, s.mac(pairwise))
    }
}

/// The gateway's answer to a member's challenge: the chain and where its clock is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncBody {
    pub session: u32,
    pub node: NodeId,
    pub nonce: u64,
    pub chain: u16,
    pub commit: [u8; KEY_LEN],
    pub interval_us: u32,
    pub d: u8,
    pub gw_interval: u32,
    pub gw_into_us: u32,
}

impl SyncBody {
    fn write(&self, w: &mut W<'_>) {
        w.u32(self.session).u16(self.node).put(&self.nonce.to_be_bytes()).u16(self.chain).put(&self.commit).u32(self.interval_us).u8(self.d).u32(self.gw_interval).u32(self.gw_into_us);
    }

    pub fn mac(&self, pairwise: &[u8; 16]) -> [u8; 8] {
        let mut b = [0u8; 48];
        let n = {
            let mut w = W::new(&mut b);
            self.write(&mut w);
            w.done().unwrap_or(0)
        };
        let h = hmac(pairwise, &[b"SMtsync1", &b[..n]]);
        let mut m = [0u8; 8];
        m.copy_from_slice(&h[..8]);
        m
    }
}

pub fn req_mac(pairwise: &[u8; 16], session: u32, node: NodeId, nonce: u64, rtt_us: u32) -> [u8; 8] {
    let h = hmac(pairwise, &[b"SMtreq2", &session.to_be_bytes(), &node.to_be_bytes(), &nonce.to_be_bytes(), &rtt_us.to_be_bytes()]);
    let mut m = [0u8; 8];
    m.copy_from_slice(&h[..8]);
    m
}

/// Freshness-port messages (beside [`crate::admin::SessionMsg`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TeslaMsg {
    /// Member → gateway: send me the chain, bound to this nonce.
    /// `rtt_us`: the member's best round trip so far (0: none), for the gateway's `d` (Q24).
    Req { session: u32, node: NodeId, nonce: u64, rtt_us: u32, mac: [u8; 8] },
    /// Gateway → member.
    Sync(SyncBody, [u8; 8]),
}

impl TeslaMsg {
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut w = W::new(out);
        match self {
            TeslaMsg::Req { session, node, nonce, rtt_us, mac } => {
                w.u8(T_TESLA_REQ).u32(*session).u16(*node).put(&nonce.to_be_bytes()).u32(*rtt_us).put(mac);
            }
            TeslaMsg::Sync(s, mac) => {
                w.u8(T_TESLA_SYNC);
                s.write(&mut w);
                w.put(mac);
            }
        }
        w.done()
    }

    pub fn decode(b: &[u8]) -> Option<TeslaMsg> {
        let mut r = R::new(b);
        let m = match r.u8()? {
            T_TESLA_REQ => TeslaMsg::Req { session: r.u32()?, node: r.u16()?, nonce: u64::from_be_bytes(r.arr()?), rtt_us: r.u32()?, mac: r.arr()? },
            T_TESLA_SYNC => {
                let s = SyncBody {
                    session: r.u32()?,
                    node: r.u16()?,
                    nonce: u64::from_be_bytes(r.arr()?),
                    chain: r.u16()?,
                    commit: r.arr()?,
                    interval_us: r.u32()?,
                    d: r.u8()?,
                    gw_interval: r.u32()?,
                    gw_into_us: r.u32()?,
                };
                TeslaMsg::Sync(s, r.arr()?)
            }
            _ => return None,
        };
        r.end()?;
        Some(m)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VerifyStats {
    pub accepted: u32,
    /// Arrived after its key could have been disclosed (late, or a replay).
    pub unsafe_late: u32,
    /// Claims an interval the gateway cannot have reached yet (only a forger sends these).
    pub future: u32,
    pub bad_tag: u32,
    /// A disclosed key that does not hash back to the trusted one.
    pub bad_key: u32,
    pub stale_seq: u32,
    /// Dropped from a full buffer.
    pub overflow: u32,
    pub wrong_chain: u32,
    /// Applied on arrival (apply-then-verify), and of those, rolled back when the tag failed.
    pub provisional: u32,
    pub rolled_back: u32,
    pub expired: u32,
    pub hashes: u64,
}

/// After a provisional update fails verification, the member verifies before applying for
/// this long: an insider gets at most one bounded glitch per cooldown (§7.9, Q22).
pub const COOLDOWN_US: i64 = 10_000_000;

#[derive(Clone, Copy)]
struct Pending {
    interval: u16,
    seq: u64,
    port: u8,
    tag: [u8; TAG_LEN],
    len: u8,
    body: [u8; BODY_MAX],
    applied: bool,
}

/// What a verifier tells its owner.
#[derive(Debug, PartialEq, Eq)]
pub enum Out<'a> {
    /// Render this update. `provisional`: applied on arrival, before its key is out
    /// (apply-then-verify); it may still be rejected.
    Apply { seq: u64, port: u8, body: &'a [u8], provisional: bool },
    /// A buffered update failed verification: it was forged. `shown`: it had been applied
    /// provisionally (return to the last verified state). Its interval and tag identify it
    /// in a forgery report (§7.9, Q25).
    Rejected { seq: u64, port: u8, body: &'a [u8], shown: bool, interval: u16, tag: [u8; TAG_LEN], key: [u8; KEY_LEN] },
    /// A provisional update whose key never came (no later packet reached this member in
    /// time): return to the last verified state. Not evidence of forgery.
    Expired { seq: u64, port: u8, body: &'a [u8] },
}

/// A member's view of the gateway's current chain.
pub struct Verifier {
    pub ctx: Context,
    pub chain: u16,
    interval_us: u32,
    d: u8,
    known_idx: u32,
    known: [u8; KEY_LEN],
    /// Local time the Req went out, and the gateway's chain time (µs since interval 1
    /// started) when it answered.
    t0_us: i64,
    gw_at_reply_us: i64,
    pending: [Option<Pending>; PENDING],
    /// Newest verified sequence, and newest verified sequence rendered.
    last_seq: u64,
    shown_seq: u64,
    /// Interval of the newest provisional update rendered. Provisional updates are ordered
    /// by interval, not by sequence: a forger picks any sequence, but only an interval
    /// inside the safe window, so a genuine update from a later interval overwrites it.
    prov_interval: u16,
    /// Apply-then-verify (Q22): render a safe update on arrival, verify when its key comes.
    pub early: bool,
    cool_until_us: i64,
    pub stats: VerifyStats,
}

/// A member's outstanding challenge.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Challenge {
    pub session: u32,
    pub nonce: u64,
    pub t0_us: i64,
}

impl Verifier {
    /// Accept a Sync for our challenge (MAC under the session's pairwise key).
    pub fn from_sync(ch: &Challenge, s: &SyncBody, mac: &[u8; 8], pairwise: &[u8; 16], me: NodeId, mesh_id: u32) -> Option<Verifier> {
        if s.session != ch.session || s.nonce != ch.nonce || s.node != me || !ct_eq(&s.mac(pairwise), mac) || s.interval_us == 0 || s.d == 0 {
            return None;
        }
        let gw_at_reply_us = s.gw_interval.saturating_sub(1) as i64 * s.interval_us as i64 + s.gw_into_us as i64;
        Some(Verifier {
            ctx: Context { mesh_id, session: s.session },
            chain: s.chain,
            interval_us: s.interval_us,
            d: s.d,
            known_idx: 0,
            known: s.commit,
            t0_us: ch.t0_us,
            gw_at_reply_us,
            pending: [None; PENDING],
            last_seq: 0,
            shown_seq: 0,
            prov_interval: 0,
            early: false,
            cool_until_us: i64::MIN,
            stats: VerifyStats::default(),
        })
    }

    pub fn disclose_delay(&self) -> u8 {
        self.d
    }

    /// A later Sync for the same chain (best-of-N, Q24): keep whichever bound is tighter.
    /// Returns whether it was.
    pub fn rebound(&mut self, now_us: i64, other: &Verifier) -> bool {
        if other.chain != self.chain || other.ctx != self.ctx {
            return false;
        }
        if other.upper_interval(now_us) < self.upper_interval(now_us) || (other.upper_us(now_us) < self.upper_us(now_us)) {
            self.t0_us = other.t0_us;
            self.gw_at_reply_us = other.gw_at_reply_us;
            return true;
        }
        false
    }

    /// The latest chain time (µs) the gateway can have reached at local time `now_us`.
    fn upper_us(&self, now_us: i64) -> i64 {
        let e = (now_us - self.t0_us).max(0);
        self.gw_at_reply_us + e + e * DRIFT_PPM / 1_000_000
    }

    /// The latest interval the gateway can be in at local time `now_us`.
    pub fn upper_interval(&self, now_us: i64) -> u32 {
        (self.upper_us(now_us) / self.interval_us as i64) as u32 + 1
    }

    /// Would a packet from `interval` still be safe at local time `now_us`?
    pub fn safe(&self, interval: u32, now_us: i64) -> bool {
        interval > self.known_idx && self.upper_interval(now_us) < interval + self.d as u32
    }

    /// Is the member verifying before applying (cooling down after a rejected provisional
    /// update, or apply-then-verify off)?
    pub fn verify_first(&self, now_us: i64) -> bool {
        !self.early || now_us < self.cool_until_us
    }

    /// A disclosed key: accept it if it hashes back to the trusted one.
    fn on_key(&mut self, idx: u32, key: &[u8; KEY_LEN]) {
        if idx <= self.known_idx {
            return;
        }
        let n = idx - self.known_idx;
        if n > MAX_STEP {
            self.stats.bad_key += 1;
            return;
        }
        self.stats.hashes += n as u64;
        if ct_eq(&steps(*key, n), &self.known) {
            self.known_idx = idx;
            self.known = *key;
        } else {
            self.stats.bad_key += 1;
        }
    }

    /// A packet: buffer it if safe (and, with apply-then-verify, apply it at once), take its
    /// disclosed key, then settle every buffered packet whose key is now known: apply the
    /// verified ones not yet applied, reject the provisional ones whose tag fails.
    #[allow(clippy::too_many_arguments)]
    pub fn on_packet(&mut self, now_us: i64, seq: u64, port: u8, a: &Auth, body: &[u8], out: &mut dyn FnMut(Out<'_>)) {
        if a.chain != self.chain {
            self.stats.wrong_chain += 1;
            return;
        }
        // The condition is checked on arrival, before the key it carries is taken.
        if body.len() <= BODY_MAX {
            if a.interval as u32 > self.upper_interval(now_us) {
                // A genuine packet is never from an interval the gateway cannot have reached;
                // a forger would pick one to keep its glitch on screen longer.
                self.stats.future += 1;
            } else if !self.safe(a.interval as u32, now_us) {
                self.stats.unsafe_late += 1;
            } else if seq <= self.last_seq || self.pending.iter().flatten().any(|p| p.seq == seq) {
                self.stats.stale_seq += 1;
            } else {
                let slot = match self.pending.iter().position(|p| p.is_none()) {
                    Some(i) => i,
                    None => {
                        self.stats.overflow += 1;
                        (0..PENDING).min_by_key(|&i| self.pending[i].map_or(0, |p| p.seq)).unwrap_or(0)
                    }
                };
                let mut b = [0u8; BODY_MAX];
                b[..body.len()].copy_from_slice(body);
                let apply = !self.verify_first(now_us) && a.interval >= self.prov_interval;
                self.pending[slot] = Some(Pending { interval: a.interval, seq, port, tag: a.tag, len: body.len() as u8, body: b, applied: apply });
                if apply {
                    self.prov_interval = a.interval;
                    self.stats.provisional += 1;
                    out(Out::Apply { seq, port, body, provisional: true });
                }
            }
        }
        self.on_key(a.disclosed as u32, &a.key);
        self.release(now_us, out);
    }

    fn release(&mut self, now_us: i64, out: &mut dyn FnMut(Out<'_>)) {
        loop {
            let next = (0..PENDING).filter(|&i| self.pending[i].is_some_and(|p| (p.interval as u32) <= self.known_idx)).min_by_key(|&i| self.pending[i].map_or(u64::MAX, |p| p.seq));
            let Some(i) = next else { break };
            let p = self.pending[i].take().expect("pending");
            let n = self.known_idx - p.interval as u32;
            self.stats.hashes += n as u64 + 1;
            let k = steps(self.known, n);
            let body = &p.body[..p.len as usize];
            if !ct_eq(&tag(&k, self.ctx, self.chain, p.interval, p.seq, p.port, body), &p.tag) {
                self.stats.bad_tag += 1;
                if p.applied {
                    // A forgery was on screen: undo it, and verify first for a while.
                    self.stats.rolled_back += 1;
                    self.cool_until_us = now_us + COOLDOWN_US;
                }
                out(Out::Rejected { seq: p.seq, port: p.port, body, shown: p.applied, interval: p.interval, tag: p.tag, key: k });
                continue;
            }
            if p.seq <= self.last_seq {
                self.stats.stale_seq += 1;
                continue;
            }
            self.last_seq = p.seq;
            self.stats.accepted += 1;
            if p.seq > self.shown_seq {
                self.shown_seq = p.seq;
                if !p.applied {
                    out(Out::Apply { seq: p.seq, port: p.port, body, provisional: false });
                }
            }
        }
    }

    /// Revert provisional updates still unverified `d + 2` intervals after the latest the
    /// gateway can have sent them (their key never reached us: a member cut off, or its
    /// neighbours blocked). Call periodically.
    pub fn expire(&mut self, now_us: i64, out: &mut dyn FnMut(Out<'_>)) {
        let upper = self.upper_interval(now_us);
        for i in 0..PENDING {
            let Some(p) = self.pending[i] else { continue };
            if p.applied && upper > p.interval as u32 + self.d as u32 + 2 {
                self.pending[i] = None;
                self.stats.expired += 1;
                out(Out::Expired { seq: p.seq, port: p.port, body: &p.body[..p.len as usize] });
            }
        }
    }

    /// Packets waiting for their keys.
    pub fn waiting(&self) -> usize {
        self.pending.iter().flatten().count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: Context = Context { mesh_id: 7, session: 9 };
    const PW: [u8; 16] = [5; 16];

    fn setup(start: i64, member_t0: i64, reply_at: i64, d: u8) -> (Signer, Verifier) {
        let s = Signer::new(&[1; 16], 3, start, INTERVAL_US, d);
        let ch = Challenge { session: 9, nonce: 42, t0_us: member_t0 };
        let TeslaMsg::Sync(body, mac) = s.sync(reply_at, 9, 5, 42, &PW) else { unreachable!() };
        let v = Verifier::from_sync(&ch, &body, &mac, &PW, 5, 7).expect("sync");
        (s, v)
    }

    #[test]
    fn the_chain_is_consistent_through_its_checkpoints() {
        let mut s = Signer::new(&[9; 16], 1, 0, INTERVAL_US, 3);
        // Every key hashes to its predecessor, across level-2 and level-1 boundaries.
        for i in [1u32, 2, 63, 64, 65, 4095, 4096, 4097, 8192, 65_534, 65_535] {
            assert_eq!(step(&s.key(i)), s.key(i - 1), "{i}");
        }
        assert_eq!(steps(s.key(100), 100), s.commitment());
        // At most one block rebuild (4096) plus 63 per key in steady state.
        let before = s.hashes;
        for i in 5000..5100 {
            s.key(i);
        }
        assert!(s.hashes - before <= 4096 + 100 * 63, "{}", s.hashes - before);
    }

    #[test]
    fn a_member_accepts_live_updates_once_the_key_is_out() {
        // The member's clock runs 1 s behind the gateway's; the round trip is 10 ms.
        let (mut s, mut v) = setup(0, 4_000_000 - 1_000_000, 4_005_000, 3);
        let mut got = Vec::new();
        let mut t = 5_000_000; // gateway time
        for seq in 1..=20u64 {
            t += 33_000;
            let body = [seq as u8; 20];
            let a = s.seal(t, C, seq, 16, &body).unwrap();
            // Arrives 5 ms later, on the member's clock (1 s behind).
            v.on_packet(t + 5_000 - 1_000_000, seq, 16, &a, &body, &mut |o| if let Out::Apply { seq: q, body: b, .. } = o { got.push((q, b[0])) });
        }
        // Everything but the last packets (their keys not yet disclosed) delivered, in order.
        assert!(got.len() >= 17, "{}", got.len());
        assert!(got.iter().enumerate().all(|(k, (q, b))| *q == k as u64 + 1 && *b == *q as u8));
        assert_eq!(v.stats.unsafe_late + v.stats.bad_tag + v.stats.bad_key, 0);
    }

    #[test]
    fn an_insider_with_a_disclosed_key_cannot_forge() {
        let (mut s, mut v) = setup(0, 0, 0, 3);
        let mut got = Vec::new();
        let t = 1_000_000;
        let real = s.seal(t, C, 1, 16, b"real").unwrap();
        v.on_packet(t + 1_000, 1, 16, &real, b"real", &mut |o| if let Out::Apply { seq: q, body: b, .. } = o { got.push((q, b.to_vec())) });
        // Three intervals later the gateway discloses K_i for that interval.
        let later = s.seal(t + 3 * INTERVAL_US as i64, C, 2, 16, b"next").unwrap();
        assert_eq!(later.disclosed, real.interval);
        // An insider who heard it forges a packet "from" that interval, with the true key.
        let k = later.key;
        let forged = Auth { tag: tag(&k, C, real.chain, real.interval, 3, 16, b"evil"), ..real };
        v.on_packet(t + 3 * INTERVAL_US as i64 + 1_000, 2, 16, &later, b"next", &mut |o| if let Out::Apply { seq: q, body: b, .. } = o { got.push((q, b.to_vec())) });
        v.on_packet(t + 3 * INTERVAL_US as i64 + 2_000, 3, 16, &forged, b"evil", &mut |o| if let Out::Apply { seq: q, body: b, .. } = o { got.push((q, b.to_vec())) });
        assert_eq!(got, vec![(1, b"real".to_vec())]);
        // Rejected by the security condition (its interval's key is already out).
        assert_eq!(v.stats.unsafe_late, 1);
        // A forged tag on a still-safe interval fails when its key arrives.
        let t2 = t + 10 * INTERVAL_US as i64;
        let a = s.seal(t2, C, 10, 16, b"ok").unwrap();
        let bad = Auth { tag: [0; TAG_LEN], ..a };
        v.on_packet(t2 + 1_000, 11, 16, &bad, b"evil", &mut |_| {});
        let a2 = s.seal(t2 + 4 * INTERVAL_US as i64, C, 12, 16, b"x").unwrap();
        v.on_packet(t2 + 4 * INTERVAL_US as i64 + 1_000, 12, 16, &a2, b"x", &mut |_| {});
        assert_eq!(v.stats.bad_tag, 1);
        // A disclosed key that is not on the chain is refused.
        let wrong = Auth { disclosed: a2.disclosed + 1, key: [7; KEY_LEN], ..a2 };
        v.on_packet(t2 + 5 * INTERVAL_US as i64, 13, 16, &wrong, b"y", &mut |_| {});
        assert_eq!(v.stats.bad_key, 1);
    }

    /// An attacker holds the member's Req back 200 ms and its Sync another 200 ms. Real time
    /// is one axis here (member and gateway clocks agree). The member's bound is anchored at
    /// its own send time, so it overestimates the gateway's clock by the Req's delay: packets
    /// that are in fact fresh fail the condition and are dropped; none is wrongly accepted.
    #[test]
    fn a_delayed_sync_only_makes_the_bound_conservative() {
        let t0 = 1_000_000;
        let hold = 200_000;
        // The gateway answers when the held Req finally reaches it.
        let (mut s, mut v) = setup(0, t0, t0 + hold, 3);
        let now = t0 + 2 * hold; // the held Sync arrives
        let true_interval = s.interval_at(now).0;
        assert!(v.upper_interval(now) >= true_interval);
        // The bound is T_reply + (now - t0) against the truth `now`: it overshoots by
        // T_reply - t0, the Req's 200 ms hold = 10 intervals (the Sync's hold is inside
        // now - t0 and costs nothing extra; drift adds 80 µs).
        assert_eq!(v.upper_interval(now) - true_interval, 10);
        // A packet sent right now is unsafe for this member (bound 10 intervals ahead > d = 3):
        // dropped and counted, never delivered.
        let a = s.seal(now, C, 1, 16, b"a").unwrap();
        let mut got = 0;
        v.on_packet(now + 1_000, 1, 16, &a, b"a", &mut |o| if matches!(o, Out::Apply { .. }) { got += 1 });
        assert_eq!((got, v.stats.unsafe_late), (0, 1));
        // With an honest 10 ms round trip the same packet is safe.
        let (mut s2, v2) = setup(0, t0, t0 + 5_000, 3);
        let a2 = s2.seal(t0 + 10_000, C, 1, 16, b"a").unwrap();
        assert!(v2.safe(a2.interval as u32, t0 + 11_000));
    }

    /// Apply-then-verify (Q22): a safe update renders on arrival; genuine ones are then
    /// verified silently; a forged one (an insider who cannot know K_i) is rejected when its
    /// key arrives, and the member verifies first for COOLDOWN_US after that.
    #[test]
    fn apply_then_verify_renders_at_once_and_bounds_a_forgery() {
        let (mut s, mut v) = setup(0, 1_000_000, 1_005_000, 3);
        v.early = true;
        let mut log: Vec<(i64, &'static str, u64)> = Vec::new();
        let mut t = 1_100_000;
        let mut forged_at: Option<i64> = None;
        for seq in 1..=30u64 {
            t += 33_000;
            let a = s.seal(t, C, seq, 16, b"real").unwrap();
            let now = t + 3_000;
            v.on_packet(now, seq, 16, &a, b"real", &mut |o| match o {
                Out::Apply { seq, provisional: true, .. } => log.push((now, "prov", seq)),
                Out::Apply { seq, .. } => log.push((now, "late", seq)),
                Out::Rejected { seq, shown: true, .. } => log.push((now, "reject", seq)),
                Out::Rejected { .. } | Out::Expired { .. } => {}
            });
            if seq == 10 || seq == 12 {
                // An insider forges an update for the current interval (it knows the time and
                // the disclosed keys, not K_i), sequence far ahead.
                let f = Auth { tag: [0xAA; TAG_LEN], ..a };
                let fs = 1_000 + seq;
                forged_at.get_or_insert(now + 500);
                v.on_packet(now + 500, fs, 16, &f, b"evil", &mut |o| match o {
                    Out::Apply { seq, provisional: true, .. } => log.push((now + 500, "prov", seq)),
                    Out::Apply { seq, .. } => log.push((now + 500, "late", seq)),
                    Out::Rejected { seq, shown: true, .. } => log.push((now + 500, "reject", seq)),
                    Out::Rejected { .. } | Out::Expired { .. } => {}
                });
            }
        }
        // Genuine 1..=12 render on arrival (3 ms after sending): the forgery's far-ahead
        // sequence (1010) does not hold them back, and genuine 11 (next interval) overwrites
        // it 32.5 ms after it appeared.
        let prov: Vec<u64> = log.iter().filter(|e| e.1 == "prov" && e.2 < 1_000).map(|e| e.2).collect();
        assert_eq!(prov, (1..=12).collect::<Vec<_>>());
        let shown = log.iter().find(|e| e.2 == 1_010 && e.1 == "prov").expect("forgery shown").0;
        let next = log.iter().find(|e| e.2 == 11).unwrap().0;
        assert_eq!(next - shown, 32_500);
        // Genuine 12 (t = 1.496 s, interval 75) discloses K_72, the forgery's interval: it is
        // rejected 65.5 ms after it appeared, within (d + 1) intervals + one packet gap.
        let gone = log.iter().find(|e| e.2 == 1_010 && e.1 == "reject").expect("forgery rejected").0;
        assert_eq!(gone - shown, 65_500);
        // Then the cooldown: the second forgery (1012) is never shown, and genuine 13.. are
        // verified first (shown ~d intervals late): every one whose interval's key the last
        // packet disclosed.
        assert!(!log.iter().any(|e| e.2 == 1_012 && e.1 == "prov"));
        let disclosed = s.interval_at(t).0 - 3;
        let last = (13..=30u64).filter(|q| s.interval_at(1_100_000 + *q as i64 * 33_000).0 <= disclosed).max().unwrap();
        let late: Vec<u64> = log.iter().filter(|e| e.1 == "late").map(|e| e.2).collect();
        assert_eq!(late, (13..=last).collect::<Vec<_>>());
        assert!(last >= 27);
        assert_eq!(v.stats.rolled_back, 1);
        let _ = forged_at;
    }

    /// A forger cannot buy a long glitch by claiming a future interval: the member drops
    /// packets from intervals the gateway cannot have reached.
    #[test]
    fn a_future_interval_is_refused() {
        let (mut s, mut v) = setup(0, 1_000_000, 1_005_000, 3);
        v.early = true;
        let now = 1_200_000;
        let a = s.seal(now, C, 1, 16, b"x").unwrap();
        let f = Auth { interval: a.interval + 10, tag: [1; TAG_LEN], ..a };
        let mut shown = 0;
        v.on_packet(now + 1_000, 2, 16, &f, b"evil", &mut |o| {
            if matches!(o, Out::Apply { .. }) {
                shown += 1;
            }
        });
        assert_eq!((shown, v.stats.future), (0, 1));
    }

    /// A provisional update whose key never arrives is reverted d + 2 intervals on.
    #[test]
    fn an_unverified_provisional_update_expires() {
        let (mut s, mut v) = setup(0, 1_000_000, 1_005_000, 3);
        v.early = true;
        let t = 1_100_000;
        let a = s.seal(t, C, 1, 16, b"x").unwrap();
        let mut ev = Vec::new();
        v.on_packet(t + 1_000, 1, 16, &a, b"x", &mut |o| ev.push(format!("{o:?}").split(' ').next().unwrap().to_string()));
        v.expire(t + 4 * INTERVAL_US as i64, &mut |o| ev.push(format!("{o:?}").split(' ').next().unwrap().to_string()));
        assert_eq!(ev, ["Apply"]);
        v.expire(t + 7 * INTERVAL_US as i64, &mut |o| ev.push(format!("{o:?}").split(' ').next().unwrap().to_string()));
        assert_eq!(ev, ["Apply", "Expired"]);
        assert_eq!((v.stats.expired, v.stats.rolled_back), (1, 0));
    }

    /// Best-of-N challenges (Q24): a later, faster round trip tightens the bound.
    #[test]
    fn a_tighter_round_trip_rebounds_the_clock() {
        let s = Signer::new(&[1; 16], 3, 0, INTERVAL_US, 3);
        let ch = |nonce, t0| Challenge { session: 9, nonce, t0_us: t0 };
        // First round trip 100 ms (gateway answered at t0 + 80 ms), second 10 ms.
        let TeslaMsg::Sync(b1, m1) = s.sync(1_080_000, 9, 5, 1, &PW) else { unreachable!() };
        let mut v = Verifier::from_sync(&ch(1, 1_000_000), &b1, &m1, &PW, 5, 7).unwrap();
        let TeslaMsg::Sync(b2, m2) = s.sync(2_005_000, 9, 5, 2, &PW) else { unreachable!() };
        let v2 = Verifier::from_sync(&ch(2, 2_000_000), &b2, &m2, &PW, 5, 7).unwrap();
        let now = 2_010_000;
        let before = v.upper_interval(now);
        assert!(v.rebound(now, &v2));
        let after = v.upper_interval(now);
        // The first bound carried 80 ms of slack, the second 5 ms: 75 ms, 3.75 intervals.
        assert_eq!(before - after, 4);
        assert!(!v.rebound(now, &v2));
    }

    #[test]
    fn a_sync_for_another_nonce_or_key_is_refused() {
        let s = Signer::new(&[1; 16], 3, 0, INTERVAL_US, 3);
        let TeslaMsg::Sync(body, mac) = s.sync(0, 9, 5, 42, &PW) else { unreachable!() };
        let ch = Challenge { session: 9, nonce: 41, t0_us: 0 };
        assert!(Verifier::from_sync(&ch, &body, &mac, &PW, 5, 7).is_none());
        let ch = Challenge { session: 9, nonce: 42, t0_us: 0 };
        assert!(Verifier::from_sync(&ch, &body, &mac, &[6; 16], 5, 7).is_none());
        assert!(Verifier::from_sync(&ch, &body, &mac, &PW, 6, 7).is_none());
        assert!(Verifier::from_sync(&ch, &body, &mac, &PW, 5, 7).is_some());
    }

    #[test]
    fn messages_and_trailers_roundtrip() {
        let s = Signer::new(&[1; 16], 3, 0, INTERVAL_US, 3);
        let m = s.sync(123_456, 9, 5, 42, &PW);
        let mut b = [0u8; 80];
        let n = m.encode(&mut b).unwrap();
        assert_eq!(TeslaMsg::decode(&b[..n]), Some(m));
        let r = TeslaMsg::Req { session: 9, node: 5, nonce: 42, rtt_us: 12_000, mac: req_mac(&PW, 9, 5, 42, 12_000) };
        let n = r.encode(&mut b).unwrap();
        assert_eq!(TeslaMsg::decode(&b[..n]), Some(r));
        let a = Auth { chain: 1, interval: 2, tag: [3; 8], disclosed: 4, key: [5; 16] };
        let n = a.encode(&mut b).unwrap();
        assert_eq!(n, AUTH_LEN);
        assert_eq!(Auth::decode(&b[..n]), Some(a));
    }
}
