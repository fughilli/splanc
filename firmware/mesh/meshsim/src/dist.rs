//! Distribution: the managed flood vs the two-tier tree (design §5.8), packet level.
//!
//! Every node runs either the swarm's managed flood (relay once after an RSSI-weighted delay,
//! cancel on hearing a duplicate, adaptive hop limit) or the tree ([`splanc_mesh::tree`]):
//! the root sends each packet on UWB to its UWB children and on 802.11 to the rest, relays
//! rebroadcast once on 802.11, leaves never relay, orphans flood, and a node that sees a gap
//! (a later sequence, or its parent's advert) asks its parent (then any neighbour) for the
//! missing packets.
//!
//! 802.11 is [`Air`] (CSMA, collisions, capture, per-node adaptive rate, walking people). UWB
//! is a DW3000-class TDMA medium: 6.8 Mb/s, 80-byte frame payload (a packet is fragmented;
//! every fragment must arrive), data slots for the root every 4 ms, one beacon slot per node
//! per second, a link budget with its own enclosure loss and shadowing, no contention.
//!
//! Both schemes carry the same packets (a live update with per-receiver MACs: 13 B + 8 B per
//! member + the body, split at 19 recipients per packet). Security semantics are unchanged by
//! the tree: it only decides who forwards.

use std::collections::{HashMap, HashSet, VecDeque};

use splanc_mesh::msg::Class;
use splanc_mesh::tree::{Radio, Role, Tree, TreeAd};

use super::{Air, Placement, RadioModel, Rate, SimPort, MTU};
use splanc_mesh::backhaul::Backhaul;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scheme {
    Flood,
    Tree,
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
    /// Tree packets carry every member's MAC entry (any overheard copy delivers; only relays
    /// forward) instead of just the forwarder's subtree.
    pub full_macs: bool,
    pub wifi_enclosure_db: f64,
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
    pub repaired: u64,
    pub packets_per_update: usize,
    pub uwb_tier: usize,
    /// Per node per minute: switches by hysteresis, and parent losses by cause.
    pub switches_per_node_min: f64,
    pub lost_silent: u32,
    pub lost_no_route: u32,
    pub lost_evicted: u32,
    pub evictions_per_node_min: f64,
    /// End of run: nodes whose children exceed their advertised cap, the worst excess, and
    /// the time-average share of samples (each second) with any node over cap.
    pub over_cap_nodes: usize,
    pub max_excess: u8,
    pub over_cap_share: f64,
}

const KIND_DATA: u8 = 1;
const KIND_AD: u8 = 2;
const KIND_NACK: u8 = 3;
const KIND_REPAIR: u8 = 4;
const ENVELOPE: usize = 22;
const UWB_PAYLOAD: usize = 80;
const UWB_FRAME_US: i64 = 210; // preamble + PHR + 80 B at 6.8 Mb/s
const UWB_DATA_EVERY_US: i64 = 4_000;
const SLOT_US: i64 = 5_000;
const DEADLINE_US: i64 = 500_000;
const CACHE: usize = 16;

fn rnd(s: &mut u64) -> f64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    (*s >> 11) as f64 / (1u64 << 53) as f64
}

struct Node {
    port: SimPort,
    tree: Tree,
    /// seq -> first arrival (global µs).
    got: HashMap<u16, i64>,
    /// Flood relays pending: seq -> due time.
    flood_due: HashMap<u16, (i64, u8)>,
    relayed: HashSet<u16>,
    cache: VecDeque<(u16, Vec<u8>)>,
    next_ad: i64,
    next_window: i64,
    alive: bool,
    waypoint: Option<(f64, f64)>,
    nacked: HashMap<u16, i64>,
    /// Flood: the first sender heard per sequence (a copy from anyone else is a duplicate).
    first_from: HashMap<u16, usize>,
}

struct Uwb {
    /// Frames to deliver at a time: (when, from, bytes).
    q: Vec<(i64, usize, Vec<u8>)>,
    busy_us: i64,
    shadow: Vec<Vec<i64>>,
}

