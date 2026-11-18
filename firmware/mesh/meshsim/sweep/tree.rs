//! Distribution sweep (design §5.8): the managed flood vs the two-tier tree. CSV on stdout.
//!
//! `TREE_SET` picks the cases:
//! - `tree` (default): mesh size, UWB share, walking people, moving fixtures, a relay killed;
//! - `switch`: the automatic flood/tree switch (Q18) on a membership ramp; with
//!   `SERIES_OUT=file` it also writes the per-second series;
//! - `uwbhop`: one-hop vs multi-hop UWB (Q20) at 64/128 fixtures;
//! - `cache`: relay cache depth vs repair hits (Q21).

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use meshsim::dist::{run, DistCfg, Scheme};
use splanc_mesh::msg::Class;

#[derive(Clone, Debug)]
struct Case {
    set: &'static str,
    n: usize,
    scheme: Scheme,
    uwb_frac: f64,
    walking: bool,
    moving: f64,
    kill: bool,
    multihop: bool,
    depth: usize,
    loss: f64,
    ramp: bool,
}

fn rnd(s: &mut u64) -> f64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    (*s >> 11) as f64 / (1u64 << 53) as f64
}

/// The membership ramp for the switch (ms from start, members): 8 during the warm-up; up
/// through the band (16, 22: stays flood); 30 (tree after the hold); down into the band (20:
/// stays tree); 14 (flood after the hold); then 15 <-> 25 every 3 s (shorter than the hold:
/// no flapping); finally 30 for good.
fn ramp() -> Vec<(i64, usize)> {
    let mut v = vec![(0, 8), (20_000, 16), (30_000, 22), (40_000, 30), (60_000, 20), (75_000, 14)];
    let mut t = 90_000;
    while t < 110_000 {
        v.push((t, 25));
        v.push((t + 3_000, 15));
        t += 6_000;
    }
    v.push((110_000, 30));
    v
}

fn cfg(c: &Case, seed: u64) -> DistCfg {
    let side = (c.n as f64).sqrt().ceil() as usize;
    let mut s = seed | 1;
    // A grid 5 m apart with ±1 m jitter; the gateway at a corner.
    let positions: Vec<(f64, f64)> = (0..c.n).map(|i| ((i % side) as f64 * 5.0 + rnd(&mut s) * 2.0 - 1.0, (i / side) as f64 * 5.0 + rnd(&mut s) * 2.0 - 1.0)).collect();
    let uwb: Vec<bool> = (0..c.n).map(|i| c.uwb_frac > 0.0 && (i == 0 || rnd(&mut s) < c.uwb_frac)).collect();
    let class: Vec<Class> = (0..c.n).map(|i| if i % 4 == 0 { Class::P4 } else { Class::C6 }).collect();
    let mut d = DistCfg::new(positions, uwb, class, c.scheme, seed);
    d.walking = c.walking;
    d.moving = c.moving;
    d.loss = c.loss;
    d.kill_relay_at_ms = c.kill.then_some(5_000);
    d.uwb_multihop = c.multihop;
    d.cache_depth = c.depth;
    if c.set == "cache" {
        d.run_ms = 60_000;
    }
    if c.ramp {
        d.members = ramp();
        d.run_ms = 105_000;
    }
    d
}

