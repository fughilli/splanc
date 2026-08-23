//! Improv Wi-Fi (BLE) provisioning protocol — the RPC codec + provisioning state
//! machine, independent of the GATT transport. A central writes RPC commands to
//! the RPC-command characteristic; we parse them here, drive the state, and emit
//! current-state / RPC-result / error payloads for the notify characteristics.
//!
//! Everything is bounded and `no_std`: SSID/passphrase are copied into fixed
//! buffers, a malformed/oversize/bad-checksum packet yields an error state rather
//! than an out-of-bounds access. See <https://www.improv-wifi.com/ble/>.

use crate::rx::Buf;

/// Improv service + characteristic 128-bit UUIDs (little-endian byte order as they
/// appear on-air). Base: `00467768-6228-2272-4663-2774782680XX`.
pub const IMPROV_SVC_UUID: [u8; 16] = uuid128(0x00);
pub const IMPROV_CHAR_CURRENT_STATE: [u8; 16] = uuid128(0x01);
pub const IMPROV_CHAR_ERROR_STATE: [u8; 16] = uuid128(0x02);
pub const IMPROV_CHAR_RPC_COMMAND: [u8; 16] = uuid128(0x03);
pub const IMPROV_CHAR_RPC_RESULT: [u8; 16] = uuid128(0x04);
pub const IMPROV_CHAR_CAPABILITIES: [u8; 16] = uuid128(0x05);

/// Build an Improv 128-bit UUID (last byte `n`) in on-air little-endian order.
const fn uuid128(n: u8) -> [u8; 16] {
    // 00467768-6228-2272-4663-2774782680{n} reversed to LE.
    [
        n, 0x80, 0x26, 0x78, 0x74, 0x27, 0x63, 0x46, 0x72, 0x22, 0x28, 0x62, 0x68, 0x77, 0x46, 0x00,
    ]
}

/// Current-state characteristic values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum State {
    /// Awaiting activation/authorization (we auto-authorize: not used as a gate).
    AuthorizationRequired = 0x01,
    Authorized = 0x02,
    Provisioning = 0x03,
    Provisioned = 0x04,
}

/// Error-state characteristic values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum ErrorState {
    None = 0x00,
    InvalidRpcPacket = 0x01,
    UnknownRpcCommand = 0x02,
    UnableToConnect = 0x03,
    NotAuthorized = 0x04,
}

/// RPC command identifiers (first byte of an RPC packet).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Command {
    SendWifi = 0x01,
    Identify = 0x02,
    GetCurrentState = 0x03,
    GetDeviceInfo = 0x04,
    ScanWifi = 0x05,
}

impl Command {
    fn from_u8(v: u8) -> Option<Command> {
        match v {
            0x01 => Some(Command::SendWifi),
            0x02 => Some(Command::Identify),
            0x03 => Some(Command::GetCurrentState),
            0x04 => Some(Command::GetDeviceInfo),
            0x05 => Some(Command::ScanWifi),
            _ => None,
        }
    }
}

pub const MAX_SSID: usize = 32;
pub const MAX_PASS: usize = 64;

/// Wi-Fi credentials extracted from a SendWifi RPC.
pub struct Credentials {
    pub ssid: Buf<MAX_SSID>,
    pub pass: Buf<MAX_PASS>,
}

/// What the caller (firmware) must act on after feeding an RPC packet.
pub enum Action {
    /// Nothing to do beyond the state/error updates already applied.
    None,
    /// Central requested identify (e.g. blink an LED).
    Identify,
    /// Central sent Wi-Fi credentials: connect, then call
    /// [`Improv::provisioning_result`] with the outcome.
    Provision(Credentials),
}

/// The Improv provisioning state machine + RPC codec.
pub struct Improv {
    pub state: State,
    pub error: ErrorState,
    /// The last RPC result payload to expose on the RPC-result characteristic.
    result: Buf<64>,
    /// 1 = supports identify (bit0 of the capabilities characteristic).
    capabilities: u8,
}

impl Improv {
    pub const fn new() -> Self {
        Improv {
            state: State::Authorized, // no user-authorization gate
            error: ErrorState::None,
            result: Buf::new(),
            capabilities: 0x00,
        }
    }

    /// Capabilities characteristic value (1 byte).
    pub fn capabilities(&self) -> [u8; 1] {
        [self.capabilities]
    }
    /// Current-state characteristic value (1 byte).
    pub fn current_state(&self) -> [u8; 1] {
        [self.state as u8]
    }
    /// Error-state characteristic value (1 byte).
    pub fn error_state(&self) -> [u8; 1] {
        [self.error as u8]
    }
    /// RPC-result characteristic value.
    pub fn rpc_result(&self) -> &[u8] {
        self.result.as_slice()
    }

