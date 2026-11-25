//! meshsim scenarios (design §14.1): the radiolarians' 6 fixtures, a late joiner, lossy links,
//! foreign and unauthenticated nodes, an insider forging commands, replays (live and after a
//! reboot), closed joins with and without the site secret, locked mode, removal + rotation
//! for 6 and 64 fixtures.
//!
//! Each prints a one-line summary (`--nocapture`) with the numbers the PR reports.

use splanc_mesh::admin::{self, Command, ENTRY_LEN};
use splanc_mesh::backhaul::NodeId;
use splanc_mesh::envelope::EPOCH_FIRST;
use splanc_mesh::link::{self, Frame};
use splanc_mesh::membership::{site_mesh_key, Credentials, Mode, Phase, ProvisionSource};
use splanc_mesh::ports::{Port, Targets};
use splanc_mesh::rekey::{RekeyHead, RekeyOrder, RekeyWraps};
use splanc_mesh::security::FrameGuard;
use splanc_mesh::stack::SendError;
use splanc_mesh::admin::UnlockError;
use swarm_net::mesh::{Header as MeshHeader, PacketOf, BROADCAST};

use super::*;

const SITE: [u8; 32] = [0x5a; 32];
const GW: usize = 0;
const CONN: usize = 0;
const SESSION: u32 = 1;

fn creds(w: &World) -> Credentials {
    Credentials { mesh_id: w.mesh_id, site_secret: Some(SITE), admin_key: Some(w.admin.public()), ..Credentials::default() }
}

fn id(i: usize) -> NodeId {
    0x1001 + i as NodeId
}

/// The radiolarians (§10.1): fixtures on a 3 m circle (3–6 m apart), in metal enclosures
/// (15 dB each way, an estimate until R0 measures it), clocks off by up to ~0.2 s and ±20 ppm.
fn room(n: usize, seed: u64) -> World {
    let mut w = World::new(RadioModel::default(), seed);
    for i in 0..n {
        let a = i as f64 * std::f64::consts::TAU / n as f64;
        let place = Placement {
            x_m: 3.0 * a.cos(),
            y_m: 3.0 * a.sin(),
            enclosure_db: 15.0,
            clock_offset_us: (i as i64 * 37_000) - 90_000,
            clock_ppm: (i as f64 * 8.0) - 20.0,
            ..Placement::at(0.0, 0.0)
        };
        w.add(id(i), place);
    }
    w
}

fn is_member(w: &World, i: usize) -> bool {
    w.nodes[i].stack.membership.is_member()
}

fn all_members(w: &World, idx: &[usize]) -> bool {
    idx.iter().all(|&i| is_member(w, i))
}

/// Power on `idx`, `stagger_ms` apart, and wait (≤ `max_ms`) until all are members.
fn form(w: &mut World, idx: &[usize], c: &Credentials, stagger_ms: i64, max_ms: i64) -> i64 {
    let t0 = w.now();
    for &i in idx {
        w.power_on(i, Some((c, ProvisionSource::Factory)));
        w.run_ms(stagger_ms);
    }
    let idx = idx.to_vec();
    w.run_until(max_ms, |w| all_members(w, &idx)).unwrap_or_else(|| {
        let phases: Vec<_> = idx.iter().map(|&i| w.nodes[i].stack.membership.phase()).collect();
        panic!("mesh did not form: {phases:?}")
    });
    (w.now() - t0) / 1_000
}

/// Send control `op` from the gateway; the global time it was sent.
fn control(w: &mut World, op: u32, t: Targets) -> i64 {
    let local = w.local(GW);
    w.nodes[GW].stack.send_control(local, CONN, op, t, b"set_uniforms{speed=0.5}").expect("control");
    w.now()
}

/// Send control `op` from gateway `gw`'s connection 0.
fn control_on(w: &mut World, gw: usize, op: u32, t: Targets) -> i64 {
    let local = w.local(gw);
    w.nodes[gw].stack.send_control(local, CONN, op, t, b"set_uniforms{speed=0.5}").expect("control");
    w.now()
}

/// Who got control `op` (index, count, latency ms of the first).
fn receivers(w: &World, op: u32, sent: i64) -> Vec<(usize, usize, f64)> {
    w.nodes
        .iter()
        .enumerate()
        .filter_map(|(i, n)| {
            let got: Vec<_> = n.controls().into_iter().filter(|c| c.2 == op).collect();
            (!got.is_empty()).then(|| (i, got.len(), (got[0].0 - sent) as f64 / 1_000.0))
        })
        .collect()
}

fn sum_guard(w: &World, f: impl Fn(&splanc_mesh::security::SecurityStats) -> u32) -> u32 {
    w.nodes.iter().map(|n| f(&n.stack.node.guard.stats)).sum()
}

/// What an insider does: a mesh packet with any origin it likes, sealed with the group key it
/// legitimately holds, put on the air from its own radio.
fn inject_as(w: &mut World, from: usize, origin: NodeId, port: Port, payload: &[u8]) {
    let h = MeshHeader { origin, id: 0xBEEF, dest: BROADCAST, hop_limit: 3, hop_start: 3, flags: 0, attempt: 0, port: port as u8 };
    let p = PacketOf::<P>::new(h, payload).unwrap();
    let mut body = [0u8; 256];
    let n = p.encode(&mut body).unwrap();
    let mut lf = [0u8; 300];
    let m = link::encode(w.nodes[from].id, Frame::Mesh(&body[..n]), &mut lf).unwrap();
    let mut sealed = [0u8; 300];
    let now = w.local(from);
    let k = w.nodes[from].stack.node.guard.seal(now, &lf[..m], &mut sealed).unwrap();
    w.air.inject(from, sealed[..k].to_vec());
}

