//! A bounded GATT server with service/characteristic discovery and 128-bit UUIDs.
//!
//! The attribute database is a fixed array built by [`GattDb::add_primary_service`]
//! / [`GattDb::add_characteristic`], which assign handles and synthesise the
//! declaration attributes. [`GattDb::handle_att`] answers the ATT requests a
//! central issues while discovering + using the services (MTU exchange, group/type
//! reads for discovery, find-information for descriptors, and value read/write),
//! and [`GattDb::notification`] builds a Handle Value Notification.
//!
//! Everything is `no_std` and bounded: a crafted request (bad handle, oversize
//! write, out-of-range discovery) yields an ATT error response, never an OOB.

use crate::rx::{Buf, Overflow};

/// Max stored value per attribute (Improv SendWifi RPC ≈ 100 bytes).
pub const GATT_VAL_MAX: usize = 100;
/// ATT server MTU we advertise (data is still bounded by our buffers).
pub const ATT_MTU: u16 = 185;
/// Response buffer bound (fits one MTU worth of discovery/read payload).
pub const GATT_RSP_MAX: usize = ATT_MTU as usize;

// ATT opcodes.
const ATT_ERROR_RSP: u8 = 0x01;
const ATT_EXCHANGE_MTU_REQ: u8 = 0x02;
const ATT_EXCHANGE_MTU_RSP: u8 = 0x03;
const ATT_FIND_INFORMATION_REQ: u8 = 0x04;
const ATT_FIND_INFORMATION_RSP: u8 = 0x05;
const ATT_READ_BY_TYPE_REQ: u8 = 0x08;
const ATT_READ_BY_TYPE_RSP: u8 = 0x09;
const ATT_READ_REQ: u8 = 0x0a;
const ATT_READ_RSP: u8 = 0x0b;
const ATT_READ_BY_GROUP_TYPE_REQ: u8 = 0x10;
const ATT_READ_BY_GROUP_TYPE_RSP: u8 = 0x11;
const ATT_WRITE_REQ: u8 = 0x12;
const ATT_WRITE_RSP: u8 = 0x13;
const ATT_WRITE_CMD: u8 = 0x52;
const ATT_HANDLE_VALUE_NTF: u8 = 0x1b;

// ATT error codes.
const ERR_INVALID_HANDLE: u8 = 0x01;
const ERR_WRITE_NOT_PERMITTED: u8 = 0x03;
const ERR_INVALID_LENGTH: u8 = 0x0d;
const ERR_REQUEST_NOT_SUPPORTED: u8 = 0x06;
const ERR_ATTRIBUTE_NOT_FOUND: u8 = 0x0a;

// GATT declaration UUIDs (16-bit).
const UUID_PRIMARY_SERVICE: u16 = 0x2800;
const UUID_CHARACTERISTIC: u16 = 0x2803;
const UUID_CCCD: u16 = 0x2902;

// Characteristic property bits.
pub const PROP_READ: u8 = 0x02;
pub const PROP_WRITE_NO_RSP: u8 = 0x04;
pub const PROP_WRITE: u8 = 0x08;
pub const PROP_NOTIFY: u8 = 0x10;

/// A 16- or 128-bit UUID (128-bit bytes are in on-air little-endian order).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Uuid {
    U16(u16),
    U128([u8; 16]),
}

impl Uuid {
    fn len(&self) -> usize {
        match self {
            Uuid::U16(_) => 2,
            Uuid::U128(_) => 16,
        }
    }
    fn write(&self, out: &mut Buf<GATT_RSP_MAX>) -> Result<(), Overflow> {
        match self {
            Uuid::U16(v) => out.extend(&v.to_le_bytes()),
            Uuid::U128(b) => out.extend(b),
        }
    }
    /// Match this attribute type against a requested type UUID (raw bytes).
    fn matches(&self, want: &[u8]) -> bool {
        match self {
            Uuid::U16(v) => want.len() == 2 && want == v.to_le_bytes(),
            Uuid::U128(b) => want.len() == 16 && want == b,
        }
    }
}

/// One attribute: handle + type UUID + inline bounded value + access flags.
struct Attr {
    handle: u16,
    uuid: Uuid,
    value: Buf<GATT_VAL_MAX>,
    readable: bool,
    writable: bool,
}

