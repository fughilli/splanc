//! C ABI for the P4 player's C++ (declared in firmware/netout/netout_ffi.h).
//!
//! The settings live in a static here. Every call comes from the player's one
//! message task (the same task that runs `lm_player_handle`), except the DDP
//! packet builder, which is pure and safe from any task.

use core::ffi::{c_char, CStr};

use crate::config::{
    net_index, Clock, EthConfig, IpMode, NetOutput, NetSettings, Phy, BLOB_LEN, NET_CHANNELS,
    NET_CHANNEL_FIRST,
};
use crate::wire::{self, Controller, LinkStatus, Request};

struct State {
    settings: NetSettings,
    gen: u32,
    commit: bool,
}

static mut STATE: State = State {
    settings: NetSettings {
        eth: EthConfig {
            enabled: false,
            phy: Phy::Ip101,
            phy_addr: 1,
            mdc: 31,
            mdio: 52,
            reset: 51,
            clock: Clock::ExtIn,
            clock_gpio: -1,
            ip_mode: IpMode::DhcpServer,
            ip: 0xC0A8_3201,
            netmask: 0xFFFF_FF00,
            gateway: 0,
        },
        outputs: [NetOutput { ip: 0, port: 0, name: [0; 32], name_len: 0 }; NET_CHANNELS],
    },
    gen: 0,
    commit: true,
};

#[allow(static_mut_refs)]
fn state() -> &'static mut State {
    // SAFETY: one task calls these (see the module note), so there is never a
    // second live reference.
    unsafe { &mut STATE }
}

/// A static C string for an error code.
fn c(code: &str) -> *const c_char {
    let s: &'static CStr = match code {
        "bad_phy" => c"bad_phy",
        "bad_pin" => c"bad_pin",
        "pin_in_use" => c"pin_in_use",
        "bad_address" => c"bad_address",
        "bad_channel" => c"bad_channel",
        "bad_message" => c"bad_message",
        _ => c"error",
    };
    s.as_ptr()
}

unsafe fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if p.is_null() || len == 0 { &[] } else { core::slice::from_raw_parts(p, len) }
}

unsafe fn bytes_mut<'a>(p: *mut u8, len: usize) -> &'a mut [u8] {
    if p.is_null() || len == 0 { &mut [] } else { core::slice::from_raw_parts_mut(p, len) }
}

unsafe fn cstr<'a>(p: *const c_char) -> &'a str {
    if p.is_null() {
        return "";
    }
    CStr::from_ptr(p).to_str().unwrap_or("error")
}

/// The Ethernet config as C sees it (netout_ffi.h `NetoutEthConfig`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct NetoutEthConfig {
    pub enabled: u8,
    /// 1 ip101, 2 lan8720, 3 rtl8201, 4 dp83848, 5 ksz80xx.
    pub phy: u8,
    pub phy_addr: i8,
    pub mdc: i8,
    pub mdio: i8,
    pub reset: i8,
    /// 0 = clock in on GPIO50, 1 = clock out on clock_gpio.
    pub clock: u8,
    pub clock_gpio: i8,
    /// 0 DHCP client, 1 static, 2 DHCP server.
    pub ip_mode: u8,
    pub ip: u32,
    pub netmask: u32,
    pub gateway: u32,
}

/// One network output (netout_ffi.h `NetoutTarget`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct NetoutTarget {
    pub ip: u32,
    /// The port to send to (the default filled in).
    pub port: u16,
}

/// The running link state (netout_ffi.h `NetoutLinkStatus`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
pub struct NetoutLinkStatus {
    pub link_up: u8,
    pub full_duplex: u8,
    pub speed_mbps: u32,
    pub ip: u32,
    pub netmask: u32,
    pub gateway: u32,
    pub mac: [u8; 6],
    pub tx_frames: u32,
    pub tx_errors: u32,
}

/// One discovered controller (netout_ffi.h `NetoutController`). Strings are
/// NUL-terminated in fixed arrays.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct NetoutController {
    pub name: [c_char; 33],
    pub version: [c_char; 17],
    pub ip: u32,
    pub mac: [u8; 6],
    pub led_count: u32,
}

fn arr_str(a: &[c_char]) -> &[u8] {
    // SAFETY: c_char and u8 have the same size and alignment.
    let b = unsafe { core::slice::from_raw_parts(a.as_ptr() as *const u8, a.len()) };
    let n = b.iter().position(|&x| x == 0).unwrap_or(b.len());
    &b[..n]
}

/// The arm (95-98) if `msg` is an Ethernet request, else 0.
#[no_mangle]
pub unsafe extern "C" fn netout_arm(msg: *const u8, len: usize) -> i32 {
    match wire::decode_client(bytes(msg, len)) {
        Ok(Request::SetEthernetConfig { .. }) => wire::CM_SET_ETHERNET_CONFIG as i32,
        Ok(Request::GetEthernetState) => wire::CM_GET_ETHERNET_STATE as i32,
        Ok(Request::DiscoverControllers { .. }) => wire::CM_DISCOVER_CONTROLLERS as i32,
        Ok(Request::SetNetworkOutput { .. }) => wire::CM_SET_NETWORK_OUTPUT as i32,
        // Ours but unparseable: answered with the state and the error.
        Ok(Request::Refused(_)) => match crate::pb::Reader::new(bytes(msg, len)).field() {
            Ok(Some((n, _))) => n as i32,
            _ => 0,
        },
        _ => 0,
    }
}

