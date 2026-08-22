//! Heapless BLE RX parse/reassembly — the bounded HCI/L2CAP/ATT layer. Same
//! discipline as the 802.11 side (`ieee80211`):
//!
//!   * [`L2capReassembler`] recombines an L2CAP PDU across HCI-ACL fragments into
//!     a fixed [`Buf`]; an over-length recombination (the L2CAP length field and
//!     the fragment stream are untrusted (remotely supplied)) becomes `Err(Overflow)`,
//!     never an out-of-bounds write.
//!   * [`att`] parses ATT PDUs bounded by the input slice — no out-of-bounds
//!     reads on a truncated or over-declared length.
//!
//! Zero allocation; bounded by input.

use crate::rx::{Buf, Overflow};

/// BLE spec caps an L2CAP PDU (LE) well under this; size to the controller's RX.
pub const L2CAP_MAX: usize = 1024;

/// HCI ACL data packet header: `[handle:2][total_len:2][payload...]`.
/// The first fragment of an L2CAP PDU additionally starts with the L2CAP header
/// `[len:2][cid:2]`. All accessors are bounds-checked.
pub struct AclPacket<'a> {
    pub handle: u16,
    pub pb_flag: u8, // packet-boundary flag (start vs continuation)
    pub payload: &'a [u8],
}

impl<'a> AclPacket<'a> {
    pub fn parse(buf: &'a [u8]) -> Option<AclPacket<'a>> {
        if buf.len() < 4 {
            return None;
        }
        let hf = u16::from_le_bytes([buf[0], buf[1]]);
        let total = u16::from_le_bytes([buf[2], buf[3]]) as usize;
        if 4 + total > buf.len() {
            return None; // declared length runs past the buffer
        }
        Some(AclPacket {
            handle: hf & 0x0fff,
            pb_flag: ((hf >> 12) & 0x3) as u8,
            payload: &buf[4..4 + total],
        })
    }
    /// PB flag 0b10 = first fragment of a higher-layer (L2CAP) message.
    pub fn is_start(&self) -> bool {
        self.pb_flag == 0b10 || self.pb_flag == 0b00
    }
}

/// Recombine an L2CAP PDU across ACL fragments into a fixed buffer. The L2CAP
/// length field and the fragment stream are untrusted (remotely supplied); every append is
/// bounded and an over-length recombination is dropped, not written out of bounds.
pub struct L2capReassembler {
    buf: Buf<L2CAP_MAX>,
    expected: usize, // full L2CAP PDU length (4 + payload) once known
    have_header: bool,
}

impl L2capReassembler {
    pub const fn new() -> Self {
        L2capReassembler { buf: Buf::new(), expected: 0, have_header: false }
    }
    pub fn reset(&mut self) {
        self.buf = Buf::new();
        self.expected = 0;
        self.have_header = false;
    }

    /// Feed one ACL packet. On completion returns the recombined L2CAP PDU
    /// `[len:2][cid:2][payload...]`; `Ok(None)` while more fragments are needed;
    /// `Err(Overflow)` if the declared/streamed length exceeds `L2CAP_MAX`.
    pub fn push(&mut self, pkt: &AclPacket<'_>) -> Result<Option<&[u8]>, Overflow> {
        if pkt.is_start() {
            self.reset();
            if pkt.payload.len() >= 2 {
                // L2CAP length (payload len) + 4 for the L2CAP header itself.
                let l2len = u16::from_le_bytes([pkt.payload[0], pkt.payload[1]]) as usize;
                self.expected = l2len + 4;
                self.have_header = true;
                if self.expected > L2CAP_MAX {
                    return Err(Overflow); // reject an over-long PDU up front
                }
            }
        }
        self.buf.extend(pkt.payload)?; // bounded — never overruns L2CAP_MAX
        if self.have_header && self.buf.len() >= self.expected {
            return Ok(Some(&self.buf.as_slice()[..self.expected]));
        }
        Ok(None)
    }
}

impl Default for L2capReassembler {
    fn default() -> Self {
        Self::new()
    }
}

/// Bounded ATT PDU parsing (runs on the recombined L2CAP payload for CID 0x0004).
pub mod att {
    /// One ATT PDU: opcode + the (borrowed) parameters, bounded by the input.
    pub struct AttPdu<'a> {
        pub opcode: u8,
        pub params: &'a [u8],
    }

