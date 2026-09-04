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

/// Incremental PMK derivation. The PMK is PBKDF2-HMAC-SHA1 with c=4096 — ~8192 HMAC-SHA1s,
/// ~1.8s of pure compute on the C6. Done synchronously it FREEZES the single-core transport
/// loop for that whole time, starving the BLE link (its supervision timer expires and a
/// provisioner drops the link mid-join). This spreads the work across many `step()` calls so
/// the caller can service BLE/coex/RX between chunks; the result is bit-identical to `pmk()`.
pub struct PmkDeriv {
    pass: [u8; 64],
    pass_len: usize,
    salt: [u8; 32], // ssid
    salt_len: usize,
    out: [u8; 32],
    block: u32,  // 1-based PBKDF2 block index (dkLen 32 / 20 => 2 blocks)
    u: [u8; 20],  // current U_j
    t: [u8; 20],  // running XOR accumulator T for this block
    iter: u32,    // HMACs done in this block so far (1..=4096)
    off: usize,   // output bytes filled
    done: bool,
}

impl PmkDeriv {
    pub fn new(passphrase: &[u8], ssid: &[u8]) -> Self {
        let mut s = PmkDeriv {
            pass: [0; 64], pass_len: passphrase.len().min(64),
            salt: [0; 32], salt_len: ssid.len().min(32),
            out: [0; 32], block: 1, u: [0; 20], t: [0; 20], iter: 0, off: 0, done: false,
        };
        s.pass[..s.pass_len].copy_from_slice(&passphrase[..s.pass_len]);
        s.salt[..s.salt_len].copy_from_slice(&ssid[..s.salt_len]);
        s.start_block();
        s
    }

    // U1 = HMAC(pass, salt || INT(block)); T = U1; iter = 1.
    fn start_block(&mut self) {
        let mut u = [0u8; 20];
        hmac_sha1(&self.pass[..self.pass_len],
                  &[&self.salt[..self.salt_len], &self.block.to_be_bytes()], &mut u);
        self.u = u;
        self.t = u;
        self.iter = 1;
    }

    /// Perform up to `chunk` HMAC-SHA1 iterations. Returns true once the full 32-byte PMK is ready.
    pub fn step(&mut self, chunk: u32) -> bool {
        if self.done {
            return true;
        }
        let mut budget = chunk;
        while budget > 0 {
            if self.iter >= 4096 {
                // Block complete: fold T into the output, advance to the next block (or finish).
                let take = core::cmp::min(20, self.out.len() - self.off);
                self.out[self.off..self.off + take].copy_from_slice(&self.t[..take]);
                self.off += take;
                if self.off >= self.out.len() {
                    self.done = true;
                    return true;
                }
                self.block += 1;
                self.start_block(); // does U1 for the new block (one HMAC)
                budget -= 1;
                continue;
            }
            let mut next = [0u8; 20];
            hmac_sha1(&self.pass[..self.pass_len], &[&self.u], &mut next);
            self.u = next;
            for i in 0..20 {
                self.t[i] ^= self.u[i];
            }
            self.iter += 1;
            budget -= 1;
        }
        false
    }