#[test]
fn radiolarians_self_configure_and_take_control() {
    let mut w = room(6, 1);
    let all: Vec<usize> = (0..6).collect();
    let c = creds(&w);
    let formed_ms = form(&mut w, &all, &c, 300, 15_000);
    for n in &w.nodes {
        assert_eq!(n.stack.node.guard.epoch(), Some(EPOCH_FIRST));
    }
    w.run_ms(2_000);
    assert_eq!(sum_guard(&w, |s| s.bad_mic), 0);
    let rssi: Vec<f64> = (1..6).map(|j| w.air.rssi(0, j).unwrap()).collect();

    // A locked connection cannot command; a grant the admin did not sign locks unlocking out.
    let t = w.local(GW);
    assert_eq!(w.nodes[GW].stack.send_control(t, CONN, 1, Targets::All, b"x"), Err(SendError::Locked));
    let rogue = AdminSigner::from_secret(b"not-the-admin!!!", w.mesh_id).grant(w.mesh_id, 9, id(GW), w.nodes[GW].stack.dev.public_key(), 99_999);
    assert!(w.nodes[GW].stack.unlock(t, 1, &rogue, None).is_err());
    let g = w.grant(GW, SESSION);
    assert!(w.nodes[GW].stack.unlock(t + 1_000_000, CONN, &g, None).is_err(), "locked out");
    w.run_ms(2_100);
    let sync_ms = w.unlock_and_sync(GW, SESSION, &all, 10_000).expect("members confirm the session");
    for n in &w.nodes[1..] {
        assert_eq!(n.stack.sessions.stats.grants_verified, 1, "one ECDSA verify per session");
    }

    // One flood (one packet with 5 MACs) reaches every member once.
    let sent = control(&mut w, 1, Targets::All);
    w.run_ms(1_000);
    let got = receivers(&w, 1, sent);
    assert_eq!(got.iter().map(|g| g.0).collect::<Vec<_>>(), [1, 2, 3, 4, 5], "{got:?}");
    assert!(got.iter().all(|g| g.1 == 1), "exactly once: {got:?}");
    let max_lat = got.iter().map(|g| g.2).fold(0.0, f64::max);
    assert!(max_lat < 100.0, "{got:?}");

    // Groups (§7.7): fixtures 3 and 4 in group 7.
    let t = w.local(GW);
    w.nodes[GW].stack.assign_groups(t, CONN, id(3), &[7]).unwrap();
    w.nodes[GW].stack.assign_groups(t, CONN, id(4), &[7, 9]).unwrap();
    w.run_ms(1_000);
    assert_eq!(w.nodes[3].stack.membership.groups().as_slice(), &[7]);
    let sent = control(&mut w, 2, Targets::Group(7));
    w.run_ms(1_000);
    assert_eq!(receivers(&w, 2, sent).iter().map(|g| g.0).collect::<Vec<_>>(), [3, 4]);
    let sent = control(&mut w, 3, Targets::nodes(&[id(2), id(5)]).unwrap());
    w.run_ms(1_000);
    assert_eq!(receivers(&w, 3, sent).iter().map(|g| g.0).collect::<Vec<_>>(), [2, 5]);
    let t = w.local(GW);
    w.nodes[GW].stack.set_mode(t, CONN, Mode::Locked).unwrap();
    w.run_ms(1_000);
    assert!(w.nodes.iter().all(|n| n.stack.membership.mode() == Some(Mode::Locked)));

    let share = w.airtime_share();
    assert!(share < 0.10, "airtime {share}");
    let cmd_bytes = admin::COMMAND_HEADER + 5 * ENTRY_LEN;
    eprintln!(
        "radiolarians: formed in {formed_ms} ms; session synced in {sync_ms} ms; RSSI from fixture 0 {:.0}..{:.0} dBm; control to all 5 \
         in max {max_lat:.1} ms ({cmd_bytes} B of authority per command); airtime {:.1}% over {} s",
        rssi.iter().cloned().fold(f64::MAX, f64::min),
        rssi.iter().cloned().fold(f64::MIN, f64::max),
        share * 100.0,
        w.now() / 1_000_000
    );
}

#[test]
fn late_joiner() {
    let mut w = room(6, 2);
    let c = creds(&w);
    form(&mut w, &[0, 1, 2, 3, 4], &c, 100, 10_000);
    w.unlock_and_sync(GW, SESSION, &[1, 2, 3, 4], 10_000).unwrap();
    w.run_ms(20_000);
    w.power_on(5, Some((&c, ProvisionSource::Factory)));
    let ms = w.run_until(10_000, |w| is_member(w, 5)).expect("joins");
    assert!(ms <= 6_000, "{ms} ms (5 s search + an advert)");
    // It hears the grant (re-broadcast every 5 s), acks, is confirmed and added to the roster.
    let sync = w.run_until(10_000, |w| w.nodes[5].synced(SESSION)).expect("syncs");
    let sent = control(&mut w, 1, Targets::All);
    w.run_ms(1_000);
    assert!(receivers(&w, 1, sent).iter().any(|g| g.0 == 5));
    eprintln!("late joiner: a member {ms} ms after power-on, commandable {sync} ms later");
}

#[test]
fn lossy_links() {
    let mut w = room(6, 3);
    w.air.set_loss(0.3);
    let all: Vec<usize> = (0..6).collect();
    let c = creds(&w);
    form(&mut w, &all, &c, 100, 15_000);
    w.unlock_and_sync(GW, SESSION, &all, 20_000).expect("sync despite loss");
    let mut got = [0usize; 6];
    let n_ops = 20;
    for op in 0..n_ops {
        let sent = control(&mut w, 100 + op, Targets::All);
        w.run_ms(300);
        for g in receivers(&w, 100 + op, sent) {
            assert_eq!(g.1, 1, "once");
            got[g.0] += 1;
        }
    }
    w.run_ms(2_000);
    let ratio: Vec<f64> = got[1..].iter().map(|&g| g as f64 / n_ops as f64).collect();
    assert!(ratio.iter().all(|&r| r >= 0.9), "{ratio:?}");
    w.nodes[5].stack.send(id(GW), Port::Reply, b"\x00\x00\x00\x01ok", true).unwrap();
    let ms = w
        .run_until(3_000, |w| w.nodes[GW].events.iter().any(|(_, e)| matches!(e, Ev::Packet { port: Port::Reply, .. })))
        .expect("reply delivered");
    let s = w.air.stats();
    eprintln!("lossy (30% per reception): flood delivery per member {ratio:?}; acked reply in {ms} ms; {} of {} receptions lost", s.lost, s.lost + s.receptions);
}

#[test]
fn foreign_unauthenticated_and_insider_nodes_are_refused() {
    let mut w = room(9, 4);
    let members: Vec<usize> = (0..6).collect();
    let c = creds(&w);
    form(&mut w, &members, &c, 100, 10_000);
    // 6: same mesh id, wrong site secret. 7: another mesh. 8: holds the mesh key
    // (app-provisioned) but no admin public key.
    w.power_on(6, Some((&Credentials { site_secret: Some([0x01; 32]), ..c }, ProvisionSource::Factory)));
    let other = Credentials { mesh_id: w.mesh_id ^ 0xFFFF, site_secret: Some([0x02; 32]), ..c };
    w.power_on(7, Some((&other, ProvisionSource::Factory)));
    let keyed = Credentials { mesh_key: Some((EPOCH_FIRST, site_mesh_key(&SITE, w.mesh_id))), admin_key: None, site_secret: None, ..c };
    w.power_on(8, Some((&keyed, ProvisionSource::App)));
    w.run_ms(12_000);
    let mut everyone = members.clone();
    everyone.push(8);
    w.unlock_and_sync(GW, SESSION, &members, 10_000).unwrap();

    assert!(!is_member(&w, 6));
    assert!(w.nodes[6].stack.node.guard.stats.bad_mic > 0);
    assert!(w.nodes[GW].pending().iter().any(|p| p.node == id(6)), "listed for approval");
    assert!(is_member(&w, 7));
    assert!(sum_guard(&w, |s| s.foreign_mesh) > 0);
    // Node 8 cannot verify the grant (no admin key): never synced, never commanded.
    assert!(is_member(&w, 8) && !w.nodes[8].synced(SESSION));
    assert!(w.nodes[8].stack.sessions.stats.grants_rejected > 0);

    // Insider: member 1 holds the mesh key and its own session key. It forges a command
    // "from the gateway" for everyone, MAC'd with its own pairwise key, and a raw untagged one.
    let k1 = w.nodes[1].stack.sessions.get(SESSION).unwrap().key;
    let rec: Vec<(NodeId, [u8; 16])> = (1..6).map(|i| (id(i), k1)).collect();
    let mut body = [0u8; 64];
    let bl = splanc_mesh::ports::ControlHeader::new(666, Targets::All).encode(b"set_effect evil", &mut body).unwrap();
    let mut buf = [0u8; 256];
    let seq = u64::MAX / 2;
    let n = admin::seal_command(w.mesh_id, SESSION, seq, Port::Control as u8, &body[..bl], &rec, &mut buf).unwrap();
    inject_as(&mut w, 1, id(GW), Port::Control, &buf[..n]);
    inject_as(&mut w, 1, id(GW), Port::Control, b"\0\0\0\x09\0set_effect");
    w.run_ms(1_000);
    // (The insider itself accepts it: its own MAC entry is under its own key.)
    assert!(w.nodes.iter().enumerate().all(|(i, n)| i == 1 || n.controls().iter().all(|c| c.2 != 666)), "nobody else acted on a forgery");
    let bad_macs: u32 = w.nodes.iter().map(|n| n.stack.sessions.stats.bad_mac).sum();
    assert!(bad_macs >= 4, "{bad_macs}");
    // And the real gateway's control reaches the members (not 6, 7 or 8).
    // (Broadcast control is not retried: over three commands every member is reached, and
    // nobody outside the members ever is.)
    let mut reached = std::collections::BTreeSet::new();
    for op in 5..8 {
        let sent = control(&mut w, op, Targets::All);
        w.run_ms(1_000);
        reached.extend(receivers(&w, op, sent).iter().map(|g| g.0));
    }
    // Every honest member is reached, and nobody outside the members. (If the insider (1)
    // heard its own forgery relayed back, it took it — its own MAC entry is valid — and now
    // refuses the gateway's real commands as stale: it only hurts itself.)
    let reached: Vec<usize> = reached.into_iter().collect();
    assert!([2, 3, 4, 5].iter().all(|i| reached.contains(i)), "{reached:?}");
    assert!(reached.iter().all(|i| (1..=5).contains(i)), "{reached:?}");
    eprintln!(
        "foreign/insider: bad MIC {} foreign-mesh {}; forged per-receiver MACs refused {bad_macs}; keyless member never synced",
        sum_guard(&w, |s| s.bad_mic),
        sum_guard(&w, |s| s.foreign_mesh)
    );
}