fn cases(set: &str) -> Vec<Case> {
    let base = Case { set: "tree", n: 16, scheme: Scheme::Tree, uwb_frac: 0.5, walking: true, moving: 0.0, kill: false, multihop: true, depth: 4, loss: 0.03, ramp: false };
    let mut v = Vec::new();
    match set {
        "switch" => {
            for scheme in [Scheme::Flood, Scheme::Tree, Scheme::Auto] {
                v.push(Case { set: "switch", n: 30, scheme, ramp: true, ..base.clone() });
            }
        }
        "uwbhop" => {
            for n in [64usize, 128] {
                v.push(Case { set: "uwbhop", n, scheme: Scheme::Flood, uwb_frac: 0.0, ..base.clone() });
                for f in [0.5, 1.0] {
                    for multihop in [false, true] {
                        v.push(Case { set: "uwbhop", n, uwb_frac: f, multihop, ..base.clone() });
                    }
                }
            }
        }
        "cache" => {
            for n in [32usize, 64] {
                for loss in [0.03, 0.10, 0.20] {
                    for depth in [1usize, 2, 4, 8, 16] {
                        v.push(Case { set: "cache", n, depth, loss, ..base.clone() });
                    }
                }
            }
        }
        _ => {
            for n in [6usize, 16, 32, 64, 128] {
                v.push(Case { n, scheme: Scheme::Flood, uwb_frac: 0.0, ..base.clone() });
                for f in [0.0, 0.25, 0.5, 1.0] {
                    v.push(Case { n, uwb_frac: f, ..base.clone() });
                }
                v.push(Case { n, scheme: Scheme::Auto, ..base.clone() });
            }
            for scheme in [Scheme::Flood, Scheme::Tree] {
                for (walking, moving) in [(false, 0.0), (true, 0.0), (false, 0.25), (true, 0.25)] {
                    v.push(Case { set: "dynamics", n: 32, scheme, walking, moving, ..base.clone() });
                }
            }
            for f in [0.0, 0.5] {
                v.push(Case { set: "kill", n: 32, uwb_frac: f, kill: true, ..base.clone() });
            }
        }
    }
    v
}

fn main() {
    let set = std::env::var("TREE_SET").unwrap_or_else(|_| "tree".into());
    let cs = cases(&set);
    let threads = std::env::var("SWEEP_THREADS").ok().and_then(|s| s.parse().ok()).unwrap_or(4usize);
    let next = AtomicUsize::new(0);
    let rows = Mutex::new(Vec::new());
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(c) = cs.get(i) else { break };
                let t0 = std::time::Instant::now();
                let o = run(&cfg(c, 1000 + c.n as u64));
                eprintln!("[{}/{}] {:?} in {:.1}s", i + 1, cs.len(), c, t0.elapsed().as_secs_f64());
                rows.lock().unwrap().push((i, c.clone(), o));
            });
        }
    });
    let mut rows = rows.into_inner().unwrap();
    rows.sort_by_key(|r| r.0);
    println!("set,n,scheme,uwb_frac,walking,moving,kill,multihop,depth,loss,delivery,reliable_delivery,lat_p50_ms,lat_p99_ms,wifi_airtime,uwb_util,ctrl_bps,relays,max_children,orphans,parent_changes_per_node_min,repair_s,uwb_tier,uwb_depth,uwb_first,evictions_per_node_min,max_excess,nacks,cache_hits,cache_misses,nack_age_p90,nack_age_max,nack_lacking,mode_switches");
    for (_, c, o) in &rows {
        println!(
            "{},{},{:?},{},{},{},{},{},{},{},{:.4},{:.4},{:.1},{:.1},{:.4},{:.4},{:.1},{},{},{},{:.2},{:.2},{},{},{:.3},{:.2},{},{},{},{},{},{},{},{}",
            c.set, c.n, c.scheme, c.uwb_frac, c.walking, c.moving, c.kill, c.multihop, c.depth, c.loss, o.delivery, o.reliable_delivery, o.lat_p50_ms, o.lat_p99_ms, o.wifi_airtime, o.uwb_util, o.ctrl_bps, o.relays, o.max_children, o.orphans, o.parent_changes_per_node_min, o.repair_s, o.uwb_tier, o.uwb_depth, o.uwb_first, o.evictions_per_node_min, o.max_excess, o.nacks, o.cache_hits, o.cache_misses, o.nack_age_p90, o.nack_age_max, o.nack_lacking, o.mode_switches
        );
    }
    if let Ok(path) = std::env::var("SERIES_OUT") {
        let mut f = std::fs::File::create(path).expect("series file");
        writeln!(f, "scheme,t_s,members,tree,delivery,airtime").unwrap();
        for (_, c, o) in &rows {
            for b in &o.series {
                writeln!(f, "{:?},{},{},{},{:.4},{:.4}", c.scheme, b.t_s, b.members, b.tree as u8, b.delivery, b.airtime).unwrap();
            }
        }
    }
}
