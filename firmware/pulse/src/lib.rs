//! Topology-aware effect engine (design doc §7.8 / Phase G): a STATEFUL graph
//! simulation that drives effects along the fixture's physical shape.
//!
//! The graph comes from the extracted topology (segments joined at branch
//! points, with free ends = termini). Two effects:
//!
//! - **Pulse**: comets spawn at a terminus and travel the graph. At a junction
//!   a pulse picks a random outgoing segment (never back the way it came) and
//!   may split into two independent pulses; at a terminus it despawns. A
//!   lead-in / lead-out envelope ramps each pulse smoothly out of and back into
//!   black so it never pops. Per LED, brightness is the r² point-source falloff
//!   over the true 3D distance (along-segment Δs + perpendicular d_perp).
//! - **Flood**: a wavefront leaves a terminus and propagates outward by GEODESIC
//!   graph distance, lighting each LED as it arrives then decaying behind it;
//!   once everything has faded a new flood starts from a fresh terminus. (On a
//!   tree there are no cycles, so no swirl yet — that needs cycle-preserving
//!   extraction; the geodesic model already handles it when it lands.)
//!
//! Integer / fixed-point throughout (no hardware f64 on the C6); a small seeded
//! xorshift PRNG makes the randomness deterministic and replayable. Bounded, no
//! alloc — the whole sim lives in fixed arrays. Stepped once per frame by the
//! player, then queried per LED.

#![no_std]

pub type Rgb = (u8, u8, u8);

pub const MAX_SEGMENTS: usize = 48;
pub const MAX_NODES: usize = 64;
pub const MAX_PULSES: usize = 24;
pub const MAX_PALETTE: usize = 8;
/// Max segments meeting at one node (junction fan-out).
pub const MAX_INCIDENT: usize = 6;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Effect {
    Pulse,
    Flood,
}

#[derive(Clone, Copy)]
pub struct EffectConfig {
    pub effect: Effect,
    /// Global brightness scale, Q8 (256 == full).
    pub intensity_q8: u16,
    /// Travel speed, mm/s (pulse agents / flood wavefront).
    pub speed_mm_s: u32,
    /// r² point-source / wavefront glow radius, mm.
    pub glow_radius_mm: u32,
    /// Lead-in/out ramp distance at termini, mm (pulse).
    pub lead_mm: u32,
    /// Probability, Q8, that a pulse SPLITS at a junction.
    pub split_q8: u16,
    /// Time between pulse spawns, ms.
    pub spawn_interval_ms: u32,
    /// Flood: fade length behind the wavefront, mm.
    pub decay_mm: u32,
    pub palette: [Rgb; MAX_PALETTE],
    pub palette_len: usize,
}

impl EffectConfig {
    fn palette_at(&self, i: u32) -> Rgb {
        if self.palette_len == 0 {
            (255, 255, 255)
        } else {
            self.palette[(i as usize) % self.palette_len]
        }
    }
}

// -- graph ------------------------------------------------------------------

#[derive(Clone, Copy, Default)]
struct Seg {
    len_mm: u32,
    node_a: u16,
    node_b: u16,
}

#[derive(Clone, Copy)]
struct Node {
    inc_seg: [u16; MAX_INCIDENT],
    degree: u8,
}
impl Default for Node {
    fn default() -> Self {
        Node { inc_seg: [0; MAX_INCIDENT], degree: 0 }
    }
}

pub struct Graph {
    segs: [Seg; MAX_SEGMENTS],
    n_segs: usize,
    nodes: [Node; MAX_NODES],
    n_nodes: usize,
    termini: [u16; MAX_NODES],
    n_termini: usize,
}