/// Apply a set_ethernet_config / set_network_output. `busy` are the GPIOs the
/// LED strips drive. Returns null on success (the gen is bumped) or a static
/// error code (nothing changed). Get / discover requests are a no-op (null).
#[no_mangle]
pub unsafe extern "C" fn netout_apply(
    msg: *const u8,
    len: usize,
    busy: *const i32,
    n_busy: usize,
) -> *const c_char {
    let busy: &[i32] = if busy.is_null() || n_busy == 0 { &[] } else { core::slice::from_raw_parts(busy, n_busy) };
    let s = state();
    match wire::decode_client(bytes(msg, len)) {
        Ok(Request::SetEthernetConfig { config, commit }) => {
            if let Err(r) = config.validate(busy) {
                return c(r.code());
            }
            s.settings.eth = config;
            s.commit = commit;
            s.gen = s.gen.wrapping_add(1);
            core::ptr::null()
        }
        Ok(Request::SetNetworkOutput { channel, output, commit }) => {
            let Some(i) = net_index(channel) else { return c("bad_channel") };
            if let Err(r) = output.validate() {
                return c(r.code());
            }
            s.settings.outputs[i] = output;
            s.commit = commit;
            s.gen = s.gen.wrapping_add(1);
            core::ptr::null()
        }
        Ok(Request::Refused(e)) => c(e),
        Ok(_) => core::ptr::null(),
        Err(_) => c("bad_message"),
    }
}

/// How long a discover_controllers request asks to wait (default and cap applied).
#[no_mangle]
pub unsafe extern "C" fn netout_discover_timeout_ms(msg: *const u8, len: usize) -> u32 {
    match wire::decode_client(bytes(msg, len)) {
        Ok(Request::DiscoverControllers { timeout_ms }) => timeout_ms,
        _ => wire::DISCOVER_DEFAULT_MS,
    }
}

/// Bumped by every applied change; the firmware polls it to re-apply and persist.
#[no_mangle]
pub extern "C" fn netout_gen() -> u32 {
    state().gen
}

/// Whether the latest change should be persisted (1) or is a preview (0).
#[no_mangle]
pub extern "C" fn netout_commit() -> i32 {
    state().commit as i32
}

#[no_mangle]
pub unsafe extern "C" fn netout_config(out: *mut NetoutEthConfig) {
    if out.is_null() {
        return;
    }
    let e = &state().settings.eth;
    *out = NetoutEthConfig {
        enabled: e.enabled as u8,
        phy: e.phy as u8,
        phy_addr: e.phy_addr,
        mdc: e.mdc,
        mdio: e.mdio,
        reset: e.reset,
        clock: e.clock as u8,
        clock_gpio: e.clock_gpio,
        ip_mode: e.ip_mode as u8,
        ip: e.ip,
        netmask: e.netmask,
        gateway: e.gateway,
    };
}

/// The target of LED `channel`: 1 and `*out` filled if it is a network channel
/// with a target, else 0.
#[no_mangle]
pub unsafe extern "C" fn netout_output(channel: i32, out: *mut NetoutTarget) -> i32 {
    let Some(i) = net_index(channel) else { return 0 };
    let o = &state().settings.outputs[i];
    if !o.active() {
        return 0;
    }
    if !out.is_null() {
        *out = NetoutTarget { ip: o.ip, port: o.port_or_default() };
    }
    1
}

/// The GPIOs the Ethernet config takes while enabled (none when disabled), for
/// refusing them as LED data pins. Returns how many were written (at most `cap`).
#[no_mangle]
pub unsafe extern "C" fn netout_busy_pins(out: *mut i32, cap: usize) -> usize {
    let e = &state().settings.eth;
    if !e.enabled || out.is_null() {
        return 0;
    }
    let mut n = 0;
    for p in e.pins() {
        if p >= 0 && n < cap {
            *out.add(n) = p;
            n += 1;
        }
    }
    n
}

/// Encode `ServerMessage{ethernet_state}` from the stored settings and `st`.
/// `error` (may be null) is a machine code. Returns the length, 0 if `cap` is short.
#[no_mangle]
pub unsafe extern "C" fn netout_encode_state(
    st: *const NetoutLinkStatus,
    error: *const c_char,
    out: *mut u8,
    cap: usize,
) -> usize {
    let st = if st.is_null() { NetoutLinkStatus::default() } else { *st };
    let ls = LinkStatus {
        link_up: st.link_up != 0,
        speed_mbps: st.speed_mbps,
        full_duplex: st.full_duplex != 0,
        ip: st.ip,
        netmask: st.netmask,
        gateway: st.gateway,
        mac: st.mac,
        tx_frames: st.tx_frames,
        tx_errors: st.tx_errors,
    };
    let s = &state().settings;
    wire::encode_ethernet_state(&s.eth, &s.outputs, &ls, cstr(error), bytes_mut(out, cap)).unwrap_or(0)
}

