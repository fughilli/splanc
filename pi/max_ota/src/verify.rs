//! Is this offer installable on this device? (docs/design/max-ota.md "Signing")
//!
//! The same 108-byte manifest as the C6 (`splanc_ota::manifest`), checked against
//! the ring (`crate::ring::RING`: the C6 loader's ring, 0 `release`, 1 `backup`,
//! 2 `next`) and the board in flags bits 24..31, which is mandatory: the keys are
//! shared, so the signed board is what keeps a C6 image (board 0) off a MAX. The player (unprivileged, facing the
//! network) runs this for a quick answer to `ota_begin`; the root updater runs it
//! again before it downloads anything, and is the authority.

use p256::ecdsa::signature::Verifier;
use p256::ecdsa::{Signature, VerifyingKey};
use splanc_ota::keyring::{self, EpochRecord, KeyRefusal, KeyState};
use splanc_ota::manifest::{Manifest, FLAG_LOADER};

use crate::board::{self, Board};

pub type Ring = [(u8, &'static str, Option<[u8; 65]>)];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    BadManifest,
    WrongBoard,
    Key(KeyRefusal),
    Downgrade,
    TooLarge,
    BadEpoch,
}

impl Refusal {
    /// The OtaStatus.error code (the C6's codes where they mean the same thing).
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::BadManifest => "bad_manifest",
            Refusal::WrongBoard => "wrong_board",
            Refusal::Key(k) => k.code(),
            Refusal::Downgrade => "downgrade",
            Refusal::TooLarge => "too_large",
            Refusal::BadEpoch => "bad_epoch",
        }
    }
}

/// What the device knows when it judges an offer.
#[derive(Clone, Copy, Debug)]
pub struct Device {
    pub board: Board,
    pub keys: KeyState,
    /// Manifest version of the running system (0 = unknown: a developer deploy).
    pub app_version: u32,
}

/// The ring key with this id, if it is provisioned (UNSET entries verify nothing).
pub fn ring_key(ring: &Ring, id: u8) -> Option<&[u8; 65]> {
    ring.iter().find(|(k, _, _)| *k == id).and_then(|(_, _, key)| key.as_ref())
}

/// ECDSA P-256 over SHA-256(`msg`), `sig` = r || s (the signer's format).
pub fn signature_ok(public: &[u8; 65], msg: &[u8], sig: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_sec1_bytes(public) else {
        return false;
    };
    let Ok(sig) = Signature::from_slice(sig) else {
        return false;
    };
    vk.verify(msg, &sig).is_ok()
}

/// Check a manifest offered for install. Ok = the parsed manifest, signed by a
/// trusted, unrevoked ring key, for this board, at or above the security floor, and
/// not a downgrade unless asked for.
pub fn check_offer(manifest: &[u8], allow_downgrade: bool, dev: &Device, ring: &Ring) -> Result<Manifest, Refusal> {
    let m = Manifest::decode(manifest).ok_or(Refusal::BadManifest)?;
    if m.flags & FLAG_LOADER != 0 || m.size == 0 {
        return Err(Refusal::BadManifest);
    }
    if board::board_id(m.flags) != dev.board.id() {
        return Err(Refusal::WrongBoard);
    }
    let id = keyring::select_key(&m, |id| ring_key(ring, id).is_some(), &dev.keys).map_err(Refusal::Key)?;
    let public = ring_key(ring, id).ok_or(Refusal::Key(KeyRefusal::UnknownKey))?;
    if !signature_ok(public, &m.signed_bytes(), &m.signature) {
        return Err(Refusal::Key(KeyRefusal::BadSignature));
    }
    if m.version < dev.app_version && !allow_downgrade {
        return Err(Refusal::Downgrade);
    }
    Ok(m)
}

/// Apply a key-epoch record (docs/design/ota.md "Key rotation"; the release's
/// `key-epoch.bin`, the same record the C6 loaders apply: same ring): the new key
/// state, or the current one when the record is not newer (already applied). A
/// record whose signer isn't a provisioned ring key is refused (`unknown_key`), as
/// on the C6.
pub fn apply_epoch(st: &KeyState, rec: &[u8], ring: &Ring) -> Result<KeyState, Refusal> {
    let r = EpochRecord::decode(rec).ok_or(Refusal::BadEpoch)?;
    let sig_ok = ring_key(ring, r.signer).is_some_and(|k| signature_ok(k, &r.signed_bytes(), &r.signature));
    match keyring::apply_epoch(st, &r, sig_ok, |id| ring_key(ring, id).is_some()) {
        Ok(next) => Ok(next),
        Err(KeyRefusal::StaleEpoch) => Ok(*st),
        Err(e) => Err(Refusal::Key(e)),
    }
}
