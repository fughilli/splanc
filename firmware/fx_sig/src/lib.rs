//! Signatures for prebuilt native (AOT) effect images
//! (docs/design/fx-native-aot.md, "Trust").
//!
//! A prebuilt native image travels as a `.fxn` container: a fixed 40-byte
//! header, the RV32 code words, and the operand bytes the image's generic
//! helper reads. The header carries a **4-byte truncated HMAC-SHA256** tag
//! computed with a symmetric key the device holds (today the public *dev* key
//! on every device; later a per-user key provisioned by pairing). The tag
//! binds, through one canonical domain-separated message:
//!
//! - every header field (key id, key epoch, native ABI, minimum firmware
//!   version, device/fleet scope, sizes, entry offsets);
//! - the native code and operand bytes;
//! - the exact `.fxb` bytecode the image was lowered from (the device already
//!   holds it, so it is hashed in, not shipped twice).
//!
//! ```text
//! tag = HMAC-SHA256(key, "splanc-fx-sig-v1" || header[0..36]
//!                        || SHA-256(code || op_code || fxb))[0..4]
//! ```
//!
//! It does **not** bind the firmware build: a signature stays valid across
//! firmware releases as long as the native ABI is one the firmware supports and
//! the firmware is at least `min_fw`. Old blobs are retired by raising the
//! device's minimum key epoch or revoking the key id ([`Policy`]), not by a
//! version field.
//!
//! The signature authenticates *who* produced an image; it is never the only
//! guard. Every image, signed or not, still passes `fx_aot::verify` and runs
//! under the arena's PMP/PMA W^X protection.
//!
//! A 32-bit tag can be guessed with probability 2^-32 per attempt, so failed
//! verifications are rate limited ([`Limiter`]) with an exponential backoff
//! whose state the firmware persists across reboots.
//!
//! no_std, no alloc; SHA-256 comes from `splanc_ota` (shared with the OTA
//! signer) behind the [`Digest`] trait, so the device can plug in the C6's
//! hardware SHA.
#![cfg_attr(not(test), no_std)]

pub mod keyring;
pub mod limiter;

pub use keyring::{KeyRing, Policy, DEV_KEY, DEV_KEY_ID};
pub use limiter::Limiter;

use splanc_ota::sha256::Sha256;

/// Container magic.
pub const MAGIC: [u8; 4] = *b"FXN1";
/// Container format version (byte 4).
pub const FORMAT_VERSION: u8 = 1;
/// Domain-separation prefix of the HMAC message (16 bytes).
pub const DOMAIN: &[u8; 16] = b"splanc-fx-sig-v1";
/// Header length; the tag is its last [`TAG_LEN`] bytes.
pub const HEADER_LEN: usize = 40;
/// Signed header prefix (everything but the tag).
pub const SIGNED_HEADER_LEN: usize = 36;
/// Truncated tag length (32 bits).
pub const TAG_LEN: usize = 4;
/// Scope value meaning "any device holding the key" (fleet-wide).
pub const SCOPE_FLEET: [u8; 8] = [0; 8];
/// Entry-offset sentinel for "no such entry".
pub const NO_ENTRY: u16 = 0xFFFF;

/// A streaming SHA-256. The software one ([`SoftSha256`]) is the default; the
/// device may supply a hardware-backed one. Must be FIPS 180-4 SHA-256.
pub trait Digest {
    fn update(&mut self, data: &[u8]);
    fn finish(self) -> [u8; 32];
}

/// The dependency-free software SHA-256 shared with the OTA signer.
#[derive(Clone, Default)]
pub struct SoftSha256(Sha256);

impl SoftSha256 {
    pub fn new() -> Self {
        SoftSha256(Sha256::new())
    }
}

impl Digest for SoftSha256 {
    fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }
    fn finish(self) -> [u8; 32] {
        self.0.finish()
    }
}

/// A firmware release as one monotonic number, the same packing the OTA
/// manifest uses: `major * 1_000_000 + minor * 1_000 + patch` (1.6.0 ->
/// 1_006_000). Untagged development builds report 0.
pub fn fw_version(major: u32, minor: u32, patch: u32) -> Option<u32> {
    splanc_ota::manifest::version_number(major, minor, patch)
}

