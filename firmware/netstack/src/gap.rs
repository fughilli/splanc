//! Heapless BLE peripheral role — GAP advertising state machine + a fixed GATT
//! attribute table with a bounded ATT server, on top of the bounded L2CAP/ATT
//! layer (`ble`). No dynamic allocation: the attribute table is a fixed array
//! with inline values, and the ATT server writes responses into a bounded
//! [`Buf`]; a crafted ATT request (bad handle / oversize write) yields an ATT
//! error PDU, never an OOB access.

use crate::ble::att::AttPdu;
use crate::rx::{Buf, Overflow};

/// Max stored value per attribute (peripheral characteristics are small).
pub const ATT_VAL_MAX: usize = 32;

// ATT opcodes.
const ATT_ERROR_RSP: u8 = 0x01;
const ATT_READ_REQ: u8 = 0x0a;
const ATT_READ_RSP: u8 = 0x0b;
const ATT_WRITE_REQ: u8 = 0x12;
const ATT_WRITE_RSP: u8 = 0x13;
// ATT error codes.
const ERR_INVALID_HANDLE: u8 = 0x01;
const ERR_WRITE_NOT_PERMITTED: u8 = 0x03;
const ERR_INVALID_LENGTH: u8 = 0x0d;

/// One GATT attribute: a 16-bit handle + 16-bit UUID + an inline, bounded value.
#[derive(Clone, Copy)]
pub struct Attribute {
    pub handle: u16,
    pub uuid16: u16,
    value: [u8; ATT_VAL_MAX],
    len: usize,
    pub writable: bool,
}

impl Attribute {
    pub fn new(handle: u16, uuid16: u16, initial: &[u8], writable: bool) -> Self {
        let mut a = Attribute { handle, uuid16, value: [0; ATT_VAL_MAX], len: 0, writable };
        let n = initial.len().min(ATT_VAL_MAX);
        a.value[..n].copy_from_slice(&initial[..n]);
        a.len = n;
        a
    }
    pub fn value(&self) -> &[u8] {
        &self.value[..self.len]
    }
    fn set(&mut self, v: &[u8]) -> Result<(), ()> {
        if v.len() > ATT_VAL_MAX {
            return Err(());
        }
        self.value[..v.len()].copy_from_slice(v);
        self.len = v.len();
        Ok(())
    }
}

/// Fixed-capacity GATT server. `N` attributes, all static.
pub struct GattServer<const N: usize> {
    attrs: [Option<Attribute>; N],
    count: usize,
}

impl<const N: usize> GattServer<N> {
    pub const fn new() -> Self {
        GattServer { attrs: [None; N], count: 0 }
    }

    /// Add an attribute (at init). `Err(Overflow)` if the table is full.
    pub fn add(&mut self, attr: Attribute) -> Result<(), Overflow> {
        if self.count >= N {
            return Err(Overflow);
        }
        self.attrs[self.count] = Some(attr);
        self.count += 1;
        Ok(())
    }

    /// Immutable read of an attribute's stored value (for tests/telemetry).
    pub fn value_of(&self, handle: u16) -> Option<&[u8]> {
        self.attrs[..self.count]
            .iter()
            .filter_map(|a| a.as_ref())
            .find(|a| a.handle == handle)
            .map(|a| a.value())
    }

    fn find(&mut self, handle: u16) -> Option<&mut Attribute> {
        self.attrs[..self.count]
            .iter_mut()
            .filter_map(|a| a.as_mut())
            .find(|a| a.handle == handle)
    }

    /// Handle an ATT PDU (from the recombined L2CAP payload for CID 0x0004),
    /// writing the response into `out`. Every path is bounded; malformed input
    /// produces an ATT error response, never an OOB read/write.
    pub fn handle_att(&mut self, pdu: &AttPdu<'_>, out: &mut Buf<{ ATT_VAL_MAX + 8 }>) -> Result<(), Overflow> {
        match pdu.opcode {
            ATT_READ_REQ => {
                if pdu.params.len() < 2 {
                    return att_error(ATT_READ_REQ, 0, ERR_INVALID_LENGTH, out);
                }
                let handle = u16::from_le_bytes([pdu.params[0], pdu.params[1]]);
                match self.find(handle) {
                    Some(a) => {
                        out.extend(&[ATT_READ_RSP])?;
                        out.extend(a.value())
                    }
                    None => att_error(ATT_READ_REQ, handle, ERR_INVALID_HANDLE, out),
                }
            }
            ATT_WRITE_REQ => {
                if pdu.params.len() < 2 {
                    return att_error(ATT_WRITE_REQ, 0, ERR_INVALID_LENGTH, out);
                }
                let handle = u16::from_le_bytes([pdu.params[0], pdu.params[1]]);
                let value = &pdu.params[2..];
                match self.find(handle) {
                    None => att_error(ATT_WRITE_REQ, handle, ERR_INVALID_HANDLE, out),
                    Some(a) if !a.writable => {
                        att_error(ATT_WRITE_REQ, handle, ERR_WRITE_NOT_PERMITTED, out)
                    }
                    Some(a) => match a.set(value) {
                        Ok(()) => out.extend(&[ATT_WRITE_RSP]),
                        Err(()) => att_error(ATT_WRITE_REQ, handle, ERR_INVALID_LENGTH, out),
                    },
                }
            }
            op => att_error(op, 0, 0x06 /*request not supported*/, out),
        }
    }
}