#[test]
fn replayed_frames_are_rejected_live_and_after_a_reboot() {
    let mut w = room(6, 5);
    let all: Vec<usize> = (0..6).collect();
    let c = creds(&w);
    form(&mut w, &all, &c, 100, 10_000);
    w.unlock_and_sync(GW, SESSION, &all, 10_000).unwrap();
    let mark = w.air.sniffed().len();
    let sent = control(&mut w, 7, Targets::All);
    w.run_ms(1_000);
    assert_eq!(receivers(&w, 7, sent).len(), 5);
    let captured: Vec<Sniffed> = w.air.sniffed()[mark..].to_vec();
    let dup0 = sum_guard(&w, |s| s.replay_duplicate);
    for f in &captured {
        w.air.inject(f.from, f.bytes.clone());
    }
    w.run_ms(1_000);
    assert!(receivers(&w, 7, sent).iter().all(|g| g.1 == 1), "acted on once");
    let dup = sum_guard(&w, |s| s.replay_duplicate) - dup0;
    assert!(dup > 0);

    // Fixture 3 reboots: no replay state, no session. A minute later the attacker replays
    // the captured control. The frames may pass the envelope (no state for the sender), but
    // the command is held, the grant re-synced, and the old sequence refused.
    let rebooted_at = w.now();
    w.reboot(3);
    w.run_until(10_000, |w| is_member(w, 3)).unwrap();
    w.run_ms(60_000);
    let before = w.nodes[3].stack.sessions.stats.stale;
    for f in &captured {
        w.air.inject(f.from, f.bytes.clone());
    }
    w.run_ms(5_000);
    assert!(w.nodes[3].synced(SESSION), "re-synced through the held command");
    assert!(w.nodes[3].controls().iter().all(|c| c.0 < rebooted_at), "the rebooted node never acted on the replay");
    let stale = w.nodes[3].stack.sessions.stats.stale - before;
    assert!(receivers(&w, 7, sent).iter().all(|g| g.1 == 1));
    // And real commands work again.
    let sent = control(&mut w, 8, Targets::All);
    w.run_ms(1_000);
    assert!(receivers(&w, 8, sent).iter().any(|g| g.0 == 3));
    let g3 = w.nodes[3].stack.node.guard.stats;
    eprintln!(
        "replay: {} frames replayed; {dup} duplicates refused live; after a reboot: {} short-header frames dropped (no state), {} replays refused by restored/learned windows, {stale} held commands refused as stale; nothing acted on",
        captured.len(),
        g3.unsynced_short,
        g3.replay_duplicate + g3.replay_too_old
    );
}

#[test]
fn closed_join_with_and_without_the_secret() {
    let mut w = room(6, 6);
    let c = creds(&w);
    let rotated = Credentials { mesh_key: Some((2, [0x22; 16])), ..c };
    for i in 0..4 {
        w.power_on(i, Some((&rotated, ProvisionSource::App)));
    }
    w.run_ms(3_000);
    w.power_on(4, Some((&c, ProvisionSource::Factory)));
    let ms = w.run_until(12_000, |w| is_member(w, 4)).expect("joins with the secret");
    let s4 = w.nodes[4].stack.membership.state.unwrap();
    assert_eq!((s4.epoch, s4.mesh_key), (2, [0x22; 16]));
    let bare = Credentials { mesh_id: w.mesh_id, ..Credentials::default() };
    w.power_on(5, Some((&bare, ProvisionSource::Factory)));
    w.run_ms(15_000);
    assert_eq!(w.nodes[5].stack.membership.phase(), Phase::Joining);
    let p = *w.nodes[GW].pending().iter().find(|p| p.node == id(5)).expect("the gateway lists it");
    w.unlock_and_sync(GW, SESSION, &[1, 2, 3, 4], 10_000).unwrap();
    let t = w.local(GW);
    w.nodes[GW].stack.admit(t, CONN, &p).unwrap();
    let ams = w.run_until(10_000, |w| is_member(w, 5)).expect("admitted");
    assert_eq!(w.nodes[5].stack.membership.admin_key(), Some(&w.admin.public()), "admin key delivered, authenticated");
    w.run_until(10_000, |w| w.nodes[5].synced(SESSION)).expect("syncs");
    let sent = control(&mut w, 9, Targets::All);
    w.run_ms(1_000);
    assert_eq!(receivers(&w, 9, sent).iter().map(|g| g.0).collect::<Vec<_>>(), [1, 2, 3, 4, 5]);
    eprintln!("closed join: with the secret in {ms} ms; without, admitted {ams} ms after the admin's tap");
}

#[test]
fn locked_mode_rejects_an_unapproved_device() {
    let mut w = room(6, 7);
    let c = creds(&w);
    let locked = Credentials { mode: Mode::Locked, mesh_key: Some((3, [0x33; 16])), ..c };
    for i in 0..5 {
        w.power_on(i, Some((&locked, ProvisionSource::App)));
    }
    w.run_ms(2_000);
    w.power_on(5, Some((&c, ProvisionSource::Factory)));
    w.run_ms(15_000);
    assert!(!is_member(&w, 5));
    let not_allowed: u32 = w.nodes.iter().map(|n| n.stack.membership.stats.not_allowed).sum();
    assert!(not_allowed > 0);
    let p = *w.nodes[GW].pending().iter().find(|p| p.node == id(5)).expect("pending at the gateway");
    // A forged admit (an insider's group-key packet "from the gateway") does nothing.
    inject_as(&mut w, 1, id(GW), Port::Membership, &[0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 9, 0, 0x10, 0x10, 0x06, 0, 0, 0, 0, 0, 0, 0, 0]);
    w.run_ms(3_000);
    assert!(!is_member(&w, 5));
    w.unlock_and_sync(GW, SESSION, &[1, 2, 3, 4], 10_000).unwrap();
    let t = w.local(GW);
    w.nodes[GW].stack.admit(t, CONN, &p).unwrap();
    w.run_until(10_000, |w| is_member(w, 5)).expect("admitted");
    assert!(w.nodes[..5].iter().all(|n| n.stack.membership.state.unwrap().allow.contains(&p.key_hash)));
    eprintln!("locked: refused {not_allowed} requests with a valid site secret until approved");
}

