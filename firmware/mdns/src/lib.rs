//! Minimal mDNS / DNS-SD responder for the heapless netstack player.
//!
//! no_std, zero-dependency, no allocation: a query is parsed in place and the
//! reply is written into a caller buffer. It answers exactly one service,
//! `<instance>._splanc._tcp.local` (SRV -> `<host>.local:<port>`, TXT with the
//! agent-discovery keys), the DNS-SD enumeration PTR, and the `<host>.local` A
//! record — what the agent bridge (and `avahi-browse` / python-zeroconf) needs to
//! find a device and fetch its `/.well-known/splanc.json`.
//!
//! Reply routing (RFC 6762 §5.4, §6.7): a query from a source port other than
//! 5353 is a legacy one-shot resolver and gets a UNICAST reply that echoes the id
//! and questions with TTL <= 10; a query whose matched questions all set the QU
//! bit gets a unicast reply; anything else is answered on the multicast group.
//! The transport decides whether it may send multicast right now (the netstack
//! never emits group-addressed frames during a live wss session).

#![no_std]

/// The mDNS port and IPv4 group.
pub const MDNS_PORT: u16 = 5353;
pub const MDNS_GROUP: [u8; 4] = [224, 0, 0, 251];

/// The DNS-SD service type the device registers.
pub const SERVICE: &str = "_splanc._tcp";

const T_A: u16 = 1;
const T_PTR: u16 = 12;
const T_TXT: u16 = 16;
const T_SRV: u16 = 33;
const T_ANY: u16 = 255;
const CLASS_IN: u16 = 1;
const CACHE_FLUSH: u16 = 0x8000;
/// TTLs (s): host-bound records 120, the rest 4500 (RFC 6762 §10).
const TTL_HOST: u32 = 120;
const TTL_OTHER: u32 = 4500;
/// Legacy unicast replies must not outlive 10 s (RFC 6762 §6.7).
const TTL_LEGACY: u32 = 10;

/// The one service this device advertises.
pub struct Service<'a> {
    /// Host label: the A record is `<host>.local` (e.g. `splanc-ddeeff`).
    pub host: &'a str,
    /// Service instance label (the device's display name); cut to 63 bytes.
    pub instance: &'a str,
    /// The TCP port the SRV points at (the wss/HTTPS server).
    pub port: u16,
    /// The device's IPv4 address (the A record).
    pub ip: [u8; 4],
    /// TXT key/value pairs, in order.
    pub txt: &'a [(&'a str, &'a str)],
}

/// Where a reply goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dest {
    /// To 224.0.0.251:5353.
    Multicast,
    /// Back to the querier's address and source port.
    Unicast,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reply {
    pub len: usize,
    pub dest: Dest,
}

// Record bits: what a reply carries.
const R_PTR: u8 = 1; // _splanc._tcp.local PTR <instance>
const R_ENUM: u8 = 2; // _services._dns-sd._udp.local PTR _splanc._tcp.local
const R_SRV: u8 = 4;
const R_TXT: u8 = 8;
const R_A: u8 = 16;

/// `splanc-` + the last three MAC bytes in lowercase hex, from a MAC string such
/// as `AA:BB:CC:DD:EE:FF` (any separators). Falls back to `splanc` when the string
/// has fewer than six hex digits.
pub fn host_label<'b>(mac: &str, buf: &'b mut [u8; 13]) -> &'b str {
    buf[..7].copy_from_slice(b"splanc-");
    let mut hex = [0u8; 12];
    let mut n = 0;
    for c in mac.bytes() {
        if c.is_ascii_hexdigit() && n < hex.len() {
            hex[n] = c.to_ascii_lowercase();
            n += 1;
        }
    }
    if n < 6 {
        return "splanc";
    }
    buf[7..].copy_from_slice(&hex[n - 6..n]);
    core::str::from_utf8(&buf[..]).unwrap_or("splanc")
}