impl Attr {
    fn new(handle: u16, uuid: Uuid, val: &[u8], readable: bool, writable: bool) -> Self {
        let mut value = Buf::new();
        let _ = value.extend(&val[..val.len().min(GATT_VAL_MAX)]);
        Attr { handle, uuid, value, readable, writable }
    }
}

/// Fixed-capacity GATT database (`N` attributes; services + characteristics +
/// their value/CCCD attributes each consume entries).
pub struct GattDb<const N: usize> {
    attrs: [Option<Attr>; N],
    count: usize,
    next_handle: u16,
    /// The negotiated ATT MTU. A response PDU must be <= this; before any MTU
    /// exchange the BLE default (23) applies, so discovery responses that ignore
    /// it overflow the client and get discarded.
    mtu: u16,
}

impl<const N: usize> GattDb<N> {
    pub const fn new() -> Self {
        const NONE: Option<Attr> = None;
        GattDb { attrs: [NONE; N], count: 0, next_handle: 1, mtu: 23 }
    }

    fn push(&mut self, a: Attr) -> Result<u16, Overflow> {
        if self.count >= N {
            return Err(Overflow);
        }
        let h = a.handle;
        self.attrs[self.count] = Some(a);
        self.count += 1;
        Ok(h)
    }

    /// Add a primary-service declaration. Returns its handle.
    pub fn add_primary_service(&mut self, svc: Uuid) -> Result<u16, Overflow> {
        let h = self.next_handle;
        let mut decl: Buf<GATT_VAL_MAX> = Buf::new();
        match svc {
            Uuid::U16(v) => decl.extend(&v.to_le_bytes())?,
            Uuid::U128(b) => decl.extend(&b)?,
        }
        self.next_handle += 1;
        self.push(Attr::new(h, Uuid::U16(UUID_PRIMARY_SERVICE), decl.as_slice(), true, false))
    }

    /// Add a characteristic (declaration + value, plus a CCCD if it notifies).
    /// Returns the value handle.
    pub fn add_characteristic(
        &mut self,
        uuid: Uuid,
        props: u8,
        initial: &[u8],
    ) -> Result<u16, Overflow> {
        let decl_h = self.next_handle;
        let val_h = decl_h + 1;
        // Declaration value: [props][value_handle:2][char UUID].
        let mut decl: Buf<GATT_VAL_MAX> = Buf::new();
        decl.extend(&[props])?;
        decl.extend(&val_h.to_le_bytes())?;
        match uuid {
            Uuid::U16(v) => decl.extend(&v.to_le_bytes())?,
            Uuid::U128(b) => decl.extend(&b)?,
        }
        self.next_handle += 2;
        self.push(Attr::new(decl_h, Uuid::U16(UUID_CHARACTERISTIC), decl.as_slice(), true, false))?;
        let readable = props & PROP_READ != 0;
        let writable = props & (PROP_WRITE | PROP_WRITE_NO_RSP) != 0;
        self.push(Attr::new(val_h, uuid, initial, readable, writable))?;
        if props & PROP_NOTIFY != 0 {
            let cccd_h = self.next_handle;
            self.next_handle += 1;
            self.push(Attr::new(cccd_h, Uuid::U16(UUID_CCCD), &[0, 0], true, true))?;
        }
        Ok(val_h)
    }

    fn iter(&self) -> impl Iterator<Item = &Attr> {
        self.attrs[..self.count].iter().flatten()
    }
    fn find(&mut self, handle: u16) -> Option<&mut Attr> {
        self.attrs[..self.count].iter_mut().flatten().find(|a| a.handle == handle)
    }

    /// Read the current value of `handle` (for the firmware to inspect/update).
    pub fn value_of(&self, handle: u16) -> Option<&[u8]> {
        self.iter().find(|a| a.handle == handle).map(|a| a.value.as_slice())
    }
    /// Set an attribute's value (e.g. update a notify characteristic before
    /// sending a notification). Ignores unknown handles / oversize values.
    pub fn set_value(&mut self, handle: u16, val: &[u8]) {
        if val.len() > GATT_VAL_MAX {
            return;
        }
        if let Some(a) = self.find(handle) {
            a.value.clear();
            let _ = a.value.extend(val);
        }
    }

