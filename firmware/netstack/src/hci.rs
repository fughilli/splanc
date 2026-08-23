//! BLE HCI host — the host side of the Host Controller Interface, allocation-free.
//! Drives the (vendor) BLE controller over VHCI: builds HCI commands, parses HCI
//! events + ACL, and sequences advertising bring-up and the connection. Together
//! with `ble`/`gap` (L2CAP/ATT/GATT) this replaces the vendor BLE host (NimBLE):
//! the controller only owns the radio link layer.
//!
//! Packet type indicators (first VHCI byte): 0x01 command, 0x02 ACL, 0x04 event.

use crate::rx::{Buf, Overflow};

pub const H4_CMD: u8 = 0x01;
pub const H4_ACL: u8 = 0x02;
pub const H4_EVT: u8 = 0x04;

// LE / control opcodes (OGF<<10 | OCF).
const OP_RESET: u16 = 0x0C03;
const OP_SET_EVENT_MASK: u16 = 0x0C01;
const OP_LE_SET_ADV_PARAMS: u16 = 0x2006;
const OP_LE_SET_ADV_DATA: u16 = 0x2008;
const OP_LE_SET_SCAN_RSP: u16 = 0x2009;
const OP_LE_SET_ADV_ENABLE: u16 = 0x200A;
const OP_LE_SET_EVENT_MASK: u16 = 0x2001;
const OP_LE_READ_BUF_SIZE: u16 = 0x2002;
const OP_LE_READ_LOCAL_FEAT: u16 = 0x2003;
const OP_LE_SET_RANDOM_ADDR: u16 = 0x2005;

// Event codes.
const EV_CMD_COMPLETE: u8 = 0x0E;
const EV_CMD_STATUS: u8 = 0x0F;
const EV_DISCONN: u8 = 0x05;
const EV_LE_META: u8 = 0x3E;
const LE_CONN_COMPLETE: u8 = 0x01;

fn cmd(op: u16, params: &[u8], out: &mut Buf<64>) -> usize {
    out.clear();
    let _ = out.extend(&[H4_CMD]);
    let _ = out.extend(&op.to_le_bytes());
    let _ = out.extend(&[params.len() as u8]);
    let _ = out.extend(params);
    out.len()
}

/// The bring-up sequence: each `poll` step emits the next HCI command until the
/// device is advertising; `on_event` advances it as command-completes arrive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostState {
    Init,
    ResetSent,
    EvtMaskSent,
    LeMaskSent,
    BufSizeSent,
    FeatSent,
    RandAddrSent,
    AdvParamsSent,
    AdvDataSent,
    ScanRspSent,
    AdvEnableSent,
    Advertising,
    Connected(u16),
}

pub struct BleHost {
    pub state: HostState,
    adv: [u8; 32],
    adv_len: usize,
    scan_rsp: [u8; 32],
    /// Static random advertising address (little-endian; MSB has the top two bits
    /// set = static-random). Default is distinctive; the firmware overrides it.
    rand_addr: [u8; 6],
}

impl BleHost {
    pub const fn new() -> Self {
        BleHost {
            state: HostState::Init,
            adv: [0; 32],
            adv_len: 0,
            scan_rsp: [0; 32],
            rand_addr: [0x01, 0x00, 0x00, 0x00, 0xDE, 0xC0], // C0:DE:00:00:00:01
        }
    }

    /// Set the static random advertising address (LE byte order). The MSB
    /// (`addr[5]`) must have its top two bits set (static random).
    pub fn set_random_addr(&mut self, addr: [u8; 6]) {
        self.rand_addr = addr;
        self.rand_addr[5] |= 0xC0;
    }

    /// Set the advertising payload (AD structures) — e.g. flags + complete local
    /// name. Bounded to the 31-byte legacy limit.
    pub fn set_adv(&mut self, ad: &[u8]) {
        self.adv_len = ad.len().min(31);
        self.adv[1..1 + self.adv_len].copy_from_slice(&ad[..self.adv_len]);
        self.adv[0] = self.adv_len as u8; // HCI adv-data length field
    }

    /// Set the scan-response payload — AD structures returned to an active scanner
    /// (SCAN_REQ). Must NOT contain the Flags AD type (invalid in a scan response).
    pub fn set_scan_rsp(&mut self, ad: &[u8]) {
        let n = ad.len().min(31);
        self.scan_rsp[1..1 + n].copy_from_slice(&ad[..n]);
        self.scan_rsp[0] = n as u8; // HCI scan-response-data length field
    }