/// Parse "X.Y.Z" (optional leading 'v', any "-suffix" ignored) into
/// [`fw_version`]'s number; `None` if it isn't a release version.
pub fn parse_fw_version(s: &str) -> Option<u32> {
    splanc_ota::manifest::parse_version(s)
}

/// The decoded `.fxn` header.
///
/// | off | size | field |
/// |---|---|---|
/// | 0 | 4 | magic `FXN1` |
/// | 4 | 1 | format version (1) |
/// | 5 | 1 | `key_id` |
/// | 6 | 2 | `key_epoch` |
/// | 8 | 2 | `abi` (native ABI version) |
/// | 10 | 2 | `flags` (0) |
/// | 12 | 4 | `min_fw` ([`fw_version`] packing) |
/// | 16 | 8 | `scope` ([`SCOPE_FLEET`] or a device id, e.g. the MAC, zero padded) |
/// | 24 | 2 | `code_words` |
/// | 26 | 2 | `op_code_len` |
/// | 28 | 2 | `update_off` (words; [`NO_ENTRY`]) |
/// | 30 | 2 | `shade_off` |
/// | 32 | 2 | `prep_off` ([`NO_ENTRY`]) |
/// | 34 | 2 | reserved (0) |
/// | 36 | 4 | `tag` |
///
/// All integers little-endian. Payload: `code_words` u32 LE words, then
/// `op_code_len` bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Header {
    pub key_id: u8,
    pub key_epoch: u16,
    pub abi: u16,
    pub flags: u16,
    pub min_fw: u32,
    pub scope: [u8; 8],
    pub code_words: u16,
    pub op_code_len: u16,
    pub update_off: u16,
    pub shade_off: u16,
    pub prep_off: u16,
    pub tag: [u8; TAG_LEN],
}

impl Header {
    /// Encode to the 40 wire bytes.
    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut h = [0u8; HEADER_LEN];
        h[0..4].copy_from_slice(&MAGIC);
        h[4] = FORMAT_VERSION;
        h[5] = self.key_id;
        h[6..8].copy_from_slice(&self.key_epoch.to_le_bytes());
        h[8..10].copy_from_slice(&self.abi.to_le_bytes());
        h[10..12].copy_from_slice(&self.flags.to_le_bytes());
        h[12..16].copy_from_slice(&self.min_fw.to_le_bytes());
        h[16..24].copy_from_slice(&self.scope);
        h[24..26].copy_from_slice(&self.code_words.to_le_bytes());
        h[26..28].copy_from_slice(&self.op_code_len.to_le_bytes());
        h[28..30].copy_from_slice(&self.update_off.to_le_bytes());
        h[30..32].copy_from_slice(&self.shade_off.to_le_bytes());
        h[32..34].copy_from_slice(&self.prep_off.to_le_bytes());
        h[36..40].copy_from_slice(&self.tag);
        h
    }

    /// Decode and structurally check a header (not the tag).
    pub fn decode(b: &[u8]) -> Result<Header, Reject> {
        if b.len() < HEADER_LEN {
            return Err(Reject::Malformed);
        }
        if b[0..4] != MAGIC || b[4] != FORMAT_VERSION {
            return Err(Reject::Malformed);
        }
        let u16_at = |o: usize| u16::from_le_bytes([b[o], b[o + 1]]);
        if u16_at(34) != 0 {
            return Err(Reject::Malformed);
        }
        let mut scope = [0u8; 8];
        scope.copy_from_slice(&b[16..24]);
        let mut tag = [0u8; TAG_LEN];
        tag.copy_from_slice(&b[36..40]);
        Ok(Header {
            key_id: b[5],
            key_epoch: u16_at(6),
            abi: u16_at(8),
            flags: u16_at(10),
            min_fw: u32::from_le_bytes([b[12], b[13], b[14], b[15]]),
            scope,
            code_words: u16_at(24),
            op_code_len: u16_at(26),
            update_off: u16_at(28),
            shade_off: u16_at(30),
            prep_off: u16_at(32),
            tag,
        })
    }

    /// Total container length this header declares.
    pub fn total_len(&self) -> usize {
        HEADER_LEN + 4 * self.code_words as usize + self.op_code_len as usize
    }
}

