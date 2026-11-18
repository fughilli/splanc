//! Distribution: the managed flood vs the two-tier tree (design §5.8), packet level.
//!
//! The gateway (node 0) is the root. For every update it picks a mode ([`Scheme::Auto`]: the
//! root's [`Selector`] on the member count, Q18) and stamps it in the packet:
//!
//! - **Flood**: every node relays each packet once after a short delay and cancels when it
//!   hears someone else's copy first; hop limit = the 802.11 diameter + 1 (the adaptive limit).
//! - **Tree** ([`splanc_mesh::tree`]): the root sends on UWB (to UWB children) and on 802.11;
//!   relays forward once, over 802.11 if they have 802.11 children and, with multi-hop UWB
//!   (Q20), over UWB if they have UWB children; leaves never relay; orphans flood.
//!
//! Every packet carries every recipient's MAC entry (13 B + 8 B per member, at most 19 per
//! packet), so any copy of the right part delivers. Reliable commands (one per second) carry
//! a sequence: a node that sees a gap asks its parent by unicast NACK, and the parent answers
//! from its [`RelayCache`] (Q21: every fixture caches; the hit rate is measured here).
//!
//! 802.11 is [`Air`] (CSMA, collisions, capture, walking people). UWB is a DW3000-class TDMA
//! medium: 6.8 Mb/s, 80-byte frames (a packet is fragmented; every fragment must arrive), a
//! 4 ms superframe of four 1 ms data slots (slot 0 the root's, slots 1-3 shared round-robin by
//! UWB relays), one beacon per node per second, a link budget with enclosure loss and
//! walking shadow, no contention.

use std::collections::{HashMap, HashSet, VecDeque};

use splanc_mesh::backhaul::Backhaul;
use splanc_mesh::msg::Class;
use splanc_mesh::tesla::{self, Auth, Challenge, Out, Signer, TeslaMsg, Verifier};
use splanc_mesh::tree::{Dist, Radio, RelayCache, Role, Selector, Tree, TreeAd};

use super::{Air, Placement, RadioModel, Rate, SimPort, MTU};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Flood,
    Tree,
    /// The root's selector decides by member count (Q18).
    Auto,
}

#[derive(Clone, Debug)]
pub struct DistCfg {
    pub positions: Vec<(f64, f64)>,
    pub uwb: Vec<bool>,
    pub class: Vec<Class>,
    pub scheme: Scheme,
    pub walking: bool,
    /// Share of fixtures that move (random waypoint, 0.3 m/s).
    pub moving: f64,
    pub loss: f64,
    pub adaptive_rate: bool,
    /// Live updates per second from the gateway (node 0).
    pub hz: u32,
    pub warmup_ms: i64,
    pub run_ms: i64,
    /// Kill the relay with the most children this long after the warm-up.
    pub kill_relay_at_ms: Option<i64>,
    pub seed: u64,
    /// UWB antenna loss through the enclosure (each end), dB.
    pub uwb_enclosure_db: f64,
    pub wifi_enclosure_db: f64,
    /// UWB relays forward over UWB to their UWB children (Q20); otherwise only the root
    /// sends on UWB.
    pub uwb_multihop: bool,
    /// Relay cache entries used (≤ 16).
    pub cache_depth: usize,
    /// Members over time, `(ms from start, count)`: nodes `0..count` are on. Empty: all.
    pub members: Vec<(i64, usize)>,
    /// Live updates in tree mode under the broadcast authenticator (Q19): `(interval µs,
    /// disclosure delay d)`. None: per-receiver MACs everywhere.
    pub tesla: Option<(u32, u8)>,
    /// The challenge round trip each member bootstraps its time bound with (ms). With
    /// `tesla_adaptive` it is sampled instead: twice the member's measured delivery latency
    /// plus 2 ms and an exponential queueing jitter of this mean (ms).
    pub tesla_rtt_ms: i64,
    /// Apply-then-verify (Q22).
    pub tesla_early: bool,
    /// Best-of-N challenges and a gateway `d` sized from the reported round trips (Q24).
    pub tesla_adaptive: bool,
    /// An insider forging live updates for the current interval at this rate (Hz).
    pub insider_hz: f64,
}

impl DistCfg {
    pub fn new(positions: Vec<(f64, f64)>, uwb: Vec<bool>, class: Vec<Class>, scheme: Scheme, seed: u64) -> DistCfg {
        DistCfg {
            positions,
            uwb,
            class,
            scheme,
            walking: true,
            moving: 0.0,
            loss: 0.03,
            adaptive_rate: false,
            hz: 30,
            warmup_ms: 15_000,
            run_ms: 20_000,
            kill_relay_at_ms: None,
            seed,
            uwb_enclosure_db: 3.0,
            wifi_enclosure_db: 10.0,
            uwb_multihop: true,
            cache_depth: splanc_mesh::tree::CACHE_ENTRIES,
            members: Vec::new(),
            tesla: None,
            tesla_rtt_ms: 40,
            tesla_early: false,
            tesla_adaptive: false,
            insider_hz: 0.0,
        }
    }
}

/// One second of the run (after the warm-up).
#[derive(Clone, Debug, Default)]
pub struct Bin {
    pub t_s: f64,
    pub members: usize,
    pub tree: bool,
    pub delivery: f64,
    pub airtime: f64,
}

