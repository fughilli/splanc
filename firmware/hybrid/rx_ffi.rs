//! RX-ingest FFI for the hybrid firmware: a single static `Stack` (in .bss, not
//! on any task stack) plus an `extern "C"` entry that hands a raw 802.11 frame to
//! the heapless netstack.
//!
//! Fully zero-copy: the frame pointer is the radio's RX buffer. Management frames
//! advance the role state machines in place; for data frames, `on_rx` invokes a
//! closure with the payload borrowing that same buffer, and the closure walks it
//! with the zero-copy protobuf reader — no byte is ever copied into an app buffer.

#![no_std]
#![allow(static_mut_refs)]

use ledmapper_netstack::mlme::Mac;
use ledmapper_netstack::pb::PbReader;
use ledmapper_netstack::stack::{Ingest, Role, Stack};

const SELF_MAC: Mac = [0x02, 0x00, 0x53, 0x45, 0x43, 0x01];
const BSSID: Mac = [0x02, 0x00, 0x53, 0x45, 0x43, 0xa0];

// Fixed, static stack instance in .bss (never pressures a task stack).
static mut STACK: Option<Stack<1, 2, 4, 4>> = None;
// Zero-copy demonstration counters: data frames delivered + protobuf fields
// decoded directly out of the radio RX buffer.
static mut DATA_FRAMES: u32 = 0;
static mut PB_FIELDS: u32 = 0;

/// Feed one received 802.11 frame to the heapless stack (zero copy). Returns a
/// status code: 0=Consumed, 1=Replied, 2=Ignored, 3=Refused.
#[no_mangle]
pub extern "C" fn netstack_rx_ingest(frame: *const u8, len: u32) -> u32 {
    if frame.is_null() || len == 0 {
        return 3;
    }
    let s = unsafe {
        if STACK.is_none() {
            STACK = Some(Stack::new(Role::Sta, SELF_MAC, BSSID));
        }
        STACK.as_mut().unwrap()
    };
    let slice = unsafe { core::slice::from_raw_parts(frame, len as usize) };
    let r = s.on_rx(slice, |view| {
        // Data payload borrows the RX buffer; decode it in place, zero copy.
        unsafe { DATA_FRAMES += 1 };
        for (_field, _value) in PbReader::new(view.payload) {
            unsafe { PB_FIELDS += 1 };
        }
    });
    match r {
        Ingest::Consumed => 0,
        Ingest::Replied(_) => 1,
        Ingest::Ignored => 2,
        Ingest::Refused => 3,
    }
}

/// Kick off a STA join to `bssid` (6 bytes): the MLME builds an auth request and
/// queues it for transmission. Returns 1 if queued.
#[no_mangle]
pub extern "C" fn netstack_sta_connect(bssid: *const u8) -> u32 {
    if bssid.is_null() {
        return 0;
    }
    let mut b: Mac = [0; 6];
    unsafe { core::ptr::copy_nonoverlapping(bssid, b.as_mut_ptr(), 6) };
    let s = unsafe {
        if STACK.is_none() {
            STACK = Some(Stack::new(Role::Sta, SELF_MAC, BSSID));
        }
        STACK.as_mut().unwrap()
    };
    matches!(s.sta_connect(b), Ingest::Replied(_)) as u32
}

/// Drain the next frame the stack has queued for transmission into `buf`,
/// returning its length (0 if none). The firmware hands each to esp_wifi_80211_tx.
#[no_mangle]
pub extern "C" fn netstack_tx_next(buf: *mut u8, cap: u32) -> u32 {
    if buf.is_null() {
        return 0;
    }
    let s = unsafe {
        match STACK.as_mut() {
            Some(st) => st,
            None => return 0,
        }
    };
    let out = unsafe { core::slice::from_raw_parts_mut(buf, cap as usize) };
    s.pop_tx(out) as u32
}

/// Zero-copy telemetry for the firmware to print: (data_frames, pb_fields).
#[no_mangle]
pub extern "C" fn netstack_rx_stats(data_frames: *mut u32, pb_fields: *mut u32) {
    unsafe {
        if !data_frames.is_null() {
            *data_frames = DATA_FRAMES;
        }
        if !pb_fields.is_null() {
            *pb_fields = PB_FIELDS;
        }
    }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
