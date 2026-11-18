//! pimesh: probe and run the Splanc mesh on a Linux radio (docs/design/mesh-pi-transport.md
//! §5 has the hardware test plan that drives it).
//!
//!   pimesh caps   <if>                      what the radio/driver allows
//!   pimesh send   <if> [opts]               transmit probe frames, report errors
//!   pimesh listen <if> [opts]               print received Splanc frames
//!   pimesh pong   <if> [opts]               echo probes back (unicast to the sender)
//!   pimesh ping   <if> [opts]               send probes, measure round trips and loss
//!   pimesh node   <if> --id N [opts]        run a mesh node; --app-ms M broadcasts app data
//!
//! opts: --via brcm|nl80211|monitor|udp  --cat vendor|public  --count N  --interval-ms M
//!       --len L  --da MAC  --channel C  --dwell MS  --freq MHz  --rate KBPS  --secs S
//!       --mac MAC (monitor: our A2)

use std::collections::HashMap;
use std::io;
use std::time::{Duration, Instant};

use splanc_mesh::{Backhaul, Node, NodeConfig};
use splanc_mesh_linux::frame::{self, Category};
use splanc_mesh_linux::nl80211::{self, Nl80211};
use splanc_mesh_linux::radio::{BrcmActframe, BrcmRx, Monitor, Nl80211Mgmt, RawRadio, TxRecord};
use splanc_mesh_linux::sys;
use splanc_mesh_linux::udp::UdpRadio;
use splanc_mesh_linux::{WifiBackhaul, WifiConfig};

struct Opts {
    cmd: String,
    ifname: String,
    via: String,
    cat: Category,
    count: u32,
    interval_ms: u64,
    len: usize,
    da: Option<[u8; 6]>,
    channel: u32,
    dwell: u32,
    freq: Option<u32>,
    rate: u32,
    secs: u64,
    mac: Option<[u8; 6]>,
    id: u16,
    app_ms: u64,
    rx: BrcmRx,
    csv: bool,
}

fn opts() -> Opts {
    let a: Vec<String> = std::env::args().skip(1).collect();
    if a.len() < 2 {
        eprintln!("usage: pimesh caps|send|listen|ping|pong|node <ifname> [opts] (see source header)");
        std::process::exit(2);
    }
    let mut o = Opts {
        cmd: a[0].clone(),
        ifname: a[1].clone(),
        via: "brcm".into(),
        cat: Category::PublicVendor,
        count: 10,
        interval_ms: 100,
        len: 64,
        da: None,
        channel: 0,
        dwell: 0,
        freq: None,
        rate: 6_000,
        secs: 10,
        mac: None,
        id: 0,
        app_ms: 0,
        rx: BrcmRx::Tap,
        csv: false,
    };
    let mut i = 2;
    while i + 1 < a.len() + 1 && i < a.len() {
        let (k, v) = (a[i].as_str(), a.get(i + 1).cloned().unwrap_or_default());
        let num = || v.parse::<u64>().unwrap_or_else(|_| panic!("{k}: bad number {v:?}"));
        match k {
            "--via" => o.via = v.clone(),
            "--cat" => o.cat = if v == "vendor" { Category::Vendor } else { Category::PublicVendor },
            "--count" => o.count = num() as u32,
            "--interval-ms" => o.interval_ms = num(),
            "--len" => o.len = num() as usize,
            "--da" => o.da = sys::parse_mac(&v),
            "--channel" => o.channel = num() as u32,
            "--dwell" => o.dwell = num() as u32,
            "--freq" => o.freq = Some(num() as u32),
            "--rate" => o.rate = num() as u32,
            "--secs" => o.secs = num(),
            "--mac" => o.mac = sys::parse_mac(&v),
            "--id" => o.id = num() as u16,
            "--app-ms" => o.app_ms = num(),
            "--rx" => o.rx = if v == "nl" { BrcmRx::Nl80211 } else { BrcmRx::Tap },
            "--csv" => {
                o.csv = true;
                i -= 1; // a flag
            }
            _ => panic!("unknown option {k}"),
        }
        i += 2;
    }
    o
}