/// The UWB link budget (dBm) from `a` to `b`: −14 dBm EIRP (−41.3 dBm/MHz over 500 MHz),
/// free space at 6.5 GHz (48.7 dB at 1 m, exponent 2 line of sight), the antennas' enclosure
/// losses, 10 dB while someone stands in the path.
fn uwb_rx(cfg: &DistCfg, a: (f64, f64), b: (f64, f64), shadowed: bool) -> f64 {
    let d = ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt().max(0.3);
    -14.0 - (48.7 + 20.0 * d.log10()) - 2.0 * cfg.uwb_enclosure_db - if shadowed { 10.0 } else { 0.0 }
}

const UWB_SENS: f64 = -94.0;

/// Recipients per packet: the per-receiver MAC entries one 802.11 packet carries (§7.9).
const PER_PACKET: usize = 19;

/// Frame: kind, origin (2), seq (2), hop, part, forwarder (2), reliable seq (2), then the
/// packet body (sized by its recipients).
fn frame(kind: u8, seq: u16, hop: u8, part: u8, fwd: u16, rseq: u16, recipients: usize) -> Vec<u8> {
    let body = 13 + 8 * recipients + 12;
    let mut f = vec![0u8; (11 + body + ENVELOPE).min(MTU)];
    f[0] = kind;
    f[1..3].copy_from_slice(&1u16.to_be_bytes());
    f[3..5].copy_from_slice(&seq.to_be_bytes());
    f[5] = hop;
    f[6] = part;
    f[7..9].copy_from_slice(&fwd.to_be_bytes());
    f[9..11].copy_from_slice(&rseq.to_be_bytes());
    f
}

/// The descendants of `i` in the current tree, grouped by child subtree (DFS order), then cut
/// into packets of ≤ 19 recipients at subtree boundaries where possible.
fn parts_for(nodes: &[Node], i: usize, only_radio: Option<Radio>) -> Vec<Vec<usize>> {
    let n = nodes.len();
    let kids = |p: usize| -> Vec<usize> { (0..n).filter(|&j| nodes[j].alive && nodes[j].tree.parent.is_some_and(|(q, _)| q as usize == p + 1)).collect() };
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for c in kids(i) {
        if let Some(r) = only_radio {
            if nodes[c].tree.parent.map(|p| p.1) != Some(r) {
                continue;
            }
        }
        let mut g = Vec::new();
        let mut stack = vec![c];
        let mut seen = HashSet::new();
        while let Some(x) = stack.pop() {
            if !seen.insert(x) || g.len() > 256 {
                continue;
            }
            g.push(x);
            stack.extend(kids(x));
        }
        groups.push(g);
    }
    let mut parts: Vec<Vec<usize>> = Vec::new();
    let mut cur: Vec<usize> = Vec::new();
    for g in groups {
        if cur.len() + g.len() > PER_PACKET && !cur.is_empty() {
            parts.push(std::mem::take(&mut cur));
        }
        for x in g {
            if cur.len() == PER_PACKET {
                parts.push(std::mem::take(&mut cur));
            }
            cur.push(x);
        }
    }
    if !cur.is_empty() {
        parts.push(cur);
    }
    parts
}

struct Sim<'a> {
    cfg: &'a DistCfg,
    /// (seq, forwarder, part) -> the recipients whose MAC entries the packet carries.
    cover: HashMap<(u16, u16, u8), Vec<usize>>,
    ctrl: u64,
    repaired: u64,
    hops: u8,
}

