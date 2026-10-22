//! Which key may sign an image, and how keys are retired (docs/design/ota.md
//! "Key rotation").
//!
//! The loader trusts a small keyring compiled in: key id 0 `release` (online,
//! the OTA_SIGNING_KEY Actions secret), 1 `backup` (offline, cold storage), 2
//! `next` (a planned successor). The id travels in the manifest's flags (bits
//! 8..15; signed, so it can't be swapped), which keeps the manifest byte-for-byte
//! the swarm loader's layout (id 0 = flags 0 = the swarm's default).
//!
//! Retirement is a signed **key epoch** record: a monotonic epoch number and a
//! bitmask of revoked key ids, signed by a key the loader trusts and hasn't
//! revoked. The loader persists the highest epoch it has accepted and the union
//! of revocations, and never lowers either.
//!
//! The manifest's flags also carry a **security version** (bits 16..23). The
//! loader keeps a floor (the highest security version it has installed) and
//! refuses anything below it, whatever `allow_downgrade` says: a validly signed
//! older image with a known hole can't be replayed onto a device.

use crate::manifest::Manifest;

/// Key ids the loader knows (the compiled-in ring may leave some unset).
pub const KEY_RELEASE: u8 = 0;
pub const KEY_BACKUP: u8 = 1;
pub const KEY_NEXT: u8 = 2;
pub const MAX_KEYS: u8 = 8;

pub fn key_id(m: &Manifest) -> u8 {
    ((m.flags >> 8) & 0xff) as u8
}

pub fn security_version(m: &Manifest) -> u8 {
    ((m.flags >> 16) & 0xff) as u8
}

/// flags for a manifest signed by `key_id` at `security_version` (bit 0, the
/// swarm's loader flag, stays clear).
pub fn flags(key_id: u8, security_version: u8) -> u32 {
    ((key_id as u32) << 8) | ((security_version as u32) << 16)
}

/// What the loader has persisted.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyState {
    pub epoch: u32,
    /// Bit n set = key id n revoked.
    pub revoked: u32,
    /// Lowest security version still installable.
    pub security_floor: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyRefusal {
    /// No key with this id in the ring.
    UnknownKey,
    /// The key was revoked by an accepted epoch record.
    RevokedKey,
    /// Below the device's security-version floor.
    SecurityFloor,
    BadEpoch,
    /// An epoch record that isn't newer than the stored one.
    StaleEpoch,
    /// An epoch record that would un-revoke a key, or revoke its own signer.
    BadRevocation,
    BadSignature,
}

impl KeyRefusal {
    pub fn code(&self) -> &'static str {
        match self {
            KeyRefusal::UnknownKey => "unknown_key",
            KeyRefusal::RevokedKey => "revoked_key",
            KeyRefusal::SecurityFloor => "security_floor",
            KeyRefusal::BadEpoch => "bad_epoch",
            KeyRefusal::StaleEpoch => "stale_epoch",
            KeyRefusal::BadRevocation => "bad_revocation",
            KeyRefusal::BadSignature => "bad_signature",
        }
    }
}

/// Which ring key must verify `m`: its id must be in the ring (`in_ring(id)`)
/// and not revoked, and its security version at or above the floor.
pub fn select_key(m: &Manifest, in_ring: impl Fn(u8) -> bool, st: &KeyState) -> Result<u8, KeyRefusal> {
    let id = key_id(m);
    if id >= MAX_KEYS || !in_ring(id) {
        return Err(KeyRefusal::UnknownKey);
    }
    if st.revoked & (1 << id) != 0 {
        return Err(KeyRefusal::RevokedKey);
    }
    if security_version(m) < st.security_floor {
        return Err(KeyRefusal::SecurityFloor);
    }
    Ok(id)
}

/// The floor after installing `m` (it only rises).
pub fn raise_floor(st: &KeyState, m: &Manifest) -> KeyState {
    KeyState { security_floor: st.security_floor.max(security_version(m)), ..*st }
}

pub const EPOCH_MAGIC: u32 = 0x5045_4b53; // "SKEP" little-endian
pub const EPOCH_SIGNED_LEN: usize = 16;
pub const EPOCH_LEN: usize = EPOCH_SIGNED_LEN + 64;

/// A signed key epoch: magic, epoch, revoked mask, signer key id (u32 LE each),
/// then ECDSA P-256 r||s over SHA-256 of those 16 bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EpochRecord {
    pub epoch: u32,
    pub revoked: u32,
    pub signer: u8,
    pub signature: [u8; 64],
}

impl EpochRecord {
    pub fn signed_bytes(&self) -> [u8; EPOCH_SIGNED_LEN] {
        let mut b = [0u8; EPOCH_SIGNED_LEN];
        b[0..4].copy_from_slice(&EPOCH_MAGIC.to_le_bytes());
        b[4..8].copy_from_slice(&self.epoch.to_le_bytes());
        b[8..12].copy_from_slice(&self.revoked.to_le_bytes());
        b[12..16].copy_from_slice(&(self.signer as u32).to_le_bytes());
        b
    }

    pub fn encode(&self) -> [u8; EPOCH_LEN] {
        let mut b = [0u8; EPOCH_LEN];
        b[..EPOCH_SIGNED_LEN].copy_from_slice(&self.signed_bytes());
        b[EPOCH_SIGNED_LEN..].copy_from_slice(&self.signature);
        b
    }

    pub fn decode(b: &[u8]) -> Option<EpochRecord> {
        if b.len() != EPOCH_LEN {
            return None;
        }
        let u = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        if u(0) != EPOCH_MAGIC || u(12) >= MAX_KEYS as u32 {
            return None;
        }
        let mut signature = [0u8; 64];
        signature.copy_from_slice(&b[EPOCH_SIGNED_LEN..]);
        Some(EpochRecord { epoch: u(4), revoked: u(8), signer: u(12) as u8, signature })
    }
}

/// Apply a record whose signature (by ring key `rec.signer`) the caller checked:
/// `signature_ok`. The signer must be in the ring and not revoked (before or by
/// this record); the epoch must rise; revocations only accumulate. Returns the
/// new state to persist. A record equal to the stored epoch is `StaleEpoch`
/// (callers treat that as "already applied").
pub fn apply_epoch(
    st: &KeyState,
    rec: &EpochRecord,
    signature_ok: bool,
    in_ring: impl Fn(u8) -> bool,
) -> Result<KeyState, KeyRefusal> {
    if !in_ring(rec.signer) {
        return Err(KeyRefusal::UnknownKey);
    }
    if st.revoked & (1 << rec.signer) != 0 {
        return Err(KeyRefusal::RevokedKey);
    }
    if !signature_ok {
        return Err(KeyRefusal::BadSignature);
    }
    if rec.epoch <= st.epoch {
        return Err(KeyRefusal::StaleEpoch);
    }
    if (rec.revoked & st.revoked) != st.revoked || (rec.revoked & (1 << rec.signer)) != 0 {
        return Err(KeyRefusal::BadRevocation);
    }
    Ok(KeyState { epoch: rec.epoch, revoked: rec.revoked, ..*st })
}