/// Answer `query` (a DNS message received on port 5353 from `src_port`), or None
/// when it asks nothing this device owns (or is a response / malformed).
pub fn respond(query: &[u8], src_port: u16, svc: &Service, out: &mut [u8]) -> Option<Reply> {
    if query.len() < 12 {
        return None;
    }
    let flags = be16(query, 2)?;
    if flags & 0x8000 != 0 || (flags >> 11) & 0xf != 0 {
        return None; // a response, or not a standard query
    }
    let qd = be16(query, 4)?;
    let legacy = src_port != MDNS_PORT;

    let names = Names::new(svc);
    let mut answers = 0u8;
    let mut all_qu = true;
    let mut off = 12;
    for _ in 0..qd {
        let mut name = [0u8; 256];
        let (nlen, next) = read_name(query, off, &mut name)?;
        let qtype = be16(query, next)?;
        let qclass = be16(query, next + 2)?;
        off = next + 4;
        if qclass & 0x7fff != CLASS_IN && qclass & 0x7fff != T_ANY {
            continue;
        }
        let q = &name[..nlen];
        let any = qtype == T_ANY;
        let before = answers;
        if names.is_service(q) && (any || qtype == T_PTR) {
            answers |= R_PTR;
        }
        if names.is_enum(q) && (any || qtype == T_PTR) {
            answers |= R_ENUM;
        }
        if names.is_instance(q) {
            if any || qtype == T_SRV {
                answers |= R_SRV;
            }
            if any || qtype == T_TXT {
                answers |= R_TXT;
            }
        }
        if names.is_host(q) && (any || qtype == T_A) {
            answers |= R_A;
        }
        if answers != before && qclass & 0x8000 == 0 {
            all_qu = false;
        }
    }
    if answers == 0 {
        return None;
    }
    // Additional records (RFC 6763 §12): a PTR answer brings the SRV/TXT/A; an SRV
    // brings the A.
    let mut additional = 0u8;
    if answers & R_PTR != 0 {
        additional |= R_SRV | R_TXT | R_A;
    }
    if answers & R_SRV != 0 {
        additional |= R_A;
    }
    additional &= !answers;

    let mut w = Writer { out, n: 0, ok: true };
    let id = if legacy { be16(query, 0)? } else { 0 };
    w.u16(id);
    w.u16(0x8400); // response, authoritative
    if legacy {
        // Echo the question section verbatim (offsets match: it starts at 12 in both,
        // so any compression pointers inside it stay valid).
        w.u16(qd);
    } else {
        w.u16(0);
    }
    w.u16(answers.count_ones() as u16);
    w.u16(0);
    w.u16(additional.count_ones() as u16);
    if legacy {
        w.bytes(&query[12..off]);
    }
    let ttl = |t: u32| if legacy { t.min(TTL_LEGACY) } else { t };
    let flush = if legacy { 0 } else { CACHE_FLUSH };
    for set in [answers, additional] {
        write_records(&mut w, &names, svc, set, &ttl, flush);
    }
    if !w.ok {
        return None;
    }
    let dest = if legacy || all_qu { Dest::Unicast } else { Dest::Multicast };
    Some(Reply { len: w.n, dest })
}

/// An unsolicited announcement (RFC 6762 §8.3) of every record, for the multicast
/// group: sent when the device gets its address, so browsers see it without asking.
pub fn announce(svc: &Service, out: &mut [u8]) -> Option<usize> {
    let names = Names::new(svc);
    let mut w = Writer { out, n: 0, ok: true };
    let all = R_PTR | R_ENUM | R_SRV | R_TXT | R_A;
    w.u16(0);
    w.u16(0x8400);
    w.u16(0);
    w.u16(all.count_ones() as u16);
    w.u16(0);
    w.u16(0);
    write_records(&mut w, &names, svc, all, &|t| t, CACHE_FLUSH);
    w.ok.then_some(w.n)
}

