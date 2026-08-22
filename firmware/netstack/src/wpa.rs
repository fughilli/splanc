//! WPA2-PSK (RSN) supplicant — the 802.11 4-way handshake and key hierarchy,
//! allocation-free. Replaces the vendor supplicant's role for STA association:
//! derive the PMK from the passphrase, run the 4-way handshake against the AP's
//! authenticator, and produce the pairwise (PTK) and group (GTK) keys the CCMP
//! layer installs.
//!
//! The crypto is self-contained and small (HMAC-SHA1 / PBKDF2 / the WPA PRF are
//! the only primitives the handshake itself needs), and validated against the
//! official FIPS-180 / RFC-2202 / RFC-6070 / 802.11i vectors in the tests. AES
//! (for the encrypted-GTK KDE in message 3) is provided by [`ccmp`](crate::ccmp)
//! via the [`KeyUnwrap`] hook, keeping this module free of a block cipher.

use crate::rx::{Buf, Overflow};

pub type Nonce = [u8; 32];

/// Pairwise Transient Key, split into its confirmation / encryption / temporal
/// parts (CCMP uses a 128-bit TK).
#[derive(Clone, Copy, Default)]
pub struct Ptk {
    pub kck: [u8; 16], // EAPOL-Key MIC key
    pub kek: [u8; 16], // EAPOL-Key encryption key (unwraps the GTK)
    pub tk: [u8; 16],  // CCMP temporal key
}

/// AES key unwrap (RFC 3394), used to decrypt the GTK KDE in message 3. Provided
/// by the caller (the `ccmp` AES) so this module carries no block cipher.
pub trait KeyUnwrap {
    /// Unwrap `wrapped` (n+1 64-bit blocks) with `kek` into `out`; returns the
    /// plaintext length, or `Err` on integrity failure.
    fn aes_unwrap(&self, kek: &[u8; 16], wrapped: &[u8], out: &mut [u8]) -> Result<usize, ()>;
}

// --- SHA-1 (FIPS 180) --------------------------------------------------------

struct Sha1 {
    h: [u32; 5],
    len: u64,
    block: [u8; 64],
    n: usize,
}

impl Sha1 {
    fn new() -> Self {
        Sha1 { h: [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0], len: 0, block: [0; 64], n: 0 }
    }
    fn update(&mut self, mut data: &[u8]) {
        self.len += data.len() as u64;
        while !data.is_empty() {
            let take = core::cmp::min(64 - self.n, data.len());
            self.block[self.n..self.n + take].copy_from_slice(&data[..take]);
            self.n += take;
            data = &data[take..];
            if self.n == 64 {
                self.process();
                self.n = 0;
            }
        }
    }
    fn process(&mut self) {
        let mut w = [0u32; 80];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([self.block[i * 4], self.block[i * 4 + 1], self.block[i * 4 + 2], self.block[i * 4 + 3]]);
        }
        for i in 16..80 {
            w[i] = (w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]).rotate_left(1);
        }
        let (mut a, mut b, mut c, mut d, mut e) = (self.h[0], self.h[1], self.h[2], self.h[3], self.h[4]);
        for i in 0..80 {
            let (f, k) = match i {
                0..=19 => ((b & c) | ((!b) & d), 0x5A827999u32),
                20..=39 => (b ^ c ^ d, 0x6ED9EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1BBCDC),
                _ => (b ^ c ^ d, 0xCA62C1D6),
            };
            let t = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(w[i]);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = t;
        }
        self.h[0] = self.h[0].wrapping_add(a);
        self.h[1] = self.h[1].wrapping_add(b);
        self.h[2] = self.h[2].wrapping_add(c);
        self.h[3] = self.h[3].wrapping_add(d);
        self.h[4] = self.h[4].wrapping_add(e);
    }
    fn finish(mut self) -> [u8; 20] {
        let bits = self.len * 8;
        self.update(&[0x80]);
        while self.n != 56 {
            self.update(&[0]);
        }
        self.update(&bits.to_be_bytes());
        let mut out = [0u8; 20];
        for i in 0..5 {
            out[i * 4..i * 4 + 4].copy_from_slice(&self.h[i].to_be_bytes());
        }
        out
    }
}

