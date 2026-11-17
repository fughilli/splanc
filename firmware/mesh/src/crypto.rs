//! Crypto helpers for the Splanc mesh layer (design §7): HKDF-SHA256 on the swarm's
//! HMAC-SHA256 (Splanc's SHA-256 on the host, MbedTLS in firmware), a constant-time compare,
//! and the two seams the layer needs from the device: its P-256 key ([`DeviceKey`], for the
//! join's ECDH, §7.3) and a random source ([`Entropy`]).
//!
//! AES-CCM itself is the netstack's (`ledmapper_netstack::ccmp`, the code the STA path's
//! CCMP runs on, on the C6's AES accelerator).

use swarm_net::crypto::{sha256, Sha256};

/// An uncompressed SEC1 P-256 public key (0x04 ‖ X ‖ Y).
pub type PublicKey = [u8; 65];

/// The 8-byte hash of a device's public key that the allow-list (locked mode, §7.2) and the
/// app's device list name a device by: SHA-256(public key)[..8].
pub type KeyHash = [u8; 8];

pub fn key_hash(pk: &PublicKey) -> KeyHash {
    let h = sha256(pk);
    let mut o = [0u8; 8];
    o.copy_from_slice(&h[..8]);
    o
}

/// The device's own P-256 key pair (the per-device TLS key of `docs/design/per-device-cert.md`).
/// Firmware implements it on MbedTLS (M7); the host build has [`crate::host_keys`].
pub trait DeviceKey {
    fn public_key(&self) -> PublicKey;
    /// ECDH with a peer's public key: the shared X coordinate, or None if `peer` is not a
    /// valid point.
    fn ecdh(&self, peer: &PublicKey) -> Option<[u8; 32]>;
}

/// Randomness for keys and nonces (the C6's RNG in firmware).
pub trait Entropy {
    fn fill(&mut self, out: &mut [u8]);

    fn u32(&mut self) -> u32 {
        let mut b = [0u8; 4];
        self.fill(&mut b);
        u32::from_le_bytes(b)
    }
}

/// A pairwise key between this device and a peer (both P-256 device keys): ECDH, then
/// `HKDF(mesh id, "SMpair1" ‖ lower id ‖ higher id)`. Either side derives the same key; no
/// other device can. Admin commands, freshness replies and member reports to a gateway are
/// MAC'd under these, so the shared mesh key never vouches for which device spoke.
pub fn pairwise_key(dev: &dyn DeviceKey, peer: &PublicKey, mesh_id: u32, me: u16, them: u16) -> Option<[u8; 16]> {
    let shared = dev.ecdh(peer)?;
    let (lo, hi) = if me < them { (me, them) } else { (them, me) };
    Some(hkdf16(&mesh_id.to_be_bytes(), &shared, &[b"SMpair1", &lo.to_be_bytes(), &hi.to_be_bytes()]))
}

/// ECDSA P-256 verify over the concatenation of `parts` (≤ 192 bytes), on the swarm's
/// backend (Splanc's host crypto; MbedTLS with the C6/P4 ECC accelerator in firmware).
pub fn p256_verify_parts(public_key: &PublicKey, parts: &[&[u8]], sig: &[u8; 64]) -> bool {
    let mut m = [0u8; 192];
    let mut n = 0;
    for p in parts {
        if n + p.len() > m.len() {
            return false;
        }
        m[n..n + p.len()].copy_from_slice(p);
        n += p.len();
    }
    swarm_net::crypto::p256_verify(public_key, &m[..n], sig)
}

