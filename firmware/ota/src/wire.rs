//! The OTA arms of the player protocol (shared/protocol/proto/ledmapper.proto,
//! "Firmware update over the air"), hand-coded so the loader can speak them
//! without the generated bindings for the whole protocol: it decodes only the
//! `ClientMessage` arms below (everything else is reported as `Other` and
//! answered `error{unsupported}`) and encodes a subset `Welcome`, `Error` and
//! `OtaStatus`. tests/wire.rs checks every number here against the generated
//! host bindings.

/// `ClientMessage.msg` field numbers.
pub const CM_HELLO: u32 = 1;
pub const CM_TIME_SYNC_PING: u32 = 2;
pub const CM_GET_TLS_INFO: u32 = 45;
pub const CM_OTA_BEGIN: u32 = 70;
pub const CM_OTA_CHUNK: u32 = 71;
pub const CM_OTA_FINISH: u32 = 72;
pub const CM_OTA_ABORT: u32 = 73;
pub const CM_GET_OTA_STATUS: u32 = 74;
pub const CM_OTA_REBOOT: u32 = 75;

/// `ServerMessage.msg` field numbers.
pub const SM_WELCOME: u32 = 1;
pub const SM_TIME_SYNC_PONG: u32 = 2;
pub const SM_TLS_INFO: u32 = 24;
pub const SM_ERROR: u32 = 9;
pub const SM_OTA_STATUS: u32 = 32;

/// `Welcome.ota`.
pub const WELCOME_OTA: u32 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Mode {
    Unknown = 0,
    App = 1,
    Loader = 2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum State {
    Idle = 0,
    /// The app accepted the manifest and is restarting into the loader:
    /// reconnect and send ota_begin again.
    Rebooting = 1,
    Receiving = 2,
    Verifying = 3,
    /// Verified and selected: the device restarts into the new app.
    Installed = 4,
    Failed = 5,
    /// A pull device (Splanc MAX, docs/design/max-ota.md) fetching its image itself.
    Downloading = 6,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum RebootTarget {
    App = 0,
    Loader = 1,
}

/// A decoded `ClientMessage`, borrowing from the frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ClientArm<'a> {
    Hello,
    /// `time_sync_ping{t0}` (the loader answers it so a client's connect
    /// sequence — hello, tls_info, clock sync — completes).
    TimeSyncPing { t0: f64 },
    GetTlsInfo,
    /// `source_url` (field 4) is for pull devices (a Splanc MAX); the C6 ignores it.
    OtaBegin { manifest: &'a [u8], allow_downgrade: bool, key_epoch: &'a [u8], source_url: &'a [u8] },
    OtaChunk { offset: u32, data: &'a [u8] },
    OtaFinish,
    OtaAbort,
    GetOtaStatus,
    OtaReboot { target: RebootTarget },
    /// Some other arm (its field number): not an OTA message.
    Other(u32),
    /// No arm set.
    Empty,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Malformed;

struct Reader<'a> {
    b: &'a [u8],
    o: usize,
}

enum Value<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
    Fixed64(u64),
    Fixed32,
}

impl<'a> Reader<'a> {
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

    fn field(&mut self) -> Result<Option<(u32, Value<'a>)>, Malformed> {
        if self.o >= self.b.len() {
            return Ok(None);
        }
        let key = self.varint()?;
        let num = (key >> 3) as u32;
        if num == 0 {
            return Err(Malformed);
        }
        let v = match key & 7 {
            0 => Value::Varint(self.varint()?),
            1 => {
                let start = self.o;
                self.skip(8)?;
                let mut w = [0u8; 8];
                w.copy_from_slice(&self.b[start..start + 8]);
                Value::Fixed64(u64::from_le_bytes(w))
            }
            2 => {
                let n = self.varint()? as usize;
                let start = self.o;
                self.skip(n)?;
                let b: &'a [u8] = self.b;
                Value::Bytes(&b[start..start + n])
            }
            5 => {
                self.skip(4)?;
                Value::Fixed32
            }
            _ => return Err(Malformed),
        };
        Ok(Some((num, v)))
    }

    fn skip(&mut self, n: usize) -> Result<(), Malformed> {
        let end = self.o.checked_add(n).ok_or(Malformed)?;
        if end > self.b.len() {
            return Err(Malformed);
        }
        self.o = end;
        Ok(())
    }
}

fn submessage(v: Value<'_>) -> Result<&[u8], Malformed> {
    match v {
        Value::Bytes(b) => Ok(b),
        _ => Err(Malformed),
    }
}

/// Decode a `ClientMessage` frame's arm. The OTA arms' fields are read in
/// place; any other arm is only identified.
pub fn decode_client(frame: &[u8]) -> Result<ClientArm<'_>, Malformed> {
    let mut r = Reader { b: frame, o: 0 };
    let mut arm = ClientArm::Empty;
    while let Some((num, v)) = r.field()? {
        arm = match num {
            CM_HELLO => {
                submessage(v)?;
                ClientArm::Hello
            }
            CM_TIME_SYNC_PING => {
                let mut s = Reader { b: submessage(v)?, o: 0 };
                let mut t0 = 0.0;
                while let Some((n, v)) = s.field()? {
                    if let (1, Value::Fixed64(x)) = (n, v) {
                        t0 = f64::from_bits(x);
                    }
                }
                ClientArm::TimeSyncPing { t0 }
            }
            CM_GET_TLS_INFO => {
                submessage(v)?;
                ClientArm::GetTlsInfo
            }
            CM_OTA_BEGIN => {
                let mut s = Reader { b: submessage(v)?, o: 0 };
                let (mut manifest, mut allow_downgrade, mut key_epoch, mut source_url): (&[u8], bool, &[u8], &[u8]) =
                    (&[], false, &[], &[]);
                while let Some((n, v)) = s.field()? {
                    match (n, v) {
                        (1, Value::Bytes(b)) => manifest = b,
                        (2, Value::Varint(x)) => allow_downgrade = x != 0,
                        (3, Value::Bytes(b)) => key_epoch = b,
                        (4, Value::Bytes(b)) => source_url = b,
                        _ => {}
                    }
                }
                ClientArm::OtaBegin { manifest, allow_downgrade, key_epoch, source_url }
            }
            CM_OTA_CHUNK => {
                let mut s = Reader { b: submessage(v)?, o: 0 };
                let (mut offset, mut data): (u32, &[u8]) = (0, &[]);
                while let Some((n, v)) = s.field()? {
                    match (n, v) {
                        (1, Value::Varint(x)) => offset = x as u32,
                        (2, Value::Bytes(b)) => data = b,
                        _ => {}
                    }
                }
                ClientArm::OtaChunk { offset, data }
            }
            CM_OTA_FINISH => ClientArm::OtaFinish,
            CM_OTA_ABORT => ClientArm::OtaAbort,
            CM_GET_OTA_STATUS => ClientArm::GetOtaStatus,
            CM_OTA_REBOOT => {
                let mut s = Reader { b: submessage(v)?, o: 0 };
                let mut target = RebootTarget::App;
                while let Some((n, v)) = s.field()? {
                    if let (1, Value::Varint(x)) = (n, v) {
                        target = if x == 1 { RebootTarget::Loader } else { RebootTarget::App };
                    }
                }
                ClientArm::OtaReboot { target }
            }
            other => ClientArm::Other(other),
        };
    }
    Ok(arm)
}

// -- encoding ----------------------------------------------------------------------

/// A bounded protobuf writer: `ok` turns false on overflow.
pub struct Writer<'a> {
    out: &'a mut [u8],
    n: usize,
    ok: bool,
}

