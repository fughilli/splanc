//! The Ethernet config and the network outputs: their types, validation and
//! flash blob.

/// The first network LED channel: channels 0-1 are the GPIO strips.
pub const NET_CHANNEL_FIRST: u8 = 2;
/// Network LED channels (2..=7): the player core's `MAX_CHANNELS` is 8.
pub const NET_CHANNELS: usize = 6;
/// Highest GPIO number on the ESP32-P4.
pub const MAX_GPIO: i32 = 54;
/// The RMII data bus and reference clock input on the P4. These are IO MUX pins:
/// unlike MDC / MDIO they cannot be moved, so the config doesn't carry them.
pub const RMII_GPIOS: [i32; 7] = [49, 34, 35, 28, 29, 30, 50];
/// The reference clock input pin, for `Clock::ExtIn`.
pub const RMII_CLK_IN_GPIO: i32 = 50;
/// DDP's UDP port.
pub const DDP_PORT: u16 = 4048;
/// Display names are cut to this many bytes.
pub const NAME_MAX: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Phy {
    Ip101 = 1,
    Lan8720 = 2,
    Rtl8201 = 3,
    Dp83848 = 4,
    Ksz80xx = 5,
}

impl Phy {
    pub const ALL: [Phy; 5] = [
        Phy::Ip101,
        Phy::Lan8720,
        Phy::Rtl8201,
        Phy::Dp83848,
        Phy::Ksz80xx,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Phy::Ip101 => "ip101",
            Phy::Lan8720 => "lan8720",
            Phy::Rtl8201 => "rtl8201",
            Phy::Dp83848 => "dp83848",
            Phy::Ksz80xx => "ksz80xx",
        }
    }

    pub fn from_id(s: &[u8]) -> Option<Phy> {
        Phy::ALL
            .into_iter()
            .find(|p| p.id().as_bytes().eq_ignore_ascii_case(s))
    }

    pub fn from_u8(v: u8) -> Option<Phy> {
        Phy::ALL.into_iter().find(|p| *p as u8 == v)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Clock {
    /// The PHY or an oscillator drives the 50 MHz clock into GPIO50.
    ExtIn = 0,
    /// The P4 drives it out on `clock_gpio`.
    Out = 1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum IpMode {
    DhcpClient = 0,
    Static = 1,
    DhcpServer = 2,
}

/// IPv4 addresses are u32s holding the four octets big-endian, as on the wire
/// (192.168.50.1 = 0xC0A83201).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EthConfig {
    pub enabled: bool,
    pub phy: Phy,
    /// -1 = scan the MDIO bus.
    pub phy_addr: i8,
    pub mdc: i8,
    pub mdio: i8,
    /// -1 = none.
    pub reset: i8,
    pub clock: Clock,
    pub clock_gpio: i8,
    pub ip_mode: IpMode,
    pub ip: u32,
    pub netmask: u32,
    pub gateway: u32,
}

impl Default for EthConfig {
    /// Off, with the wiring of the P4 boards that carry an IP101 (the IDF's P4
    /// default: MDC 31, MDIO 52, reset 51, clock in on GPIO50) and the address
    /// plan of a private LED network (192.168.50.1/24, like the Mac's en15).
    fn default() -> Self {
        Self {
            enabled: false,
            phy: Phy::Ip101,
            phy_addr: 1,
            mdc: 31,
            mdio: 52,
            reset: 51,
            clock: Clock::ExtIn,
            clock_gpio: -1,
            ip_mode: IpMode::DhcpServer,
            ip: 0xC0A8_3201,
            netmask: 0xFFFF_FF00,
            gateway: 0,
        }
    }
}

/// Why a config or output was refused (the machine codes in
/// `EthernetState.error`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    BadPhy,
    BadPin,
    PinInUse,
    BadAddress,
    BadChannel,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::BadPhy => "bad_phy",
            Refusal::BadPin => "bad_pin",
            Refusal::PinInUse => "pin_in_use",
            Refusal::BadAddress => "bad_address",
            Refusal::BadChannel => "bad_channel",
        }
    }
}

fn gpio_ok(g: i32) -> bool {
    (0..=MAX_GPIO).contains(&g)
}

/// A netmask is a run of ones then zeros, and not empty.
pub fn netmask_ok(m: u32) -> bool {
    m != 0 && m.leading_ones() + m.trailing_zeros() == 32
}

