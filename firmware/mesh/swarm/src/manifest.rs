// Ported from fughilli/indoor_localization swarm/net/src/manifest.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! The signed description of a firmware image: a `Manifest` envelope `{body, signature}`
//! (swarm_wire.proto). It fits in one UWB frame of its own (FRAME_TYPE_FW_MANIFEST), so a
//! node can check an offer before it accepts a single byte of the image. Signed with ECDSA
//! P-256 (verified by MbedTLS on the device); the public key is compiled into the firmware,
//! the private key stays on the host.
//!
//! The signature covers SHA-256 of the `body` bytes exactly as the signer serialized them.
//! A received manifest keeps the envelope bytes it arrived as and is stored and re-served
//! from those: it is never re-encoded.

use crate::crypto::{self, P256_PUBLIC_KEY_LEN, P256_SIGNATURE_LEN};
use crate::wire::{self, pb};

pub const SIGNATURE_LEN: usize = P256_SIGNATURE_LEN;
/// Longest ManifestBody: version 6 + size 6 + sha256 34 + flags 2.
pub const MAX_BODY: usize = 48;
/// Longest Manifest the link carries: (46 + 2) + 66 = 114 with `flags` absent (0), which
/// leaves a 10-byte link header 124 of 125. A manifest with `flags` set and every other
/// varint at full width would be 116 and is rejected (flags is reserved).
pub const MAX_ENCODED: usize = 114;
/// Staging sector 0: `varint(length) || Manifest`.
pub const STAGED_MAX: usize = 1 + MAX_ENCODED;

/// Reserved: the image is a loader, not node firmware.
pub const FLAG_LOADER: u32 = 1 << 0;

#[derive(Clone, Copy, Debug)]
pub struct Manifest {
    /// Monotonic; nodes ignore images not newer than what they have.
    pub version: u32,
    /// Image length in bytes.
    pub size: u32,
    pub sha256: [u8; 32],
    pub flags: u32,
    /// ECDSA P-256 (r || s) over SHA-256 of the body bytes. All zero while unsigned.
    pub signature: [u8; SIGNATURE_LEN],
    /// ManifestBody exactly as signed.
    body: [u8; MAX_BODY],
    body_len: u8,
    /// The envelope as transmitted (empty while unsigned).
    raw: [u8; MAX_ENCODED],
    raw_len: u8,
}

/// Equal when the envelopes are byte-identical.
impl PartialEq for Manifest {
    fn eq(&self, o: &Manifest) -> bool {
        self.raw() == o.raw()
    }
}
impl Eq for Manifest {}

impl Manifest {
    /// Parse an envelope (structure only: nothing is trusted until `verify`). The bytes are
    /// kept verbatim.
    pub fn decode(b: &[u8]) -> Option<Manifest> {
        if b.is_empty() || b.len() > MAX_ENCODED {
            return None;
        }
        let env = pb::ManifestView::parse(b).ok()?;
        let (body_bytes, signature) = (env.body(), env.signature());
        if signature.len() != SIGNATURE_LEN || body_bytes.is_empty() || body_bytes.len() > MAX_BODY {
            return None;
        }
        let body = pb::ManifestBodyView::parse(body_bytes).ok()?;
        if body.sha256().len() != 32 {
            return None;
        }
        let mut m = Manifest {
            version: body.version(),
            size: body.size(),
            sha256: [0; 32],
            flags: body.flags(),
            signature: [0; SIGNATURE_LEN],
            body: [0; MAX_BODY],
            body_len: body_bytes.len() as u8,
            raw: [0; MAX_ENCODED],
            raw_len: b.len() as u8,
        };
        m.sha256.copy_from_slice(body.sha256());
        m.signature.copy_from_slice(signature);
        m.body[..body_bytes.len()].copy_from_slice(body_bytes);
        m.raw[..b.len()].copy_from_slice(b);
        Some(m)
    }

    /// The envelope as transmitted: what goes in a FW_MANIFEST frame, to the staging flash
    /// and to the USB host. Empty if unsigned.
    pub fn raw(&self) -> &[u8] {
        &self.raw[..self.raw_len as usize]
    }

    /// The ManifestBody bytes the signature covers.
    pub fn body_bytes(&self) -> &[u8] {
        &self.body[..self.body_len as usize]
    }

    /// Signature check against the public key built into the firmware, over the exact body
    /// bytes this manifest arrived with.
    pub fn verify(&self, public_key: &[u8; P256_PUBLIC_KEY_LEN]) -> bool {
        self.raw_len != 0 && crypto::p256_verify(public_key, self.body_bytes(), &self.signature)
    }

    /// An unsigned manifest for `image`; sign() fills the signature and the envelope.
    pub fn for_image(image: &[u8], version: u32, flags: u32) -> Manifest {
        let sha256 = crypto::sha256(image);
        let size = image.len() as u32;
        let mut m = Manifest {
            version,
            size,
            sha256,
            flags,
            signature: [0; SIGNATURE_LEN],
            body: [0; MAX_BODY],
            body_len: 0,
            raw: [0; MAX_ENCODED],
            raw_len: 0,
        };
        m.body_len = wire::manifest_body(version, size, &sha256, flags, &mut m.body).expect("body fits") as u8;
        m
    }