impl<'a> Writer<'a> {
    pub fn new(out: &'a mut [u8]) -> Self {
        Writer { out, n: 0, ok: true }
    }

    pub fn finish(self) -> Option<usize> {
        self.ok.then_some(self.n)
    }

    fn put(&mut self, b: &[u8]) {
        if !self.ok || self.n + b.len() > self.out.len() {
            self.ok = false;
            return;
        }
        self.out[self.n..self.n + b.len()].copy_from_slice(b);
        self.n += b.len();
    }

    fn varint(&mut self, mut v: u64) {
        let mut tmp = [0u8; 10];
        let mut i = 0;
        loop {
            let c = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                tmp[i] = c;
                i += 1;
                break;
            }
            tmp[i] = c | 0x80;
            i += 1;
        }
        self.put(&tmp[..i]);
    }

    fn key(&mut self, num: u32, wire: u8) {
        self.varint(((num as u64) << 3) | wire as u64);
    }

    /// A double (fixed64), omitted when 0.0.
    pub fn double(&mut self, num: u32, v: f64) {
        if v != 0.0 {
            self.key(num, 1);
            self.put(&v.to_bits().to_le_bytes());
        }
    }

    /// proto3: zero values are omitted.
    pub fn uint(&mut self, num: u32, v: u64) {
        if v != 0 {
            self.key(num, 0);
            self.varint(v);
        }
    }

    pub fn bool(&mut self, num: u32, v: bool) {
        self.uint(num, v as u64);
    }

    pub fn bytes(&mut self, num: u32, b: &[u8]) {
        if !b.is_empty() {
            self.key(num, 2);
            self.varint(b.len() as u64);
            self.put(b);
        }
    }

    /// A repeated string element (written even when empty).
    pub fn repeated_str(&mut self, num: u32, s: &str) {
        self.key(num, 2);
        self.varint(s.len() as u64);
        self.put(s.as_bytes());
    }

    /// A length-delimited submessage: written into the tail of the buffer, then
    /// moved down behind its length prefix.
    pub fn message(&mut self, num: u32, body: impl FnOnce(&mut Writer<'_>)) {
        if !self.ok {
            return;
        }
        self.key(num, 2);
        // Reserve the widest prefix a body that fits could need (5 bytes), then
        // shift down once its length is known.
        let start = self.n;
        if start + 5 > self.out.len() {
            self.ok = false;
            return;
        }
        let len = {
            let mut sub = Writer { out: &mut self.out[start + 5..], n: 0, ok: true };
            body(&mut sub);
            if !sub.ok {
                self.ok = false;
                return;
            }
            sub.n
        };
        let mut pre = [0u8; 5];
        let mut p = 0;
        let mut v = len as u64;
        loop {
            let c = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                pre[p] = c;
                p += 1;
                break;
            }
            pre[p] = c | 0x80;
            p += 1;
        }
        self.out.copy_within(start + 5..start + 5 + len, start + p);
        self.out[start..start + p].copy_from_slice(&pre[..p]);
        self.n = start + p + len;
    }

    /// A submessage that's present even when every field is default (the
    /// oneof arm must be on the wire).
    pub fn empty_message(&mut self, num: u32) {
        self.key(num, 2);
        self.varint(0);
    }
}

