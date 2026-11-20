//! Device metrics (docs/design/device-metrics.md): get_device_metrics -> device_metrics.
//!
//! The app asks only when its user switched on "Send feedback to Fug Studio". Nothing
//! here runs until then: the reply is built on request from state the player already
//! keeps (the frame-rate autoscaler) plus a snapshot the C++ firmware fills through a
//! callback it registers at boot ([`lm_metrics_set_source`]): heap, uptime, reset
//! counters, Wi-Fi / Bluetooth counters, LED count. The only state added here is the
//! callback pointer and one lag counter (8 bytes of .bss); the counters the C++ side
//! keeps are a few words more (main.cpp, netstack_transport.cpp).
//!
//! The reply is encoded ZERO-COPY into the caller's buffer (no by-value
//! ServerMessage), like the other firmware-only arms. Mesh fields stay 0 (= no mesh)
//! until the mesh stack is in the player; then [`LmSysMetrics::mesh_*`] carries them.

use core::ptr::addr_of;

use super::{write_arm, PbOut, FPS};

/// ClientMessage arm of the request (get_device_metrics = 120).
pub const ARM_GET_DEVICE_METRICS: u32 = 120;
/// ServerMessage arm of the reply (device_metrics = 64).
const ARM_DEVICE_METRICS: u32 = 64;
/// DeviceMetrics.version.
const METRICS_VERSION: u64 = 1;

/// What the C++ firmware knows (it fills this on request). Zeroed = not measured.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LmSysMetrics {
    pub uptime_s: u32,
    /// esp_reset_reason_t of this boot.
    pub reset_reason: u32,
    /// Since the last power-on (RTC no-init memory).
    pub boot_count: u32,
    pub wdt_resets: u32,
    pub panic_resets: u32,
    pub brownout_resets: u32,
    pub heap_free: u32,
    pub heap_min_free: u32,
    pub heap_largest_free: u32,
    pub led_count: u32,
    /// Wi-Fi leases obtained / lost since boot.
    pub wifi_joins: u32,
    pub wifi_link_losses: u32,
    /// Smoothed RSSI of frames from the joined AP, dBm (0 = unknown).
    pub wifi_rssi_dbm: i32,
    /// Bluetooth links that dropped (supervision / LL timeout).
    pub ble_drops: u32,
    /// 0 = no mesh; 1 flood, 2 tree.
    pub mesh_mode: u32,
    pub mesh_members: u32,
    pub mesh_delivery_permille: u32,
    pub mesh_airtime_permille: u32,
    pub mesh_relay_load_permille: u32,
    pub mesh_mode_switches: u32,
}

/// The C++ snapshot filler (None: host builds, and boards that don't register one).
static mut SOURCE: Option<unsafe extern "C" fn(*mut LmSysMetrics)> = None;
/// Times an effect started lagging (counted where the lag change is taken).
static mut LAG_EVENTS: u32 = 0;

/// Register the snapshot filler (main.cpp setup). Called once, before the transports.
///
/// # Safety
/// `f` must stay valid for the program's life and only write the struct it is given.
#[no_mangle]
pub unsafe extern "C" fn lm_metrics_set_source(f: Option<unsafe extern "C" fn(*mut LmSysMetrics)>) {
    SOURCE = f;
}

/// An effect started lagging (lm_fps_take_lag_notify).
pub(crate) unsafe fn note_lag_start() {
    LAG_EVENTS = LAG_EVENTS.wrapping_add(1);
}

#[cfg(lm_ota_inapp)]
const BOARD: &[u8] = b"esp32p4";
#[cfg(all(not(lm_ota_inapp), target_arch = "riscv32"))]
const BOARD: &[u8] = b"esp32c6";
#[cfg(all(not(lm_ota_inapp), not(target_arch = "riscv32")))]
const BOARD: &[u8] = b"host";

/// sint32 zig-zag.
fn zigzag(v: i32) -> u64 {
    ((v << 1) ^ (v >> 31)) as u32 as u64
}

/// Body of DeviceMetrics. Zero values are left out (proto3 defaults).
pub(crate) fn write_metrics(w: &mut PbOut, s: &LmSysMetrics, fps: [u32; 5], lagging: bool, lag_events: u32) {
    fn u(w: &mut PbOut, f: u32, v: u32) {
        if v != 0 {
            w.uint(f, v as u64);
        }
    }
    w.uint(1, METRICS_VERSION);
    w.bytes(2, BOARD);
    for (i, v) in fps.iter().enumerate() {
        u(w, 10 + i as u32, *v);
    }
    if lagging {
        w.uint(15, 1);
    }
    u(w, 16, lag_events);
    u(w, 17, s.heap_free);
    u(w, 18, s.heap_min_free);
    u(w, 19, s.heap_largest_free);
    u(w, 20, s.led_count);
    u(w, 30, s.uptime_s);
    u(w, 31, s.reset_reason);
    u(w, 32, s.boot_count);
    u(w, 33, s.wdt_resets);
    u(w, 34, s.panic_resets);
    u(w, 35, s.brownout_resets);
    u(w, 36, s.wifi_joins);
    u(w, 37, s.wifi_link_losses);
    if s.wifi_rssi_dbm != 0 {
        w.uint(38, zigzag(s.wifi_rssi_dbm));
    }
    u(w, 39, s.ble_drops);
    u(w, 50, s.mesh_mode);
    if s.mesh_mode != 0 {
        u(w, 51, s.mesh_members);
        u(w, 52, s.mesh_delivery_permille);
        u(w, 53, s.mesh_airtime_permille);
        u(w, 54, s.mesh_relay_load_permille);
        u(w, 55, s.mesh_mode_switches);
    }
}

/// get_device_metrics: the snapshot, encoded zero-copy into `out`.
pub(crate) unsafe fn handle_get_device_metrics(out: *mut u8, out_cap: usize) -> i32 {
    let mut s = LmSysMetrics::default();
    if let Some(f) = *addr_of!(SOURCE) {
        f(&mut s);
    }
    let c = &*addr_of!(FPS);
    let fps = [c.pinned_fps(), c.current_fps(), c.achieved_fps(), c.min_fps(), c.max_fps()];
    let (lagging, lag) = (c.lagging(), LAG_EVENTS);
    write_arm(out, out_cap, ARM_DEVICE_METRICS, |w| write_metrics(w, &s, fps, lagging, lag))
}