impl<const N: usize> Default for GattServer<N> {
    fn default() -> Self {
        Self::new()
    }
}

fn att_error(
    req_op: u8,
    handle: u16,
    err: u8,
    out: &mut Buf<{ ATT_VAL_MAX + 8 }>,
) -> Result<(), Overflow> {
    out.extend(&[ATT_ERROR_RSP, req_op])?;
    out.extend(&handle.to_le_bytes())?;
    out.extend(&[err])
}

// --- GAP advertising / connection state -------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GapState {
    Idle,
    Advertising,
    Connected,
}

/// BLE peripheral GAP: advertise, then a single connection (fixed, no alloc).
pub struct Peripheral {
    pub state: GapState,
    adv: Buf<31>, // legacy adv PDU payload is <=31 bytes
}

impl Peripheral {
    pub fn new() -> Self {
        Peripheral { state: GapState::Idle, adv: Buf::new() }
    }

    /// Build the advertising payload (flags + complete local name), bounded to
    /// the 31-byte legacy limit.
    pub fn set_adv(&mut self, name: &[u8]) -> Result<(), Overflow> {
        self.adv = Buf::new();
        self.adv.extend(&[0x02, 0x01, 0x06])?; // Flags: LE General Discoverable
        let n = name.len().min(29 - self.adv.len().min(29));
        self.adv.extend(&[(n + 1) as u8, 0x09])?; // AD: Complete Local Name
        self.adv.extend(&name[..n])
    }

    pub fn start_advertising(&mut self) {
        if self.state == GapState::Idle {
            self.state = GapState::Advertising;
        }
    }
    pub fn on_connect(&mut self) {
        self.state = GapState::Connected;
    }
    pub fn on_disconnect(&mut self) {
        self.state = GapState::Idle;
    }
    pub fn adv_payload(&self) -> &[u8] {
        self.adv.as_slice()
    }
}

impl Default for Peripheral {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gatt_read_write_roundtrip() {
        let mut g: GattServer<4> = GattServer::new();
        g.add(Attribute::new(0x0003, 0x2a00, b"dev", true)).unwrap();
        let mut out: Buf<{ ATT_VAL_MAX + 8 }> = Buf::new();
        // write "hi" to handle 3
        let wr = [ATT_WRITE_REQ, 0x03, 0x00, b'h', b'i'];
        g.handle_att(&AttPdu::parse(&wr).unwrap(), &mut out).unwrap();
        assert_eq!(out.as_slice(), &[ATT_WRITE_RSP]);
        // read it back
        out = Buf::new();
        let rd = [ATT_READ_REQ, 0x03, 0x00];
        g.handle_att(&AttPdu::parse(&rd).unwrap(), &mut out).unwrap();
        assert_eq!(out.as_slice(), &[ATT_READ_RSP, b'h', b'i']);
    }

    #[test]
    fn gatt_rejects_bad_handle_and_oversize() {
        let mut g: GattServer<2> = GattServer::new();
        g.add(Attribute::new(0x0003, 0x2a00, b"x", true)).unwrap();
        let mut out: Buf<{ ATT_VAL_MAX + 8 }> = Buf::new();
        // read a non-existent handle -> ATT error, not OOB.
        let rd = [ATT_READ_REQ, 0xff, 0x00];
        g.handle_att(&AttPdu::parse(&rd).unwrap(), &mut out).unwrap();
        assert_eq!(out.as_slice()[0], ATT_ERROR_RSP);
        assert_eq!(out.as_slice()[4], ERR_INVALID_HANDLE);
        // oversize write -> INVALID_LENGTH, value unchanged, no OOB.
        out = Buf::new();
        let mut wr = [0u8; 3 + ATT_VAL_MAX + 10];
        wr[0] = ATT_WRITE_REQ;
        wr[1] = 0x03;
        g.handle_att(&AttPdu::parse(&wr).unwrap(), &mut out).unwrap();
        assert_eq!(out.as_slice()[0], ATT_ERROR_RSP);
    }

    #[test]
    fn gap_state_machine() {
        let mut p = Peripheral::new();
        p.set_adv(b"heapless-c6").unwrap();
        assert!(p.adv_payload().len() <= 31);
        p.start_advertising();
        assert_eq!(p.state, GapState::Advertising);
        p.on_connect();
        assert_eq!(p.state, GapState::Connected);
        p.on_disconnect();
        assert_eq!(p.state, GapState::Idle);
    }
}