/// A parsed, *not yet authenticated* container borrowing its bytes.
#[derive(Clone, Copy, Debug)]
pub struct Fxn<'a> {
    pub header: Header,
    raw_header: &'a [u8],
    /// Code bytes (`code_words * 4`, little-endian words).
    pub code: &'a [u8],
    pub op_code: &'a [u8],
}

impl<'a> Fxn<'a> {
    /// Parse a container: header, exact length, entry offsets inside the code.
    pub fn parse(b: &'a [u8]) -> Result<Fxn<'a>, Reject> {
        let header = Header::decode(b)?;
        if b.len() != header.total_len() || header.code_words == 0 {
            return Err(Reject::Malformed);
        }
        let in_code = |o: u16, optional: bool| {
            (optional && o == NO_ENTRY) || (o as usize) < header.code_words as usize
        };
        if !in_code(header.shade_off, false)
            || !in_code(header.update_off, true)
            || !in_code(header.prep_off, true)
        {
            return Err(Reject::Malformed);
        }
        let code_end = HEADER_LEN + 4 * header.code_words as usize;
        Ok(Fxn {
            header,
            raw_header: &b[..HEADER_LEN],
            code: &b[HEADER_LEN..code_end],
            op_code: &b[code_end..],
        })
    }

    /// Code word `i` (little-endian).
    pub fn word(&self, i: usize) -> u32 {
        let c = &self.code[4 * i..4 * i + 4];
        u32::from_le_bytes([c[0], c[1], c[2], c[3]])
    }
}

/// Why a native image was not accepted. The effect then stays on the VM; the
/// reason is reported to the client (never a refusal to play).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    /// Not a well-formed v1 container (or the wrong length / entry offsets).
    Malformed,
    /// No key with this id is provisioned.
    UnknownKey,
    /// The key id is revoked ([`Policy::revoked`]).
    RevokedKey,
    /// Signed under a key epoch below the device's minimum ([`Policy::min_epoch`]).
    OldEpoch,
    /// Scoped to a different device.
    WrongScope,
    /// The native ABI isn't one this firmware supports.
    AbiUnsupported,
    /// Requires a newer firmware (`min_fw` above the running version).
    FirmwareTooOld,
    /// Failed verifications are backing off; retry after this many ms.
    RateLimited { retry_ms: u32 },
    /// The tag doesn't match (tampered, wrong key, or a different `.fxb`).
    BadTag,
}

impl Reject {
    /// Short stable token for logs and the client-visible fallback reason.
    pub fn as_str(&self) -> &'static str {
        match self {
            Reject::Malformed => "malformed",
            Reject::UnknownKey => "unknown_key",
            Reject::RevokedKey => "revoked_key",
            Reject::OldEpoch => "old_epoch",
            Reject::WrongScope => "wrong_scope",
            Reject::AbiUnsupported => "abi_unsupported",
            Reject::FirmwareTooOld => "fw_too_old",
            Reject::RateLimited { .. } => "rate_limited",
            Reject::BadTag => "bad_tag",
        }
    }
}

/// What the running firmware is and accepts — echoed with a fallback reason so
/// the client sees why (e.g. `fw=1006000 abi=1`).
#[derive(Clone, Copy, Debug)]
pub struct Device<'a> {
    /// The running firmware's [`fw_version`] (0 for an untagged dev build).
    pub fw_version: u32,
    /// Native ABI versions this firmware can execute.
    pub abis: &'a [u16],
    /// This device's id for scoped images (e.g. the MAC, zero padded).
    pub device_id: [u8; 8],
}

/// SHA-256 over the signed payload: `code || op_code || fxb`.
pub fn payload_digest<D: Digest>(mut d: D, code: &[u8], op_code: &[u8], fxb: &[u8]) -> [u8; 32] {
    d.update(code);
    d.update(op_code);
    d.update(fxb);
    d.finish()
}

/// The full (untruncated) HMAC over the canonical message.
fn hmac_message<D: Digest + Clone>(
    k: &keyring::HmacKey<D>,
    signed_header: &[u8],
    digest: &[u8; 32],
) -> [u8; 32] {
    k.mac(&[DOMAIN, signed_header, digest])
}

