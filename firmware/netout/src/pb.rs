//! The minimum of protobuf wire format the hand-coded arms need: a bounded
//! reader over a borrowed frame and a bounded writer into a caller's buffer.
//! Neither allocates; both fail rather than read or write out of bounds.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Malformed;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Overflow;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Value<'a> {
    Varint(u64),
    Fixed64(u64),
    Bytes(&'a [u8]),
    Fixed32(u32),
}

impl Value<'_> {
    /// A varint field as the proto's int32 (negative values are 10-byte
    /// two's-complement varints on the wire).
    pub fn as_i32(self) -> Option<i32> {
        match self {
            Value::Varint(v) => Some(v as i64 as i32),
            _ => None,
        }
    }
}

pub struct Reader<'a> {
    b: &'a [u8],
    o: usize,
}

impl<'a> Reader<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Self { b, o: 0 }
    }

    fn varint(&mut self) -> Result<u64, Malformed> {
        let mut v = 0u64;
        for i in 0..10 {
            let c = *self.b.get(self.o).ok_or(Malformed)?;
            self.o += 1;
            v |= ((c & 0x7f) as u64) << (7 * i);
            if c & 0x80 == 0 {
                return Ok(v);
            }
        }
        Err(Malformed)
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], Malformed> {
        let end = self.o.checked_add(n).ok_or(Malformed)?;
        let b: &'a [u8] = self.b;
        let s = b.get(self.o..end).ok_or(Malformed)?;
        self.o = end;
        Ok(s)
    }

    /// The next field, or None at the end of the message.
    pub fn field(&mut self) -> Result<Option<(u32, Value<'a>)>, Malformed> {
        if self.o >= self.b.len() {
            return Ok(None);
        }
        let key = self.varint()?;
        let num = u32::try_from(key >> 3).map_err(|_| Malformed)?;
        if num == 0 {
            return Err(Malformed);
        }
        let v = match key & 7 {
            0 => Value::Varint(self.varint()?),
            1 => {
                let s = self.take(8)?;
                let mut w = [0u8; 8];
                w.copy_from_slice(s);
                Value::Fixed64(u64::from_le_bytes(w))
            }
            2 => {
                let n = usize::try_from(self.varint()?).map_err(|_| Malformed)?;
                Value::Bytes(self.take(n)?)
            }
            5 => {
                let s = self.take(4)?;
                let mut w = [0u8; 4];
                w.copy_from_slice(s);
                Value::Fixed32(u32::from_le_bytes(w))
            }
            _ => return Err(Malformed),
        };
        Ok(Some((num, v)))
    }
}

/// Writes protobuf fields into `buf`, from `pos` on.
pub struct Writer<'a> {
    pub buf: &'a mut [u8],
    pub pos: usize,
}

impl<'a> Writer<'a> {
    pub fn new(buf: &'a mut [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn raw(&mut self, b: &[u8]) -> Result<(), Overflow> {
        let end = self.pos.checked_add(b.len()).ok_or(Overflow)?;
        self.buf.get_mut(self.pos..end).ok_or(Overflow)?.copy_from_slice(b);
        self.pos = end;
        Ok(())
    }

    pub fn varint(&mut self, mut v: u64) -> Result<(), Overflow> {
        loop {
            let c = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                return self.raw(&[c]);
            }
            self.raw(&[c | 0x80])?;
        }
    }

    fn key(&mut self, num: u32, wt: u8) -> Result<(), Overflow> {
        self.varint(((num as u64) << 3) | wt as u64)
    }

    /// A uint32 / uint64 / bool / enum field; proto3 omits zeros.
    pub fn uint(&mut self, num: u32, v: u64) -> Result<(), Overflow> {
        if v == 0 {
            return Ok(());
        }
        self.key(num, 0)?;
        self.varint(v)
    }

    /// An int32 field (negative values sign-extend to 10 bytes, as protobuf does).
    pub fn int32(&mut self, num: u32, v: i32) -> Result<(), Overflow> {
        self.uint(num, v as i64 as u64)
    }

    pub fn fixed32(&mut self, num: u32, v: u32) -> Result<(), Overflow> {
        if v == 0 {
            return Ok(());
        }
        self.key(num, 5)?;
        self.raw(&v.to_le_bytes())
    }

    pub fn bytes(&mut self, num: u32, b: &[u8]) -> Result<(), Overflow> {
        if b.is_empty() {
            return Ok(());
        }
        self.key(num, 2)?;
        self.varint(b.len() as u64)?;
        self.raw(b)
    }

    /// A submessage written by `f`, even when empty (presence matters for the
    /// envelope's oneof arm). The body is written in place after a length
    /// reserved at its largest (3 bytes: up to 2 MiB) and moved down to fit.
    pub fn message(
        &mut self,
        num: u32,
        f: impl FnOnce(&mut Writer<'_>) -> Result<(), Overflow>,
    ) -> Result<(), Overflow> {
        self.key(num, 2)?;
        let len_at = self.pos;
        let body_at = len_at.checked_add(3).ok_or(Overflow)?;
        if body_at > self.buf.len() {
            return Err(Overflow);
        }
        let body_len = {
            let mut sub = Writer { buf: &mut self.buf[body_at..], pos: 0 };
            f(&mut sub)?;
            sub.pos
        };
        let mut len = [0u8; 3];
        let n = {
            let mut lw = Writer { buf: &mut len, pos: 0 };
            lw.varint(body_len as u64)?;
            lw.pos
        };
        self.buf.copy_within(body_at..body_at + body_len, len_at + n);
        self.buf[len_at..len_at + n].copy_from_slice(&len[..n]);
        self.pos = len_at + n + body_len;
        Ok(())
    }
}
