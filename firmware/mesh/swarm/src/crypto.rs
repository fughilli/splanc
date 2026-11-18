// Ported from fughilli/indoor_localization swarm/net/src/crypto.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! The crypto this crate needs: SHA-256 (streaming), HMAC-SHA256 and ECDSA
//! P-256 signature verification. Two backends behind one interface:
//!
//! - feature `mbedtls` (firmware): extern C functions implemented in
//!   firmware/mesh/swarm/swarm_crypto.cpp on the firmware's MbedTLS, which
//!   uses the SHA (and on the C6, ECC) accelerator;
//! - otherwise (host tests, host tools): Splanc's dependency-free SHA-256
//!   (//firmware/ota `splanc_ota::sha256`, the digest the OTA signer and tests
//!   already agree with the device on), HMAC built on it here (RFC 2104), and
//!   P-256 from the host-only `p256` crate (@player_crates, the universe the
//!   OTA signer uses), so no crypto crate reaches the firmware graph.
//!
//! Message authentication on the mesh uses 4-byte HMAC tags: 32 bits keeps
//! per-packet overhead small, a forger gets one guess per frame it
//! transmits, and replay counters reject reuse. The HMAC key is provisioned
//! per node over USB and never compiled into images (images travel over the
//! air in the clear). Each use prefixes a domain byte so a tag for one kind
//! of message is never valid for another.

pub const HMAC_KEY_LEN: usize = 32;
pub const TAG_LEN: usize = 4;
/// Uncompressed SEC1 point: 0x04 || x || y.
pub const P256_PUBLIC_KEY_LEN: usize = 65;
/// r || s, big-endian.
pub const P256_SIGNATURE_LEN: usize = 64;

pub const DOMAIN_BUNDLE: u8 = b'B';
pub const DOMAIN_OVERRIDE: u8 = b'O';

/// Longest message a tag covers (domain byte + content): a full swarm bundle body is ~970
/// bytes (firmware/mesh/swarm/docs/swarm-wire.md).
pub const TAG_MSG_MAX: usize = 1024;

#[cfg(feature = "mbedtls")]
mod backend {
    extern "C" {
        fn swarm_crypto_sha256_begin() -> *mut core::ffi::c_void;
        fn swarm_crypto_sha256_update(ctx: *mut core::ffi::c_void, data: *const u8, len: usize);
        /// Writes 32 bytes and frees the context.
        fn swarm_crypto_sha256_finish(ctx: *mut core::ffi::c_void, out: *mut u8);
        fn swarm_crypto_hmac_sha256(key: *const u8, key_len: usize, msg: *const u8, len: usize, out: *mut u8) -> i32;
        /// 0 if `sig` (r||s) is valid for `hash` under `public_key` (SEC1).
        fn swarm_crypto_p256_verify(public_key: *const u8, hash: *const u8, sig: *const u8) -> i32;
    }

    pub struct Sha256(*mut core::ffi::c_void);

    impl Sha256 {
        pub fn new() -> Sha256 {
            Sha256(unsafe { swarm_crypto_sha256_begin() })
        }
        pub fn update(&mut self, data: &[u8]) {
            if !self.0.is_null() {
                unsafe { swarm_crypto_sha256_update(self.0, data.as_ptr(), data.len()) }
            }
        }
        pub fn finish(mut self) -> [u8; 32] {
            let mut out = [0u8; 32];
            if !self.0.is_null() {
                unsafe { swarm_crypto_sha256_finish(self.0, out.as_mut_ptr()) }
                self.0 = core::ptr::null_mut();
            }
            out
        }
    }

    impl Default for Sha256 {
        fn default() -> Sha256 {
            Sha256::new()
        }
    }

    impl Drop for Sha256 {
        fn drop(&mut self) {
            if !self.0.is_null() {
                let mut scratch = [0u8; 32];
                unsafe { swarm_crypto_sha256_finish(self.0, scratch.as_mut_ptr()) }
            }
        }
    }

    pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
        let mut out = [0u8; 32];
        unsafe { swarm_crypto_hmac_sha256(key.as_ptr(), key.len(), msg.as_ptr(), msg.len(), out.as_mut_ptr()) };
        out
    }

    pub fn p256_verify(public_key: &[u8; 65], hash: &[u8; 32], sig: &[u8; 64]) -> bool {
        unsafe { swarm_crypto_p256_verify(public_key.as_ptr(), hash.as_ptr(), sig.as_ptr()) == 0 }
    }
}

#[cfg(not(feature = "mbedtls"))]
mod backend {
    use p256::ecdsa::signature::hazmat::PrehashVerifier;
    use p256::ecdsa::{Signature, VerifyingKey};