    /// Sign with a P-256 private scalar (host side) and build the envelope. False if the
    /// envelope would not fit one frame (MAX_ENCODED).
    #[cfg(not(feature = "mbedtls"))]
    pub fn sign(&mut self, secret: &[u8; 32]) -> bool {
        self.signature = crypto::signing::p256_sign(secret, self.body_bytes());
        let (body, sig) = (self.body, self.signature);
        match wire::manifest(&body[..self.body_len as usize], &sig, &mut self.raw) {
            Some(n) => {
                self.raw_len = n as u8;
                true
            }
            None => false,
        }
    }

    /// Sector 0 of the staging partition: `varint(length) || Manifest`.
    pub fn encode_staged(&self, out: &mut [u8; STAGED_MAX]) -> usize {
        let n = wire::write_varint(self.raw_len as u32, out);
        out[n..n + self.raw_len as usize].copy_from_slice(self.raw());
        n + self.raw_len as usize
    }

    /// Read a manifest back from sector 0. Erased flash (0xFF...), a bad length or a
    /// malformed envelope read as "no manifest".
    pub fn decode_staged(b: &[u8]) -> Option<Manifest> {
        let (len, used) = wire::read_varint(b)?;
        let len = len as usize;
        if len == 0 || len > MAX_ENCODED || b.len() < used + len {
            return None;
        }
        Manifest::decode(&b[used..used + len])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::crypto::signing::p256_public_key;

    const SECRET: [u8; 32] = [7; 32];

    #[test]
    fn signed_manifest_round_trips_and_verifies() {
        let mut m = Manifest::for_image(b"firmware bytes", 3, 0);
        assert!(!m.verify(&p256_public_key(&SECRET)), "unsigned");
        assert!(m.sign(&SECRET));
        let d = Manifest::decode(m.raw()).unwrap();
        assert_eq!(d, m);
        assert_eq!((d.version, d.size, d.flags), (3, 14, 0));
        assert_eq!(d.sha256, crypto::sha256(b"firmware bytes"));
        assert!(d.verify(&p256_public_key(&SECRET)));
        assert!(m.raw().len() <= MAX_ENCODED);
    }

    /// The signature covers the body bytes as transmitted: an envelope whose body is a
    /// non-canonical (but valid) encoding verifies, and is kept byte for byte.
    #[test]
    fn verifies_and_keeps_non_canonical_bodies() {
        let mut m = Manifest::for_image(b"img", 9, 0);
        // The same fields, version written twice (last wins) and a trailing unknown field.
        let mut body = Vec::new();
        body.extend_from_slice(&[0x08, 0x01]); // version 1 (overridden)
        body.extend_from_slice(m.body_bytes());
        body.extend_from_slice(&[0x50, 0x07]); // unknown field 10
        let sig = crypto::signing::p256_sign(&SECRET, &body);
        let mut raw = vec![0x12, 64];
        raw.extend_from_slice(&sig); // signature first
        raw.extend_from_slice(&[0x0a, body.len() as u8]);
        raw.extend_from_slice(&body);
        let d = Manifest::decode(&raw).unwrap();
        assert_eq!(d.raw(), &raw[..]);
        assert_eq!(d.version, 9);
        assert!(d.verify(&p256_public_key(&SECRET)));
        assert!(m.sign(&SECRET));
        assert_ne!(d, m);
    }

    #[test]
    fn tampering_or_wrong_key_fails() {
        let mut m = Manifest::for_image(b"firmware bytes", 3, 0);
        m.sign(&SECRET);
        let pk = p256_public_key(&SECRET);
        // Flip a bit in the transmitted bytes (inside the sha256).
        let mut raw = m.raw().to_vec();
        raw[12] ^= 1;
        assert!(!Manifest::decode(&raw).unwrap().verify(&pk));
        // Version bumped in the body: the signature no longer matches.
        let mut bumped = m.raw().to_vec();
        bumped[3] += 1;
        assert!(!Manifest::decode(&bumped).unwrap().verify(&pk));
        assert!(!m.verify(&p256_public_key(&[8; 32])));
        assert!(Manifest::decode(&m.raw()[..m.raw().len() - 1]).is_none(), "truncated");
        assert!(Manifest::decode(&[]).is_none());
    }

    #[test]
    fn staged_form_is_length_prefixed_and_erased_flash_is_none() {
        let mut m = Manifest::for_image(b"firmware bytes", 3, 0);
        m.sign(&SECRET);
        let mut out = [0xFFu8; STAGED_MAX];
        let n = m.encode_staged(&mut out);
        assert_eq!(out[0] as usize, m.raw().len());
        assert_eq!(n, 1 + m.raw().len());
        assert_eq!(Manifest::decode_staged(&out), Some(m));
        assert_eq!(Manifest::decode_staged(&[0xFF; STAGED_MAX]), None);
        assert_eq!(Manifest::decode_staged(&[0u8; STAGED_MAX]), None);
    }
}
