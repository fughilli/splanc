//! The Ethernet arms of the player protocol (shared/protocol/proto/ledmapper.proto,
//! "Ethernet + network LED outputs"), hand-coded so the P4 answers them
//! without the core's by-value envelopes growing. tests/wire.rs checks every
//! number here against the generated host bindings.

use crate::config::{Clock, EthConfig, IpMode, NetOutput, Phy, NAME_MAX};
use crate::pb::{Malformed, Overflow, Reader, Value, Writer};

/// `ClientMessage.msg` field numbers.
pub const CM_SET_ETHERNET_CONFIG: u32 = 95;
pub const CM_GET_ETHERNET_STATE: u32 = 96;
pub const CM_DISCOVER_CONTROLLERS: u32 = 97;
pub const CM_SET_NETWORK_OUTPUT: u32 = 98;

/// `ServerMessage.msg` field numbers.
pub const SM_ETHERNET_STATE: u32 = 53;
pub const SM_CONTROLLER_LIST: u32 = 54;

/// `EthernetConfig` field numbers.
mod ec {
    pub const ENABLED: u32 = 1;
    pub const PHY: u32 = 2;
    pub const PHY_ADDR: u32 = 3;
    pub const MDC: u32 = 4;
    pub const MDIO: u32 = 5;
    pub const RESET: u32 = 6;
    pub const CLOCK: u32 = 7;
    pub const CLOCK_GPIO: u32 = 8;
    pub const IP_MODE: u32 = 9;
    pub const IP: u32 = 10;
    pub const NETMASK: u32 = 11;
    pub const GATEWAY: u32 = 12;
}

/// `NetworkOutput` field numbers.
mod no {
    pub const CHANNEL: u32 = 1;
    pub const PROTOCOL: u32 = 2;
    pub const IP: u32 = 3;
    pub const PORT: u32 = 4;
    pub const NAME: u32 = 5;
}

/// `EthernetState` field numbers.
mod es {
    pub const CONFIG: u32 = 1;
    pub const OUTPUTS: u32 = 2;
    pub const LINK_UP: u32 = 3;
    pub const SPEED: u32 = 4;
    pub const FULL_DUPLEX: u32 = 5;
    pub const IP: u32 = 6;
    pub const NETMASK: u32 = 7;
    pub const GATEWAY: u32 = 8;
    pub const MAC: u32 = 9;
    pub const ERROR: u32 = 10;
    pub const TX_FRAMES: u32 = 11;
    pub const TX_ERRORS: u32 = 12;
}

/// `DiscoveredController` field numbers.
mod dc {
    pub const NAME: u32 = 1;
    pub const IP: u32 = 2;
    pub const MAC: u32 = 3;
    pub const LED_COUNT: u32 = 4;
    pub const VERSION: u32 = 5;
    pub const KIND: u32 = 6;
}

/// Discovery waits this long when the request leaves `timeout_ms` 0...
pub const DISCOVER_DEFAULT_MS: u32 = 600;
/// ...and never longer: a C6 front end waits 1000 ms for the P4's reply.
pub const DISCOVER_MAX_MS: u32 = 800;

/// A decoded request. `Refused` is an Ethernet arm whose fields don't parse
/// into a config (an unknown PHY, an out-of-range number): it is still ours,
/// and answered with the current state and the error.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Request {
    SetEthernetConfig { config: EthConfig, commit: bool },
    GetEthernetState,
    DiscoverControllers { timeout_ms: u32 },
    SetNetworkOutput { channel: i32, output: NetOutput, commit: bool },
    Refused(&'static str),
    /// Some other arm (its field number), or none: not ours.
    Other(u32),
}