impl EthConfig {
    /// The GPIOs this config takes while enabled, -1 for unused slots.
    pub fn pins(&self) -> [i32; 11] {
        let mut p = [-1i32; 11];
        p[..7].copy_from_slice(&RMII_GPIOS);
        p[7] = self.mdc as i32;
        p[8] = self.mdio as i32;
        p[9] = self.reset as i32;
        p[10] = if self.clock == Clock::Out {
            self.clock_gpio as i32
        } else {
            -1
        };
        p
    }

    /// Check a config before it is applied. `busy` are GPIOs other outputs
    /// drive (the LED strips' data pins), which an enabled config must not take.
    /// A disabled config is still checked for shape, so it can be stored and
    /// enabled later, but not against `busy`.
    pub fn validate(&self, busy: &[i32]) -> Result<(), Refusal> {
        if !(-1..=31).contains(&(self.phy_addr as i32)) {
            return Err(Refusal::BadPhy);
        }
        if !gpio_ok(self.mdc as i32) || !gpio_ok(self.mdio as i32) || self.mdc == self.mdio {
            return Err(Refusal::BadPin);
        }
        if self.reset != -1 && !gpio_ok(self.reset as i32) {
            return Err(Refusal::BadPin);
        }
        if self.clock == Clock::Out && !gpio_ok(self.clock_gpio as i32) {
            return Err(Refusal::BadPin);
        }
        // No pin twice: MDC / MDIO / reset / clock out against each other and
        // the fixed RMII bus.
        let pins = self.pins();
        for (i, a) in pins.iter().enumerate() {
            if *a < 0 {
                continue;
            }
            if pins[i + 1..].contains(a) {
                return Err(Refusal::BadPin);
            }
        }
        match self.ip_mode {
            IpMode::DhcpClient => {}
            IpMode::Static | IpMode::DhcpServer => {
                if !netmask_ok(self.netmask) {
                    return Err(Refusal::BadAddress);
                }
                let host = self.ip & !self.netmask;
                // Not the network or broadcast address, and not 0.0.0.0/8, 127/8
                // or multicast and above.
                let first = self.ip >> 24;
                if host == 0 || host == !self.netmask || first == 0 || first == 127 || first >= 224
                {
                    return Err(Refusal::BadAddress);
                }
                if self.gateway != 0 && (self.gateway & self.netmask) != (self.ip & self.netmask) {
                    return Err(Refusal::BadAddress);
                }
            }
        }
        if self.enabled && pins.iter().any(|p| *p >= 0 && busy.contains(p)) {
            return Err(Refusal::PinInUse);
        }
        Ok(())
    }
}

/// One network output (an LED channel 2..=7 with a target).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NetOutput {
    /// Controller IPv4 (big-endian octets in a u32); 0 = off.
    pub ip: u32,
    /// UDP port; 0 = DDP_PORT.
    pub port: u16,
    pub name: [u8; NAME_MAX],
    pub name_len: u8,
}

impl Default for NetOutput {
    fn default() -> Self {
        Self {
            ip: 0,
            port: 0,
            name: [0; NAME_MAX],
            name_len: 0,
        }
    }
}

impl NetOutput {
    pub fn new(ip: u32, port: u16, name: &[u8]) -> Self {
        let mut o = Self {
            ip,
            port,
            ..Default::default()
        };
        o.set_name(name);
        o
    }

    pub fn set_name(&mut self, name: &[u8]) {
        // Cut at a UTF-8 character boundary so the stored name stays valid.
        let mut n = name.len().min(NAME_MAX);
        while n > 0 && n < name.len() && (name[n] & 0xC0) == 0x80 {
            n -= 1;
        }
        self.name = [0; NAME_MAX];
        self.name[..n].copy_from_slice(&name[..n]);
        self.name_len = n as u8;
    }

    pub fn name(&self) -> &[u8] {
        &self.name[..self.name_len as usize]
    }

    pub fn active(&self) -> bool {
        self.ip != 0
    }

    pub fn port_or_default(&self) -> u16 {
        if self.port == 0 {
            DDP_PORT
        } else {
            self.port
        }
    }

    pub fn validate(&self) -> Result<(), Refusal> {
        if self.ip == 0 {
            return Ok(()); // clearing the target
        }
        let first = self.ip >> 24;
        // A unicast or limited-broadcast IPv4: not 0/8, 127/8 or multicast.
        if first == 0 || first == 127 || (224..255).contains(&first) {
            return Err(Refusal::BadAddress);
        }
        Ok(())
    }
}

