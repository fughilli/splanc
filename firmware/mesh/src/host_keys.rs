//! Host implementations (tests, `meshsim`, and the app/bridge side): a P-256 device key on
//! the host-only `p256` crate (the one the OTA signer and the swarm's host build use), the
//! admin signer (the app and the bridge hold the admin secret; fixtures never do), and a
//! deterministic random source. Firmware implements [`DeviceKey`] on MbedTLS with the
//! per-device TLS key (M7). A Linux node (a Pi) runs this crate's std build as is; it needs
//! a `DeviceKey` on its own key file and a real `Entropy` (getrandom) instead of these.

use p256::elliptic_curve::sec1::ToEncodedPoint;

use crate::crypto::{DeviceKey, Entropy, PublicKey};

/// A P-256 key pair from a seed (deterministic, for simulation).
pub struct HostKey {
    sk: p256::SecretKey,
    pk: PublicKey,
}

impl HostKey {
    pub fn from_seed(seed: u64) -> HostKey {
        let mut ctr = 0u32;
        loop {
            let mut b = [0u8; 12];
            b[..8].copy_from_slice(&seed.to_be_bytes());
            b[8..].copy_from_slice(&ctr.to_be_bytes());
            if let Ok(sk) = p256::SecretKey::from_slice(&swarm_net::crypto::sha256(&b)) {
                let mut pk = [0u8; 65];
                pk.copy_from_slice(sk.public_key().to_encoded_point(false).as_bytes());
                return HostKey { sk, pk };
            }
            ctr += 1;
        }
    }
}

impl DeviceKey for HostKey {
    fn public_key(&self) -> PublicKey {
        self.pk
    }

    fn ecdh(&self, peer: &PublicKey) -> Option<[u8; 32]> {
        let peer = p256::PublicKey::from_sec1_bytes(peer).ok()?;
        let shared = (peer.to_projective() * *self.sk.to_nonzero_scalar()).to_affine();
        let ep = shared.to_encoded_point(false);
        let mut x = [0u8; 32];
        x.copy_from_slice(ep.x()?);
        Some(x)
    }
}

/// The admin signing key (design §7.9): derived from the admin secret and the mesh id, so any
/// phone or bridge that imported the secret signs with the same key. Members hold only
/// [`AdminSigner::public`].
pub struct AdminSigner {
    secret: [u8; 32],
    public: PublicKey,
}

impl AdminSigner {
    pub fn from_secret(admin_secret: &[u8; 16], mesh_id: u32) -> AdminSigner {
        for ctr in 0u8.. {
            let d = crate::crypto::hkdf32(&mesh_id.to_be_bytes(), admin_secret, &[b"splanc mesh admin sign", &[ctr]]);
            if let Ok(sk) = p256::SecretKey::from_slice(&d) {
                let mut public = [0u8; 65];
                public.copy_from_slice(sk.public_key().to_encoded_point(false).as_bytes());
                return AdminSigner { secret: d, public };
            }
        }
        unreachable!("a valid scalar within 256 tries")
    }

    pub fn public(&self) -> PublicKey {
        self.public
    }

    /// ECDSA P-256 over SHA-256(`msg`).
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        swarm_net::crypto::signing::p256_sign(&self.secret, msg)
    }

    /// A delegation certificate for `key` (this signer as the admin key).
    pub fn delegation(&self, mesh_id: u32, key: PublicKey, not_after: u32) -> crate::admin::Delegation {
        let mut d = crate::admin::Delegation { mesh_id, key, not_after, sig: [0; 64] };
        let mut b = [0u8; 81];
        let m = d.signed(&mut b).to_vec();
        d.sig = self.sign(&m);
        d
    }

    /// A session grant signed by this key as a delegate (it names itself in `by`).
    pub fn delegated_grant(&self, mesh_id: u32, session: u32, gateway: u16, gateway_key: PublicKey, not_after: u32) -> crate::admin::Grant {
        let mut g = self.grant(mesh_id, session, gateway, gateway_key, not_after);
        g.by = Some(crate::crypto::key_hash(&self.public));
        g
    }

    /// A session grant for gateway `gateway` (§7.9).
    pub fn grant(&self, mesh_id: u32, session: u32, gateway: u16, gateway_key: PublicKey, not_after: u32) -> crate::admin::Grant {
        let mut g = crate::admin::Grant { mesh_id, session, gateway, gateway_key, not_after, sig: [0; 64], by: None };
        let mut b = [0u8; 87];
        let m = g.signed(&mut b).to_vec();
        g.sig = self.sign(&m);
        g
    }
}

/// xorshift64*: deterministic randomness for simulations (never for real keys).
pub struct TestRng(pub u64);

impl Entropy for TestRng {
    fn fill(&mut self, out: &mut [u8]) {
        for b in out {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            if self.0 == 0 {
                self.0 = 0x9E37_79B9_7F4A_7C15;
            }
            *b = (self.0.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 56) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecdh_agrees_and_rejects_bad_points() {
        let (a, b) = (HostKey::from_seed(1), HostKey::from_seed(2));
        let ab = a.ecdh(&b.public_key()).unwrap();
        assert_eq!(Some(ab), b.ecdh(&a.public_key()));
        assert_ne!(Some(ab), a.ecdh(&HostKey::from_seed(3).public_key()));
        assert_eq!(a.ecdh(&[4; 65]), None);
        assert_eq!(a.public_key(), HostKey::from_seed(1).public_key());
    }
}