/// Remove a fixture: one signed order, new mesh key and site secret, per-member wraps; the
/// removed one is left on the old epoch and refused at join.
fn removal(n: usize, grid: bool, seed: u64) -> (i64, usize, usize, u32) {
    let mut w = if grid {
        let mut w = World::new(RadioModel::default(), seed);
        let side = (n as f64).sqrt().ceil() as usize;
        for i in 0..n {
            let mut p = Placement::at((i % side) as f64 * 4.0, (i / side) as f64 * 4.0);
            p.enclosure_db = 15.0;
            p.clock_offset_us = ((i as i64 * 7_919) % 1_000_000) - 500_000;
            p.clock_ppm = ((i as f64 * 13.0) % 40.0) - 20.0;
            w.add(id(i), p);
        }
        w
    } else {
        room(n, seed)
    };
    let all: Vec<usize> = (0..n).collect();
    let c = creds(&w);
    form(&mut w, &all, &c, 0, 30_000);
    if w.unlock_and_sync(GW, SESSION, &all, 90_000).is_none() {
        let synced = all.iter().filter(|&&i| w.nodes[i].synced(SESSION)).count();
        let roster = w.nodes[GW].stack.gateway.as_ref().unwrap().len();
        let st = w.nodes[GW].stack.gateway.as_ref().unwrap().stats;
        let m = w.nodes[GW].stack.node.net.mesh.stats;
        panic!("roster incomplete: synced {synced}/{n}, roster {roster}, {st:?}, gw mesh {m:?}, air {:?}", w.air.stats());
    }
    let victim = n - 1;
    let removed = w.nodes[victim].stack.key_hash();
    let (mk, ss) = ([0xA5u8; 16], [0x5Au8; 32]);
    let order = RekeyOrder::sign(&w.admin, w.mesh_id, 2, &mk, &ss, 1, &[removed]);
    let t = w.local(GW);
    let mut evs = Vec::new();
    w.nodes[GW].stack.rotate(t, CONN, order, &mk, &ss, &[id(victim)], &mut |e| evs.push(Ev::from(e))).unwrap();
    let rest: Vec<usize> = (1..victim).collect();
    let t0 = w.now();
    let acked = w
        .run_until(60_000, |w| w.nodes[GW].stack.rekeyer.as_ref().unwrap().done_us.is_some())
        .unwrap_or_else(|| panic!("rotation did not converge: {} left", w.nodes[GW].stack.rekeyer.as_ref().unwrap().remaining()));
    let switched = w.run_until(30_000, |w| rest.iter().all(|&i| w.nodes[i].stack.node.guard.epoch() == Some(2))).expect("everyone switched");
    let ms = (w.now() - t0) / 1_000;
    eprintln!("  rekey {n}: all acked after {acked} ms, all sending under the new key after {ms} ms (+{switched})");
    assert_eq!(w.nodes[victim].stack.node.guard.epoch(), Some(1), "the removed fixture keeps the old key");
    let packets = 1 + (n - 2).div_ceil(splanc_mesh::rekey::WRAPS_PER_PACKET);
    let bytes = RekeyHead::LEN + (n - 2) * 26 + (packets - 1) * RekeyWraps::len_for(0);
    // After the 60 s overlap, the removed fixture cannot read control; its rejoin is refused.
    w.run_ms(61_000);
    let sent = control(&mut w, 42, Targets::All);
    w.run_ms(2_000);
    assert!(!receivers(&w, 42, sent).iter().any(|g| g.0 == victim));
    let revoked: u32 = w.nodes.iter().map(|n| n.stack.membership.stats.revoked).sum();
    (ms, bytes, packets, revoked)
}

#[test]
fn removal_rekey_6_fixtures() {
    let (ms, bytes, packets, revoked) = removal(6, false, 8);
    assert!(ms < 5_000, "{ms}");
    eprintln!("rekey 6 fixtures: converged in {ms} ms; {bytes} B in {packets} packets; removed fixture's rejoins refused {revoked}");
}

#[test]
fn removal_rekey_64_fixtures() {
    let (ms, bytes, packets, revoked) = removal(64, true, 9);
    assert!(ms < 20_000, "{ms}");
    eprintln!("rekey 64 fixtures (8x8 grid, 4 m): converged in {ms} ms; {bytes} B in {packets} packets; rejoins refused {revoked}");
}

/// Revocable access (docs/design/share-links.md): a delegate the admin key certified
/// administers the mesh through one gateway (its certificate travels ahead of its grant);
/// the owner, through another gateway, rotates the keys with the delegate on the revocation
/// list; every member drops the delegate's session, its gateway locks, and the delegate's
/// grant is refused from then on.
#[test]
fn a_delegate_administers_until_the_owner_revokes_it() {
    let n = 6;
    let mut w = room(n, 21);
    let all: Vec<usize> = (0..n).collect();
    let c = creds(&w);
    form(&mut w, &all, &c, 0, 30_000);

    let delegate = AdminSigner::from_secret(b"a delegate's key", w.mesh_id);
    let cert = w.admin.delegation(w.mesh_id, delegate.public(), admin::NO_EXPIRY);
    let local_s = (w.local(GW) / 1_000_000) as u32;
    let g = delegate.delegated_grant(w.mesh_id, SESSION, w.nodes[GW].id, w.nodes[GW].stack.dev.public_key(), local_s + 3600);

    // Without its certificate the gateway refuses the grant.
    let t = w.local(GW);
    assert_eq!(w.nodes[GW].stack.unlock(t, CONN, &g, None), Err(UnlockError::BadGrant));
    w.run_ms(2_100);
    let t = w.local(GW);
    w.nodes[GW].stack.unlock(t, CONN, &g, Some(&cert)).expect("a certified delegate's grant");
    let members: Vec<usize> = (1..n).collect();
    let ms = w.run_until(60_000, |w| members.iter().all(|&m| w.nodes[m].synced(SESSION))).expect("members synced to the delegate's session");
    let sent = control(&mut w, 41, Targets::All);
    w.run_ms(2_000);
    assert_eq!(receivers(&w, 41, sent).len(), n - 1, "the delegate commands every member");
    eprintln!("delegate: {} members synced in {ms} ms, commands reach all", n - 1);

    // The owner, on another gateway, revokes it with a key rotation.
    const OWNER_GW: usize = 1;
    const OWNER_SESSION: u32 = 2;
    w.unlock_and_sync(OWNER_GW, OWNER_SESSION, &all, 60_000).expect("owner session");
    let dh = splanc_mesh::crypto::key_hash(&delegate.public());
    let (mk, ss) = ([0xA6u8; 16], [0x6Au8; 32]);
    let order = RekeyOrder::sign(&w.admin, w.mesh_id, 2, &mk, &ss, 1, &[dh]);
    let t = w.local(OWNER_GW);
    w.nodes[OWNER_GW].stack.rotate(t, CONN, order, &mk, &ss, &[], &mut |_| {}).unwrap();
    let others: Vec<usize> = (0..n).filter(|&i| i != OWNER_GW).collect();
    w.run_until(60_000, |w| others.iter().all(|&i| !w.nodes[i].synced(SESSION))).expect("every member dropped the delegate's session");
    assert!(w.nodes[GW].stack.gateway.is_none(), "the delegate's gateway session is gone");
    assert!(!w.nodes[GW].stack.signing_session(CONN), "its connection is locked");
    assert!(w.nodes.iter().all(|x| x.stack.sessions.delegation(&dh).is_none()), "no member keeps its certificate");

    // Its grant (and a fresh one) is refused from now on; the owner still commands.
    w.run_ms(2_100);
    let t = w.local(GW);
    assert_eq!(w.nodes[GW].stack.unlock(t, CONN, &g, Some(&cert)), Err(UnlockError::BadGrant));
    let sent = control_on(&mut w, OWNER_GW, 43, Targets::All);
    w.run_ms(2_000);
    assert_eq!(receivers(&w, 43, sent).len(), n - 1, "the owner's session is untouched");
}