    /// Feed a write to the RPC-command characteristic. Validates framing +
    /// checksum, updates state/error, and returns the [`Action`] the firmware
    /// must take. A bad packet sets `error = InvalidRpcPacket` and returns
    /// `Action::None`.
    pub fn on_rpc(&mut self, pkt: &[u8]) -> Action {
        self.error = ErrorState::None;
        // Framing: [command][data_len][data..data_len][checksum].
        if pkt.len() < 3 {
            self.error = ErrorState::InvalidRpcPacket;
            return Action::None;
        }
        let data_len = pkt[1] as usize;
        if pkt.len() != data_len + 3 {
            self.error = ErrorState::InvalidRpcPacket;
            return Action::None;
        }
        // Checksum = sum of all preceding bytes, low 8 bits.
        let sum = pkt[..pkt.len() - 1].iter().fold(0u8, |a, &b| a.wrapping_add(b));
        if sum != pkt[pkt.len() - 1] {
            self.error = ErrorState::InvalidRpcPacket;
            return Action::None;
        }
        let data = &pkt[2..2 + data_len];
        match Command::from_u8(pkt[0]) {
            Some(Command::SendWifi) => self.on_send_wifi(data),
            Some(Command::Identify) => Action::Identify,
            Some(Command::GetCurrentState) => Action::None,
            Some(Command::GetDeviceInfo) => Action::None,
            Some(Command::ScanWifi) => Action::None,
            None => {
                self.error = ErrorState::UnknownRpcCommand;
                Action::None
            }
        }
    }

    /// Parse a SendWifi payload: `[ssid_len][ssid][pass_len][pass]`.
    fn on_send_wifi(&mut self, data: &[u8]) -> Action {
        let mut creds = Credentials { ssid: Buf::new(), pass: Buf::new() };
        let Some((ssid, rest)) = take_lv(data) else {
            self.error = ErrorState::InvalidRpcPacket;
            return Action::None;
        };
        let Some((pass, _)) = take_lv(rest) else {
            self.error = ErrorState::InvalidRpcPacket;
            return Action::None;
        };
        if ssid.len() > MAX_SSID || pass.len() > MAX_PASS || creds.ssid.extend(ssid).is_err()
            || creds.pass.extend(pass).is_err()
        {
            self.error = ErrorState::InvalidRpcPacket;
            return Action::None;
        }
        self.state = State::Provisioning;
        Action::Provision(creds)
    }

    /// Report the outcome of a provisioning attempt. On success, `redirect_urls`
    /// (each `&str`) are packed into the SendWifi RPC result; on failure the state
    /// reverts to Authorized with `error = UnableToConnect`.
    pub fn provisioning_result(&mut self, ok: bool, redirect_urls: &[&str]) {
        self.result.clear();
        if !ok {
            self.state = State::Authorized;
            self.error = ErrorState::UnableToConnect;
            return;
        }
        self.state = State::Provisioned;
        self.error = ErrorState::None;
        // RPC result: [command=SendWifi][data_len][ (len,str).. ][checksum].
        let mut body: Buf<48> = Buf::new();
        for url in redirect_urls {
            let b = url.as_bytes();
            if body.extend(&[b.len() as u8]).is_err() || body.extend(b).is_err() {
                return;
            }
        }
        let _ = self.result.extend(&[Command::SendWifi as u8, body.len() as u8]);
        let _ = self.result.extend(body.as_slice());
        let sum = self.result.as_slice().iter().fold(0u8, |a, &b| a.wrapping_add(b));
        let _ = self.result.extend(&[sum]);
    }
}

impl Default for Improv {
    fn default() -> Self {
        Self::new()
    }
}

// --- GATT binding: the Improv service exposed over the GATT database ----------

use crate::gatt::{
    GattDb, Uuid, GATT_RSP_MAX, PROP_NOTIFY, PROP_READ, PROP_WRITE, PROP_WRITE_NO_RSP,
};

/// What the firmware should do after feeding an ATT op to [`ImprovService`].
pub struct ImprovOutcome {
    /// ATT response length written to `out` (0 = no response, e.g. write-command).
    pub resp_len: usize,
    /// A provisioning action to perform (connect Wi-Fi / identify), if any.
    pub action: Action,
    /// Characteristic value handles whose values changed and should be notified
    /// (current-state, error-state, rpc-result), terminated by 0.
    pub notify: [u16; 3],
}

