//! The few libc calls the radios need, declared here so the crate takes no new dependency
//! (std links libc on Linux anyway). Linux only.

#![allow(non_camel_case_types)]

use std::io;
use std::os::fd::{FromRawFd, OwnedFd, RawFd};

pub type c_int = i32;
pub type socklen_t = u32;

pub const AF_NETLINK: c_int = 16;
pub const AF_PACKET: c_int = 17;
pub const SOCK_RAW: c_int = 3;
pub const SOCK_CLOEXEC: c_int = 0o2000000;
pub const NETLINK_GENERIC: c_int = 16;
pub const SOL_NETLINK: c_int = 270;
pub const NETLINK_ADD_MEMBERSHIP: c_int = 1;
pub const NETLINK_EXT_ACK: c_int = 11;
pub const MSG_DONTWAIT: c_int = 0x40;
pub const ETH_P_ALL: u16 = 0x0003;
pub const SOL_SOCKET: c_int = 1;
pub const SO_RCVBUF: c_int = 8;

#[repr(C)]
pub struct sockaddr_nl {
    pub nl_family: u16,
    pub nl_pad: u16,
    pub nl_pid: u32,
    pub nl_groups: u32,
}

#[repr(C)]
pub struct sockaddr_ll {
    pub sll_family: u16,
    pub sll_protocol: u16,
    pub sll_ifindex: i32,
    pub sll_hatype: u16,
    pub sll_pkttype: u8,
    pub sll_halen: u8,
    pub sll_addr: [u8; 8],
}

extern "C" {
    fn socket(domain: c_int, ty: c_int, protocol: c_int) -> c_int;
    fn bind(fd: c_int, addr: *const u8, len: socklen_t) -> c_int;
    fn send(fd: c_int, buf: *const u8, len: usize, flags: c_int) -> isize;
    fn recv(fd: c_int, buf: *mut u8, len: usize, flags: c_int) -> isize;
    fn setsockopt(fd: c_int, level: c_int, name: c_int, val: *const u8, len: socklen_t) -> c_int;
    fn if_nametoindex(name: *const u8) -> u32;
}

fn check(r: isize) -> io::Result<usize> {
    if r < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(r as usize)
    }
}

pub fn sock(domain: c_int, ty: c_int, protocol: c_int) -> io::Result<OwnedFd> {
    let fd = unsafe { socket(domain, ty | SOCK_CLOEXEC, protocol) };
    check(fd as isize)?;
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

pub fn bind_raw<T>(fd: RawFd, addr: &T) -> io::Result<()> {
    let r = unsafe { bind(fd, addr as *const T as *const u8, std::mem::size_of::<T>() as socklen_t) };
    check(r as isize).map(|_| ())
}

pub fn send_raw(fd: RawFd, b: &[u8]) -> io::Result<usize> {
    check(unsafe { send(fd, b.as_ptr(), b.len(), 0) })
}

/// Receive; `Ok(None)` when nothing is waiting and `block` is false.
pub fn recv_raw(fd: RawFd, b: &mut [u8], block: bool) -> io::Result<Option<usize>> {
    let r = unsafe { recv(fd, b.as_mut_ptr(), b.len(), if block { 0 } else { MSG_DONTWAIT }) };
    match check(r) {
        Ok(n) => Ok(Some(n)),
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn setsockopt_int(fd: RawFd, level: c_int, name: c_int, v: c_int) -> io::Result<()> {
    let r = unsafe { setsockopt(fd, level, name, &v as *const c_int as *const u8, 4) };
    check(r as isize).map(|_| ())
}

pub fn ifindex(name: &str) -> io::Result<u32> {
    let mut c = name.as_bytes().to_vec();
    c.push(0);
    match unsafe { if_nametoindex(c.as_ptr()) } {
        0 => Err(io::Error::new(io::ErrorKind::NotFound, format!("no interface {name}"))),
        i => Ok(i),
    }
}

/// This interface's MAC (sysfs).
pub fn mac_of(ifname: &str) -> io::Result<[u8; 6]> {
    let s = std::fs::read_to_string(format!("/sys/class/net/{ifname}/address"))?;
    parse_mac(s.trim()).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("bad MAC {s:?}")))
}

pub fn parse_mac(s: &str) -> Option<[u8; 6]> {
    let mut m = [0u8; 6];
    let mut it = s.split(':');
    for b in m.iter_mut() {
        *b = u8::from_str_radix(it.next()?, 16).ok()?;
    }
    it.next().is_none().then_some(m)
}

pub fn fmt_mac(m: &[u8; 6]) -> String {
    m.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":")
}