    pub use splanc_ota::sha256::Sha256;

    const BLOCK: usize = 64;

    /// HMAC-SHA256 (RFC 2104) over splanc_ota's SHA-256.
    pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
        let mut k = [0u8; BLOCK];
        if key.len() > BLOCK {
            k[..32].copy_from_slice(&splanc_ota::sha256::sha256(key));
        } else {
            k[..key.len()].copy_from_slice(key);
        }
        let mut pad = [0u8; BLOCK];
        for (p, &b) in pad.iter_mut().zip(k.iter()) {
            *p = b ^ 0x36;
        }
        let mut inner = Sha256::new();
        inner.update(&pad);
        inner.update(msg);
        let inner = inner.finish();
        for (p, &b) in pad.iter_mut().zip(k.iter()) {
            *p = b ^ 0x5c;
        }
        let mut outer = Sha256::new();
        outer.update(&pad);
        outer.update(&inner);
        outer.finish()
    }

    pub fn p256_verify(public_key: &[u8; 65], hash: &[u8; 32], sig: &[u8; 64]) -> bool {
        let Ok(vk) = VerifyingKey::from_sec1_bytes(public_key) else { return false };
        let Ok(sig) = Signature::from_slice(sig) else { return false };
        vk.verify_prehash(hash, &sig).is_ok()
    }
}

pub use backend::Sha256;

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(data);
    h.finish()
}

pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    backend::hmac_sha256(key, msg)
}

/// ECDSA P-256 over SHA-256(`msg`).
pub fn p256_verify(public_key: &[u8; P256_PUBLIC_KEY_LEN], msg: &[u8], sig: &[u8; P256_SIGNATURE_LEN]) -> bool {
    backend::p256_verify(public_key, &sha256(msg), sig)
}

/// The 4-byte tag over domain || parts: the bottom (first) 4 bytes of the
/// HMAC. None if the message is longer than TAG_MSG_MAX.
pub fn tag(key: &[u8; HMAC_KEY_LEN], domain: u8, parts: &[&[u8]]) -> Option<[u8; TAG_LEN]> {
    let mut msg = [0u8; TAG_MSG_MAX];
    msg[0] = domain;
    let mut n = 1;
    for p in parts {
        if n + p.len() > TAG_MSG_MAX {
            return None;
        }
        msg[n..n + p.len()].copy_from_slice(p);
        n += p.len();
    }
    let h = hmac_sha256(key, &msg[..n]);
    Some([h[0], h[1], h[2], h[3]])
}

