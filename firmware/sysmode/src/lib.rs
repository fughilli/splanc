//! The device's memory-mode state machine (docs/design/memory-regions.md).
//!
//! The C6's heap minimum was never one feature being too big: it was a STATE —
//! BLE provisioning still resident while the first TLS handshake allocated
//! (RAM audit, 2026-10-19). "No reachable state exhausts memory" is therefore a
//! reachability property, and this crate states it as code:
//!
//! - [`SysMode`] is the product of the independent axes (WiFi bring-up, BLE,
//!   wss, LED activity, stored map);
//! - [`step`] is the ONE transition function (pure; the firmware is meant to
//!   call it as the single authority for mode switches, so the model can't
//!   drift from the code);
//! - [`live_bytes`] costs a state from the per-component table in [`cost`],
//!   whose numbers are measured on the real image (each cites its source).
//!
//! `tests/reachability.rs` walks EVERY reachable state from boot (explicit-state
//! model checking — the space is a few hundred states) and asserts the
//! invariants and the budget.
//!
//! Policy: today BLE stays up (advertising, reconnectable) alongside a wss
//! session; making the radios exclusive is an open product decision, so it is
//! a [`Policy`] knob and the test reports the worst state under both.

#![no_std]

/// WiFi bring-up. The vendor driver runs the boot scan; after the join the
/// netstack owns the radio.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Wifi {
    /// No credentials: waiting for Improv over BLE.
    Unprovisioned,
    /// Vendor scan + join in progress.
    Scanning,
    /// Associated; the heapless netstack owns TCP/IP.
    Joined,
}

/// The BLE controller + host (Improv provisioning and the BLE player GATT
/// transport share one link).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Ble {
    /// Controller deinitialized (only under [`Policy::radio_exclusive`]).
    Off,
    /// Controller up, advertising, no central.
    Advertising,
    /// A central is connected (Improv or the BLE player session).
    Connected,
}

/// What the LEDs are doing. Map upload is exclusive of an effect (product
/// decision 2026-10-19: effects need not play during an upload), so it is an
/// activity, not a flag beside one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Activity {
    Idle,
    /// Counting patterns for a capture (state lives in the always-resident
    /// Player core).
    Mapping,
    /// Built-in pulse/flood playback (the topology simulator, SIM).
    Playback,
    /// A loaded fx VM effect; `video` = set_texture frames are streaming (the
    /// delta buffer FX_TEX_PREV is live only then).
    Effect { video: bool },
    /// A sharded map/topology upload being decoded into the map store.
    Upload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SysMode {
    pub wifi: Wifi,
    pub ble: Ble,
    /// A wss (TLS) session is open. The netstack serves one at a time.
    pub wss: bool,
    pub activity: Activity,
    /// A map (+ topology) is stored: the per-LED caches are populated.
    pub map: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Event {
    /// A BLE central connects (provisioner or BLE player client).
    BleConnect,
    BleDisconnect,
    /// Improv delivered WiFi credentials.
    ImprovCredentials,
    /// The vendor scan + join finished.
    Joined,
    /// The AP dropped us; the netstack rejoins (no vendor rescan).
    LinkLost,
    WssOpen,
    WssClose,
    MappingStart,
    MappingStop,
    PlaybackStart,
    PlaybackStop,
    FxLoad,
    FxClear,
    /// The first set_texture frame of a stream / the stream going quiet.
    VideoStart,
    VideoStop,
    UploadBegin,
    /// The final window decoded; `ok` = the map/topology was accepted.
    UploadEnd { ok: bool },
}

impl Event {
    pub const ALL: [Event; 18] = [
        Event::BleConnect,
        Event::BleDisconnect,
        Event::ImprovCredentials,
        Event::Joined,
        Event::LinkLost,
        Event::WssOpen,
        Event::WssClose,
        Event::MappingStart,
        Event::MappingStop,
        Event::PlaybackStart,
        Event::PlaybackStop,
        Event::FxLoad,
        Event::FxClear,
        Event::VideoStart,
        Event::VideoStop,
        Event::UploadBegin,
        Event::UploadEnd { ok: true },
        Event::UploadEnd { ok: false },
    ];
}

/// Why an event is refused in a state (the firmware answers with an error /
/// ignores it; the state is unchanged).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refuse {
    /// The event can't happen here (e.g. disconnect with no central).
    NotApplicable,
    /// Needs a transport (wss session or BLE central) to carry the command.
    NoTransport,
    /// Needs WiFi joined.
    NotJoined,
    /// Effects/video need... an effect; video needs the wss transport.
    NoEffect,
    /// Policy forbids it (BLE while a wss session is live, exclusive radios).
    Policy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// BLE controller deinit while a wss session is live (re-init on close).
    /// `false` = today's firmware: BLE keeps advertising, the provisioning link
    /// is dropped when a wss client appears, but a central may reconnect.
    pub radio_exclusive: bool,
}

