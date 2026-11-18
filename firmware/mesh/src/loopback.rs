//! An in-memory backhaul for host tests (feature `loopback`, or this crate's own tests): N
//! ports on one shared medium with per-link RSSI (or no link), random loss, per-port MTU and
//! a bounded RX queue. Link broadcasts reach every port in range; a link unicast reaches
//! only the addressed node (if in range), as an 802.11 receiver filters by address.
//!
//! Not a radio model (no airtime, collisions or clocks): the `meshsim` of design §14.1
//! builds those on the same [`Backhaul`] seam.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use crate::backhaul::{Backhaul, BackhaulId, Busy, NodeId, RxMeta};

struct Frame {
    bytes: Vec<u8>,
    meta: RxMeta,
}

struct Medium {
    /// links[from][to]: RSSI if `to` hears `from`.
    links: Vec<Vec<Option<i8>>>,
    ids: Vec<Option<NodeId>>,
    queues: Vec<VecDeque<Frame>>,
    loss: f32,
    rng: u64,
    now_us: i64,
    sent: u64,
    lost: u64,
    overflowed: u64,
}

impl Medium {
    fn lost(&mut self) -> bool {
        // xorshift64
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        ((self.rng >> 11) as f64 / (1u64 << 53) as f64) < self.loss as f64
    }
}

/// The shared medium. Cheap to clone (a handle).
#[derive(Clone)]
pub struct Air(Rc<RefCell<Medium>>);

/// Per-port RX queue depth.
pub const QUEUE: usize = 32;

impl Air {
    /// `n` ports, no links.
    pub fn new(n: usize) -> Air {
        Air(Rc::new(RefCell::new(Medium {
            links: vec![vec![None; n]; n],
            ids: vec![None; n],
            queues: (0..n).map(|_| VecDeque::new()).collect(),
            loss: 0.0,
            rng: 0x9E37_79B9_7F4A_7C15,
            now_us: 0,
            sent: 0,
            lost: 0,
            overflowed: 0,
        })))
    }

    /// Everyone hears everyone at `rssi_dbm`.
    pub fn full(n: usize, rssi_dbm: i8) -> Air {
        let air = Air::new(n);
        for i in 0..n {
            for j in 0..n {
                if i != j {
                    air.link(i, j, Some(rssi_dbm));
                }
            }
        }
        air
    }

    /// A line: each port hears only its neighbours, at -80 dBm.
    pub fn line(n: usize) -> Air {
        let air = Air::new(n);
        for i in 1..n {
            air.link(i - 1, i, Some(-80));
            air.link(i, i - 1, Some(-80));
        }
        air
    }

    /// Whether (and how loud) port `to` hears port `from`.
    pub fn link(&self, from: usize, to: usize, rssi_dbm: Option<i8>) {
        self.0.borrow_mut().links[from][to] = rssi_dbm;
    }

    /// Probability that a receiver misses a frame.
    pub fn set_loss(&self, loss: f32) {
        self.0.borrow_mut().loss = loss;
    }

    /// The time stamped on frames sent from now on (the receivers' `rx_us`).
    pub fn set_now(&self, now_us: i64) {
        self.0.borrow_mut().now_us = now_us;
    }

    /// (frames sent, receptions lost, receptions dropped on a full queue).
    pub fn counts(&self) -> (u64, u64, u64) {
        let m = self.0.borrow();
        (m.sent, m.lost, m.overflowed)
    }

    /// Port `index`, for node `id` (link unicasts to `id` reach it), with this MTU.
    pub fn port(&self, index: usize, id: NodeId, mtu: usize) -> Port {
        self.0.borrow_mut().ids[index] = Some(id);
        Port { air: self.clone(), index, mtu, backhaul: BackhaulId(0) }
    }
}

/// One node's end of the [`Air`].
pub struct Port {
    air: Air,
    index: usize,
    mtu: usize,
    backhaul: BackhaulId,
}

impl Backhaul for Port {
    fn mtu(&self) -> usize {
        self.mtu
    }

    fn send(&mut self, frame: &[u8], dst: Option<NodeId>) -> Result<(), Busy> {
        // Oversized frames would not leave a real radio either.
        assert!(frame.len() <= self.mtu, "frame of {} bytes over the {}-byte MTU", frame.len(), self.mtu);
        let mut m = self.air.0.borrow_mut();
        m.sent += 1;
        let mut src_mac = [0x02, 0, 0, 0, 0, 0];
        src_mac[4..].copy_from_slice(&(self.index as u16).to_be_bytes());
        for to in 0..m.links.len() {
            let Some(rssi) = m.links[self.index][to] else { continue };
            if dst.is_some() && m.ids[to] != dst {
                continue;
            }
            if m.lost() {
                m.lost += 1;
                continue;
            }
            if m.queues[to].len() >= QUEUE {
                m.overflowed += 1;
                continue;
            }
            let meta = RxMeta { len: frame.len(), rssi_dbm: rssi, rx_us: m.now_us, src_mac, backhaul: self.backhaul };
            m.queues[to].push_back(Frame { bytes: frame.to_vec(), meta });
        }
        Ok(())
    }

    fn recv(&mut self, buf: &mut [u8]) -> Option<RxMeta> {
        let f = self.air.0.borrow_mut().queues[self.index].pop_front()?;
        let n = f.bytes.len().min(buf.len());
        buf[..n].copy_from_slice(&f.bytes[..n]);
        Some(RxMeta { len: n, ..f.meta })
    }

    fn may_send(&self, _now_us: i64) -> bool {
        true
    }
}