fn radio(o: &Opts) -> io::Result<Box<dyn RawRadio>> {
    Ok(match o.via.as_str() {
        "brcm" => Box::new(BrcmActframe::open(&o.ifname, o.cat, o.channel, o.dwell, o.rx)?),
        "nl80211" => Box::new(Nl80211Mgmt::open(&o.ifname, o.cat, o.freq)?),
        "monitor" => {
            let mac = o.mac.ok_or_else(|| io::Error::other("--mac required with --via monitor"))?;
            Box::new(Monitor::open(&o.ifname, mac, o.rate)?)
        }
        "udp" => Box::new(UdpRadio::multicast(o.mac.map_or_else(|| sys::mac_of(&o.ifname), Ok)?)?),
        v => return Err(io::Error::other(format!("unknown --via {v}"))),
    })
}

fn backhaul(o: &Opts) -> io::Result<WifiBackhaul<Box<dyn RawRadio>>> {
    let mtu = if o.via == "udp" { 1400 } else { 250 };
    let cfg = WifiConfig { cat: o.cat, mtu, rate_kbps: o.rate, max_duty: 0.5, ..WifiConfig::default() };
    Ok(WifiBackhaul::new(radio(o)?, cfg))
}

/// Probe payload: "PRB" kind(1: ping, 2: pong) seq u32 t_us u64, padded.
fn probe(kind: u8, seq: u32, t_us: u64, len: usize) -> Vec<u8> {
    let mut p = b"PRB".to_vec();
    p.push(kind);
    p.extend_from_slice(&seq.to_le_bytes());
    p.extend_from_slice(&t_us.to_le_bytes());
    p.resize(len.max(16), 0xa5);
    p
}

fn parse_probe(b: &[u8]) -> Option<(u8, u32, u64)> {
    (b.len() >= 16 && &b[..3] == b"PRB")
        .then(|| (b[3], u32::from_le_bytes(b[4..8].try_into().unwrap()), u64::from_le_bytes(b[8..16].try_into().unwrap())))
}

fn pct(v: &mut [u32], q: f64) -> u32 {
    v.sort_unstable();
    v.get(((v.len() as f64 - 1.0) * q).round() as usize).copied().unwrap_or(0)
}

/// Print a summary (and with --csv every record) of the radio's per-send log.
fn tx_report(o: &Opts, log: &[TxRecord]) {
    if log.is_empty() {
        return;
    }
    if o.csv {
        for r in log {
            println!("tx,{},{},{},{},{}", r.packet_id, r.call_us, r.cpu_us, r.complete_us, r.status as i64);
        }
    }
    let mut call: Vec<u32> = log.iter().map(|r| r.call_us).collect();
    let mut cpu: Vec<u32> = log.iter().map(|r| r.cpu_us).collect();
    let mut done: Vec<u32> = log.iter().filter(|r| r.status != u32::MAX).map(|r| r.complete_us).collect();
    let mut st: HashMap<i64, u32> = HashMap::new();
    for r in log {
        *st.entry(r.status as i64).or_default() += 1;
    }
    println!(
        "txlog n={} status={st:?} call_us p50={} p90={} p99={} cpu_us p50={} p90={} complete_us p50={} p90={} p99={}",
        log.len(),
        pct(&mut call, 0.5),
        pct(&mut call, 0.9),
        pct(&mut call, 0.99),
        pct(&mut cpu, 0.5),
        pct(&mut cpu, 0.9),
        pct(&mut done, 0.5),
        pct(&mut done, 0.9),
        pct(&mut done, 0.99)
    );
}