#[derive(Clone, Debug, Default)]
pub struct DistOut {
    /// Live updates delivered (no repair: the next update supersedes a lost one).
    pub delivery: f64,
    /// Reliable commands delivered within 1 s (with repair).
    pub reliable_delivery: f64,
    pub lat_p50_ms: f64,
    pub lat_p99_ms: f64,
    pub wifi_airtime: f64,
    pub uwb_util: f64,
    /// Tree control bytes per node per second (the advert fields, NACKs, repairs).
    pub ctrl_bps: f64,
    pub relays: usize,
    pub max_children: u8,
    pub orphans: usize,
    pub parent_changes_per_node_min: f64,
    pub repair_s: f64,
    pub packets_per_update: usize,
    /// Nodes whose parent link is UWB, and the deepest UWB-only path from the root.
    pub uwb_tier: usize,
    pub uwb_depth: u8,
    /// Updates that reached a node over UWB first.
    pub uwb_first: f64,
    pub evictions_per_node_min: f64,
    pub max_excess: u8,
    pub nacks: u64,
    pub cache_hits: u64,
    pub cache_misses: u64,
    /// How far back each repair request reached: the responder's newest reliable sequence
    /// minus the one asked for (the depth a cache needs to answer it).
    pub nack_age_p90: u16,
    pub nack_age_max: u16,
    /// Requests the parent could not answer because it never had the packet.
    pub nack_lacking: u64,
    pub mode_switches: u32,
    /// The broadcast authenticator: packets a member dropped as unsafe (arrived after their
    /// key could be out), hashes per member per second and at the gateway, and the bytes of
    /// one authenticated update on the air.
    pub tesla_unsafe: u64,
    pub tesla_hashes_member_s: f64,
    pub tesla_hashes_gw_s: f64,
    pub update_bytes: usize,
    /// The disclosure delay in use at the end, and chains built.
    pub tesla_d: u8,
    pub tesla_chains: u32,
    /// Honest updates rolled back (should be none).
    pub honest_rejected: u64,
    /// The insider: forgeries sent, member-forgeries shown, how long each stayed on screen
    /// (until a newer genuine update or its rejection; ms), and the share of member-time a
    /// forged value was on screen.
    pub forgeries: u64,
    pub forged_shown: u64,
    pub glitch_p50_ms: f64,
    pub glitch_max_ms: f64,
    pub forged_screen_share: f64,
    /// The root's children (the members a per-receiver-MAC first hop would reach directly).
    pub root_children: u8,
    pub series: Vec<Bin>,
}

const KIND_DATA: u8 = 1;
const KIND_AD: u8 = 2;
const KIND_NACK: u8 = 3;
const KIND_REPAIR: u8 = 4;
const ENVELOPE: usize = 22;
const HDR: usize = 12;
const UWB_PAYLOAD: usize = 80;
const UWB_FRAME_US: i64 = 210; // preamble + PHR + 80 B at 6.8 Mb/s
const UWB_SLOT_FRAMES: usize = 4; // 1 ms slot
const SLOT_US: i64 = 5_000;
const DEADLINE_US: i64 = 500_000;
const UWB_SENS: f64 = -94.0;
/// Recipients per packet: the per-receiver MAC entries one 802.11 packet carries (§7.9).
const PER_PACKET: usize = 19;
const FLOOD_FWD: u16 = 0xFFFF;

fn rnd(s: &mut u64) -> f64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    (*s >> 11) as f64 / (1u64 << 53) as f64
}

/// (seq, part) as one key.
fn key(seq: u16, part: u8) -> u32 {
    ((seq as u32) << 8) | part as u32
}

/// A live update's body: per-receiver MACs (13 B + 8 B per recipient), or the broadcast
/// authenticator's trailer (30 B) + sequence (8 B) + control header (6 B); 12 B of uniforms.
fn body_len(recipients: usize, auth: bool) -> usize {
    if auth {
        tesla::AUTH_LEN + 8 + 6 + 12
    } else {
        13 + 8 * recipients + 12
    }
}

const PAIRWISE: [u8; 16] = [0x5a; 16];
const CTX: tesla::Context = tesla::Context { mesh_id: 7, session: 1 };

/// Frame header (12 B): kind, origin (2), seq (2), hop, part, forwarder (2), reliable seq
/// (2), mode; then `body` bytes.
#[allow(clippy::too_many_arguments)]
fn frame(kind: u8, seq: u16, hop: u8, part: u8, fwd: u16, rseq: u16, mode: Dist, body: usize) -> Vec<u8> {
    let mut f = vec![0u8; (HDR + body + ENVELOPE).min(MTU)];
    f[0] = kind;
    f[1..3].copy_from_slice(&1u16.to_be_bytes());
    f[3..5].copy_from_slice(&seq.to_be_bytes());
    f[5] = hop;
    f[6] = part;
    f[7..9].copy_from_slice(&fwd.to_be_bytes());
    f[9..11].copy_from_slice(&rseq.to_be_bytes());
    f[11] = (mode == Dist::Tree) as u8;
    f
}

struct Node {
    port: SimPort,
    tree: Tree,
    /// seq -> first arrival (global µs).
    got: HashMap<u16, i64>,
    got_uwb: HashSet<u16>,
    /// Pending 802.11 forwards: (seq, part) -> (due, hop).
    due: HashMap<u32, (i64, u8)>,
    relayed: HashSet<u32>,
    uwb_sent: HashSet<u32>,
    /// Flood: the first sender heard per (seq, part); a copy from anyone else cancels.
    first_from: HashMap<u32, usize>,
    cache: RelayCache<16, 256>,
    nacked: HashMap<u32, i64>,
    uwb_out: VecDeque<Vec<u8>>,
    next_ad: i64,
    next_window: i64,
    alive: bool,
    killed: bool,
    waypoint: Option<(f64, f64)>,
    /// What this node learnt of each update: its reliable sequence and its mode.
    rseq_of: HashMap<u16, u16>,
    mode_of: HashMap<u16, bool>,
    /// (seq, part) copies already received.
    seen: HashSet<u32>,
    /// The member's verifier for the gateway's chain, and the updates handed to it.
    tv: Option<Verifier>,
    fed: HashSet<u16>,
    /// Q24: challenges made for the current chain, the last one's time, the best round trip.
    tries: u8,
    last_req: i64,
    best_rtt: u32,
    /// A forged update on screen since (seq, time).
    forged_on: Option<(u16, i64)>,
}

struct Gen {
    seq: u16,
    t: i64,
    reliable: bool,
    tree: bool,
    alive: Vec<bool>,
}

struct Sim<'a> {
    cfg: &'a DistCfg,
    /// seq -> the recipients of each part.
    parts: HashMap<u16, Vec<Vec<usize>>>,
    hops: u8,
    ctrl: u64,
    nacks: u64,
    ages: Vec<u16>,
    lacking: u64,
    /// The gateway's chain and each authenticated update's trailer and body.
    signer: Option<Signer>,
    auth: HashMap<u16, (Auth, [u8; 12])>,
    gen_t: HashMap<u16, i64>,
    rtt_max: u32,
    rebuild: bool,
    chains: u32,
    rng: u64,
    glitches: Vec<f64>,
    honest_rejected: u64,
}

