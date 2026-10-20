//! The firmware side of the model: track the device's [`SysMode`] by OBSERVING
//! what it is doing, and check every transition it takes against [`step`].
//!
//! The firmware's mode switches are scattered (BLE HCI edges, the WiFi join
//! state machine, TLS session resets, upload windows, effect load/park), so
//! instead of an event hook at each site the firmware hands [`Tracker::observe`]
//! a snapshot of the facts it can see, once per loop. The tracker derives the
//! sysmode events that turn its model state into the observed one, applying each
//! through [`step`]. A refusal means the firmware took a transition the model
//! says is unreachable: today that is LOG-ONLY (the firmware's behaviour wins:
//! the axis is forced to what was observed and counted), the first step towards
//! `step` being the authority that gates the switch.

use crate::{step, Activity, Ble, Event, Refuse, SysMode, Wifi};

/// The facts the firmware sees at a poll.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Observed {
    /// WiFi credentials committed (Improv or the wired console).
    pub creds: bool,
    /// A DHCP lease is held (the netstack is on the network).
    pub leased: bool,
    /// A BLE central is connected.
    pub ble_connected: bool,
    /// The wss (TLS + WebSocket) session is up.
    pub wss: bool,
    /// A sharded map/topology upload is in progress.
    pub upload: bool,
    /// A mapping capture or the counting probe is showing.
    pub mapping: bool,
    /// An fx VM effect is loaded (and not parked behind a capture).
    pub effect: bool,
    /// set_texture frames are streaming over the wss session (one arrived within
    /// the quiet period AND the session is up — frames ride wss only).
    pub video: bool,
    /// A map is stored.
    pub map: bool,
}

/// Counters a JTAG watcher can read without disturbing the device (no network
/// reporting). Layout is stable: `#[repr(C)]`, u32 fields.
#[repr(C)]
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Stats {
    /// Snapshots observed.
    pub polls: u32,
    /// Events the model accepted.
    pub accepted: u32,
    /// Events the model refused, total and per [`Refuse`] kind (index = code).
    pub refused: u32,
    pub refused_by_kind: [u32; 4],
    /// Observed changes no event models (forced without a step).
    pub unmodeled: u32,
    /// [`state_code`] of the tracked state.
    pub state: u32,
    /// The last refusal: `state_code << 16 | event_code << 8 | refuse_code`.
    pub last_refusal: u32,
}

/// A refused transition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    pub from: SysMode,
    /// `None` for a change no event models.
    pub event: Option<Event>,
    pub why: Option<Refuse>,
}

pub struct Tracker {
    pub state: SysMode,
    pub stats: Stats,
    prev_leased: bool,
}

impl Tracker {
    pub const fn new(boot: SysMode) -> Self {
        Tracker {
            state: boot,
            stats: STATS_ZERO,
            prev_leased: false,
        }
    }

    /// Restart from a boot state (the firmware calls this once the stored
    /// map/effect have been replayed).
    pub fn reset(&mut self, boot: SysMode) {
        *self = Tracker::new(boot);
        self.stats.state = state_code(boot);
    }

    /// Apply one event through the model. A refusal leaves the state as is.
    pub fn event(&mut self, e: Event) -> Result<SysMode, Refuse> {
        let r = step(self.state, e);
        match r {
            Ok(n) => {
                self.state = n;
                self.stats.accepted += 1;
            }
            Err(why) => self.count_refusal(Some(e), Some(why)),
        }
        self.stats.state = state_code(self.state);
        r
    }

    /// Bring the model state to `o`, one modeled event at a time; every refused
    /// (or unmodeled) change is reported to `on_refuse` and then forced, so the
    /// model keeps tracking the device. Bounded: at most a few events per axis.
    pub fn observe(&mut self, o: Observed, mut on_refuse: impl FnMut(Refusal)) {
        self.stats.polls += 1;
        let mut link_lost = self.prev_leased && !o.leased;
        self.prev_leased = o.leased;
        for _ in 0..16 {
            let Some(e) = next_event(self.state, o, &mut link_lost) else {
                break;
            };
            match e {
                Next::Event(e) => {
                    let from = self.state;
                    if let Err(why) = self.event(e) {
                        on_refuse(Refusal {
                            from,
                            event: Some(e),
                            why: Some(why),
                        });
                        self.state = force(self.state, o, Some(e));
                    }
                }
                Next::Unmodeled => {
                    let from = self.state;
                    self.stats.unmodeled += 1;
                    self.note_last(None, None);
                    on_refuse(Refusal {
                        from,
                        event: None,
                        why: None,
                    });
                    self.state = force(self.state, o, None);
                }
            }
        }
        self.stats.state = state_code(self.state);
    }

    fn count_refusal(&mut self, e: Option<Event>, why: Option<Refuse>) {
        self.stats.refused += 1;
        if let Some(w) = why {
            self.stats.refused_by_kind[refuse_code(w) as usize] += 1;
        }
        self.note_last(e, why);
    }

    fn note_last(&mut self, e: Option<Event>, why: Option<Refuse>) {
        self.stats.last_refusal = state_code(self.state) << 16
            | e.map_or(0xff, event_code) << 8
            | why.map_or(0xff, refuse_code);
    }
}