    impl<'a> AttPdu<'a> {
        pub fn parse(l2cap_payload: &'a [u8]) -> Option<AttPdu<'a>> {
            let (&opcode, params) = l2cap_payload.split_first()?;
            Some(AttPdu { opcode, params })
        }
    }

    /// Parse a Write Request's `[handle:2][value...]` without trusting any
    /// embedded length — the value is exactly the remaining bytes, bounded.
    pub fn write_req<'a>(pdu: &'a AttPdu<'a>) -> Option<(u16, &'a [u8])> {
        const ATT_WRITE_REQ: u8 = 0x12;
        if pdu.opcode != ATT_WRITE_REQ || pdu.params.len() < 2 {
            return None;
        }
        let handle = u16::from_le_bytes([pdu.params[0], pdu.params[1]]);
        Some((handle, &pdu.params[2..]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acl(handle: u16, pb: u8, payload: &[u8]) -> [u8; 4 + 64] {
        let mut b = [0u8; 4 + 64];
        let hf = (handle & 0x0fff) | ((pb as u16) << 12);
        b[0..2].copy_from_slice(&hf.to_le_bytes());
        b[2..4].copy_from_slice(&(payload.len() as u16).to_le_bytes());
        b[4..4 + payload.len()].copy_from_slice(payload);
        b
    }

    #[test]
    fn acl_parse_is_bounded() {
        assert!(AclPacket::parse(&[0, 0, 0]).is_none()); // < 4 bytes
        // total_len=100 but only 2 payload bytes present -> rejected, no OOB.
        assert!(AclPacket::parse(&[0, 0, 100, 0, 1, 2]).is_none());
    }

    #[test]
    fn l2cap_reassembly_recombines() {
        // L2CAP PDU: len=6, cid=4, 6 bytes of ATT -> total 10 bytes, split 5+5.
        let mut full = [0u8; 10];
        full[0..2].copy_from_slice(&6u16.to_le_bytes()); // l2cap len
        full[2..4].copy_from_slice(&4u16.to_le_bytes()); // cid = ATT
        full[4..10].copy_from_slice(&[0x12, 0x03, 0x00, 0xaa, 0xbb, 0xcc]);
        let mut r = L2capReassembler::new();
        let p0 = acl(0x40, 0b10, &full[0..5]);
        let p1 = acl(0x40, 0b01, &full[5..10]);
        assert!(matches!(r.push(&AclPacket::parse(&p0[..9]).unwrap()), Ok(None)));
        let out = r.push(&AclPacket::parse(&p1[..9]).unwrap()).unwrap().unwrap();
        assert_eq!(out.len(), 10);
        // ATT write-req parse on the recombined payload.
        let att = att::AttPdu::parse(&out[4..]).unwrap();
        let (h, v) = att::write_req(&att).unwrap();
        assert_eq!(h, 0x0003);
        assert_eq!(v, &[0xaa, 0xbb, 0xcc]);
    }

    #[test]
    fn l2cap_reassembly_rejects_overlong_pdu() {
        // A declared L2CAP length far past L2CAP_MAX -> Err up front, never
        // allocates or overruns.
        let mut hdr = [0u8; 8];
        hdr[0..2].copy_from_slice(&(L2CAP_MAX as u16 + 100).to_le_bytes());
        hdr[2..4].copy_from_slice(&4u16.to_le_bytes());
        let p = acl(0x40, 0b10, &hdr);
        let mut r = L2capReassembler::new();
        assert_eq!(r.push(&AclPacket::parse(&p[..12]).unwrap()), Err(Overflow));
    }
}
