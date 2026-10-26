//! Minimal Linux GPIO character-device client (GPIO uAPI v2): one input line
//! with rising-edge events, used to wait for the FPGA's `frame_done` output.
//!
//! The raw ioctls instead of libgpiod (C, can't link into the static-musl player)
//! or a gpio crate: one input line needs three ioctls and a `read`, and `libc` is
//! already in the player's crate graph (tokio/spidev). Struct layouts follow
//! `include/uapi/linux/gpio.h` (Linux ≥ 5.10) and are size-checked in the tests,
//! so a layout slip fails the build's tests instead of corrupting an ioctl.
//!
//! Edge timestamps are the kernel's (`CLOCK_MONOTONIC`, taken in the GPIO IRQ
//! handler), so `wake_ns - edge.timestamp_ns` is the IRQ-to-userspace latency.

use crate::pacing::{mono_ns, FrameDone};
use std::ffi::CStr;
use std::fs::{File, OpenOptions};
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::Duration;

const GPIO_MAX_NAME_SIZE: usize = 32;
const GPIO_V2_LINES_MAX: usize = 64;
const GPIO_V2_LINE_NUM_ATTRS_MAX: usize = 10;

/// `GPIO_V2_LINE_FLAG_*` (uapi/linux/gpio.h).
pub const FLAG_INPUT: u64 = 1 << 2;
pub const FLAG_EDGE_RISING: u64 = 1 << 4;
pub const FLAG_BIAS_PULL_DOWN: u64 = 1 << 9;
/// `GPIO_V2_LINE_EVENT_RISING_EDGE`.
pub const EVENT_RISING_EDGE: u32 = 1;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GpioChipInfo {
    pub name: [u8; GPIO_MAX_NAME_SIZE],
    pub label: [u8; GPIO_MAX_NAME_SIZE],
    pub lines: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct LineAttribute {
    id: u32,
    padding: u32,
    /// union { flags; values; debounce_period_us } — u64-aligned.
    value: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct LineConfigAttribute {
    attr: LineAttribute,
    mask: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct LineConfig {
    flags: u64,
    num_attrs: u32,
    padding: [u32; 5],
    attrs: [LineConfigAttribute; GPIO_V2_LINE_NUM_ATTRS_MAX],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct LineRequest {
    offsets: [u32; GPIO_V2_LINES_MAX],
    consumer: [u8; GPIO_MAX_NAME_SIZE],
    config: LineConfig,
    num_lines: u32,
    event_buffer_size: u32,
    padding: [u32; 5],
    fd: i32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct LineValues {
    bits: u64,
    mask: u64,
}

#[repr(C)]
#[derive(Clone, Copy, Default, Debug)]
pub struct LineEvent {
    pub timestamp_ns: u64,
    pub id: u32,
    pub offset: u32,
    pub seqno: u32,
    pub line_seqno: u32,
    padding: [u32; 6],
}

/// `_IOC(dir, 0xB4, nr, size)` with the generic (arm/arm64/x86) encoding.
const fn ioc(dir: u32, nr: u32, size: usize) -> u32 {
    (dir << 30) | ((size as u32) << 16) | (0xB4 << 8) | nr
}
const IOC_READ: u32 = 2;
const IOC_RW: u32 = 3;
pub const GPIO_GET_CHIPINFO_IOCTL: u32 = ioc(IOC_READ, 0x01, std::mem::size_of::<GpioChipInfo>());
pub const GPIO_V2_GET_LINE_IOCTL: u32 = ioc(IOC_RW, 0x07, std::mem::size_of::<LineRequest>());
pub const GPIO_V2_LINE_GET_VALUES_IOCTL: u32 =
    ioc(IOC_RW, 0x0E, std::mem::size_of::<LineValues>());

fn cstr_field(b: &[u8]) -> String {
    CStr::from_bytes_until_nul(b)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Read a chip's `(name, label, lines)`.
pub fn chip_info(path: &str) -> io::Result<(String, String, u32)> {
    let f = File::open(path)?;
    let mut info = GpioChipInfo { name: [0; 32], label: [0; 32], lines: 0 };
    // SAFETY: GPIO_GET_CHIPINFO_IOCTL fills a gpiochip_info, which `info` is.
    let rc = unsafe { libc::ioctl(f.as_raw_fd(), GPIO_GET_CHIPINFO_IOCTL as _, &mut info) };
    if rc < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((cstr_field(&info.name), cstr_field(&info.label), info.lines))
}

/// Labels of the SoC/RP1 pin controllers that own the 40-pin header's BCM GPIO
/// numbers, so `GPIO 22` means header pin 15 on every Pi generation:
/// Pi 3 `pinctrl-bcm2835`, Pi 4 `pinctrl-bcm2711`, Pi 5 `pinctrl-rp1` (which
/// moved from gpiochip4 to gpiochip0 in kernel 6.6.47).
pub const HEADER_CHIP_LABELS: &[&str] = &["pinctrl-bcm2835", "pinctrl-bcm2711", "pinctrl-rp1"];

/// Resolve `auto` to the gpiochip that owns the header pins (by label), falling
/// back to `/dev/gpiochip0`. Any other value is used as a path.
pub fn resolve_chip(spec: &str) -> String {
    if spec != "auto" {
        return spec.to_string();
    }
    let mut chips: Vec<String> = std::fs::read_dir("/dev")
        .map(|d| {
            d.filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.starts_with("gpiochip"))
                .map(|n| format!("/dev/{n}"))
                .collect()
        })
        .unwrap_or_default();
    chips.sort();
    for c in &chips {
        if let Ok((_, label, _)) = chip_info(c) {
            if HEADER_CHIP_LABELS.contains(&label.as_str()) {
                return c.clone();
            }
        }
    }
    "/dev/gpiochip0".to_string()
}

/// One requested input line with rising-edge detection and a pull-down (so an
/// unwired pin reads a stable LOW and produces no edges).
pub struct EdgeLine {
    fd: OwnedFd,
    pub chip: String,
    pub offset: u32,
}

impl EdgeLine {
    pub fn request(chip: &str, offset: u32, consumer: &str) -> io::Result<Self> {
        let chip_f = OpenOptions::new().read(true).write(true).open(chip)?;
        let mut req = LineRequest {
            offsets: [0; GPIO_V2_LINES_MAX],
            consumer: [0; GPIO_MAX_NAME_SIZE],
            config: LineConfig {
                flags: FLAG_INPUT | FLAG_EDGE_RISING | FLAG_BIAS_PULL_DOWN,
                ..Default::default()
            },
            num_lines: 1,
            event_buffer_size: 0, // kernel default (16 per line)
            padding: [0; 5],
            fd: -1,
        };
        req.offsets[0] = offset;
        let n = consumer.len().min(GPIO_MAX_NAME_SIZE - 1);
        req.consumer[..n].copy_from_slice(&consumer.as_bytes()[..n]);
        // SAFETY: GPIO_V2_GET_LINE_IOCTL reads/writes a gpio_v2_line_request.
        let rc = unsafe { libc::ioctl(chip_f.as_raw_fd(), GPIO_V2_GET_LINE_IOCTL as _, &mut req) };
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: on success the kernel returned a fresh, owned line fd.
        let fd = unsafe { OwnedFd::from_raw_fd(req.fd) };
        // Non-blocking reads, so draining the event queue never blocks.
        // SAFETY: plain fcntl on an fd we own.
        unsafe {
            let fl = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
            libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, fl | libc::O_NONBLOCK);
        }
        Ok(Self { fd, chip: chip.to_string(), offset })
    }

    fn raw(&self) -> RawFd {
        self.fd.as_raw_fd()
    }

    /// Read every queued event without blocking; returns the newest rising
    /// edge's timestamp and the number of events read.
    fn read_events(&mut self) -> io::Result<(usize, Option<u64>)> {
        let mut buf = [LineEvent::default(); 16];
        let mut count = 0;
        let mut newest = None;
        loop {
            let bytes = std::mem::size_of_val(&buf);
            // SAFETY: reading whole gpio_v2_line_event records into `buf`.
            let n = unsafe { libc::read(self.raw(), buf.as_mut_ptr().cast(), bytes) };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::WouldBlock {
                    return Ok((count, newest));
                }
                return Err(e);
            }
            let k = n as usize / std::mem::size_of::<LineEvent>();
            for ev in &buf[..k] {
                if ev.id == EVENT_RISING_EDGE {
                    newest = Some(ev.timestamp_ns);
                }
            }
            count += k;
            if k < buf.len() {
                return Ok((count, newest));
            }
        }
    }
}

impl FrameDone for EdgeLine {
    fn drain(&mut self) -> io::Result<usize> {
        self.read_events().map(|(n, _)| n)
    }

    fn is_high(&mut self) -> io::Result<bool> {
        let mut v = LineValues { bits: 0, mask: 1 };
        // SAFETY: GPIO_V2_LINE_GET_VALUES_IOCTL reads/writes a gpio_v2_line_values.
        let rc = unsafe { libc::ioctl(self.raw(), GPIO_V2_LINE_GET_VALUES_IOCTL as _, &mut v) };
        if rc < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(v.bits & 1 != 0)
    }

    fn wait_rising(&mut self, timeout: Duration) -> io::Result<Option<u64>> {
        let deadline = mono_ns() + timeout.as_nanos() as u64;
        loop {
            let now = mono_ns();
            if now >= deadline {
                return Ok(None);
            }
            let left = deadline - now;
            let ts = libc::timespec {
                tv_sec: (left / 1_000_000_000) as _,
                tv_nsec: (left % 1_000_000_000) as _,
            };
            let mut pfd = libc::pollfd { fd: self.raw(), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd, a valid timespec, no signal mask.
            let rc = unsafe { libc::ppoll(&mut pfd, 1, &ts, std::ptr::null()) };
            if rc < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e);
            }
            if rc == 0 {
                return Ok(None);
            }
            if let (_, Some(ts)) = self.read_events()? {
                return Ok(Some(ts));
            }
            // Only falling edges / spurious wake-up: keep waiting.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uapi_layouts_match_linux_gpio_h() {
        assert_eq!(std::mem::size_of::<GpioChipInfo>(), 68);
        assert_eq!(std::mem::size_of::<LineAttribute>(), 16);
        assert_eq!(std::mem::size_of::<LineConfigAttribute>(), 24);
        assert_eq!(std::mem::size_of::<LineConfig>(), 272);
        assert_eq!(std::mem::size_of::<LineRequest>(), 592);
        assert_eq!(std::mem::size_of::<LineValues>(), 16);
        assert_eq!(std::mem::size_of::<LineEvent>(), 48);
    }

    #[test]
    fn ioctl_numbers_match_linux_gpio_h() {
        // Values from the kernel headers (arm64/x86 _IOC encoding).
        assert_eq!(GPIO_GET_CHIPINFO_IOCTL, 0x8044_B401);
        assert_eq!(GPIO_V2_GET_LINE_IOCTL, 0xC250_B407);
        assert_eq!(GPIO_V2_LINE_GET_VALUES_IOCTL, 0xC010_B40E);
    }

    #[test]
    fn explicit_chip_path_is_kept() {
        assert_eq!(resolve_chip("/dev/gpiochip4"), "/dev/gpiochip4");
    }
}