/// A command for 64 members takes several packets (per-receiver MACs).
#[test]
fn per_receiver_mac_cost() {
    for (n, body) in [(6usize, 20usize), (16, 20), (64, 20)] {
        let per = admin::recipients_per_packet(192, body);
        let packets = n.div_ceil(per);
        let bytes = packets * (admin::COMMAND_HEADER + body) + n * ENTRY_LEN;
        eprintln!("command to {n}: {packets} packet(s), {bytes} B ({} B of MACs)", n * ENTRY_LEN);
        assert!(Command::parse(&[0; 13]).is_some());
    }
}

/// Q11: the app renews the grant in the background before it expires; commands keep flowing
/// across the original expiry, and members only verify a signature (no new keys or acks).
#[test]
fn grant_renewal_keeps_a_live_show_running() {
    let mut w = room(6, 11);
    w.grant_ttl_s = 660; // renewal is due 600 s before expiry: after a minute
    let all: Vec<usize> = (0..6).collect();
    let c = creds(&w);
    form(&mut w, &all, &c, 0, 10_000);
    w.unlock_and_sync(GW, SESSION, &all, 10_000).unwrap();
    let mut sent = Vec::new();
    for op in 0..150u32 {
        sent.push((op, control(&mut w, 1000 + op, Targets::All)));
        w.run_ms(5_000);
    }
    let mut missing = 0;
    for (op, at) in &sent {
        missing += 5 - receivers(&w, 1000 + op, *at).len();
    }
    let renewals: u32 = w.nodes.iter().map(|n| n.stack.sessions.stats.renewals).sum();
    let expired: u32 = w.nodes.iter().map(|n| n.stack.sessions.stats.stale).sum();
    assert!(w.renewals >= 1 && renewals >= 5, "app {} members {renewals}", w.renewals);
    assert_eq!(expired, 0, "nothing refused as expired or stale");
    assert!(missing <= 4, "{missing} of 750 missing");
    let jobs: u32 = w.nodes.iter().map(|n| n.stack.crypto_jobs).sum();
    eprintln!("renewal: {} app renewals over 750 s, {renewals} member re-verifies, {jobs} crypto jobs in all (none per command); {missing}/750 commands missed", w.renewals);
}

/// Q15: the adaptive hop limit reaches the far end of a line that a fixed limit of 3 cannot.
#[test]
fn adaptive_hop_limit_reaches_the_end_of_a_line() {
    let mut out = Vec::new();
    for adaptive in [false, true] {
        let mut w = World::new(RadioModel::default(), 12);
        w.adaptive_hops = adaptive;
        w.hop_limit = 3;
        let n = 16;
        for i in 0..n {
            let mut p = Placement::at(i as f64 * 5.0, 0.0);
            p.enclosure_db = 15.0;
            w.add(id(i), p);
        }
        let c = Credentials { mesh_key: Some((1, [7; 16])), ..creds(&w) };
        for i in 0..n {
            w.power_on(i, Some((&c, ProvisionSource::App)));
        }
        w.run_ms(15_000);
        let all: Vec<usize> = (0..n).collect();
        w.unlock_and_sync(GW, SESSION, &all, 60_000);
        let mut far = 0;
        for op in 0..10 {
            let at = control(&mut w, 500 + op, Targets::All);
            w.run_ms(1_000);
            far += receivers(&w, 500 + op, at).iter().filter(|g| g.0 >= n - 3).count();
        }
        out.push((far, w.nodes[GW].stack.hop_limit(w.local(GW))));
    }
    assert_eq!(out[0].0, 0, "fixed 3 hops never reach the last three: {out:?}");
    assert!(out[1].0 >= 25, "adaptive reaches them: {out:?}");
    eprintln!("adaptive hops (line of 16, 5 m): fixed 3 reached the last 3 nodes {}/30 times; adaptive (limit {}) {}/30", out[0].0, out[1].1, out[1].0);
}

/// Q12: every node starts at the most robust rate and climbs while its neighbours keep
/// hearing it; with people walking through the room it backs off and control still gets
/// through.
#[test]
fn rate_adaptation_climbs_and_survives_walking() {
    let m = RadioModel { adaptive: true, walking: true, ..RadioModel::default() };
    let mut w = World::new(m, 13);
    for i in 0..6 {
        let a = i as f64 * std::f64::consts::TAU / 6.0;
        let mut p = Placement::at(3.0 * a.cos(), 3.0 * a.sin());
        p.enclosure_db = 10.0;
        w.add(id(i), p);
    }
    let all: Vec<usize> = (0..6).collect();
    let c = creds(&w);
    form(&mut w, &all, &c, 0, 10_000);
    w.unlock_and_sync(GW, SESSION, &all, 10_000).unwrap();
    w.run_ms(20_000);
    let mut got = 0;
    for op in 0..300u32 {
        let at = control(&mut w, 2000 + op, Targets::All);
        w.run_ms(33);
        let _ = at;
    }
    w.run_ms(1_000);
    for (i, n) in w.nodes.iter().enumerate() {
        if i != GW {
            got += n.controls().iter().filter(|c| c.2 >= 2000).count();
        }
    }
    let rates: Vec<f64> = (0..6).map(|i| Rate::LADDER[w.air.rate_ctl(i).ix].mbps()).collect();
    let changes: u32 = (0..6).map(|i| w.air.rate_ctl(i).changes).sum();
    let ratio = got as f64 / 1500.0;
    assert!(rates.iter().all(|&r| r >= 6.0), "{rates:?}");
    assert!(ratio >= 0.98, "{ratio}");
    eprintln!("rate adaptation (6 fixtures, walking): rates now {rates:?} Mb/s, {changes} changes in {} s; 30 Hz control delivered {:.1}%", w.now() / 1_000_000, ratio * 100.0);
}