/// Run one configuration.
#[allow(clippy::needless_range_loop)] // nodes, positions and the UWB matrix share the index
pub fn run(cfg: &DistCfg) -> DistOut {
    let n = cfg.positions.len();
    let model = RadioModel { rate: Rate::Ofdm6, adaptive: cfg.adaptive_rate, walking: cfg.walking, ..RadioModel::default() };
    let air = Air::new(model, cfg.seed);
    let mut s = cfg.seed ^ 0x77;
    let mut nodes: Vec<Node> = (0..n)
        .map(|i| {
            let mut p = Placement::at(cfg.positions[i].0, cfg.positions[i].1);
            p.enclosure_db = cfg.wifi_enclosure_db;
            p.clock_offset_us = (rnd(&mut s) * 2e5) as i64;
            let idx = air.add(i as u16 + 1, p);
            air.0.borrow_mut().st[idx].online = true;
            let mut tree = Tree::new(i as u16 + 1, cfg.uwb[i], cfg.class[i]);
            tree.pos = Some(((cfg.positions[i].0 * 10.0) as i16, (cfg.positions[i].1 * 10.0) as i16));
            Node {
                port: SimPort { air: air.clone(), index: idx },
                tree,
                got: HashMap::new(),
                flood_due: HashMap::new(),
                relayed: HashSet::new(),
                cache: VecDeque::new(),
                next_ad: (rnd(&mut s) * 1e6) as i64,
                next_window: 1_000_000 + (rnd(&mut s) * 1e6) as i64,
                alive: true,
                waypoint: None,
                nacked: HashMap::new(),
                first_from: HashMap::new(),
            }
        })
        .collect();
    air.set_loss(cfg.loss);
    nodes[0].tree.set_root(Some(1), 1);
    let movers: Vec<usize> = (1..n).filter(|_| rnd(&mut s) < cfg.moving).collect();
    let mut uwb = Uwb { q: Vec::new(), busy_us: 0, shadow: vec![vec![0; n]; n] };
    let mut sim = Sim { cfg, cover: HashMap::new(), ctrl: 0, repaired: 0, hops: diameter(&air, n) + 1 };
    let flood_parts: Vec<Vec<usize>> = (1..n).collect::<Vec<_>>().chunks(PER_PACKET).map(|c| c.to_vec()).collect();
    let mut seq: u16 = 0;
    let mut rseq: u16 = 0;
    let mut gen: Vec<(u16, i64, bool)> = Vec::new();
    let mut killed: Option<(usize, Vec<usize>, i64)> = None;
    let mut repair_done: Option<i64> = None;
    let mut buf = [0u8; 512];
    let t_end = (cfg.warmup_ms + cfg.run_ms) * 1000;
    let mut air0 = 0i64;
    let mut next_uwb_data = 0i64;
    let mut uwb_outbox: VecDeque<(Vec<u8>, usize)> = VecDeque::new();
    let mut updates = 0u64;
    let (mut over_samples, mut over_hits) = (0u64, 0u64);
    let mut now = 0i64;
    while now < t_end {
        now += 1_000;
        air.0.borrow_mut().advance(now);
        if now == cfg.warmup_ms * 1000 {
            air0 = air.stats().airtime_us;
            uwb.busy_us = 0;
            sim.ctrl = 0;
            sim.repaired = 0;
            for nd in nodes.iter_mut() {
                nd.tree.stats = Default::default();
            }
        }
        if cfg.walking && now % 500_000 == 0 {
            for a in 0..n {
                for b in a + 1..n {
                    if rnd(&mut s) < 0.03 {
                        let until = now + 1_000_000 + (rnd(&mut s) * 2e6) as i64;
                        uwb.shadow[a][b] = until;
                        uwb.shadow[b][a] = until;
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
            if now == (cfg.warmup_ms + k) * 1000 && cfg.scheme == Scheme::Tree {
                let victim = (1..n).filter(|&i| nodes[i].alive).max_by_key(|&i| nodes[i].tree.children).unwrap_or(1);
                let kids: Vec<usize> = (0..n).filter(|&j| nodes[j].tree.parent.is_some_and(|p| p.0 as usize == victim + 1)).collect();
                nodes[victim].alive = false;
                air.0.borrow_mut().st[victim].online = false;
                killed = Some((victim, kids, now));
            }
        }
        // DAO: every relay reports its children to the root every 5 s (2 hops, 4 + 2 B each).
        if cfg.scheme == Scheme::Tree && now % 5_000_000 == 0 {
            for nd in nodes.iter().filter(|x| x.alive && x.tree.role == Role::Relay) {
                sim.ctrl += 2 * (4 + 2 * nd.tree.children as u64 + ENVELOPE as u64);
            }
        }
        // Generate an update (one reliable command per second, the rest live).
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
            gen.push((seq, now, reliable));
            nodes[0].got.insert(seq, now);
            if reliable {
                nodes[0].tree.seq = r;
            }
            match cfg.scheme {
                Scheme::Flood => {
                    for (k, p) in flood_parts.iter().enumerate() {
                        let f = frame(KIND_DATA, seq, 0, k as u8, 0xFFFF, r, p.len());
                        sim.cover.insert((seq, 0xFFFF, k as u8), p.clone());
                        cache_put(&mut nodes[0].cache, seq, &f);
                        let _ = nodes[0].port.send(&f, None);
                    }
                }
                Scheme::Tree => {
                    // UWB: one broadcast with the MAC entries of every UWB child's subtree.
                    if cfg.uwb[0] {
                        let all: Vec<usize> = if cfg.full_macs { (1..n).collect() } else { parts_for(&nodes, 0, Some(Radio::Uwb)).concat() };
                        if !all.is_empty() {
                            let f = frame(KIND_DATA, seq, 0, 0, 1, r, all.len());
                            let mut f = f;
                            f.truncate(11 + 13 + 8 * all.len() + 12); // UWB carries no 802.11 envelope
                            sim.cover.insert((seq, 1, 0), all);
                            uwb_outbox.push_back((f, 0));
                        }
                    }
                    // 802.11: the root's own 802.11 children's subtrees.
                    let wifi_parts = if cfg.full_macs { flood_parts.clone() } else { parts_for(&nodes, 0, Some(Radio::Wifi)) };
                    for (k, p) in wifi_parts.into_iter().enumerate() {
                        let f = frame(KIND_DATA, seq, 0, k as u8 + 1, 1, r, p.len());
                        sim.cover.insert((seq, 1, k as u8 + 1), p);
                        if reliable {
                            cache_put(&mut nodes[0].cache, r, &f);
                        }
                        let _ = nodes[0].port.send(&f, None);
                    }
                }
            }
        }
        // UWB: the root's data slot every 4 ms, up to 3 frames of 80 B (all fragments needed).
        if cfg.scheme == Scheme::Tree && now >= next_uwb_data {
            next_uwb_data = now + UWB_DATA_EVERY_US;
            let mut frames = 0;
            while let Some((f, _)) = uwb_outbox.front() {
                let frags = f.len().div_ceil(UWB_PAYLOAD);
                if frames + frags > 3 && frames > 0 {
                    break;
                }
                frames += frags;
                let (f, _) = uwb_outbox.pop_front().unwrap();
                let at = now + frags as i64 * UWB_FRAME_US;
                uwb.busy_us += frags as i64 * UWB_FRAME_US;
                for j in 1..n {
                    if !cfg.uwb[j] || !nodes[j].alive {
                        continue;
                    }
                    let rx = uwb_rx(cfg, pos(&air, 0), pos(&air, j), uwb.shadow[0][j] > now);
                    let p_ok = if rx >= UWB_SENS + 3.0 { 0.98 } else if rx >= UWB_SENS { 0.7 } else { 0.0 };
                    if (0..frags).all(|_| rnd(&mut s) < p_ok) {
                        uwb.q.push((at, j, f.clone()));
                    }
                }
            }
        }
        if cfg.scheme == Scheme::Tree && now % 1_000_000 == 0 {
            for i in 0..n {
                if !cfg.uwb[i] || !nodes[i].alive {
                    continue;
                }
                let ad = nodes[i].tree.ad();
                uwb.busy_us += UWB_FRAME_US;
                sim.ctrl += TreeAd::LEN as u64;
                for j in 0..n {
                    if j == i || !cfg.uwb[j] || !nodes[j].alive {
                        continue;
                    }
                    let rx = uwb_rx(cfg, pos(&air, i), pos(&air, j), uwb.shadow[i][j] > now);
                    let p_ok = if rx >= UWB_SENS + 3.0 { 0.98 } else if rx >= UWB_SENS { 0.7 } else { 0.0 };
                    if rnd(&mut s) < p_ok {
                        let p = pos(&air, i);
                        nodes[j].tree.heard(now, i as u16 + 1, Radio::Uwb, &ad, Some(((p.0 * 10.0) as i16, (p.1 * 10.0) as i16)));
                    }
                }
            }
        }
        let due: Vec<(i64, usize, Vec<u8>)> = {
            let (d, keep): (Vec<_>, Vec<_>) = uwb.q.drain(..).partition(|x| x.0 <= now);
            uwb.q = keep;
            d
        };
        for (_, j, f) in due {
            on_data(&mut sim, &mut nodes, j, 0, &f, now);
        }
        for i in 0..n {
            if !nodes[i].alive {
                continue;
            }
            while let Some(meta) = nodes[i].port.recv(&mut buf) {
                let f = buf[..meta.len].to_vec();
                let src = (u16::from_be_bytes([meta.src_mac[4], meta.src_mac[5]]) as usize).saturating_sub(1);
                match f[0] {
                    KIND_AD if cfg.scheme == Scheme::Tree => {
                        if let Some(ad) = TreeAd::decode(&f[1..1 + TreeAd::LEN]) {
                            let x = i16::from_be_bytes([f[13], f[14]]);
                            let y = i16::from_be_bytes([f[15], f[16]]);
                            nodes[i].tree.heard(now, src as u16 + 1, Radio::Wifi, &ad, Some((x, y)));
                            // The parent has a reliable packet we lack: ask for it.
                            if nodes[i].tree.parent.is_some_and(|p| p.0 as usize == src + 1) {
                                let mine = nodes[i].tree.seq;
                                let gap = ad.seq.wrapping_sub(mine);
                                if gap > 0 && gap < 5 {
                                    for q in 1..=gap {
                                        nack(&mut nodes[i], mine.wrapping_add(q), src as u16 + 1, now, &mut sim.ctrl);
                                    }
                                }
                            }
                        }
                    }
                    KIND_DATA | KIND_REPAIR => on_data(&mut sim, &mut nodes, i, src, &f, now),
                    KIND_NACK => {
                        let want = u16::from_be_bytes([f[1], f[2]]);
                        if let Some((_, fr)) = nodes[i].cache.iter().find(|(q, _)| *q == want) {
                            let mut r = fr.clone();
                            r[0] = KIND_REPAIR;
                            let dst = u16::from_be_bytes([f[3], f[4]]);
                            // A repair carries just the requester's entry.
                            let seq = u16::from_be_bytes([r[3], r[4]]);
                            r[7..9].copy_from_slice(&(0x8000 | dst).to_be_bytes());
                            r.truncate(11 + 13 + 8 + 12 + ENVELOPE);
                            sim.cover.insert((seq, 0x8000 | dst, r[6]), vec![dst as usize - 1]);
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
                let mut tb = [0u8; 12];
                nodes[i].tree.ad().encode(&mut tb);
                a.extend_from_slice(&tb);
                a.extend_from_slice(&((p.0 * 10.0) as i16).to_be_bytes());
                a.extend_from_slice(&((p.1 * 10.0) as i16).to_be_bytes());
                a.resize(14 + ENVELOPE, 0);
                if cfg.scheme == Scheme::Tree {
                    sim.ctrl += (TreeAd::LEN + 4) as u64;
                }
                let _ = nodes[i].port.send(&a, None);
            }
            if now >= nodes[i].next_window {
                nodes[i].next_window = now + 1_000_000;
                let uwb_expected = if cfg.uwb[i] && cfg.scheme == Scheme::Tree { 1 } else { 0 };
                nodes[i].tree.window(1, uwb_expected);
                nodes[i].tree.decide(now);
            }
            let due: Vec<u16> = nodes[i].flood_due.iter().filter(|(_, (t, _))| *t <= now).map(|(q, _)| *q).collect();
            for q in due {
                let (_, h) = nodes[i].flood_due.remove(&q).unwrap();
                nodes[i].relayed.insert(q);
                match cfg.scheme {
                    Scheme::Flood => {
                        for (k, p) in flood_parts.iter().enumerate() {
                            let _ = p;
                            let f = frame(KIND_DATA, q, h, k as u8, 0xFFFF, 0, flood_parts[k].len());
                            let _ = nodes[i].port.send(&f, None);
                        }
                    }
                    Scheme::Tree => {
                        // A relay: its own subtree's entries only.
                        let me = i as u16 + 1;
                        let r = nodes[i].cache.iter().find(|(x, _)| *x == q).map_or(0, |(_, fr)| u16::from_be_bytes([fr[9], fr[10]]));
                        let orphan = nodes[i].tree.role == Role::Orphan;
                        let parts = if orphan || cfg.full_macs { flood_parts.clone() } else { parts_for(&nodes, i, None) };
                        for (k, p) in parts.into_iter().enumerate() {
                            let fwd = if orphan { 0xFFFF } else { me };
                            let f = frame(KIND_DATA, q, h, k as u8, fwd, r, p.len());
                            if !orphan {
                                sim.cover.insert((q, me, k as u8), p);
                            }
                            if r != 0 {
                                cache_put(&mut nodes[i].cache, r, &f);
                            }
                            let _ = nodes[i].port.send(&f, None);
                        }
                    }
                }
            }
        }
        if cfg.scheme == Scheme::Tree && now > cfg.warmup_ms * 1000 && now % 1_000_000 == 0 {
            over_samples += 1;
            if nodes.iter().any(|x| x.alive && x.tree.children > splanc_mesh::tree::advertised_cap(x.tree.class)) {
                over_hits += 1;
            }
        }
        if let (Some((victim, kids, at)), None) = (&killed, repair_done) {
            let ok = kids.iter().all(|&j| {
                let has_parent = nodes[j].tree.parent.is_some_and(|p| p.0 as usize != victim + 1);
                let recent = gen.iter().rev().take(5).any(|(q, t, _)| *t > *at && nodes[j].got.get(q).is_some_and(|r| r - t < 100_000));
                has_parent && recent
            });
            if ok {
                repair_done = Some(now - at);
            }
        }
    }
    let mut lat = Vec::new();
    let (mut exp_live, mut ok_live, mut exp_rel, mut ok_rel) = (0u64, 0u64, 0u64, 0u64);
    for (q, t, rel) in &gen {
        if *t > t_end - DEADLINE_US {
            continue;
        }
        for (j, nd) in nodes.iter().enumerate() {
            if j == 0 || !nd.alive {
                continue;
            }
            let hit = nd.got.get(q).is_some_and(|r| r - t <= if *rel { 2 * DEADLINE_US } else { DEADLINE_US });
            if *rel {
                exp_rel += 1;
                ok_rel += hit as u64;
            } else {
                exp_live += 1;
                ok_live += hit as u64;
            }
            if hit {
                lat.push((nd.got[q] - t) as f64 / 1000.0);
            }
        }
    }
    lat.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pct = |p: f64| if lat.is_empty() { f64::NAN } else { lat[((lat.len() - 1) as f64 * p) as usize] };
    let run_s = cfg.run_ms as f64 / 1000.0;
    let live: Vec<&Node> = nodes.iter().filter(|n| n.alive).collect();
    DistOut {
        delivery: if exp_live > 0 { ok_live as f64 / exp_live as f64 } else { f64::NAN },
        reliable_delivery: if exp_rel > 0 { ok_rel as f64 / exp_rel as f64 } else { f64::NAN },
        lat_p50_ms: pct(0.5),
        lat_p99_ms: pct(0.99),
        wifi_airtime: (air.stats().airtime_us - air0) as f64 / (cfg.run_ms as f64 * 1000.0),
        uwb_util: uwb.busy_us as f64 / (cfg.run_ms as f64 * 1000.0),
        ctrl_bps: sim.ctrl as f64 / run_s / n as f64,
        relays: live.iter().filter(|n| n.tree.role == Role::Relay).count(),
        max_children: live.iter().map(|n| n.tree.children).max().unwrap_or(0),
        orphans: if cfg.scheme == Scheme::Tree { live.iter().filter(|n| n.tree.role == Role::Orphan).count() } else { 0 },
        parent_changes_per_node_min: live.iter().map(|n| n.tree.stats.parent_changes as f64).sum::<f64>() / live.len() as f64 / (run_s / 60.0),
        repair_s: repair_done.map_or(f64::NAN, |d| d as f64 / 1e6),
        repaired: sim.repaired,
        packets_per_update: flood_parts.len(),
        uwb_tier: live.iter().filter(|n| n.tree.parent.is_some_and(|p| p.1 == Radio::Uwb)).count(),
        switches_per_node_min: live.iter().map(|n| (n.tree.stats.parent_changes - n.tree.stats.local_repairs.min(n.tree.stats.parent_changes)) as f64).sum::<f64>() / live.len() as f64 / (run_s / 60.0),
        lost_silent: live.iter().map(|n| n.tree.stats.lost_silent).sum(),
        lost_no_route: live.iter().map(|n| n.tree.stats.lost_no_route).sum(),
        lost_evicted: live.iter().map(|n| n.tree.stats.lost_evicted).sum(),
        over_cap_nodes: live.iter().filter(|x| x.tree.children > splanc_mesh::tree::advertised_cap(x.tree.class)).count(),
        max_excess: live.iter().map(|x| x.tree.children.saturating_sub(splanc_mesh::tree::advertised_cap(x.tree.class))).max().unwrap_or(0),
        over_cap_share: if over_samples > 0 { over_hits as f64 / over_samples as f64 } else { 0.0 },
        evictions_per_node_min: live.iter().map(|n| n.tree.stats.evictions as f64).sum::<f64>() / live.len() as f64 / (run_s / 60.0),
    }
}

fn cache_put(c: &mut VecDeque<(u16, Vec<u8>)>, seq: u16, f: &[u8]) {
    if c.len() >= CACHE {
        c.pop_front();
    }
    c.push_back((seq, f.to_vec()));
}

fn nack(nd: &mut Node, rseq: u16, parent: u16, now: i64, ctrl: &mut u64) {
    if nd.nacked.get(&rseq).is_some_and(|t| now - t < 100_000) {
        return;
    }
    nd.nacked.insert(rseq, now);
    let mut f = vec![KIND_NACK, 0, 0, 0, 0];
    f[1..3].copy_from_slice(&rseq.to_be_bytes());
    f[3..5].copy_from_slice(&nd.tree.me.to_be_bytes());
    f.resize(5 + ENVELOPE, 0);
    *ctrl += f.len() as u64;
    let _ = nd.port.send(&f, Some(parent));
}

fn on_data(sim: &mut Sim<'_>, nodes: &mut [Node], i: usize, from: usize, f: &[u8], now: i64) {
    let seq = u16::from_be_bytes([f[3], f[4]]);
    let hop = f[5];
    let part = f[6];
    let fwd = u16::from_be_bytes([f[7], f[8]]);
    let rseq = u16::from_be_bytes([f[9], f[10]]);
    // Delivered only by a packet that carries this node's MAC entry.
    let covered = sim.cover.get(&(seq, fwd, part)).is_some_and(|v| v.contains(&i));
    if f[0] == KIND_REPAIR && covered && !nodes[i].got.contains_key(&seq) {
        sim.repaired += 1;
    }
    if covered && !nodes[i].got.contains_key(&seq) {
        nodes[i].got.insert(seq, now);
        if rseq != 0 {
            cache_put(&mut nodes[i].cache, rseq, f);
            let missed = nodes[i].tree.got(rseq);
            if let Some((p, _)) = nodes[i].tree.parent {
                for q in missed {
                    nack(&mut nodes[i], q, p, now, &mut sim.ctrl);
                }
            }
        }
    }
    if f[0] == KIND_REPAIR {
        return;
    }
    let flood = sim.cfg.scheme == Scheme::Flood || nodes[i].tree.role == Role::Orphan || fwd == 0xFFFF;
    if flood {
        // Managed flood: the first copy schedules a relay; a copy from someone else cancels it.
        match nodes[i].first_from.get(&seq) {
            None => {
                nodes[i].first_from.insert(seq, from);
                if hop + 1 < sim.hops && !nodes[i].relayed.contains(&seq) {
                    let jitter = ((i as i64 * 7919 + seq as i64 * 104_729) % 1000) * SLOT_US / 1000;
                    nodes[i].flood_due.insert(seq, (now + jitter + SLOT_US, hop + 1));
                }
            }
            Some(&first) if first != from => {
                nodes[i].flood_due.remove(&seq);
            }
            _ => {}
        }
        return;
    }
    if covered && nodes[i].tree.role == Role::Relay && !nodes[i].relayed.contains(&seq) && !nodes[i].flood_due.contains_key(&seq) {
        let jitter = ((i as i64 * 7919 + seq as i64 * 104_729) % 1000) * 2;
        nodes[i].flood_due.insert(seq, (now + jitter, hop + 1));
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