const STATS_ZERO: Stats = Stats {
    polls: 0,
    accepted: 0,
    refused: 0,
    refused_by_kind: [0; 4],
    unmodeled: 0,
    state: 0,
    last_refusal: 0,
};

enum Next {
    Event(Event),
    Unmodeled,
}

/// The activity the observation implies (one value; the firmware's precedence:
/// an upload or a capture preempts — parks — an effect).
fn observed_activity(o: Observed) -> Activity {
    if o.upload {
        Activity::Upload
    } else if o.mapping {
        Activity::Mapping
    } else if o.effect {
        Activity::Effect { video: o.video }
    } else {
        Activity::Idle
    }
}

/// The next event that moves `s` towards `o`, axis by axis (WiFi, link, wss,
/// BLE, activity, map).
fn next_event(s: SysMode, o: Observed, link_lost: &mut bool) -> Option<Next> {
    use Event as E;
    // WiFi bring-up.
    if s.wifi == Wifi::Unprovisioned && o.creds {
        return Some(Next::Event(if s.ble == Ble::Connected && o.ble_connected {
            E::ImprovCredentials
        } else {
            E::WiredCredentials
        }));
    }
    if s.wifi == Wifi::Scanning && o.leased {
        return Some(Next::Event(E::Joined));
    }
    if *link_lost && s.wifi == Wifi::Joined {
        *link_lost = false;
        return Some(Next::Event(E::LinkLost));
    }
    // Sessions and links.
    if s.wss != o.wss {
        return Some(Next::Event(if o.wss { E::WssOpen } else { E::WssClose }));
    }
    match (s.ble, o.ble_connected) {
        (Ble::Connected, false) => return Some(Next::Event(E::BleDisconnect)),
        (Ble::Advertising, true) => return Some(Next::Event(E::BleConnect)),
        _ => {}
    }
    // What the LEDs are doing.
    let want = observed_activity(o);
    if s.activity != want {
        return Some(Next::Event(match (s.activity, want) {
            (Activity::Upload, _) => E::UploadEnd { ok: o.map },
            (_, Activity::Upload) => E::UploadBegin,
            (Activity::Mapping, _) => E::MappingStop,
            (_, Activity::Mapping) => E::MappingStart,
            (Activity::Effect { .. }, Activity::Effect { video: true }) => E::VideoStart,
            (Activity::Effect { .. }, Activity::Effect { video: false }) => E::VideoStop,
            (Activity::Effect { .. }, _) => E::FxClear,
            (Activity::Idle, _) => E::FxLoad,
        }));
    }
    // A map stored outside a sharded upload (a single-frame submit_map) is an
    // upload too; a map disappearing has no event.
    if s.map != o.map && s.activity != Activity::Upload {
        return Some(if o.map {
            Next::Event(E::UploadBegin)
        } else {
            Next::Unmodeled
        });
    }
    None
}

/// Force the axis an event (or an unmodeled change) targets to what was observed.
fn force(mut s: SysMode, o: Observed, e: Option<Event>) -> SysMode {
    use Event as E;
    match e {
        Some(E::ImprovCredentials | E::WiredCredentials) => s.wifi = Wifi::Scanning,
        Some(E::Joined | E::LinkLost) => s.wifi = Wifi::Joined,
        Some(E::WssOpen | E::WssClose) => s.wss = o.wss,
        Some(E::BleConnect | E::BleDisconnect) => {
            s.ble = if o.ble_connected {
                Ble::Connected
            } else {
                Ble::Advertising
            }
        }
        Some(E::UploadBegin) if s.activity == observed_activity(o) => s.map = o.map,
        Some(_) => s.activity = observed_activity(o),
        None => s.map = o.map,
    }
    s
}

/// Compact state encoding for the stats static / logs: bits 0-1 wifi
/// (0 unprovisioned, 1 scanning, 2 joined), bit 2 BLE connected, bit 3 wss,
/// bits 4-6 activity (0 idle, 1 mapping, 2 effect, 3 effect+video, 4 upload),
/// bit 7 map.
pub fn state_code(s: SysMode) -> u32 {
    let wifi = match s.wifi {
        Wifi::Unprovisioned => 0,
        Wifi::Scanning => 1,
        Wifi::Joined => 2,
    };
    let act = match s.activity {
        Activity::Idle => 0,
        Activity::Mapping => 1,
        Activity::Effect { video: false } => 2,
        Activity::Effect { video: true } => 3,
        Activity::Upload => 4,
    };
    wifi | ((s.ble == Ble::Connected) as u32) << 2
        | (s.wss as u32) << 3
        | act << 4
        | (s.map as u32) << 7
}

/// Index of `e` in [`Event::ALL`].
pub fn event_code(e: Event) -> u32 {
    Event::ALL.iter().position(|&x| x == e).unwrap_or(0xff) as u32
}

pub fn refuse_code(r: Refuse) -> u32 {
    match r {
        Refuse::NotApplicable => 0,
        Refuse::NoTransport => 1,
        Refuse::NotJoined => 2,
        Refuse::NoEffect => 3,
    }
}
