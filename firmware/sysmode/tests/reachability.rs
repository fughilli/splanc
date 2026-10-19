//! Exhaustive reachability of the memory-mode state machine: BFS from every
//! boot state over every event visits ALL reachable states (explicit-state
//! model checking), then asserts the invariants and the RAM budget in each.
//! `--nocapture` prints the per-state live-bytes table and the worst states.

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use ledmapper_sysmode::{
    components, cost, heap_bytes, is_quiescent, live_bytes, step, Activity, Ble, Event, SysMode,
    Wifi,
};

const BOOTS: [SysMode; 2] = [SysMode::BOOT_UNPROVISIONED, SysMode::BOOT_RESTORED];

/// Every reachable state -> one (predecessor, event) that first reached it.
fn explore() -> BTreeMap<SysMode, Option<(SysMode, Event)>> {
    let mut seen = BTreeMap::new();
    let mut q = VecDeque::new();
    for b in BOOTS {
        seen.insert(b, None);
        q.push_back(b);
    }
    while let Some(s) = q.pop_front() {
        for e in Event::ALL {
            if let Ok(n) = step(s, e) {
                if !seen.contains_key(&n) {
                    seen.insert(n, Some((s, e)));
                    q.push_back(n);
                }
            }
        }
    }
    seen
}

/// The shortest event trace from a boot state to `s` (for failure messages).
fn trace(seen: &BTreeMap<SysMode, Option<(SysMode, Event)>>, mut s: SysMode) -> Vec<Event> {
    let mut t = Vec::new();
    while let Some(Some((prev, e))) = seen.get(&s) {
        t.push(*e);
        s = *prev;
    }
    t.reverse();
    t
}

fn worst(
    seen: &BTreeMap<SysMode, Option<(SysMode, Event)>>,
    f: fn(SysMode) -> usize,
) -> (SysMode, usize) {
    seen.keys().map(|&s| (s, f(s))).max_by_key(|x| x.1).unwrap()
}

fn describe(s: SysMode) -> String {
    let parts: Vec<String> = components(s).map(|c| format!("{}={}", c.name, c.bytes)).collect();
    format!("{s:?}\n    {}", parts.join(" + "))
}

#[test]
fn invariants_hold_in_every_reachable_state() {
    let seen = explore();
    for &s in seen.keys() {
        let why = || format!("state {s:?} via {:?}", trace(&seen, s));
        // A wss session needs the network; video needs the wss transport.
        assert!(!s.wss || s.wifi == Wifi::Joined, "{}", why());
        if s.activity == (Activity::Effect { video: true }) {
            assert!(s.wss, "video without wss: {}", why());
        }
        // Upload and an effect never coexist (product decision): the activity
        // is ONE value, and loading an effect mid-upload is refused.
        if s.activity == Activity::Upload {
            assert!(step(s, Event::FxLoad).is_err(), "{}", why());
            assert!(!s.map, "the old map is invalid during an upload: {}", why());
            // A running upload needs a live transport.
            assert!(s.wss || s.ble == Ble::Connected, "orphaned upload: {}", why());
        }
    }
}

/// PR-38: BLE and wss coexist. A central can connect while a wss session is
/// live, a session can open with BLE up, and the state where both carry
/// traffic at once is reachable — so every budget below includes it.
#[test]
fn ble_and_wss_coexist() {
    rr::verifies!("PR-38");
    let seen = explore();
    let both: Vec<&SysMode> =
        seen.keys().filter(|s| s.wss && s.ble == Ble::Connected).collect();
    assert!(!both.is_empty(), "no reachable state serves a BLE central beside wss");
    for &s in seen.keys() {
        if s.wss && s.ble == Ble::Advertising {
            assert_eq!(
                step(s, Event::BleConnect).map(|n| (n.wss, n.ble)),
                Ok((true, Ble::Connected)),
                "a central must be able to connect during a wss session: {s:?}"
            );
        }
        if s.wifi == Wifi::Joined && !s.wss {
            let n = step(s, Event::WssOpen).expect("wss opens with BLE up");
            assert!(n.wss, "{s:?}");
        }
    }
}

#[test]
fn every_state_can_return_to_quiescent() {
    let seen = explore();
    // Reverse search: the set of states from which a quiescent one is reachable.
    let mut good: BTreeSet<SysMode> = seen.keys().copied().filter(|&s| is_quiescent(s)).collect();
    assert!(!good.is_empty());
    loop {
        let before = good.len();
        for &s in seen.keys() {
            if !good.contains(&s)
                && Event::ALL.iter().any(|&e| step(s, e).is_ok_and(|n| good.contains(&n)))
            {
                good.insert(s);
            }
        }
        if good.len() == before {
            break;
        }
    }
    for &s in seen.keys() {
        assert!(good.contains(&s), "stuck in {s:?} via {:?}", trace(&seen, s));
    }
}

/// Today's layout: every static component is resident, so only the heap part
/// varies by state. The worst reachable heap state must be the one the
/// `ram_audit` HITL scenario measured (else the gate isn't exercising the worst
/// case), and it must fit what was measured as heap + still free there.
#[test]
fn todays_heap_worst_case_is_the_measured_one() {
    let seen = explore();
    let (s, bytes) = worst(&seen, heap_bytes);
    assert_eq!(
        bytes,
        cost::HEAP_AT_MIN,
        "the worst reachable heap state differs from the HITL-measured minimum state:\n  {}\n  via {:?}",
        describe(s),
        trace(&seen, s)
    );
    assert!(bytes <= cost::HEAP_AT_MIN + cost::MIN_FREE_MEASURED);
}

/// Region layout: the mode-dependent components share the budget and only the
/// live set counts.
#[test]
fn live_set_fits_the_budget() {
    println!("BUDGET (mode-dependent RAM, today's footprint + measured free) = {} B", cost::BUDGET);
    let seen = explore();
    println!("\n{} reachable states", seen.len());
    let mut rows: Vec<(usize, SysMode)> = seen.keys().map(|&s| (live_bytes(s), s)).collect();
    rows.sort();
    for (b, s) in &rows {
        println!("  {b:7} B  heap {:6} B  {s:?}", heap_bytes(*s));
    }
    let (s, bytes) = worst(&seen, live_bytes);
    println!(
        "worst live set: {bytes} B ({} B headroom)\n  {}\n  via {:?}",
        cost::BUDGET as i64 - bytes as i64,
        describe(s),
        trace(&seen, s)
    );
    for &st in seen.keys() {
        assert!(
            live_bytes(st) <= cost::BUDGET,
            "{st:?} needs {} B > budget {} B, via {:?}",
            live_bytes(st),
            cost::BUDGET,
            trace(&seen, st)
        );
    }
    // Pinned: a cost-table or transition change that moves these is a reviewed
    // budget change, not an accident.
    assert_eq!((seen.len(), bytes), (PINNED_STATES, PINNED_WORST));
    // Today's layout pays for every static at once plus the worst heap state;
    // the union layout pays only for the worst live set.
    let today = cost::ALL_MODE_STATICS + cost::HEAP_AT_MIN;
    println!(
        "\ntoday's layout holds {today} B for these components; a mode-union layout needs \
         {PINNED_WORST} B"
    );
}

const PINNED_STATES: usize = 57;
// +3,072 B: FX_LED_ROOM (multi-fixture room-frame cache, #280).
const PINNED_WORST: usize = 154_285;
