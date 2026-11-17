//! A minimal nl80211 client over a raw generic-netlink socket (no libnl): resolve the family,
//! register for action frames, transmit management frames, read TX status and RX frames, run
//! vendor commands (brcmfmac's DCMD), and read the capabilities that decide which transport
//! a radio can use (docs/design/mesh-pi-transport.md §2).

use std::io;
use std::os::fd::{AsRawFd, OwnedFd};

use crate::sys;

pub const CMD_GET_WIPHY: u8 = 1;
pub const CMD_GET_INTERFACE: u8 = 5;
pub const CMD_REGISTER_FRAME: u8 = 58;
pub const CMD_FRAME: u8 = 59;
pub const CMD_FRAME_TX_STATUS: u8 = 60;
pub const CMD_VENDOR: u8 = 103;
pub const CMD_REMAIN_ON_CHANNEL: u8 = 55;

pub const ATTR_WIPHY: u16 = 1;
pub const ATTR_WIPHY_NAME: u16 = 2;
pub const ATTR_IFINDEX: u16 = 3;
pub const ATTR_IFNAME: u16 = 4;
pub const ATTR_IFTYPE: u16 = 5;
pub const ATTR_MAC: u16 = 6;
pub const ATTR_SUPPORTED_IFTYPES: u16 = 32;
pub const ATTR_WIPHY_FREQ: u16 = 38;
pub const ATTR_SUPPORTED_COMMANDS: u16 = 50;
pub const ATTR_FRAME: u16 = 51;
pub const ATTR_DURATION: u16 = 87;
pub const ATTR_COOKIE: u16 = 88;
pub const ATTR_FRAME_MATCH: u16 = 91;
pub const ATTR_ACK: u16 = 92;
pub const ATTR_TX_FRAME_TYPES: u16 = 99;
pub const ATTR_RX_FRAME_TYPES: u16 = 100;
pub const ATTR_FRAME_TYPE: u16 = 101;
pub const ATTR_OFFCHANNEL_TX_OK: u16 = 108;
pub const ATTR_TX_NO_CCK_RATE: u16 = 135;
pub const ATTR_DONT_WAIT_FOR_ACK: u16 = 142;
pub const ATTR_FEATURE_FLAGS: u16 = 143;
pub const ATTR_RX_SIGNAL_DBM: u16 = 151;
pub const ATTR_SPLIT_WIPHY_DUMP: u16 = 174;
pub const ATTR_VENDOR_ID: u16 = 195;
pub const ATTR_VENDOR_SUBCMD: u16 = 196;
pub const ATTR_VENDOR_DATA: u16 = 197;
pub const ATTR_EXT_FEATURES: u16 = 217;

pub const IFTYPE_STATION: u16 = 2;
pub const IFTYPE_MONITOR: u16 = 6;
pub const EXT_FEATURE_MGMT_TX_RANDOM_TA: usize = 10;
/// Management frame type/subtype for Action, as nl80211 FRAME_TYPE wants it (FC, LE).
pub const FTYPE_ACTION: u16 = 0x00d0;

const GENL_ID_CTRL: u16 = 16;
const CTRL_CMD_GETFAMILY: u8 = 3;
const CTRL_ATTR_FAMILY_ID: u16 = 1;
const CTRL_ATTR_FAMILY_NAME: u16 = 2;
const CTRL_ATTR_MCAST_GROUPS: u16 = 7;
const CTRL_ATTR_MCAST_GRP_NAME: u16 = 1;
const CTRL_ATTR_MCAST_GRP_ID: u16 = 2;
const NLM_F_REQUEST: u16 = 1;
const NLM_F_MULTI: u16 = 2;
const NLM_F_ACK: u16 = 4;
const NLM_F_DUMP: u16 = 0x300;
const NLMSG_ERROR: u16 = 2;
const NLMSG_DONE: u16 = 3;
const NLA_F_NESTED: u16 = 0x8000;

/// Attribute builder for one genetlink message.
pub struct Msg {
    b: Vec<u8>,
    nests: Vec<usize>,
}

