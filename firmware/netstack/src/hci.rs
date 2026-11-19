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
const OP_DISCONNECT: u16 = 0x0406; // Link Control: HCI_Disconnect (OGF 0x01, OCF 0x06)
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
const LE_CONN_UPDATE_COMPLETE: u8 = 0x03;

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
    /// Negotiated connection interval in 1.25 ms units (from LE Connection Complete /
    /// Connection Update Complete). 0 when not connected. The coex arbiter uses it to
    /// predict connection-event anchors and yield the radio to BLE only around them.
    conn_interval: u16,
    /// HCI reason of the last Disconnection Complete (0 = none yet): 0x08 supervision
    /// timeout (RF/coex), 0x13 the central closed it, 0x22 LL response timeout, 0x28
    /// instant passed, 0x3e failed to establish. Telemetry only.
    last_disc_reason: u8,
    /// The scan response changed (a live rename) after bring-up already sent it to
    /// the controller: re-send LE Set Scan Response Data at the next safe point
    /// (now if advertising, else when advertising resumes after a disconnect).
    scan_rsp_dirty: bool,
    /// A live-refresh LE Set Scan Response Data is outstanding (its Command Complete
    /// is consumed here, not by the bring-up sequencer).
    scan_rsp_inflight: bool,
}

impl BleHost {
    pub const fn new() -> Self {
        BleHost {
            state: HostState::Init,
            adv: [0; 32],
            adv_len: 0,
            scan_rsp: [0; 32],
            rand_addr: [0x01, 0x00, 0x00, 0x00, 0xDE, 0xC0], // C0:DE:00:00:00:01
            conn_interval: 0,
            last_disc_reason: 0,
            scan_rsp_dirty: false,
            scan_rsp_inflight: false,
        }
    }

    /// Negotiated connection interval in 1.25 ms units (0 if not connected).
    pub fn conn_interval(&self) -> u16 {
        self.conn_interval
    }

    /// HCI reason of the last Disconnection Complete (0 = none yet).
    pub fn last_disc_reason(&self) -> u8 {
        self.last_disc_reason
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
        if self.scan_rsp[0] as usize == n && self.scan_rsp[1..1 + n] == ad[..n] {
            return; // unchanged: no HCI traffic
        }
        self.scan_rsp = [0; 32];
        self.scan_rsp[1..1 + n].copy_from_slice(&ad[..n]);
        self.scan_rsp[0] = n as u8; // HCI scan-response-data length field
        // Before the bring-up reaches LE Set Scan Response Data it sends this buffer
        // anyway; from then on the controller holds a copy, so a change (a live
        // rename) must be re-sent — see `poll_cmd` / the EV_DISCONN branch.
        self.scan_rsp_dirty = !matches!(
            self.state,
            HostState::Init
                | HostState::ResetSent
                | HostState::EvtMaskSent
                | HostState::LeMaskSent
                | HostState::BufSizeSent
                | HostState::FeatSent
                | HostState::RandAddrSent
                | HostState::AdvParamsSent
                | HostState::AdvDataSent
        );
    }

    /// Whether a scan-response change is still waiting to reach the controller.
    pub fn scan_rsp_pending(&self) -> bool {
        self.scan_rsp_dirty || self.scan_rsp_inflight
    }

