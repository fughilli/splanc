//! Native-image signing keys held by the device, and the revocation policy.
//!
//! Keys are symmetric HMAC-SHA256 keys identified by a one-byte id. Today every
//! device holds only the **dev key** (id [`DEV_KEY_ID`]): it is compiled into
//! the firmware and checked into the repo, so it authenticates nothing — it
//! exists to bring the signature path up end to end. A per-user key
//! provisioned by pairing (docs/design/fx-native-aot.md, "Provisioning seam")
//! slots in under another id with no format change; revoking id 0 then retires
//! every dev-signed blob.
//!
//! The ring stores each key as its precomputed HMAC inner/outer hash states, so
//! a verify costs the two final compressions instead of re-deriving the pads.

use crate::Digest;

/// Key id of the development key.
pub const DEV_KEY_ID: u8 = 0;

/// The development key. **Not a secret**: public in the repository and present
/// on every device, so a dev-key signature proves nothing about who built an
/// image. Replace with per-user provisioned keys (and revoke id 0) before
/// signatures are relied on for anything.
pub const DEV_KEY: [u8; 32] = *b"splanc-fx-dev-key-NOT-SECRET-v1!";

/// Most keys a device holds at once (dev + user keys during a rotation).
pub const MAX_KEYS: usize = 4;

/// An HMAC-SHA256 key as its precomputed `key ^ ipad` / `key ^ opad` states.
#[derive(Clone)]
pub struct HmacKey<D> {
    pub(crate) inner: D,
    pub(crate) outer: D,
}

impl<D: Digest + Clone> HmacKey<D> {
    /// RFC 2104 key schedule: keys longer than the 64-byte block are hashed
    /// first, shorter ones zero-padded.
    pub fn new(key: &[u8], mut new_digest: impl FnMut() -> D) -> Self {
        let mut k0 = [0u8; 64];
        if key.len() > 64 {
            let mut d = new_digest();
            d.update(key);
            k0[..32].copy_from_slice(&d.finish());
        } else {
            k0[..key.len()].copy_from_slice(key);
        }
        let mut ipad = [0u8; 64];
        let mut opad = [0u8; 64];
        for i in 0..64 {
            ipad[i] = k0[i] ^ 0x36;
            opad[i] = k0[i] ^ 0x5c;
        }
        let mut inner = new_digest();
        inner.update(&ipad);
        let mut outer = new_digest();
        outer.update(&opad);
        HmacKey { inner, outer }
    }

    /// Full HMAC-SHA256 over the concatenation of `parts`.
    pub fn mac(&self, parts: &[&[u8]]) -> [u8; 32] {
        let mut inner = self.inner.clone();
        for p in parts {
            inner.update(p);
        }
        let ih = inner.finish();
        let mut outer = self.outer.clone();
        outer.update(&ih);
        outer.finish()
    }
}

/// The device's provisioned keys (fixed capacity, no alloc).
#[derive(Clone)]
pub struct KeyRing<D> {
    slots: [Option<(u8, HmacKey<D>)>; MAX_KEYS],
}

impl<D: Digest + Clone> KeyRing<D> {
    pub const fn empty() -> Self {
        KeyRing {
            slots: [None, None, None, None],
        }
    }

    /// A ring holding only the dev key — the default on every device today.
    pub fn with_dev_key(new_digest: impl FnMut() -> D) -> Self {
        let mut r = Self::empty();
        r.install(DEV_KEY_ID, &DEV_KEY, new_digest);
        r
    }

    /// Install (or replace) key `id`. False when the ring is full.
    pub fn install(&mut self, id: u8, key: &[u8], new_digest: impl FnMut() -> D) -> bool {
        let k = HmacKey::new(key, new_digest);
        if let Some(s) = self.slots.iter_mut().flatten().find(|(i, _)| *i == id) {
            s.1 = k;
            return true;
        }
        match self.slots.iter_mut().find(|s| s.is_none()) {
            Some(s) => {
                *s = Some((id, k));
                true
            }
            None => false,
        }
    }

    /// Drop key `id` (no-op if absent).
    pub fn remove(&mut self, id: u8) {
        for s in self.slots.iter_mut() {
            if matches!(s, Some((i, _)) if *i == id) {
                *s = None;
            }
        }
    }

    pub fn get(&self, id: u8) -> Option<&HmacKey<D>> {
        self.slots
            .iter()
            .flatten()
            .find(|(i, _)| *i == id)
            .map(|(_, k)| k)
    }

    /// Provisioned key ids (for status reporting).
    pub fn ids(&self) -> impl Iterator<Item = u8> + '_ {
        self.slots.iter().flatten().map(|(i, _)| *i)
    }
}

/// Revocation policy, persisted next to the keys (NVS) and, like the OTA
/// keyring's `kepoch`/`krevoked`, never lowered.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Policy {
    /// Blobs signed under a lower key epoch are refused. Raising it retires
    /// every older blob at once, whatever key signed it.
    pub min_epoch: u16,
    /// Revoked key ids, one bit per id 0..=31 (bit 0 = the dev key).
    pub revoked: u32,
}

impl Policy {
    pub fn is_revoked(&self, id: u8) -> bool {
        id < 32 && self.revoked & (1 << id) != 0
    }

    /// Raise the minimum epoch (a lower value is ignored). True if it changed.
    pub fn raise_min_epoch(&mut self, epoch: u16) -> bool {
        if epoch > self.min_epoch {
            self.min_epoch = epoch;
            true
        } else {
            false
        }
    }

    /// Revoke key id `id` (ids >= 32 can't be revoked by bit; use the epoch).
    pub fn revoke(&mut self, id: u8) -> bool {
        if id >= 32 || self.is_revoked(id) {
            return false;
        }
        self.revoked |= 1 << id;
        true
    }
}
