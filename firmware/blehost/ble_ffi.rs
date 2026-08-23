//! BLE-host FFI: a static HCI host + Improv GATT service driving the vendor BLE
//! controller. The firmware pumps HCI packets between the controller and this
//! state machine; advertising bring-up, ATT/GATT discovery, and the Improv
//! provisioning flow are all here in the heapless netstack — the controller only
//! owns the radio link.

#![no_std]
#![allow(static_mut_refs)]

use ledmapper_netstack::ble::att::AttPdu;
use ledmapper_netstack::gatt::{GATT_RSP_MAX, GATT_VAL_MAX};
use ledmapper_netstack::hci::{acl, parse_acl, BleHost, HostState, H4_ACL, H4_EVT};
use ledmapper_netstack::improv::{Action, ImprovService, IMPROV_SVC_UUID, MAX_PASS, MAX_SSID};
use ledmapper_netstack::rx::Buf;

static mut HOST: BleHost = BleHost::new();
static mut IMPROV: Option<ImprovService> = None;

// Pending provisioning request handed to the firmware (which owns Wi-Fi), plus a
// queue of value handles to notify the central after an RPC.
static mut PENDING_SSID: Buf<MAX_SSID> = Buf::new();
static mut PENDING_PASS: Buf<MAX_PASS> = Buf::new();
static mut HAS_PENDING: bool = false;
static mut NOTIFY_Q: [u16; 4] = [0; 4];
static mut NOTIFY_N: usize = 0;

fn copy_out(src: &[u8], out: *mut u8, cap: u32) -> u32 {
    let n = src.len().min(cap as usize);
    unsafe { core::ptr::copy_nonoverlapping(src.as_ptr(), out, n) };
    n as u32
}

/// One-time setup: advertise Flags + the Improv 128-bit service UUID (so the
/// Improv provisioner recognises us), the name in the scan response, and build the
/// Improv GATT service.
#[no_mangle]
pub extern "C" fn ns_ble_setup() {
    unsafe {
        // Primary ADV: Flags (LE General Discoverable, BR/EDR not supported) +
        // Complete List of 128-bit Service UUIDs (0x07) = the Improv service.
        let mut adv: Buf<31> = Buf::new();
        let _ = adv.extend(&[0x02, 0x01, 0x06]);
        let _ = adv.extend(&[0x11, 0x07]);
        let _ = adv.extend(&IMPROV_SVC_UUID);
        HOST.set_adv(adv.as_slice());
        // Scan response: the complete local name (NO Flags AD). A distinct name
        // ("heapless-ble") so a scanner doesn't confuse us with older DUTs still
        // advertising "heapless-c6"/"-imp" within the rigs' shared BLE range.
        HOST.set_scan_rsp(&[
            0x09, 0x09, b'h', b'l', b's', b'-', b'f', b'i', b'x', b'1',
        ]);
        IMPROV = Some(ImprovService::new());
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

/// Wrap an ATT payload in L2CAP (CID 0x0004) + an HCI ACL for `handle` into `out`.
fn wrap_att_acl(handle: u16, att: &[u8], out: *mut u8, cap: u32) -> u32 {
    let mut l2buf: Buf<{ GATT_RSP_MAX + 4 }> = Buf::new();
    let _ = l2buf.extend(&(att.len() as u16).to_le_bytes());
    let _ = l2buf.extend(&[0x04, 0x00]);
    let _ = l2buf.extend(att);
    let mut aclb: Buf<{ GATT_RSP_MAX + 8 }> = Buf::new();
    if acl(handle, l2buf.as_slice(), &mut aclb).is_err() {
        return 0;
    }
    copy_out(aclb.as_slice(), out, cap)
}

/// Process a received HCI packet (event or ACL). Writes any response ACL into
/// `out`, returning its length. ATT requests run the Improv GATT service; an RPC
/// write that carries Wi-Fi credentials stashes them for the firmware to act on.
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
            if l2.len() < 4 || u16::from_le_bytes([l2[2], l2[3]]) != 0x0004 {
                return 0; // only the ATT channel
            }
            let Some(pdu) = AttPdu::parse(&l2[4..]) else {
                return 0;
            };
            let svc = unsafe { IMPROV.as_mut() };
            let Some(svc) = svc else { return 0 };
            let mut att: Buf<GATT_RSP_MAX> = Buf::new();
            let outcome = svc.handle_att(pdu.opcode, pdu.params, &mut att);
            // Stash Wi-Fi credentials for the firmware; queue notifications.
            if let Action::Provision(creds) = outcome.action {
                unsafe {
                    PENDING_SSID.clear();
                    PENDING_PASS.clear();
                    let _ = PENDING_SSID.extend(creds.ssid.as_slice());
                    let _ = PENDING_PASS.extend(creds.pass.as_slice());
                    HAS_PENDING = true;
                }
            }
            queue_notifications(&outcome.notify);
            if outcome.resp_len == 0 {
                return 0; // write-command: no ATT response
            }
            wrap_att_acl(handle, att.as_slice(), out, cap)
        }
        _ => 0,
    }
}

