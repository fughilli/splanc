//! CCMP (AES-CCM) for 802.11 data frames + the AES-128 primitive it needs,
//! allocation-free. Replaces the vendor's link-layer crypto: encrypt/decrypt the
//! MPDU payload with the pairwise/group temporal key, build/parse the CCMP
//! header, and enforce the 8-byte MIC. Also provides AES key-unwrap (RFC 3394)
//! for the WPA2 GTK KDE via [`wpa::KeyUnwrap`](crate::wpa::KeyUnwrap).
//!
//! AES, AES-CCM, and key-unwrap are validated against the FIPS-197, RFC-3610, and
//! RFC-3394 vectors in the tests; CCMP encap/decap is round-trip + tamper tested.

use crate::wpa::KeyUnwrap;

// --- AES-128 (FIPS-197) ------------------------------------------------------

#[rustfmt::skip]
const SBOX: [u8; 256] = [
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
];

const RCON: [u8; 11] = [0x00, 0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36];

fn inv_sbox(x: u8) -> u8 {
    // derived from SBOX (avoids a second 256-byte table)
    SBOX.iter().position(|&v| v == x).unwrap() as u8
}

fn xtime(x: u8) -> u8 {
    (x << 1) ^ (if x & 0x80 != 0 { 0x1b } else { 0 })
}
fn gmul(mut a: u8, mut b: u8) -> u8 {
    let mut p = 0u8;
    for _ in 0..8 {
        if b & 1 != 0 {
            p ^= a;
        }
        let hi = a & 0x80;
        a <<= 1;
        if hi != 0 {
            a ^= 0x1b;
        }
        b >>= 1;
    }
    p
}

/// AES-128 block cipher. On the ESP32-C6 target the single-block primitive runs on
/// the dedicated standalone AES accelerator ([`hw_aes`]); host builds (and the test
/// suite) use the software cipher with pre-expanded round keys. The public API is
/// identical either way, so CCMP / key-wrap code is backend-agnostic.
pub struct Aes128 {
    key: [u8; 16],
    #[cfg(not(all(target_arch = "riscv32", not(test))))]
    rk: [[u8; 16]; 11],
}

impl Aes128 {
    #[cfg(all(target_arch = "riscv32", not(test)))]
    pub fn new(key: &[u8; 16]) -> Self {
        Aes128 { key: *key } // HW engine takes the raw key; no round-key expansion needed
    }

    #[cfg(not(all(target_arch = "riscv32", not(test))))]
    pub fn new(key: &[u8; 16]) -> Self {
        let mut rk = [[0u8; 16]; 11];
        rk[0].copy_from_slice(key);
        for r in 1..11 {
            let prev = rk[r - 1];
            let mut t = [prev[12], prev[13], prev[14], prev[15]];
            t.rotate_left(1);
            for b in &mut t {
                *b = SBOX[*b as usize];
            }
            t[0] ^= RCON[r];
            for i in 0..4 {
                rk[r][i] = prev[i] ^ t[i];
            }
            for i in 4..16 {
                rk[r][i] = prev[i] ^ rk[r][i - 4];
            }
        }
        Aes128 { key: *key, rk }
    }

    pub fn encrypt_block(&self, s: &mut [u8; 16]) {
        #[cfg(all(target_arch = "riscv32", not(test)))]
        {
            hw_aes::block(&self.key, s, hw_aes::MODE_ENC);
            return;
        }
        #[cfg(not(all(target_arch = "riscv32", not(test))))]
        self.encrypt_block_sw(s);
    }

    pub fn decrypt_block(&self, s: &mut [u8; 16]) {
        #[cfg(all(target_arch = "riscv32", not(test)))]
        {
            hw_aes::block(&self.key, s, hw_aes::MODE_DEC);
            return;
        }
        #[cfg(not(all(target_arch = "riscv32", not(test))))]
        self.decrypt_block_sw(s);
    }

