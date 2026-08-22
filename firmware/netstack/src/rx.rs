//! Heapless RX primitives — the allocation-free core of the stack.
//!
//!   * [`Buf`] is capacity-typed: appending past `N` returns `Err(Overflow)`
//!     rather than overrunning the buffer.
//!   * [`IeReader`] is a bounded iterator: it never reads past the input slice
//!     and needs no allocation.
//!
//! `no_std`, no `alloc`.

/// Maximum 802.11 frame we receive on the C6; sized to the RX buffer budget.
pub const MAX_FRAME: usize = 1700;

#[derive(Debug, PartialEq, Eq)]
pub struct Overflow;

/// Append-only, capacity-typed byte buffer. The capacity `N` is part of the
/// type, and every write is bounds-checked, so a write can never exceed `N`.
pub struct Buf<const N: usize> {
    data: [u8; N],
    len: usize,
}

impl<const N: usize> Buf<N> {
    pub const fn new() -> Self {
        Buf { data: [0u8; N], len: 0 }
    }
    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
    #[inline]
    pub fn as_slice(&self) -> &[u8] {
        &self.data[..self.len]
    }
    #[inline]
    pub fn remaining(&self) -> usize {
        N - self.len
    }

    /// Append raw bytes, or `Err(Overflow)` if they don't fit.
    pub fn extend(&mut self, bytes: &[u8]) -> Result<(), Overflow> {
        if bytes.len() > self.remaining() {
            return Err(Overflow);
        }
        self.data[self.len..self.len + bytes.len()].copy_from_slice(bytes);
        self.len += bytes.len();
        Ok(())
    }

    /// Append a full IE (`[id][len][body...]`), bounds-checked.
    pub fn push_ie(&mut self, id: u8, body: &[u8]) -> Result<(), Overflow> {
        if body.len() > 255 || body.len() + 2 > self.remaining() {
            return Err(Overflow);
        }
        self.data[self.len] = id;
        self.data[self.len + 1] = body.len() as u8;
        self.data[self.len + 2..self.len + 2 + body.len()].copy_from_slice(body);
        self.len += 2 + body.len();
        Ok(())
    }
}

impl<const N: usize> Default for Buf<N> {
    fn default() -> Self {
        Self::new()
    }
}

/// One parsed information element: `id` + the body slice (borrowed, never copied).
#[derive(Debug, Clone, Copy)]
pub struct Ie<'a> {
    pub id: u8,
    pub body: &'a [u8],
}

/// Bounded iterator over an 802.11 IE list. Each step consumes `2 + len` bytes
/// and stops (rather than reading past `end`) on a truncated trailer, so a
/// malformed frame can never drive an out-of-bounds read.
pub struct IeReader<'a> {
    rest: &'a [u8],
}

impl<'a> IeReader<'a> {
    pub fn new(ies: &'a [u8]) -> Self {
        IeReader { rest: ies }
    }
}

impl<'a> Iterator for IeReader<'a> {
    type Item = Ie<'a>;
    fn next(&mut self) -> Option<Ie<'a>> {
        if self.rest.len() < 2 {
            return None; // no room for id+len -> done
        }
        let id = self.rest[0];
        let len = self.rest[1] as usize;
        if 2 + len > self.rest.len() {
            return None; // declared length runs past the buffer -> stop
        }
        let body = &self.rest[2..2 + len];
        self.rest = &self.rest[2 + len..];
        Some(Ie { id, body })
    }
}

/// Copy the transmitted beacon IEs into `out`, bounded. An over-long
/// reconstruction returns `Err(Overflow)` rather than writing past `out`.
pub fn reconstruct_beacon_ies<const N: usize>(
    transmitted_ies: &[u8],
    out: &mut Buf<N>,
) -> Result<(), Overflow> {
    for ie in IeReader::new(transmitted_ies) {
        if ie.id == 0x47 {
            continue; // the MBSSID element itself is consumed, not copied
        }
        out.push_ie(ie.id, ie.body)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ie_reader_is_bounded_on_truncation() {
        // Declares an IE of length 200 but only 3 bytes follow -> reader stops,
        // no panic, no OOB read.
        let ies = [0xdd, 200, 1, 2, 3];
        assert_eq!(IeReader::new(&ies).count(), 0);
    }

    #[test]
    fn buf_extend_rejects_overflow() {
        let mut b: Buf<8> = Buf::new();
        assert!(b.extend(&[0u8; 6]).is_ok());
        assert_eq!(b.extend(&[0u8; 4]), Err(Overflow)); // would exceed 8 -> Err
        assert_eq!(b.len(), 6);
    }

    #[test]
    fn oversize_mbssid_reconstruction_is_bounded() {
        // A transmitted IE set large enough to overflow the destination buffer:
        // the capacity-typed Buf returns Err(Overflow) at the boundary instead
        // of writing past it. Build ~1650 B of vendor IEs.
        let mut ies: Buf<MAX_FRAME> = Buf::new();
        while ies.remaining() > 260 {
            ies.push_ie(0xdd, &[0x5a; 253]).unwrap();
        }
        // Reconstruct into a buffer smaller than the input: must Err, never
        // overrun.
        let mut out: Buf<1024> = Buf::new();
        assert_eq!(reconstruct_beacon_ies(ies.as_slice(), &mut out), Err(Overflow));
        assert!(out.len() <= 1024); // never wrote past capacity
    }
}