pub fn sha1(data: &[u8]) -> [u8; 20] {
    let mut h = Sha1::new();
    h.update(data);
    h.finish()
}

/// HMAC-SHA1 over up to two data chunks (avoids concatenation buffers).
pub fn hmac_sha1(key: &[u8], data: &[&[u8]], out: &mut [u8; 20]) {
    let mut k0 = [0u8; 64];
    if key.len() > 64 {
        k0[..20].copy_from_slice(&sha1(key));
    } else {
        k0[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; 64];
    let mut opad = [0x5cu8; 64];
    for i in 0..64 {
        ipad[i] ^= k0[i];
        opad[i] ^= k0[i];
    }
    let mut inner = Sha1::new();
    inner.update(&ipad);
    for d in data {
        inner.update(d);
    }
    let ih = inner.finish();
    let mut outer = Sha1::new();
    outer.update(&opad);
    outer.update(&ih);
    *out = outer.finish();
}

/// PBKDF2-HMAC-SHA1 (RFC 2898) — WPA2 uses c=4096, dkLen=32 for the PMK.
pub fn pbkdf2_sha1(pass: &[u8], salt: &[u8], iters: u32, out: &mut [u8]) {
    let mut block = 1u32;
    let mut off = 0;
    while off < out.len() {
        let mut u = [0u8; 20];
        hmac_sha1(pass, &[salt, &block.to_be_bytes()], &mut u);
        let mut t = u;
        for _ in 1..iters {
            let mut next = [0u8; 20];
            hmac_sha1(pass, &[&u], &mut next);
            u = next;
            for i in 0..20 {
                t[i] ^= u[i];
            }
        }
        let take = core::cmp::min(20, out.len() - off);
        out[off..off + take].copy_from_slice(&t[..take]);
        off += take;
        block += 1;
    }
}

/// The WPA PRF (802.11i): expand `key` over `label || 0x00 || data || counter`
/// to `out.len()` bytes via HMAC-SHA1.
fn prf(key: &[u8], label: &[u8], data: &[u8], out: &mut [u8]) {
    let mut off = 0u8;
    let mut pos = 0;
    while pos < out.len() {
        let mut digest = [0u8; 20];
        hmac_sha1(key, &[label, &[0x00], data, &[off]], &mut digest);
        let take = core::cmp::min(20, out.len() - pos);
        out[pos..pos + take].copy_from_slice(&digest[..take]);
        pos += take;
        off += 1;
    }
}

/// PMK = PBKDF2(passphrase, ssid, 4096, 32).
pub fn pmk(passphrase: &[u8], ssid: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 32];
    pbkdf2_sha1(passphrase, ssid, 4096, &mut k);
    k
}

/// Derive the PTK from the PMK and the two nonces + MAC addresses (802.11i
/// "Pairwise key expansion"): data = min(AA,SA)||max(AA,SA)||min(N)||max(N).
pub fn derive_ptk(pmk: &[u8; 32], aa: &[u8; 6], sa: &[u8; 6], anonce: &Nonce, snonce: &Nonce) -> Ptk {
    let mut data = [0u8; 76];
    let (lo_mac, hi_mac) = if aa <= sa { (aa, sa) } else { (sa, aa) };
    data[0..6].copy_from_slice(lo_mac);
    data[6..12].copy_from_slice(hi_mac);
    let (lo_n, hi_n) = if anonce <= snonce { (anonce, snonce) } else { (snonce, anonce) };
    data[12..44].copy_from_slice(lo_n);
    data[44..76].copy_from_slice(hi_n);
    let mut out = [0u8; 48];
    prf(pmk, b"Pairwise key expansion", &data, &mut out);
    let mut ptk = Ptk::default();
    ptk.kck.copy_from_slice(&out[0..16]);
    ptk.kek.copy_from_slice(&out[16..32]);
    ptk.tk.copy_from_slice(&out[32..48]);
    ptk
}

// --- EAPOL-Key framing + 4-way state machine ---------------------------------