/// `OtaStatus`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Status<'a> {
    pub mode: u8,
    pub state: u8,
    pub version: u32,
    pub size: u32,
    pub offset: u32,
    pub error: &'a str,
    pub app_version: u32,
    pub app_fw_version: &'a str,
    pub loader_reason: &'a str,
    pub last_result: &'a str,
    pub loader_version: u32,
    pub max_chunk: u32,
    pub slot_size: u32,
    pub key_epoch: u32,
    pub revoked_keys: u32,
    pub security_floor: u32,
    /// Pull devices: the board their images are built for ("pi3", …); "" on a C6.
    pub board: &'a str,
}

impl Status<'_> {
    fn write(&self, w: &mut Writer<'_>) {
        w.uint(1, self.mode as u64);
        w.uint(2, self.state as u64);
        w.uint(3, self.version as u64);
        w.uint(4, self.size as u64);
        w.uint(5, self.offset as u64);
        w.bytes(6, self.error.as_bytes());
        w.uint(7, self.app_version as u64);
        w.bytes(8, self.app_fw_version.as_bytes());
        w.bytes(9, self.loader_reason.as_bytes());
        w.bytes(10, self.last_result.as_bytes());
        w.uint(11, self.loader_version as u64);
        w.uint(12, self.max_chunk as u64);
        w.uint(13, self.slot_size as u64);
        w.uint(14, self.key_epoch as u64);
        w.uint(15, self.revoked_keys as u64);
        w.uint(16, self.security_floor as u64);
        w.bytes(17, self.board.as_bytes());
    }
}

/// `ServerMessage{ota_status}`.
pub fn encode_status(s: &Status<'_>, out: &mut [u8]) -> Option<usize> {
    let mut w = Writer::new(out);
    w.message(SM_OTA_STATUS, |w| s.write(w));
    w.finish()
}

/// `ServerMessage{error{code, message}}`.
pub fn encode_error(code: &str, message: &str, out: &mut [u8]) -> Option<usize> {
    let mut w = Writer::new(out);
    w.message(SM_ERROR, |w| {
        w.bytes(1, code.as_bytes());
        w.bytes(2, message.as_bytes());
    });
    w.finish()
}

/// What the loader reports in its `Welcome` (the rest stays default: a client
/// reads `ota.mode == LOADER` / the "loader" feature and shows recovery).
#[derive(Clone, Copy, Debug, Default)]
pub struct LoaderWelcome<'a> {
    pub mac: &'a str,
    pub device_name: &'a str,
    pub fw_git_commit: &'a str,
    pub fw_git_dirty: bool,
    pub fw_version: &'a str,
    pub status: Status<'a>,
}

/// The loader's feature list (`Welcome.features`).
pub const LOADER_FEATURES: &[&str] = &["ota", "loader", "tls_info"];

/// `ServerMessage{time_sync_pong{t0, t1, t2}}`.
pub fn encode_time_sync_pong(t0: f64, t1: f64, t2: f64, out: &mut [u8]) -> Option<usize> {
    let mut w = Writer::new(out);
    w.message(SM_TIME_SYNC_PONG, |w| {
        w.double(1, t0);
        w.double(2, t1);
        w.double(3, t2);
    });
    w.finish()
}

/// `ServerMessage{tls_info{state, cert_sha256, persisted}}`.
pub fn encode_tls_info(state: &str, cert_sha256: &str, persisted: bool, out: &mut [u8]) -> Option<usize> {
    let mut w = Writer::new(out);
    w.message(SM_TLS_INFO, |w| {
        w.bytes(1, state.as_bytes());
        w.bytes(2, cert_sha256.as_bytes());
        w.bool(3, persisted);
    });
    w.finish()
}

/// `ServerMessage{welcome}` for the loader.
pub fn encode_loader_welcome(wl: &LoaderWelcome<'_>, out: &mut [u8]) -> Option<usize> {
    let mut w = Writer::new(out);
    w.message(SM_WELCOME, |w| {
        w.bytes(4, wl.mac.as_bytes());
        w.bytes(5, wl.device_name.as_bytes());
        w.bytes(7, wl.fw_git_commit.as_bytes());
        w.bool(8, wl.fw_git_dirty);
        w.bytes(9, wl.fw_version.as_bytes());
        for f in LOADER_FEATURES {
            w.repeated_str(10, f);
        }
        w.message(WELCOME_OTA, |w| wl.status.write(w));
    });
    w.finish()
}