    /// Produce the next HCI command to send for bring-up, or 0 bytes when there's
    /// nothing to do (advertising / connected).
    pub fn poll_cmd(&mut self, out: &mut Buf<64>) -> usize {
        match self.state {
            HostState::Init => {
                self.state = HostState::ResetSent;
                cmd(OP_RESET, &[], out)
            }
            _ => 0,
        }
    }

    /// Advance on a received HCI event; returns the next command to send (if any)
    /// into `out`.
    pub fn on_event(&mut self, pkt: &[u8], out: &mut Buf<64>) -> usize {
        if pkt.len() < 3 || pkt[0] != H4_EVT {
            return 0;
        }
        let code = pkt[1];
        let params = &pkt[3..];
        match code {
            EV_CMD_COMPLETE if params.len() >= 3 => {
                let op = u16::from_le_bytes([params[1], params[2]]);
                self.after_complete(op, out)
            }
            EV_CMD_STATUS => 0,
            EV_LE_META if !params.is_empty() && params[0] == LE_CONN_COMPLETE && params.len() >= 4 => {
                let handle = u16::from_le_bytes([params[2], params[3]]) & 0x0fff;
                self.state = HostState::Connected(handle);
                0
            }
            EV_DISCONN => {
                // back to advertising after a disconnect
                self.state = HostState::AdvEnableSent;
                cmd(OP_LE_SET_ADV_ENABLE, &[0x01], out)
            }
            _ => 0,
        }
    }

    fn after_complete(&mut self, op: u16, out: &mut Buf<64>) -> usize {
        match (self.state, op) {
            (HostState::ResetSent, OP_RESET) => {
                self.state = HostState::EvtMaskSent;
                // Main HCI event mask: enable the standard events AND the LE Meta
                // Event (bit 61 = byte 7 bit 5). Without this the controller
                // suppresses ALL LE meta events, so LE Connection Complete never
                // reaches the host and connections silently fail.
                cmd(OP_SET_EVENT_MASK, &[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x3f], out)
            }
            (HostState::EvtMaskSent, _) => {
                self.state = HostState::LeMaskSent;
                // LE event mask: Connection Complete (bit0) .. LTK Request (bit4).
                cmd(OP_LE_SET_EVENT_MASK, &[0x1f, 0, 0, 0, 0, 0, 0, 0], out)
            }
            (HostState::LeMaskSent, _) => {
                // Read the controller's ACL buffer sizes + LE features, as the
                // NimBLE host does at startup (ble_hs_startup_go). Arms the ACL
                // data path before we accept a connection.
                self.state = HostState::BufSizeSent;
                cmd(OP_LE_READ_BUF_SIZE, &[], out)
            }
            (HostState::BufSizeSent, _) => {
                self.state = HostState::FeatSent;
                cmd(OP_LE_READ_LOCAL_FEAT, &[], out)
            }
            (HostState::FeatSent, _) => {
                // Set a static random address (top 2 bits = 11). Advertising with a
                // random address means a central caches our GATT DB under an address
                // that changes per firmware build, avoiding a stale GATT cache after
                // the DB layout changes.
                self.state = HostState::RandAddrSent;
                cmd(OP_LE_SET_RANDOM_ADDR, &self.rand_addr, out)
            }
            (HostState::RandAddrSent, _) => {
                self.state = HostState::AdvParamsSent;
                // adv interval 0x00A0 (100ms), connectable undirected, own addr type
                // = 1 (random — matches the address set above).
                let p = [0xa0, 0x00, 0xa0, 0x00, 0x00, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0x07, 0x00];
                cmd(OP_LE_SET_ADV_PARAMS, &p, out)
            }
            (HostState::AdvParamsSent, _) => {
                self.state = HostState::AdvDataSent;
                cmd(OP_LE_SET_ADV_DATA, &self.adv[..32], out)
            }
            (HostState::AdvDataSent, _) => {
                // Provide a scan response so an active scanner (which sends SCAN_REQ
                // before deciding to connect) completes discovery and proceeds to
                // send CONNECT_IND. Without this the central only ever scans.
                self.state = HostState::ScanRspSent;
                cmd(OP_LE_SET_SCAN_RSP, &self.scan_rsp[..32], out)
            }
            (HostState::ScanRspSent, _) => {
                self.state = HostState::AdvEnableSent;
                cmd(OP_LE_SET_ADV_ENABLE, &[0x01], out)
            }
            (HostState::AdvEnableSent, _) => {
                self.state = HostState::Advertising;
                0
            }
            _ => 0,
        }
    }

    pub fn conn_handle(&self) -> Option<u16> {
        match self.state {
            HostState::Connected(h) => Some(h),
            _ => None,
        }
    }
}

impl Default for BleHost {
    fn default() -> Self {
        Self::new()
    }
}

