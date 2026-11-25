//! A minimal DNS stub resolver codec: one IN A question out, its A records
//! back (RFC 1035). Enough to turn `pool.ntp.org` into addresses through the
//! DHCP-offered resolver; no caching, no TCP fallback, no EDNS.

use crate::Ip;

/// The DNS server port.
pub const PORT: u16 = 53;
/// Longest name we resolve (the stored server names are ≤ 64 bytes).
pub const NAME_MAX: usize = 64;
/// The largest query [`build_query`] writes: header + name + type/class.
pub const QUERY_MAX: usize = 12 + NAME_MAX + 2 + 4;

const TYPE_A: u16 = 1;
const CLASS_IN: u16 = 1;

/// Why a response was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DnsError {
    /// Truncated or malformed.
    Malformed,
    /// Not the response to our query (id, QR, opcode or the question differ).
    NotOurs,
    /// The server answered with this RCODE (3 = no such name, 2 = server
    /// failure, …).
    Rcode(u8),
    /// A good answer without any A record.
    NoAddress,
}

/// Whether `name` is a host name we can put in a query: 1..=64 bytes of
/// dot-separated labels of 1..=63 letters, digits, `-` or `_`.
pub fn valid_name(name: &[u8]) -> bool {
    if name.is_empty() || name.len() > NAME_MAX {
        return false;
    }
    let name = name.strip_suffix(b".").unwrap_or(name);
    !name.is_empty()
        && name.split(|&c| c == b'.').all(|l| {
            !l.is_empty()
                && l.len() <= 63
                && l.iter()
                    .all(|&c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
}

/// A dotted-quad literal (`"192.168.1.1"`) as an address.
pub fn parse_ipv4(s: &[u8]) -> Option<Ip> {
    let mut ip = [0u8; 4];
    let mut parts = s.split(|&c| c == b'.');
    for o in ip.iter_mut() {
        let p = parts.next()?;
        if p.is_empty() || p.len() > 3 || !p.iter().all(u8::is_ascii_digit) {
            return None;
        }
        let v = p.iter().fold(0u32, |a, &c| a * 10 + (c - b'0') as u32);
        if v > 255 {
            return None;
        }
        *o = v as u8;
    }
    if parts.next().is_some() {
        return None;
    }
    Some(ip)
}

/// Writes a recursive IN A query for `name` with transaction `id`. Returns its
/// length, or 0 when the name is invalid or `out` too small.
pub fn build_query(out: &mut [u8], id: u16, name: &[u8]) -> usize {
    if !valid_name(name) || out.len() < QUERY_MAX {
        return 0;
    }
    let name = name.strip_suffix(b".").unwrap_or(name);
    out[..12].copy_from_slice(&[
        (id >> 8) as u8,
        id as u8,
        0x01, // RD
        0x00,
        0,
        1, // QDCOUNT
        0,
        0,
        0,
        0,
        0,
        0,
    ]);
    let mut n = 12;
    for l in name.split(|&c| c == b'.') {
        out[n] = l.len() as u8;
        out[n + 1..n + 1 + l.len()].copy_from_slice(l);
        n += 1 + l.len();
    }
    out[n] = 0;
    n += 1;
    out[n..n + 4].copy_from_slice(&[0, TYPE_A as u8, 0, CLASS_IN as u8]);
    n + 4
}

fn be16(b: &[u8], i: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*b.get(i)?, *b.get(i + 1)?]))
}

/// Skips the (possibly compressed) name at `i`; returns the index after it.
fn skip_name(b: &[u8], mut i: usize) -> Option<usize> {
    loop {
        let l = *b.get(i)?;
        match l & 0xc0 {
            0x00 if l == 0 => return Some(i + 1),
            0x00 => i += 1 + l as usize,
            0xc0 => {
                b.get(i + 1)?;
                return Some(i + 2);
            }
            _ => return None,
        }
        if i > b.len() {
            return None;
        }
    }
}

/// Whether the uncompressed question name at `i` is `name` (ASCII
/// case-insensitive, RFC 4343). Returns the index after it.
fn match_name(b: &[u8], mut i: usize, name: &[u8]) -> Option<usize> {
    let name = name.strip_suffix(b".").unwrap_or(name);
    for l in name.split(|&c| c == b'.') {
        if *b.get(i)? as usize != l.len() {
            return None;
        }
        let got = b.get(i + 1..i + 1 + l.len())?;
        if !got.eq_ignore_ascii_case(l) {
            return None;
        }
        i += 1 + l.len();
    }
    (*b.get(i)? == 0).then_some(i + 1)
}

/// Parses the response to our query (`id`, `name`): up to `out.len()` distinct
/// A addresses in answer order. Returns `(count, min_ttl_s)`.
pub fn parse_response(
    b: &[u8],
    id: u16,
    name: &[u8],
    out: &mut [Ip],
) -> Result<(usize, u32), DnsError> {
    if b.len() < 12 {
        return Err(DnsError::Malformed);
    }
    let flags = be16(b, 2).ok_or(DnsError::Malformed)?;
    if be16(b, 0) != Some(id) || flags & 0x8000 == 0 || (flags >> 11) & 0xf != 0 {
        return Err(DnsError::NotOurs);
    }
    let qd = be16(b, 4).ok_or(DnsError::Malformed)?;
    let an = be16(b, 6).ok_or(DnsError::Malformed)?;
    if qd != 1 {
        return Err(DnsError::NotOurs);
    }
    let mut i = match_name(b, 12, name).ok_or(DnsError::NotOurs)?;
    if be16(b, i) != Some(TYPE_A) || be16(b, i + 2) != Some(CLASS_IN) {
        return Err(DnsError::NotOurs);
    }
    i += 4;
    let rcode = (flags & 0xf) as u8;
    if rcode != 0 {
        return Err(DnsError::Rcode(rcode));
    }
    let mut count = 0;
    let mut ttl_min = u32::MAX;
    for _ in 0..an {
        i = skip_name(b, i).ok_or(DnsError::Malformed)?;
        let ty = be16(b, i).ok_or(DnsError::Malformed)?;
        let class = be16(b, i + 2).ok_or(DnsError::Malformed)?;
        let ttl = u32::from_be_bytes(
            b.get(i + 4..i + 8)
                .ok_or(DnsError::Malformed)?
                .try_into()
                .map_err(|_| DnsError::Malformed)?,
        );
        let rdlen = be16(b, i + 8).ok_or(DnsError::Malformed)? as usize;
        let rd = b.get(i + 10..i + 10 + rdlen).ok_or(DnsError::Malformed)?;
        i += 10 + rdlen;
        if ty == TYPE_A && class == CLASS_IN && rdlen == 4 {
            let ip: Ip = [rd[0], rd[1], rd[2], rd[3]];
            if ip == [0; 4] || out[..count].contains(&ip) {
                continue;
            }
            if count < out.len() {
                out[count] = ip;
                count += 1;
                ttl_min = ttl_min.min(ttl);
            }
        }
    }
    if count == 0 {
        return Err(DnsError::NoAddress);
    }
    Ok((count, ttl_min))
}