impl Graph {
    /// Build from topology segments `(a, b, length_mm)` — a/b are branch-point
    /// ids (≥0) or -1 for a free end (each free end is its own terminus node).
    pub fn build(segs_ab_len: &[(i32, i32, u32)]) -> Graph {
        let n = segs_ab_len.len().min(MAX_SEGMENTS);
        let mut max_branch: i32 = -1;
        for &(a, b, _) in &segs_ab_len[..n] {
            max_branch = max_branch.max(a).max(b);
        }
        let mut next_leaf = (max_branch + 1).max(0) as u16;
        let mut segs = [Seg::default(); MAX_SEGMENTS];
        let mut nodes = [Node::default(); MAX_NODES];
        let mut n_nodes = next_leaf as usize;
        let resolve = |v: i32, next_leaf: &mut u16, n_nodes: &mut usize| -> u16 {
            if v >= 0 {
                v as u16
            } else {
                let id = *next_leaf;
                *next_leaf += 1;
                *n_nodes = (*n_nodes).max(id as usize + 1);
                id
            }
        };
        for (i, &(a, b, len)) in segs_ab_len[..n].iter().enumerate() {
            let na = resolve(a, &mut next_leaf, &mut n_nodes);
            let nb = resolve(b, &mut next_leaf, &mut n_nodes);
            segs[i] = Seg { len_mm: len, node_a: na, node_b: nb };
            for nd in [na, nb] {
                if (nd as usize) < MAX_NODES {
                    let node = &mut nodes[nd as usize];
                    if (node.degree as usize) < MAX_INCIDENT {
                        node.inc_seg[node.degree as usize] = i as u16;
                        node.degree += 1;
                    }
                }
            }
        }
        n_nodes = n_nodes.min(MAX_NODES);
        let mut termini = [0u16; MAX_NODES];
        let mut n_termini = 0;
        for nd in 0..n_nodes {
            if nodes[nd].degree == 1 && n_termini < MAX_NODES {
                termini[n_termini] = nd as u16;
                n_termini += 1;
            }
        }
        Graph { segs, n_segs: n, nodes, n_nodes, termini, n_termini }
    }

    fn is_terminus(&self, node: u16) -> bool {
        self.nodes[node as usize].degree <= 1
    }

    /// The segment id joining `node`, other than `except`, chosen by `pick`
    /// among the eligible ones. Returns (seg, count-of-eligible).
    fn choose(&self, node: u16, except: u16, pick: u32) -> Option<(u16, usize)> {
        let nd = &self.nodes[node as usize];
        let mut elig: [u16; MAX_INCIDENT] = [0; MAX_INCIDENT];
        let mut m = 0;
        for i in 0..nd.degree as usize {
            if nd.inc_seg[i] != except {
                elig[m] = nd.inc_seg[i];
                m += 1;
            }
        }
        if m == 0 {
            None
        } else {
            Some((elig[(pick as usize) % m], m))
        }
    }
}

// -- simulation -------------------------------------------------------------

#[derive(Clone, Copy, Default)]
struct Pulse {
    alive: bool,
    seg: u16,
    /// Position along the segment, mm from node_a.
    pos_mm: u32,
    /// Travel direction: true = a→b (pos increasing).
    fwd: bool,
    /// Distance traveled since spawn (for the lead-in ramp), mm.
    traveled_mm: u32,
    color: u32,
}

pub struct Sim {
    graph: Graph,
    cfg: EffectConfig,
    rng: u32,
    time_ms: u64,
    // pulse
    pulses: [Pulse; MAX_PULSES],
    spawn_accum_ms: u32,
    // flood: geodesic distance from the source to each node + the wavefront.
    node_dist: [u32; MAX_NODES],
    flood_front_mm: u32,
    flood_max_mm: u32,
}

fn rng_next(s: &mut u32) -> u32 {
    let mut x = *s;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *s = x;
    x
}

impl Sim {
    pub fn new(graph: Graph, cfg: EffectConfig, seed: u32) -> Sim {
        let mut sim = Sim {
            graph,
            cfg,
            rng: if seed == 0 { 0x9E3779B9 } else { seed },
            time_ms: 0,
            pulses: [Pulse::default(); MAX_PULSES],
            spawn_accum_ms: 0,
            node_dist: [u32::MAX; MAX_NODES],
            flood_front_mm: 0,
            flood_max_mm: 0,
        };
        if cfg.effect == Effect::Flood {
            sim.start_flood();
        }
        sim
    }

    pub fn config(&self) -> &EffectConfig {
        &self.cfg
    }

