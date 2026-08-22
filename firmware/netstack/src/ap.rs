//! WPA2-PSK authenticator — the AP side of the 4-way handshake + the group key,
//! allocation-free. Together with the STA supplicant this is a complete,
//! interoperable WPA2-PSK implementation (the interop test drives a full 4-way
//! between our supplicant and our authenticator). Also builds beacons/probe
//! responses for the AP role.

use crate::ccmp::aes_wrap;
use crate::mlme::Mac;
use crate::rx::{Buf, Overflow};
use crate::wpa::{
    build_eapol_key, derive_ptk, parse_eapol, verify_eapol_mic, Nonce, Ptk, KEY_INFO_ACK,
    KEY_INFO_INSTALL, KEY_INFO_MIC, KEY_INFO_SECURE,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthState {
    Idle,
    SentM1,
    SentM3,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthStep {
    Send(usize),
    Done,
    Ignored,
}

/// AP-side 4-way authenticator for one station.
pub struct Authenticator {
    pmk: [u8; 32],
    aa: Mac,   // AP MAC
    spa: Mac,  // station MAC
    anonce: Nonce,
    gtk: [u8; 16],
    gtk_id: u8,
    ptk: Ptk,
    pub state: AuthState,
}

impl Authenticator {
    pub fn new(pmk: [u8; 32], ap: Mac, sta: Mac, anonce: Nonce, gtk: [u8; 16]) -> Self {
        Authenticator { pmk, aa: ap, spa: sta, anonce, gtk, gtk_id: 1, ptk: Ptk::default(), state: AuthState::Idle }
    }

    pub fn ptk(&self) -> &Ptk {
        &self.ptk
    }

    /// Begin: emit message 1 (ANonce, no MIC).
    pub fn start(&mut self, out: &mut Buf<256>) -> usize {
        let n = build_eapol_key(KEY_INFO_ACK, &self.anonce, &[], None, out).unwrap_or(0);
        self.state = AuthState::SentM1;
        n
    }

    /// GTK KDE (RSN): dd | len | 00-0f-ac-01 | keyid | reserved | GTK. Padded to
    /// an 8-byte multiple so AES key-wrap can encrypt it into message 3.
    fn gtk_kde(&self, out: &mut [u8; 24]) {
        out[0] = 0xdd;
        out[1] = 22; // 000fac01 (4) + keyid (1) + reserved (1) + GTK (16)
        out[2..6].copy_from_slice(&[0x00, 0x0f, 0xac, 0x01]);
        out[6] = self.gtk_id & 0x03;
        out[7] = 0x00;
        out[8..24].copy_from_slice(&self.gtk);
    }

    /// Feed a received EAPOL-Key frame. On M2: derive the PTK, verify its MIC, and
    /// emit M3 with the wrapped GTK. On M4: verify and finish.
    pub fn on_eapol(&mut self, frame: &[u8], out: &mut Buf<256>) -> AuthStep {
        let Some((ki, nonce, _kd)) = parse_eapol(frame) else {
            return AuthStep::Ignored;
        };
        let has_mic = ki & KEY_INFO_MIC != 0;
        let install = ki & KEY_INFO_INSTALL != 0;
        if self.state == AuthState::SentM1 && has_mic && !install {
            // Message 2: SNonce + MIC. Derive the PTK from both nonces, verify.
            let mut snonce = [0u8; 32];
            snonce.copy_from_slice(nonce);
            self.ptk = derive_ptk(&self.pmk, &self.aa, &self.spa, &self.anonce, &snonce);
            if !verify_eapol_mic(&self.ptk.kck, frame) {
                self.state = AuthState::Failed;
                return AuthStep::Ignored;
            }
            // Message 3: MIC + INSTALL + SECURE + ACK, ANonce, wrapped GTK KDE.
            let mut kde = [0u8; 24];
            self.gtk_kde(&mut kde);
            let mut wrapped = [0u8; 32];
            let wl = aes_wrap(&self.ptk.kek, &kde, &mut wrapped);
            let ki3 = KEY_INFO_MIC | KEY_INFO_INSTALL | KEY_INFO_SECURE | KEY_INFO_ACK;
            let anonce = self.anonce;
            return match build_eapol_key(ki3, &anonce, &wrapped[..wl], Some(&self.ptk.kck), out) {
                Ok(n) => {
                    self.state = AuthState::SentM3;
                    AuthStep::Send(n)
                }
                Err(_) => {
                    self.state = AuthState::Failed;
                    AuthStep::Ignored
                }
            };
        }
        if self.state == AuthState::SentM3 && has_mic && ki & KEY_INFO_SECURE != 0 && !install {
            // Message 4: final MIC. Confirm and install.
            if verify_eapol_mic(&self.ptk.kck, frame) {
                self.state = AuthState::Done;
                return AuthStep::Done;
            }
            self.state = AuthState::Failed;
        }
        AuthStep::Ignored
    }
}

/// Build a beacon / probe-response frame body for an open or RSN AP: the 802.11
/// header + fixed params + SSID / rates / DS / TIM + (optional) RSN IE.
pub fn build_beacon(bssid: Mac, ssid: &[u8], channel: u8, rsn: bool, out: &mut Buf<256>) -> Result<usize, Overflow> {
    out.clear();
    out.extend(&[0x80, 0x00, 0x00, 0x00])?; // FC=beacon, duration
    out.extend(&[0xff; 6])?; // DA broadcast
    out.extend(&bssid)?; // SA
    out.extend(&bssid)?; // BSSID
    out.extend(&[0x00, 0x00])?; // seq
    out.extend(&[0u8; 8])?; // timestamp
    out.extend(&[0x64, 0x00])?; // beacon interval
    out.extend(&[if rsn { 0x11 } else { 0x01 }, 0x04])?; // capability (privacy if rsn)
    out.push_ie(0x00, ssid)?; // SSID
    out.push_ie(0x01, &[0x82, 0x84, 0x8b, 0x96, 0x0c, 0x12, 0x18, 0x24])?; // rates
    out.push_ie(0x03, &[channel])?; // DS
    out.push_ie(0x05, &[0x00, 0x01, 0x00, 0x00])?; // TIM
    if rsn {
        // RSN IE: version 1, CCMP group + pairwise, PSK AKM.
        out.push_ie(
            0x30,
            &[
                0x01, 0x00, // version
                0x00, 0x0f, 0xac, 0x04, // group cipher CCMP
                0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, // pairwise CCMP
                0x01, 0x00, 0x00, 0x0f, 0xac, 0x02, // AKM PSK
                0x00, 0x00, // RSN capabilities
            ],
        )?;
    }
    Ok(out.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sta::{Out, Phase, Sta};
    use crate::mlme::subtype;

    const AP: Mac = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5];
    const STA: Mac = [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5];

    #[test]
    fn our_sta_completes_4way_with_our_ap() {
        let ssid = b"testnet";
        let pass = b"password12";
        let pmk = crate::wpa::pmk(pass, ssid);
        let gtk = [0x77u8; 16];
        let mut ap = Authenticator::new(pmk, AP, STA, [0xe0; 32], gtk);
        let mut sta = Sta::new(ssid, pass, AP, STA, [0xc0; 32]);

        // Assume association already done on the STA (drive it there).
        let mut mo: Buf<256> = Buf::new();
        sta.connect(&mut mo);
        sta.on_mgmt(subtype::AUTH, AP, 0, &mut mo);
        sta.on_mgmt(subtype::ASSOC_RESP, AP, 0, &mut mo);
        assert_eq!(sta.phase(), Phase::FourWay);

        // M1: AP -> STA
        let mut m1: Buf<256> = Buf::new();
        ap.start(&mut m1);
        // STA processes M1, emits M2
        assert!(matches!(sta.on_eapol(m1.as_slice()), Out::Send(_)));
        let m2 = sta.last_tx().to_vec();
        // AP processes M2, emits M3 (with wrapped GTK)
        let mut m3: Buf<256> = Buf::new();
        assert!(matches!(ap.on_eapol(&m2, &mut m3), AuthStep::Send(_)));
        // STA processes M3, installs keys, emits M4 -> Connected
        assert_eq!(sta.on_eapol(m3.as_slice()), Out::Connected);
        let m4 = sta.last_tx().to_vec();
        // AP processes M4 -> Done
        let mut junk: Buf<256> = Buf::new();
        assert_eq!(ap.on_eapol(&m4, &mut junk), AuthStep::Done);

        // Both sides derived the SAME PTK, and the STA recovered the AP's GTK.
        assert_eq!(ap.ptk().tk, sta_tk(&sta));
        assert_eq!(sta_gtk(&sta), &gtk[..]);
    }

    // test-only accessors
    fn sta_tk(s: &Sta) -> [u8; 16] {
        s.tk_for_test()
    }
    fn sta_gtk(s: &Sta) -> &[u8] {
        s.gtk_for_test()
    }

    #[test]
    fn beacon_has_rsn_ie() {
        let mut out: Buf<256> = Buf::new();
        build_beacon(AP, b"net", 6, true, &mut out).unwrap();
        // RSN IE (0x30) present.
        assert!(out.as_slice().windows(2).any(|w| w[0] == 0x30 && w[1] == 20));
    }
}