/// Index into the outputs table for LED `channel`, if it is a network channel.
pub fn net_index(channel: i32) -> Option<usize> {
    let i = channel.checked_sub(NET_CHANNEL_FIRST as i32)?;
    if (0..NET_CHANNELS as i32).contains(&i) {
        Some(i as usize)
    } else {
        None
    }
}

/// Everything persisted: the config and every output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct NetSettings {
    pub eth: EthConfig,
    pub outputs: [NetOutput; NET_CHANNELS],
}

/// Flash blob layout version. Bump on any change, and keep reading the old one.
const BLOB_V1: u8 = 1;
const CFG_LEN: usize = 22;
const OUT_LEN: usize = 4 + 2 + 1 + NAME_MAX;
/// Size of the flash blob.
pub const BLOB_LEN: usize = 2 + CFG_LEN + NET_CHANNELS * OUT_LEN;

impl NetSettings {
    /// Serialise for flash: version, a byte count, then fixed fields.
    pub fn to_blob(&self, out: &mut [u8; BLOB_LEN]) {
        let e = &self.eth;
        out.fill(0);
        out[0] = BLOB_V1;
        out[1] = CFG_LEN as u8;
        let c = &mut out[2..2 + CFG_LEN];
        c[0] = e.enabled as u8;
        c[1] = e.phy as u8;
        c[2] = e.phy_addr as u8;
        c[3] = e.mdc as u8;
        c[4] = e.mdio as u8;
        c[5] = e.reset as u8;
        c[6] = e.clock as u8;
        c[7] = e.clock_gpio as u8;
        c[8] = e.ip_mode as u8;
        c[9] = 0;
        c[10..14].copy_from_slice(&e.ip.to_be_bytes());
        c[14..18].copy_from_slice(&e.netmask.to_be_bytes());
        c[18..22].copy_from_slice(&e.gateway.to_be_bytes());
        for (i, o) in self.outputs.iter().enumerate() {
            let at = 2 + CFG_LEN + i * OUT_LEN;
            let b = &mut out[at..at + OUT_LEN];
            b[0..4].copy_from_slice(&o.ip.to_be_bytes());
            b[4..6].copy_from_slice(&o.port.to_be_bytes());
            b[6] = o.name_len;
            b[7..].copy_from_slice(&o.name);
        }
    }

    /// Read a blob written by `to_blob`. A blob that is short, of an unknown
    /// version or that fails validation reads as None (the caller keeps the
    /// defaults): flash from another build must never brick the output.
    pub fn from_blob(b: &[u8]) -> Option<NetSettings> {
        if b.len() < BLOB_LEN || b[0] != BLOB_V1 || b[1] as usize != CFG_LEN {
            return None;
        }
        let c = &b[2..2 + CFG_LEN];
        let be = |s: &[u8]| u32::from_be_bytes([s[0], s[1], s[2], s[3]]);
        let eth = EthConfig {
            enabled: c[0] != 0,
            phy: Phy::from_u8(c[1])?,
            phy_addr: c[2] as i8,
            mdc: c[3] as i8,
            mdio: c[4] as i8,
            reset: c[5] as i8,
            clock: match c[6] {
                0 => Clock::ExtIn,
                1 => Clock::Out,
                _ => return None,
            },
            clock_gpio: c[7] as i8,
            ip_mode: match c[8] {
                0 => IpMode::DhcpClient,
                1 => IpMode::Static,
                2 => IpMode::DhcpServer,
                _ => return None,
            },
            ip: be(&c[10..14]),
            netmask: be(&c[14..18]),
            gateway: be(&c[18..22]),
        };
        eth.validate(&[]).ok()?;
        let mut outputs = [NetOutput::default(); NET_CHANNELS];
        for (i, o) in outputs.iter_mut().enumerate() {
            let at = 2 + CFG_LEN + i * OUT_LEN;
            let s = &b[at..at + OUT_LEN];
            let n = (s[6] as usize).min(NAME_MAX);
            *o = NetOutput::new(be(&s[0..4]), u16::from_be_bytes([s[4], s[5]]), &s[7..7 + n]);
            if o.validate().is_err() {
                *o = NetOutput::default();
            }
        }
        Some(NetSettings { eth, outputs })
    }
}
