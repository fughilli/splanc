//! Model-vs-firmware agreement: the observation sequences the firmware produces
//! on the HITL scenarios (BLE Improv + wss e2e, wired provisioning, the loaded
//! TLS worst case with a sharded map upload + texture effect + session churn, a
//! capture over a running effect, link loss) are tracked through `step` with
//! ZERO refusals. A refusal here means the firmware does something the model
//! calls unreachable — fix whichever one is wrong, don't widen the model.

use ledmapper_sysmode::observe::{Observed, Refusal, Tracker};
use ledmapper_sysmode::{Activity, Ble, SysMode, Wifi};

/// Feed `seq` (each entry: a change applied to the running observation) and
/// return every refusal.
fn run(boot: SysMode, start: Observed, seq: &[&dyn Fn(&mut Observed)]) -> (Tracker, Vec<Refusal>) {
    let mut t = Tracker::new(boot);
    let mut o = start;
    let mut refused = Vec::new();
    t.observe(o, |r| refused.push(r));
    for f in seq {
        f(&mut o);
        t.observe(o, |r| refused.push(r));
    }
    (t, refused)
}

fn assert_tracks(t: &Tracker, refused: &[Refusal]) {
    assert!(
        refused.is_empty(),
        "the model refused the firmware: {refused:#?}"
    );
    assert_eq!(t.stats.refused + t.stats.unmodeled, 0);
}

/// BLE Improv provisioning, then the app's wss session (the e2e_netstack path):
/// the firmware drops the provisioning link when the wss client appears and the
/// central's disconnect lands a moment later.
fn provision_then_wss() -> Vec<&'static dyn Fn(&mut Observed)> {
    vec![
        &|o| o.ble_connected = true,
        &|o| o.creds = true,
        &|o| o.leased = true,
        &|o| o.wss = true,
        &|o| o.ble_connected = false,
    ]
}

#[test]
fn e2e_improv_then_wss() {
    let (t, r) = run(
        SysMode::BOOT_UNPROVISIONED,
        Observed::default(),
        &provision_then_wss(),
    );
    assert_tracks(&t, &r);
    assert_eq!(
        (t.state.wifi, t.state.ble, t.state.wss),
        (Wifi::Joined, Ble::Advertising, true)
    );
}

#[test]
fn wired_provisioning_without_a_central() {
    let seq: Vec<&dyn Fn(&mut Observed)> =
        vec![&|o| o.creds = true, &|o| o.leased = true, &|o| o.wss = true];
    let (t, r) = run(SysMode::BOOT_UNPROVISIONED, Observed::default(), &seq);
    assert_tracks(&t, &r);
    assert!(t.state.wss);
}

/// The ram_audit / loaded_tls worst case: provision, wss, a sharded 512-LED map
/// upload, a texture-sampling effect with streamed frames, then fresh wss
/// sessions on the loaded heap with a BLE central reconnecting (PR-38).
#[test]
fn loaded_tls_worst_case() {
    let mut seq = provision_then_wss();
    seq.extend::<[&dyn Fn(&mut Observed); 12]>([
        &|o| o.upload = true,
        &|o| {
            o.upload = false;
            o.map = true;
        },
        &|o| o.effect = true,
        &|o| o.video = true,
        &|o| o.video = false,
        &|o| o.wss = false,
        &|o| o.wss = true,
        &|o| o.ble_connected = true, // a central alongside the session
        &|o| o.video = true,
        // The session ends: so does the stream (video is "frames over wss"); BLE stays.
        &|o| {
            o.wss = false;
            o.video = false;
        },
        &|o| o.wss = true,
        &|o| o.ble_connected = false,
    ]);
    let (t, r) = run(SysMode::BOOT_UNPROVISIONED, Observed::default(), &seq);
    assert_tracks(&t, &r);
    assert_eq!(t.state.activity, Activity::Effect { video: false, deck_b: false });
    assert!(t.state.map);
}

/// A capture over a running effect parks it; the effect resumes when the
/// capture stops (the app is still connected).
#[test]
fn capture_parks_then_resumes_the_effect() {
    let mut seq = provision_then_wss();
    seq.extend::<[&dyn Fn(&mut Observed); 4]>([
        &|o| o.map = true, // single-frame submit_map
        &|o| o.effect = true,
        &|o| o.mapping = true, // effect stays loaded underneath
        &|o| o.mapping = false,
    ]);
    let (t, r) = run(SysMode::BOOT_UNPROVISIONED, Observed::default(), &seq);
    assert_tracks(&t, &r);
    assert_eq!(t.state.activity, Activity::Effect { video: false, deck_b: false });
}

/// The AP drops us mid-session: the lease and the TCP session die in the same
/// poll; the netstack rejoins in place.
#[test]
fn link_loss_mid_session() {
    let mut seq = provision_then_wss();
    seq.extend::<[&dyn Fn(&mut Observed); 3]>([
        &|o| {
            o.leased = false;
            o.wss = false;
        },
        &|o| o.leased = true,
        &|o| o.wss = true,
    ]);
    let (t, r) = run(SysMode::BOOT_UNPROVISIONED, Observed::default(), &seq);
    assert_tracks(&t, &r);
    assert!(t.state.wss);
}

/// Restored boot (stored map + effect, no credentials: they are RAM-only), then
/// the BLE player transport drives it before any WiFi.
#[test]
fn restored_boot_over_ble() {
    let start = Observed {
        map: true,
        effect: true,
        ..Default::default()
    };
    let seq: Vec<&dyn Fn(&mut Observed)> =
        vec![&|o| o.ble_connected = true, &|o| o.effect = false, &|o| {
            o.effect = true
        }];
    let (t, r) = run(SysMode::BOOT_RESTORED, start, &seq);
    assert_tracks(&t, &r);
}

/// The check has teeth: a session with no network is refused (and forced, so
/// the tracker keeps following the device).
#[test]
fn an_unreachable_observation_is_refused() {
    let seq: Vec<&dyn Fn(&mut Observed)> = vec![&|o| o.wss = true];
    let (t, r) = run(SysMode::BOOT_UNPROVISIONED, Observed::default(), &seq);
    assert_eq!(r.len(), 1, "{r:#?}");
    assert_eq!(t.stats.refused, 1);
    assert!(t.state.wss, "forced to the observed state");
}

/// A Show Mode session over wss: video streams into deck A, then deck B is cued
/// (the stream stops: deck B takes the aux region), crossfaded, and freed; the
/// stream may resume once deck B is gone.
#[test]
fn show_mode_deck_b_evicts_video() {
    let mut seq = provision_then_wss();
    seq.extend::<Vec<&dyn Fn(&mut Observed)>>(vec![
        &|o| o.effect = true,
        &|o| o.video = true,
        // Deck B loads: set_texture is dropped from here, so the stream goes quiet.
        &|o| o.deck_b = true,
        &|o| o.video = false,
        &|o| o.deck_b = false,
        &|o| o.video = true,
        &|o| o.video = false,
    ]);
    let (t, r) = run(SysMode::BOOT_UNPROVISIONED, Observed::default(), &seq);
    assert_tracks(&t, &r);
    assert_eq!(t.state.activity, Activity::Effect { video: false, deck_b: false });
}
