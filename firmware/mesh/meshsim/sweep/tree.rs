//! Distribution sweep (design §5.8): the managed flood vs the two-tier tree, across mesh size,
//! UWB-capable share, walking people, moving fixtures and a relay failure. CSV on stdout.
//! `TREE_QUICK=1` runs a small subset.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use meshsim::dist::{run, DistCfg, Scheme};
use splanc_mesh::msg::Class;

#[derive(Clone, Debug)]
struct Case {
    sweep: &'static str,
    n: usize,
    scheme: Scheme,
    uwb_frac: f64,
    walking: bool,
    moving: f64,
    kill: bool,
    full: bool,
}

fn rnd(s: &mut u64) -> f64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    (*s >> 11) as f64 / (1u64 << 53) as f64
}

fn cfg(c: &Case, seed: u64) -> DistCfg {
    let side = (c.n as f64).sqrt().ceil() as usize;
    let mut s = seed | 1;
    // A grid 5 m apart with ±1 m jitter (fixtures where they fit).
    let positions: Vec<(f64, f64)> = (0..c.n).map(|i| ((i % side) as f64 * 5.0 + rnd(&mut s) * 2.0 - 1.0, (i / side) as f64 * 5.0 + rnd(&mut s) * 2.0 - 1.0)).collect();
    let uwb: Vec<bool> = (0..c.n).map(|i| i == 0 || rnd(&mut s) < c.uwb_frac).collect();
    let uwb: Vec<bool> = if c.uwb_frac == 0.0 { vec![false; c.n] } else { uwb };
    let class: Vec<Class> = (0..c.n).map(|i| if i % 4 == 0 { Class::P4 } else { Class::C6 }).collect();
    DistCfg {
        positions,
        uwb,
        class,
        scheme: c.scheme,
        walking: c.walking,
        moving: c.moving,
        loss: 0.03,
        adaptive_rate: false,
        hz: 30,
        warmup_ms: 15_000,
        run_ms: 20_000,
        kill_relay_at_ms: if c.kill { Some(5_000) } else { None },
        seed,
        uwb_enclosure_db: 3.0,
        full_macs: c.full,
        wifi_enclosure_db: 10.0,
    }
}

fn cases(quick: bool) -> Vec<Case> {
    let mut v = Vec::new();
    let base = Case { sweep: "", n: 16, scheme: Scheme::Tree, uwb_frac: 0.5, walking: true, moving: 0.0, kill: false, full: true };
    if quick {
        v.push(Case { sweep: "quick", n: 6, scheme: Scheme::Flood, ..base.clone() });
        v.push(Case { sweep: "quick", n: 6, ..base });
        return v;
    }
    for n in [6usize, 16, 32, 64, 128] {
        v.push(Case { sweep: "scale", n, scheme: Scheme::Flood, uwb_frac: 0.0, ..base.clone() });
        for f in [0.0, 0.25, 0.5, 1.0] {
            v.push(Case { sweep: "scale", n, uwb_frac: f, ..base.clone() });
        }
    }
    for (scheme, full) in [(Scheme::Flood, true), (Scheme::Tree, false), (Scheme::Tree, true)] {
        for (walking, moving) in [(false, 0.0), (true, 0.0), (false, 0.25), (true, 0.25)] {
            v.push(Case { sweep: "dynamics", n: 32, scheme, walking, moving, full, ..base.clone() });
        }
    }
    // Subtree-only MACs vs full MACs across scale (50 % UWB).
    for n in [16usize, 64] {
        v.push(Case { sweep: "macs", n, full: false, ..base.clone() });
    }
    for f in [0.0, 0.5] {
        v.push(Case { sweep: "kill", n: 32, uwb_frac: f, kill: true, ..base.clone() });
    }
    v
}

fn main() {
    let quick = std::env::var("TREE_QUICK").is_ok();
    let mut cs = cases(quick);
    if let Ok(only) = std::env::var("TREE_ONLY") {
        cs.retain(|c| c.sweep == only);
    }
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
    println!("sweep,n,scheme,full_macs,uwb_frac,walking,moving,kill,delivery,reliable_delivery,lat_p50_ms,lat_p99_ms,wifi_airtime,uwb_util,ctrl_bps,relays,max_children,orphans,parent_changes_per_node_min,repair_s,repaired,packets_per_update,uwb_tier,switches_per_node_min,lost_silent,lost_no_route,lost_evicted,evictions_per_node_min,over_cap_nodes,max_excess,over_cap_share");
    for (_, c, o) in rows {
        println!(
            "{},{},{:?},{},{},{},{},{},{:.4},{:.4},{:.1},{:.1},{:.4},{:.4},{:.1},{},{},{},{:.2},{:.2},{},{},{},{:.2},{},{},{},{:.2},{},{},{:.3}",
            c.sweep, c.n, c.scheme, c.full, c.uwb_frac, c.walking, c.moving, c.kill, o.delivery, o.reliable_delivery, o.lat_p50_ms, o.lat_p99_ms, o.wifi_airtime, o.uwb_util, o.ctrl_bps, o.relays, o.max_children, o.orphans, o.parent_changes_per_node_min, o.repair_s, o.repaired, o.packets_per_update, o.uwb_tier, o.switches_per_node_min, o.lost_silent, o.lost_no_route, o.lost_evicted, o.evictions_per_node_min, o.over_cap_nodes, o.max_excess, o.over_cap_share
        );
    }
}