fn iovar(o: &Opts, name: &str) -> io::Result<()> {
    let mut r = BrcmActframe::open(&o.ifname, o.cat, 1, 0, BrcmRx::Nl80211)?;
    let mut t = Vec::new();
    let mut last = Vec::new();
    for _ in 0..o.count {
        let s = Instant::now();
        last = r.iovar_get(name, o.len.max(4))?;
        t.push(s.elapsed().as_micros() as u32);
    }
    let hex: String = last.iter().take(64).map(|b| format!("{b:02x}")).collect();
    println!("iovar {name} len={} first64={hex} get_us p50={} p90={} min={}", last.len(), pct(&mut t.clone(), 0.5), pct(&mut t.clone(), 0.9), t.iter().min().unwrap_or(&0));
    Ok(())
}

fn caps(o: &Opts) -> io::Result<()> {
    let ifindex = sys::ifindex(&o.ifname)?;
    let mut nl = Nl80211::open()?;
    let (wiphy, iftype, freq) = nl.interface(ifindex)?;
    let c = nl.caps(wiphy)?;
    let driver = std::fs::read_link(format!("/sys/class/net/{}/device/driver", o.ifname))
        .ok()
        .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    println!("if={} ifindex={ifindex} mac={} driver={driver} phy={} iftype={iftype} freq={freq:?}", o.ifname, sys::fmt_mac(&sys::mac_of(&o.ifname)?), c.name);
    println!("iftypes={:?} monitor={}", c.iftypes, c.monitor());
    println!("action_tx_iftypes={:?} action_rx_iftypes={:?}", c.action_tx, c.action_rx);
    println!("cmd_frame={} cmd_remain_on_channel={} vendor_cmds={:?}", c.commands.contains(&nl80211::CMD_FRAME), c.commands.contains(&nl80211::CMD_REMAIN_ON_CHANNEL), c.vendor);
    println!("ext_mgmt_tx_random_ta={}", c.ext(nl80211::EXT_FEATURE_MGMT_TX_RANDOM_TA));
    for cat in [Category::Vendor, Category::PublicVendor] {
        let r = nl.register_action(ifindex, cat.prefix());
        println!("register_action({cat:?})={r:?}");
    }
    Ok(())
}

fn send(o: &Opts) -> io::Result<()> {
    let mut bh = backhaul(o)?;
    let t0 = Instant::now();
    let (mut ok, mut err) = (0, 0);
    let mut errs: HashMap<String, u32> = HashMap::new();
    let mut call_us: Vec<u32> = Vec::new();
    for seq in 0..o.count {
        let t = t0.elapsed().as_micros() as i64;
        bh.set_now(t);
        let p = probe(1, seq, t as u64, o.len);
        let f = {
            let mut b = vec![0u8; 2400];
            let n = frame::encode(o.cat, o.da.unwrap_or(frame::BROADCAST), bh.mac(), seq as u16, &p, &mut b).unwrap();
            b.truncate(n);
            b
        };
        let s = Instant::now();
        match bh.radio.send(&f) {
            Ok(()) => ok += 1,
            Err(e) => {
                err += 1;
                *errs.entry(e.to_string()).or_default() += 1;
            }
        }
        call_us.push(s.elapsed().as_micros() as u32);
        if seq < 3 {
            println!("send seq={seq} took_us={}", s.elapsed().as_micros());
        }
        let mut buf = [0u8; 2400];
        while bh.recv(&mut buf).is_some() {}
        std::thread::sleep(Duration::from_millis(o.interval_ms));
    }
    std::thread::sleep(Duration::from_millis(200));
    let mut buf = [0u8; 2400];
    while bh.recv(&mut buf).is_some() {}
    println!("sent ok={ok} err={err} errors={errs:?} stats={:?}", bh.stats);
    println!("send_call_us p50={} p90={} p99={} max={}", pct(&mut call_us, 0.5), pct(&mut call_us, 0.9), pct(&mut call_us, 0.99), pct(&mut call_us, 1.0));
    let log = bh.radio.take_tx_log();
    tx_report(o, &log);
    Ok(())
}

