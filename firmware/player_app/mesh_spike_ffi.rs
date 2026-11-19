//! The M2 mesh envelope (firmware/mesh `envelope` + `replay`, design §5.1, §7.5) for the M3a
//! spike's C++ side (mesh_spike_impl.h): seal / open AES-128-CCM frames with 64-bit
//! counters, and a per-source replay window. Linked only into the LM_MESH_SPIKE player.
//!
//! No statics: the replay table lives in the caller's buffer (allocated when the mesh is
//! enabled, [`ns_mesh_replay_size`] bytes), so a disabled mesh costs no RAM.
//!
//! Membership is the owner's spike rule (desk #67): one dev-only key per site, loaded over
//! the HITL console, used as the mesh key of epoch 1. No joins, no rotation (M7).

#![cfg_attr(not(test), no_std)]
#![allow(clippy::missing_safety_doc)]

use splanc_mesh::envelope::{self, Header, MicLen, EPOCH_FIRST};
use splanc_mesh::replay::{ReplayReject, ReplayTable};

/// Sources the spike's replay table tracks.
const SOURCES: usize = 8;
type Table = ReplayTable<SOURCES>;

/// Bytes the caller allocates for the replay table.
#[no_mangle]
pub extern "C" fn ns_mesh_replay_size() -> u32 {
    core::mem::size_of::<Table>() as u32
}

/// Initialise a replay table in `buf` (`ns_mesh_replay_size` bytes, 8-aligned).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_replay_init(buf: *mut u8) {
    core::ptr::write(buf as *mut Table, Table::new());
}

/// The epoch-1 frame key for `mesh_id` and the dev site key (16 bytes) into `out` (16).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_frame_key(mesh_id: u32, site_key: *const u8, out: *mut u8) {
    let k = &*(site_key as *const [u8; 16]);
    let fk = envelope::frame_key(mesh_id, k, EPOCH_FIRST);
    core::ptr::copy_nonoverlapping(fk.as_ptr(), out, 16);
}

/// Seal `body` into `out` (long header: every frame carries its full 64-bit counter, so a
/// receiver syncs without a freshness exchange; MIC 8, the 802.11 size). Returns the
/// envelope length, or 0 if `out` is short.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_seal(key: *const u8, mesh_id: u32, src: u16, counter: u64, body: *const u8,
                                      len: u32, out: *mut u8, cap: u32) -> u32 {
    let key = &*(key as *const [u8; 16]);
    let h = Header { mesh_id, epoch: EPOCH_FIRST, src, counter, long: true };
    let body = core::slice::from_raw_parts(body, len as usize);
    let out = core::slice::from_raw_parts_mut(out, cap as usize);
    envelope::seal(key, MicLen::M8, &h, body, out).unwrap_or(0) as u32
}

/// `ns_mesh_open` results (negative = rejected).
pub const OPEN_NOT_ENVELOPE: i32 = -1;
pub const OPEN_OTHER_MESH: i32 = -2;
pub const OPEN_DUPLICATE: i32 = -3;
pub const OPEN_TOO_OLD: i32 = -4;
pub const OPEN_TABLE_FULL: i32 = -5;
pub const OPEN_BAD_MIC: i32 = -6;

/// Open the envelope in `frame[..len]` in place: decode the header, check the replay window
/// (before any AES), verify + decrypt, then commit the counter. On success returns the body
/// offset in `frame` and writes its length, the source and the counter; else a negative
/// `OPEN_*` code.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_open(key: *const u8, mesh_id: u32, table: *mut u8, now_s: u32, frame: *mut u8,
                                      len: u32, body_len: *mut u32, src: *mut u16, counter: *mut u64) -> i32 {
    let key = &*(key as *const [u8; 16]);
    let t = &mut *(table as *mut Table);
    let f = core::slice::from_raw_parts_mut(frame, len as usize);
    let h = match Header::decode(f) {
        Ok(h) => h,
        Err(_) => return OPEN_NOT_ENVELOPE,
    };
    if h.mesh_id != mesh_id || h.epoch != EPOCH_FIRST {
        return OPEN_OTHER_MESH;
    }
    let ctr = if h.long {
        h.counter
    } else {
        match t.state(h.src) {
            Some(s) => envelope::reconstruct(s.high, h.counter as u32),
            None => return OPEN_TOO_OLD, // no state for a short header: wait for a long one
        }
    };
    if let Err(r) = t.check(h.src, ctr, now_s) {
        t.count(r);
        return reject(r);
    }
    let range = match envelope::open(key, MicLen::M8, &h, ctr, f) {
        Ok(r) => r,
        Err(_) => return OPEN_BAD_MIC,
    };
    if let Err(r) = t.commit(h.src, ctr, now_s) {
        return reject(r);
    }
    *body_len = (range.end - range.start) as u32;
    *src = h.src;
    *counter = ctr;
    range.start as i32
}

fn reject(r: ReplayReject) -> i32 {
    match r {
        ReplayReject::Duplicate => OPEN_DUPLICATE,
        ReplayReject::TooOld => OPEN_TOO_OLD,
        ReplayReject::Full => OPEN_TABLE_FULL,
    }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

#[cfg(test)]
mod tests {

    use super::*;
    use std::vec;

    #[test]
    fn seal_open_round_trip_with_replay_and_wrong_key() {
        let site = [7u8; 16];
        let mut key = [0u8; 16];
        let mut other = [0u8; 16];
        unsafe {
            ns_mesh_frame_key(0x5150, site.as_ptr(), key.as_mut_ptr());
            ns_mesh_frame_key(0x5150, [8u8; 16].as_ptr(), other.as_mut_ptr());
        }
        let mut table = vec![0u64; (ns_mesh_replay_size() as usize).div_ceil(8)];
        let tp = table.as_mut_ptr() as *mut u8;
        unsafe { ns_mesh_replay_init(tp) };
        let body = [0x5au8; 200];
        let mut f = [0u8; 300];
        let n = unsafe { ns_mesh_seal(key.as_ptr(), 0x5150, 2, 1 << 40, body.as_ptr(), 200, f.as_mut_ptr(), 300) };
        assert_eq!(n as usize, 18 + 200 + 8);
        let (mut bl, mut src, mut ctr) = (0u32, 0u16, 0u64);
        let open = |key: &[u8; 16], frame: &mut [u8], bl: &mut u32, src: &mut u16, ctr: &mut u64| unsafe {
            ns_mesh_open(key.as_ptr(), 0x5150, tp, 1, frame.as_mut_ptr(), n, bl, src, ctr)
        };
        let mut g = f;
        assert_eq!(open(&other, &mut g, &mut bl, &mut src, &mut ctr), OPEN_BAD_MIC);
        let mut g = f;
        let off = open(&key, &mut g, &mut bl, &mut src, &mut ctr);
        assert_eq!((off, bl, src, ctr), (18, 200, 2, 1 << 40));
        assert_eq!(&g[18..218], &body[..]);
        // A MAC retry of the same MPDU is a replay: dropped before any AES.
        let mut g = f;
        assert_eq!(open(&key, &mut g, &mut bl, &mut src, &mut ctr), OPEN_DUPLICATE);
        // Another mesh id is not ours.
        let mut g = f;
        unsafe {
            assert_eq!(ns_mesh_open(key.as_ptr(), 0x5151, tp, 1, g.as_mut_ptr(), n, &mut bl, &mut src, &mut ctr),
                       OPEN_OTHER_MESH);
        }
        // No Espressif OUI / ESP-NOW header in the envelope.
        assert_eq!(&f[..2], b"SL");
    }
}