/// An IGMPv2 Membership Report for 224.0.0.251 (RFC 2236): the 8-byte IGMP
/// message. The transport wraps it in IPv4 (proto 2, TTL 1, dst = the group,
/// Router Alert option) — so a snooping AP forwards the mDNS group to us.
pub fn igmp_v2_report() -> [u8; 8] {
    let mut m = [0x16, 0, 0, 0, 224, 0, 0, 251];
    let c = inet_checksum(&m);
    m[2] = (c >> 8) as u8;
    m[3] = c as u8;
    m
}

/// The internet checksum (RFC 1071) of `d`.
pub fn inet_checksum(d: &[u8]) -> u16 {
    let mut s: u32 = 0;
    let mut i = 0;
    while i + 1 < d.len() {
        s += u32::from(u16::from_be_bytes([d[i], d[i + 1]]));
        i += 2;
    }
    if i < d.len() {
        s += u32::from(d[i]) << 8;
    }
    while s >> 16 != 0 {
        s = (s & 0xffff) + (s >> 16);
    }
    !(s as u16)
}

fn write_records(
    w: &mut Writer,
    names: &Names,
    svc: &Service,
    set: u8,
    ttl: &dyn Fn(u32) -> u32,
    flush: u16,
) {
    if set & R_PTR != 0 {
        w.raw_name(names.service());
        w.rr_head(T_PTR, CLASS_IN, ttl(TTL_OTHER));
        let inst = names.instance();
        w.u16(inst.len() as u16);
        w.raw_name(inst);
    }
    if set & R_ENUM != 0 {
        w.raw_name(names.enumeration());
        w.rr_head(T_PTR, CLASS_IN, ttl(TTL_OTHER));
        let s = names.service();
        w.u16(s.len() as u16);
        w.raw_name(s);
    }
    if set & R_SRV != 0 {
        w.raw_name(names.instance());
        w.rr_head(T_SRV, CLASS_IN | flush, ttl(TTL_HOST));
        let host = names.host();
        w.u16((6 + host.len()) as u16);
        w.u16(0); // priority
        w.u16(0); // weight
        w.u16(svc.port);
        w.raw_name(host);
    }
    if set & R_TXT != 0 {
        w.raw_name(names.instance());
        w.rr_head(T_TXT, CLASS_IN | flush, ttl(TTL_OTHER));
        let len: usize = svc.txt.iter().map(|(k, v)| 1 + txt_len(k, v)).sum();
        w.u16(len as u16);
        for (k, v) in svc.txt {
            let n = txt_len(k, v);
            w.byte(n as u8);
            let kv = [k.as_bytes(), b"=", v.as_bytes()];
            let mut left = n;
            for part in kv {
                let take = part.len().min(left);
                w.bytes(&part[..take]);
                left -= take;
            }
        }
    }
    if set & R_A != 0 {
        w.raw_name(names.host());
        w.rr_head(T_A, CLASS_IN | flush, ttl(TTL_HOST));
        w.u16(4);
        w.bytes(&svc.ip);
    }
}

/// A TXT string's length: `key=value`, capped at 255.
fn txt_len(k: &str, v: &str) -> usize {
    (k.len() + 1 + v.len()).min(255)
}

/// The device's names, wire-encoded (length-prefixed labels, 0-terminated).
struct Names {
    service: Name,
    enumeration: Name,
    instance: Name,
    host: Name,
}