const EAPOL_HDR: usize = 4; // version, type, length[2]
pub const KEY_INFO_MIC: u16 = 0x0100;
pub const KEY_INFO_ACK: u16 = 0x0080;
pub const KEY_INFO_INSTALL: u16 = 0x0040;
pub const KEY_INFO_SECURE: u16 = 0x0200;

/// Parsed EAPOL-Key frame (fields borrow the input; no copy).
struct EapolKey<'a> {
    key_info: u16,
    nonce: &'a [u8],    // 32
    mic: &'a [u8],      // 16
    key_data: &'a [u8], // encrypted GTK KDE (msg3) or empty
}

impl<'a> EapolKey<'a> {
    /// EAPOL header (4) + Key descriptor. Offsets per 802.1X/802.11i.
    fn parse(f: &'a [u8]) -> Option<EapolKey<'a>> {
        if f.len() < EAPOL_HDR + 95 {
            return None;
        }
        let d = &f[EAPOL_HDR..]; // key descriptor
        let key_info = u16::from_be_bytes([d[1], d[2]]);
        let nonce = &d[13..45];
        let mic = &d[77..93];
        let kd_len = u16::from_be_bytes([d[93], d[94]]) as usize;
        let key_data = d.get(95..95 + kd_len)?;
        Some(EapolKey { key_info, nonce, mic, key_data })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HsState {
    Idle,
    PtkStart,  // got M1, sent M2
    Done,      // got M3, sent M4, keys installed
    Failed,
}

/// Outcome of feeding one EAPOL frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    NeedMore,       // nothing to send yet
    Send(usize),    // wrote a response of this length into `out`
    Installed,      // handshake complete; ptk()/gtk() are valid
    Ignored,
}

/// WPA2-PSK supplicant instance (one association).
pub struct Supplicant {
    pub state: HsState,
    pmk: [u8; 32],
    aa: [u8; 6],
    sa: [u8; 6],
    snonce: Nonce,
    ptk: Ptk,
    gtk: [u8; 32],
    gtk_len: usize,
}

impl Supplicant {
    pub fn new(pmk: [u8; 32], ap: [u8; 6], sta: [u8; 6], snonce: Nonce) -> Self {
        Supplicant {
            state: HsState::Idle,
            pmk,
            aa: ap,
            sa: sta,
            snonce,
            ptk: Ptk::default(),
            gtk: [0; 32],
            gtk_len: 0,
        }
    }

    pub fn ptk(&self) -> &Ptk {
        &self.ptk
    }
    pub fn gtk(&self) -> &[u8] {
        &self.gtk[..self.gtk_len]
    }

    /// Feed a received EAPOL-Key frame. On M1 derives the PTK and emits M2; on M3
    /// verifies the MIC, unwraps the GTK, and emits M4.
    pub fn on_eapol<U: KeyUnwrap>(&mut self, frame: &[u8], unwrap: &U, out: &mut Buf<128>) -> Step {
        let Some(k) = EapolKey::parse(frame) else {
            return Step::Ignored;
        };
        let has_mic = k.key_info & KEY_INFO_MIC != 0;
        let ver = k.key_info & 0x0007; // key-descriptor version to echo
        if !has_mic && k.key_info & KEY_INFO_ACK != 0 {
            // Message 1: ANonce, no MIC. Derive the PTK and emit M2.
            let mut anonce = [0u8; 32];
            anonce.copy_from_slice(k.nonce);
            self.ptk = derive_ptk(&self.pmk, &self.aa, &self.sa, &anonce, &self.snonce);
            self.state = HsState::PtkStart;
            let snonce = self.snonce;
            return match self.build_reply(KEY_INFO_MIC | ver, &snonce, out) {
                Ok(n) => Step::Send(n),
                Err(_) => {
                    self.state = HsState::Failed;
                    Step::Ignored
                }
            };
        }
        if has_mic && k.key_info & KEY_INFO_INSTALL != 0 {
            // Message 3: verify MIC over the frame, then unwrap the GTK KDE.
            if !self.verify_mic(frame) {
                self.state = HsState::Failed;
                return Step::Ignored;
            }
            let mut gtk_buf = [0u8; 40];
            if let Ok(n) = unwrap.aes_unwrap(&self.ptk.kek, k.key_data, &mut gtk_buf) {
                // GTK KDE begins with an 8-byte KDE header before the key bytes.
                let gtk = if n > 8 { &gtk_buf[8..n] } else { &gtk_buf[..n] };
                self.gtk_len = core::cmp::min(gtk.len(), 32);
                self.gtk[..self.gtk_len].copy_from_slice(&gtk[..self.gtk_len]);
            }
            let empty = [0u8; 32]; // M4 carries no nonce
            return match self.build_reply(KEY_INFO_MIC | KEY_INFO_SECURE | ver, &empty, out) {
                Ok(_n) => {
                    self.state = HsState::Done;
                    Step::Installed
                }
                Err(_) => {
                    self.state = HsState::Failed;
                    Step::Ignored
                }
            };
        }
        Step::Ignored
    }

    fn build_reply(&self, key_info: u16, nonce: &Nonce, out: &mut Buf<128>) -> Result<usize, Overflow> {
        build_eapol_key(key_info, nonce, &[], Some(&self.ptk.kck), out)
    }

    fn verify_mic(&self, frame: &[u8]) -> bool {
        verify_eapol_mic(&self.ptk.kck, frame)
    }
}

// --- shared EAPOL-Key framing (used by both supplicant and authenticator) -----

/// Build an EAPOL-Key frame (any of M1..M4): the 802.1X descriptor with the given
/// key info, nonce, and (optional) key data, then — if `kck` is given — the
/// HMAC-SHA1-128 MIC over the whole frame with the MIC field zeroed.
pub fn build_eapol_key<const N: usize>(
    key_info: u16,
    nonce: &Nonce,
    key_data: &[u8],
    kck: Option<&[u8; 16]>,
    out: &mut Buf<N>,
) -> Result<usize, Overflow> {
    out.clear();
    out.extend(&[0x02, 0x03])?; // EAPOL version 2, type Key
    let body_len = (95 + key_data.len()) as u16;
    out.extend(&body_len.to_be_bytes())?;
    out.extend(&[0x02])?; // descriptor type: RSN
    out.extend(&key_info.to_be_bytes())?;
    out.extend(&[0x00, 0x10])?; // key length 16
    out.extend(&[0u8; 8])?; // replay counter
    out.extend(nonce)?; // 32
    out.extend(&[0u8; 16])?; // EAPOL key IV
    out.extend(&[0u8; 8])?; // key RSC
    out.extend(&[0u8; 8])?; // reserved
    let mic_pos = out.len(); // = EAPOL_HDR + 77
    out.extend(&[0u8; 16])?; // MIC (filled below)
    out.extend(&(key_data.len() as u16).to_be_bytes())?;
    out.extend(key_data)?;
    if let Some(k) = kck {
        let mut mic = [0u8; 20];
        hmac_sha1(k, &[out.as_slice()], &mut mic);
        out.as_mut_slice()[mic_pos..mic_pos + 16].copy_from_slice(&mic[..16]);
    }
    Ok(out.len())
}

/// Verify the MIC of a received EAPOL-Key frame under `kck`.
pub fn verify_eapol_mic(kck: &[u8; 16], frame: &[u8]) -> bool {
    if frame.len() < EAPOL_HDR + 93 || frame.len() > 256 {
        return false;
    }
    let mic_pos = EAPOL_HDR + 77;
    let mut tmp = [0u8; 256];
    tmp[..frame.len()].copy_from_slice(frame);
    for b in &mut tmp[mic_pos..mic_pos + 16] {
        *b = 0;
    }
    let mut mac = [0u8; 20];
    hmac_sha1(kck, &[&tmp[..frame.len()]], &mut mac);
    mac[..16] == frame[mic_pos..mic_pos + 16]
}

/// Parse the fields of an EAPOL-Key frame: (key_info, nonce, key_data).
pub fn parse_eapol(frame: &[u8]) -> Option<(u16, &[u8], &[u8])> {
    let k = EapolKey::parse(frame)?;
    Some((k.key_info, k.nonce, k.key_data))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> [u8; 32] {
        let mut o = [0u8; 32];
        let b = s.as_bytes();
        for i in 0..s.len() / 2 {
            let h = |c: u8| (c as char).to_digit(16).unwrap() as u8;
            o[i] = (h(b[i * 2]) << 4) | h(b[i * 2 + 1]);
        }
        o
    }

    #[test]
    fn sha1_fips_vector() {
        // FIPS 180: SHA1("abc")
        assert_eq!(&sha1(b"abc"), &hex("a9993e364706816aba3e25717850c26c9cd0d89d")[..20]);
    }

    #[test]
    fn hmac_sha1_rfc2202() {
        // RFC 2202 test case 2: key="Jefe", data="what do ya want for nothing?"
        let mut out = [0u8; 20];
        hmac_sha1(b"Jefe", &[b"what do ya want for nothing?"], &mut out);
        assert_eq!(&out, &hex("effcdf6ae5eb2fa2d27416d5f184df9c259a7c79")[..20]);
    }

    #[test]
    fn pbkdf2_rfc6070() {
        // RFC 6070: P="password", S="salt", c=1, dkLen=20
        let mut out = [0u8; 20];
        pbkdf2_sha1(b"password", b"salt", 1, &mut out);
        assert_eq!(&out, &hex("0c60c80f961f0e71f3a9b524af6012062fe037a6")[..20]);
    }

    #[test]
    fn wpa2_pmk_documented_vector() {
        // 802.11i / wpa_passphrase: passphrase="password", ssid="IEEE"
        let k = pmk(b"password", b"IEEE");
        assert_eq!(&k, &hex("f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e"));
    }

    struct NoUnwrap;
    impl KeyUnwrap for NoUnwrap {
        fn aes_unwrap(&self, _k: &[u8; 16], w: &[u8], out: &mut [u8]) -> Result<usize, ()> {
            let n = w.len().min(out.len());
            out[..n].copy_from_slice(&w[..n]);
            Ok(n)
        }
    }

    // Build a minimal EAPOL-Key frame for the test handshake.
    fn eapol(key_info: u16, nonce: &[u8; 32], mic: Option<&[u8; 16]>) -> [u8; 99] {
        let mut f = [0u8; 99];
        f[0] = 0x02;
        f[1] = 0x03;
        f[2..4].copy_from_slice(&95u16.to_be_bytes());
        f[4] = 0x02; // RSN
        f[5..7].copy_from_slice(&key_info.to_be_bytes());
        f[7..9].copy_from_slice(&16u16.to_be_bytes());
        f[4 + 13..4 + 45].copy_from_slice(nonce); // nonce at descriptor+13
        if let Some(m) = mic {
            f[4 + 77..4 + 93].copy_from_slice(m);
        }
        f
    }

    #[test]
    fn four_way_reaches_installed() {
        let pmk = [0x11u8; 32];
        let ap = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5];
        let sta = [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5];
        let snonce = [0xc0u8; 32];
        let anonce = [0xe0u8; 32];
        let mut sup = Supplicant::new(pmk, ap, sta, snonce);

        // M1: ANonce, ACK, no MIC.
        let m1 = eapol(KEY_INFO_ACK, &anonce, None);
        let mut out: Buf<128> = Buf::new();
        assert!(matches!(sup.on_eapol(&m1, &NoUnwrap, &mut out), Step::Send(_)));
        assert_eq!(sup.state, HsState::PtkStart);
        // PTK was derived; KCK is non-zero.
        assert_ne!(sup.ptk().kck, [0u8; 16]);

        // M3: MIC + INSTALL. Compute a valid MIC with the derived KCK so verify passes.
        let mut m3 = eapol(KEY_INFO_MIC | KEY_INFO_INSTALL, &anonce, None);
        let mut mic = [0u8; 20];
        hmac_sha1(&sup.ptk().kck, &[&m3[..]], &mut mic); // MIC field is already zero
        m3[4 + 77..4 + 93].copy_from_slice(&mic[..16]);
        let mut out2: Buf<128> = Buf::new();
        let step = sup.on_eapol(&m3, &NoUnwrap, &mut out2);
        assert!(matches!(step, Step::Installed));
        assert_eq!(sup.state, HsState::Done);
    }
}