impl Policy {
    /// What the firmware does today.
    pub const CURRENT: Policy = Policy { radio_exclusive: false };
    pub const RADIO_EXCLUSIVE: Policy = Policy { radio_exclusive: true };
}

impl SysMode {
    /// Power-on: no credentials (first boot / after a factory reset).
    pub const BOOT_UNPROVISIONED: SysMode = SysMode {
        wifi: Wifi::Unprovisioned,
        ble: Ble::Advertising,
        wss: false,
        activity: Activity::Idle,
        map: false,
    };

    /// Power-on with stored credentials, map and effect: fs_replay restores the
    /// map + effect before the network is up, then the scan starts.
    pub const BOOT_RESTORED: SysMode = SysMode {
        wifi: Wifi::Scanning,
        ble: Ble::Advertising,
        wss: false,
        activity: Activity::Effect { video: false },
        map: true,
    };

    fn transport(&self) -> bool {
        self.wss || self.ble == Ble::Connected
    }
}

/// The transition function. Pure and total: every (state, event) is either a
/// new state or a [`Refuse`].
pub fn step(s: SysMode, e: Event, p: Policy) -> Result<SysMode, Refuse> {
    use Activity as A;
    let mut n = s;
    match e {
        Event::BleConnect => {
            if s.ble != Ble::Advertising {
                return Err(Refuse::NotApplicable);
            }
            n.ble = Ble::Connected;
        }
        Event::BleDisconnect => {
            if s.ble != Ble::Connected {
                return Err(Refuse::NotApplicable);
            }
            n.ble = Ble::Advertising;
            if !n.transport() {
                n = drop_transport(n);
            }
        }
        Event::ImprovCredentials => {
            if s.ble != Ble::Connected || s.wifi != Wifi::Unprovisioned {
                return Err(Refuse::NotApplicable);
            }
            n.wifi = Wifi::Scanning;
        }
        Event::Joined => {
            if s.wifi != Wifi::Scanning {
                return Err(Refuse::NotApplicable);
            }
            n.wifi = Wifi::Joined;
        }
        Event::LinkLost => {
            if s.wifi != Wifi::Joined {
                return Err(Refuse::NotApplicable);
            }
            // The netstack rejoins in place (Joined -> Joined), but the TCP
            // session dies with the link.
            if s.wss {
                n = close_wss(n, p);
            }
        }
        Event::WssOpen => {
            if s.wifi != Wifi::Joined {
                return Err(Refuse::NotJoined);
            }
            if s.wss {
                return Err(Refuse::NotApplicable);
            }
            n.wss = true;
            n.ble = if p.radio_exclusive {
                Ble::Off
            } else if s.ble == Ble::Connected {
                // Today: a wss client appearing drops the (vestigial,
                // post-provisioning) BLE link; the controller re-advertises.
                Ble::Advertising
            } else {
                s.ble
            };
        }
        Event::WssClose => {
            if !s.wss {
                return Err(Refuse::NotApplicable);
            }
            n = close_wss(n, p);
        }
        Event::MappingStart => {
            need_transport(s)?;
            n.activity = A::Mapping; // replaces whatever was showing
        }
        Event::MappingStop => {
            if s.activity != A::Mapping {
                return Err(Refuse::NotApplicable);
            }
            n.activity = A::Idle;
        }
        Event::PlaybackStart => {
            need_transport(s)?;
            if !s.map {
                return Err(Refuse::NotApplicable); // pulse/flood need the topology
            }
            n.activity = A::Playback;
        }
        Event::PlaybackStop => {
            if s.activity != A::Playback {
                return Err(Refuse::NotApplicable);
            }
            n.activity = A::Idle;
        }
        Event::FxLoad => {
            need_transport(s)?;
            if s.activity == A::Upload {
                // Exclusive of an upload: the upload owns the activity memory.
                return Err(Refuse::NotApplicable);
            }
            n.activity = A::Effect { video: false };
        }
        Event::FxClear => {
            if !matches!(s.activity, A::Effect { .. }) {
                return Err(Refuse::NoEffect);
            }
            n.activity = A::Idle;
        }
        Event::VideoStart => {
            if !s.wss {
                return Err(Refuse::NoTransport); // 8 KB frames ride wss only
            }
            if s.activity != (A::Effect { video: false }) {
                return Err(Refuse::NoEffect);
            }
            n.activity = A::Effect { video: true };
        }
        Event::VideoStop => {
            if s.activity != (A::Effect { video: true }) {
                return Err(Refuse::NotApplicable);
            }
            n.activity = A::Effect { video: false };
        }
        Event::UploadBegin => {
            need_transport(s)?;
            if s.activity == A::Upload {
                return Err(Refuse::NotApplicable);
            }
            // The upload clears the running effect/playback (it rebuilds the
            // topology anyway) and invalidates the stored map until it ends.
            n.activity = A::Upload;
            n.map = false;
        }
        Event::UploadEnd { ok } => {
            if s.activity != A::Upload {
                return Err(Refuse::NotApplicable);
            }
            n.activity = A::Idle;
            n.map = ok;
        }
    }
    Ok(n)
}