/// Encode `ServerMessage{controller_list}`. Returns the length, 0 if `cap` is short.
#[no_mangle]
pub unsafe extern "C" fn netout_encode_controllers(
    list: *const NetoutController,
    n: usize,
    error: *const c_char,
    out: *mut u8,
    cap: usize,
) -> usize {
    let list: &[NetoutController] = if list.is_null() || n == 0 { &[] } else { core::slice::from_raw_parts(list, n) };
    let mut cs: [Controller<'_>; 16] =
        [Controller { name: &[], ip: 0, mac: [0; 6], led_count: 0, version: &[], kind: b"wled" }; 16];
    let mut k = 0;
    for c in list.iter().take(16) {
        cs[k] = Controller {
            name: arr_str(&c.name),
            ip: c.ip,
            mac: c.mac,
            led_count: c.led_count,
            version: arr_str(&c.version),
            kind: b"wled",
        };
        k += 1;
    }
    wire::encode_controller_list(&cs[..k], cstr(error), bytes_mut(out, cap)).unwrap_or(0)
}

/// Bytes `netout_save` writes.
#[no_mangle]
pub extern "C" fn netout_blob_len() -> usize {
    BLOB_LEN
}

/// Serialise the settings for flash into `out` (cap >= netout_blob_len()).
/// Returns the length, 0 if `cap` is short.
#[no_mangle]
pub unsafe extern "C" fn netout_save(out: *mut u8, cap: usize) -> usize {
    if out.is_null() || cap < BLOB_LEN {
        return 0;
    }
    let mut b = [0u8; BLOB_LEN];
    state().settings.to_blob(&mut b);
    core::ptr::copy_nonoverlapping(b.as_ptr(), out, BLOB_LEN);
    BLOB_LEN
}

/// Load settings saved by `netout_save` at boot (does not bump the gen).
/// Returns 1 if loaded, 0 if the blob was unusable (the defaults stay).
#[no_mangle]
pub unsafe extern "C" fn netout_load(b: *const u8, len: usize) -> i32 {
    match NetSettings::from_blob(bytes(b, len)) {
        Some(s) => {
            state().settings = s;
            1
        }
        None => 0,
    }
}

/// Parse a WLED `/json/info` body into `out` (its `ip` is left as it was: the
/// caller knows whom it asked). Returns 1, or 0 if it isn't a WLED reply.
#[no_mangle]
pub unsafe extern "C" fn netout_parse_wled_info(json: *const u8, len: usize, out: *mut NetoutController) -> i32 {
    let Some(info) = crate::wled::parse_info(bytes(json, len)) else { return 0 };
    if out.is_null() {
        return 1;
    }
    let o = &mut *out;
    o.name = [0; 33];
    for (d, s) in o.name.iter_mut().zip(info.name()) {
        *d = *s as c_char;
    }
    o.version = [0; 17];
    for (d, s) in o.version.iter_mut().zip(info.version()) {
        *d = *s as c_char;
    }
    o.mac = info.mac;
    o.led_count = info.led_count;
    1
}

/// Packets one frame of `len` RGB bytes takes.
#[no_mangle]
pub extern "C" fn netout_ddp_packet_count(len: usize) -> usize {
    crate::ddp::packet_count(len)
}

/// Write DDP packet `index` of the frame `data[0..len)` with sequence `seq` into
/// `out`. Returns its length, 0 if `index` is past the frame or `cap` is short.
/// Pure: safe from any task.
#[no_mangle]
pub unsafe extern "C" fn netout_ddp_packet(
    data: *const u8,
    len: usize,
    index: usize,
    seq: u8,
    out: *mut u8,
    cap: usize,
) -> usize {
    crate::ddp::packet(bytes(data, len), index, seq, bytes_mut(out, cap)).unwrap_or(0)
}

/// The sequence number after `seq` (1..=15).
#[no_mangle]
pub extern "C" fn netout_ddp_next_seq(seq: u8) -> u8 {
    crate::ddp::next_seq(seq)
}

/// The first network LED channel and how many there are.
#[no_mangle]
pub extern "C" fn netout_first_channel() -> i32 {
    NET_CHANNEL_FIRST as i32
}

#[no_mangle]
pub extern "C" fn netout_channels() -> i32 {
    NET_CHANNELS as i32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn controller_strings_stop_at_nul() {
        let mut name = [0 as c_char; 33];
        for (i, b) in b"DISTIRA".iter().enumerate() {
            name[i] = *b as c_char;
        }
        assert_eq!(arr_str(&name), b"DISTIRA");
    }
}
