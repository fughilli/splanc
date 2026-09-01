//! Full WPA2-PSK STA connection flow — composes the MLME (open auth + assoc), the
//! WPA2 supplicant (4-way handshake), and CCMP (data encrypt/decrypt) into one
//! allocation-free state machine. This is what replaces the vendor STA path: hand
//! it received management + EAPOL frames and it drives the association to a keyed,
//! Connected state; then it CCMP-protects the data plane (payloads to/from lwIP).

use crate::ccmp::{ccmp_decap, ccmp_encap, AesUnwrap};
use crate::mlme::{subtype, Mac, StaMlme, StaState};
use crate::rx::Buf;
use crate::wpa::{pmk as derive_pmk, Nonce, Step, Supplicant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Authenticating,
    Associating,
    FourWay,
    Connected,
    Failed,
}

/// What a fed frame produced.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Out {
    None,
    Send(usize),  // a response of this length is in `out`
    Connected,    // handshake done; keys installed
}

pub struct Sta {
    mlme: StaMlme,
    sup: Supplicant,
    ap: Mac,
    self_mac: Mac,
    phase: Phase,
    tx_pn: u64,
    have_keys: bool,
    last_tx: [u8; 128],
    last_tx_len: usize,
}

impl Sta {
    /// Build an STA for `ssid`/`passphrase`, connecting to `ap` as `self_mac`.
    /// `snonce` is this station's nonce for the handshake (from an RNG).
    pub fn new(ssid: &[u8], passphrase: &[u8], ap: Mac, self_mac: Mac, snonce: Nonce) -> Self {
        let pmk = derive_pmk(passphrase, ssid);
        Self::from_pmk(pmk, ap, self_mac, snonce)
    }