impl Msg {
    pub fn new(family: u16, flags: u16, cmd: u8) -> Msg {
        let mut b = vec![0u8; 20];
        b[4..6].copy_from_slice(&family.to_ne_bytes());
        b[6..8].copy_from_slice(&(flags | NLM_F_REQUEST).to_ne_bytes());
        b[16] = cmd;
        b[17] = 1; // genl version
        Msg { b, nests: Vec::new() }
    }
    pub fn attr(mut self, ty: u16, v: &[u8]) -> Msg {
        let len = 4 + v.len();
        self.b.extend_from_slice(&(len as u16).to_ne_bytes());
        self.b.extend_from_slice(&ty.to_ne_bytes());
        self.b.extend_from_slice(v);
        while self.b.len() % 4 != 0 {
            self.b.push(0);
        }
        self
    }
    pub fn u32(self, ty: u16, v: u32) -> Msg {
        self.attr(ty, &v.to_ne_bytes())
    }
    pub fn u16(self, ty: u16, v: u16) -> Msg {
        self.attr(ty, &v.to_ne_bytes())
    }
    pub fn flag(self, ty: u16) -> Msg {
        self.attr(ty, &[])
    }
    pub fn begin_nest(mut self, ty: u16) -> Msg {
        self.nests.push(self.b.len());
        self.b.extend_from_slice(&[0, 0]);
        self.b.extend_from_slice(&(ty | NLA_F_NESTED).to_ne_bytes());
        self
    }
    pub fn end_nest(mut self) -> Msg {
        let at = self.nests.pop().expect("nest");
        let len = (self.b.len() - at) as u16;
        self.b[at..at + 2].copy_from_slice(&len.to_ne_bytes());
        self
    }
    fn finish(mut self, seq: u32) -> Vec<u8> {
        let len = self.b.len() as u32;
        self.b[0..4].copy_from_slice(&len.to_ne_bytes());
        self.b[8..12].copy_from_slice(&seq.to_ne_bytes());
        self.b
    }
}

/// Iterate attributes in `b`: (type without flags, payload).
pub fn attrs(mut b: &[u8]) -> impl Iterator<Item = (u16, &[u8])> {
    std::iter::from_fn(move || {
        if b.len() < 4 {
            return None;
        }
        let len = u16::from_ne_bytes([b[0], b[1]]) as usize;
        let ty = u16::from_ne_bytes([b[2], b[3]]) & 0x3fff;
        if len < 4 || len > b.len() {
            return None;
        }
        let v = &b[4..len];
        b = &b[len.next_multiple_of(4).min(b.len())..];
        Some((ty, v))
    })
}

pub fn get<'a>(b: &'a [u8], ty: u16) -> Option<&'a [u8]> {
    attrs(b).find(|(t, _)| *t == ty).map(|(_, v)| v)
}

pub fn get_u32(b: &[u8], ty: u16) -> Option<u32> {
    get(b, ty).filter(|v| v.len() >= 4).map(|v| u32::from_ne_bytes([v[0], v[1], v[2], v[3]]))
}

pub fn get_u64(b: &[u8], ty: u16) -> Option<u64> {
    get(b, ty).filter(|v| v.len() >= 8).map(|v| u64::from_ne_bytes(v[..8].try_into().unwrap()))
}

/// One received genetlink message: its command and attribute bytes.
#[derive(Debug, Clone)]
pub struct Event {
    pub family: u16,
    pub cmd: u8,
    pub seq: u32,
    pub attrs: Vec<u8>,
}

/// A generic-netlink socket bound to nl80211.
pub struct Nl80211 {
    fd: OwnedFd,
    pub family: u16,
    seq: u32,
    /// Unsolicited messages seen while waiting for a reply (RX frames, TX status).
    pending: std::collections::VecDeque<Event>,
    buf: Vec<u8>,
}