    #[cfg(not(all(target_arch = "riscv32", not(test))))]
    fn encrypt_block_sw(&self, s: &mut [u8; 16]) {
        add_rk(s, &self.rk[0]);
        for r in 1..10 {
            sub_bytes(s);
            shift_rows(s);
            mix_columns(s);
            add_rk(s, &self.rk[r]);
        }
        sub_bytes(s);
        shift_rows(s);
        add_rk(s, &self.rk[10]);
    }

    #[cfg(not(all(target_arch = "riscv32", not(test))))]
    fn decrypt_block_sw(&self, s: &mut [u8; 16]) {
        add_rk(s, &self.rk[10]);
        for r in (1..10).rev() {
            inv_shift_rows(s);
            inv_sub_bytes(s);
            add_rk(s, &self.rk[r]);
            inv_mix_columns(s);
        }
        inv_shift_rows(s);
        inv_sub_bytes(s);
        add_rk(s, &self.rk[0]);
    }
}

/// ESP32-C6 standalone AES accelerator (`DR_REG_AES_BASE = 0x6008_8000`), single-block
/// ECB. CCMP (AES-CTR keystream + CBC-MAC) and RFC-3394 key-wrap use the forward block
/// (`MODE_ENC`); key-unwrap uses the inverse block (`MODE_DEC`). Register map + the
/// mode/state encoding are from the IDF `soc/aes_reg.h` + `hal/aes_ll.h` for esp32c6.
#[cfg(all(target_arch = "riscv32", not(test)))]
pub mod hw_aes {
    const AES_BASE: usize = 0x6008_8000;
    const AES_KEY_0: usize = AES_BASE + 0x00; // KEY_0..3 (AES-128), stride 4
    const AES_TEXT_IN_0: usize = AES_BASE + 0x20; // 4 words
    const AES_TEXT_OUT_0: usize = AES_BASE + 0x30; // 4 words
    const AES_MODE: usize = AES_BASE + 0x40; // 0 = AES-128 enc, 4 = AES-128 dec
    const AES_TRIGGER: usize = AES_BASE + 0x48; // write 1 to start
    const AES_STATE: usize = AES_BASE + 0x4C; // typical mode: 0 = idle/done, 1 = busy
    const AES_DMA_ENABLE: usize = AES_BASE + 0x90; // 0 = typical (CPU) mode, 1 = DMA mode
    const PCR_AES_CONF: usize = 0x6009_60C8; // bit0 = AES clock enable, bit1 = reset
    const PCR_DS_CONF: usize = 0x6009_60E0; // bit1 = DS reset (holds AES in reset if set)

    pub const MODE_ENC: u32 = 0;
    pub const MODE_DEC: u32 = 4;

    use core::sync::atomic::{AtomicBool, Ordering};
    static INIT: AtomicBool = AtomicBool::new(false);

    #[inline(always)]
    unsafe fn wr(a: usize, v: u32) {
        core::ptr::write_volatile(a as *mut u32, v);
    }
    #[inline(always)]
    unsafe fn rd(a: usize) -> u32 {
        core::ptr::read_volatile(a as *const u32)
    }

    /// One-time: pulse the AES reset. The clock-enable / DS-reset-clear / DMA-mode are
    /// re-asserted on EVERY block (see `reclaim`) because mbedtls's esp_aes shares this
    /// peripheral and, on release, disables the AES clock and can leave DMA mode enabled.
    unsafe fn ensure_init() {
        if INIT.load(Ordering::Relaxed) {
            return;
        }
        wr(PCR_AES_CONF, rd(PCR_AES_CONF) | 0b01); // clock enable (bit0)
        wr(PCR_AES_CONF, rd(PCR_AES_CONF) | 0b10); // assert reset (bit1)
        wr(PCR_AES_CONF, rd(PCR_AES_CONF) & !0b10); // release reset
        INIT.store(true, Ordering::Relaxed);
    }