fn i8_of(v: Value<'_>) -> Result<i8, &'static str> {
    let x = v.as_i32().ok_or("bad_message")?;
    i8::try_from(x).map_err(|_| "bad_pin")
}

/// Decode an `EthernetConfig`. Unset fields are proto3 zeros, so a client must
/// send the whole config (the app always does: it edits the echoed one).
pub fn decode_config(b: &[u8]) -> Result<EthConfig, &'static str> {
    let mut c = EthConfig {
        enabled: false,
        phy: Phy::Ip101,
        phy_addr: 0,
        mdc: 0,
        mdio: 0,
        reset: 0,
        clock: Clock::ExtIn,
        clock_gpio: 0,
        ip_mode: IpMode::DhcpClient,
        ip: 0,
        netmask: 0,
        gateway: 0,
    };
    let mut phy_seen = false;
    let mut r = Reader::new(b);
    while let Some((n, v)) = r.field().map_err(|_| "bad_message")? {
        match (n, v) {
            (ec::ENABLED, Value::Varint(x)) => c.enabled = x != 0,
            (ec::PHY, Value::Bytes(s)) => {
                c.phy = Phy::from_id(s).ok_or("bad_phy")?;
                phy_seen = true;
            }
            (ec::PHY_ADDR, v) => c.phy_addr = i8_of(v).map_err(|_| "bad_phy")?,
            (ec::MDC, v) => c.mdc = i8_of(v)?,
            (ec::MDIO, v) => c.mdio = i8_of(v)?,
            (ec::RESET, v) => c.reset = i8_of(v)?,
            (ec::CLOCK, Value::Varint(x)) => {
                c.clock = match x {
                    0 => Clock::ExtIn,
                    1 => Clock::Out,
                    _ => return Err("bad_message"),
                }
            }
            (ec::CLOCK_GPIO, v) => c.clock_gpio = i8_of(v)?,
            (ec::IP_MODE, Value::Varint(x)) => {
                c.ip_mode = match x {
                    0 => IpMode::DhcpClient,
                    1 => IpMode::Static,
                    2 => IpMode::DhcpServer,
                    _ => return Err("bad_message"),
                }
            }
            (ec::IP, Value::Fixed32(x)) => c.ip = x,
            (ec::NETMASK, Value::Fixed32(x)) => c.netmask = x,
            (ec::GATEWAY, Value::Fixed32(x)) => c.gateway = x,
            _ => {}
        }
    }
    if !phy_seen {
        return Err("bad_phy");
    }
    Ok(c)
}

fn decode_output(b: &[u8]) -> Result<(i32, NetOutput), &'static str> {
    let mut channel = 0;
    let mut o = NetOutput::default();
    let mut r = Reader::new(b);
    while let Some((n, v)) = r.field().map_err(|_| "bad_message")? {
        match (n, v) {
            (no::CHANNEL, v) => channel = v.as_i32().ok_or("bad_message")?,
            // DDP is the only protocol (0); anything else is refused.
            (no::PROTOCOL, Value::Varint(x)) if x != 0 => return Err("bad_message"),
            (no::IP, Value::Fixed32(x)) => o.ip = x,
            (no::PORT, Value::Varint(x)) => o.port = u16::try_from(x).map_err(|_| "bad_address")?,
            (no::NAME, Value::Bytes(s)) => o.set_name(s),
            _ => {}
        }
    }
    Ok((channel, o))
}

/// Read `commit` (field 2 of SetEthernetConfig / SetNetworkOutput): unset = true.
fn commit_of(v: Value<'_>) -> bool {
    !matches!(v, Value::Varint(0))
}

/// Decode a `ClientMessage` frame. A malformed frame is `Err`: the caller lets
/// the player core answer it (with its own decode error).
pub fn decode_client(frame: &[u8]) -> Result<Request, Malformed> {
    let mut r = Reader::new(frame);
    let mut req = Request::Other(0);
    while let Some((num, v)) = r.field()? {
        let body = match v {
            Value::Bytes(b) => b,
            _ => {
                req = Request::Other(num);
                continue;
            }
        };
        req = match num {
            CM_SET_ETHERNET_CONFIG => {
                let mut cfg: Option<Result<EthConfig, &'static str>> = None;
                let mut commit = true;
                let mut s = Reader::new(body);
                while let Some((n, v)) = s.field()? {
                    match (n, v) {
                        (1, Value::Bytes(c)) => cfg = Some(decode_config(c)),
                        (2, v) => commit = commit_of(v),
                        _ => {}
                    }
                }
                match cfg.unwrap_or(Err("bad_message")) {
                    Ok(config) => Request::SetEthernetConfig { config, commit },
                    Err(e) => Request::Refused(e),
                }
            }
            CM_GET_ETHERNET_STATE => Request::GetEthernetState,
            CM_DISCOVER_CONTROLLERS => {
                let mut t = 0u32;
                let mut s = Reader::new(body);
                while let Some((n, v)) = s.field()? {
                    if let (1, Value::Varint(x)) = (n, v) {
                        t = u32::try_from(x).unwrap_or(u32::MAX);
                    }
                }
                let t = if t == 0 { DISCOVER_DEFAULT_MS } else { t.min(DISCOVER_MAX_MS) };
                Request::DiscoverControllers { timeout_ms: t }
            }
            CM_SET_NETWORK_OUTPUT => {
                let mut out: Option<Result<(i32, NetOutput), &'static str>> = None;
                let mut commit = true;
                let mut s = Reader::new(body);
                while let Some((n, v)) = s.field()? {
                    match (n, v) {
                        (1, Value::Bytes(c)) => out = Some(decode_output(c)),
                        (2, v) => commit = commit_of(v),
                        _ => {}
                    }
                }
                match out.unwrap_or(Err("bad_message")) {
                    Ok((channel, output)) => Request::SetNetworkOutput { channel, output, commit },
                    Err(e) => Request::Refused(e),
                }
            }
            n => Request::Other(n),
        };
    }
    Ok(req)
}