    /// Produce the next HCI command to send: the bring-up Reset, or — while
    /// advertising — a live scan-response refresh after a rename. 0 bytes when
    /// there's nothing to do. Safe to call every loop.
    ///
    /// The refresh is a bare LE Set Scan Response Data with advertising left ON:
    /// for legacy advertising the spec lets the host change the data while enabled
    /// (the controller uses it from the next advertising event), which avoids an
    /// Enable(0)/Enable(1) gap in which the board is undiscoverable.
    pub fn poll_cmd(&mut self, out: &mut Buf<64>) -> usize {
        match self.state {
            HostState::Init => {
                self.state = HostState::ResetSent;
                cmd(OP_RESET, &[], out)
            }
            HostState::Advertising if self.scan_rsp_dirty && !self.scan_rsp_inflight => {
                self.scan_rsp_dirty = false;
                self.scan_rsp_inflight = true;
                cmd(OP_LE_SET_SCAN_RSP, &self.scan_rsp[..32], out)
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
                if op == OP_LE_SET_SCAN_RSP && self.scan_rsp_inflight {
                    // The live refresh's completion — not a bring-up step.
                    self.scan_rsp_inflight = false;
                    return 0;
                }
                self.after_complete(op, out)
            }
            EV_CMD_STATUS => 0,
            EV_LE_META if !params.is_empty() && params[0] == LE_CONN_COMPLETE && params.len() >= 4 => {
                let handle = u16::from_le_bytes([params[2], params[3]]) & 0x0fff;
                self.state = HostState::Connected(handle);
                // Capture the negotiated connection interval (params[12..14], 1.25 ms units) so the
                // coex arbiter can predict connection-event anchors and yield the radio to BLE only
                // around them. NOTE: we deliberately do NOT issue an *HCI LE Connection Update* here
                // to raise the supervision timeout — measured on rig-2 it made things WORSE (a
                // peripheral-initiated update creates an LL "instant" that, if the WiFi join starves
                // BLE right then, drops the link with reason 0x28 Instant Passed even FASTER). The
                // supervision timeout IS raised (~6s, so the link rides out the ~3s AP-side DHCP-OFFER
                // stall that otherwise dropped it) — but via the spec-correct L2CAP Connection
                // Parameter Update Request the host sends on connect (ble_ffi.rs
                // conn_param_update_req_acl), which lets the CENTRAL own the LL instant. Raised
                // rig-2 single-attempt provisioning 62%->92%; see WORKLOG.
                if params.len() >= 14 {
                    self.conn_interval = u16::from_le_bytes([params[12], params[13]]);
                }
                0
            }
            EV_LE_META
                if !params.is_empty() && params[0] == LE_CONN_UPDATE_COMPLETE && params.len() >= 6 =>
            {
                // The central re-negotiated params mid-session: re-capture the interval
                // (params[4..6], 1.25 ms units) so the coex phase prediction stays aligned.
                self.conn_interval = u16::from_le_bytes([params[4], params[5]]);
                0
            }
            EV_DISCONN => {
                // params: status, handle (2), reason.
                if params.len() >= 4 {
                    self.last_disc_reason = params[3];
                }
                self.conn_interval = 0;
                if self.scan_rsp_dirty {
                    // Renamed while connected: load the new scan response first, then
                    // the bring-up tail (ScanRspSent -> Adv Enable) resumes advertising.
                    self.scan_rsp_dirty = false;
                    self.state = HostState::ScanRspSent;
                    return cmd(OP_LE_SET_SCAN_RSP, &self.scan_rsp[..32], out);
                }
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
                // adv interval 0x0140 (320 * 0.625ms = 200ms = 5Hz), connectable
                // undirected, own addr type = 1 (random — matches the address set
                // above). Slower than the old 0x00A0 (100ms/10Hz) to ease adv-channel
                // congestion when 8+ boards advertise on the same bench.
                let p = [0x40, 0x01, 0x40, 0x01, 0x00, 0x01, 0x00, 0, 0, 0, 0, 0, 0, 0x07, 0x00];
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

    /// Build a peripheral-initiated HCI_Disconnect for the current link (reason
    /// 0x13 = Remote User Terminated Connection) into `out`, or 0 bytes if not
    /// connected. The controller sends LL_TERMINATE_IND to the central and fires
    /// EV_DISCONN within ~1 connection interval — a GRACEFUL teardown, versus
    /// passively waiting the ~6s supervision timeout. Used to drop the vestigial
    /// post-provision link the moment a wss client appears, so coex stops yielding
    /// airtime to a dead link during the TLS handshake. The LE Disconnection
    /// Complete event drives the host back to advertising via on_event.
    pub fn disconnect_cmd(&self, out: &mut Buf<64>) -> usize {
        match self.state {
            HostState::Connected(h) => {
                let mut p = [0u8; 3];
                p[0..2].copy_from_slice(&h.to_le_bytes());
                p[2] = 0x13; // Remote User Terminated Connection
                cmd(OP_DISCONNECT, &p, out)
            }
            _ => 0,
        }
    }
}

impl Default for BleHost {
    fn default() -> Self {
        Self::new()
    }
}

/// Largest name that fits a legacy scan response as one AD structure
/// (31 bytes - length - type).
pub const NAME_AD_MAX: usize = 29;

/// Build the scan-response Local Name AD structure for `name` into `out`
/// (`[len][type][name..]`), returning its length (0 for an empty name). A name
/// that fits is a Complete Local Name (0x09); a longer one is cut to
/// [`NAME_AD_MAX`] bytes at a UTF-8 character boundary and marked Shortened
/// (0x08), so it never overflows the 31-byte payload nor ends in half a character.
pub fn name_ad(name: &[u8], out: &mut [u8; 31]) -> usize {
    if name.is_empty() {
        return 0;
    }
    let (n, ty) = if name.len() <= NAME_AD_MAX {
        (name.len(), 0x09)
    } else {
        let mut n = NAME_AD_MAX;
        // Back off continuation bytes (10xxxxxx) so the cut lands on a char start.
        while n > 0 && name[n] & 0xC0 == 0x80 {
            n -= 1;
        }
        (n, 0x08)
    };
    out[0] = (n + 1) as u8;
    out[1] = ty;
    out[2..2 + n].copy_from_slice(&name[..n]);
    n + 2
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

    fn bring_up(h: &mut BleHost) {
        let mut out: Buf<64> = Buf::new();
        h.poll_cmd(&mut out);
        for op in [
            OP_RESET,
            OP_SET_EVENT_MASK,
            OP_LE_SET_EVENT_MASK,
            OP_LE_READ_BUF_SIZE,
            OP_LE_READ_LOCAL_FEAT,
            OP_LE_SET_RANDOM_ADDR,
            OP_LE_SET_ADV_PARAMS,
            OP_LE_SET_ADV_DATA,
            OP_LE_SET_SCAN_RSP,
            OP_LE_SET_ADV_ENABLE,
        ] {
            h.on_event(&cmd_complete(op), &mut out);
        }
        assert_eq!(h.state, HostState::Advertising);
    }

    fn opcode(out: &Buf<64>) -> u16 {
        let s = out.as_slice();
        u16::from_le_bytes([s[1], s[2]])
    }

    fn name_rsp(name: &[u8]) -> ([u8; 31], usize) {
        let mut ad = [0u8; 31];
        let n = name_ad(name, &mut ad);
        (ad, n)
    }

    #[test]
    fn name_ad_complete_and_shortened() {
        let (ad, n) = name_rsp(b"Kitchen");
        assert_eq!(&ad[..n], &[8, 0x09, b'K', b'i', b't', b'c', b'h', b'e', b'n']);
        // Exactly 29 bytes still fits as Complete.
        let name29 = [b'a'; 29];
        let (ad, n) = name_rsp(&name29);
        assert_eq!((n, ad[0], ad[1]), (31, 30, 0x09));
        // 32 bytes (the firmware maximum) is cut to 29 and marked Shortened.
        let name32 = [b'b'; 32];
        let (ad, n) = name_rsp(&name32);
        assert_eq!((n, ad[0], ad[1]), (31, 30, 0x08));
        assert!(ad[2..31].iter().all(|&c| c == b'b'));
        assert_eq!(name_rsp(b"").1, 0);
    }

    #[test]
    fn name_ad_cuts_on_utf8_boundary() {
        // 28 ASCII bytes + a 3-byte char straddles the 29-byte budget: drop the char.
        let mut name = [b'x'; 31];
        name[28..31].copy_from_slice("€".as_bytes());
        let (ad, n) = name_rsp(&name);
        assert_eq!((n, ad[0], ad[1]), (30, 29, 0x08));
        assert!(core::str::from_utf8(&ad[2..n]).is_ok());
    }

    #[test]
    fn rename_while_advertising_resends_scan_rsp_only() {
        let mut h = BleHost::new();
        let (ad, n) = name_rsp(b"Old");
        h.set_scan_rsp(&ad[..n]); // before bring-up: rides the bring-up, no refresh
        bring_up(&mut h);
        let mut out: Buf<64> = Buf::new();
        assert_eq!(h.poll_cmd(&mut out), 0);
        assert!(!h.scan_rsp_pending());

        let (ad, n) = name_rsp(b"New name");
        h.set_scan_rsp(&ad[..n]);
        assert!(h.scan_rsp_pending());
        assert!(h.poll_cmd(&mut out) > 0);
        assert_eq!(opcode(&out), OP_LE_SET_SCAN_RSP);
        // HCI param block: [len][31 bytes data] — the new name AD, zero padded.
        let p = &out.as_slice()[4..];
        assert_eq!(p.len(), 32);
        assert_eq!(p[0] as usize, n);
        assert_eq!(&p[1..1 + n], &ad[..n]);
        assert!(p[1 + n..].iter().all(|&b| b == 0));
        // One in flight at a time; advertising stays enabled throughout.
        assert_eq!(h.poll_cmd(&mut out), 0);
        assert_eq!(h.on_event(&cmd_complete(OP_LE_SET_SCAN_RSP), &mut out), 0);
        assert_eq!(h.state, HostState::Advertising);
        assert!(!h.scan_rsp_pending());
        assert_eq!(h.poll_cmd(&mut out), 0);
        // Setting the same name again is free.
        h.set_scan_rsp(&ad[..n]);
        assert!(!h.scan_rsp_pending());
    }

    #[test]
    fn rename_during_inflight_refresh_queues_another() {
        let mut h = BleHost::new();
        bring_up(&mut h);
        let mut out: Buf<64> = Buf::new();
        let (ad, n) = name_rsp(b"A");
        h.set_scan_rsp(&ad[..n]);
        assert!(h.poll_cmd(&mut out) > 0);
        let (ad, n) = name_rsp(b"B");
        h.set_scan_rsp(&ad[..n]);
        assert_eq!(h.poll_cmd(&mut out), 0); // waits for the first completion
        h.on_event(&cmd_complete(OP_LE_SET_SCAN_RSP), &mut out);
        assert!(h.poll_cmd(&mut out) > 0);
        assert_eq!(out.as_slice()[7], b'B');
    }

    #[test]
    fn rename_while_connected_applies_when_advertising_resumes() {
        let mut h = BleHost::new();
        bring_up(&mut h);
        let mut out: Buf<64> = Buf::new();
        let conn = [H4_EVT, EV_LE_META, 0x13, LE_CONN_COMPLETE, 0x00, 0x40, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        h.on_event(&conn, &mut out);
        assert_eq!(h.conn_handle(), Some(0x40));
        let (ad, n) = name_rsp(b"Renamed");
        h.set_scan_rsp(&ad[..n]);
        // Connected: nothing is sent, the link is untouched.
        assert_eq!(h.poll_cmd(&mut out), 0);
        assert_eq!(h.conn_handle(), Some(0x40));
        // Disconnect: new scan response first, then advertising enable.
        let disc = [H4_EVT, EV_DISCONN, 0x04, 0x00, 0x40, 0x00, 0x13];
        assert!(h.on_event(&disc, &mut out) > 0);
        assert_eq!(opcode(&out), OP_LE_SET_SCAN_RSP);
        assert_eq!(&out.as_slice()[5..5 + n], &ad[..n]);
        assert!(h.on_event(&cmd_complete(OP_LE_SET_SCAN_RSP), &mut out) > 0);
        assert_eq!(opcode(&out), OP_LE_SET_ADV_ENABLE);
        h.on_event(&cmd_complete(OP_LE_SET_ADV_ENABLE), &mut out);
        assert_eq!(h.state, HostState::Advertising);
        assert!(!h.scan_rsp_pending());
    }

    #[test]
    fn disconnect_without_rename_just_reenables() {
        let mut h = BleHost::new();
        bring_up(&mut h);
        h.state = HostState::Connected(0x40);
        let mut out: Buf<64> = Buf::new();
        let disc = [H4_EVT, EV_DISCONN, 0x04, 0x00, 0x40, 0x00, 0x13];
        h.on_event(&disc, &mut out);
        assert_eq!(opcode(&out), OP_LE_SET_ADV_ENABLE);
    }

    #[test]
    fn rename_mid_bringup_rides_the_bringup() {
        let mut h = BleHost::new();
        let mut out: Buf<64> = Buf::new();
        h.poll_cmd(&mut out);
        for op in [OP_RESET, OP_SET_EVENT_MASK, OP_LE_SET_EVENT_MASK, OP_LE_READ_BUF_SIZE,
                   OP_LE_READ_LOCAL_FEAT, OP_LE_SET_RANDOM_ADDR, OP_LE_SET_ADV_PARAMS] {
            h.on_event(&cmd_complete(op), &mut out);
        }
        assert_eq!(h.state, HostState::AdvDataSent);
        let (ad, n) = name_rsp(b"Early");
        h.set_scan_rsp(&ad[..n]);
        assert!(!h.scan_rsp_pending());
        h.on_event(&cmd_complete(OP_LE_SET_ADV_DATA), &mut out);
        assert_eq!(opcode(&out), OP_LE_SET_SCAN_RSP);
        assert_eq!(&out.as_slice()[5..5 + n], &ad[..n]);
    }
}