fn queue_notifications(handles: &[u16]) {
    unsafe {
        for &h in handles {
            if h != 0 && NOTIFY_N < NOTIFY_Q.len() {
                NOTIFY_Q[NOTIFY_N] = h;
                NOTIFY_N += 1;
            }
        }
    }
}

/// Poll for the next queued characteristic notification (current-state / error /
/// RPC-result) as a ready-to-send ACL. Returns 0 when the queue is empty. The
/// firmware calls this in its loop after `ns_ble_on_hci`.
#[no_mangle]
pub extern "C" fn ns_ble_poll_notify(out: *mut u8, cap: u32) -> u32 {
    unsafe {
        if NOTIFY_N == 0 {
            return 0;
        }
        let Some(conn) = HOST.conn_handle() else {
            NOTIFY_N = 0;
            return 0;
        };
        let h = NOTIFY_Q[0];
        NOTIFY_Q.copy_within(1..NOTIFY_N, 0);
        NOTIFY_N -= 1;
        let Some(svc) = IMPROV.as_ref() else { return 0 };
        let mut ntf: Buf<GATT_RSP_MAX> = Buf::new();
        if svc.db.notification(h, &mut ntf) == 0 {
            return 0;
        }
        wrap_att_acl(conn, ntf.as_slice(), out, cap)
    }
}

/// Retrieve pending Wi-Fi credentials from an Improv SendWifi RPC. Copies the SSID
/// and passphrase (NUL-terminated) into the caller's buffers and returns 1 if a
/// request was pending (clearing it), else 0.
#[no_mangle]
pub extern "C" fn ns_ble_take_wifi(ssid: *mut u8, ssid_cap: u32, pass: *mut u8, pass_cap: u32) -> u32 {
    unsafe {
        if !HAS_PENDING {
            return 0;
        }
        HAS_PENDING = false;
        let sn = copy_out(PENDING_SSID.as_slice(), ssid, ssid_cap.saturating_sub(1));
        *ssid.add(sn as usize) = 0;
        let pn = copy_out(PENDING_PASS.as_slice(), pass, pass_cap.saturating_sub(1));
        *pass.add(pn as usize) = 0;
        1
    }
}

/// Report the outcome of the firmware's Wi-Fi connection attempt back to Improv
/// (updates current-state/error/result + queues their notifications).
#[no_mangle]
pub extern "C" fn ns_ble_provision_result(ok: u32) {
    unsafe {
        if let Some(svc) = IMPROV.as_mut() {
            svc.finish_provisioning(ok != 0, &[]);
            let (c, e, r) =
                (svc.current_state_handle(), svc.error_state_handle(), svc.rpc_result_handle());
            queue_notifications(&[c, e, r]);
        }
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
        HostState::BufSizeSent => 10,
        HostState::FeatSent => 11,
        HostState::AdvParamsSent => 3,
        HostState::AdvDataSent => 4,
        HostState::ScanRspSent => 9,
        HostState::AdvEnableSent => 5,
        HostState::Advertising => 6,
        HostState::Connected(_) => 7,
    }
}

// Keep the Wi-Fi buffer bound referenced (documents the FFI contract for callers).
const _: () = assert!(MAX_SSID <= GATT_VAL_MAX && MAX_PASS <= GATT_VAL_MAX);

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