    /// Handle an ATT request, writing the response into `out`. Returns the
    /// response length (0 for a write-command, which has no response).
    pub fn handle_att(&mut self, opcode: u8, params: &[u8], out: &mut Buf<GATT_RSP_MAX>) -> usize {
        out.clear();
        let r = match opcode {
            ATT_EXCHANGE_MTU_REQ => self.mtu(params, out),
            ATT_READ_BY_GROUP_TYPE_REQ => self.read_by_group_type(params, out),
            ATT_READ_BY_TYPE_REQ => self.read_by_type(params, out),
            ATT_FIND_INFORMATION_REQ => self.find_information(params, out),
            ATT_READ_REQ => self.read(params, out),
            ATT_WRITE_REQ => self.write(params, out, true),
            ATT_WRITE_CMD => return self.write_cmd(params),
            op => att_error(op, 0, ERR_REQUEST_NOT_SUPPORTED, out),
        };
        let _ = r;
        out.len()
    }

    fn mtu(&mut self, params: &[u8], out: &mut Buf<GATT_RSP_MAX>) -> Result<(), Overflow> {
        // Negotiated MTU = min(client, server); never below the 23-byte minimum.
        if params.len() >= 2 {
            let client = u16::from_le_bytes([params[0], params[1]]);
            self.mtu = client.min(ATT_MTU).max(23);
        }
        out.extend(&[ATT_EXCHANGE_MTU_RSP])?;
        out.extend(&ATT_MTU.to_le_bytes())
    }

    /// Response byte budget = the negotiated MTU (a response PDU must fit in it).
    fn budget(&self) -> usize {
        self.mtu as usize
    }

    /// ATT_READ_BY_GROUP_TYPE — primary-service discovery.
    fn read_by_group_type(&self, params: &[u8], out: &mut Buf<GATT_RSP_MAX>) -> Result<(), Overflow> {
        let Some((start, end, ty)) = parse_range_type(params) else {
            return att_error(ATT_READ_BY_GROUP_TYPE_REQ, 0, ERR_INVALID_LENGTH, out);
        };
        if !matches_u16(ty, UUID_PRIMARY_SERVICE) {
            return att_error(ATT_READ_BY_GROUP_TYPE_REQ, start, ERR_REQUEST_NOT_SUPPORTED, out);
        }
        // Element = [handle:2][end_group:2][service UUID]; all elements same len.
        let mut wrote = false;
        let mut elem_len = 0usize;
        for a in self.iter() {
            if a.handle < start || a.handle > end || a.uuid != Uuid::U16(UUID_PRIMARY_SERVICE) {
                continue;
            }
            let this_len = 4 + a.value.len();
            if !wrote {
                elem_len = this_len;
                out.extend(&[ATT_READ_BY_GROUP_TYPE_RSP, elem_len as u8])?;
            } else if this_len != elem_len || out.len() + elem_len > self.budget() {
                break; // format change or full: stop (client re-queries from next)
            }
            let end_group = self.service_end(a.handle);
            out.extend(&a.handle.to_le_bytes())?;
            out.extend(&end_group.to_le_bytes())?;
            out.extend(a.value.as_slice())?;
            wrote = true;
        }
        if !wrote {
            return att_error(ATT_READ_BY_GROUP_TYPE_REQ, start, ERR_ATTRIBUTE_NOT_FOUND, out);
        }
        Ok(())
    }

    /// The end-group handle of the service starting at `svc_handle`: the last
    /// attribute handle before the next primary service (or the max handle).
    fn service_end(&self, svc_handle: u16) -> u16 {
        let mut end = svc_handle;
        let mut next_svc = u16::MAX;
        for a in self.iter() {
            if a.uuid == Uuid::U16(UUID_PRIMARY_SERVICE)
                && a.handle > svc_handle
                && a.handle < next_svc
            {
                next_svc = a.handle;
            }
        }
        for a in self.iter() {
            if a.handle > end && a.handle < next_svc {
                end = a.handle;
            }
        }
        end
    }

