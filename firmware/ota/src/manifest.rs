//! The signed description of a firmware image (docs/design/ota.md "Image,
//! manifest, signature").
//!
//! Byte-for-byte the swarm loader's manifest (indoor_localization
//! `swarm/net/src/manifest.rs`), so the two loaders can converge on one format:
//!
//! | off | size | field     |                                               |
//! |-----|------|-----------|-----------------------------------------------|
//! | 0   | 4    | version   | u32 LE, monotonic                             |
//! | 4   | 4    | size      | u32 LE, image bytes                           |
//! | 8   | 32   | sha256    | of the image                                  |
//! | 40  | 4    | flags     | u32 LE; bit 0 = loader image (reserved),      |
//! |     |      |           | 8..15 key id, 16..23 security version,        |
//! |     |      |           | 24..31 board (0 = a C6 app; else Splanc MAX)  |
//! | 44  | 64   | signature | ECDSA P-256 r‖s over SHA-256 of bytes 0..44   |
//!
//! The signature is checked by the caller (mbedtls on the device, the `p256`
//! crate on the host): this module is the layout only, so it stays no_std and
//! dependency-free.

/// version, size, sha256, flags: the signed part.
pub const SIGNED_LEN: usize = 4 + 4 + 32 + 4;
pub const SIGNATURE_LEN: usize = 64;
pub const ENCODED_LEN: usize = SIGNED_LEN + SIGNATURE_LEN;

/// Reserved (as in the swarm): the image is a loader, not an app. Splanc's
/// loader refuses such images until loader self-update has its own safety story.
pub const FLAG_LOADER: u32 = 1 << 0;

/// The board an image is for, in flags bits 24..31 (signed, so it can't be
/// swapped): 0 = a C6 app image; 1.. = a Splanc MAX board (pi/max_ota `Board`,
/// docs/design/max-ota.md). The C6 and the MAX trust the SAME signing keys, so
/// this field is what keeps each from installing the other's images: the C6
/// refuses any board but 0, the MAX refuses 0 and any board but its own.
pub const BOARD_SHIFT: u32 = 24;
pub const BOARD_C6: u8 = 0;

/// The board id in `flags` (bits 24..31).
pub fn board(flags: u32) -> u8 {
    (flags >> BOARD_SHIFT) as u8
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Manifest {
    /// Monotonic; see [`version_number`] for how a release tag maps onto it.
    pub version: u32,
    /// Image length in bytes.
    pub size: u32,
    pub sha256: [u8; 32],
    pub flags: u32,
    /// ECDSA P-256 (r || s, big-endian each) over SHA-256 of [`signed_bytes`].
    pub signature: [u8; SIGNATURE_LEN],
}

impl Manifest {
    pub fn encode(&self) -> [u8; ENCODED_LEN] {
        let mut out = [0u8; ENCODED_LEN];
        out[..SIGNED_LEN].copy_from_slice(&self.signed_bytes());
        out[SIGNED_LEN..].copy_from_slice(&self.signature);
        out
    }

    /// Exactly [`ENCODED_LEN`] bytes (a longer buffer is not a manifest: the wire
    /// field and the NVS record both carry it alone).
    pub fn decode(b: &[u8]) -> Option<Manifest> {
        if b.len() != ENCODED_LEN {
            return None;
        }
        let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let mut sha256 = [0u8; 32];
        sha256.copy_from_slice(&b[8..40]);
        let mut signature = [0u8; SIGNATURE_LEN];
        signature.copy_from_slice(&b[SIGNED_LEN..ENCODED_LEN]);
        Some(Manifest { version: u32_at(0), size: u32_at(4), sha256, flags: u32_at(40), signature })
    }

    pub fn signed_bytes(&self) -> [u8; SIGNED_LEN] {
        let mut out = [0u8; SIGNED_LEN];
        out[0..4].copy_from_slice(&self.version.to_le_bytes());
        out[4..8].copy_from_slice(&self.size.to_le_bytes());
        out[8..40].copy_from_slice(&self.sha256);
        out[40..44].copy_from_slice(&self.flags.to_le_bytes());
        out
    }

    /// An unsigned manifest for an image whose digest is `sha256`.
    pub fn unsigned(version: u32, size: u32, sha256: [u8; 32], flags: u32) -> Manifest {
        Manifest { version, size, sha256, flags, signature: [0; SIGNATURE_LEN] }
    }
}

/// A release version as the manifest's monotonic number:
/// `major * 1_000_000 + minor * 1_000 + patch` (1.9.0 -> 1009000), so it reads
/// back in decimal. Components past 999 (minor/patch) or 4293 (major) don't fit.
pub fn version_number(major: u32, minor: u32, patch: u32) -> Option<u32> {
    if minor > 999 || patch > 999 || major > 4293 {
        return None;
    }
    Some(major * 1_000_000 + minor * 1_000 + patch)
}

/// Parse "X.Y.Z" (an optional leading 'v', and any "-suffix" after Z ignored)
/// into its [`version_number`].
pub fn parse_version(s: &str) -> Option<u32> {
    let s = s.strip_prefix('v').unwrap_or(s);
    let core = s.split(['-', '+']).next()?;
    let mut it = core.split('.');
    let mut part = || -> Option<u32> {
        let p = it.next()?;
        if p.is_empty() || p.len() > 4 || !p.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        p.parse().ok()
    };
    let (a, b, c) = (part()?, part()?, part()?);
    if it.next().is_some() {
        return None;
    }
    version_number(a, b, c)
}