/// Mesh time and `apply_at` across the radiolarians (M4, §6): clocks off by up to ~0.2 s and
/// ±20 ppm, CSMA, collisions and RX-stamp jitter. Mesh time forms with no root, every member
/// maps one show epoch onto its own clock, and a scheduled change lands at one instant; a
/// member that reboots rejoins the running time (it never founds a second one).
#[test]
fn mesh_time_and_apply_at_skew() {
    use splanc_mesh::meshtime::SyncState;
    let mut w = room(6, 41);
    let all: Vec<usize> = (0..6).collect();
    let c = creds(&w);
    form(&mut w, &all, &c, 150, 20_000);
    w.run_ms(15_000);
    // The spread of mesh time across the members at one instant, sampled for 60 s.
    let spread = |w: &World| -> i64 {
        let m: Vec<i64> = (0..6).map(|i| w.nodes[i].stack.time.mesh_us(w.local(i))).collect();
        m.iter().max().unwrap() - m.iter().min().unwrap()
    };
    let mut worst = 0;
    let mut sum = 0;
    for _ in 0..120 {
        w.run_ms(500);
        let s = spread(&w);
        worst = worst.max(s);
        sum += s;
    }
    assert!((0..6).all(|i| w.nodes[i].stack.time.state == SyncState::Synced));
    // Node 0's app sets the show epoch 2 s ahead; a change is scheduled for epoch + 1.5 s.
    // On a mesh with an admin key the epoch is the admin session's (M7): node 0 holds one,
    // and the members take the epoch from its signed TIME_BASE.
    w.unlock_and_sync(0, SESSION, &all, 15_000).expect("session");
    let epoch_mesh = w.nodes[0].stack.time.mesh_us(w.local(0)) + 2_000_000;
    w.nodes[0].stack.originate_epoch(splanc_mesh::stack::EpochSource::Console, Some(epoch_mesh)).expect("console under a session");
    w.run_ms(2_000);
    let apply_mesh = epoch_mesh + 1_500_000;
    // Each member's local instant of the change, in global time.
    let mut global: Vec<i64> = Vec::new();
    for i in 0..6 {
        let n = &w.nodes[i].stack.time;
        assert_eq!(n.epoch.and_then(|e| e.epoch_mesh_us), Some(epoch_mesh), "node {i} has the epoch");
        let local_at = n.local_us(apply_mesh);
        // Invert the node's clock: local = g + off + g*ppm.
        let p = w.air.0.borrow().st[w.nodes[i].index].place;
        let g = ((local_at - p.clock_offset_us) as f64 / (1.0 + p.clock_ppm / 1e6)) as i64;
        global.push(g);
    }
    let skew = global.iter().max().unwrap() - global.iter().min().unwrap();
    // A member reboots: it rejoins the running time.
    w.reboot(3);
    w.run_ms(20_000);
    let t3 = &w.nodes[3].stack.time;
    assert!(t3.stats.joined >= 1 && t3.stats.founded == 0, "{:?}", t3.stats);
    let mut after = 0;
    for _ in 0..20 {
        w.run_ms(500);
        after = after.max(spread(&w));
    }
    println!(
        "mesh time (6 nodes): spread mean {} µs worst {worst} µs; apply_at skew {skew} µs; after a reboot worst {after} µs",
        sum / 120
    );
    assert!(worst < 200, "mesh time spread {worst} µs");
    assert!(skew < 200, "apply_at skew {skew} µs");
    assert!(after < 200, "after the reboot {after} µs");
}

/// Mesh M5 (§8.2) on a dev closed mesh (no admin key, desk #67): the gateway opens its session
/// on the envelope, fans control out, members answer per the relay allow-list, the gateway
/// aggregates; member status reaches the gateway; only the gateway's session starts epochs.
#[test]
fn gateway_fan_out_on_envelope_trust() {
    use splanc_mesh::gateway::{self, ReplyMsg, Status, StatusMsg};
    use splanc_mesh::stack::EpochSource;
    let mut w = room(3, 5);
    let all: Vec<usize> = (0..3).collect();
    let c = Credentials { mesh_id: w.mesh_id, site_secret: Some(SITE), ..Credentials::default() };
    form(&mut w, &all, &c, 300, 15_000);
    assert!(w.nodes.iter().all(|n| n.stack.envelope_trust()));
    // Not open yet: no control, no epoch from the app's connection.
    let t = w.local(GW);
    assert_eq!(w.nodes[GW].stack.send_control(t, CONN, 1, Targets::All, b"x"), Err(SendError::Locked));
    assert_eq!(w.nodes[GW].stack.originate_epoch(EpochSource::Connection(CONN), Some(5)), None);
    w.nodes[GW].stack.open_gateway(CONN).expect("envelope trust");
    assert!(w.nodes[GW].stack.originate_epoch(EpochSource::Connection(CONN), Some(5)).is_some());
    assert_eq!(w.nodes[GW].stack.originate_epoch(EpochSource::Connection(CONN + 1), Some(6)), None, "another connection");
    assert_eq!(w.nodes[1].stack.originate_epoch(EpochSource::Connection(CONN), Some(7)), None, "a member");
    // Status reaches the gateway.
    for (i, n) in w.nodes.iter_mut().enumerate() {
        n.stack.set_status(StatusMsg { firmware: 9, fps: 80, heap_free: 50_000 + i as u32, sync: 2, ..StatusMsg::default() });
    }
    w.run_ms(3_000);
    let listed: Vec<NodeId> = w.nodes[GW].stack.fanout.members.iter().flatten().filter(|m| m.status.is_some()).map(|m| m.node).collect();
    assert!(listed.contains(&id(1)) && listed.contains(&id(2)), "{listed:?}");

    // Members answer every control they get, as the firmware does (mesh_ffi).
    let answer = |w: &mut World, seen: &mut std::collections::BTreeSet<(usize, u32)>| {
        for i in 1..3 {
            let ctls = w.nodes[i].controls();
            for (_, origin, op, inner) in ctls {
                if !seen.insert((i, op)) {
                    continue;
                }
                let (status, arm, code) = match gateway::relay_arm(&inner) {
                    Ok(a) => (Status::Ok, a as u8, 0),
                    Err(r) => (Status::Refused, gateway::client_arm(&inner).map_or(0, |a| a.0 as u8), r.code()),
                };
                w.nodes[i].stack.reply(origin, &ReplyMsg { op_id: op, status, arm, code }).expect("reply");
            }
        }
    };
    let mut seen = std::collections::BTreeSet::new();
    let brightness: &[u8] = &[0xfa, 0x01, 5, 0x0d, 0, 0, 0, 0x3f];
    let rename: &[u8] = &[0xda, 0x01, 3, 0x0a, 1, b'x'];
    let mut results = Vec::new();
    for (op, inner, arm) in [(10u32, brightness, 31u8), (11, rename, 27)] {
        let t = w.local(GW);
        let expect = w.nodes[GW].stack.send_control_collect(t, CONN, op, Targets::All, inner, arm, 2_000_000).expect("send");
        assert_eq!(expect, 2);
        let mut got = None;
        for _ in 0..300 {
            w.run_ms(10);
            answer(&mut w, &mut seen);
            if let Some(r) = w.nodes[GW].stack.fanout.take_done() {
                got = Some(r);
                break;
            }
        }
        let r = got.expect("a result");
        assert!(r.complete, "every member answered: {r:?}");
        results.push(r);
    }
    assert!(results[0].status[..2].iter().all(|s| *s == Status::Ok));
    assert!(results[1].status[..2].iter().all(|s| *s == Status::Refused));
    assert!(results[1].code[..2].iter().all(|c| *c == 27));
    let lat: Vec<u16> = results[0].latency_ms[..2].to_vec();
    println!("gateway fan-out (3 nodes, envelope trust): answers in {lat:?} ms; refusals {:?}", &results[1].code[..2]);
    // A mesh holding an admin key refuses the envelope framing, even from the real gateway.
    let mut w2 = room(2, 6);
    let c2 = creds(&w2);
    form(&mut w2, &[0, 1], &c2, 300, 15_000);
    assert!(!w2.nodes[GW].stack.envelope_trust());
    assert!(w2.nodes[GW].stack.open_gateway(CONN).is_err());
    let mut body = [0u8; 64];
    let bl = splanc_mesh::ports::ControlHeader::new(77, Targets::All).encode(brightness, &mut body).unwrap();
    let mut buf = [0u8; 128];
    let n = admin::seal_command(w2.mesh_id, splanc_mesh::ports::SESSION_ENVELOPE, 1, Port::Control as u8, &body[..bl], &[], &mut buf).unwrap();
    inject_as(&mut w2, GW, id(GW), Port::Control, &buf[..n]);
    w2.run_ms(1_000);
    assert!(w2.nodes[1].controls().is_empty());
    assert_eq!(w2.nodes[1].stack.router.stats.untrusted, 1);
}