impl Nl80211 {
    pub fn open() -> io::Result<Nl80211> {
        let fd = sys::sock(sys::AF_NETLINK, sys::SOCK_RAW, sys::NETLINK_GENERIC)?;
        let addr = sys::sockaddr_nl { nl_family: sys::AF_NETLINK as u16, nl_pad: 0, nl_pid: 0, nl_groups: 0 };
        sys::bind_raw(fd.as_raw_fd(), &addr)?;
        let _ = sys::setsockopt_int(fd.as_raw_fd(), sys::SOL_NETLINK, sys::NETLINK_EXT_ACK, 1);
        let _ = sys::setsockopt_int(fd.as_raw_fd(), sys::SOL_SOCKET, sys::SO_RCVBUF, 1 << 20);
        let mut s = Nl80211 { fd, family: GENL_ID_CTRL, seq: 1, pending: Default::default(), buf: vec![0; 1 << 16] };
        let reply =
            s.request(Msg::new(GENL_ID_CTRL, 0, CTRL_CMD_GETFAMILY).attr(CTRL_ATTR_FAMILY_NAME, b"nl80211\0"))?;
        let a = &reply.first().ok_or_else(|| io::Error::other("no nl80211 family"))?.attrs;
        s.family = get(a, CTRL_ATTR_FAMILY_ID)
            .map(|v| u16::from_ne_bytes([v[0], v[1]]))
            .ok_or_else(|| io::Error::other("no family id"))?;
        // Join "mlme" for TX status (cfg80211 multicasts it) and the frames we register for.
        if let Some(groups) = get(a, CTRL_ATTR_MCAST_GROUPS) {
            for (_, g) in attrs(groups) {
                let name = get(g, CTRL_ATTR_MCAST_GRP_NAME).unwrap_or(b"");
                if name.starts_with(b"mlme") {
                    if let Some(id) = get_u32(g, CTRL_ATTR_MCAST_GRP_ID) {
                        sys::setsockopt_int(s.fd.as_raw_fd(), sys::SOL_NETLINK, sys::NETLINK_ADD_MEMBERSHIP, id as i32)?;
                    }
                }
            }
        }
        Ok(s)
    }

    pub fn msg(&self, flags: u16, cmd: u8) -> Msg {
        Msg::new(self.family, flags, cmd)
    }

    /// Send a request with an ACK and collect replies until the ACK (or the end of a dump).
    pub fn request(&mut self, m: Msg) -> io::Result<Vec<Event>> {
        self.seq = self.seq.wrapping_add(1);
        let seq = self.seq;
        let dump = u16::from_ne_bytes([m.b[6], m.b[7]]) & NLM_F_DUMP == NLM_F_DUMP;
        let mut m = m;
        let f = u16::from_ne_bytes([m.b[6], m.b[7]]) | NLM_F_ACK;
        m.b[6..8].copy_from_slice(&f.to_ne_bytes());
        sys::send_raw(self.fd.as_raw_fd(), &m.finish(seq))?;
        let mut out = Vec::new();
        loop {
            let n = sys::recv_raw(self.fd.as_raw_fd(), &mut self.buf, true)?.unwrap_or(0);
            let mut b = &self.buf[..n];
            while b.len() >= 16 {
                let len = u32::from_ne_bytes(b[0..4].try_into().unwrap()) as usize;
                if len < 16 || len > b.len() {
                    break;
                }
                let ty = u16::from_ne_bytes([b[4], b[5]]);
                let flags = u16::from_ne_bytes([b[6], b[7]]);
                let mseq = u32::from_ne_bytes(b[8..12].try_into().unwrap());
                let body = &b[16..len];
                b = &b[len.next_multiple_of(4).min(b.len())..];
                if mseq != seq {
                    if ty >= 0x10 && body.len() >= 4 {
                        self.pending.push_back(Event { family: ty, cmd: body[0], seq: mseq, attrs: body[4..].to_vec() });
                    }
                    continue;
                }
                match ty {
                    NLMSG_ERROR => {
                        let err = i32::from_ne_bytes(body[0..4].try_into().unwrap());
                        return if err == 0 { Ok(out) } else { Err(io::Error::from_raw_os_error(-err)) };
                    }
                    NLMSG_DONE => return Ok(out),
                    _ => {
                        if body.len() >= 4 {
                            out.push(Event { family: ty, cmd: body[0], seq: mseq, attrs: body[4..].to_vec() });
                        }
                        let _ = (flags & NLM_F_MULTI, dump);
                    }
                }
            }
        }
    }