/// Build an HCI ACL packet carrying an L2CAP PDU on `handle` (first fragment).
pub fn acl<const N: usize>(handle: u16, l2cap: &[u8], out: &mut Buf<N>) -> Result<usize, Overflow> {
    out.clear();
    out.extend(&[H4_ACL])?;
    // PB=0b00 (first non-automatically-flushable) is what a HOST uses for the
    // start of an L2CAP PDU on LE; PB=0b10 (first-flush) is a controller->host /
    // BR-EDR value and the C6 controller drops host ACL sent with it.
    out.extend(&(handle & 0x0fff).to_le_bytes())?; // PB=00, BC=00
    out.extend(&(l2cap.len() as u16).to_le_bytes())?;
    out.extend(l2cap)?;
    Ok(out.len())
}

/// Parse an inbound HCI ACL packet -> (handle, l2cap payload).
pub fn parse_acl(pkt: &[u8]) -> Option<(u16, &[u8])> {
    if pkt.len() < 5 || pkt[0] != H4_ACL {
        return None;
    }
    let handle = u16::from_le_bytes([pkt[1], pkt[2]]) & 0x0fff;
    let dlen = u16::from_le_bytes([pkt[3], pkt[4]]) as usize;
    let data = pkt.get(5..5 + dlen)?;
    Some((handle, data))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Feed a command-complete for `op` and confirm the host advances + emits.
    fn cmd_complete(op: u16) -> [u8; 6] {
        [H4_EVT, EV_CMD_COMPLETE, 0x04, 0x01, op as u8, (op >> 8) as u8]
    }

    #[test]
    fn bringup_sequence_reaches_advertising() {
        let mut h = BleHost::new();
        h.set_adv(&[0x02, 0x01, 0x06, 0x0c, 0x09, b'h', b'e', b'a', b'p', b'l', b'e', b's', b's', b'-', b'c', b'6']);
        let mut out: Buf<64> = Buf::new();
        assert!(h.poll_cmd(&mut out) > 0 && out.as_slice()[0] == H4_CMD); // Reset
        assert_eq!(h.state, HostState::ResetSent);
        // walk the completes: Reset -> main event mask -> LE event mask -> adv params
        h.on_event(&cmd_complete(OP_RESET), &mut out);
        assert_eq!(h.state, HostState::EvtMaskSent);
        h.on_event(&cmd_complete(OP_SET_EVENT_MASK), &mut out);
        assert_eq!(h.state, HostState::LeMaskSent);
        h.on_event(&cmd_complete(OP_LE_SET_EVENT_MASK), &mut out);
        assert_eq!(h.state, HostState::BufSizeSent);
        h.on_event(&cmd_complete(OP_LE_READ_BUF_SIZE), &mut out);
        assert_eq!(h.state, HostState::FeatSent);
        h.on_event(&cmd_complete(OP_LE_READ_LOCAL_FEAT), &mut out);
        assert_eq!(h.state, HostState::RandAddrSent);
        h.on_event(&cmd_complete(OP_LE_SET_RANDOM_ADDR), &mut out);
        assert_eq!(h.state, HostState::AdvParamsSent);
        h.on_event(&cmd_complete(OP_LE_SET_ADV_PARAMS), &mut out);
        // adv data command carries our payload length.
        assert_eq!(out.as_slice()[0], H4_CMD);
        h.on_event(&cmd_complete(OP_LE_SET_ADV_DATA), &mut out);
        assert_eq!(h.state, HostState::ScanRspSent);
        h.on_event(&cmd_complete(OP_LE_SET_SCAN_RSP), &mut out);
        h.on_event(&cmd_complete(OP_LE_SET_ADV_ENABLE), &mut out);
        assert_eq!(h.state, HostState::Advertising);
    }

    #[test]
    fn connection_and_acl_roundtrip() {
        let mut h = BleHost::new();
        h.state = HostState::Advertising;
        // LE Connection Complete -> Connected(handle=0x0040)
        let ev = [H4_EVT, EV_LE_META, 0x13, LE_CONN_COMPLETE, 0x00, 0x40, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        let mut out: Buf<64> = Buf::new();
        h.on_event(&ev, &mut out);
        assert_eq!(h.conn_handle(), Some(0x40));
        // ACL build/parse round-trip.
        let l2 = [0x04, 0x00, 0x04, 0x00, 0x0b, b'h', b'i']; // len,cid,att...
        acl(0x40, &l2, &mut out).unwrap();
        let (hh, data) = parse_acl(out.as_slice()).unwrap();
        assert_eq!((hh, data), (0x40, &l2[..]));
    }
}