    /// Re-take ownership of the peripheral from mbedtls each block: clock on, DS reset
    /// clear, and force typical (CPU) mode by disabling DMA. Without the DMA clear, a
    /// prior mbedtls DMA-mode AES op leaves STATE semantics changed and our poll for
    /// STATE==0 never returns — spinning forever with interrupts masked (interrupt WDT
    /// reset, seen mid-TLS-handshake when mbedtls starts protecting records).
    #[inline(always)]
    unsafe fn reclaim() {
        wr(PCR_AES_CONF, rd(PCR_AES_CONF) | 0b01); // clock enable (mbedtls disables it on release)
        wr(PCR_DS_CONF, rd(PCR_DS_CONF) & !0b10); // clear DS reset (else AES held in reset)
        wr(AES_DMA_ENABLE, 0); // typical/CPU mode (undo any mbedtls DMA-mode config)
    }

    /// One AES-128 block on the accelerator, in place. Runs with machine interrupts
    /// masked: the peripheral is stateful and shared with mbedtls/TLS, so reclaim→key→
    /// text→trigger→read must be atomic against a preempting AES user. A few µs. The
    /// STATE poll is bounded so a wedged peripheral can never hang interrupts (WDT).
    pub fn block(key: &[u8; 16], data: &mut [u8; 16], mode: u32) {
        let saved: usize;
        unsafe {
            core::arch::asm!("csrrci {0}, mstatus, 0x8", out(reg) saved); // clear MIE, save old
            ensure_init();
            reclaim();
            wr(AES_MODE, mode);
            for i in 0..4 {
                let o = i * 4;
                wr(AES_KEY_0 + o, u32::from_le_bytes([key[o], key[o + 1], key[o + 2], key[o + 3]]));
                wr(AES_TEXT_IN_0 + o, u32::from_le_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]]));
            }
            wr(AES_TRIGGER, 1);
            // Bounded busy-wait: one block completes in a few dozen cycles; the cap only
            // exists so a misconfigured/contended peripheral can't wedge with MIE cleared.
            let mut spins = 0u32;
            while rd(AES_STATE) != 0 {
                spins += 1;
                if spins > 100_000 {
                    break;
                }
            }
            for i in 0..4 {
                let o = i * 4;
                data[o..o + 4].copy_from_slice(&rd(AES_TEXT_OUT_0 + o).to_le_bytes());
            }
            if saved & 0x8 != 0 {
                core::arch::asm!("csrrsi x0, mstatus, 0x8"); // restore MIE if it was set
            }
        }
    }
}

