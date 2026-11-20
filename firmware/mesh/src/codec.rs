//! Bounded big-endian byte writer and reader for Splanc's fixed-layout mesh messages
//! (membership, sessions, rekeys). No allocation; a short buffer or input is an error, never
//! a panic.

/// A bounded writer over a byte slice.
pub struct W<'a> {
    b: &'a mut [u8],
    n: usize,
    ok: bool,
}

impl<'a> W<'a> {
    pub fn new(b: &'a mut [u8]) -> W<'a> {
        W { b, n: 0, ok: true }
    }
    pub fn put(&mut self, s: &[u8]) -> &mut Self {
        if self.ok && self.n + s.len() <= self.b.len() {
            self.b[self.n..self.n + s.len()].copy_from_slice(s);
            self.n += s.len();
        } else {
            self.ok = false;
        }
        self
    }
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.put(&[v])
    }
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.put(&v.to_be_bytes())
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.put(&v.to_be_bytes())
    }
    pub fn i64(&mut self, v: i64) -> &mut Self {
        self.put(&v.to_be_bytes())
    }
    pub fn done(&self) -> Option<usize> {
        self.ok.then_some(self.n)
    }
}

/// A bounded reader.
pub struct R<'a> {
    b: &'a [u8],
}

impl<'a> R<'a> {
    pub fn new(b: &'a [u8]) -> R<'a> {
        R { b }
    }
    pub fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        if self.b.len() < n {
            return None;
        }
        let (h, t) = self.b.split_at(n);
        self.b = t;
        Some(h)
    }
    pub fn arr<const N: usize>(&mut self) -> Option<[u8; N]> {
        self.take(N)?.try_into().ok()
    }
    pub fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }
    pub fn u16(&mut self) -> Option<u16> {
        Some(u16::from_be_bytes(self.arr()?))
    }
    pub fn u32(&mut self) -> Option<u32> {
        Some(u32::from_be_bytes(self.arr()?))
    }
    pub fn i64(&mut self) -> Option<i64> {
        Some(i64::from_be_bytes(self.arr()?))
    }
    pub fn rest(self) -> &'a [u8] {
        self.b
    }
    /// The reader has nothing left (exact-length messages).
    pub fn end(&self) -> Option<()> {
        self.b.is_empty().then_some(())
    }
}
