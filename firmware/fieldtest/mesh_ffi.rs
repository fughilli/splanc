//! The field kit's mesh mode (TEST-ONLY, never ships): the real M1 `splanc_mesh::Node`
//! (swarm_net managed flooding) on the C6's VENDOR Wi-Fi stack, through a raw-frame shim
//! backhaul in field_node.cpp. A stand-in for M3's netstack backhaul so the flood can be
//! measured over real radios; it speaks the same frames as the Pi's `pimesh node`
//! (Public Action 04 09, CID 0A 5C 4D, kind 0x01, the M1 link frame, MTU 250).
#![no_std]

use splanc_mesh::{Backhaul, BackhaulId, Busy, Node, NodeConfig, NodeId, RxMeta};
use swarm_net::net::{NetOf, PORT_APP};
use swarm_net::update::Flash;

#[cfg(all(not(test), target_os = "none"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

extern "C" {
    /// field_node.cpp: send `frame` (the mesh bytes after our 6-byte prefix) to `mac`
    /// (broadcast if null). True if queued.
    fn fm_radio_send(frame: *const u8, len: usize, mac: *const u8) -> bool;
}

const P: usize = 200;
const MTU: usize = 250;
const PEERS: usize = 32;

struct Shim {
    peers: [(NodeId, [u8; 6], i64); PEERS],
    now_us: i64,
    sent: u32,
    busy: u32,
}

impl Backhaul for Shim {
    fn mtu(&self) -> usize {
        MTU
    }
    fn send(&mut self, frame: &[u8], dst: Option<NodeId>) -> Result<(), Busy> {
        let mac = dst.and_then(|d| self.peers.iter().find(|p| p.0 == d && p.2 != 0).map(|p| p.1));
        let ok = unsafe {
            fm_radio_send(frame.as_ptr(), frame.len(), mac.as_ref().map_or(core::ptr::null(), |m| m.as_ptr()))
        };
        if ok {
            self.sent += 1;
            Ok(())
        } else {
            self.busy += 1;
            Err(Busy)
        }
    }
    fn recv(&mut self, _buf: &mut [u8]) -> Option<RxMeta> {
        None // frames are pushed in by fm_on_rx
    }
    fn may_send(&self, _now_us: i64) -> bool {
        true
    }
}

impl Shim {
    fn learn(&mut self, id: NodeId, mac: [u8; 6]) {
        let now = self.now_us.max(1);
        if let Some(p) = self.peers.iter_mut().find(|p| p.0 == id) {
            p.1 = mac;
            p.2 = now;
            return;
        }
        let oldest = self.peers.iter_mut().min_by_key(|p| p.2).unwrap();
        *oldest = (id, mac, now);
    }
}

/// Firmware-update frames are not used by the field kit: no flash behind them.
struct NoFlash;
impl Flash for NoFlash {
    fn capacity(&self) -> u32 {
        0
    }
    fn erase(&mut self, _o: u32, _l: u32) -> bool {
        false
    }
    fn write(&mut self, _o: u32, _d: &[u8]) -> bool {
        false
    }
    fn read(&mut self, _o: u32, _b: &mut [u8]) -> bool {
        false
    }
}

static mut NODE: Option<Node<Shim, P>> = None;
static mut SCRATCH: [u8; 1024] = [0; 1024];

#[allow(static_mut_refs)]
fn node() -> Option<&'static mut Node<Shim, P>> {
    unsafe { NODE.as_mut() }
}

/// Start (or restart) the node as mesh id `id`; the HMAC key is the Pi bench's (pimesh node).
#[no_mangle]
pub extern "C" fn fm_init(id: u16, hop_limit: u8, seed: u32) -> i32 {
    let mut net = NetOf::<P>::new(id, Some([5; swarm_net::crypto::HMAC_KEY_LEN]), [0; 65], 1, seed);
    if hop_limit > 0 {
        net.mesh.cfg.hop_limit = hop_limit;
    }
    let shim = Shim { peers: [(0, [0; 6], 0); PEERS], now_us: 0, sent: 0, busy: 0 };
    match Node::new(net, shim, NodeConfig::default()) {
        Ok(n) => {
            #[allow(static_mut_refs)]
            unsafe {
                NODE = Some(n);
                if n_scratch() > SCRATCH.len() {
                    return -2;
                }
            }
            0
        }
        Err(_) => -1,
    }
}

fn n_scratch() -> usize {
    node().map_or(0, |n| n.scratch_len())
}

#[no_mangle]
pub extern "C" fn fm_stop() {
    unsafe {
        NODE = None;
    }
}

/// One received mesh frame (the bytes after the prefix).
#[no_mangle]
pub extern "C" fn fm_on_rx(frame: *const u8, len: usize, rssi: i8, rx_us: i64, mac: *const u8) {
    let Some(n) = node() else { return };
    let f = unsafe { core::slice::from_raw_parts(frame, len) };
    let mut m = [0u8; 6];
    m.copy_from_slice(unsafe { core::slice::from_raw_parts(mac, 6) });
    if let Ok(r) = splanc_mesh::link::decode(f) {
        n.backhaul.learn(r.src, m);
    }
    let meta = RxMeta { len, rssi_dbm: rssi, rx_us, src_mac: m, backhaul: BackhaulId(0) };
    n.on_rx(f, &meta, &mut NoFlash);
}

#[no_mangle]
#[allow(static_mut_refs)]
pub extern "C" fn fm_tick(now_us: i64) {
    let Some(n) = node() else { return };
    n.backhaul.now_us = now_us;
    unsafe { n.tick(now_us, &mut NoFlash, &mut SCRATCH) };
}

/// Flood `payload` to every node on the app port. Returns the packet id, or -1.
#[no_mangle]
pub extern "C" fn fm_send(dest: u16, payload: *const u8, len: usize) -> i32 {
    let Some(n) = node() else { return -1 };
    let p = unsafe { core::slice::from_raw_parts(payload, len) };
    n.net.send(dest, PORT_APP, p, false).map_or(-1, |id| id as i32)
}

#[repr(C)]
pub struct FmApp {
    pub origin: u16,
    pub dest: u16,
    pub hops: u8,
    pub rssi: i8,
    pub len: u16,
}

/// Next delivered app packet: fills `info` and up to `cap` bytes; false when none.
#[no_mangle]
pub extern "C" fn fm_next(info: *mut FmApp, buf: *mut u8, cap: usize) -> bool {
    let Some(n) = node() else { return false };
    let Some(a) = n.net.next_app() else { return false };
    let k = a.len.min(cap).min(a.payload.len());
    unsafe {
        core::ptr::copy_nonoverlapping(a.payload.as_ptr(), buf, k);
        *info = FmApp { origin: a.origin, dest: a.dest, hops: a.hops, rssi: a.rssi as i8, len: k as u16 };
    }
    true
}

#[repr(C)]
pub struct FmStats {
    pub rx: u32,
    pub rx_rejected: u32,
    pub rx_own: u32,
    pub tx: u32,
    pub beacons: u32,
    pub tx_busy: u32,
    pub radio_sent: u32,
    pub radio_busy: u32,
}

#[no_mangle]
pub extern "C" fn fm_stats(out: *mut FmStats) -> bool {
    let Some(n) = node() else { return false };
    let s = n.stats;
    unsafe {
        *out = FmStats {
            rx: s.rx,
            rx_rejected: s.rx_rejected,
            rx_own: s.rx_own,
            tx: s.tx,
            beacons: s.beacons,
            tx_busy: s.tx_busy,
            radio_sent: n.backhaul.sent,
            radio_busy: n.backhaul.busy,
        };
    }
    true
}
