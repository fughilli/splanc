//! Zero-copy protobuf wire reader — iterates the fields of an encoded message,
//! returning length-delimited values (bytes / string / sub-message) as **borrows
//! into the input buffer**. No allocation, no copy: paired with the zero-copy RX
//! path, a protobuf message received over the air is decoded in place in the
//! radio's RX buffer and its fields are handed to the app as slices of that same
//! buffer.

/// A decoded field value. `Bytes` borrows the source buffer (zero copy).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PbValue<'a> {
    Varint(u64),
    Fixed64(u64),
    Fixed32(u32),
    Bytes(&'a [u8]),
}

impl<'a> PbValue<'a> {
    /// Interpret a `Bytes` value as a UTF-8 string slice (still borrowed).
    pub fn as_str(&self) -> Option<&'a str> {
        match self {
            PbValue::Bytes(b) => core::str::from_utf8(b).ok(),
            _ => None,
        }
    }
    pub fn as_bytes(&self) -> Option<&'a [u8]> {
        match self {
            PbValue::Bytes(b) => Some(b),
            _ => None,
        }
    }
    pub fn as_u64(&self) -> Option<u64> {
        match self {
            PbValue::Varint(v) => Some(*v),
            PbValue::Fixed64(v) => Some(*v),
            PbValue::Fixed32(v) => Some(*v as u64),
            _ => None,
        }
    }
}

/// A field iterator over a protobuf-encoded buffer. Bounded: a truncated or
/// malformed field ends iteration (returns `None`), never reads out of bounds.
pub struct PbReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> PbReader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        PbReader { buf, pos: 0 }
    }

    fn varint(&mut self) -> Option<u64> {
        let mut val: u64 = 0;
        let mut shift = 0;
        loop {
            let b = *self.buf.get(self.pos)?;
            self.pos += 1;
            val |= ((b & 0x7f) as u64) << shift;
            if b & 0x80 == 0 {
                return Some(val);
            }
            shift += 7;
            if shift >= 64 {
                return None; // overlong varint
            }
        }
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let s = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(s)
    }
}

impl<'a> Iterator for PbReader<'a> {
    /// `(field_number, value)`.
    type Item = (u32, PbValue<'a>);

    fn next(&mut self) -> Option<Self::Item> {
        if self.pos >= self.buf.len() {
            return None;
        }
        let tag = self.varint()?;
        let field = (tag >> 3) as u32;
        let wire = (tag & 0x7) as u8;
        let value = match wire {
            0 => PbValue::Varint(self.varint()?),
            1 => {
                let b = self.take(8)?;
                PbValue::Fixed64(u64::from_le_bytes(b.try_into().ok()?))
            }
            2 => {
                let len = self.varint()? as usize;
                PbValue::Bytes(self.take(len)?) // borrows the buffer — zero copy
            }
            5 => {
                let b = self.take(4)?;
                PbValue::Fixed32(u32::from_le_bytes(b.try_into().ok()?))
            }
            _ => return None, // unknown/deprecated group wire type -> stop
        };
        Some((field, value))
    }
}

/// Convenience: find the first field with `field_number == num` (zero-copy).
pub fn field<'a>(buf: &'a [u8], num: u32) -> Option<PbValue<'a>> {
    PbReader::new(buf).find(|(f, _)| *f == num).map(|(_, v)| v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_fields_zero_copy() {
        // field 1: varint 150; field 2: string "hi"; field 3: fixed32 7.
        let msg = [0x08, 0x96, 0x01, 0x12, 0x02, b'h', b'i', 0x1d, 7, 0, 0, 0];
        let (mut v1, mut s2, mut f3) = (0u64, "", 0u32);
        for (f, v) in PbReader::new(&msg) {
            match f {
                1 => v1 = v.as_u64().unwrap(),
                2 => s2 = v.as_str().unwrap(),
                3 => f3 = v.as_u64().unwrap() as u32,
                _ => {}
            }
        }
        assert_eq!((v1, s2, f3), (150, "hi", 7));
        // the string value borrows `msg` — prove it points inside the input buffer.
        let s = field(&msg, 2).unwrap().as_bytes().unwrap();
        let base = msg.as_ptr() as usize;
        assert!((s.as_ptr() as usize) >= base && (s.as_ptr() as usize) < base + msg.len());
    }

    #[test]
    fn truncated_is_bounded_not_oob() {
        let msg = [0x12, 0x05, b'a', b'b']; // says len=5 but only 2 bytes follow
        assert_eq!(PbReader::new(&msg).count(), 0); // stops cleanly, no panic
    }
}