/// The running state the firmware reports alongside the config.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LinkStatus {
    pub link_up: bool,
    pub speed_mbps: u32,
    pub full_duplex: bool,
    pub ip: u32,
    pub netmask: u32,
    pub gateway: u32,
    /// All zero = unknown (not reported).
    pub mac: [u8; 6],
    pub tx_frames: u32,
    pub tx_errors: u32,
}

fn write_config(w: &mut Writer<'_>, c: &EthConfig) -> Result<(), Overflow> {
    w.uint(ec::ENABLED, c.enabled as u64)?;
    w.bytes(ec::PHY, c.phy.id().as_bytes())?;
    w.int32(ec::PHY_ADDR, c.phy_addr as i32)?;
    w.int32(ec::MDC, c.mdc as i32)?;
    w.int32(ec::MDIO, c.mdio as i32)?;
    w.int32(ec::RESET, c.reset as i32)?;
    w.uint(ec::CLOCK, c.clock as u64)?;
    w.int32(ec::CLOCK_GPIO, c.clock_gpio as i32)?;
    w.uint(ec::IP_MODE, c.ip_mode as u64)?;
    w.fixed32(ec::IP, c.ip)?;
    w.fixed32(ec::NETMASK, c.netmask)?;
    w.fixed32(ec::GATEWAY, c.gateway)
}

/// Encode a `ServerMessage{ethernet_state}` into `out`; returns its length.
/// `outputs[i]` is LED channel 2 + i; only active ones are listed.
pub fn encode_ethernet_state(
    config: &EthConfig,
    outputs: &[NetOutput],
    st: &LinkStatus,
    error: &str,
    out: &mut [u8],
) -> Result<usize, Overflow> {
    let mut w = Writer::new(out);
    w.message(SM_ETHERNET_STATE, |w| {
        w.message(es::CONFIG, |w| write_config(w, config))?;
        for (i, o) in outputs.iter().enumerate() {
            if !o.active() {
                continue;
            }
            w.message(es::OUTPUTS, |w| {
                w.int32(no::CHANNEL, crate::config::NET_CHANNEL_FIRST as i32 + i as i32)?;
                w.fixed32(no::IP, o.ip)?;
                w.uint(no::PORT, o.port as u64)?;
                w.bytes(no::NAME, o.name())
            })?;
        }
        w.uint(es::LINK_UP, st.link_up as u64)?;
        w.uint(es::SPEED, st.speed_mbps as u64)?;
        w.uint(es::FULL_DUPLEX, st.full_duplex as u64)?;
        w.fixed32(es::IP, st.ip)?;
        w.fixed32(es::NETMASK, st.netmask)?;
        w.fixed32(es::GATEWAY, st.gateway)?;
        if st.mac != [0; 6] {
            w.bytes(es::MAC, &st.mac)?;
        }
        w.bytes(es::ERROR, error.as_bytes())?;
        w.uint(es::TX_FRAMES, st.tx_frames as u64)?;
        w.uint(es::TX_ERRORS, st.tx_errors as u64)
    })?;
    Ok(w.pos)
}

/// One controller discovery found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Controller<'a> {
    pub name: &'a [u8],
    pub ip: u32,
    /// All zero = unknown.
    pub mac: [u8; 6],
    pub led_count: u32,
    pub version: &'a [u8],
    pub kind: &'a [u8],
}

fn cut(s: &[u8], n: usize) -> &[u8] {
    &s[..s.len().min(n)]
}

/// Encode a `ServerMessage{controller_list}` into `out`; returns its length.
/// Strings are cut to the host bindings' capacities (name 32, version 16,
/// kind 8) so any client decodes the reply.
pub fn encode_controller_list(list: &[Controller<'_>], error: &str, out: &mut [u8]) -> Result<usize, Overflow> {
    let mut w = Writer::new(out);
    w.message(SM_CONTROLLER_LIST, |w| {
        for c in list.iter().take(16) {
            w.message(1, |w| {
                w.bytes(dc::NAME, cut(c.name, NAME_MAX))?;
                w.fixed32(dc::IP, c.ip)?;
                if c.mac != [0; 6] {
                    w.bytes(dc::MAC, &c.mac)?;
                }
                w.uint(dc::LED_COUNT, c.led_count as u64)?;
                w.bytes(dc::VERSION, cut(c.version, 16))?;
                w.bytes(dc::KIND, cut(c.kind, 8))
            })?;
        }
        w.bytes(2, error.as_bytes())
    })?;
    Ok(w.pos)
}