    /// ATT_READ_BY_TYPE — characteristic discovery (or any typed read).
    fn read_by_type(&self, params: &[u8], out: &mut Buf<GATT_RSP_MAX>) -> Result<(), Overflow> {
        let Some((start, end, ty)) = parse_range_type(params) else {
            return att_error(ATT_READ_BY_TYPE_REQ, 0, ERR_INVALID_LENGTH, out);
        };
        let mut wrote = false;
        let mut elem_len = 0usize;
        for a in self.iter() {
            if a.handle < start || a.handle > end || !a.uuid.matches(ty) {
                continue;
            }
            let this_len = 2 + a.value.len();
            if !wrote {
                elem_len = this_len;
                out.extend(&[ATT_READ_BY_TYPE_RSP, elem_len as u8])?;
            } else if this_len != elem_len || out.len() + elem_len > self.budget() {
                break;
            }
            out.extend(&a.handle.to_le_bytes())?;
            out.extend(a.value.as_slice())?;
            wrote = true;
        }
        if !wrote {
            return att_error(ATT_READ_BY_TYPE_REQ, start, ERR_ATTRIBUTE_NOT_FOUND, out);
        }
        Ok(())
    }

    /// ATT_FIND_INFORMATION — descriptor discovery (handle + UUID pairs).
    fn find_information(&self, params: &[u8], out: &mut Buf<GATT_RSP_MAX>) -> Result<(), Overflow> {
        if params.len() < 4 {
            return att_error(ATT_FIND_INFORMATION_REQ, 0, ERR_INVALID_LENGTH, out);
        }
        let start = u16::from_le_bytes([params[0], params[1]]);
        let end = u16::from_le_bytes([params[2], params[3]]);
        let mut wrote = false;
        let mut fmt = 0u8; // 1 = 16-bit, 2 = 128-bit
        for a in self.iter() {
            if a.handle < start || a.handle > end {
                continue;
            }
            let this_fmt = if a.uuid.len() == 2 { 1 } else { 2 };
            let elem_len = 2 + a.uuid.len();
            if !wrote {
                fmt = this_fmt;
                out.extend(&[ATT_FIND_INFORMATION_RSP, fmt])?;
            } else if this_fmt != fmt || out.len() + elem_len > self.budget() {
                break;
            }
            out.extend(&a.handle.to_le_bytes())?;
            a.uuid.write(out)?;
            wrote = true;
        }
        if !wrote {
            return att_error(ATT_FIND_INFORMATION_REQ, start, ERR_ATTRIBUTE_NOT_FOUND, out);
        }
        Ok(())
    }

    fn read(&mut self, params: &[u8], out: &mut Buf<GATT_RSP_MAX>) -> Result<(), Overflow> {
        if params.len() < 2 {
            return att_error(ATT_READ_REQ, 0, ERR_INVALID_LENGTH, out);
        }
        let handle = u16::from_le_bytes([params[0], params[1]]);
        let budget = self.budget();
        match self.iter().find(|a| a.handle == handle) {
            Some(a) if a.readable => {
                let n = a.value.len().min(budget - 1); // Read Response: opcode + value

                let val: Buf<GATT_VAL_MAX> = {
                    let mut b = Buf::new();
                    let _ = b.extend(&a.value.as_slice()[..n]);
                    b
                };
                out.extend(&[ATT_READ_RSP])?;
                out.extend(val.as_slice())
            }
            Some(_) => att_error(ATT_READ_REQ, handle, ERR_WRITE_NOT_PERMITTED, out),
            None => att_error(ATT_READ_REQ, handle, ERR_INVALID_HANDLE, out),
        }
    }

    fn write(&mut self, params: &[u8], out: &mut Buf<GATT_RSP_MAX>, respond: bool) -> Result<(), Overflow> {
        if params.len() < 2 {
            return att_error(ATT_WRITE_REQ, 0, ERR_INVALID_LENGTH, out);
        }
        let handle = u16::from_le_bytes([params[0], params[1]]);
        let value = &params[2..];
        if value.len() > GATT_VAL_MAX {
            return att_error(ATT_WRITE_REQ, handle, ERR_INVALID_LENGTH, out);
        }
        match self.find(handle) {
            None => att_error(ATT_WRITE_REQ, handle, ERR_INVALID_HANDLE, out),
            Some(a) if !a.writable => att_error(ATT_WRITE_REQ, handle, ERR_WRITE_NOT_PERMITTED, out),
            Some(a) => {
                a.value.clear();
                a.value.extend(value)?;
                if respond {
                    out.extend(&[ATT_WRITE_RSP])?;
                }
                Ok(())
            }
        }
    }

