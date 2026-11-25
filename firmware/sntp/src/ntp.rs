//! SNTP v4 (RFC 4330 / RFC 5905 on-wire) for a client on a monotonic clock.
//!
//! The request carries no clock reading: its transmit timestamp is a random
//! 64-bit cookie (as chrony does), so the device leaks nothing and a reply
//! must echo the cookie in its origin field to be ours. The four timestamps of
//! the exchange are then
//!
//! ```text
//! T1 = mono µs when the request left      T2 = server UTC when it arrived
//! T4 = mono µs when the reply arrived     T3 = server UTC when it left
//! offset θ = ((T2 − T1) + (T3 − T4)) / 2  (UTC = mono + θ)
//! delay  δ = (T4 − T1) − (T3 − T2)
//! ```
//!
//! and the time is "UTC = T4 + θ at mono T4, ± δ/2 + the server's root delay/2
//! + root dispersion".

/// The NTP packet without extensions or a MAC, bytes.
pub const PACKET_LEN: usize = 48;
/// The NTP server port.
pub const PORT: u16 = 123;

/// Seconds from the NTP epoch (1900-01-01) to the Unix epoch.
pub const NTP_UNIX_OFFSET_S: i64 = 2_208_988_800;
/// NTP-era pivot: era-0 seconds below this (before 2026-01-01) are read as era
/// 1 (from 2036-02-07), so the codec is right until 2162.
pub const ERA_PIVOT_S: u32 = 3_976_214_400;

/// A reply's server state.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reply {
    /// Leap indicator (0 none, 1 +1 s, 2 −1 s; 3 = unsynchronised is refused).
    pub leap: u8,
    /// 1 (a reference clock) .. 15.
    pub stratum: u8,
    /// The server's round-trip delay to its reference, µs.
    pub root_delay_us: i64,
    /// The server's dispersion to its reference, µs.
    pub root_dispersion_us: i64,
    /// T2: UTC µs when the server received the request.
    pub receive_unix_us: i64,
    /// T3: UTC µs when the server sent the reply.
    pub transmit_unix_us: i64,
}

/// Why a reply was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReplyError {
    /// Shorter than 48 bytes.
    Truncated,
    /// Not a server reply (mode ≠ 4) or an unknown version.
    NotAReply,
    /// The origin timestamp isn't our cookie (stale, duplicated or spoofed).
    WrongOrigin,
    /// Kiss-o'-death (stratum 0) with this ASCII code: `RATE`, `DENY`, `RSTR`, …
    KissOfDeath([u8; 4]),
    /// Leap indicator 3 (the server's clock is not synchronised) or stratum
    /// 16 and up.
    Unsynchronised,
    /// A zero transmit timestamp, or T3 before T2.
    BadTimestamps,
}

/// NTP 64-bit timestamp → Unix µs (era-pivoted, see [`ERA_PIVOT_S`]).
pub fn ntp_to_unix_us(secs: u32, frac: u32) -> i64 {
    let mut s = secs as i64;
    if secs < ERA_PIVOT_S {
        s += 1 << 32;
    }
    let us = ((frac as u64 * 1_000_000) >> 32) as i64;
    (s - NTP_UNIX_OFFSET_S) * 1_000_000 + us
}

/// Unix µs → NTP 64-bit timestamp `(secs, frac)` (wraps into era 1 after 2036).
pub fn unix_us_to_ntp(unix_us: i64) -> (u32, u32) {
    let s = unix_us.div_euclid(1_000_000) + NTP_UNIX_OFFSET_S;
    let us = unix_us.rem_euclid(1_000_000) as u64;
    // Round up so ntp -> unix -> ntp is stable at µs resolution.
    let frac = ((us << 32) + 999_999) / 1_000_000;
    (s as u32, frac as u32)
}

/// NTP short format (16.16 seconds) → µs.
fn short_to_us(v: u32) -> i64 {
    ((v as u64 * 1_000_000) >> 16) as i64
}

fn be32(b: &[u8], i: usize) -> u32 {
    u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Writes a client request (version 4, mode 3) whose transmit timestamp is
/// `cookie` into `out`. Returns [`PACKET_LEN`], or 0 when `out` is too small.
pub fn build_request(out: &mut [u8], cookie: u64) -> usize {
    if out.len() < PACKET_LEN {
        return 0;
    }
    out[..PACKET_LEN].fill(0);
    out[0] = (4 << 3) | 3; // LI 0, VN 4, mode 3 (client)
    out[40..48].copy_from_slice(&cookie.to_be_bytes());
    PACKET_LEN
}

/// Parses a server reply to the request that carried `cookie`.
pub fn parse_reply(b: &[u8], cookie: u64) -> Result<Reply, ReplyError> {
    if b.len() < PACKET_LEN {
        return Err(ReplyError::Truncated);
    }
    let leap = b[0] >> 6;
    let version = (b[0] >> 3) & 7;
    let mode = b[0] & 7;
    if mode != 4 || !(3..=4).contains(&version) {
        return Err(ReplyError::NotAReply);
    }
    if b[24..32] != cookie.to_be_bytes() {
        return Err(ReplyError::WrongOrigin);
    }
    let stratum = b[1];
    if stratum == 0 {
        return Err(ReplyError::KissOfDeath([b[12], b[13], b[14], b[15]]));
    }
    if leap == 3 || stratum >= 16 {
        return Err(ReplyError::Unsynchronised);
    }
    let (rs, rf) = (be32(b, 32), be32(b, 36));
    let (ts, tf) = (be32(b, 40), be32(b, 44));
    if ts == 0 && tf == 0 {
        return Err(ReplyError::BadTimestamps);
    }
    let receive_unix_us = ntp_to_unix_us(rs, rf);
    let transmit_unix_us = ntp_to_unix_us(ts, tf);
    if transmit_unix_us < receive_unix_us || (rs == 0 && rf == 0) {
        return Err(ReplyError::BadTimestamps);
    }
    Ok(Reply {
        leap,
        stratum,
        root_delay_us: short_to_us(be32(b, 4)),
        root_dispersion_us: short_to_us(be32(b, 8)),
        receive_unix_us,
        transmit_unix_us,
    })
}

/// One exchange's result on the monotonic clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Exchange {
    /// θ: UTC µs minus mono µs.
    pub offset_us: i64,
    /// δ: the network round trip, µs (≥ 0).
    pub delay_us: i64,
    /// The error bound of `T4 + θ` at T4: δ/2 + root delay/2 + root
    /// dispersion, µs.
    pub err_us: i64,
}

impl Exchange {
    /// θ, δ and the error bound from T1 / T4 (mono µs) and the reply.
    pub fn compute(t1_mono_us: i64, t4_mono_us: i64, r: &Reply) -> Exchange {
        let t2 = r.receive_unix_us;
        let t3 = r.transmit_unix_us;
        let offset_us = ((t2 - t1_mono_us) + (t3 - t4_mono_us)) / 2;
        let delay_us = ((t4_mono_us - t1_mono_us) - (t3 - t2)).max(0);
        let err_us = delay_us / 2 + r.root_delay_us / 2 + r.root_dispersion_us;
        Exchange {
            offset_us,
            delay_us,
            err_us,
        }
    }
}
