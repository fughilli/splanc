//! BLE-host FFI: a static HCI host + GATT server driving the vendor BLE
//! controller over VHCI. The firmware pumps HCI packets between the controller
//! and this state machine; advertising bring-up and ATT/GATT are all here, in the
//! heapless netstack — the controller only owns the radio link.

#![no_std]
#![allow(static_mut_refs)]

use ledmapper_netstack::ble::att::AttPdu;
use ledmapper_netstack::gap::{Attribute, GattServer, ATT_VAL_MAX};
use ledmapper_netstack::hci::{acl, parse_acl, BleHost, HostState, H4_ACL, H4_EVT};
use ledmapper_netstack::rx::Buf;

static mut HOST: BleHost = BleHost::new();
static mut GATT: GattServer<8> = GattServer::new();

fn copy_out(src: &[u8], out: *mut u8, cap: u32) -> u32 {
    let n = src.len().min(cap as usize);
    unsafe { core::ptr::copy_nonoverlapping(src.as_ptr(), out, n) };
    n as u32
}

/// One-time setup: advertising payload (flags + complete local name) + a small
/// GATT table (a device-name characteristic to read/write).
#[no_mangle]
pub extern "C" fn ns_ble_setup() {
    unsafe {
        // AD: Flags (LE General Discoverable) + Complete Local Name "heapless-c6".
        HOST.set_adv(&[
            0x02, 0x01, 0x06, 0x0c, 0x09, b'h', b'e', b'a', b'p', b'l', b'e', b's', b's', b'-', b'c',
            b'6',
        ]);
        // Scan response: the complete local name only (NO Flags AD — invalid in a
        // scan response). Lets an active scanner finish discovery and then connect.
        HOST.set_scan_rsp(&[
            0x0c, 0x09, b'h', b'e', b'a', b'p', b'l', b'e', b's', b's', b'-', b'c', b'6',
        ]);
        let _ = GATT.add(Attribute::new(0x0003, 0x2a00, b"heapless-c6", true));
    }
}

/// Next HCI command to send for bring-up (the initial Reset). 0 when idle.
#[no_mangle]
pub extern "C" fn ns_ble_poll_cmd(out: *mut u8, cap: u32) -> u32 {
    let mut b: Buf<64> = Buf::new();
    let n = unsafe { HOST.poll_cmd(&mut b) };
    if n == 0 {
        return 0;
    }
    copy_out(b.as_slice(), out, cap)
}

/// Process a received HCI packet (event or ACL). Writes any response to send back
/// to the controller into `out`, returning its length. For an ATT request on the
/// connection, this runs the GATT server and returns the ATT response as an ACL.
#[no_mangle]
pub extern "C" fn ns_ble_on_hci(pkt: *const u8, len: u32, out: *mut u8, cap: u32) -> u32 {
    if pkt.is_null() || len == 0 {
        return 0;
    }
    let s = unsafe { core::slice::from_raw_parts(pkt, len as usize) };
    match s[0] {
        H4_EVT => {
            let mut b: Buf<64> = Buf::new();
            let n = unsafe { HOST.on_event(s, &mut b) };
            if n == 0 {
                0
            } else {
                copy_out(b.as_slice(), out, cap)
            }
        }
        H4_ACL => {
            let Some((handle, l2)) = parse_acl(s) else {
                return 0;
            };
            if l2.len() < 4 {
                return 0;
            }
            let cid = u16::from_le_bytes([l2[2], l2[3]]);
            if cid != 0x0004 {
                return 0; // only ATT for now
            }
            let Some(pdu) = AttPdu::parse(&l2[4..]) else {
                return 0;
            };
            let mut att: Buf<{ ATT_VAL_MAX + 8 }> = Buf::new();
            if unsafe { GATT.handle_att(&pdu, &mut att) }.is_err() {
                return 0;
            }
            // Wrap the ATT response in L2CAP (CID 0x0004) then an HCI ACL.
            let mut l2buf: Buf<64> = Buf::new();
            let _ = l2buf.extend(&(att.len() as u16).to_le_bytes());
            let _ = l2buf.extend(&[0x04, 0x00]);
            let _ = l2buf.extend(att.as_slice());
            let mut aclb: Buf<64> = Buf::new();
            if acl(handle, l2buf.as_slice(), &mut aclb).is_err() {
                return 0;
            }
            copy_out(aclb.as_slice(), out, cap)
        }
        _ => 0,
    }
}

/// Host state for telemetry: 0=Init .. 6=Advertising, 7=Connected.
#[no_mangle]
pub extern "C" fn ns_ble_state() -> u32 {
    match unsafe { HOST.state } {
        HostState::Init => 0,
        HostState::ResetSent => 1,
        HostState::EvtMaskSent => 2,
        HostState::LeMaskSent => 8,
        HostState::AdvParamsSent => 3,
        HostState::AdvDataSent => 4,
        HostState::ScanRspSent => 9,
        HostState::AdvEnableSent => 5,
        HostState::Advertising => 6,
        HostState::Connected(_) => 7,
    }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