/// Mesh M7 (§7.3, §7.6, §7.9), the `mesh_join_admin` HITL's script on the simulated air: a
/// closed mesh forms from the site secret; a fixture without it cannot join until the admin
/// admits it; control and the show epoch need the admin's signed session (an insider with the
/// mesh key can do neither: envelope framing and beacon epochs are refused); a revocation
/// rotates the keys without the removed fixture and survives a reboot (through the persisted
/// bytes); an eject sends one fixture out.
#[test]
fn join_admin_closed_mesh() {
    use splanc_mesh::meshtime::ShowEpoch;
    use splanc_mesh::stack::EpochSource;
    let mut w = room(3, 11);
    let c = creds(&w);
    let formed_ms = form(&mut w, &[0, 1], &c, 300, 15_000);
    assert!(!w.nodes[GW].stack.envelope_trust(), "an admin key: signed sessions only");
    // c knows the mesh and the admin key, not the site secret: it asks, and waits.
    let bare = Credentials { mesh_id: w.mesh_id, admin_key: Some(w.admin.public()), ..Credentials::default() };
    w.power_on(2, Some((&bare, ProvisionSource::App)));
    w.run_ms(15_000);
    assert_eq!(w.nodes[2].stack.membership.phase(), Phase::Joining, "unapproved: not a member");
    assert_eq!(w.nodes[2].stack.node.guard.epoch(), None, "holds no mesh key");
    let p = *w.nodes[GW].pending().iter().find(|p| p.node == id(2)).expect("the gateway lists it");
    assert_eq!(p.key_hash, w.nodes[2].stack.key_hash());
    assert!(w.nodes[GW].stack.membership.gateway_pending.iter().flatten().any(|q| q.node == id(2)));

    // Locked until a grant: no control, no admit, no epoch.
    let t = w.local(GW);
    assert_eq!(w.nodes[GW].stack.send_control(t, CONN, 1, Targets::All, b"x"), Err(SendError::Locked));
    assert_eq!(w.nodes[GW].stack.admit(t, CONN, &p), Err(SendError::Locked));
    assert_eq!(w.nodes[GW].stack.originate_epoch(EpochSource::Connection(CONN), Some(5)), None);
    assert_eq!(w.nodes[GW].stack.originate_epoch(EpochSource::Console, Some(5)), None, "the console too");
    // An insider (b, holding the mesh key) frames control for "the gateway" on envelope trust.
    let brightness: &[u8] = &[0xfa, 0x01, 5, 0x0d, 0, 0, 0, 0x3f];
    let mut body = [0u8; 64];
    let bl = splanc_mesh::ports::ControlHeader::new(66, Targets::All).encode(brightness, &mut body).unwrap();
    let mut buf = [0u8; 128];
    let n = admin::seal_command(w.mesh_id, splanc_mesh::ports::SESSION_ENVELOPE, 1, Port::Control as u8, &body[..bl], &[], &mut buf).unwrap();
    inject_as(&mut w, 1, id(1), Port::Control, &buf[..n]);
    w.run_ms(1_000);
    assert!(w.nodes[GW].controls().is_empty(), "refused");
    assert_eq!(w.nodes[GW].stack.router.stats.untrusted, 1);

    // The admin unlocks a, b syncs; the admin admits c; c joins (approval) and syncs too.
    let sync_ms = w.unlock_and_sync(GW, SESSION, &[1], 10_000).expect("b syncs");
    let t = w.local(GW);
    w.nodes[GW].stack.admit(t, CONN, &p).expect("admit");
    let admit_ms = w.run_until(15_000, |w| is_member(w, 2)).expect("admitted");
    assert_eq!(w.nodes[2].stack.membership.admin_key(), Some(&w.admin.public()));
    w.run_until(15_000, |w| w.nodes[2].synced(SESSION)).expect("c syncs");
    let sent = control(&mut w, 2, Targets::All);
    w.run_ms(1_000);
    assert_eq!(receivers(&w, 2, sent).iter().map(|g| g.0).collect::<Vec<_>>(), [1, 2]);

    // The show epoch: only a's session starts one, members take it from the signed TIME_BASE.
    let t = w.local(GW);
    let at = w.nodes[GW].stack.time.mesh_us(t) + 2_000_000;
    assert_eq!(w.nodes[1].stack.originate_epoch(EpochSource::Connection(CONN), Some(at)), None, "b holds no grant");
    let e = w.nodes[GW].stack.originate_epoch(EpochSource::Connection(CONN), Some(at)).expect("a's session");
    w.run_ms(2_000);
    for i in 1..3 {
        assert_eq!(w.nodes[i].stack.time.epoch, Some(e), "node {i} follows the signed epoch");
        assert!(w.nodes[i].stack.epochs_signed >= 1);
    }
    // b forges a later epoch into its beacons (what an insider's firmware could do): ignored.
    let forged = w.nodes[1].stack.time.originate(Some(at + 9_000_000));
    assert!(forged.newer_than(&e));
    w.run_ms(4_000);
    assert_eq!(w.nodes[GW].stack.time.epoch, Some(e));
    assert_eq!(w.nodes[2].stack.time.epoch, Some(e));
    assert!(w.nodes[2].stack.time.stats.unsigned >= 1);
    let _ = ShowEpoch::LEN;

    // Revoke c: a rotation to b only, c's key on the revocation list.
    let kh2 = w.nodes[2].stack.key_hash();
    let (mk, ss) = ([0x3cu8; 16], [0xc3u8; 32]);
    let order = RekeyOrder::sign(&w.admin, w.mesh_id, 2, &mk, &ss, 1, &[kh2]);
    let t = w.local(GW);
    w.nodes[GW].stack.rotate(t, CONN, order, &mk, &ss, &[id(2)], &mut |_| {}).expect("rotate");
    w.run_until(30_000, |w| w.nodes[1].stack.node.guard.epoch() == Some(2) && w.nodes[GW].stack.node.guard.epoch() == Some(2)).expect("a and b on epoch 2");
    assert_eq!(w.nodes[2].stack.node.guard.epoch(), Some(1), "c keeps the old key");
    w.run_ms(61_000);
    let sent = control(&mut w, 3, Targets::All);
    w.run_ms(1_500);
    assert_eq!(receivers(&w, 3, sent).iter().map(|g| g.0).collect::<Vec<_>>(), [1], "c gets nothing");
    let refused_before: u32 = (0..2).map(|i| w.nodes[i].stack.membership.stats.revoked).sum();
    assert!(refused_before > 0, "c's rejoin is refused");

    // Both members reboot: the revocation (and the new epoch) come back from the stored bytes.
    w.reboot(GW);
    w.reboot(1);
    w.run_until(15_000, |w| is_member(w, 0) && is_member(w, 1)).expect("back in the mesh");
    for i in 0..2 {
        let s = w.nodes[i].stack.membership.state.unwrap();
        assert_eq!((s.epoch, s.revoked.contains(&kh2)), (2, true), "node {i}");
    }
    w.run_ms(10_000);
    let refused_after: u32 = (0..2).map(|i| w.nodes[i].stack.membership.stats.revoked).sum();
    assert!(refused_after > 0, "still refused after the reboot");
    assert!(!is_member(&w, 2) || w.nodes[2].stack.node.guard.epoch() == Some(1));
    // The admin unlocks again (RAM sessions are gone) and b is commandable; c still is not.
    w.unlock_and_sync(GW, SESSION + 1, &[1], 15_000).expect("b syncs again");
    let t = w.local(GW);
    w.nodes[GW].stack.send_control(t, CONN, 4, Targets::All, b"set_uniforms{speed=0.5}").expect("control");
    let sent = w.now();
    w.run_ms(1_500);
    assert_eq!(receivers(&w, 4, sent).iter().map(|g| g.0).collect::<Vec<_>>(), [1]);

    // Eject b (issue #571's seam): it leaves the mesh and forgets it.
    let kh1 = w.nodes[1].stack.key_hash();
    let t = w.local(GW);
    w.nodes[GW].stack.eject(t, CONN, id(1), kh1).expect("eject");
    w.run_until(3_000, |w| w.nodes[1].stack.membership.state.is_none()).expect("ejected");
    assert!(w.nodes[1].events.iter().any(|(_, e)| *e == Ev::Ejected));
    // The gateway stops listing it at once (not after MEMBER_STALE_US).
    let t = w.local(GW);
    assert!(w.nodes[GW].stack.fanout.live(t).all(|m| m.node != id(1)), "the ejected member is still listed");
    eprintln!(
        "join_admin: closed mesh formed in {formed_ms} ms; b synced {sync_ms} ms after unlock; c admitted {admit_ms} ms after the tap; \
         insider control refused ({} untrusted), forged epoch ignored ({} unsigned); revocation refused {refused_before} rejoins, {refused_after} after a reboot",
        w.nodes[GW].stack.router.stats.untrusted,
        w.nodes[2].stack.time.stats.unsigned
    );
}