/// HMAC-SHA256 (RFC 2104) over the concatenation of `parts`, streamed (no message buffer:
/// the C6's stack is small).
pub fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        k[..32].copy_from_slice(&sha256(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut pad = [0u8; BLOCK];
    for (p, &b) in pad.iter_mut().zip(k.iter()) {
        *p = b ^ 0x36;
    }
    let mut inner = Sha256::new();
    inner.update(&pad);
    for p in parts {
        inner.update(p);
    }
    let inner = inner.finish();
    for (p, &b) in pad.iter_mut().zip(k.iter()) {
        *p = b ^ 0x5c;
    }
    let mut outer = Sha256::new();
    outer.update(&pad);
    outer.update(&inner);
    outer.finish()
}

/// HKDF-SHA256 (RFC 5869): extract with `salt`, expand with the concatenated `info` parts
/// into `out` (at most 64 bytes, all this layer needs). Returns false (and leaves `out`
/// zeroed) if `out` is too long or `info` has more than 8 parts.
pub fn hkdf(salt: &[u8], ikm: &[u8], info: &[&[u8]], out: &mut [u8]) -> bool {
    out.fill(0);
    if out.len() > 64 || info.len() > 8 {
        return false;
    }
    let prk = hmac(salt, &[ikm]);
    // T(i) = HMAC(PRK, T(i-1) ‖ info ‖ i)
    let mut prev = [0u8; 32];
    let mut prev_len = 0usize;
    let mut done = 0usize;
    let mut i = 1u8;
    while done < out.len() {
        let mut parts: [&[u8]; 10] = [&[]; 10];
        parts[0] = &prev[..prev_len];
        let n = info.len();
        parts[1..1 + n].copy_from_slice(&info[..n]);
        let ctr = [i];
        parts[1 + n] = &ctr;
        let t = hmac(&prk, &parts[..2 + n]);
        let take = (out.len() - done).min(32);
        out[done..done + take].copy_from_slice(&t[..take]);
        done += take;
        prev = t;
        prev_len = 32;
        i += 1;
    }
    true
}

/// A 16-byte key from [`hkdf`].
pub fn hkdf16(salt: &[u8], ikm: &[u8], info: &[&[u8]]) -> [u8; 16] {
    let mut k = [0u8; 16];
    hkdf(salt, ikm, info, &mut k);
    k
}

/// A 32-byte key from [`hkdf`].
pub fn hkdf32(salt: &[u8], ikm: &[u8], info: &[&[u8]]) -> [u8; 32] {
    let mut k = [0u8; 32];
    hkdf(salt, ikm, info, &mut k);
    k
}

/// Constant-time equality (no early exit; lengths are not secret).
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut d = 0u8;
    for (x, y) in a.iter().zip(b) {
        d |= x ^ y;
    }
    // Keep the compiler from short-circuiting on d.
    core::hint::black_box(d) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap()).collect()
    }

    /// RFC 5869 test cases 1 and 3 (SHA-256).
    #[test]
    fn hkdf_rfc5869() {
        let ikm = [0x0bu8; 22];
        let salt = hex("000102030405060708090a0b0c");
        let info = hex("f0f1f2f3f4f5f6f7f8f9");
        let mut okm = [0u8; 42];
        // Split info across parts: the concatenation is what counts.
        assert!(hkdf(&salt, &ikm, &[&info[..3], &info[3..]], &mut okm));
        assert_eq!(
            okm.to_vec(),
            hex("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
        );
        let mut okm = [0u8; 42];
        assert!(hkdf(&[], &ikm, &[], &mut okm));
        assert_eq!(
            okm.to_vec(),
            hex("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
        );
    }

    #[test]
    fn hkdf_refuses_oversize() {
        let mut out = [1u8; 65];
        assert!(!hkdf(b"s", b"k", &[], &mut out));
        assert_eq!(out, [0; 65]);
    }

    /// RFC 4231 test case 2, split into parts.
    #[test]
    fn hmac_rfc4231() {
        let h = hmac(b"Jefe", &[b"what do ya want ", b"for nothing?"]);
        assert_eq!(h.to_vec(), hex("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"));
        assert_eq!(h, swarm_net::crypto::hmac_sha256(b"Jefe", b"what do ya want for nothing?"));
    }

    #[test]
    fn ct_eq_works() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }
}
