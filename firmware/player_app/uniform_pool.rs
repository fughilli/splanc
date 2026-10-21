//! The uniform pool (docs/design/sensor-core.md §Effects): named live values
//! that producers publish and effects consume as ordinary uniforms, bound BY
//! NAME. An effect that declares `uniform vec4 imu_quat;` gets the fused
//! orientation written into that uniform every frame while a sensor is
//! running; without a sensor the uniform keeps its default / UI value, so the
//! same effect previews (and can be driven by hand) with no hardware.
//!
//! Producers:
//! - the native sensor core (sensor_ffi.rs): the fixed `imu_*` entries below,
//!   computed per frame from the seqlocked snapshot, and only when bound;
//! - dynamic entries published by name (`publish`) — the hook the on-device
//!   driver VM's exports use (FUG-107), so a VM-driven sensor lands in the
//!   same pool.
//!
//! Binding happens off the render path: at effect load (`bind`, loop task) and
//! when a NEW dynamic name appears (`publish` rebinds). The render task's
//! per-frame `apply` is a short loop of slot writes; with nothing bound it is
//! one branch. Everything runs under the player mutex like the rest of ffi.rs.

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_fx_vm::Program;
use ledmapper_osc as osc;
use ledmapper_sensor::math::Quat;

use super::{deck, fx_set_uniform, sensor_ffi, N_DECKS};

/// Pool entries (the fixed sensor names + dynamic ones).
pub const POOL_CAP: usize = 24;
/// Bound uniforms per deck.
pub const MAX_BIND: usize = 12;
const NAME_MAX: usize = osc::MAX_NAME;

/// The native sensor core's entries: (uniform name, width). Units are chosen
/// for effects: accelerations in g (1.0 = gravity), angles in radians, and
/// vectors in the MAP frame effects already use for `led.pos` (+Y up) — the
/// sensor core's z-up fixture frame is rotated -90° about x on the way in
/// (x, y, z) -> (x, z, -y). Yaw between the sensor and the map is the mount
/// calibration's job (identity until set; see the design doc).
pub const SENSOR_ENTRIES: [(&str, u8); 9] = [
    // Fixture->world orientation, (w, x, y, z), map axes (+Y up).
    ("imu_quat", 4),
    // (roll, pitch, yaw) radians, aerospace Z-Y-X about the sensor core's
    // z-up axes (yaw = heading about vertical); yaw drifts without a magnetometer.
    ("imu_euler", 3),
    // Unit vector pointing DOWN, fixture frame: dot(led.pos, imu_gravity) > 0
    // on the floor-side LEDs.
    ("imu_gravity", 3),
    // Gravity-removed acceleration, world frame, g.
    ("imu_lin_accel", 3),
    // Raw (calibrated) accel, fixture frame, g — 1.0 up at rest.
    ("imu_accel", 3),
    // Angular rate, fixture frame, rad/s.
    ("imu_gyro", 3),
    // Shake level 0..1.
    ("imu_shake", 1),
    // Tap counter (increments per tap; compare to the last value in update()).
    ("imu_tap", 1),
    // Shake-episode counter.
    ("imu_shake_count", 1),
];

#[derive(Clone, Copy)]
struct Entry {
    name: [u8; NAME_MAX],
    name_len: u8,
    width: u8,
    vals: [f32; 4],
    /// Dynamic entries: has a value been published since (re)creation.
    live: bool,
}

const EMPTY: Entry = Entry { name: [0; NAME_MAX], name_len: 0, width: 0, vals: [0.0; 4], live: false };

#[derive(Clone, Copy)]
struct Bind {
    entry: u8,
    slot: u16,
    width: u8,
}

const NO_BIND: Bind = Bind { entry: 0, slot: 0, width: 0 };

/// Dynamic entries only (sensor entries are implicit indices 0..SENSOR_ENTRIES).
static mut DYN: [Entry; POOL_CAP - SENSOR_ENTRIES.len()] = [EMPTY; POOL_CAP - SENSOR_ENTRIES.len()];
static mut DYN_LEN: usize = 0;
static mut BINDS: [[Bind; MAX_BIND]; N_DECKS] = [[NO_BIND; MAX_BIND]; N_DECKS];
static mut BIND_N: [u8; N_DECKS] = [0; N_DECKS];
/// Any deck reads a sensor entry (gates the per-frame snapshot read).
static mut BINDS_SENSOR: [bool; N_DECKS] = [false; N_DECKS];

fn entry_name(i: usize) -> &'static [u8] {
    if i < SENSOR_ENTRIES.len() {
        SENSOR_ENTRIES[i].0.as_bytes()
    } else {
        // SAFETY: names are only mutated on the loop task under the mutex.
        unsafe {
            let e = &(*addr_of!(DYN))[i - SENSOR_ENTRIES.len()];
            core::slice::from_raw_parts(e.name.as_ptr(), e.name_len as usize)
        }
    }
}

fn entry_width(i: usize) -> u8 {
    if i < SENSOR_ENTRIES.len() {
        SENSOR_ENTRIES[i].1
    } else {
        unsafe { (*addr_of!(DYN))[i - SENSOR_ENTRIES.len()].width }
    }
}

unsafe fn entries() -> usize {
    SENSOR_ENTRIES.len() + DYN_LEN
}

