//! wasm-bindgen surface over `lh_web` (core.rs): the lighthouse pipeline for the
//! browser. The page owns WebHID (feature reports are promises, input reports
//! events); this module is synchronous: the handshake comes back as one step at a
//! time (`handshake` → perform → `handshake_answer` → `handshake` …), reports and
//! clock ticks go in, events come out as a JSON array from `drain`.
//! web/src/p4demo/lh/ wraps it (and may run it in a worker: worker.js).

use lh_web::{json_str, Answer, Options, Session, Step};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct LhTracker {
    s: Session,
}

fn sets_json(sets: &[Vec<u8>]) -> String {
    let mut o = String::from("[");
    for (i, s) in sets.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push('[');
        for (k, b) in s.iter().enumerate() {
            if k > 0 {
                o.push(',');
            }
            o.push_str(&b.to_string());
        }
        o.push(']');
    }
    o.push(']');
    o
}

#[wasm_bindgen]
impl LhTracker {
    /// `host_clock`: map device clocks onto report arrival times (lhd --host-clock);
    /// `stream`: with it, stream sweeps into the filter (lhd --stream-sweeps, the P4).
    #[wasm_bindgen(constructor)]
    pub fn new(host_clock: bool, stream: bool) -> LhTracker {
        LhTracker { s: Session::new(Options { host_clock, stream }) }
    }

    /// A HID device was opened: its handle, or 0 if it isn't a known Vive device.
    pub fn add_device(&mut self, vid: u16, pid: u16) -> u32 {
        self.s.add_device(vid, pid)
    }

    pub fn remove_device(&mut self, handle: u32) {
        self.s.remove_device(handle)
    }

    /// The next handshake step, JSON:
    ///   {"step":"pending","sets":[[…]],"delay_ms":n,"get":id,"len":n}
    ///   {"step":"ready","sets":[[…]],"serial":"…"}
    ///   {"step":"failed","why":"…"}
    pub fn handshake(&mut self, handle: u32) -> String {
        match self.s.handshake(handle) {
            Step::Pending { sets, delay_ms, get, len } => format!(
                "{{\"step\":\"pending\",\"sets\":{},\"delay_ms\":{},\"get\":{},\"len\":{}}}",
                sets_json(&sets),
                delay_ms,
                get,
                len
            ),
            Step::Ready { sets, serial } => {
                format!("{{\"step\":\"ready\",\"sets\":{},\"serial\":{}}}", sets_json(&sets), json_str(&serial))
            }
            Step::Failed { why } => format!("{{\"step\":\"failed\",\"why\":{}}}", json_str(&why)),
        }
    }

    /// The answer to the pending GET `report_id`: `status` 0 = ok (`data`, report id
    /// first), 1 = NAK / not answered (retried), 2 = device gone.
    pub fn handshake_answer(&mut self, handle: u32, report_id: u8, status: u8, data: &[u8]) {
        let a = match status {
            0 => Answer::Ok(data.to_vec()),
            2 => Answer::Gone,
            _ => Answer::Nak,
        };
        self.s.handshake_answer(handle, report_id, a)
    }

    /// One input report (report id first) from HID interface `interface` (a dongle: 0),
    /// arrived at `host_us` (µs, the page's performance.now() * 1000).
    pub fn report(&mut self, handle: u32, interface: i32, data: &[u8], host_us: f64) {
        self.s.report(handle, interface, data, host_us as i64)
    }

    /// Many reports in one call (fewer crossings, and one worker message):
    /// `packed` is [handle u32 LE, interface i32 LE, host_us f64 LE, len u16 LE, bytes…]*.
    pub fn reports(&mut self, packed: &[u8]) {
        let mut p = 0;
        while p + 18 <= packed.len() {
            let u32_at = |i: usize| u32::from_le_bytes([packed[i], packed[i + 1], packed[i + 2], packed[i + 3]]);
            let handle = u32_at(p);
            let interface = u32_at(p + 4) as i32;
            let mut f = [0u8; 8];
            f.copy_from_slice(&packed[p + 8..p + 16]);
            let host_us = f64::from_le_bytes(f);
            let len = u16::from_le_bytes([packed[p + 16], packed[p + 17]]) as usize;
            p += 18;
            if p + len > packed.len() {
                break;
            }
            self.s.report(handle, interface, &packed[p..p + len], host_us as i64);
            p += len;
        }
    }

    /// Housekeeping (~10 Hz): quiet wireless devices, health aging. Returns the handles
    /// whose tracker went away (handshake them again).
    pub fn tick(&mut self, host_us: f64) -> Vec<u32> {
        self.s.tick(host_us as i64)
    }

    /// A saved station: `pose` [x y z qw qx qy qz] (world <- station, m), `cov` 36,
    /// `cal` 10 numbers ([phase tilt curve gibphase gibmag] per axis) or empty.
    pub fn station_prior(&mut self, id: u32, pose: &[f64], cov: &[f64], cal: &[f64]) -> Result<(), JsValue> {
        self.s.station_prior(id, pose, cov, cal).map_err(|e| JsValue::from_str(&e))
    }

    pub fn recalibrate(&mut self) {
        self.s.recalibrate()
    }

    /// Forget the stations: calibrate from still scenes again.
    pub fn reset(&mut self) {
        self.s.reset()
    }

    /// The events since the last call, a JSON array (see core.rs drain_kernel).
    pub fn drain(&mut self) -> String {
        self.s.drain()
    }
}