    /// Live pulse count (introspection / tests).
    pub fn active_pulses(&self) -> usize {
        self.pulses.iter().filter(|p| p.alive).count()
    }

    /// Current flood wavefront distance, mm (introspection / tests).
    pub fn flood_front_mm(&self) -> u32 {
        self.flood_front_mm
    }

    /// Advance the simulation by `dt_ms`.
    pub fn step(&mut self, dt_ms: u32) {
        self.time_ms += dt_ms as u64;
        let adv = (self.cfg.speed_mm_s as u64 * dt_ms as u64 / 1000) as u32;
        match self.cfg.effect {
            Effect::Pulse => self.step_pulses(adv, dt_ms),
            Effect::Flood => self.step_flood(adv),
        }
    }

    fn step_pulses(&mut self, adv: u32, dt_ms: u32) {
        // Spawn on a cadence at a random terminus, heading inward.
        self.spawn_accum_ms += dt_ms;
        if self.spawn_accum_ms >= self.cfg.spawn_interval_ms.max(1) && self.graph.n_termini > 0 {
            self.spawn_accum_ms = 0;
            let ti = (rng_next(&mut self.rng) as usize) % self.graph.n_termini;
            let node = self.graph.termini[ti];
            let seg = self.graph.nodes[node as usize].inc_seg[0];
            let fwd = self.graph.segs[seg as usize].node_a == node; // away from the terminus
            let color = rng_next(&mut self.rng);
            self.spawn(seg, fwd, color);
        }
        // Advance each pulse; hand junction/terminus transitions to a helper.
        // (Collect splits into a small queue to avoid borrow issues.)
        for pi in 0..MAX_PULSES {
            if !self.pulses[pi].alive {
                continue;
            }
            let mut remaining = adv;
            // A bounded number of segment hops per frame (avoids infinite loops
            // on degenerate zero-length segments).
            for _ in 0..8 {
                let p = self.pulses[pi];
                let len = self.graph.segs[p.seg as usize].len_mm;
                let to_end = if p.fwd { len.saturating_sub(p.pos_mm) } else { p.pos_mm };
                if remaining < to_end {
                    // Stay on this segment.
                    self.pulses[pi].pos_mm = if p.fwd { p.pos_mm + remaining } else { p.pos_mm - remaining };
                    self.pulses[pi].traveled_mm = p.traveled_mm.saturating_add(remaining);
                    break;
                }
                // Reached the far node.
                remaining -= to_end;
                self.pulses[pi].traveled_mm = p.traveled_mm.saturating_add(to_end);
                let node = if p.fwd { self.graph.segs[p.seg as usize].node_b } else { self.graph.segs[p.seg as usize].node_a };
                if self.graph.is_terminus(node) {
                    self.pulses[pi].alive = false;
                    break;
                }
                // Junction: pick an outgoing segment (not the incoming one).
                let pick = rng_next(&mut self.rng);
                let Some((next, m)) = self.graph.choose(node, p.seg, pick) else {
                    self.pulses[pi].alive = false;
                    break;
                };
                // Maybe split onto a second, different outgoing segment.
                if m >= 2 && (rng_next(&mut self.rng) & 0xFF) < self.cfg.split_q8 as u32 {
                    let pick2 = rng_next(&mut self.rng);
                    if let Some((other, _)) = self.graph.choose_excluding(node, p.seg, next, pick2) {
                        self.enter_segment_new(other, node, p.color);
                    }
                }
                self.enter_segment(pi, next, node);
            }
        }
    }

    /// Point pulse `pi` onto `seg`, entering from `from_node` (pos at that end).
    fn enter_segment(&mut self, pi: usize, seg: u16, from_node: u16) {
        let s = self.graph.segs[seg as usize];
        let fwd = s.node_a == from_node;
        self.pulses[pi].seg = seg;
        self.pulses[pi].fwd = fwd;
        self.pulses[pi].pos_mm = if fwd { 0 } else { s.len_mm };
    }