/// (Re)bind deck `d`'s uniforms to pool entries by name. Called at effect load
/// (with the loaded manifest) and after a new dynamic entry appears.
///
/// # Safety
/// Loop task, under the player mutex (builds a ~0.9 KB PortTable on the stack).
pub(crate) unsafe fn bind(d: usize, manifest: &[u8]) {
    if d >= N_DECKS {
        return;
    }
    let table = osc::parse_manifest(manifest);
    let mut n = 0usize;
    let mut sensor = false;
    for i in 0..entries() {
        if n >= MAX_BIND {
            break;
        }
        let Ok(name) = core::str::from_utf8(entry_name(i)) else { continue };
        if let Some(port) = table.resolve(name) {
            let w = port.width.min(entry_width(i));
            if w == 0 {
                continue;
            }
            (*addr_of_mut!(BINDS))[d][n] = Bind { entry: i as u8, slot: port.slot, width: w };
            n += 1;
            sensor |= i < SENSOR_ENTRIES.len();
        }
    }
    (*addr_of_mut!(BIND_N))[d] = n as u8;
    (*addr_of_mut!(BINDS_SENSOR))[d] = sensor;
}

/// Rebind every loaded deck against its resident manifest.
unsafe fn rebind_all() {
    for d in 0..N_DECKS {
        let Some(p) = deck(d) else { continue };
        if (*p).len == 0 {
            continue;
        }
        let bytes = &(*p).bytes[..(*p).len];
        if let Ok(prog) = Program::parse(bytes) {
            bind(d, prog.manifest);
        }
    }
}

/// Publish a dynamic entry (a VM driver export). A new name allocates an entry
/// and rebinds the decks; returns false when the pool is full or the name is
/// unusable. Width = vals.len() (1..4).
///
/// # Safety
/// Loop task, under the player mutex.
pub(crate) unsafe fn publish(name: &[u8], vals: &[f32]) -> bool {
    if name.is_empty() || name.len() > NAME_MAX || vals.is_empty() || vals.len() > 4 {
        return false;
    }
    let dyn_ = &mut *addr_of_mut!(DYN);
    let mut found = None;
    for (i, e) in dyn_[..DYN_LEN].iter().enumerate() {
        if &e.name[..e.name_len as usize] == name {
            found = Some(i);
            break;
        }
    }
    let i = match found {
        Some(i) => i,
        None => {
            if DYN_LEN >= dyn_.len() || SENSOR_ENTRIES.iter().any(|(n, _)| n.as_bytes() == name) {
                return false;
            }
            let e = &mut dyn_[DYN_LEN];
            *e = EMPTY;
            e.name[..name.len()].copy_from_slice(name);
            e.name_len = name.len() as u8;
            e.width = vals.len() as u8;
            DYN_LEN += 1;
            rebind_all();
            DYN_LEN - 1
        }
    };
    let e = &mut dyn_[i];
    e.vals[..vals.len()].copy_from_slice(vals);
    e.live = true;
    true
}

/// Drop every dynamic entry (driver removed) and rebind.
///
/// # Safety
/// Loop task, under the player mutex.
pub(crate) unsafe fn clear_dynamic() {
    DYN_LEN = 0;
    rebind_all();
}

/// Names + widths currently in the pool (for get_sensors / tests).
pub(crate) unsafe fn for_each_entry(mut f: impl FnMut(&[u8], u8, bool)) {
    let live_sensor = sensor_ffi::sensor_running();
    for i in 0..entries() {
        let live = if i < SENSOR_ENTRIES.len() {
            live_sensor
        } else {
            (*addr_of!(DYN))[i - SENSOR_ENTRIES.len()].live
        };
        f(entry_name(i), entry_width(i), live);
    }
}

/// Write every bound, live pool value into its deck's uniforms for this frame.
/// Render task, under the player mutex, before the decks' update().
///
/// # Safety
/// See module doc.
pub(crate) unsafe fn apply_frame() {
    let n = *addr_of!(BIND_N);
    if n.iter().all(|&k| k == 0) {
        return;
    }
    let need_sensor = (*addr_of!(BINDS_SENSOR)).iter().any(|&b| b);
    let snap = if need_sensor { sensor_ffi::running_snapshot() } else { None };
    for d in 0..N_DECKS {
        for b in &(*addr_of!(BINDS))[d][..n[d] as usize] {
            let i = b.entry as usize;
            let mut v = [0.0f32; 4];
            if i < SENSOR_ENTRIES.len() {
                let Some(s) = snap.as_ref() else { continue };
                let g = 1.0 / ledmapper_sensor::math::GRAVITY;
                match i {
                    0 => v = quat_to_map(s.quat),
                    1 => v[..3].copy_from_slice(&Quat::from_array(s.quat).to_euler()),
                    2 => v[..3].copy_from_slice(&to_map(s.gravity, 1.0)),
                    3 => v[..3].copy_from_slice(&to_map(s.linear_accel, g)),
                    4 => v[..3].copy_from_slice(&to_map(s.accel, g)),
                    5 => v[..3].copy_from_slice(&to_map(s.gyro, 1.0)),
                    6 => v[0] = s.shake,
                    7 => v[0] = s.tap_count as f32,
                    _ => v[0] = s.shake_count as f32,
                }
            } else {
                let e = &(*addr_of!(DYN))[i - SENSOR_ENTRIES.len()];
                if !e.live {
                    continue;
                }
                v = e.vals;
            }
            fx_set_uniform(d, b.slot as u32, &v[..b.width as usize]);
        }
    }
}

/// z-up sensor-core frame -> +Y-up map frame (scaled): (x, y, z) -> (x, z, -y).
fn to_map(v: [f32; 3], k: f32) -> [f32; 3] {
    [v[0] * k, v[2] * k, -v[1] * k]
}

/// The same change of basis on both sides of a rotation: c q c^-1, c = -90°
/// about x. Expanded: (w, x, y, z) -> (w, x, z, -y).
fn quat_to_map(q: [f32; 4]) -> [f32; 4] {
    [q[0], q[1], q[3], -q[2]]
}
