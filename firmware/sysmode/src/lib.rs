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
//! BLE and wss COEXIST (requirement PR-38): the controller is never torn down
//! for a wss session, so the budget must hold both at once — radio mutual
//! exclusion is not an available memory-reduction strategy.

#![no_std]

pub mod observe;

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
    /// A loaded fx VM effect; `video` = set_texture frames are streaming (the
    /// delta buffer is live only then); `deck_b` = a second effect is loaded on
    /// FX deck B (docs/design/uniform-keypoints.md). Video and deck B share ONE
    /// aux region (ffi.rs FxAux), so they are mutually exclusive: loading deck B
    /// ends a stream, and a stream can't start while deck B is loaded. A
    /// deck-B-only show (deck A cleared) is over-approximated as an effect state.
    Effect { video: bool, deck_b: bool },
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
    /// The wired serial console delivered credentials (`PROV <ssid> <pass>`, the
    /// no-BLE HITL path) — needs no central.
    WiredCredentials,
    /// The vendor scan + join finished.
    Joined,
    /// The AP dropped us; the netstack rejoins (no vendor rescan).
    LinkLost,
    WssOpen,
    WssClose,
    MappingStart,
    MappingStop,
    FxLoad,
    FxClear,
    /// An effect loaded onto / cleared from FX deck B.
    DeckBLoad,
    DeckBClear,
    /// The first set_texture frame of a stream / the stream going quiet.
    VideoStart,
    VideoStop,
    UploadBegin,
    /// The final window decoded; `ok` = the map/topology was accepted.
    UploadEnd { ok: bool },
}