fn need_transport(s: SysMode) -> Result<(), Refuse> {
    if s.transport() {
        Ok(())
    } else {
        Err(Refuse::NoTransport)
    }
}

fn close_wss(mut n: SysMode, p: Policy) -> SysMode {
    n.wss = false;
    // Video frames ride wss only: the stream ends with the session even if a
    // BLE central is still connected (found by the reachability test).
    if n.activity == (Activity::Effect { video: true }) {
        n.activity = Activity::Effect { video: false };
    }
    if p.radio_exclusive {
        n.ble = Ble::Advertising; // re-init the controller
    }
    if !n.transport() {
        n = drop_transport(n);
    }
    n
}

/// The last transport went away: an in-flight upload is abandoned and a video
/// stream stops. (A loaded effect / playback / map keep running.)
fn drop_transport(mut n: SysMode) -> SysMode {
    n.activity = match n.activity {
        Activity::Upload => Activity::Idle,
        Activity::Effect { .. } => Activity::Effect { video: false },
        a => a,
    };
    n
}

/// Per-component RAM (bytes), measured on the shipping image. Static sizes are
/// `nm -S` of the netstack ELF at bd46f9a5 (PR #262); heap sizes are the live
/// TLSF blocks (incl. headers) attributed in the min-watermark core dump
/// (`ram_audit` HITL run, firmware-v1.6.0; heap usage of these components did
/// not change in #262).
pub mod cost {
    // -- BLE (controller up = Advertising or Connected) ----------------------
    /// Vendor controller heap: pools / LL env / HCI buffers (23,368 B in 220
    /// blocks) + the ble_ll_task stack (5,136 B) + small controller allocs.
    /// Core dump: component "BLE controller blob (vendor)", heap.
    pub const BLE_CONTROLLER_HEAP: usize = 28_868;
    /// Heapless BLE host statics: ble_ffi::IMPROV 4,192 + ble_ffi::L2CAP 1,036 +
    /// improv_ble_netstack s_ring 2,160 (nm).
    pub const BLE_HOST_STATIC: usize = 4_192 + 1_036 + 2_160;
    /// Per-connection host buffers (ble_ffi.rs malloc(cap) + the 1,536-B
    /// improv_ble_netstack frame): core dump component "netstack BLE host
    /// (Rust: Improv + player GATT)", heap.
    pub const BLE_LINK_HEAP: usize = 3_876;

    // -- wss session ------------------------------------------------------------
    /// mbedTLS server context + live handshake allocations + the parsed
    /// cert/key: core dump component "netstack transport (C++: TLS/WS glue)",
    /// heap, captured mid-handshake (the minimum). The ~6.5 KB dynamic record
    /// buffers come and go per record; at the captured instant they were part
    /// of this figure.
    pub const TLS_SESSION_HEAP: usize = 9_944;
    /// WS reassembly g_ws_rx 6,144 + reply buffer g_tx 2,064 (nm).
    pub const WS_BUFFERS_STATIC: usize = 6_144 + 2_064;

    // -- WiFi bring-up ------------------------------------------------------------
    /// What the vendor scan leaves on the heap and never frees: cnx-mgr / scan /
    /// TWT / HE state + NVS cache (9,080) + esp_event loop + task (5,756) + lwIP
    /// tcpip thread + state (5,592). Core dump components "WiFi driver blob"
    /// (scan-only part, per design §1.1), "esp_event loop", "lwIP".
    pub const SCAN_RESIDUE_HEAP: usize = 9_080 + 5_756 + 5_592;
    /// The scan-record buffer g_scan (nm).
    pub const SCAN_STATIC: usize = 960;

    // -- stored map ---------------------------------------------------------------
    /// ARENA_MEM 8,192 (topology geometry) + FX_LED_TOPO 10,240 + FX_LED_POS
    /// 6,144 + FX_LED_MAPPED 32 (nm): the per-LED caches the map decodes into.
    pub const MAP_STORE_STATIC: usize = 8_192 + 10_240 + 6_144 + 32;