/// The UWB link budget (dBm) from `a` to `b`: −14 dBm EIRP (−41.3 dBm/MHz over 500 MHz),
/// free space at 6.5 GHz (48.7 dB at 1 m, exponent 2 line of sight), the antennas' enclosure
/// losses, 10 dB while someone stands in the path.
fn uwb_rx(cfg: &DistCfg, a: (f64, f64), b: (f64, f64), shadowed: bool) -> f64 {
    let d = ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt().max(0.3);
    -14.0 - (48.7 + 20.0 * d.log10()) - 2.0 * cfg.uwb_enclosure_db - if shadowed { 10.0 } else { 0.0 }
}

fn uwb_ok(rx: f64) -> f64 {
    if rx >= UWB_SENS + 3.0 {
        0.98
    } else if rx >= UWB_SENS {
        0.7
    } else {
        0.0
    }
}

fn members_at(cfg: &DistCfg, t_ms: i64) -> usize {
    let n = cfg.positions.len();
    cfg.members.iter().take_while(|(t, _)| *t <= t_ms).last().map_or(n, |x| x.1.min(n))
}

/// Run one configuration.
#[allow(clippy::needless_range_loop)] // nodes, positions and the UWB matrix share the index
pub fn run(cfg: &DistCfg) -> DistOut {
    let n = cfg.positions.len();
    let model = RadioModel { rate: Rate::Ofdm6, adaptive: cfg.adaptive_rate, walking: cfg.walking, ..RadioModel::default() };
    let air = Air::new(model, cfg.seed);
    let mut s = cfg.seed ^ 0x77;
    let new_tree = |i: usize| {
        let mut t = Tree::new(i as u16 + 1, cfg.uwb[i], cfg.class[i]);
        t.pos = Some(((cfg.positions[i].0 * 10.0) as i16, (cfg.positions[i].1 * 10.0) as i16));
        t
    };
    let mut nodes: Vec<Node> = (0..n)
        .map(|i| {
            let mut p = Placement::at(cfg.positions[i].0, cfg.positions[i].1);
            p.enclosure_db = cfg.wifi_enclosure_db;
            p.clock_offset_us = (rnd(&mut s) * 2e5) as i64;
            let idx = air.add(i as u16 + 1, p);
            let mut cache = RelayCache::new();
            cache.set_depth(cfg.cache_depth);
            Node {
                port: SimPort { air: air.clone(), index: idx },
                tree: new_tree(i),
                got: HashMap::new(),
                got_uwb: HashSet::new(),
                due: HashMap::new(),
                relayed: HashSet::new(),
                uwb_sent: HashSet::new(),
                first_from: HashMap::new(),
                cache,
                nacked: HashMap::new(),
                uwb_out: VecDeque::new(),
                next_ad: (rnd(&mut s) * 1e6) as i64,
                next_window: 1_000_000 + (rnd(&mut s) * 1e6) as i64,
                alive: false,
                killed: false,
                waypoint: None,
                rseq_of: HashMap::new(),
                mode_of: HashMap::new(),
                seen: HashSet::new(),
                tv: None,
                fed: HashSet::new(),
                tries: 0,
                last_req: i64::MIN / 2,
                best_rtt: 0,
                forged_on: None,
            }
        })
        .collect();
    air.set_loss(cfg.loss);
    nodes[0].tree.set_root(Some(1), 1);
    let movers: Vec<usize> = (1..n).filter(|_| rnd(&mut s) < cfg.moving).collect();
    let mut shadow = vec![vec![0i64; n]; n];
    let mut uwb_busy = 0i64;
    // Every node on for the diameter (the flood's adaptive hop limit), then the schedule.
    for i in 0..n {
        air.0.borrow_mut().st[i].online = true;
    }
    let mut sim = Sim { cfg, parts: HashMap::new(), hops: diameter(&air, n) + 1, ctrl: 0, nacks: 0, ages: Vec::new(), lacking: 0, signer: cfg.tesla.map(|(iv, d)| Signer::new(&[0x33; 16], 1, 0, iv, d)), auth: HashMap::new(), gen_t: HashMap::new(), rtt_max: 0, rebuild: false, chains: 1, rng: cfg.seed ^ 0x7e57, glitches: Vec::new(), honest_rejected: 0 };
    let gw_hashes0 = sim.signer.as_ref().map_or(0, |s| s.hashes);
    let mut selector = Selector::new();
    let mut seq: u16 = 0;
    let mut rseq: u16 = 0;
    let mut gens: Vec<Gen> = Vec::new();
    let mut killed: Option<(usize, Vec<usize>, i64)> = None;
    let mut repair_done: Option<i64> = None;
    let mut buf = [0u8; 512];
    let t_end = (cfg.warmup_ms + cfg.run_ms) * 1000;
    let mut air0 = 0i64;
    let mut air_bins: Vec<(i64, usize, bool)> = Vec::new();
    let mut rr = 1usize;
    let mut updates = 0u64;
    let mut forge_seq: u16 = 0x8000;
    let mut forgeries = 0u64;
    let mut now = 0i64;
    while now < t_end {
        now += 1_000;
        air.0.borrow_mut().advance(now);
        if now == cfg.warmup_ms * 1000 {
            air0 = air.stats().airtime_us;
            uwb_busy = 0;
            sim.ctrl = 0;
            sim.nacks = 0;
            sim.ages.clear();
            sim.lacking = 0;
            for nd in nodes.iter_mut() {
                nd.tree.stats = Default::default();
                nd.cache.stats = Default::default();
            }
        }
        // Membership: nodes 0..count are on; a joiner starts with fresh tree state.
        if now % 100_000 == 0 || now == 1_000 {
            let count = members_at(cfg, now / 1000);
            for i in 0..n {
                let want = (i < count || i == 0) && !nodes[i].killed;
                if want != nodes[i].alive {
                    nodes[i].alive = want;
                    air.0.borrow_mut().st[i].online = want;
                    if want && i != 0 {
                        nodes[i].tree = new_tree(i);
                    }
                }
            }
        }
        if now >= cfg.warmup_ms * 1000 && now % 1_000_000 == 0 {
            let alive = nodes.iter().filter(|x| x.alive).count();
            air_bins.push((air.stats().airtime_us, alive, selector.mode == Dist::Tree));
        }
        if cfg.walking && now % 500_000 == 0 {
            for a in 0..n {
                for b in a + 1..n {
                    if rnd(&mut s) < 0.03 {
                        let until = now + 1_000_000 + (rnd(&mut s) * 2e6) as i64;
                        shadow[a][b] = until;
                        shadow[b][a] = until;
                    }
                }
            }
        }
        if !movers.is_empty() && now % 100_000 == 0 {
            let (w, h) = extent(&cfg.positions);
            for &i in &movers {
                let wp = *nodes[i].waypoint.get_or_insert((rnd(&mut s) * w, rnd(&mut s) * h));
                let mut m = air.0.borrow_mut();
                let p = &mut m.st[i].place;
                let (dx, dy) = (wp.0 - p.x_m, wp.1 - p.y_m);
                let d = (dx * dx + dy * dy).sqrt();
                if d < 0.1 {
                    drop(m);
                    nodes[i].waypoint = None;
                } else {
                    let step = 0.03f64.min(d);
                    p.x_m += dx / d * step;
                    p.y_m += dy / d * step;
                    nodes[i].tree.pos = Some(((p.x_m * 10.0) as i16, (p.y_m * 10.0) as i16));
                }
            }
        }
        if let (Some(k), None) = (cfg.kill_relay_at_ms, &killed) {
            if now == (cfg.warmup_ms + k) * 1000 {
                let victim = (1..n).filter(|&i| nodes[i].alive).max_by_key(|&i| nodes[i].tree.children).unwrap_or(1);
                let kids: Vec<usize> = (0..n).filter(|&j| nodes[j].alive && nodes[j].tree.parent.is_some_and(|p| p.0 as usize == victim + 1)).collect();
                nodes[victim].alive = false;
                nodes[victim].killed = true;
                air.0.borrow_mut().st[victim].online = false;
                killed = Some((victim, kids, now));
            }
        }
        // Child reports: every relay to the root every 5 s (2 hops, 4 + 2 B per child).
        if now % 5_000_000 == 0 {
            for nd in nodes.iter().filter(|x| x.alive && x.tree.role == Role::Relay) {
                sim.ctrl += 2 * (4 + 2 * nd.tree.children as u64 + ENVELOPE as u64);
            }
        }
        // The gateway's update: live at `hz`, one in `hz` reliable.
        if now >= cfg.warmup_ms * 1000 && cfg.hz > 0 && (now / 1000) % (1000 / cfg.hz as i64) == 0 {
            seq = seq.wrapping_add(1);
            updates += 1;
            let reliable = updates % cfg.hz as u64 == 0;
            let r = if reliable {
                rseq = rseq.wrapping_add(1);
                rseq
            } else {
                0
            };
            let alive: Vec<bool> = nodes.iter().map(|x| x.alive).collect();
            let members = alive.iter().filter(|a| **a).count();
            let mode = match cfg.scheme {
                Scheme::Flood => Dist::Flood,
                Scheme::Tree => Dist::Tree,
                Scheme::Auto => selector.update(now, members as u16),
            };
            gens.push(Gen { seq, t: now, reliable, tree: mode == Dist::Tree, alive: alive.clone() });
            sim.gen_t.insert(seq, now);
            sim.gen_t.remove(&seq.wrapping_sub(512));
            // Q24: the gateway rebuilds its chain when a member's round trip needs a larger d.
            if sim.rebuild {
                sim.rebuild = false;
                let d = tesla::needed_d(sim.rtt_max, sim.signer.as_ref().map_or(tesla::INTERVAL_US, |s| s.interval_us()));
                let iv = sim.signer.as_ref().map_or(tesla::INTERVAL_US, |s| s.interval_us());
                sim.chains += 1;
                sim.signer = Some(Signer::new(&[0x34 ^ sim.chains as u8; 16], sim.chains as u16, now, iv, d));
                sim.rtt_max = 0;
                for nd in nodes.iter_mut() {
                    nd.tv = None;
                    nd.tries = 0;
                }
            }
            nodes[0].got.insert(seq, now);
            if reliable {
                nodes[0].tree.seq = r;
            }
            let recips: Vec<usize> = (1..n).filter(|&j| alive[j]).collect();
            // Live updates in tree mode under the broadcast authenticator: one packet for
            // everyone. Reliable commands keep per-receiver MACs.
            let auth = mode == Dist::Tree && !reliable && sim.signer.is_some();
            let parts: Vec<Vec<usize>> = if auth { vec![recips.clone()] } else { recips.chunks(PER_PACKET).map(|c| c.to_vec()).collect() };
            if auth {
                let body = [seq as u8; 12];
                let a = sim.signer.as_mut().unwrap().seal(now, CTX, seq as u64, 24, &body).expect("chain");
                sim.auth.insert(seq, (a, body));
                sim.auth.remove(&seq.wrapping_sub(256));
            }
            let fwd = if mode == Dist::Flood { FLOOD_FWD } else { 1 };
            for (k, p) in parts.iter().enumerate() {
                let f = frame(KIND_DATA, seq, 0, k as u8, fwd, r, mode, body_len(p.len(), auth));
                if r != 0 {
                    nodes[0].cache.put(key16(r, k as u8), &f);
                }
                let _ = nodes[0].port.send(&f, None);
                if mode == Dist::Tree && cfg.uwb[0] {
                    let mut u = f.clone();
                    u.truncate(f.len() - ENVELOPE); // UWB frames carry no 802.11 envelope
                    nodes[0].uwb_out.push_back(u);
                }
            }
            sim.parts.insert(seq, parts);
            if sim.parts.len() > 64 {
                let old = seq.wrapping_sub(64);
                sim.parts.remove(&old);
            }
        }
        // The insider (the member half-way through the list) forges an update for the
        // gateway's current interval: it knows the time and the disclosed keys, not K_i.
        if cfg.insider_hz > 0.0 && now >= cfg.warmup_ms * 1000 && sim.signer.is_some() && (now / 1000) % ((1000.0 / cfg.insider_hz) as i64).max(1) == 7 {
            let x = n / 2;
            if nodes[x].alive {
                forge_seq = forge_seq.wrapping_add(1) | 0x8000;
                let s = sim.signer.as_mut().unwrap();
                let (cur, _) = s.interval_at(now);
                let d = s.disclose_delay() as u32;
                let key = s.key(cur.saturating_sub(d));
                let a = Auth { chain: s.chain, interval: cur as u16, tag: [0x5A; 8], disclosed: cur.saturating_sub(d) as u16, key };
                sim.auth.insert(forge_seq, (a, [0xEE; 12]));
                let recips: Vec<usize> = (1..n).filter(|&j| nodes[j].alive && j != x).collect();
                sim.parts.insert(forge_seq, vec![recips]);
                let f = frame(KIND_DATA, forge_seq, 0, 0, x as u16 + 1, 0, Dist::Tree, body_len(0, true));
                let _ = nodes[x].port.send(&f, None);
                forgeries += 1;
            }
        }
        // UWB: a 4 ms superframe of four 1 ms slots; slot 0 the root's, 1-3 round-robin.
        let slot = (now / 1000) % 4;
        let sender = if slot == 0 {
            (!nodes[0].uwb_out.is_empty()).then_some(0)
        } else {
            let found = (0..n).map(|k| (rr + k) % n).find(|&i| i != 0 && nodes[i].alive && !nodes[i].uwb_out.is_empty());
            if let Some(i) = found {
                rr = i + 1;
            }
            found
        };
        if let Some(i) = sender {
            let mut frames = 0;
            while let Some(f) = nodes[i].uwb_out.front() {
                let frags = f.len().div_ceil(UWB_PAYLOAD);
                if frames + frags > UWB_SLOT_FRAMES && frames > 0 {
                    break;
                }
                frames += frags;
                let f = nodes[i].uwb_out.pop_front().unwrap();
                uwb_busy += frags as i64 * UWB_FRAME_US;
                let pi = pos(&air, i);
                for j in 0..n {
                    if j == i || !cfg.uwb[j] || !nodes[j].alive {
                        continue;
                    }
                    let p = uwb_ok(uwb_rx(cfg, pi, pos(&air, j), shadow[i][j] > now));
                    if p > 0.0 && (0..frags).all(|_| rnd(&mut s) < p) {
                        on_data(&mut sim, &mut nodes, j, i, &f, now + frames as i64 * UWB_FRAME_US, true);
                    }
                }
            }
        }
        // UWB beacons: each UWB node once a second.
        if now % 1_000_000 == 0 {
            for i in 0..n {
                if !cfg.uwb[i] || !nodes[i].alive {
                    continue;
                }
                let ad = nodes[i].tree.ad();
                uwb_busy += UWB_FRAME_US;
                sim.ctrl += TreeAd::LEN as u64;
                let pi = pos(&air, i);
                for j in 0..n {
                    if j == i || !cfg.uwb[j] || !nodes[j].alive {
                        continue;
                    }
                    if rnd(&mut s) < uwb_ok(uwb_rx(cfg, pi, pos(&air, j), shadow[i][j] > now)) {
                        nodes[j].tree.heard(now, i as u16 + 1, Radio::Uwb, &ad, Some(((pi.0 * 10.0) as i16, (pi.1 * 10.0) as i16)));
                    }
                }
            }
        }
        for i in 0..n {
            if !nodes[i].alive {
                continue;
            }
            while let Some(meta) = nodes[i].port.recv(&mut buf) {
                let f = buf[..meta.len].to_vec();
                let src = (u16::from_be_bytes([meta.src_mac[4], meta.src_mac[5]]) as usize).saturating_sub(1);
                match f[0] {
                    KIND_AD => {
                        let Some(ad) = TreeAd::decode(&f[1..1 + TreeAd::LEN]) else { continue };
                        let x = i16::from_be_bytes([f[13], f[14]]);
                        let y = i16::from_be_bytes([f[15], f[16]]);
                        nodes[i].tree.heard(now, src as u16 + 1, Radio::Wifi, &ad, Some((x, y)));
                        // The parent has a reliable packet we lack: ask for it.
                        if nodes[i].tree.parent.is_some_and(|p| p.0 as usize == src + 1) {
                            let mine = nodes[i].tree.seq;
                            let gap = ad.seq.wrapping_sub(mine);
                            if gap > 0 && gap < 5 {
                                for q in 1..=gap {
                                    nack(&mut sim, &mut nodes[i], mine.wrapping_add(q), src as u16 + 1, now);
                                }
                            }
                        }
                    }
                    KIND_DATA | KIND_REPAIR => on_data(&mut sim, &mut nodes, i, src, &f, now, false),
                    KIND_NACK => {
                        let want = u16::from_be_bytes([f[1], f[2]]);
                        let part = f[3];
                        let dst = u16::from_be_bytes([f[4], f[5]]);
                        let age = nodes[i].tree.seq.wrapping_sub(want);
                        if age < 0x8000 {
                            sim.ages.push(age);
                        } else {
                            sim.lacking += 1; // the parent never had it either
                        }
                        if let Some(fr) = nodes[i].cache.get(key16(want, part)).map(|b| b.to_vec()) {
                            let mut r = fr;
                            r[0] = KIND_REPAIR;
                            // A repair carries just the requester's entry.
                            r.truncate(HDR + 13 + 8 + 12 + ENVELOPE);
                            sim.ctrl += r.len() as u64;
                            let _ = nodes[i].port.send(&r, Some(dst));
                        }
                    }
                    _ => {}
                }
            }
            if now >= nodes[i].next_ad {
                nodes[i].next_ad = now + 750_000 + (rnd(&mut s) * 250_000.0) as i64;
                let p = pos(&air, i);
                let mut a = vec![KIND_AD];
                let mut tb = [0u8; TreeAd::LEN];
                nodes[i].tree.ad().encode(&mut tb);
                a.extend_from_slice(&tb);
                a.extend_from_slice(&((p.0 * 10.0) as i16).to_be_bytes());
                a.extend_from_slice(&((p.1 * 10.0) as i16).to_be_bytes());
                a.resize(14 + ENVELOPE, 0); // the advert exists anyway (§5.3)
                sim.ctrl += (TreeAd::LEN + 4) as u64;
                let _ = nodes[i].port.send(&a, None);
            }
            if now >= nodes[i].next_window {
                nodes[i].next_window = now + 1_000_000;
                nodes[i].tree.window(1, cfg.uwb[i] as u8);
                nodes[i].tree.decide(now);
            }
            let due: Vec<u32> = nodes[i].due.iter().filter(|(_, (t, _))| *t <= now).map(|(k, _)| *k).collect();
            for k in due {
                let (_, h) = nodes[i].due.remove(&k).unwrap();
                nodes[i].relayed.insert(k);
                let (q, part) = ((k >> 8) as u16, (k & 0xFF) as u8);
                let Some(p) = sim.parts.get(&q).and_then(|v| v.get(part as usize)) else { continue };
                let r = nodes[i].cache_rseq(q);
                let tree = nodes[i].tree_mode(q);
                let flood = !tree || nodes[i].tree.role == Role::Orphan;
                let fwd = if flood { FLOOD_FWD } else { i as u16 + 1 };
                let mode = if tree { Dist::Tree } else { Dist::Flood };
                let f = frame(KIND_DATA, q, h, part, fwd, r, mode, body_len(p.len(), sim.auth.contains_key(&q)));
                let _ = nodes[i].port.send(&f, None);
            }
        }
        if let (Some((victim, kids, at)), None) = (&killed, repair_done) {
            let ok = kids.iter().all(|&j| {
                let has_parent = nodes[j].tree.parent.is_some_and(|p| p.0 as usize != victim + 1);
                let recent = gens.iter().rev().take(5).any(|g| g.t > *at && nodes[j].got.get(&g.seq).is_some_and(|r| r - g.t < 100_000));
                has_parent && recent
            });
            if ok {
                repair_done = Some(now - at);
            }
        }
    }
    // Metrics.
    let mut lat = Vec::new();
    let (mut exp_live, mut ok_live, mut exp_rel, mut ok_rel, mut via_uwb) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let nbins = (cfg.run_ms / 1000) as usize;
    let mut bins: Vec<(u64, u64, usize, bool)> = vec![(0, 0, 0, false); nbins.max(1)];
    for g in &gens {
        if g.t > t_end - DEADLINE_US {
            continue;
        }
        let b = (((g.t - cfg.warmup_ms * 1000) / 1_000_000) as usize).min(bins.len() - 1);
        bins[b].2 = g.alive.iter().filter(|a| **a).count();
        bins[b].3 = g.tree;
        for (j, nd) in nodes.iter().enumerate() {
            if j == 0 || !g.alive[j] || nd.killed && killed.as_ref().is_some_and(|k| g.t >= k.2) {
                continue;
            }
            let hit = nd.got.get(&g.seq).is_some_and(|r| r - g.t <= if g.reliable { 2 * DEADLINE_US } else { DEADLINE_US });
            if g.reliable {
                exp_rel += 1;
                ok_rel += hit as u64;
            } else {
                exp_live += 1;
                ok_live += hit as u64;
                bins[b].0 += 1;
                bins[b].1 += hit as u64;
            }
            if hit {
                lat.push((nd.got[&g.seq] - g.t) as f64 / 1000.0);
                via_uwb += nd.got_uwb.contains(&g.seq) as u64;
            }
        }
    }
    lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| if lat.is_empty() { f64::NAN } else { lat[((lat.len() - 1) as f64 * p) as usize] };
    let run_s = cfg.run_ms as f64 / 1000.0;
    let live: Vec<&Node> = nodes.iter().filter(|n| n.alive).collect();
    let mut series = Vec::new();
    let mut prev = air0;
    for (k, b) in bins.iter().enumerate() {
        let a = air_bins.get(k + 1).map_or(prev, |x| x.0);
        series.push(Bin { t_s: k as f64, members: b.2, tree: b.3, delivery: if b.0 > 0 { b.1 as f64 / b.0 as f64 } else { f64::NAN }, airtime: (a - prev) as f64 / 1e6 });
        prev = a;
    }
    // The deepest chain of UWB parent links from the root.
    let uwb_depth = (0..n)
        .filter(|&j| nodes[j].alive)
        .map(|j| {
            let (mut d, mut x, mut guard) = (0u8, j, 0);
            while let Some((p, Radio::Uwb)) = nodes[x].tree.parent {
                d += 1;
                x = p as usize - 1;
                guard += 1;
                if guard > 64 {
                    break;
                }
            }
            d
        })
        .max()
        .unwrap_or(0);
    DistOut {
        delivery: if exp_live > 0 { ok_live as f64 / exp_live as f64 } else { f64::NAN },
        reliable_delivery: if exp_rel > 0 { ok_rel as f64 / exp_rel as f64 } else { f64::NAN },
        lat_p50_ms: pct(0.5),
        lat_p99_ms: pct(0.99),
        wifi_airtime: (air.stats().airtime_us - air0) as f64 / (cfg.run_ms as f64 * 1000.0),
        uwb_util: uwb_busy as f64 / (cfg.run_ms as f64 * 1000.0),
        ctrl_bps: sim.ctrl as f64 / run_s / n as f64,
        relays: live.iter().filter(|n| n.tree.role == Role::Relay).count(),
        max_children: live.iter().map(|n| n.tree.children).max().unwrap_or(0),
        orphans: live.iter().filter(|n| n.tree.role == Role::Orphan).count(),
        parent_changes_per_node_min: live.iter().map(|n| n.tree.stats.parent_changes as f64).sum::<f64>() / live.len() as f64 / (run_s / 60.0),
        repair_s: repair_done.map_or(f64::NAN, |d| d as f64 / 1e6),
        packets_per_update: (n - 1).div_ceil(PER_PACKET),
        uwb_tier: live.iter().filter(|n| n.tree.parent.is_some_and(|p| p.1 == Radio::Uwb)).count(),
        uwb_depth,
        uwb_first: if ok_live + ok_rel > 0 { via_uwb as f64 / (ok_live + ok_rel) as f64 } else { 0.0 },
        evictions_per_node_min: live.iter().map(|n| n.tree.stats.evictions as f64).sum::<f64>() / live.len() as f64 / (run_s / 60.0),
        max_excess: live.iter().map(|x| x.tree.children.saturating_sub(splanc_mesh::tree::advertised_cap(x.tree.class))).max().unwrap_or(0),
        nacks: sim.nacks,
        cache_hits: nodes.iter().map(|x| x.cache.stats.hits as u64).sum(),
        cache_misses: nodes.iter().map(|x| x.cache.stats.misses as u64).sum(),
        nack_age_p90: {
            let mut a = sim.ages.clone();
            a.sort_unstable();
            a.get(a.len().saturating_sub(1) * 9 / 10).copied().unwrap_or(0)
        },
        nack_age_max: sim.ages.iter().copied().max().unwrap_or(0),
        nack_lacking: sim.lacking,
        mode_switches: selector.switches,
        root_children: nodes[0].tree.children,
        tesla_d: sim.signer.as_ref().map_or(0, |s| s.disclose_delay()),
        tesla_chains: if sim.signer.is_some() { sim.chains } else { 0 },
        honest_rejected: sim.honest_rejected,
        forgeries,
        forged_shown: sim.glitches.len() as u64,
        glitch_p50_ms: {
            let mut g = sim.glitches.clone();
            g.sort_by(|a, b| a.partial_cmp(b).unwrap());
            g.get(g.len() / 2).copied().unwrap_or(0.0)
        },
        glitch_max_ms: sim.glitches.iter().cloned().fold(0.0, f64::max),
        forged_screen_share: sim.glitches.iter().sum::<f64>() / 1000.0 / ((n - 1) as f64 * run_s),
        tesla_unsafe: nodes.iter().filter_map(|x| x.tv.as_ref()).map(|v| v.stats.unsafe_late as u64).sum(),
        tesla_hashes_member_s: {
            let v: Vec<f64> = nodes.iter().filter_map(|x| x.tv.as_ref()).map(|v| v.stats.hashes as f64).collect();
            if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 / run_s }
        },
        tesla_hashes_gw_s: sim.signer.as_ref().map_or(0.0, |s| (s.hashes - gw_hashes0) as f64 / ((cfg.warmup_ms + cfg.run_ms) as f64 / 1000.0)),
        update_bytes: HDR + body_len(n - 1, cfg.tesla.is_some()) + ENVELOPE,
        series,
    }
}

