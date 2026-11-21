//! The protobuf reply writer for the C6 front end's relay (relay_ffi.rs): a `ServerMessage`
//! arm encoded straight into the reply buffer, no by-value message. The same writer as the
//! player's (ffi.rs `PbOut` / `write_arm`), which wifi_ffi.rs, compiled into both, expects;
//! the player keeps its own copy so its code generation (and loopTask's stack bound,
//! stack_bound_test) doesn't move.

/// A protobuf writer over the reply buffer that can also just count (for the
/// length prefix of a message written in place). `n` is bytes written/counted;
/// `ok` turns false when a real write would overflow.
pub(crate) struct PbOut<'a> {
    pub(crate) buf: Option<&'a mut [u8]>,
    pub(crate) n: usize,
    pub(crate) ok: bool,
}

impl PbOut<'_> {
    pub(crate) fn byte(&mut self, b: u8) {
        if let Some(buf) = self.buf.as_deref_mut() {
            match buf.get_mut(self.n) {
                Some(slot) => *slot = b,
                None => self.ok = false,
            }
        }
        self.n += 1;
    }
    pub(crate) fn varint(&mut self, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.byte(b);
                return;
            }
            self.byte(b | 0x80);
        }
    }
    pub(crate) fn key(&mut self, field: u32, wire: u8) {
        self.varint(((field as u64) << 3) | wire as u64);
    }
    /// A 32-bit fixed field (wire type 5): a `float` as its bits, or fixed32.
    #[allow(dead_code)] // the relay writes none
    pub(crate) fn fixed32(&mut self, field: u32, v: u32) {
        self.key(field, 5);
        for b in v.to_le_bytes() {
            self.byte(b);
        }
    }
    pub(crate) fn uint(&mut self, field: u32, v: u64) {
        self.key(field, 0);
        self.varint(v);
    }
    pub(crate) fn bytes(&mut self, field: u32, b: &[u8]) {
        self.key(field, 2);
        self.varint(b.len() as u64);
        for &x in b {
            self.byte(x);
        }
    }
}

/// Write `ServerMessage.<field>` (a LEN arm) around the body `body` writes, in
/// ONE pass: the body goes in after a reserved 4-byte key+length header, which
/// is then filled and the body slid down to meet it. Bodies are < 16 KiB.
pub(crate) unsafe fn write_arm(out: *mut u8, out_cap: usize, field: u32, body: impl FnOnce(&mut PbOut)) -> i32 {
    const HDR: usize = 4;
    if out_cap <= HDR {
        return -2;
    }
    let buf = core::slice::from_raw_parts_mut(out, out_cap);
    let n = {
        let mut w = PbOut { buf: Some(&mut buf[HDR..]), n: 0, ok: true };
        body(&mut w);
        if !w.ok || w.n >= 1 << 14 {
            return -2;
        }
        w.n
    };
    let mut h = PbOut { buf: Some(&mut buf[..HDR]), n: 0, ok: true };
    h.key(field, 2);
    h.varint(n as u64);
    let hn = h.n;
    buf.copy_within(HDR..HDR + n, hn);
    (hn + n) as i32
}