    // -- activity -------------------------------------------------------------------
    /// The topology simulator SIM (nm) for pulse/flood.
    pub const PLAYBACK_STATIC: usize = 2_144;
    /// The loaded fx VM: FX_ARENA 24,576 + FX_VM 5,120 + FX_BYTES 4,096 + JIT
    /// (g_jit_region 2,048 + FX_JIT_TARGETS 1,025 + FX_JIT_CONSTS 256 +
    /// FX_JIT_PLANS 80 + FX_JIT_BLOCKS 64) + tex_comp LUT 1,024 + OSC_TABLE 900
    /// + OSC_SHADOW 512 (nm).
    pub const EFFECT_STATIC: usize =
        24_576 + 5_120 + 4_096 + (2_048 + 1_025 + 256 + 80 + 64) + 1_024 + 900 + 512;
    /// The set_texture delta buffer FX_TEX_PREV (nm), live only while video
    /// streams.
    pub const VIDEO_STATIC: usize = 8_192;
    /// A map/topology upload streams windows to flash and decodes off flash on
    /// loopTask's (statically sized) stack; the map store is rebuilt in place.
    /// No RAM beyond the map store it fills.
    pub const UPLOAD: usize = 0;

    /// Mode-independent statics that the per-mode components above COULD be
    /// carved out of — today they are all permanently resident.
    pub const ALL_MODE_STATICS: usize = BLE_HOST_STATIC
        + WS_BUFFERS_STATIC
        + SCAN_STATIC
        + MAP_STORE_STATIC
        + PLAYBACK_STATIC
        + EFFECT_STATIC
        + VIDEO_STATIC;

    /// Measured minimum free heap on the `ram_audit` worst case after #262
    /// (device esp_get_minimum_free_heap_size, HITL rig-2, 2026-10-19).
    pub const MIN_FREE_MEASURED: usize = 54_204;

    /// Mode-dependent HEAP live at that measured minimum: the first wss
    /// handshake right after Improv, the provisioning central still connected,
    /// scan residue resident (RAM audit; the watcher's low came during that
    /// handshake in both runs).
    pub const HEAP_AT_MIN: usize = BLE_CONTROLLER_HEAP + BLE_LINK_HEAP + TLS_SESSION_HEAP + SCAN_RESIDUE_HEAP;

    /// The RAM that exists for mode-dependent components: what they occupy in
    /// today's layout at the measured minimum, plus what was still free there.
    pub const BUDGET: usize = ALL_MODE_STATICS + HEAP_AT_MIN + MIN_FREE_MEASURED;
}

/// One mode-dependent component live in a state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Component {
    pub name: &'static str,
    pub bytes: usize,
    /// Drawn from the shared IDF heap today (vs. a permanently resident static).
    pub heap: bool,
}

/// The components live in a state. Scan residue stays after the join because
/// the vendor driver never frees it (today's firmware; see
/// docs/design/memory-regions.md for the removal).
pub fn components(s: SysMode) -> impl Iterator<Item = Component> {
    use cost::*;
    let ble_up = s.ble != Ble::Off;
    let c = |live: bool, name, bytes, heap| (live, Component { name, bytes, heap });
    let parts = [
        c(ble_up, "ble_controller", BLE_CONTROLLER_HEAP, true),
        c(ble_up, "ble_host", BLE_HOST_STATIC, false),
        c(s.ble == Ble::Connected, "ble_link", BLE_LINK_HEAP, true),
        c(s.wss, "tls_session", TLS_SESSION_HEAP, true),
        c(s.wss, "ws_buffers", WS_BUFFERS_STATIC, false),
        c(s.wifi != Wifi::Unprovisioned, "scan_residue", SCAN_RESIDUE_HEAP, true),
        c(s.wifi == Wifi::Scanning, "scan", SCAN_STATIC, false),
        c(s.map || s.activity == Activity::Upload, "map_store", MAP_STORE_STATIC, false),
        c(s.activity == Activity::Playback, "playback", PLAYBACK_STATIC, false),
        c(matches!(s.activity, Activity::Effect { .. }), "effect", EFFECT_STATIC, false),
        c(s.activity == (Activity::Effect { video: true }), "video", VIDEO_STATIC, false),
        c(s.activity == Activity::Upload, "upload", UPLOAD, false),
    ];
    parts.into_iter().filter(|p| p.0).map(|p| p.1)
}

/// Bytes the mode-dependent components need in state `s`: the live set a
/// mode-union region layout must hold at once.
pub fn live_bytes(s: SysMode) -> usize {
    components(s).map(|c| c.bytes).sum()
}

/// The part of [`live_bytes`] drawn from the shared heap in TODAY's layout
/// (every static component is resident regardless of state).
pub fn heap_bytes(s: SysMode) -> usize {
    components(s).filter(|c| c.heap).map(|c| c.bytes).sum()
}

/// Quiescent: nothing in flight (no session, no central, nothing playing).
pub fn is_quiescent(s: SysMode) -> bool {
    !s.wss && s.ble != Ble::Connected && s.activity == Activity::Idle
}