fn add_rk(s: &mut [u8; 16], k: &[u8; 16]) {
    for i in 0..16 {
        s[i] ^= k[i];
    }
}
fn sub_bytes(s: &mut [u8; 16]) {
    for b in s.iter_mut() {
        *b = SBOX[*b as usize];
    }
}
fn inv_sub_bytes(s: &mut [u8; 16]) {
    for b in s.iter_mut() {
        *b = inv_sbox(*b);
    }
}
fn shift_rows(s: &mut [u8; 16]) {
    let t = *s;
    // column-major state: byte(row, col) = s[col*4 + row]
    for row in 1..4 {
        for col in 0..4 {
            s[col * 4 + row] = t[((col + row) % 4) * 4 + row];
        }
    }
}
fn inv_shift_rows(s: &mut [u8; 16]) {
    let t = *s;
    for row in 1..4 {
        for col in 0..4 {
            s[col * 4 + row] = t[((col + 4 - row) % 4) * 4 + row];
        }
    }
}
fn mix_columns(s: &mut [u8; 16]) {
    for c in 0..4 {
        let o = c * 4;
        let (a0, a1, a2, a3) = (s[o], s[o + 1], s[o + 2], s[o + 3]);
        s[o] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
        s[o + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
        s[o + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
        s[o + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
    }
}
fn inv_mix_columns(s: &mut [u8; 16]) {
    for c in 0..4 {
        let o = c * 4;
        let (a0, a1, a2, a3) = (s[o], s[o + 1], s[o + 2], s[o + 3]);
        s[o] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
        s[o + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
        s[o + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
        s[o + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
    }
}

// --- AES key unwrap (RFC 3394) ----------------------------------------------

/// AES key wrap (RFC 3394) — the authenticator side, to encrypt the GTK KDE in
/// message 3. `plain` is a multiple of 8 bytes; `out` gets `plain.len()+8`.
pub fn aes_wrap(kek: &[u8; 16], plain: &[u8], out: &mut [u8]) -> usize {
    let n = plain.len() / 8;
    if plain.len() % 8 != 0 || out.len() < plain.len() + 8 {
        return 0;
    }
    let aes = Aes128::new(kek);
    let mut a = [0xa6u8; 8];
    let mut r = [[0u8; 8]; 8];
    for i in 0..n {
        r[i].copy_from_slice(&plain[8 * i..8 * i + 8]);
    }
    for j in 0..6 {
        for i in 0..n {
            let mut blk = [0u8; 16];
            blk[..8].copy_from_slice(&a);
            blk[8..].copy_from_slice(&r[i]);
            aes.encrypt_block(&mut blk);
            a.copy_from_slice(&blk[..8]);
            let t = (n * j + i + 1) as u64;
            for k in 0..8 {
                a[k] ^= (t >> (8 * (7 - k))) as u8;
            }
            r[i].copy_from_slice(&blk[8..]);
        }
    }
    out[..8].copy_from_slice(&a);
    for i in 0..n {
        out[8 * (i + 1)..8 * (i + 2)].copy_from_slice(&r[i]);
    }
    (n + 1) * 8
}

/// The AES for the WPA2 GTK KDE. Wraps [`Aes128`] to satisfy the supplicant hook.
pub struct AesUnwrap;

impl KeyUnwrap for AesUnwrap {
    fn aes_unwrap(&self, kek: &[u8; 16], wrapped: &[u8], out: &mut [u8]) -> Result<usize, ()> {
        if wrapped.len() < 16 || wrapped.len() % 8 != 0 {
            return Err(());
        }
        let n = wrapped.len() / 8 - 1;
        // Real authenticators wrap several KDEs (GTK + IGTK + padding) into M3's key
        // data — up to ~9 blocks — not just the single GTK KDE our interop test used.
        if n > 32 {
            return Err(());
        }
        let aes = Aes128::new(kek);
        let mut a = [0u8; 8];
        a.copy_from_slice(&wrapped[..8]);
        let mut r = [[0u8; 8]; 32];
        for i in 0..n {
            r[i].copy_from_slice(&wrapped[8 * (i + 1)..8 * (i + 2)]);
        }
        for j in (0..6).rev() {
            for i in (0..n).rev() {
                let t = (n * j + i + 1) as u64;
                let mut blk = [0u8; 16];
                blk[..8].copy_from_slice(&a);
                for k in 0..8 {
                    blk[k] ^= (t >> (8 * (7 - k))) as u8;
                }
                blk[8..].copy_from_slice(&r[i]);
                aes.decrypt_block(&mut blk);
                a.copy_from_slice(&blk[..8]);
                r[i].copy_from_slice(&blk[8..]);
            }
        }
        if a != [0xa6; 8] {
            return Err(()); // integrity check value
        }
        let len = n * 8;
        if out.len() < len {
            return Err(());
        }
        for i in 0..n {
            out[8 * i..8 * i + 8].copy_from_slice(&r[i]);
        }
        Ok(len)
    }
}

// --- AES-CCM (CCM*, L=2, M=8 as CCMP uses) -----------------------------------

const M: usize = 8; // MIC length
const L: usize = 2; // length field size (15 - nonce_len)

fn ctr_block(nonce: &[u8; 13], counter: u16) -> [u8; 16] {
    let mut a = [0u8; 16];
    a[0] = (L - 1) as u8; // flags
    a[1..14].copy_from_slice(nonce);
    a[14..16].copy_from_slice(&counter.to_be_bytes());
    a
}

/// AES-CCM encrypt in place: `data` (plaintext -> ciphertext) with `aad`, and the
/// 8-byte MIC appended is returned separately. Bounded: caller sizes buffers.
fn ccm_mic(aes: &Aes128, nonce: &[u8; 13], aad: &[u8], data: &[u8]) -> [u8; M] {
    // CBC-MAC with a zero IV. B0 = flags || nonce || l(m); t = E(B0).
    let mut t = [0u8; 16];
    t[0] = 0x40 /*Adata*/ | (((M - 2) / 2) << 3) as u8 | (L - 1) as u8;
    t[1..14].copy_from_slice(nonce);
    t[14..16].copy_from_slice(&(data.len() as u16).to_be_bytes());
    aes_e(aes, &mut t);
    // AAD block: 2-byte length prefix then the AAD (padded to the block by cbc_mac).
    let mut aad_buf = [0u8; 2 + 32];
    let alen = aad.len();
    aad_buf[0..2].copy_from_slice(&(alen as u16).to_be_bytes());
    aad_buf[2..2 + alen].copy_from_slice(aad);
    cbc_mac(aes, &mut t, &aad_buf[..2 + alen]);
    cbc_mac(aes, &mut t, data);
    let mut mic = [0u8; M];
    mic.copy_from_slice(&t[..M]);
    // MIC ^= S0[:M], where S0 = E(A0).
    let mut a0 = ctr_block(nonce, 0);
    aes_e(aes, &mut a0);
    for i in 0..M {
        mic[i] ^= a0[i];
    }
    mic
}

fn aes_e(aes: &Aes128, b: &mut [u8; 16]) {
    aes.encrypt_block(b);
}

fn cbc_mac(aes: &Aes128, t: &mut [u8; 16], data: &[u8]) {
    let mut off = 0;
    while off < data.len() {
        let take = core::cmp::min(16, data.len() - off);
        for i in 0..take {
            t[i] ^= data[off + i];
        }
        aes_e(aes, t);
        off += take;
    }
}

fn ctr_xor(aes: &Aes128, nonce: &[u8; 13], data: &mut [u8]) {
    let mut counter = 1u16;
    let mut off = 0;
    while off < data.len() {
        let mut s = ctr_block(nonce, counter);
        aes_e(aes, &mut s);
        let take = core::cmp::min(16, data.len() - off);
        for i in 0..take {
            data[off + i] ^= s[i];
        }
        off += take;
        counter += 1;
    }
}

/// AES-CCM encrypt: `buf[..plen]` is encrypted in place and the 8-byte MIC is
/// written to `buf[plen..plen+8]`; returns total length.
pub fn ccm_encrypt(key: &[u8; 16], nonce: &[u8; 13], aad: &[u8], buf: &mut [u8], plen: usize) -> usize {
    let aes = Aes128::new(key);
    let mic = ccm_mic(&aes, nonce, aad, &buf[..plen]);
    ctr_xor(&aes, nonce, &mut buf[..plen]);
    buf[plen..plen + M].copy_from_slice(&mic);
    plen + M
}

/// AES-CCM decrypt+verify: `buf[..clen]` (ciphertext||MIC) is decrypted in place;
/// returns `Some(plaintext_len)` if the MIC verifies, else `None`.
pub fn ccm_decrypt(key: &[u8; 16], nonce: &[u8; 13], aad: &[u8], buf: &mut [u8], clen: usize) -> Option<usize> {
    if clen < M {
        return None;
    }
    let plen = clen - M;
    let aes = Aes128::new(key);
    let mut rx_mic = [0u8; M];
    rx_mic.copy_from_slice(&buf[plen..plen + M]);
    ctr_xor(&aes, nonce, &mut buf[..plen]);
    let mic = ccm_mic(&aes, nonce, aad, &buf[..plen]);
    if mic == rx_mic {
        Some(plen)
    } else {
        None
    }
}

// --- 802.11 CCMP framing -----------------------------------------------------

const HDR24: usize = 24; // base MAC header (no QoS/A4)

/// MAC header length for `hdr`: 26 for a QoS Data frame (its 2-byte QoS Control field
/// follows the 24-byte base header), else 24. Detected from the Subtype's QoS bit
/// (bit 7 of FC octet 0). No A4 / HT-Control in this stack.
fn mac_hdr_len(hdr: &[u8]) -> usize {
    if !hdr.is_empty() && hdr[0] & 0x80 != 0 {
        26
    } else {
        HDR24
    }
}

fn ccmp_nonce(a2: &[u8], pn: u64) -> [u8; 13] {
    let mut n = [0u8; 13];
    n[0] = 0; // priority/mgmt flags (non-QoS data)
    n[1..7].copy_from_slice(&a2[..6]);
    for i in 0..6 {
        n[7 + i] = (pn >> (8 * (5 - i))) as u8; // PN, 48-bit big-endian
    }
    n
}

fn ccmp_hdr(pn: u64, keyid: u8) -> [u8; 8] {
    let p = pn.to_le_bytes();
    [p[0], p[1], 0x00, 0x20 | (keyid << 6), p[2], p[3], p[4], p[5]]
}

/// AAD from the MAC header (no A4): FC (masked) + A1 + A2 + A3 + SC (seq masked), plus
/// — for a QoS Data frame — the 2-byte QoS Control field with only the TID (bits 0-3)
/// kept and the rest masked to 0 (§12.5.3.3.3). Returns the AAD and its used length
/// (22 for non-QoS, 24 for QoS).
fn ccmp_aad(hdr: &[u8]) -> ([u8; 24], usize) {
    let mut a = [0u8; 24];
    a[0] = hdr[0];
    a[1] = (hdr[1] & 0x07) | 0x40; // keep toDS/fromDS/moreFrag, set Protected
    a[2..20].copy_from_slice(&hdr[4..22]); // A1, A2, A3
    a[20] = hdr[22] & 0x0f; // SC: fragment kept, sequence masked
    a[21] = 0;
    if hdr[0] & 0x80 != 0 && hdr.len() >= 26 {
        a[22] = hdr[24] & 0x0f; // QoS Control: TID kept, everything else masked
        a[23] = 0;
        (a, 24)
    } else {
        (a, 22)
    }
}

/// CCMP-encapsulate a plaintext MPDU: `out = header || CCMP-header || CTR(payload)
/// || MIC`. Returns the total length. `hdr` is the (24-byte) MAC header; `payload`
/// is the frame body to protect.
pub fn ccmp_encap(hdr: &[u8], tk: &[u8; 16], pn: u64, keyid: u8, payload: &[u8], out: &mut [u8]) -> usize {
    let hlen = mac_hdr_len(hdr);
    if hdr.len() < hlen {
        return 0;
    }
    let nonce = ccmp_nonce(&hdr[10..16], pn);
    let (aad, alen) = ccmp_aad(hdr);
    out[..hlen].copy_from_slice(&hdr[..hlen]);
    out[hlen..hlen + 8].copy_from_slice(&ccmp_hdr(pn, keyid));
    let body = hlen + 8;
    out[body..body + payload.len()].copy_from_slice(payload);
    let clen = ccm_encrypt(tk, &nonce, &aad[..alen], &mut out[body..], payload.len());
    body + clen
}

/// CCMP-decapsulate: verify + decrypt a protected MPDU in `frame` into `out`.
/// Returns `Some((plaintext_len, pn))` on a valid MIC, else `None`.
pub fn ccmp_decap(frame: &[u8], tk: &[u8; 16], out: &mut [u8]) -> Option<(usize, u64)> {
    let hlen = mac_hdr_len(frame);
    if frame.len() < hlen + 8 + M {
        return None;
    }
    let ch = &frame[hlen..hlen + 8];
    let pn = (ch[0] as u64)
        | (ch[1] as u64) << 8
        | (ch[4] as u64) << 16
        | (ch[5] as u64) << 24
        | (ch[6] as u64) << 32
        | (ch[7] as u64) << 40;
    let nonce = ccmp_nonce(&frame[10..16], pn);
    let (aad, alen) = ccmp_aad(frame);
    let clen = frame.len() - (hlen + 8);
    let body = hlen + 8;
    out[..clen].copy_from_slice(&frame[body..body + clen]);
    let plen = ccm_decrypt(tk, &nonce, &aad[..alen], &mut out[..clen], clen)?;
    Some((plen, pn))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hx(s: &str, out: &mut [u8]) {
        let b = s.as_bytes();
        for i in 0..out.len() {
            let h = |c: u8| (c as char).to_digit(16).unwrap() as u8;
            out[i] = (h(b[i * 2]) << 4) | h(b[i * 2 + 1]);
        }
    }

    #[test]
    fn aes128_fips197() {
        let mut key = [0u8; 16];
        hx("000102030405060708090a0b0c0d0e0f", &mut key);
        let mut blk = [0u8; 16];
        hx("00112233445566778899aabbccddeeff", &mut blk);
        let aes = Aes128::new(&key);
        aes.encrypt_block(&mut blk);
        let mut exp = [0u8; 16];
        hx("69c4e0d86a7b0430d8cdb78070b4c55a", &mut exp);
        assert_eq!(blk, exp);
        aes.decrypt_block(&mut blk);
        let mut pt = [0u8; 16];
        hx("00112233445566778899aabbccddeeff", &mut pt);
        assert_eq!(blk, pt);
    }

    #[test]
    fn key_unwrap_rfc3394() {
        let mut kek = [0u8; 16];
        hx("000102030405060708090a0b0c0d0e0f", &mut kek);
        let mut wrapped = [0u8; 24];
        hx("1fa68b0a8112b447aef34bd8fb5a7b829d3e862371d2cfe5", &mut wrapped);
        let mut out = [0u8; 16];
        let n = AesUnwrap.aes_unwrap(&kek, &wrapped, &mut out).unwrap();
        let mut exp = [0u8; 16];
        hx("00112233445566778899aabbccddeeff", &mut exp);
        assert_eq!((&out[..n], n), (&exp[..], 16));
    }

    #[test]
    fn ccm_roundtrip_and_tamper() {
        let key = [0x11u8; 16];
        let nonce = [0x22u8; 13];
        let aad = [0xaa, 0xbb, 0xcc, 0xdd];
        let mut buf = [0u8; 64];
        let pt = b"heapless CCMP!";
        buf[..pt.len()].copy_from_slice(pt);
        let clen = ccm_encrypt(&key, &nonce, &aad, &mut buf, pt.len());
        assert_ne!(&buf[..pt.len()], &pt[..]); // encrypted
        // decrypt verifies + recovers.
        let mut rx = buf;
        let plen = ccm_decrypt(&key, &nonce, &aad, &mut rx, clen).unwrap();
        assert_eq!(&rx[..plen], &pt[..]);
        // a tampered MIC is rejected.
        let mut bad = buf;
        bad[clen - 1] ^= 0x01;
        assert!(ccm_decrypt(&key, &nonce, &aad, &mut bad, clen).is_none());
    }

    #[test]
    fn ccmp_frame_roundtrip() {
        // A data frame header (FC data, addrs), a TK, a PN, and a body.
        let mut hdr = [0u8; 24];
        hdr[0] = 0x08; // data
        hdr[1] = 0x01; // toDS
        hdr[4..10].copy_from_slice(&[0x00, 0x11, 0x22, 0x33, 0x44, 0x55]); // A1
        hdr[10..16].copy_from_slice(&[0x02, 0x00, 0x53, 0x45, 0x43, 0x01]); // A2
        hdr[16..22].copy_from_slice(&[0x02, 0x00, 0x53, 0x45, 0x43, 0xa0]); // A3
        let tk = [0x33u8; 16];
        let pn = 0x0000_0102_0304u64;
        let payload = b"\xaa\xaa\x03\x00\x00\x00\x08\x00 an IP packet here";
        let mut enc = [0u8; 128];
        let n = ccmp_encap(&hdr, &tk, pn, 0, payload, &mut enc);
        // ciphertext differs from plaintext; header + CCMP header are in clear.
        assert_eq!(&enc[..24], &hdr[..]);
        assert_ne!(&enc[32..32 + payload.len()], &payload[..]);
        // decap recovers the payload + PN and rejects tampering.
        let mut dec = [0u8; 128];
        let (plen, got_pn) = ccmp_decap(&enc[..n], &tk, &mut dec).unwrap();
        assert_eq!((&dec[..plen], got_pn), (&payload[..], pn));
        let mut tampered = enc;
        tampered[40] ^= 0x01;
        assert!(ccmp_decap(&tampered[..n], &tk, &mut dec).is_none());
    }
}