impl Names {
    fn new(svc: &Service) -> Self {
        let mut n = Names {
            service: Name::new(),
            enumeration: Name::new(),
            instance: Name::new(),
            host: Name::new(),
        };
        for l in ["_splanc", "_tcp", "local"] {
            n.service.label(l);
        }
        for l in ["_services", "_dns-sd", "_udp", "local"] {
            n.enumeration.label(l);
        }
        n.instance.label(svc.instance);
        for l in ["_splanc", "_tcp", "local"] {
            n.instance.label(l);
        }
        n.host.label(svc.host);
        n.host.label("local");
        n
    }
    fn service(&self) -> &[u8] {
        self.service.wire()
    }
    fn enumeration(&self) -> &[u8] {
        self.enumeration.wire()
    }
    fn instance(&self) -> &[u8] {
        self.instance.wire()
    }
    fn host(&self) -> &[u8] {
        self.host.wire()
    }
    fn is_service(&self, q: &[u8]) -> bool {
        q.eq_ignore_ascii_case(self.service())
    }
    fn is_enum(&self, q: &[u8]) -> bool {
        q.eq_ignore_ascii_case(self.enumeration())
    }
    fn is_instance(&self, q: &[u8]) -> bool {
        q.eq_ignore_ascii_case(self.instance())
    }
    fn is_host(&self, q: &[u8]) -> bool {
        q.eq_ignore_ascii_case(self.host())
    }
}

/// A wire-format name in a fixed buffer. (Label length bytes are <= 63, below
/// 'A', so a whole-name ASCII case-fold compare is a correct DNS name compare.)
struct Name {
    b: [u8; 128],
    n: usize,
}

impl Name {
    fn new() -> Self {
        Name { b: [0; 128], n: 0 }
    }
    /// Append a label (cut to 63 bytes at a UTF-8 boundary; empty -> "splanc").
    fn label(&mut self, l: &str) {
        let l = if l.is_empty() { "splanc" } else { l };
        let mut end = l.len().min(63).min(self.b.len() - self.n - 2);
        while !l.is_char_boundary(end) {
            end -= 1;
        }
        self.b[self.n] = end as u8;
        self.b[self.n + 1..self.n + 1 + end].copy_from_slice(&l.as_bytes()[..end]);
        self.n += 1 + end;
    }
    fn wire(&self) -> &[u8] {
        // The terminating root label: b[n] is always 0 (labels never fill the buffer).
        &self.b[..self.n + 1]
    }
}

/// Decompress the name at `off` into `buf` (wire form, 0-terminated); returns its
/// length and the offset just past the name in `msg`.
fn read_name(msg: &[u8], mut off: usize, buf: &mut [u8; 256]) -> Option<(usize, usize)> {
    let mut n = 0;
    let mut next = None;
    let mut jumps = 0;
    loop {
        let len = *msg.get(off)? as usize;
        if len & 0xc0 == 0xc0 {
            let ptr = ((len & 0x3f) << 8) | *msg.get(off + 1)? as usize;
            next.get_or_insert(off + 2);
            jumps += 1;
            if jumps > 16 || ptr >= msg.len() {
                return None;
            }
            off = ptr;
            continue;
        }
        if len & 0xc0 != 0 {
            return None;
        }
        if n + 1 + len > buf.len() {
            return None;
        }
        buf[n] = len as u8;
        if len == 0 {
            return Some((n + 1, next.unwrap_or(off + 1)));
        }
        buf[n + 1..n + 1 + len].copy_from_slice(msg.get(off + 1..off + 1 + len)?);
        n += 1 + len;
        off += 1 + len;
    }
}

fn be16(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(at)?, *b.get(at + 1)?]))
}

struct Writer<'a> {
    out: &'a mut [u8],
    n: usize,
    ok: bool,
}

impl Writer<'_> {
    fn byte(&mut self, b: u8) {
        match self.out.get_mut(self.n) {
            Some(s) => {
                *s = b;
                self.n += 1;
            }
            None => self.ok = false,
        }
    }
    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.byte(x);
        }
    }
    fn u16(&mut self, v: u16) {
        self.bytes(&v.to_be_bytes());
    }
    fn raw_name(&mut self, wire: &[u8]) {
        self.bytes(wire);
    }
    fn rr_head(&mut self, rtype: u16, class: u16, ttl: u32) {
        self.u16(rtype);
        self.u16(class);
        self.bytes(&ttl.to_be_bytes());
    }
}