    pub fn pmk(&self) -> [u8; 32] {
        self.out
    }
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
pub const KEY_INFO_KEY_TYPE: u16 = 0x0008; // 1 = pairwise key

/// The STA's RSN IE, echoed in EAPOL M2's key data (must match the association
/// request exactly or the authenticator rejects M2): WPA2-PSK, group CCMP, pairwise
/// CCMP, AKM PSK. The group cipher (00-0f-ac-04) MUST equal the one in the
/// Association Request (build_assoc in netstack_transport.cpp) and be one this
/// CCMP-only stack implements; it was 00-0f-ac-02 (TKIP), which — once the assoc
/// request was corrected to CCMP — no longer matched, so the authenticator rejected
/// M2 and the 4-way handshake timed out (deauth reason 15).
pub const STA_RSN_IE: [u8; 22] = [
    0x30, 0x14, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x04, 0x01, 0x00,
    0x00, 0x0f, 0xac, 0x02, 0x00, 0x00,
];

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
    replay: [u8; 8], // last received replay counter, echoed in our reply
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
            replay: [0; 8],
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
        // Echo the peer's replay counter in our reply (real authenticators require
        // M2/M4 to carry M1/M3's replay counter). It sits at descriptor offset 5..13.
        self.replay.copy_from_slice(&frame[EAPOL_HDR + 5..EAPOL_HDR + 13]);
        let has_mic = k.key_info & KEY_INFO_MIC != 0;
        let ver = k.key_info & 0x0007; // key-descriptor version to echo
        if !has_mic && k.key_info & KEY_INFO_ACK != 0 {
            // Message 1: ANonce, no MIC. Derive the PTK and emit M2 (carries the
            // pairwise key type + the STA's RSN IE in the key data).
            let mut anonce = [0u8; 32];
            anonce.copy_from_slice(k.nonce);
            self.ptk = derive_ptk(&self.pmk, &self.aa, &self.sa, &anonce, &self.snonce);
            self.state = HsState::PtkStart;
            let snonce = self.snonce;
            return match self.build_reply(
                KEY_INFO_KEY_TYPE | KEY_INFO_MIC | ver,
                &snonce,
                &STA_RSN_IE,
                out,
            ) {
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
            // Real M3 key data holds several wrapped KDEs (GTK + IGTK + padding), not
            // just one — so decrypt into a full-size buffer and walk the KDE list for
            // the GTK KDE (OUI 00-0f-ac, data type 1) rather than assuming a lone KDE.
            let mut kd_buf = [0u8; 128];
            if let Ok(n) = unwrap.aes_unwrap(&self.ptk.kek, k.key_data, &mut kd_buf) {
                if let Some(gtk) = find_gtk_kde(&kd_buf[..n]) {
                    self.gtk_len = core::cmp::min(gtk.len(), 32);
                    self.gtk[..self.gtk_len].copy_from_slice(&gtk[..self.gtk_len]);
                }
            }
            let empty = [0u8; 32]; // M4 carries no nonce and no key data
            return match self.build_reply(
                KEY_INFO_KEY_TYPE | KEY_INFO_MIC | KEY_INFO_SECURE | ver,
                &empty,
                &[],
                out,
            ) {
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
        if has_mic
            && k.key_info & KEY_INFO_ACK != 0
            && k.key_info & KEY_INFO_INSTALL == 0
            && k.key_info & KEY_INFO_KEY_TYPE == 0
            && self.state == HsState::Done
        {
            // Group Key rekey, message 1 (authenticator -> STA): a 2-way handshake the AP
            // runs periodically to roll the group (broadcast/multicast) key. It carries
            // MIC + ACK + Secure with the GROUP key type (KEY_TYPE bit clear) and no
            // Install bit, and its key data is a fresh encrypted GTK KDE. If we never
            // answer it, the authenticator times out the Group Key Handshake and DEAUTHs
            // us (reason 16) — which stranded the link mid-session. Verify the MIC (KCK),
            // unwrap + install the new GTK (so we can still decrypt group traffic), and
            // reply with Group message 2 (Secure + MIC, group key type, no key data).
            if !self.verify_mic(frame) {
                return Step::Ignored; // a bad group msg must not fail the whole supplicant
            }
            let mut kd_buf = [0u8; 128];
            if let Ok(n) = unwrap.aes_unwrap(&self.ptk.kek, k.key_data, &mut kd_buf) {
                if let Some(gtk) = find_gtk_kde(&kd_buf[..n]) {
                    self.gtk_len = core::cmp::min(gtk.len(), 32);
                    self.gtk[..self.gtk_len].copy_from_slice(&gtk[..self.gtk_len]);
                }
            }
            let empty = [0u8; 32]; // group M2 carries no nonce and no key data
            return match self.build_reply(KEY_INFO_MIC | KEY_INFO_SECURE | ver, &empty, &[], out) {
                Ok(n) => Step::Send(n), // just send the ACK; the 4-way state stays Done
                Err(_) => Step::Ignored,
            };
        }
        Step::Ignored
    }

    /// Diagnostic: report, without mutating state, how this frame parses under the
    /// current PTK. bits: 0=parse_ok 1=has_mic 2=install 3=ack 4=secure 5=mic_ok,
    /// 8..16 = parsed key_info.
    pub fn diag(&self, frame: &[u8]) -> u32 {
        let Some(k) = EapolKey::parse(frame) else {
            return 0;
        };
        let mut r = 1u32 | ((k.key_info as u32) << 8);
        if k.key_info & KEY_INFO_MIC != 0 {
            r |= 2;
        }
        if k.key_info & KEY_INFO_INSTALL != 0 {
            r |= 4;
        }
        if k.key_info & KEY_INFO_ACK != 0 {
            r |= 8;
        }
        if k.key_info & KEY_INFO_SECURE != 0 {
            r |= 16;
        }
        if verify_eapol_mic(&self.ptk.kck, frame) {
            r |= 32;
        }
        r
    }

    fn build_reply(
        &self,
        key_info: u16,
        nonce: &Nonce,
        key_data: &[u8],
        out: &mut Buf<128>,
    ) -> Result<usize, Overflow> {
        build_eapol_key(key_info, nonce, &self.replay, key_data, Some(&self.ptk.kck), out)
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
    replay: &[u8; 8],
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
    out.extend(replay)?; // replay counter — echo the peer's (required by real APs)
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

/// Walk the KDE list in M3's decrypted key data and return the GTK bytes from the
/// GTK KDE (0xdd, OUI 00-0f-ac, data type 1). Skips the IGTK KDE and 0xdd/0x00
/// padding. KDE layout: dd | len | OUI(3) | type(1) | [keyid(1) rsv(1) GTK..].
fn find_gtk_kde(kd: &[u8]) -> Option<&[u8]> {
    let mut i = 0;
    while i + 2 <= kd.len() {
        let l = kd[i + 1] as usize;
        if kd[i] != 0xdd || l < 4 || i + 2 + l > kd.len() {
            break; // padding or end of KDEs
        }
        let body = &kd[i + 2..i + 2 + l];
        if body[0..3] == [0x00, 0x0f, 0xac] && body[3] == 0x01 && body.len() > 6 {
            return Some(&body[6..]); // OUI(3) type(1) keyid(1) rsv(1) then GTK
        }
        i += 2 + l;
    }
    None
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

    #[test]
    fn incremental_pmk_matches_oneshot() {
        // The chunked PmkDeriv must be bit-identical to pmk() for any chunk size, including ones
        // that don't divide the 4096-iter blocks evenly (exercises the block-boundary handling).
        for chunk in [1u32, 7, 64, 100, 4096, 9000] {
            let mut d = PmkDeriv::new(b"password", b"IEEE");
            let mut guard = 0;
            while !d.step(chunk) {
                guard += 1;
                assert!(guard < 100_000, "PmkDeriv did not converge for chunk={chunk}");
            }
            assert_eq!(d.pmk(), pmk(b"password", b"IEEE"), "chunk={chunk}");
        }
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
