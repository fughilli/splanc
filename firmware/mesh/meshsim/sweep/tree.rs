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
    /// Broadcast authenticator (interval µs, d), and the bootstrap round trip (ms).
    tesla: Option<(u32, u8)>,
    rtt: i64,
    early: bool,
    adaptive: bool,
    insider_hz: f64,
    /// Q25: containment (0 none, 1 local, 2 central, 3 both), the insider a relay, spoofing,
    /// framers.
    guard: u8,
    insider_relay: bool,
    spoof: bool,
    framers: usize,
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
    d.tesla = c.tesla;
    d.tesla_rtt_ms = c.rtt;
    d.tesla_early = c.early;
    d.tesla_adaptive = c.adaptive;
    d.insider_hz = c.insider_hz;
    d.guard_local = c.guard & 1 != 0;
    d.guard_central = c.guard & 2 != 0;
    d.guard_spoof_only = c.guard & 4 != 0;
    d.insider_relay = c.insider_relay;
    d.spoof = c.spoof;
    d.framers = c.framers;
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
    let base = Case { set: "tree", n: 16, scheme: Scheme::Tree, uwb_frac: 0.5, walking: true, moving: 0.0, kill: false, multihop: true, depth: 4, loss: 0.03, ramp: false, tesla: None, rtt: 40, early: false, adaptive: false, insider_hz: 0.0, guard: 0, insider_relay: false, spoof: false, framers: 0 };
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
                for tesla in [None, Some((20_000u32, 3u8))] {
                    for f in [0.5, 1.0] {
                        for multihop in [false, true] {
                            v.push(Case { set: "uwbhop", n, uwb_frac: f, multihop, tesla, ..base.clone() });
                        }
                    }
                }
            }
        }
        "auth" => {
            for n in [32usize, 64, 128] {
                v.push(Case { set: "auth", n, scheme: Scheme::Flood, uwb_frac: 0.0, ..base.clone() });
                v.push(Case { set: "auth", n, ..base.clone() });
                for (iv, d) in [(20_000u32, 2u8), (20_000, 3), (20_000, 4), (10_000, 4), (10_000, 6)] {
                    v.push(Case { set: "auth", n, tesla: Some((iv, d)), ..base.clone() });
                }
                // A slower bootstrap round trip (a deep mesh): the bound is looser.
                v.push(Case { set: "auth", n, tesla: Some((20_000, 3)), rtt: 100, ..base.clone() });
                // Multi-hop UWB with the authenticator, all fixtures UWB.
                for multihop in [false, true] {
                    v.push(Case { set: "auth", n, uwb_frac: 1.0, multihop, tesla: Some((20_000, 3)), ..base.clone() });
                }
            }
        }
        "live" => {
            // Q22: keep live latency at 5-20 ms above 24 members. rtt here is the adaptive
            // runs' queueing-jitter mean (ms).
            let t = Some((20_000u32, 3u8));
            for n in [32usize, 64, 128] {
                v.push(Case { set: "live", n, ..base.clone() });
                v.push(Case { set: "live", n, tesla: t, ..base.clone() });
                v.push(Case { set: "live", n, tesla: t, adaptive: true, rtt: 5, ..base.clone() });
                v.push(Case { set: "live", n, tesla: t, adaptive: true, rtt: 5, early: true, ..base.clone() });
                v.push(Case { set: "live", n, tesla: Some((10_000, 3)), adaptive: true, rtt: 5, early: true, ..base.clone() });
                for hz in [1.0, 30.0] {
                    v.push(Case { set: "live", n, tesla: t, adaptive: true, rtt: 5, early: true, insider_hz: hz, ..base.clone() });
                }
            }
        }
        "quarantine" => {
            // Q25: an insider flooding forged live moves at 30 Hz under apply-then-verify; the
            // containment layers; a relay insider, spoofing, and framers.
            let t = Some((20_000u32, 3u8));
            let live = Case { set: "quarantine", tesla: t, adaptive: true, rtt: 5, early: true, insider_hz: 30.0, ..base.clone() };
            for n in [64usize, 128] {
                v.push(Case { n, insider_hz: 0.0, ..live.clone() });
                v.push(Case { n, guard: 3, insider_hz: 0.0, ..live.clone() });
                for guard in [0u8, 1, 2, 3] {
                    for insider_relay in [false, true] {
                        v.push(Case { n, guard, insider_relay, ..live.clone() });
                    }
                }
                v.push(Case { n, guard: 3, spoof: true, ..live.clone() });
                // The recommendation: the gateway's quorum, plus local blocks of spoofs only.
                for (spoof, insider_relay) in [(false, false), (false, true), (true, false)] {
                    v.push(Case { n, guard: 6, spoof, insider_relay, ..live.clone() });
                }
                v.push(Case { n, guard: 2, spoof: true, ..live.clone() });
                v.push(Case { n, guard: 6, insider_hz: 1.0, ..live.clone() });
                for framers in [1usize, 2] {
                    v.push(Case { n, guard: 6, insider_hz: 0.0, framers, ..live.clone() });
                }
                v.push(Case { n, guard: 3, insider_hz: 1.0, ..live.clone() });
                for framers in [1usize, 2] {
                    v.push(Case { n, guard: 3, insider_hz: 0.0, framers, ..live.clone() });
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
    if set == "bench" {
        bench();
        return;
    }
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
    println!("set,n,scheme,uwb_frac,walking,moving,kill,multihop,depth,loss,delivery,reliable_delivery,lat_p50_ms,lat_p99_ms,wifi_airtime,uwb_util,ctrl_bps,relays,max_children,orphans,parent_changes_per_node_min,repair_s,uwb_tier,uwb_depth,uwb_first,evictions_per_node_min,max_excess,nacks,cache_hits,cache_misses,nack_age_p90,nack_age_max,nack_lacking,mode_switches,tesla,rtt,tesla_unsafe,tesla_hashes_member_s,tesla_hashes_gw_s,update_bytes,early,adaptive,insider_hz,tesla_d,tesla_chains,honest_rejected,forgeries,forged_shown,glitch_p50_ms,glitch_max_ms,forged_screen_share,root_children,guard,insider_relay,spoof,framers,detect_s,false_blocks,local_false,local_true,reports_s,report_airtime,forged_after_block_s,insider_was_relay");
    for (_, c, o) in &rows {
        println!(
            "{},{},{:?},{},{},{},{},{},{},{},{:.4},{:.4},{:.1},{:.1},{:.4},{:.4},{:.1},{},{},{},{:.2},{:.2},{},{},{:.3},{:.2},{},{},{},{},{},{},{},{},{},{},{},{:.1},{:.1},{},{},{},{},{},{},{},{},{},{:.1},{:.1},{:.5},{},{},{},{},{},{:.2},{},{},{},{:.2},{:.5},{:.2},{}",
            c.set, c.n, c.scheme, c.uwb_frac, c.walking, c.moving, c.kill, c.multihop, c.depth, c.loss, o.delivery, o.reliable_delivery, o.lat_p50_ms, o.lat_p99_ms, o.wifi_airtime, o.uwb_util, o.ctrl_bps, o.relays, o.max_children, o.orphans, o.parent_changes_per_node_min, o.repair_s, o.uwb_tier, o.uwb_depth, o.uwb_first, o.evictions_per_node_min, o.max_excess, o.nacks, o.cache_hits, o.cache_misses, o.nack_age_p90, o.nack_age_max, o.nack_lacking, o.mode_switches, c.tesla.map_or("none".to_string(), |(iv, d)| format!("{}ms/d{}", iv / 1000, d)), c.rtt, o.tesla_unsafe, o.tesla_hashes_member_s, o.tesla_hashes_gw_s, o.update_bytes, c.early, c.adaptive, c.insider_hz, o.tesla_d, o.tesla_chains, o.honest_rejected, o.forgeries, o.forged_shown, o.glitch_p50_ms, o.glitch_max_ms, o.forged_screen_share, o.root_children, c.guard, c.insider_relay, c.spoof, c.framers, o.detect_s, o.false_blocks, o.local_false, o.local_true, o.reports_s, o.report_airtime, o.forged_after_block_s, o.insider_was_relay
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

/// Host timings of the broadcast authenticator's operations (µs; the C6 is measured in M3a).
fn bench() {
    use splanc_mesh::tesla::{self, Auth, Challenge, Signer, TeslaMsg, Verifier};
    use std::time::Instant;
    let t = Instant::now();
    let mut s = Signer::new(&[1; 16], 1, 0, tesla::INTERVAL_US, tesla::DISCLOSE);
    let build = t.elapsed().as_secs_f64() * 1e6;
    let c = tesla::Context { mesh_id: 7, session: 1 };
    let body = [0u8; 18];
    let n = 3000;
    let t = Instant::now();
    let mut auths: Vec<Auth> = Vec::new();
    for k in 0..n {
        auths.push(s.seal(1_000_000 + k as i64 * 33_000, c, k as u64 + 1, 24, &body).unwrap());
    }
    let seal = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let ch = Challenge { session: 1, nonce: 1, t0_us: 1_000_000 };
    let TeslaMsg::Sync(sb, mac) = s.sync(1_000_000, 1, 2, 1, &[9; 16]) else { return };
    let mut v = Verifier::from_sync(&ch, &sb, &mac, &[9; 16], 2, 7).unwrap();
    let t = Instant::now();
    let mut got = 0;
    for (k, a) in auths.iter().enumerate() {
        v.on_packet(1_000_000 + k as i64 * 33_000 + 2_000, k as u64 + 1, 24, a, &body, &mut |o| if matches!(o, tesla::Out::Apply { .. }) { got += 1 });
    }
    let verify = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let t = Instant::now();
    let mut k = [0u8; 16];
    for _ in 0..100_000 {
        k = tesla::step(&k);
    }
    let hash = t.elapsed().as_secs_f64() * 1e6 / 100_000.0;
    println!("op,host_us");
    println!("chain_build_65535,{build:.0}");
    println!("seal_per_packet,{seal:.2}");
    println!("verify_per_packet,{verify:.2}");
    println!("sha256_step,{hash:.3}");
    println!("gateway_hashes_per_packet,{:.1}", s.hashes as f64 / n as f64);
    println!("member_hashes_per_packet,{:.2}", v.stats.hashes as f64 / n as f64);
    println!("delivered,{got}/{n}");
    let _ = k;
}