    /// Build an STA from an already-derived PMK. The PMK is the expensive part (PBKDF2 c=4096,
    /// ~1.8s); deriving it incrementally off the hot path and passing it here keeps the transport
    /// loop responsive (BLE link alive) through the join. See `wpa::PmkDeriv`.
    pub fn from_pmk(pmk: [u8; 32], ap: Mac, self_mac: Mac, snonce: Nonce) -> Self {
        Sta {
            mlme: StaMlme::new(),
            sup: Supplicant::new(pmk, ap, self_mac, snonce),
            ap,
            self_mac,
            phase: Phase::Idle,
            tx_pn: 1,
            have_keys: false,
            last_tx: [0; 128],
            last_tx_len: 0,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Begin: send the open-auth request.
    pub fn connect(&mut self, out: &mut Buf<256>) -> Out {
        match self.mlme.connect(self.ap, self.self_mac, out) {
            Ok(()) => {
                self.phase = Phase::Authenticating;
                Out::Send(out.len())
            }
            Err(_) => {
                self.phase = Phase::Failed;
                Out::None
            }
        }
    }

    /// Feed a received management frame (auth / assoc-resp / deauth).
    pub fn on_mgmt(&mut self, st: u8, src: Mac, status: u16, out: &mut Buf<256>) -> Out {
        if self.mlme.on_mgmt(st, src, status, self.self_mac, out).is_err() {
            self.phase = Phase::Failed;
            return Out::None;
        }
        match self.mlme.state {
            StaState::Associating => {
                self.phase = Phase::Associating;
                Out::Send(out.len())
            }
            StaState::Associated => {
                // Association complete; await the authenticator's message 1.
                self.phase = Phase::FourWay;
                Out::None
            }
            StaState::Idle if st == subtype::DEAUTH => {
                self.phase = Phase::Idle;
                self.have_keys = false;
                Out::None
            }
            _ => Out::None,
        }
    }

    /// Feed a received EAPOL-Key frame (the 4-way handshake). On completion the
    /// pairwise key is installed and the phase becomes Connected.
    pub fn on_eapol(&mut self, frame: &[u8]) -> Out {
        let mut reply: Buf<128> = Buf::new();
        match self.sup.on_eapol(frame, &AesUnwrap, &mut reply) {
            Step::Send(n) => Out::Send(self.stash(&reply.as_slice()[..n])),
            Step::Installed => {
                self.stash(reply.as_slice()); // M4
                self.have_keys = true;
                self.phase = Phase::Connected;
                Out::Connected
            }
            _ => Out::None,
        }
    }

    /// Diagnostic passthrough: how would the supplicant parse/verify `frame`?
    pub fn diag_eapol(&self, frame: &[u8]) -> u32 {
        self.sup.diag(frame)
    }

    /// The installed pairwise temporal key (CCMP TK), valid once Connected. Used to
    /// program the hardware crypto key slot for HW encrypt/decrypt + auto-ACK.
    pub fn tk(&self) -> [u8; 16] {
        self.sup.ptk().tk
    }

    #[cfg(test)]
    pub fn tk_for_test(&self) -> [u8; 16] {
        self.sup.ptk().tk
    }
    #[cfg(test)]
    pub fn gtk_for_test(&self) -> &[u8] {
        self.sup.gtk()
    }

    // The EAPOL reply is built into a local Buf<128>; hand it back to the caller
    // via `last_tx` so the caller's fixed buffer stays the single source.
    fn stash(&mut self, bytes: &[u8]) -> usize {
        let n = bytes.len().min(self.last_tx.len());
        self.last_tx[..n].copy_from_slice(&bytes[..n]);
        self.last_tx_len = n;
        n
    }

    /// The bytes of the most recent EAPOL/data frame the STA produced.
    pub fn last_tx(&self) -> &[u8] {
        &self.last_tx[..self.last_tx_len]
    }

    /// CCMP-encrypt an outbound data frame (header + payload -> protected MPDU)
    /// with the installed pairwise key, incrementing the TX packet number.
    pub fn encrypt_data(&mut self, hdr: &[u8], payload: &[u8], out: &mut [u8]) -> usize {
        if !self.have_keys {
            return 0;
        }
        let pn = self.tx_pn;
        self.tx_pn += 1;
        let tk = self.sup.ptk().tk;
        ccmp_encap(hdr, &tk, pn, 0, payload, out)
    }

    /// CCMP-verify + decrypt an inbound protected data frame into `out`.
    pub fn decrypt_data(&self, frame: &[u8], out: &mut [u8]) -> Option<usize> {
        if !self.have_keys {
            return None;
        }
        let tk = self.sup.ptk().tk;
        ccmp_decap(frame, &tk, out).map(|(n, _pn)| n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wpa::hmac_sha1;

    const AP: Mac = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5];
    const STA: Mac = [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5];

    // Minimal EAPOL-Key frame builder (matches wpa.rs field offsets).
    fn eapol(key_info: u16, nonce: &[u8; 32], mic: Option<&[u8; 16]>) -> [u8; 99] {
        let mut f = [0u8; 99];
        f[0] = 0x02;
        f[1] = 0x03;
        f[2..4].copy_from_slice(&95u16.to_be_bytes());
        f[4] = 0x02;
        f[5..7].copy_from_slice(&key_info.to_be_bytes());
        f[7..9].copy_from_slice(&16u16.to_be_bytes());
        f[4 + 13..4 + 45].copy_from_slice(nonce);
        if let Some(m) = mic {
            f[4 + 77..4 + 93].copy_from_slice(m);
        }
        f
    }

    #[test]
    fn full_wpa2_sta_connect_then_data() {
        let mut sta = Sta::new(b"testnet", b"password12", AP, STA, [0xc0; 32]);
        let mut out: Buf<256> = Buf::new();
        // auth -> assoc -> associated
        assert!(matches!(sta.connect(&mut out), Out::Send(_)));
        assert_eq!(sta.phase(), Phase::Authenticating);
        sta.on_mgmt(subtype::AUTH, AP, 0, &mut out);
        assert_eq!(sta.phase(), Phase::Associating);
        sta.on_mgmt(subtype::ASSOC_RESP, AP, 0, &mut out);
        assert_eq!(sta.phase(), Phase::FourWay);

        // 4-way: M1 -> M2, M3 -> M4 + Connected.
        let anonce = [0xe0u8; 32];
        let m1 = eapol(0x0080 /*ACK*/, &anonce, None);
        assert!(matches!(sta.on_eapol(&m1), Out::Send(_)));
        // craft M3 with a MIC valid under the derived KCK.
        let kck = sta.sup.ptk().kck;
        let mut m3 = eapol(0x0140 /*MIC|INSTALL*/, &anonce, None);
        let mut mic = [0u8; 20];
        hmac_sha1(&kck, &[&m3[..]], &mut mic);
        m3[4 + 77..4 + 93].copy_from_slice(&mic[..16]);
        assert_eq!(sta.on_eapol(&m3), Out::Connected);
        assert_eq!(sta.phase(), Phase::Connected);

        // data plane: encrypt then decrypt round-trips under the installed TK.
        let mut hdr = [0u8; 24];
        hdr[0] = 0x08;
        hdr[10..16].copy_from_slice(&STA);
        let payload = b"hello over CCMP";
        let mut enc = [0u8; 128];
        let n = sta.encrypt_data(&hdr, payload, &mut enc);
        assert!(n > 24 + 8);
        let mut dec = [0u8; 128];
        let plen = sta.decrypt_data(&enc[..n], &mut dec).unwrap();
        assert_eq!(&dec[..plen], &payload[..]);
    }
}