fn listen(o: &Opts, pong: bool) -> io::Result<()> {
    let mut bh = backhaul(o)?;
    let t0 = Instant::now();
    let mut buf = [0u8; 2400];
    let mut n = 0u32;
    let mut rssis: Vec<i32> = Vec::new();
    while t0.elapsed() < Duration::from_secs(o.secs) {
        let t = t0.elapsed().as_micros() as i64;
        bh.set_now(t);
        let mut idle = true;
        while let Some(m) = bh.recv(&mut buf) {
            idle = false;
            n += 1;
            let p = parse_probe(&buf[..m.len]);
            rssis.push(m.rssi_dbm as i32);
            if o.csv {
                println!("rx,{},{},{}", p.map_or(-1, |x| x.1 as i64), m.rssi_dbm, t);
            }
            if !o.csv && (n <= 20 || n % 100 == 0) {
                println!("rx t_ms={} from={} len={} rssi={} probe={p:?}", t / 1000, sys::fmt_mac(&m.src_mac), m.len, m.rssi_dbm);
            }
            if let (true, Some((1, seq, ts))) = (pong, p) {
                let reply = probe(2, seq, ts, m.len);
                let mut b = vec![0u8; 2400];
                let k = frame::encode(o.cat, m.src_mac, bh.mac(), seq as u16, &reply, &mut b).unwrap();
                if let Err(e) = bh.radio.send(&b[..k]) {
                    println!("pong send error: {e}");
                }
            }
        }
        if idle {
            std::thread::sleep(Duration::from_micros(200));
        }
    }
    rssis.sort_unstable();
    let q = |f: f64| rssis.get(((rssis.len() as f64 - 1.0) * f).round() as usize).copied().unwrap_or(0);
    println!("received {n} rssi min={} p10={} p50={} p90={} max={} stats={:?}", q(0.0), q(0.1), q(0.5), q(0.9), q(1.0), bh.stats);
    let log = bh.radio.take_tx_log();
    tx_report(o, &log);
    Ok(())
}

fn ping(o: &Opts) -> io::Result<()> {
    let mut bh = backhaul(o)?;
    let t0 = Instant::now();
    let mut rtts = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut dups = 0u32;
    let mut buf = [0u8; 2400];
    let mut next = Duration::ZERO;
    let mut seq = 0u32;
    let deadline = Duration::from_millis(o.interval_ms * o.count as u64 + 1000);
    while t0.elapsed() < deadline {
        let now = t0.elapsed();
        bh.set_now(now.as_micros() as i64);
        if seq < o.count && now >= next {
            let p = probe(1, seq, now.as_micros() as u64, o.len);
            let mut b = vec![0u8; 2400];
            let k = frame::encode(o.cat, o.da.unwrap_or(frame::BROADCAST), bh.mac(), seq as u16, &p, &mut b).unwrap();
            if let Err(e) = bh.radio.send(&b[..k]) {
                println!("send error: {e}");
            }
            seq += 1;
            next = now + Duration::from_millis(o.interval_ms);
        }
        while let Some(m) = bh.recv(&mut buf) {
            if let Some((2, s, ts)) = parse_probe(&buf[..m.len]) {
                if !seen.insert(s) {
                    dups += 1;
                    continue;
                }
                let rtt = t0.elapsed().as_micros() as u64 - ts;
                rtts.push(rtt);
                if o.csv {
                    println!("rtt,{s},{rtt},{}", m.rssi_dbm);
                }
                if !o.csv && s < 5 {
                    println!("pong seq={s} rtt_us={rtt} rssi={}", m.rssi_dbm);
                }
            }
        }
        std::thread::sleep(Duration::from_micros(100));
    }
    rtts.sort_unstable();
    let pct = |q: f64| rtts.get(((rtts.len() as f64 - 1.0) * q).round() as usize).copied().unwrap_or(0);
    println!(
        "ping sent={seq} replies={} dups={dups} loss={:.1}% rtt_us p50={} p90={} p99={} max={}",
        rtts.len(),
        100.0 * (1.0 - rtts.len() as f64 / seq.max(1) as f64),
        pct(0.5),
        pct(0.9),
        pct(0.99),
        rtts.last().copied().unwrap_or(0)
    );
    let log = bh.radio.take_tx_log();
    tx_report(o, &log);
    Ok(())
}

