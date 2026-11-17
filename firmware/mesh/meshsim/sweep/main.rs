//! The heterogeneous-capacity sweep (design §10.6): mixes of standalone C6s, P4 + C6 fixtures
//! and Pis, across node counts, topologies, loss and traffic, with capacity-aware relaying on
//! and off (off = every node behaves as a C6: the uniform-small-queue baseline). One CSV row
//! per run on stdout.
//!
//!   bazel run -c opt //firmware/mesh/meshsim:sweep > sweep.csv
//!   python3 firmware/mesh/meshsim/sweep/plot.py sweep.csv docs/design/mesh/
//!
//! `SWEEP_QUICK=1` runs a small subset (CI smoke).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use meshsim::{Placement, RadioModel, World, MTU};
use splanc_mesh::backhaul::NodeId;
use splanc_mesh::membership::{Credentials, ProvisionSource};
use splanc_mesh::msg::Class;
use splanc_mesh::ports::Targets;
use swarm_net::mesh::PRIO_CLASSES;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Topo {
    Line,
    Grid,
    Random,
    Clustered,
    /// Two clusters joined only through one standalone C6 (a constrained cut vertex).
    CutVertex,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Traffic {
    /// Live control to all at this rate for 5 s.
    Control(u32),
    /// A 4 KiB effect blob (one page) from the best source.
    Blob,
    /// A 32 KiB firmware image.
    Firmware,
    /// The blob distributed, then 1/8 of the nodes power on late and catch up.
    Catchup,
    /// The blob and 30 Hz control at the same time (control must not suffer).
    Mixed,
    /// `blobs` 4 KiB blobs pushed as bulk floods (22 × 180 B each) from the source, with live
    /// control at `hz` (0: none): where relay queue space, spill and credit can matter.
    Burst { blobs: u32, hz: u32 },
    /// A firmware image of this many KiB (page protocol).
    BigFirmware(u32),
    /// The far cluster powers on after the near one has an image of this many KiB, and catches
    /// up through the C6 cut vertex.
    BigCatchup(u32),
    /// An image of this many KiB while nodes keep dropping off the air for 3 s and coming
    /// back (churn).
    Churn(u32),
    /// A live fader stream offered at this rate for 5 s (`send_live`, compact 8-byte body,
    /// coalesced), measured for delivery and for smoothness after interpolation.
    Live(u32),
}

#[derive(Clone, Copy, Debug)]
struct Cfg {
    sweep: &'static str,
    n: usize,
    topo: Topo,
    p4: f64,
    pi: f64,
    loss: f64,
    traffic: Traffic,
    aware: bool,
    seed: u64,
    ofdm: bool,
    /// One-way loss on the cut vertex's links toward the far cluster.
    asym: f64,
    hop: u8,
    /// Per-node rate adaptation (overrides `ofdm`), a fixed rate (overrides `ofdm`), people
    /// walking, enclosure losses spread 5–25 dB (mixed link qualities).
    adaptive: bool,
    rate: Option<meshsim::Rate>,
    walking: bool,
    mixed_enc: bool,
}

#[derive(Default, Debug)]
struct Out {
    delivery: f64,
    lat_p50: f64,
    lat_p95: f64,
    lat_p99: f64,
    bulk_s: f64,
    bulk_frac: f64,
    drops: [[u64; PRIO_CLASSES]; 3],
    peak_relays: [u8; 3],
    store_peak: [usize; 3],
    spilled: u64,
    airtime: f64,
    page_from_custodian: f64,
    sync_s: f64,
    live_sent_hz: f64,
    live_eff_hz: f64,
    rms: [f64; 5],
    held: f64,
    mean_mbps: f64,
    rate_changes: u32,
    burst_delivery: f64,
    burst_far: f64,
    burst_s: f64,
    cut_peak: u8,
    cut_drops: u64,
}

const SPACING: f64 = 5.0;
const MESH_KEY: [u8; 16] = [0x42; 16];

fn rand(s: &mut u64) -> f64 {
    *s ^= *s << 13;
    *s ^= *s >> 7;
    *s ^= *s << 17;
    (*s >> 11) as f64 / (1u64 << 53) as f64
}

fn positions(c: &Cfg) -> Vec<(f64, f64)> {
    let mut s = c.seed | 1;
    match c.topo {
        Topo::Line => (0..c.n).map(|i| (i as f64 * SPACING, 0.0)).collect(),
        Topo::Grid => {
            let side = (c.n as f64).sqrt().ceil() as usize;
            (0..c.n).map(|i| ((i % side) as f64 * SPACING, (i / side) as f64 * SPACING)).collect()
        }
        Topo::Random => {
            let l = (c.n as f64).sqrt() * SPACING;
            (0..c.n).map(|_| (rand(&mut s) * l, rand(&mut s) * l)).collect()
        }
        Topo::CutVertex => {
            // n - 1 nodes in two clusters 22 m apart (out of each other's range), the last one
            // at the middle: the only path between them.
            let half = (c.n - 1) / 2;
            let mut v = Vec::new();
            for i in 0..c.n - 1 {
                let cl = (i >= half) as usize;
                let a = rand(&mut s) * std::f64::consts::TAU;
                let r = rand(&mut s) * 3.0;
                v.push((cl as f64 * 22.0 + r * a.cos(), r * a.sin()));
            }
            v.push((11.0, 0.0));
            v
        }
        Topo::Clustered => {
            // Clusters of up to 8 within 3 m, 24 m apart (out of direct range), one bridge
            // node half-way between neighbouring clusters.
            let k = c.n.div_ceil(9).max(2);
            let bridges = k - 1;
            let members = c.n - bridges;
            let mut v = Vec::new();
            for i in 0..members {
                let cl = i % k;
                let a = rand(&mut s) * std::f64::consts::TAU;
                let r = rand(&mut s) * 3.0;
                v.push((cl as f64 * 24.0 + r * a.cos(), r * a.sin()));
            }
            for b in 0..bridges {
                v.push((b as f64 * 24.0 + 12.0, 0.0));
            }
            v
        }
    }
}

fn classes(c: &Cfg) -> Vec<Class> {
    let n_pi = (c.n as f64 * c.pi).round() as usize;
    let n_p4 = (c.n as f64 * c.p4).round() as usize;
    let mut order: Vec<usize> = (0..c.n).collect();
    let mut s = c.seed.wrapping_mul(31) | 1;
    for i in (1..c.n).rev() {
        let j = (rand(&mut s) * (i + 1) as f64) as usize;
        order.swap(i, j);
    }
    let mut cl = vec![Class::C6; c.n];
    for (k, &i) in order.iter().enumerate() {
        cl[i] = if k < n_pi {
            Class::Pi
        } else if k < n_pi + n_p4 {
            Class::P4
        } else {
            Class::C6
        };
    }
    // In the clustered topology, a mix with exactly one custodian puts it on a bridge (the
    // single-custodian bottleneck case).
    if c.topo == Topo::CutVertex {
        // The custodians (if any) sit in the near cluster; the far cluster and the cut vertex
        // are constrained C6s. Node 0 (gateway and source) is a custodian if the mix has one.
        let half = (c.n - 1) / 2;
        let mut k = 0;
        for (i, x) in cl.iter_mut().enumerate() {
            *x = Class::C6;
            if i < half && k < n_pi + n_p4 {
                *x = if k < n_pi { Class::Pi } else { Class::P4 };
                k += 1;
            }
        }
        return cl;
    }
    if c.topo == Topo::Clustered && n_pi + n_p4 == 1 {
        let custodian = if n_pi == 1 { Class::Pi } else { Class::P4 };
        cl.iter_mut().for_each(|x| *x = Class::C6);
        cl[c.n - 1] = custodian;
    }
    cl
}

fn id(i: usize) -> NodeId {
    0x2001 + i as NodeId
}

fn class_ix(c: Class) -> usize {
    c as usize
}

fn percentile(v: &mut [f64], p: f64) -> f64 {
    if v.is_empty() {
        return f64::NAN;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    v[((v.len() as f64 - 1.0) * p).round() as usize]
}

fn run(c: &Cfg) -> Out {
    let rate = c.rate.unwrap_or(if c.ofdm { meshsim::Rate::Ofdm6 } else { meshsim::Rate::Dsss1 });
    let m = RadioModel { rate, adaptive: c.adaptive, walking: c.walking, ..RadioModel::default() };
    let mut w = World::with(m, c.seed, 0x5357_4545, b"sweep-admin-key!", c.aware);
    w.hop_limit = c.hop.max(1);
    // hop 0 in a config means adaptive; the hop sweep's fixed limits switch adaptation off.
    w.adaptive_hops = c.hop == 0 || c.sweep != "hops";
    let img_kib = match c.traffic {
        Traffic::BigFirmware(k) | Traffic::BigCatchup(k) | Traffic::Churn(k) => k as usize,
        Traffic::Firmware => 32,
        _ => 4,
    };
    w.flash_bytes = (img_kib + 8) * 1024;
    let pos = positions(c);
    let cls = classes(c);
    let mut s = c.seed ^ 0xABCD;
    for i in 0..c.n {
        let mut p = Placement::at(pos[i].0, pos[i].1);
        p.enclosure_db = if c.mixed_enc { 5.0 + rand(&mut s) * 20.0 } else { 15.0 };
        p.clock_offset_us = (rand(&mut s) * 1e6) as i64 - 500_000;
        p.clock_ppm = rand(&mut s) * 40.0 - 20.0;
        p.class = cls[i];
        if cls[i] == Class::Pi {
            p = p.pi_radio(); // measured built-in Broadcom path (Public Action passthrough)
        }
        w.add(id(i), p);
    }
    w.air.set_loss(c.loss);
    if c.topo == Topo::CutVertex && c.asym > 0.0 {
        let half = (c.n - 1) / 2;
        for j in half..c.n - 1 {
            w.air.link_loss_oneway(c.n - 1, j, c.asym);
        }
    }
    let creds = Credentials { mesh_id: w.mesh_id, mesh_key: Some((1, MESH_KEY)), admin_key: Some(w.admin.public()), ..Credentials::default() };
    let late: Vec<usize> = match c.traffic {
        Traffic::Catchup => (c.n - c.n.div_ceil(8)..c.n).collect(),
        Traffic::BigCatchup(_) => ((c.n - 1) / 2..c.n - 1).collect(),
        _ => Vec::new(),
    };
    for i in 0..c.n {
        if !late.contains(&i) {
            w.power_on(i, Some((&creds, ProvisionSource::App)));
        }
    }
    w.run_ms(3_000);
    let mut out = Out::default();
    let gw = 0usize;
    let present: Vec<usize> = (0..c.n).filter(|i| !late.contains(i)).collect();
    let wants_control = matches!(c.traffic, Traffic::Control(_) | Traffic::Mixed | Traffic::Burst { hz: 1.., .. } | Traffic::Live(_));
    if wants_control {
        out.sync_s = w.unlock_and_sync(gw, 1, &present, 60_000).map(|ms| ms as f64 / 1000.0).unwrap_or(f64::NAN);
    }
    let air0 = w.air.stats().airtime_us;
    let t_start = w.now();
    // The bulk source: a Pi if any, else a P4, else the gateway.
    let src = (0..c.n).max_by_key(|&i| (cls[i] as u8, std::cmp::Reverse(i))).unwrap_or(0);
    let wants_bulk = matches!(c.traffic, Traffic::Blob | Traffic::Firmware | Traffic::Catchup | Traffic::Mixed | Traffic::BigFirmware(_) | Traffic::BigCatchup(_) | Traffic::Churn(_));
    let img_len = img_kib * 1024 - 64;
    if wants_bulk {
        let img: Vec<u8> = (0..img_len).map(|i| (i * 7 % 251) as u8).collect();
        w.host_image(src, &img, 2);
    }
    let mut lat = Vec::new();
    let mut delivered = 0usize;
    let mut expected = 0usize;
    let hz = match c.traffic {
        Traffic::Control(hz) => hz,
        Traffic::Mixed => 30,
        Traffic::Burst { hz, .. } => hz,
        Traffic::Live(hz) => hz,
        _ => 0,
    };
    let live = matches!(c.traffic, Traffic::Live(_));
    let truth = |t_us: i64| (t_us as f64 / 1e6 * std::f64::consts::TAU * 0.5).sin() as f32;
    // (op, sent at, value) of live updates that actually left the gateway.
    let mut live_tx: Vec<(u32, i64)> = Vec::new();
    let live_sent0 = w.nodes[gw].stack.live_sent;
    let bulk_timeout_ms: i64 = match c.traffic {
        Traffic::Firmware => 120_000,
        Traffic::BigFirmware(k) | Traffic::BigCatchup(k) | Traffic::Churn(k) => 60_000 + k as i64 * 1_500,
        _ => 60_000,
    };
    // Push bursts: (blob, chunk) packets queued at the source, released by its policy.
    let mut burst: std::collections::VecDeque<(u8, u8)> = match c.traffic {
        Traffic::Burst { blobs, .. } => (0..blobs as u8).flat_map(|b| (0..22u8).map(move |k| (b, k))).collect(),
        _ => Default::default(),
    };
    let burst_total = burst.len();
    let burst_at = w.now();
    let mut burst_done_us: Option<i64> = None;
    let mut churn_off: Vec<(usize, i64)> = Vec::new();
    let mut churn_rng = c.seed ^ 0x5151;
    let mut bulk_done: Option<f64> = None;
    let ctrl_ms = if hz > 0 { 5_000 } else { 0 };
    let mut sent: Vec<(u32, i64)> = Vec::new();
    let mut t = 0i64;
    let catchup_started = if matches!(c.traffic, Traffic::Catchup | Traffic::BigCatchup(_)) { None } else { Some(t_start) };
    let mut catchup_at = catchup_started;
    let horizon = ctrl_ms.max(if wants_bulk { bulk_timeout_ms } else { 0 }).max(if burst_total > 0 { 30_000 } else { 0 });
    while t < horizon {
        // Push the next burst packet when the source's policy allows (capacity-aware: only
        // while its neighbours advertise credit; baseline: whenever its outbox has room).
        if let Some(&(b, k)) = burst.front() {
            let now = w.local(src);
            if w.nodes[src].stack.bulk_clear_to_send(now) {
                let mut body = [0u8; 180];
                body[0] = b;
                body[1] = k;
                if w.nodes[src].stack.send_bulk(now, &body).is_ok() {
                    burst.pop_front();
                    if burst.is_empty() {
                        burst_done_us = Some(w.now());
                    }
                }
            }
        }
        // Churn: every 4 s a random node (not the source or gateway) drops off for 3 s.
        if matches!(c.traffic, Traffic::Churn(_)) {
            if t % 4_000 == 0 && t > 0 {
                let i = 1 + (rand(&mut churn_rng) * (c.n - 1) as f64) as usize;
                if i != src && i < c.n {
                    w.set_online(i, false);
                    churn_off.push((i, w.now() + 3_000_000));
                }
            }
            let now = w.now();
            churn_off.retain(|&(i, back)| {
                if now >= back {
                    w.set_online(i, true);
                    false
                } else {
                    true
                }
            });
        }
        let before = w.nodes[gw].stack.live_sent;
        if hz > 0 && t < ctrl_ms && (t * hz as i64) % 1000 < hz as i64 {
            let op = 1000 + (t * hz as i64 / 1000) as u32;
            let local = w.local(gw);
            if live {
                // A compact batch: uniform id, 16-bit value, uniform id, 16-bit value, seq.
                let v = (truth(w.now()) * 32767.0) as i16;
                let mut body = [3u8, 0, 0, 7, 0, 0, 0, 0];
                body[1..3].copy_from_slice(&v.to_be_bytes());
                let _ = w.nodes[gw].stack.send_live(local, 0, op, Targets::All, &body);
            } else if w.nodes[gw].stack.send_control(local, 0, op, Targets::All, b"set_uniforms{x=0.5}").is_ok() {
                sent.push((op, w.now()));
            }
        }
        let step = if (hz > 0 && t < ctrl_ms) || !burst.is_empty() { 1 } else { 10 };
        w.run_ms(step);
        t += step;
        if live && w.nodes[gw].stack.live_sent != before {
            live_tx.push((w.nodes[gw].stack.live_last_op, w.now()));
        }
        if wants_bulk && bulk_done.is_none() && t % 10 == 0 {
            let targets: Vec<usize> = if matches!(c.traffic, Traffic::Catchup | Traffic::BigCatchup(_)) && catchup_at.is_some() { late.clone() } else { present.clone() };
            if targets.iter().all(|&i| w.has_image(i, 2)) {
                if matches!(c.traffic, Traffic::Catchup | Traffic::BigCatchup(_)) && catchup_at.is_none() {
                    for &i in &late {
                        w.power_on(i, Some((&creds, ProvisionSource::App)));
                    }
                    catchup_at = Some(w.now());
                } else {
                    let from = catchup_at.unwrap_or(t_start);
                    bulk_done = Some((w.now() - from) as f64 / 1e6);
                }
            }
        }
        let burst_settled = burst_total == 0 || burst_done_us.is_some_and(|d| w.now() - d > 3_000_000);
        if t >= ctrl_ms && (!wants_bulk || bulk_done.is_some()) && burst_settled {
            break;
        }
    }
    w.run_ms(500);
    // Live: what left the gateway is what we judge delivery on (coalesced updates never did);
    // then each member renders at 60 fps from its keyframes (apply_at = sent + playout delay).
    if live {
        // Updates sent inside send_live (outbox had room at once) are recorded here too.
        let gw_live_ops: std::collections::HashSet<u32> = live_tx.iter().map(|x| x.0).collect();
        let mut all_ops: Vec<(u32, i64)> = live_tx.clone();
        for n in w.nodes.iter() {
            for (at, _, op, _) in n.controls() {
                if !gw_live_ops.contains(&op) && !all_ops.iter().any(|x| x.0 == op) {
                    all_ops.push((op, at - 2_000)); // sent directly by send_live: ~at its first arrival
                }
            }
        }
        all_ops.sort_by_key(|x| x.1);
        sent = all_ops.clone();
        let dur_s = (ctrl_ms as f64 / 1000.0).max(1.0);
        out.live_sent_hz = (w.nodes[gw].stack.live_sent - live_sent0) as f64 / dur_s;
        let send_time: std::collections::HashMap<u32, i64> = all_ops.iter().cloned().collect();
        let mut eff = 0.0;
        let mut sq = [0.0f64; 5];
        let mut frames = 0usize;
        let mut held = 0usize;
        let interval = 1_000_000 / hz.max(1) as i64;
        for (i, n) in w.nodes.iter().enumerate() {
            if i == gw {
                continue;
            }
            let mut rx: Vec<(i64, i64)> = n.controls().into_iter().filter_map(|(at, _, op, _)| send_time.get(&op).map(|&st| (at, st))).collect();
            rx.sort();
            eff += rx.len() as f64 / dur_s;
            // Hermite at 33 and 66 ms and at the automatic playout delay; linear and step at
            // the automatic delay.
            let auto = splanc_mesh::interp::playout_delay_us(interval);
            let variants: [(i64, splanc_mesh::interp::Kind); 5] = [
                (33_000, splanc_mesh::interp::Kind::Float),
                (66_000, splanc_mesh::interp::Kind::Float),
                (auto, splanc_mesh::interp::Kind::Float),
                (auto, splanc_mesh::interp::Kind::Color),
                (auto, splanc_mesh::interp::Kind::Discrete),
            ];
            for (vi, (delay, kind)) in variants.iter().enumerate() {
                let mut tr = splanc_mesh::interp::Track::new();
                let mut k = 0;
                let start = t_start + 500_000;
                let end = t_start + ctrl_ms * 1000 - 200_000;
                let mut tr_t = start;
                while tr_t < end {
                    while k < rx.len() && rx[k].0 <= tr_t {
                        tr.push(splanc_mesh::interp::Keyframe { t_us: rx[k].1 + delay, v: truth(rx[k].1) });
                        k += 1;
                    }
                    let (v, how) = tr.sample(*kind, tr_t, interval);
                    let e = (v - truth(tr_t - delay)) as f64;
                    sq[vi] += e * e;
                    if vi == 2 {
                        frames += 1;
                        if matches!(how, splanc_mesh::interp::Sampled::Held | splanc_mesh::interp::Sampled::Extrapolated | splanc_mesh::interp::Sampled::Empty) {
                            held += 1;
                        }
                    }
                    tr_t += 16_667;
                }
            }
        }
        let receivers = (c.n - 1) as f64;
        out.live_eff_hz = eff / receivers;
        let per = frames.max(1) as f64;
        for (o, s) in out.rms.iter_mut().zip(sq) {
            *o = (s / per).sqrt();
        }
        out.held = held as f64 / per;
    }
    if c.adaptive {
        let mut tot = 0.0;
        let mut t_all = 0i64;
        for i in 0..c.n {
            let ctl = w.air.rate_ctl(i);
            out.rate_changes += ctl.changes;
            for (k, r) in meshsim::Rate::LADDER.iter().enumerate() {
                tot += ctl.time_at[k] as f64 * r.mbps();
                t_all += ctl.time_at[k];
            }
        }
        out.mean_mbps = if t_all > 0 { tot / t_all as f64 } else { f64::NAN };
    } else {
        out.mean_mbps = rate.mbps();
    }
    // Control metrics.
    for (op, at) in &sent {
        for (i, n) in w.nodes.iter().enumerate() {
            if i == gw {
                continue;
            }
            expected += 1;
            if let Some(ev) = n.controls().into_iter().find(|x| x.2 == *op) {
                delivered += 1;
                lat.push((ev.0 - at) as f64 / 1000.0);
            }
        }
    }
    out.delivery = if expected > 0 { delivered as f64 / expected as f64 } else { f64::NAN };
    out.lat_p50 = percentile(&mut lat, 0.5);
    out.lat_p95 = percentile(&mut lat, 0.95);
    out.lat_p99 = percentile(&mut lat, 0.99);
    let targets: Vec<usize> = if matches!(c.traffic, Traffic::Catchup | Traffic::BigCatchup(_)) { late.clone() } else { (0..c.n).collect() };
    out.bulk_s = bulk_done.unwrap_or(f64::NAN);
    out.bulk_frac = if wants_bulk { targets.iter().filter(|&&i| w.has_image(i, 2)).count() as f64 / targets.len() as f64 } else { f64::NAN };
    // Burst delivery: the share of (node, chunk) pairs that arrived, and the time to push all.
    if burst_total > 0 {
        let mut got = 0usize;
        let mut far_got = 0usize;
        let half = (c.n - 1) / 2;
        for (i, n) in w.nodes.iter().enumerate() {
            if i == src {
                continue;
            }
            let mut seen = std::collections::HashSet::new();
            for (_, e) in &n.events {
                if let meshsim::Ev::Packet { port: splanc_mesh::ports::Port::Bulk, body, .. } = e {
                    seen.insert((body[0], body[1]));
                }
            }
            got += seen.len();
            if c.topo == Topo::CutVertex && (half..c.n - 1).contains(&i) {
                far_got += seen.len();
            }
        }
        out.burst_delivery = got as f64 / (burst_total * (c.n - 1)) as f64;
        out.burst_far = if c.topo == Topo::CutVertex { far_got as f64 / (burst_total * (c.n - 1 - (c.n - 1) / 2)) as f64 } else { f64::NAN };
        out.burst_s = burst_done_us.map_or(f64::NAN, |d| (d - burst_at) as f64 / 1e6);
    } else {
        out.burst_delivery = f64::NAN;
        out.burst_far = f64::NAN;
        out.burst_s = f64::NAN;
    }
    let mut served = [0u64; 2];
    for (i, n) in w.nodes.iter().enumerate() {
        let k = class_ix(n.class());
        let st = n.stack.node.net.mesh.stats;
        for p in 0..PRIO_CLASSES {
            out.drops[k][p] += st.dropped_by_prio[p] as u64;
        }
        out.peak_relays[k] = out.peak_relays[k].max(st.peak_relays);
        if let Some(s) = &n.store {
            out.store_peak[k] = out.store_peak[k].max(s.peak);
        }
        out.spilled += st.spilled as u64;
        let u = n.stack.node.net.updater.stats;
        served[(cls[i] != Class::C6) as usize] += u.chunks_served as u64;
    }
    if c.topo == Topo::CutVertex {
        let st = w.nodes[c.n - 1].stack.node.net.mesh.stats;
        out.cut_peak = st.peak_relays;
        out.cut_drops = st.dropped_by_prio.iter().map(|&d| d as u64).sum();
    }
    out.page_from_custodian = if served[0] + served[1] > 0 { served[1] as f64 / (served[0] + served[1]) as f64 } else { f64::NAN };
    let dt = (w.now() - t_start).max(1);
    out.airtime = (w.air.stats().airtime_us - air0) as f64 / dt as f64;
    out
}

fn configs(quick: bool) -> Vec<Cfg> {
    let mut v = Vec::new();
    let base = Cfg { sweep: "", n: 16, topo: Topo::Grid, p4: 0.0, pi: 0.0, loss: 0.1, traffic: Traffic::Blob, aware: true, seed: 1, ofdm: false, asym: 0.0, hop: 3, adaptive: false, rate: None, walking: false, mixed_enc: false };
    match std::env::var("SWEEP_SET").as_deref() {
        Ok("stress") => return stress(),
        Ok("live") => return live_and_rate(true),
        Ok("rate") => return live_and_rate(false),
        _ => {}
    }
    let mixes: &[(f64, f64)] = &[(0.0, 0.0), (0.25, 0.0), (0.5, 0.0), (1.0, 0.0), (0.0, 0.0625), (0.25, 0.25), (0.0, 1.0)];
    if quick {
        for &(p4, pi) in &mixes[..3] {
            v.push(Cfg { sweep: "quick", n: 6, p4, pi, traffic: Traffic::Control(30), ..base });
        }
        return v;
    }
    // A. Class mix at 16 nodes, every traffic, aware on/off.
    for &(p4, pi) in mixes {
        for traffic in [Traffic::Control(60), Traffic::Blob, Traffic::Mixed, Traffic::Firmware, Traffic::Catchup] {
            for aware in [true, false] {
                v.push(Cfg { sweep: "mix", p4, pi, traffic, aware, ..base });
            }
        }
    }
    // B. Node count, 100 % C6 vs half P4 (aware) vs half P4 baseline.
    for n in [6, 16, 32, 64] {
        for (p4, aware) in [(0.0, true), (0.5, true), (0.5, false)] {
            for traffic in [Traffic::Control(60), Traffic::Blob] {
                v.push(Cfg { sweep: "nodes", n, p4, aware, traffic, seed: 2, ..base });
            }
        }
    }
    // B2. The airtime mitigation: control at 6 Mb/s OFDM, and at 30 Hz.
    for n in [6, 16, 32, 64] {
        for (traffic, ofdm) in [(Traffic::Control(60), true), (Traffic::Control(30), false), (Traffic::Control(30), true)] {
            v.push(Cfg { sweep: "rate", n, traffic, ofdm, seed: 2, ..base });
        }
    }
    // C. Topology at 32 nodes: all C6, half P4, a single Pi.
    for topo in [Topo::Line, Topo::Grid, Topo::Random, Topo::Clustered] {
        for (p4, pi) in [(0.0, 0.0), (0.5, 0.0), (0.0, 1.0 / 32.0), (1.0 / 32.0, 0.0)] {
            for traffic in [Traffic::Control(30), Traffic::Blob] {
                v.push(Cfg { sweep: "topology", n: 32, topo, p4, pi, traffic, seed: 3, ..base });
            }
        }
    }
    // D. Loss at 16 nodes, half P4, aware on/off.
    for loss in [0.0, 0.1, 0.3] {
        for aware in [true, false] {
            for traffic in [Traffic::Control(60), Traffic::Mixed] {
                v.push(Cfg { sweep: "loss", p4: 0.5, loss, aware, traffic, seed: 4, ..base });
            }
        }
    }
    v
}

/// Scenarios where queue space should matter (design §10.6, second round), at 6 Mb/s and
/// hop limit 5: push bursts and big images through a constrained C6 cut vertex, with live
/// control, asymmetric loss, a big catch-up over a C6-only path, churn; and the hop limit.
fn stress() -> Vec<Cfg> {
    let base = Cfg { sweep: "", n: 17, topo: Topo::CutVertex, p4: 0.0, pi: 0.0, loss: 0.05, traffic: Traffic::Blob, aware: true, seed: 7, ofdm: true, asym: 0.0, hop: 5, adaptive: false, rate: None, walking: false, mixed_enc: false };
    let mixes: &[(f64, f64)] = &[(0.0, 0.0), (0.25, 0.0), (0.0, 1.0 / 17.0)];
    let mut v = Vec::new();
    for &(p4, pi) in mixes {
        for aware in [true, false] {
            for (sweep, traffic, asym) in [
                ("burst", Traffic::Burst { blobs: 4, hz: 0 }, 0.0),
                ("burst+control", Traffic::Burst { blobs: 4, hz: 30 }, 0.0),
                ("burst-asym", Traffic::Burst { blobs: 4, hz: 0 }, 0.3),
                ("catchup-256k", Traffic::BigCatchup(256), 0.0),
                ("fw-asym-256k", Traffic::BigFirmware(256), 0.3),
                ("churn-256k", Traffic::Churn(256), 0.0),
            ] {
                v.push(Cfg { sweep, p4, pi, aware, traffic, asym, ..base });
            }
        }
    }
    // The 1.5 MB firmware through the cut vertex: all C6 vs custodians, aware vs baseline.
    for &(p4, pi) in &mixes[..2] {
        for aware in [true, false] {
            v.push(Cfg { sweep: "fw-1.5M", p4, pi, aware, traffic: Traffic::BigFirmware(1536), ..base });
        }
    }
    // Hop limit on line and clustered venues.
    for topo in [Topo::Line, Topo::Clustered, Topo::Grid, Topo::Random] {
        for hop in [3u8, 5, 7, 0] {
            v.push(Cfg { sweep: "hops", n: 32, topo, hop, traffic: Traffic::Control(30), seed: 3, ..base });
        }
    }
    v
}

/// Q13 (`live`): the live-update rate each mesh size carries at ≥ 99 % delivery, and how
/// smooth members render it. Q12 (`rate`): fixed rates vs per-node adaptation, on mixed link
/// qualities with and without people walking.
fn live_and_rate(live: bool) -> Vec<Cfg> {
    let base = Cfg { sweep: "", n: 16, topo: Topo::Grid, p4: 0.0, pi: 0.0, loss: 0.05, traffic: Traffic::Live(30), aware: true, seed: 21, ofdm: true, asym: 0.0, hop: 5, adaptive: false, rate: None, walking: false, mixed_enc: true };
    let mut v = Vec::new();
    if live {
        for n in [6usize, 16, 32] {
            for hz in [15u32, 30, 45, 60, 90, 120] {
                for adaptive in [false, true] {
                    v.push(Cfg { sweep: "live", n, traffic: Traffic::Live(hz), adaptive, walking: true, ..base });
                }
            }
        }
    } else {
        for n in [6usize, 16, 32] {
            for walking in [false, true] {
                for (rate, adaptive) in [
                    (Some(meshsim::Rate::Dsss1), false),
                    (Some(meshsim::Rate::Ofdm6), false),
                    (Some(meshsim::Rate::Ofdm12), false),
                    (Some(meshsim::Rate::Ofdm24), false),
                    (None, true),
                ] {
                    v.push(Cfg { sweep: "rate", n, traffic: Traffic::Live(30), rate, adaptive, walking, ..base });
                }
            }
        }
    }
    v
}

fn main() {
    let quick = std::env::var("SWEEP_QUICK").is_ok();
    let cfgs = configs(quick);
    let threads = std::env::var("SWEEP_THREADS").ok().and_then(|s| s.parse().ok()).unwrap_or(4usize);
    let next = AtomicUsize::new(0);
    let rows = Mutex::new(Vec::new());
    std::thread::scope(|sc| {
        for _ in 0..threads {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(c) = cfgs.get(i) else { break };
                let t0 = std::time::Instant::now();
                let o = run(c);
                eprintln!("[{}/{}] {:?} in {:.1}s", i + 1, cfgs.len(), c, t0.elapsed().as_secs_f64());
                rows.lock().unwrap().push((i, *c, o));
            });
        }
    });
    let mut rows = rows.into_inner().unwrap();
    rows.sort_by_key(|r| r.0);
    println!("sweep,n,topology,p4,pi,c6,loss,traffic,aware,ofdm,adaptive,walking,mixed_enc,live_sent_hz,live_eff_hz,rms_h33,rms_h66,rms_hauto,rms_linauto,rms_stepauto,held_auto,mean_mbps,rate_changes,hop,asym,burst_delivery,burst_far,burst_s,cut_peak,cut_drops,delivery,lat_p50_ms,lat_p95_ms,lat_p99_ms,bulk_s,bulk_frac,drops_c6_bulk,drops_c6_normal,drops_c6_high,drops_p4_bulk,drops_p4_high,drops_pi_bulk,drops_pi_high,peak_relays_c6,peak_relays_p4,peak_relays_pi,relay_budget,store_peak_p4,store_peak_pi,spilled,airtime,pages_from_custodians,sync_s,mtu");
    for (_, c, o) in rows {
        let traffic = match c.traffic {
            Traffic::Control(hz) => format!("control{hz}"),
            Traffic::Burst { blobs, hz } => format!("burst{blobs}x4k+control{hz}"),
            Traffic::BigFirmware(k) => format!("firmware{k}k"),
            Traffic::BigCatchup(k) => format!("catchup{k}k"),
            Traffic::Churn(k) => format!("churn{k}k"),
            Traffic::Live(hz) => format!("live{hz}"),
            t => format!("{t:?}").to_lowercase(),
        };
        println!(
            "{},{},{:?},{:.3},{:.3},{:.3},{},{},{},{},{},{},{},{:.1},{:.1},{:.4},{:.4},{:.4},{:.4},{:.4},{:.3},{:.1},{},{},{},{:.4},{:.4},{:.2},{},{},{:.4},{:.1},{:.1},{:.1},{:.2},{:.3},{},{},{},{},{},{},{},{},{},{},{},{},{},{},{:.4},{:.3},{:.2},{}",
            c.sweep,
            c.n,
            c.topo,
            c.p4,
            c.pi,
            1.0 - c.p4 - c.pi,
            c.loss,
            traffic,
            c.aware,
            c.ofdm,
            c.adaptive,
            c.walking,
            c.mixed_enc,
            o.live_sent_hz,
            o.live_eff_hz,
            o.rms[0],
            o.rms[1],
            o.rms[2],
            o.rms[3],
            o.rms[4],
            o.held,
            o.mean_mbps,
            o.rate_changes,
            c.hop,
            c.asym,
            o.burst_delivery,
            o.burst_far,
            o.burst_s,
            o.cut_peak,
            o.cut_drops,
            o.delivery,
            o.lat_p50,
            o.lat_p95,
            o.lat_p99,
            o.bulk_s,
            o.bulk_frac,
            o.drops[0][0],
            o.drops[0][1],
            o.drops[0][2],
            o.drops[1][0],
            o.drops[1][2],
            o.drops[2][0],
            o.drops[2][2],
            o.peak_relays[0],
            o.peak_relays[1],
            o.peak_relays[2],
            swarm_net::mesh::RELAY_LEN,
            o.store_peak[1],
            o.store_peak[2],
            o.spilled,
            o.airtime,
            o.page_from_custodian,
            o.sync_s,
            MTU
        );
    }
}