    fn write_cmd(&mut self, params: &[u8]) -> usize {
        let mut sink: Buf<GATT_RSP_MAX> = Buf::new();
        let _ = self.write(params, &mut sink, false);
        0 // write-command: no response
    }

    /// Build a Handle Value Notification for `handle` into `out`. Returns 0 if the
    /// handle is unknown.
    pub fn notification(&self, handle: u16, out: &mut Buf<GATT_RSP_MAX>) -> usize {
        out.clear();
        if let Some(v) = self.value_of(handle) {
            let n = v.len().min(ATT_MTU as usize - 3);
            let _ = out.extend(&[ATT_HANDLE_VALUE_NTF]);
            let _ = out.extend(&handle.to_le_bytes());
            let _ = out.extend(&v[..n]);
        }
        out.len()
    }
}

impl<const N: usize> Default for GattDb<N> {
    fn default() -> Self {
        Self::new()
    }
}

fn matches_u16(raw: &[u8], v: u16) -> bool {
    raw.len() == 2 && raw == v.to_le_bytes()
}

/// Parse [start:2][end:2][type: 2 or 16] from a group/type request.
fn parse_range_type(params: &[u8]) -> Option<(u16, u16, &[u8])> {
    if params.len() < 6 {
        return None;
    }
    let start = u16::from_le_bytes([params[0], params[1]]);
    let end = u16::from_le_bytes([params[2], params[3]]);
    let ty = &params[4..];
    if ty.len() != 2 && ty.len() != 16 {
        return None;
    }
    Some((start, end, ty))
}