/// Bytes that look like an effect program (deterministic per seed).
fn effect_bytes(n: usize, seed: u8) -> Vec<u8> {
    (0..n).map(|i| ((i * 31 + i / 97) as u8) ^ seed).collect()
}

/// Mesh M6: a 3.5 KB effect (with a state blob for catch-ups) shared through the gateway
/// reaches every member, which all apply it on one show-clock instant; with 10 % loss too; a
/// fixture that joins later and one that reboots catch up with the current scene (the reboot
/// does not reload what it already shows).
#[test]
fn effect_share_and_late_joiner() {
    let mut w = room(4, 21);
    let c = creds(&w);
    form(&mut w, &[0, 1, 2], &c, 300, 15_000);
    w.unlock_and_sync(GW, SESSION, &[1, 2], 10_000).expect("b, c sync");
    w.run_until(10_000, |w| (0..3).all(|i| w.nodes[i].stack.time.synced())).expect("mesh time");

    let mut summary = Vec::new();
    for (round, (op, size, loss)) in [(100u32, 3_500usize, 0.0), (101, 4_400, 0.1)].into_iter().enumerate() {
        w.air.set_loss(loss);
        let effect = effect_bytes(size, round as u8);
        let state = effect_bytes(180, 0x55 ^ round as u8);
        let t0 = w.now();
        w.share_effect(GW, op, &effect, Some(&state)).expect("share");
        let ms = w.run_until(15_000, |w| (0..3).all(|i| w.nodes[i].applied.iter().any(|a| a.op_id == op))).unwrap_or_else(|| {
            let st: Vec<_> = (0..3).map(|i| (w.nodes[i].stack.blobs.fetching(), w.nodes[i].stack.blobs.stats)).collect();
            panic!("round {round}: not applied everywhere: {st:?}")
        });
        let apps: Vec<&Applied> = (0..3).map(|i| w.nodes[i].applied.iter().rev().find(|a| a.op_id == op).unwrap()).collect();
        let at = apps[0].mesh_ms;
        for (i, a) in apps.iter().enumerate() {
            assert_eq!(a.mesh_ms, at, "round {round} node {i}: the same show-clock instant");
            assert!(!a.late, "round {round} node {i}: had it in time");
        }
        let h = sha256(&effect);
        for i in 0..3 {
            assert_eq!(w.nodes[i].blobs.get(&h), Some(effect.as_slice()), "round {round} node {i}: the bytes");
            assert!(w.nodes[i].blobs.peak <= 2 * 4_608 + 400, "round {round} node {i}: blob RAM {}", w.nodes[i].blobs.peak);
        }
        let chunks: u32 = (0..3).map(|i| w.nodes[i].stack.blobs.stats.chunks_out).sum();
        summary.push(format!("round {round} ({size} B, loss {loss}): applied on all 3 at one instant {ms} ms after the share, {chunks} chunks sent"));
        let _ = t0;
    }
    w.air.set_loss(0.0);

    // A fixture powered on after the show started: it joins, syncs, and gets the scene.
    form(&mut w, &[3], &c, 0, 15_000);
    let ms = w.run_until(20_000, |w| w.nodes[3].applied.iter().any(|a| a.blobs.len() == 2)).expect("late joiner caught up");
    let a = w.nodes[3].applied.last().unwrap().clone();
    let scene = w.nodes[GW].scene.clone();
    assert_eq!(a.blobs, scene.iter().map(|b| b.0).collect::<Vec<_>>(), "effect and state");
    assert_eq!(a.skipped, 0);
    assert_eq!(w.nodes[3].blobs.get(&scene[0].0).map(|b| b.len()), Some(scene[0].1 as usize));

    // A member reboots: it rejoins and is caught up, without reloading the effect it shows.
    w.reboot(1);
    let before = w.nodes[1].applied.len();
    let rb = w.run_until(25_000, |w| w.nodes[1].applied.len() > before).expect("rebooted member caught up");
    let a = w.nodes[1].applied.last().unwrap();
    assert_eq!(a.skipped, 1, "the effect it already shows is not reloaded");
    assert_eq!(w.nodes[GW].stack.scenes_failed + w.nodes[1].stack.scenes_failed + w.nodes[3].stack.scenes_failed, 0);
    eprintln!("effect_share: {}; late joiner caught up {ms} ms after joining; rebooted member {rb} ms after its reboot (effect kept)", summary.join("; "));
}