/// The Improv service bound onto a GATT database: owns the attribute layout, keeps
/// the characteristic values in sync with the [`Improv`] state machine, and routes
/// ATT writes on the RPC-command characteristic through it.
pub struct ImprovService {
    pub db: GattDb<24>,
    pub improv: Improv,
    h_current: u16,
    h_error: u16,
    h_rpc_cmd: u16,
    h_rpc_result: u16,
}

impl ImprovService {
    pub fn new() -> Self {
        let improv = Improv::new();
        let mut db: GattDb<24> = GattDb::new();
        // Standard GATT Service (0x1801) with the feature characteristics a central
        // probes during robust-caching setup: Server (0x2B3A) + Client (0x2B29)
        // Supported Features. Without a GATT service, BlueZ's probe gets Attribute
        // Not Found and stops before characteristic discovery.
        let _ = db.add_primary_service(Uuid::U16(0x1801));
        let _ = db.add_characteristic(Uuid::U16(0x2B3A), PROP_READ, &[0x00]);
        let _ = db.add_characteristic(Uuid::U16(0x2B29), PROP_READ | PROP_WRITE, &[0x00]);
        let _ = db.add_primary_service(Uuid::U128(IMPROV_SVC_UUID));
        // Order per spec; each value handle is used by the central after discovery.
        let h_current = db
            .add_characteristic(Uuid::U128(IMPROV_CHAR_CURRENT_STATE), PROP_READ | PROP_NOTIFY, &improv.current_state())
            .unwrap_or(0);
        let h_error = db
            .add_characteristic(Uuid::U128(IMPROV_CHAR_ERROR_STATE), PROP_READ | PROP_NOTIFY, &improv.error_state())
            .unwrap_or(0);
        let h_rpc_cmd = db
            .add_characteristic(Uuid::U128(IMPROV_CHAR_RPC_COMMAND), PROP_WRITE | PROP_WRITE_NO_RSP, &[])
            .unwrap_or(0);
        let h_rpc_result = db
            .add_characteristic(Uuid::U128(IMPROV_CHAR_RPC_RESULT), PROP_READ | PROP_NOTIFY, &[])
            .unwrap_or(0);
        let _ = db.add_characteristic(Uuid::U128(IMPROV_CHAR_CAPABILITIES), PROP_READ, &improv.capabilities());
        ImprovService { db, improv, h_current, h_error, h_rpc_cmd, h_rpc_result }
    }

    /// Copy the current Improv state into the characteristic values.
    fn sync(&mut self) {
        self.db.set_value(self.h_current, &self.improv.current_state());
        self.db.set_value(self.h_error, &self.improv.error_state());
        self.db.set_value(self.h_rpc_result, self.improv.rpc_result());
    }

    /// Handle an ATT op. Writes to the RPC-command characteristic drive the Improv
    /// state machine; everything else is a plain GATT read/discovery. Returns the
    /// response length, any provisioning [`Action`], and the changed value handles.
    pub fn handle_att(&mut self, opcode: u8, params: &[u8], out: &mut Buf<GATT_RSP_MAX>) -> ImprovOutcome {
        const ATT_WRITE_REQ: u8 = 0x12;
        const ATT_WRITE_CMD: u8 = 0x52;
        let is_rpc_write = (opcode == ATT_WRITE_REQ || opcode == ATT_WRITE_CMD)
            && params.len() >= 2
            && u16::from_le_bytes([params[0], params[1]]) == self.h_rpc_cmd;
        if is_rpc_write {
            let action = self.improv.on_rpc(&params[2..]);
            self.sync();
            let resp_len = self.db.handle_att(opcode, params, out); // records value + ACKs
            return ImprovOutcome {
                resp_len,
                action,
                notify: [self.h_current, self.h_error, self.h_rpc_result],
            };
        }
        let resp_len = self.db.handle_att(opcode, params, out);
        ImprovOutcome { resp_len, action: Action::None, notify: [0, 0, 0] }
    }

    /// After a provisioning attempt completes, update state + values (call before
    /// notifying the changed handles).
    pub fn finish_provisioning(&mut self, ok: bool, redirect_urls: &[&str]) {
        self.improv.provisioning_result(ok, redirect_urls);
        self.sync();
    }

    /// Value handles for the notify characteristics.
    pub fn current_state_handle(&self) -> u16 {
        self.h_current
    }
    pub fn error_state_handle(&self) -> u16 {
        self.h_error
    }
    pub fn rpc_result_handle(&self) -> u16 {
        self.h_rpc_result
    }
}

impl Default for ImprovService {
    fn default() -> Self {
        Self::new()
    }
}