    /// Next unsolicited message (RX frame, TX status), without blocking.
    pub fn poll_event(&mut self) -> io::Result<Option<Event>> {
        if let Some(e) = self.pending.pop_front() {
            return Ok(Some(e));
        }
        loop {
            let Some(n) = sys::recv_raw(self.fd.as_raw_fd(), &mut self.buf, false)? else { return Ok(None) };
            let mut b = &self.buf[..n];
            while b.len() >= 16 {
                let len = u32::from_ne_bytes(b[0..4].try_into().unwrap()) as usize;
                if len < 16 || len > b.len() {
                    break;
                }
                let ty = u16::from_ne_bytes([b[4], b[5]]);
                let seq = u32::from_ne_bytes(b[8..12].try_into().unwrap());
                let body = &b[16..len];
                if ty == self.family && body.len() >= 4 {
                    self.pending.push_back(Event { family: ty, cmd: body[0], seq, attrs: body[4..].to_vec() });
                }
                b = &b[len.next_multiple_of(4).min(b.len())..];
            }
            if let Some(e) = self.pending.pop_front() {
                return Ok(Some(e));
            }
        }
    }

    /// Register this socket for Action frames whose body starts with `prefix`.
    pub fn register_action(&mut self, ifindex: u32, prefix: &[u8]) -> io::Result<()> {
        let m = self
            .msg(0, CMD_REGISTER_FRAME)
            .u32(ATTR_IFINDEX, ifindex)
            .u16(ATTR_FRAME_TYPE, FTYPE_ACTION)
            .attr(ATTR_FRAME_MATCH, prefix);
        self.request(m).map(|_| ())
    }

    /// NL80211_CMD_FRAME: transmit a whole management frame; returns the TX cookie.
    pub fn tx_frame(&mut self, ifindex: u32, freq: Option<u32>, frame: &[u8], no_ack: bool) -> io::Result<Option<u64>> {
        let mut m = self.msg(0, CMD_FRAME).u32(ATTR_IFINDEX, ifindex).attr(ATTR_FRAME, frame);
        if let Some(f) = freq {
            m = m.u32(ATTR_WIPHY_FREQ, f).flag(ATTR_OFFCHANNEL_TX_OK);
        }
        if no_ack {
            m = m.flag(ATTR_DONT_WAIT_FOR_ACK);
        }
        let r = self.request(m)?;
        Ok(r.iter().find_map(|e| get_u64(&e.attrs, ATTR_COOKIE)))
    }

    /// A vendor command (raw data in and out).
    pub fn vendor(&mut self, ifindex: u32, oui: u32, subcmd: u32, data: &[u8]) -> io::Result<Vec<Vec<u8>>> {
        let m = self
            .msg(0, CMD_VENDOR)
            .u32(ATTR_IFINDEX, ifindex)
            .u32(ATTR_VENDOR_ID, oui)
            .u32(ATTR_VENDOR_SUBCMD, subcmd)
            .attr(ATTR_VENDOR_DATA, data);
        Ok(self.request(m)?.into_iter().filter_map(|e| get(&e.attrs, ATTR_VENDOR_DATA).map(|v| v.to_vec())).collect())
    }

    /// (wiphy index, iftype, frequency MHz if known) of an interface.
    pub fn interface(&mut self, ifindex: u32) -> io::Result<(u32, u32, Option<u32>)> {
        let r = self.request(self.msg(0, CMD_GET_INTERFACE).u32(ATTR_IFINDEX, ifindex))?;
        let a = &r.first().ok_or_else(|| io::Error::other("no interface reply"))?.attrs;
        Ok((get_u32(a, ATTR_WIPHY).unwrap_or(0), get_u32(a, ATTR_IFTYPE).unwrap_or(0), get_u32(a, ATTR_WIPHY_FREQ)))
    }