fn att_error(req_op: u8, handle: u16, err: u8, out: &mut Buf<GATT_RSP_MAX>) -> Result<(), Overflow> {
    out.clear();
    out.extend(&[ATT_ERROR_RSP, req_op])?;
    out.extend(&handle.to_le_bytes())?;
    out.extend(&[err])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::improv::{IMPROV_CHAR_RPC_COMMAND, IMPROV_SVC_UUID};

    fn improv_db() -> GattDb<8> {
        let mut db: GattDb<8> = GattDb::new();
        db.add_primary_service(Uuid::U128(IMPROV_SVC_UUID)).unwrap();
        db.add_characteristic(Uuid::U128(IMPROV_CHAR_RPC_COMMAND), PROP_WRITE | PROP_READ, &[0])
            .unwrap();
        db
    }

    #[test]
    fn mtu_exchange() {
        let mut db = improv_db();
        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        let n = db.handle_att(ATT_EXCHANGE_MTU_REQ, &[0x40, 0x00], &mut out);
        assert_eq!(n, 3);
        assert_eq!(out.as_slice()[0], ATT_EXCHANGE_MTU_RSP);
        assert_eq!(u16::from_le_bytes([out.as_slice()[1], out.as_slice()[2]]), ATT_MTU);
    }

    #[test]
    fn discover_primary_service_128bit() {
        let mut db = improv_db();
        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        // Read By Group Type, handles 1..0xffff, type=0x2800.
        let params = [0x01, 0x00, 0xff, 0xff, 0x00, 0x28];
        db.handle_att(ATT_READ_BY_GROUP_TYPE_REQ, &params, &mut out);
        let s = out.as_slice();
        assert_eq!(s[0], ATT_READ_BY_GROUP_TYPE_RSP);
        assert_eq!(s[1] as usize, 4 + 16); // handle+end+128bit UUID
        assert_eq!(u16::from_le_bytes([s[2], s[3]]), 1); // service handle
        assert_eq!(&s[6..22], &IMPROV_SVC_UUID); // service UUID echoed
    }

    #[test]
    fn discover_characteristic_and_read_write() {
        let mut db = improv_db();
        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        // Read By Type, type=0x2803 (characteristic declaration).
        let params = [0x01, 0x00, 0xff, 0xff, 0x03, 0x28];
        db.handle_att(ATT_READ_BY_TYPE_REQ, &params, &mut out);
        let s = out.as_slice();
        assert_eq!(s[0], ATT_READ_BY_TYPE_RSP);
        // element: [decl_handle:2][props:1][val_handle:2][char UUID:16]
        assert_eq!(s[1] as usize, 2 + 1 + 2 + 16);
        let decl_h = u16::from_le_bytes([s[2], s[3]]);
        assert_eq!(decl_h, 2);
        let props = s[4];
        assert_eq!(props, PROP_WRITE | PROP_READ);
        let val_h = u16::from_le_bytes([s[5], s[6]]);
        assert_eq!(val_h, 3);
        assert_eq!(&s[7..23], &IMPROV_CHAR_RPC_COMMAND);

        // Write the value, then read it back.
        let mut w = [0u8; 5];
        w[0..2].copy_from_slice(&val_h.to_le_bytes());
        w[2..5].copy_from_slice(&[0xaa, 0xbb, 0xcc]);
        db.handle_att(ATT_WRITE_REQ, &w, &mut out);
        assert_eq!(out.as_slice()[0], ATT_WRITE_RSP);
        db.handle_att(ATT_READ_REQ, &val_h.to_le_bytes(), &mut out);
        assert_eq!(out.as_slice(), &[ATT_READ_RSP, 0xaa, 0xbb, 0xcc]);
    }

    #[test]
    fn discovery_respects_negotiated_mtu() {
        // 5 characteristics, each a 21-byte 128-bit decl. At the default MTU (23)
        // only ONE fits per Read-By-Type response; after an MTU exchange, more do.
        let mut db: GattDb<20> = GattDb::new();
        db.add_primary_service(Uuid::U16(0x1234)).unwrap();
        for c in 0..5u16 {
            db.add_characteristic(Uuid::U128([c as u8; 16]), PROP_READ, &[0]).unwrap();
        }
        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        let p = [0x01, 0x00, 0xff, 0xff, 0x03, 0x28]; // Read By Type, char decl
        db.handle_att(ATT_READ_BY_TYPE_REQ, &p, &mut out);
        let elem = out.as_slice()[1] as usize;
        assert_eq!((out.len() - 2) / elem, 1, "default MTU 23 -> 1 char per response");

        // Negotiate a large MTU, then the same query returns all 5.
        let mut m: Buf<GATT_RSP_MAX> = Buf::new();
        db.handle_att(ATT_EXCHANGE_MTU_REQ, &[0xff, 0x00], &mut m); // client MTU 255
        db.handle_att(ATT_READ_BY_TYPE_REQ, &p, &mut out);
        assert_eq!((out.len() - 2) / elem, 5, "large MTU -> all 5 chars");
    }

    #[test]
    fn read_unknown_handle_errors() {
        let mut db = improv_db();
        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        db.handle_att(ATT_READ_REQ, &[0xfe, 0x00], &mut out);
        let s = out.as_slice();
        assert_eq!(s[0], ATT_ERROR_RSP);
        assert_eq!(s[4], ERR_INVALID_HANDLE);
    }

    #[test]
    fn discovery_out_of_range_returns_not_found() {
        let mut db = improv_db();
        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        // No services in 0x0100..0x0200.
        let params = [0x00, 0x01, 0x00, 0x02, 0x00, 0x28];
        db.handle_att(ATT_READ_BY_GROUP_TYPE_REQ, &params, &mut out);
        assert_eq!(out.as_slice()[0], ATT_ERROR_RSP);
        assert_eq!(out.as_slice()[4], ERR_ATTRIBUTE_NOT_FOUND);
    }

    #[test]
    fn notify_and_cccd_present_for_notify_char() {
        let mut db: GattDb<8> = GattDb::new();
        db.add_primary_service(Uuid::U16(0x1234)).unwrap();
        let vh = db.add_characteristic(Uuid::U16(0x5678), PROP_READ | PROP_NOTIFY, &[0x01]).unwrap();
        // A CCCD (0x2902) should exist at vh+1; find-information reveals it.
        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        let params = [(vh + 1).to_le_bytes()[0], (vh + 1).to_le_bytes()[1], 0xff, 0xff];
        db.handle_att(ATT_FIND_INFORMATION_REQ, &params, &mut out);
        let s = out.as_slice();
        assert_eq!(s[0], ATT_FIND_INFORMATION_RSP);
        assert_eq!(s[1], 1); // 16-bit format
        assert_eq!(u16::from_le_bytes([s[4], s[5]]), UUID_CCCD);
        // Notification builds for the value handle.
        db.set_value(vh, &[0x03]);
        let n = db.notification(vh, &mut out);
        assert_eq!(n, 4);
        assert_eq!(out.as_slice()[0], ATT_HANDLE_VALUE_NTF);
        assert_eq!(out.as_slice()[3], 0x03);
    }
}