    /// Spawn a NEW pulse entering `seg` from `from_node` (used by splits).
    fn enter_segment_new(&mut self, seg: u16, from_node: u16, color: u32) {
        let s = self.graph.segs[seg as usize];
        let fwd = s.node_a == from_node;
        self.spawn_at(seg, fwd, if fwd { 0 } else { s.len_mm }, color);
    }

    fn spawn(&mut self, seg: u16, fwd: bool, color: u32) {
        let s = self.graph.segs[seg as usize];
        self.spawn_at(seg, fwd, if fwd { 0 } else { s.len_mm }, color);
    }

    fn spawn_at(&mut self, seg: u16, fwd: bool, pos_mm: u32, color: u32) {
        for p in self.pulses.iter_mut() {
            if !p.alive {
                *p = Pulse { alive: true, seg, pos_mm, fwd, traveled_mm: 0, color };
                return;
            }
        }
    }

    // -- flood --------------------------------------------------------------

    fn start_flood(&mut self) {
        if self.graph.n_nodes == 0 {
            return;
        }
        // Flood from a random terminus; on a terminus-less graph (a pure loop)
        // fall back to an arbitrary node so the wavefront still swirls around
        // the cycle instead of the effect going dark.
        let source = if self.graph.n_termini > 0 {
            let ti = (rng_next(&mut self.rng) as usize) % self.graph.n_termini;
            self.graph.termini[ti]
        } else {
            (rng_next(&mut self.rng) as usize % self.graph.n_nodes) as u16
        };
        self.node_dijkstra(source);
        self.flood_front_mm = 0;
        // Longest geodesic reach → when the flood is done (plus the decay tail).
        let mut maxd = 0u32;
        for nd in 0..self.graph.n_nodes {
            if self.node_dist[nd] != u32::MAX {
                maxd = maxd.max(self.node_dist[nd]);
            }
        }
        self.flood_max_mm = maxd + self.cfg.decay_mm;
    }

    fn step_flood(&mut self, adv: u32) {
        self.flood_front_mm = self.flood_front_mm.saturating_add(adv);
        if self.flood_front_mm > self.flood_max_mm {
            self.start_flood(); // faded to black — restart from a fresh terminus
        }
    }

    /// Dijkstra over the node graph (edge weight = segment length) from `source`.
    fn node_dijkstra(&mut self, source: u16) {
        for d in self.node_dist.iter_mut() {
            *d = u32::MAX;
        }
        self.node_dist[source as usize] = 0;
        // Small graphs: O(V²) settle loop, no heap.
        let mut done = [false; MAX_NODES];
        for _ in 0..self.graph.n_nodes {
            let mut u = usize::MAX;
            let mut best = u32::MAX;
            for v in 0..self.graph.n_nodes {
                if !done[v] && self.node_dist[v] < best {
                    best = self.node_dist[v];
                    u = v;
                }
            }
            if u == usize::MAX {
                break;
            }
            done[u] = true;
            let nd = self.graph.nodes[u];
            for i in 0..nd.degree as usize {
                let seg = self.graph.segs[nd.inc_seg[i] as usize];
                let other = if seg.node_a as usize == u { seg.node_b } else { seg.node_a };
                let nv = best.saturating_add(seg.len_mm);
                if nv < self.node_dist[other as usize] {
                    self.node_dist[other as usize] = nv;
                }
            }
        }
    }

    // -- rendering ----------------------------------------------------------

    /// Color for an LED on `seg` at arclength `s_mm` (from node_a), `d_perp_mm`
    /// off the segment.
    pub fn led_color(&self, seg: u16, s_mm: u32, d_perp_mm: u32) -> Rgb {
        if seg as usize >= self.graph.n_segs {
            return (0, 0, 0); // association points past the built graph
        }
        match self.cfg.effect {
            Effect::Pulse => self.pulse_led(seg, s_mm, d_perp_mm),
            Effect::Flood => self.flood_led(seg, s_mm, d_perp_mm),
        }
    }