/// The cache key of (reliable seq, part): 13 bits of seq, 3 of part.
fn key16(rseq: u16, part: u8) -> u16 {
    rseq.wrapping_mul(8) | (part as u16 & 7)
}

impl Node {
    /// First time this node hands `seq` to its verifier?
    fn tv_fed(&mut self, seq: u16) -> bool {
        self.fed.insert(seq)
    }

    /// The reliable sequence of `seq`, if this node holds it (0 if live or unknown).
    fn cache_rseq(&self, seq: u16) -> u16 {
        self.rseq_of.get(&seq).copied().unwrap_or(0)
    }

    fn tree_mode(&self, seq: u16) -> bool {
        self.mode_of.get(&seq).copied().unwrap_or(false)
    }
}

fn nack(sim: &mut Sim<'_>, nd: &mut Node, rseq: u16, parent: u16, now: i64) {
    // The part that carries this node's MAC entry: members are chunked in id order.
    let me = nd.tree.me as usize - 1;
    let part = (me.saturating_sub(1) / PER_PACKET) as u8;
    let k = key(rseq, part);
    if nd.nacked.get(&k).is_some_and(|t| now - t < 100_000) {
        return;
    }
    nd.nacked.insert(k, now);
    // kind, reliable seq (2), part, requester (2).
    let mut f = vec![KIND_NACK];
    f.extend_from_slice(&rseq.to_be_bytes());
    f.push(part);
    f.extend_from_slice(&nd.tree.me.to_be_bytes());
    f.resize(6 + ENVELOPE, 0);
    sim.ctrl += f.len() as u64;
    sim.nacks += 1;
    let _ = nd.port.send(&f, Some(parent));
}