/// Constant-time tag check.
pub fn check_tag(key: &[u8; HMAC_KEY_LEN], domain: u8, parts: &[&[u8]], got: &[u8]) -> bool {
    let Some(want) = tag(key, domain, parts) else { return false };
    if got.len() != TAG_LEN {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..TAG_LEN {
        diff |= want[i] ^ got[i];
    }
    diff == 0
}

/// Host-side signing (tools and tests only).
#[cfg(not(feature = "mbedtls"))]
pub mod signing {
    use p256::ecdsa::signature::hazmat::PrehashSigner;
    use p256::ecdsa::{Signature, SigningKey};

    /// P-256 public key (uncompressed SEC1) for a 32-byte private scalar.
    pub fn p256_public_key(secret: &[u8; 32]) -> [u8; 65] {
        let sk = SigningKey::from_slice(secret).expect("valid P-256 scalar");
        let point = sk.verifying_key().to_encoded_point(false);
        let mut out = [0u8; 65];
        out.copy_from_slice(point.as_bytes());
        out
    }

    /// ECDSA P-256 over SHA-256(`msg`): r || s.
    pub fn p256_sign(secret: &[u8; 32], msg: &[u8]) -> [u8; 64] {
        let sk = SigningKey::from_slice(secret).expect("valid P-256 scalar");
        let sig: Signature = sk.sign_prehash(&super::sha256(msg)).expect("sign");
        let mut out = [0u8; 64];
        out.copy_from_slice(&sig.to_bytes());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 4231 test case 2 (the firmware runs the same vector at boot
    /// against the MbedTLS backend).
    #[test]
    fn hmac_matches_rfc4231_case_2() {
        let h = hmac_sha256(b"Jefe", b"what do ya want for nothing?");
        let want = [
            0x5b, 0xdc, 0xc1, 0x46, 0xbf, 0x60, 0x75, 0x4e, 0x6a, 0x04, 0x24, 0x26, 0x08, 0x95, 0x75, 0xc7,
            0x5a, 0x00, 0x3f, 0x08, 0x9d, 0x27, 0x39, 0x83, 0x9d, 0xec, 0x58, 0xb9, 0x64, 0xec, 0x38, 0x43,
        ];
        assert_eq!(h, want);
    }

    /// RFC 4231 test case 6: a key longer than the block is hashed first (Splanc's host
    /// HMAC is hand-written, so it gets the long-key path checked too).
    #[test]
    fn hmac_matches_rfc4231_case_6() {
        let h = hmac_sha256(&[0xaa; 131], b"Test Using Larger Than Block-Size Key - Hash Key First");
        let want = [
            0x60, 0xe4, 0x31, 0x59, 0x1e, 0xe0, 0xb6, 0x7f, 0x0d, 0x8a, 0x26, 0xaa, 0xcb, 0xf5, 0xb7, 0x7f,
            0x8e, 0x0b, 0xc6, 0x21, 0x37, 0x28, 0xc5, 0x14, 0x05, 0x46, 0x04, 0x0f, 0x0e, 0xe3, 0x7f, 0x54,
        ];
        assert_eq!(h, want);
    }

    #[test]
    fn tags_separate_domains_keys_and_messages() {
        let k = [1u8; HMAC_KEY_LEN];
        let t = tag(&k, DOMAIN_BUNDLE, &[b"x"]).unwrap();
        assert!(check_tag(&k, DOMAIN_BUNDLE, &[b"x"], &t));
        assert!(!check_tag(&k, DOMAIN_OVERRIDE, &[b"x"], &t));
        assert!(!check_tag(&[2u8; HMAC_KEY_LEN], DOMAIN_BUNDLE, &[b"x"], &t));
        assert!(!check_tag(&k, DOMAIN_BUNDLE, &[b"y"], &t));
    }

    /// The known answer the firmware's MbedTLS self-test also checks
    /// (firmware/mesh/swarm/swarm_crypto.cpp), made with Python's cryptography.
    #[test]
    fn p256_verifies_independent_known_answer() {
        let public: [u8; 65] = [
            0x04, 0x1e, 0x18, 0x53, 0x2f, 0xd4, 0x75, 0x4c, 0x02, 0xf3, 0x04, 0x1d, 0x9c, 0x75, 0xce, 0xb3, 0x3b,
            0x83, 0xff, 0xd8, 0x1a, 0xc7, 0xce, 0x4f, 0xe8, 0x82, 0xcc, 0xb1, 0xc9, 0x8b, 0xc5, 0x89, 0x6e, 0xa4,
            0x6c, 0x31, 0x1c, 0x4e, 0x2f, 0xf4, 0x0d, 0xd9, 0x6a, 0x36, 0x53, 0xe6, 0xe4, 0x54, 0x45, 0xd3, 0x2d,
            0xfe, 0x48, 0x6e, 0xce, 0xd7, 0x5c, 0x7a, 0x90, 0xc6, 0xa1, 0x88, 0x81, 0xc0, 0xa3,
        ];
        let sig: [u8; 64] = [
            0xd7, 0xd7, 0x26, 0xa6, 0x21, 0x15, 0x88, 0x7d, 0xf8, 0xe3, 0xf4, 0xbb, 0x45, 0x50, 0xdf, 0x4a,
            0xa6, 0x7b, 0xb4, 0x8b, 0x40, 0x35, 0x5e, 0x8e, 0x07, 0xf3, 0x5a, 0x72, 0x56, 0x66, 0x9d, 0xfa,
            0x01, 0xf8, 0xf3, 0x5e, 0x83, 0x1d, 0x03, 0x4a, 0x85, 0xf1, 0xf5, 0x3a, 0x2d, 0xcc, 0x10, 0x15,
            0xcc, 0x29, 0x12, 0x23, 0x9e, 0x90, 0x88, 0x80, 0x81, 0x8b, 0x12, 0x8f, 0x8e, 0x6a, 0xeb, 0xee,
        ];
        assert_eq!(signing::p256_public_key(&[7u8; 32]), public);
        assert!(p256_verify(&public, b"swarm crypto self-test", &sig));
    }

    #[test]
    fn p256_sign_verify() {
        let secret = [7u8; 32];
        let pk = signing::p256_public_key(&secret);
        let sig = signing::p256_sign(&secret, b"manifest");
        assert!(p256_verify(&pk, b"manifest", &sig));
        assert!(!p256_verify(&pk, b"manifesT", &sig));
        let other = signing::p256_public_key(&[8u8; 32]);
        assert!(!p256_verify(&other, b"manifest", &sig));
    }
}