    fn pulse_led(&self, seg: u16, s_mm: u32, d_perp_mm: u32) -> Rgb {
        let r2_radius = (self.cfg.glow_radius_mm as u64).pow(2).max(1);
        let cutoff2 = r2_radius.saturating_mul(16);
        let dp2 = (d_perp_mm as u64).pow(2);
        let (mut ar, mut ag, mut ab) = (0u32, 0u32, 0u32);
        for p in self.pulses.iter() {
            if !p.alive || p.seg != seg {
                continue; // same-segment illumination
            }
            let ds = (p.pos_mm as i64 - s_mm as i64).unsigned_abs();
            let r2 = ds * ds + dp2;
            if r2 > cutoff2 {
                continue;
            }
            let fall = (256 * r2_radius) / (r2_radius + r2); // r² kernel, Q8
            let env = self.lead_env(p); // Q8 lead-in/out
            let w = (fall * env as u64) >> 8;
            let (r, g, b) = self.cfg.palette_at(p.color);
            ar += (w * r as u64) as u32;
            ag += (w * g as u64) as u32;
            ab += (w * b as u64) as u32;
        }
        self.scale(ar, ag, ab)
    }

    /// Lead-in (ramp up over the first lead_mm of travel) and lead-out (ramp
    /// down as the pulse nears a TERMINUS) — Q8, so a pulse never pops.
    fn lead_env(&self, p: &Pulse) -> u32 {
        let lead = self.cfg.lead_mm.max(1);
        let ein = (256 * p.traveled_mm as u64 / lead as u64).min(256) as u32;
        let s = self.graph.segs[p.seg as usize];
        let far = if p.fwd { s.node_b } else { s.node_a };
        let eout = if self.graph.is_terminus(far) {
            let remaining = if p.fwd { s.len_mm.saturating_sub(p.pos_mm) } else { p.pos_mm };
            (256 * remaining as u64 / lead as u64).min(256) as u32
        } else {
            256
        };
        ein.min(eout)
    }

    fn flood_led(&self, seg: u16, s_mm: u32, d_perp_mm: u32) -> Rgb {
        let s = self.graph.segs[seg as usize];
        let da = self.node_dist[s.node_a as usize];
        let db = self.node_dist[s.node_b as usize];
        // Geodesic distance from the source to this LED (nearer end wins).
        let arrival = (da.saturating_add(s_mm)).min(db.saturating_add(s.len_mm.saturating_sub(s_mm)));
        if arrival == u32::MAX || self.flood_front_mm < arrival {
            return (0, 0, 0); // wavefront hasn't reached it yet
        }
        let behind = self.flood_front_mm - arrival; // how long ago it arrived
        let decay = self.cfg.decay_mm.max(1);
        if behind > decay {
            return (0, 0, 0);
        }
        // Full at the wavefront, linear fade to black over decay_mm. Also dim
        // with perpendicular offset via the same r² kernel.
        let r2_radius = (self.cfg.glow_radius_mm as u64).pow(2).max(1);
        let dp2 = (d_perp_mm as u64).pow(2);
        let perp = (256 * r2_radius) / (r2_radius + dp2);
        let fade = 256 - (256 * behind as u64 / decay as u64) as u32;
        let w = (perp * fade as u64) >> 8;
        let (r, g, b) = self.cfg.palette_at(0);
        self.scale((w * r as u64) as u32, (w * g as u64) as u32, (w * b as u64) as u32)
    }

    fn scale(&self, ar: u32, ag: u32, ab: u32) -> Rgb {
        let s = |c: u32| -> u8 { (((c >> 8) * self.cfg.intensity_q8 as u32) >> 8).min(255) as u8 };
        (s(ar), s(ag), s(ab))
    }
}

impl Graph {
    /// Like `choose`, but excludes both `except` and `also`.
    fn choose_excluding(&self, node: u16, except: u16, also: u16, pick: u32) -> Option<(u16, usize)> {
        let nd = &self.nodes[node as usize];
        let mut elig: [u16; MAX_INCIDENT] = [0; MAX_INCIDENT];
        let mut m = 0;
        for i in 0..nd.degree as usize {
            let s = nd.inc_seg[i];
            if s != except && s != also {
                elig[m] = s;
                m += 1;
            }
        }
        if m == 0 {
            None
        } else {
            Some((elig[(pick as usize) % m], m))
        }
    }
}