/// A member's challenge-response with the gateway: the Req left `rtt` ago, the gateway
/// answered half-way.
fn bootstrap(sim: &mut Sim<'_>, i: usize, now: i64, one_way_us: i64) -> Option<(Verifier, u32)> {
    let rtt = if sim.cfg.tesla_adaptive {
        // Twice the delivery latency this member just saw, 2 ms of processing, and queueing.
        2 * one_way_us + 2_000 + (-(1.0 - rnd(&mut sim.rng)).ln() * sim.cfg.tesla_rtt_ms as f64 * 1000.0) as i64
    } else {
        sim.cfg.tesla_rtt_ms * 1000
    };
    let s = sim.signer.as_ref()?;
    let ch = Challenge { session: CTX.session, nonce: i as u64, t0_us: now - rtt };
    let TeslaMsg::Sync(body, mac) = s.sync(now - rtt / 2, CTX.session, i as u16 + 1, i as u64, &PAIRWISE) else { return None };
    Verifier::from_sync(&ch, &body, &mac, &PAIRWISE, i as u16 + 1, CTX.mesh_id).map(|v| (v, rtt as u32))
}

/// Q24: the member's Req carries its best round trip; the gateway raises d when needed.
fn report_rtt(sim: &mut Sim<'_>, nd: &mut Node, rtt: u32) {
    if !sim.cfg.tesla_adaptive {
        return;
    }
    nd.best_rtt = if nd.best_rtt == 0 { rtt } else { nd.best_rtt.min(rtt) };
    sim.rtt_max = sim.rtt_max.max(nd.best_rtt);
    if let Some(s) = sim.signer.as_ref() {
        if tesla::needed_d(nd.best_rtt, s.interval_us()) > s.disclose_delay() {
            sim.rebuild = true;
        }
    }
}