struct RamFlash(Vec<u8>);
impl swarm_net::update::Flash for RamFlash {
    fn capacity(&self) -> u32 {
        self.0.len() as u32
    }
    fn erase(&mut self, o: u32, l: u32) -> bool {
        self.0[o as usize..(o + l) as usize].fill(0xFF);
        true
    }
    fn write(&mut self, o: u32, d: &[u8]) -> bool {
        self.0[o as usize..o as usize + d.len()].copy_from_slice(d);
        true
    }
    fn read(&mut self, o: u32, b: &mut [u8]) -> bool {
        b.copy_from_slice(&self.0[o as usize..o as usize + b.len()]);
        true
    }
}

/// A plain (M1, no envelope) mesh node: beacons, relays, and with --app-ms a numbered app
/// broadcast; prints what it hears. The fixed test keys are for bench use only.
fn node(o: &Opts) -> io::Result<()> {
    use swarm_net::net::{NetOf, PORT_APP};
    const P: usize = 200;
    let bh = backhaul(o)?;
    let net = NetOf::<P>::new(o.id, Some([5; swarm_net::crypto::HMAC_KEY_LEN]), swarm_net::crypto::signing::p256_public_key(&[6; 32]), 1, o.id as u32);
    let mut n = Node::new(net, bh, NodeConfig::default()).map_err(|e| io::Error::other(format!("{e:?}")))?;
    let mut flash = RamFlash(vec![0xFF; 8 * swarm_net::update::PAGE_SIZE]);
    let mut scratch = vec![0u8; n.scratch_len()];
    let t0 = Instant::now();
    let (mut next_app, mut next_report) = (Duration::ZERO, Duration::from_secs(1));
    let (mut app_seq, mut app_rx) = (0u32, HashMap::<u16, u32>::new());
    while t0.elapsed() < Duration::from_secs(o.secs) {
        let now = t0.elapsed();
        let t = now.as_micros() as i64;
        n.backhaul.set_now(t);
        n.tick(t, &mut flash, &mut scratch);
        if o.app_ms > 0 && now >= next_app {
            let _ = n.net.send(swarm_net::mesh::BROADCAST, PORT_APP, &app_seq.to_le_bytes(), false);
            app_seq += 1;
            next_app = now + Duration::from_millis(o.app_ms);
        }
        while let Some(a) = n.net.next_app() {
            *app_rx.entry(a.origin).or_default() += 1;
        }
        if now >= next_report {
            println!("t={}s node={} stats={:?} wifi={:?} app_sent={app_seq} app_rx={app_rx:?}", now.as_secs(), o.id, n.stats, n.backhaul.stats);
            next_report += Duration::from_secs(1);
        }
        std::thread::sleep(Duration::from_micros(500));
    }
    Ok(())
}

fn main() {
    let o = opts();
    let r = match o.cmd.as_str() {
        "caps" => caps(&o),
        "send" => send(&o),
        "listen" => listen(&o, false),
        "pong" => listen(&o, true),
        "ping" => ping(&o),
        "node" => node(&o),
        "iovar" => {
            let name = std::env::var("IOVAR").unwrap_or_else(|_| "ver".into());
            iovar(&o, &name)
        }
        c => Err(io::Error::other(format!("unknown command {c}"))),
    };
    if let Err(e) = r {
        eprintln!("pimesh {}: {e}", o.cmd);
        std::process::exit(1);
    }
}