/// The 4-byte tag for a header (its tag field ignored) over `code`, `op_code`
/// and `fxb`, under `key`. Host signer and tests; the device uses [`verify`].
pub fn tag(key: &[u8], header: &Header, code: &[u8], op_code: &[u8], fxb: &[u8]) -> [u8; TAG_LEN] {
    let k = keyring::HmacKey::<SoftSha256>::new(key, SoftSha256::new);
    let hdr = header.encode();
    let digest = payload_digest(SoftSha256::new(), code, op_code, fxb);
    let full = hmac_message(&k, &hdr[..SIGNED_HEADER_LEN], &digest);
    let mut t = [0u8; TAG_LEN];
    t.copy_from_slice(&full[..TAG_LEN]);
    t
}

/// Constant-time equality of two tags (no early exit on the first mismatch).
#[inline(never)]
pub fn ct_eq(a: &[u8; TAG_LEN], b: &[u8; TAG_LEN]) -> bool {
    let mut d = 0u8;
    for i in 0..TAG_LEN {
        d |= a[i] ^ b[i];
    }
    // Read through a volatile so the fold isn't turned into a branchy compare.
    unsafe { core::ptr::read_volatile(&d) == 0 }
}

/// Authenticate a parsed container for this device, against the `.fxb` it
/// claims to implement. Checks, in order: the key (provisioned, not revoked,
/// epoch), scope, ABI, minimum firmware, then the rate limiter, then the tag
/// (one SHA-256 over the payload + one HMAC). A tag failure is recorded in
/// `limiter` at `now_ms`; the caller persists [`Limiter::persisted`] if
/// [`Limiter::take_dirty`] says it changed.
///
/// `new_digest` makes a fresh SHA-256 for the payload hash (software or
/// hardware); the HMAC itself uses the keyring's precomputed states.
#[allow(clippy::too_many_arguments)]
pub fn verify<R: Digest + Clone, P: Digest>(
    fxn: &Fxn<'_>,
    fxb: &[u8],
    ring: &KeyRing<R>,
    policy: &Policy,
    dev: &Device<'_>,
    limiter: &mut Limiter,
    now_ms: u64,
    new_digest: impl FnOnce() -> P,
) -> Result<(), Reject> {
    let h = &fxn.header;
    let key = ring.get(h.key_id).ok_or(Reject::UnknownKey)?;
    if policy.is_revoked(h.key_id) {
        return Err(Reject::RevokedKey);
    }
    if h.key_epoch < policy.min_epoch {
        return Err(Reject::OldEpoch);
    }
    if h.scope != SCOPE_FLEET && h.scope != dev.device_id {
        return Err(Reject::WrongScope);
    }
    if !dev.abis.contains(&h.abi) {
        return Err(Reject::AbiUnsupported);
    }
    if dev.fw_version < h.min_fw {
        return Err(Reject::FirmwareTooOld);
    }
    limiter.check(now_ms)?;
    let digest = payload_digest(new_digest(), fxn.code, fxn.op_code, fxb);
    let full = hmac_message(key, &fxn.raw_header[..SIGNED_HEADER_LEN], &digest);
    let mut want = [0u8; TAG_LEN];
    want.copy_from_slice(&full[..TAG_LEN]);
    if ct_eq(&want, &h.tag) {
        limiter.success();
        Ok(())
    } else {
        limiter.fail(now_ms);
        Err(Reject::BadTag)
    }
}

/// Build a signed container into `out` (host side: the signer and the bench
/// generator). The header's tag/size fields are filled in. Returns the length.
pub fn build_into(
    out: &mut [u8],
    key: &[u8],
    mut header: Header,
    code_words: &[u32],
    op_code: &[u8],
    fxb: &[u8],
) -> Option<usize> {
    header.code_words = u16::try_from(code_words.len()).ok()?;
    header.op_code_len = u16::try_from(op_code.len()).ok()?;
    let total = header.total_len();
    if out.len() < total {
        return None;
    }
    let code_end = HEADER_LEN + 4 * code_words.len();
    for (i, w) in code_words.iter().enumerate() {
        out[HEADER_LEN + 4 * i..HEADER_LEN + 4 * i + 4].copy_from_slice(&w.to_le_bytes());
    }
    out[code_end..total].copy_from_slice(op_code);
    let t = {
        let (code, rest) = out[HEADER_LEN..total].split_at(4 * code_words.len());
        tag(key, &header, code, rest, fxb)
    };
    header.tag = t;
    out[..HEADER_LEN].copy_from_slice(&header.encode());
    Some(total)
}

#[cfg(test)]
mod tests;
