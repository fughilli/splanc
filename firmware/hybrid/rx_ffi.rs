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
