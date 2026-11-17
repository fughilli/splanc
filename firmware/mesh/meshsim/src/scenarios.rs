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
    assert!(w.nodes[GW].stack.unlock(t, 1, &rogue).is_err());
    let g = w.grant(GW, SESSION);
    assert!(w.nodes[GW].stack.unlock(t + 1_000_000, CONN, &g).is_err(), "locked out");
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
    let bl = splanc_mesh::ports::ControlHeader { op_id: 666, targets: Targets::All }.encode(b"set_effect evil", &mut body).unwrap();
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