/// Split a length-prefixed value off the front: `[len][bytes..len]` -> (bytes, rest).
fn take_lv(data: &[u8]) -> Option<(&[u8], &[u8])> {
    let len = *data.first()? as usize;
    if data.len() < 1 + len {
        return None;
    }
    Some((&data[1..1 + len], &data[1 + len..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a valid RPC packet [cmd][len][data][checksum].
    fn rpc(cmd: u8, data: &[u8]) -> Buf<128> {
        let mut b: Buf<128> = Buf::new();
        b.extend(&[cmd, data.len() as u8]).unwrap();
        b.extend(data).unwrap();
        let sum = b.as_slice().iter().fold(0u8, |a, &x| a.wrapping_add(x));
        b.extend(&[sum]).unwrap();
        b
    }

    #[test]
    fn uuids_are_improv_base() {
        // Full on-air LE bytes of 00467768-6228-2272-4663-277478268000.
        assert_eq!(
            IMPROV_SVC_UUID,
            [
                0x00, 0x80, 0x26, 0x78, 0x74, 0x27, 0x63, 0x46, 0x72, 0x22, 0x28, 0x62, 0x68, 0x77,
                0x46, 0x00
            ]
        );
        // Only the last string byte (on-air index 0) varies per characteristic.
        assert_eq!(IMPROV_CHAR_RPC_COMMAND[0], 0x03);
        assert_eq!(IMPROV_CHAR_CAPABILITIES[0], 0x05);
        assert_eq!(IMPROV_CHAR_RPC_COMMAND[1..], IMPROV_SVC_UUID[1..]);
    }

    #[test]
    fn send_wifi_extracts_credentials_and_provisions() {
        let mut im = Improv::new();
        // data = [ssid_len]"net"[pass_len]"secret"
        let mut data: Buf<64> = Buf::new();
        data.extend(&[3]).unwrap();
        data.extend(b"net").unwrap();
        data.extend(&[6]).unwrap();
        data.extend(b"secret").unwrap();
        let pkt = rpc(Command::SendWifi as u8, data.as_slice());
        match im.on_rpc(pkt.as_slice()) {
            Action::Provision(c) => {
                assert_eq!(c.ssid.as_slice(), b"net");
                assert_eq!(c.pass.as_slice(), b"secret");
            }
            _ => panic!("expected Provision"),
        }
        assert_eq!(im.state, State::Provisioning);
        assert_eq!(im.error, ErrorState::None);

        im.provisioning_result(true, &["http://192.168.1.5"]);
        assert_eq!(im.state, State::Provisioned);
        // result parses back: cmd=SendWifi, one url.
        let r = im.rpc_result();
        assert_eq!(r[0], Command::SendWifi as u8);
        let sum = r[..r.len() - 1].iter().fold(0u8, |a, &b| a.wrapping_add(b));
        assert_eq!(sum, r[r.len() - 1]); // checksum valid
    }

    #[test]
    fn bad_checksum_sets_invalid_error() {
        let mut im = Improv::new();
        let mut pkt = rpc(Command::Identify as u8, &[]);
        let n = pkt.len();
        pkt.as_mut_slice()[n - 1] ^= 0xff; // corrupt checksum
        assert!(matches!(im.on_rpc(pkt.as_slice()), Action::None));
        assert_eq!(im.error, ErrorState::InvalidRpcPacket);
    }

    #[test]
    fn unknown_command_sets_error() {
        let mut im = Improv::new();
        let pkt = rpc(0x7f, &[]);
        assert!(matches!(im.on_rpc(pkt.as_slice()), Action::None));
        assert_eq!(im.error, ErrorState::UnknownRpcCommand);
    }

    #[test]
    fn identify_returns_action() {
        let mut im = Improv::new();
        let pkt = rpc(Command::Identify as u8, &[]);
        assert!(matches!(im.on_rpc(pkt.as_slice()), Action::Identify));
    }

    #[test]
    fn oversize_length_field_is_rejected() {
        let mut im = Improv::new();
        // Claims data_len 200 but packet is short -> InvalidRpcPacket, no OOB.
        let pkt = [Command::SendWifi as u8, 200, 0x00];
        assert!(matches!(im.on_rpc(&pkt), Action::None));
        assert_eq!(im.error, ErrorState::InvalidRpcPacket);
    }

    #[test]
    fn failed_provision_reverts_with_error() {
        let mut im = Improv::new();
        im.state = State::Provisioning;
        im.provisioning_result(false, &[]);
        assert_eq!(im.state, State::Authorized);
        assert_eq!(im.error, ErrorState::UnableToConnect);
    }

    #[test]
    fn improv_service_is_discoverable() {
        use crate::gatt::GATT_RSP_MAX;
        let mut svc = ImprovService::new();
        // Negotiate a large MTU so one response can hold all elements.
        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        svc.db.handle_att(0x02, &[0xff, 0x00], &mut out); // Exchange MTU

        // Walk primary services (Read By Group Type) across re-queries: the standard
        // GATT service (0x1801) is first (16-bit UUID, own response), then the Improv
        // service (128-bit). Confirm the Improv 128-bit UUID is discoverable.
        let mut found_improv = false;
        let mut start = 1u16;
        for _ in 0..4 {
            let p = [start.to_le_bytes()[0], start.to_le_bytes()[1], 0xff, 0xff, 0x00, 0x28];
            let n = svc.db.handle_att(0x10, &p, &mut out);
            if n == 0 || out.as_slice()[0] != 0x11 {
                break; // error / no more services
            }
            let s = out.as_slice();
            let elem = s[1] as usize;
            let mut off = 2;
            while off + elem <= s.len() {
                let end = u16::from_le_bytes([s[off + 2], s[off + 3]]);
                if elem == 20 && &s[off + 4..off + 20] == &IMPROV_SVC_UUID {
                    found_improv = true;
                }
                start = end + 1;
                off += elem;
            }
        }
        assert!(found_improv, "Improv 128-bit service not discoverable");

        // All 5 Improv characteristics are discoverable (Read By Type, large MTU).
        let mut chars: Buf<GATT_RSP_MAX> = Buf::new();
        let mut cstart = 1u16;
        let mut char_count = 0;
        for _ in 0..8 {
            let cp = [cstart.to_le_bytes()[0], cstart.to_le_bytes()[1], 0xff, 0xff, 0x03, 0x28];
            let n = svc.db.handle_att(0x08, &cp, &mut chars);
            if n == 0 || chars.as_slice()[0] != 0x09 {
                break;
            }
            let s = chars.as_slice();
            let elem = s[1] as usize;
            let mut off = 2;
            while off + elem <= s.len() {
                if elem >= 5 && &s[off + 5..off + elem] == &IMPROV_CHAR_RPC_RESULT[..elem - 5] {
                    // the RPC-result char (…8004) that Bleak couldn't find
                }
                let h = u16::from_le_bytes([s[off], s[off + 1]]);
                cstart = h + 1;
                if elem == 21 {
                    char_count += 1; // a 128-bit (Improv) characteristic
                }
                off += elem;
            }
        }
        assert_eq!(char_count, 5, "all 5 Improv characteristics discoverable");
    }

    #[test]
    fn service_routes_rpc_write_to_state_machine() {
        use crate::gatt::GATT_RSP_MAX;
        let mut svc = ImprovService::new();
        let rpc_cmd_h = svc.h_rpc_cmd;
        // Build an ATT Write to the RPC-command handle with a SendWifi RPC.
        let mut data: Buf<64> = Buf::new();
        data.extend(&[2]).unwrap();
        data.extend(b"ap").unwrap();
        data.extend(&[3]).unwrap();
        data.extend(b"pwd").unwrap();
        let pkt = rpc(Command::SendWifi as u8, data.as_slice());
        let mut params: Buf<128> = Buf::new();
        params.extend(&rpc_cmd_h.to_le_bytes()).unwrap();
        params.extend(pkt.as_slice()).unwrap();

        let mut out: Buf<GATT_RSP_MAX> = Buf::new();
        let outcome = svc.handle_att(0x12 /*WRITE_REQ*/, params.as_slice(), &mut out);
        // Provisioning action surfaced with the parsed credentials.
        match outcome.action {
            Action::Provision(c) => {
                assert_eq!(c.ssid.as_slice(), b"ap");
                assert_eq!(c.pass.as_slice(), b"pwd");
            }
            _ => panic!("expected Provision"),
        }
        assert_eq!(svc.improv.state, State::Provisioning);
        // Current-state characteristic now reads "provisioning" via a GATT read.
        let mut rd: Buf<GATT_RSP_MAX> = Buf::new();
        svc.db.handle_att(0x0a /*READ_REQ*/, &svc.h_current.to_le_bytes(), &mut rd);
        assert_eq!(rd.as_slice()[1], State::Provisioning as u8);

        // Complete provisioning; result characteristic + state update.
        svc.finish_provisioning(true, &["http://host"]);
        let mut ntf: Buf<GATT_RSP_MAX> = Buf::new();
        assert!(svc.db.notification(svc.rpc_result_handle(), &mut ntf) > 0);
        svc.db.handle_att(0x0a, &svc.h_current.to_le_bytes(), &mut rd);
        assert_eq!(rd.as_slice()[1], State::Provisioned as u8);
    }
}