    /// What decides the transport (docs/design/mesh-pi-transport.md §2): a split wiphy dump.
    pub fn caps(&mut self, wiphy: u32) -> io::Result<Caps> {
        let m = self.msg(NLM_F_DUMP, CMD_GET_WIPHY).u32(ATTR_WIPHY, wiphy).flag(ATTR_SPLIT_WIPHY_DUMP);
        let mut c = Caps::default();
        for e in self.request(m)? {
            if get_u32(&e.attrs, ATTR_WIPHY) != Some(wiphy) {
                continue;
            }
            for (t, v) in attrs(&e.attrs) {
                match t {
                    ATTR_WIPHY_NAME => c.name = String::from_utf8_lossy(v).trim_end_matches('\0').to_string(),
                    ATTR_SUPPORTED_IFTYPES => c.iftypes.extend(attrs(v).map(|(t, _)| t)),
                    ATTR_SUPPORTED_COMMANDS => c.commands.extend(attrs(v).filter_map(|(_, x)| x.first().copied())),
                    ATTR_TX_FRAME_TYPES | ATTR_RX_FRAME_TYPES => {
                        for (ift, types) in attrs(v) {
                            let action = attrs(types).any(|(_, s)| s.len() >= 2 && u16::from_ne_bytes([s[0], s[1]]) == FTYPE_ACTION);
                            if action {
                                if t == ATTR_TX_FRAME_TYPES { &mut c.action_tx } else { &mut c.action_rx }.push(ift);
                            }
                        }
                    }
                    ATTR_FEATURE_FLAGS => c.feature_flags = get_u32(&e.attrs, ATTR_FEATURE_FLAGS).unwrap_or(0),
                    ATTR_EXT_FEATURES => c.ext_features = v.to_vec(),
                    // nl80211_vendor_cmd_info {u32 vendor_id; u32 subcmd} per entry.
                    ATTR_VENDOR_DATA => c.vendor.extend(attrs(v).filter(|(_, x)| x.len() >= 8).map(|(_, x)| {
                        (u32::from_ne_bytes(x[0..4].try_into().unwrap()), u32::from_ne_bytes(x[4..8].try_into().unwrap()))
                    })),
                    _ => {}
                }
            }
        }
        Ok(c)
    }
}

#[derive(Clone, Debug, Default)]
pub struct Caps {
    pub name: String,
    pub iftypes: Vec<u16>,
    pub commands: Vec<u8>,
    pub action_tx: Vec<u16>,
    pub action_rx: Vec<u16>,
    pub feature_flags: u32,
    pub ext_features: Vec<u8>,
    /// (vendor OUI, subcommand) pairs the driver registers.
    pub vendor: Vec<(u32, u32)>,
}

impl Caps {
    pub fn monitor(&self) -> bool {
        self.iftypes.contains(&IFTYPE_MONITOR)
    }
    pub fn ext(&self, bit: usize) -> bool {
        self.ext_features.get(bit / 8).is_some_and(|b| b & (1 << (bit % 8)) != 0)
    }
}

/// A frame nl80211 delivered to a registration (NL80211_CMD_FRAME event).
#[derive(Clone, Debug)]
pub struct RxFrame {
    pub frame: Vec<u8>,
    pub freq: Option<u32>,
    pub rssi_dbm: Option<i32>,
}

impl Event {
    pub fn rx_frame(&self) -> Option<RxFrame> {
        if self.cmd != CMD_FRAME {
            return None;
        }
        Some(RxFrame {
            frame: get(&self.attrs, ATTR_FRAME)?.to_vec(),
            freq: get_u32(&self.attrs, ATTR_WIPHY_FREQ),
            rssi_dbm: get_u32(&self.attrs, ATTR_RX_SIGNAL_DBM).map(|v| v as i32),
        })
    }
    /// (cookie, acked) of a FRAME_TX_STATUS event.
    pub fn tx_status(&self) -> Option<(u64, bool)> {
        (self.cmd == CMD_FRAME_TX_STATUS)
            .then(|| (get_u64(&self.attrs, ATTR_COOKIE).unwrap_or(0), get(&self.attrs, ATTR_ACK).is_some()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_and_parses_attributes() {
        let m = Msg::new(0x1c, 0, CMD_REGISTER_FRAME)
            .u32(ATTR_IFINDEX, 3)
            .u16(ATTR_FRAME_TYPE, FTYPE_ACTION)
            .attr(ATTR_FRAME_MATCH, &[0x7f, 0x0a, 0x5c, 0x4d, 0x01])
            .begin_nest(9)
            .u32(1, 7)
            .end_nest();
        let b = m.finish(42);
        assert_eq!(u32::from_ne_bytes(b[0..4].try_into().unwrap()) as usize, b.len());
        assert_eq!(b.len() % 4, 0);
        assert_eq!(b[16], CMD_REGISTER_FRAME);
        let a = &b[20..];
        assert_eq!(get_u32(a, ATTR_IFINDEX), Some(3));
        assert_eq!(get(a, ATTR_FRAME_TYPE), Some(&FTYPE_ACTION.to_ne_bytes()[..]));
        assert_eq!(get(a, ATTR_FRAME_MATCH), Some(&[0x7f, 0x0a, 0x5c, 0x4d, 0x01][..]));
        assert_eq!(get_u32(get(a, 9).unwrap(), 1), Some(7));
    }
}