fn on_data(sim: &mut Sim<'_>, nodes: &mut [Node], i: usize, from: usize, f: &[u8], now: i64, via_uwb: bool) {
    let seq = u16::from_be_bytes([f[3], f[4]]);
    let hop = f[5];
    let part = f[6];
    let rseq = u16::from_be_bytes([f[9], f[10]]);
    let tree = f[11] == 1;
    let k = key(seq, part);
    nodes[i].mode_of.insert(seq, tree);
    if rseq != 0 {
        nodes[i].rseq_of.insert(seq, rseq);
    }
    // Delivered by the part (or the repair) that carries this node's MAC entry.
    let covered = if f[0] == KIND_REPAIR { true } else { sim.parts.get(&seq).and_then(|v| v.get(part as usize)).is_some_and(|p| p.contains(&i)) };
    // Every fixture keeps the reliable packets it hears (Q21), first copy only.
    if f[0] == KIND_DATA && nodes[i].seen.insert(k) && rseq != 0 {
        nodes[i].cache.put(key16(rseq, part), f);
    }
    if covered && f[0] == KIND_DATA && sim.auth.contains_key(&seq) {
        // The broadcast authenticator: the first copy goes to the verifier. A genuine update
        // counts as delivered when it is rendered: on arrival (apply-then-verify) or when its
        // key is out (verify-first).
        if nodes[i].seen.contains(&k) && nodes[i].tv_fed(seq) {
            let (a, body) = sim.auth[&seq];
            let one_way = sim.gen_t.get(&seq).map_or(5_000, |t| now - t);
            let chain = sim.signer.as_ref().map(|s| s.chain);
            if nodes[i].tv.as_ref().map(|v| v.chain) != chain {
                let b = bootstrap(sim, i, now, one_way);
                nodes[i].tries = 1;
                nodes[i].last_req = now;
                if let Some((mut v, rtt)) = b {
                    v.early = sim.cfg.tesla_early;
                    nodes[i].tv = Some(v);
                    report_rtt(sim, &mut nodes[i], rtt);
                }
            } else if sim.cfg.tesla_adaptive && nodes[i].tries < tesla::TRIES && now - nodes[i].last_req >= tesla::REQ_RETRY_US {
                // Best-of-N: another challenge; keep the tighter bound.
                if let Some((v2, rtt)) = bootstrap(sim, i, now, one_way) {
                    if let Some(v) = nodes[i].tv.as_mut() {
                        v.rebound(now, &v2);
                    }
                    report_rtt(sim, &mut nodes[i], rtt);
                }
                nodes[i].tries += 1;
                nodes[i].last_req = now;
            }
            let mut out: Vec<(u16, bool)> = Vec::new();
            if let Some(v) = nodes[i].tv.as_mut() {
                v.on_packet(now, seq as u64, 24, &a, &body, &mut |o| match o {
                    Out::Apply { seq, .. } => out.push((seq as u16, true)),
                    Out::Rejected { seq, .. } => out.push((seq as u16, false)),
                });
            }
            for (q, ok) in out {
                let forged = q & 0x8000 != 0;
                if ok && !forged {
                    nodes[i].got.entry(q).or_insert(now);
                }
                // A forged value stays on screen until a newer genuine one or its rejection.
                if let Some((fq, t)) = nodes[i].forged_on {
                    if (ok && !forged) || (!ok && q == fq) {
                        sim.glitches.push((now - t) as f64 / 1000.0);
                        nodes[i].forged_on = None;
                    }
                }
                if ok && forged {
                    if let Some((_, t)) = nodes[i].forged_on.take() {
                        sim.glitches.push((now - t) as f64 / 1000.0);
                    }
                    nodes[i].forged_on = Some((q, now));
                }
                if !ok && !forged {
                    sim.honest_rejected += 1;
                }
            }
        }
    } else if covered && !nodes[i].got.contains_key(&seq) {
        nodes[i].got.insert(seq, now);
        if via_uwb {
            nodes[i].got_uwb.insert(seq);
        }
        if rseq != 0 {
            let missed = nodes[i].tree.got(rseq);
            if let Some((p, _)) = nodes[i].tree.parent {
                for q in missed {
                    nack(sim, &mut nodes[i], q, p, now);
                }
            }
        }
    }
    if f[0] == KIND_REPAIR {
        return;
    }
    let flood = !tree || nodes[i].tree.role == Role::Orphan;
    if flood {
        // Managed flood: the first copy schedules a relay; a copy from someone else cancels it.
        match nodes[i].first_from.get(&k) {
            None => {
                nodes[i].first_from.insert(k, from);
                if hop + 1 < sim.hops && !nodes[i].relayed.contains(&k) {
                    let jitter = ((i as i64 * 7919 + seq as i64 * 104_729 + part as i64 * 31) % 1000) * SLOT_US / 1000;
                    nodes[i].due.insert(k, (now + jitter + SLOT_US, hop + 1));
                }
            }
            Some(&first) if first != from => {
                nodes[i].due.remove(&k);
            }
            _ => {}
        }
        return;
    }
    // Tree: only relays forward, once per (seq, part), on each radio that has children.
    if nodes[i].tree.role != Role::Relay || nodes[i].relayed.contains(&k) || nodes[i].due.contains_key(&k) {
        return;
    }
    let (wifi_kids, uwb_kids) = nodes[i].tree.child_radios();
    if wifi_kids > 0 || !sim.cfg.uwb_multihop || !sim.cfg.uwb[i] {
        let jitter = ((i as i64 * 7919 + seq as i64 * 104_729 + part as i64 * 31) % 1000) * 2;
        nodes[i].due.insert(k, (now + jitter, hop + 1));
    } else {
        nodes[i].relayed.insert(k);
    }
    if sim.cfg.uwb_multihop && sim.cfg.uwb[i] && uwb_kids > 0 && nodes[i].uwb_sent.insert(k) {
        let mut u = f.to_vec();
        u[5] = hop + 1;
        u[7..9].copy_from_slice(&(i as u16 + 1).to_be_bytes());
        if !via_uwb {
            u.truncate(u.len().saturating_sub(ENVELOPE));
        }
        nodes[i].uwb_out.push_back(u);
    }
}

fn pos(air: &Air, i: usize) -> (f64, f64) {
    let m = air.0.borrow();
    (m.st[i].place.x_m, m.st[i].place.y_m)
}

fn extent(p: &[(f64, f64)]) -> (f64, f64) {
    let w = p.iter().map(|x| x.0).fold(1.0, f64::max);
    let h = p.iter().map(|x| x.1).fold(1.0, f64::max);
    (w, h)
}

/// Hops across the mesh over good 802.11 links (BFS from every node).
fn diameter(air: &Air, n: usize) -> u8 {
    let m = air.0.borrow();
    let good = |a: usize, b: usize| m.rssi(a, b).is_some_and(|r| r >= Rate::Ofdm6.sensitivity_dbm() + 6.0);
    let mut d = 1u8;
    for s in 0..n {
        let mut dist = vec![u8::MAX; n];
        dist[s] = 0;
        let mut q = VecDeque::from([s]);
        while let Some(a) = q.pop_front() {
            for b in 0..n {
                if dist[b] == u8::MAX && good(a, b) {
                    dist[b] = dist[a] + 1;
                    d = d.max(dist[b]);
                    q.push_back(b);
                }
            }
        }
    }
    d.min(15)
}