impl Event {
    pub const ALL: [Event; 19] = [
        Event::BleConnect,
        Event::BleDisconnect,
        Event::ImprovCredentials,
        Event::WiredCredentials,
        Event::Joined,
        Event::LinkLost,
        Event::WssOpen,
        Event::WssClose,
        Event::MappingStart,
        Event::MappingStop,
        Event::FxLoad,
        Event::FxClear,
        Event::DeckBLoad,
        Event::DeckBClear,
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
    /// The aux region is held by the other of video / deck B.
    AuxBusy,
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

    /// Power-on with a stored map and effect: fs_replay restores them before the
    /// network is up. WiFi credentials are RAM-only on the netstack build, so the
    /// device still waits for Improv / the wired console.
    pub const BOOT_RESTORED: SysMode = SysMode {
        wifi: Wifi::Unprovisioned,
        ble: Ble::Advertising,
        wss: false,
        activity: Activity::Effect { video: false, deck_b: false },
        map: true,
    };

    fn transport(&self) -> bool {
        self.wss || self.ble == Ble::Connected
    }
}

/// The transition function. Pure and total: every (state, event) is either a
/// new state or a [`Refuse`].
pub fn step(s: SysMode, e: Event) -> Result<SysMode, Refuse> {
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
        Event::WiredCredentials => {
            if s.wifi != Wifi::Unprovisioned {
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
                n = close_wss(n);
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
            // A wss client appearing drops the (vestigial, post-provisioning)
            // BLE link so coex stops yielding airtime to it during the
            // handshake; the controller keeps advertising and a central may
            // reconnect alongside the session (PR-38).
            if s.ble == Ble::Connected {
                n.ble = Ble::Advertising;
            }
        }
        Event::WssClose => {
            if !s.wss {
                return Err(Refuse::NotApplicable);
            }
            n = close_wss(n);
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
        Event::FxLoad => {
            need_transport(s)?;
            if s.activity == A::Upload {
                // Exclusive of an upload: the upload owns the activity memory.
                return Err(Refuse::NotApplicable);
            }
            // A new deck-A effect ends a video stream; a loaded deck B stays.
            let deck_b = matches!(s.activity, A::Effect { deck_b: true, .. });
            n.activity = A::Effect { video: false, deck_b };
        }
        Event::FxClear => {
            n.activity = match s.activity {
                // Deck B keeps showing (video drove deck A, so it stops).
                A::Effect { deck_b: true, .. } => A::Effect { video: false, deck_b: true },
                A::Effect { .. } => A::Idle,
                _ => return Err(Refuse::NoEffect),
            };
        }
        Event::DeckBLoad => {
            need_transport(s)?;
            if s.activity == A::Upload {
                return Err(Refuse::NotApplicable);
            }
            // Deck B claims the aux region: a running video stream ends.
            n.activity = A::Effect { video: false, deck_b: true };
        }
        Event::DeckBClear => {
            if !matches!(s.activity, A::Effect { deck_b: true, .. }) {
                return Err(Refuse::NotApplicable);
            }
            n.activity = A::Effect { video: false, deck_b: false };
        }
        Event::VideoStart => {
            if !s.wss {
                return Err(Refuse::NoTransport); // 8 KB frames ride wss only
            }
            match s.activity {
                A::Effect { video: false, deck_b: false } => {}
                A::Effect { deck_b: true, .. } => return Err(Refuse::AuxBusy),
                _ => return Err(Refuse::NoEffect),
            }
            n.activity = A::Effect { video: true, deck_b: false };
        }
        Event::VideoStop => {
            if !matches!(s.activity, A::Effect { video: true, .. }) {
                return Err(Refuse::NotApplicable);
            }
            n.activity = A::Effect { video: false, deck_b: false };
        }
        Event::UploadBegin => {
            need_transport(s)?;
            if s.activity == A::Upload {
                return Err(Refuse::NotApplicable);
            }
            // The upload clears the running effect (it rebuilds the
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

fn close_wss(mut n: SysMode) -> SysMode {
    n.wss = false;
    // Video frames ride wss only: the stream ends with the session even if a
    // BLE central is still connected (found by the reachability test).
    if let Activity::Effect { video: true, deck_b } = n.activity {
        n.activity = Activity::Effect { video: false, deck_b };
    }
    if !n.transport() {
        n = drop_transport(n);
    }
    n
}

/// The last transport went away: an in-flight upload is abandoned and a video
/// stream stops. (A loaded effect / map keep running.)
fn drop_transport(mut n: SysMode) -> SysMode {
    n.activity = match n.activity {
        Activity::Upload => Activity::Idle,
        Activity::Effect { deck_b, .. } => Activity::Effect { video: false, deck_b },
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
    // -- BLE (controller always up: PR-38) -------------------------------------
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
    /// ARENA_MEM 12,288 (topology geometry) + FX_LED_TOPO 10,240 + FX_LED_POS
    /// 6,144 + FX_LED_MAPPED 32 + FX_LED_ROOM 3,072 (i16 mm x3 x 512 LEDs, the
    /// room-frame cache for multi-fixture effects) (nm): the per-LED caches the
    /// map decodes into.
    pub const MAP_STORE_STATIC: usize = 12_288 + 10_240 + 6_144 + 32 + 3_072;

    // -- activity -------------------------------------------------------------------
    /// The loaded fx VM (deck A): FX_ARENA 24,576 (shared by both decks) + DECK_A
    /// 11,436 (its .fxb 4,096 + VM 5,120 + keypoint blend state ~2.1 K + id) +
    /// JIT (g_jit_region 2,048 + FX_JIT_TARGETS 1,025 + FX_JIT_CONSTS 256 +
    /// FX_JIT_PLANS 80 + FX_JIT_BLOCKS 64) + tex_comp LUT 1,024 + OSC_TABLE 900 +
    /// OSC_SHADOW 512 + the keypoint record buffer KP_IO 1,130 (nm, fx-keypoints).
    pub const EFFECT_STATIC: usize =
        24_576 + 11_436 + (2_048 + 1_025 + 256 + 80 + 64) + 1_024 + 900 + 512 + 1_130;
    /// The aux region FX_AUX (nm): EITHER the set_texture delta buffer (8,192,
    /// live while video streams) OR FX deck B (a whole deck, 11,436) — one
    /// union, so the two cost max(), not sum().
    pub const AUX_STATIC: usize = 11_436;
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
        + EFFECT_STATIC
        + AUX_STATIC;

    /// [`ALL_MODE_STATICS`] on the image [`MIN_FREE_MEASURED`] was measured on
    /// (#262). Statics added since come out of that free heap, so the budget is
    /// fixed by the old figure (growing a static must shrink the headroom, not
    /// grow the budget).
    pub const MEASURED_STATICS: usize =
        7_388 + 8_208 + 960 + 24_608 + (24_576 + 5_120 + 4_096 + 3_473 + 1_024 + 900 + 512) + 8_192;

    /// Measured minimum free heap on the `ram_audit` worst case after #262
    /// (device esp_get_minimum_free_heap_size, HITL rig-2, 2026-10-19).
    pub const MIN_FREE_MEASURED: usize = 54_204;

    /// Mode-dependent HEAP live at that measured minimum: the first wss
    /// handshake right after Improv, the provisioning central still connected,
    /// scan residue resident (RAM audit; the watcher's low came during that
    /// handshake in both runs).
    pub const HEAP_AT_MIN: usize = BLE_CONTROLLER_HEAP + BLE_LINK_HEAP + TLS_SESSION_HEAP + SCAN_RESIDUE_HEAP;

    /// Statics added to ALL_MODE_STATICS since MIN_FREE_MEASURED was taken: the
    /// image that measured it had them as free heap, so they move from "free"
    /// to "static" rather than adding RAM — ARENA_MEM 8 -> 12 KB (+4,096, #291),
    /// FX_LED_ROOM (+3,072, #280), deck B + keypoints (+6,594). Derived from
    /// [`MEASURED_STATICS`] so a new static can't be forgotten here.
    pub const STATICS_ADDED_SINCE_MEASURED: usize = ALL_MODE_STATICS - MEASURED_STATICS;

    /// The RAM that exists for mode-dependent components: what they occupy in
    /// today's layout at the measured minimum, plus what was still free there.
    pub const BUDGET: usize =
        ALL_MODE_STATICS + HEAP_AT_MIN + MIN_FREE_MEASURED - STATICS_ADDED_SINCE_MEASURED;
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
    let c = |live: bool, name, bytes, heap| (live, Component { name, bytes, heap });
    let parts = [
        c(true, "ble_controller", BLE_CONTROLLER_HEAP, true),
        c(true, "ble_host", BLE_HOST_STATIC, false),
        c(s.ble == Ble::Connected, "ble_link", BLE_LINK_HEAP, true),
        c(s.wss, "tls_session", TLS_SESSION_HEAP, true),
        c(s.wss, "ws_buffers", WS_BUFFERS_STATIC, false),
        c(s.wifi != Wifi::Unprovisioned, "scan_residue", SCAN_RESIDUE_HEAP, true),
        c(s.wifi == Wifi::Scanning, "scan", SCAN_STATIC, false),
        c(s.map || s.activity == Activity::Upload, "map_store", MAP_STORE_STATIC, false),
        c(matches!(s.activity, Activity::Effect { .. }), "effect", EFFECT_STATIC, false),
        c(
            matches!(s.activity, Activity::Effect { video: true, .. } | Activity::Effect { deck_b: true, .. }),
            "fx_aux",
            AUX_STATIC,
            false,
        ),
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

/// Quiescent: nothing in flight (no session, no central, nothing showing).
pub fn is_quiescent(s: SysMode) -> bool {
    !s.wss && s.ble != Ble::Connected && s.activity == Activity::Idle
}
