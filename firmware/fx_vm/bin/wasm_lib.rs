//! wasm binding over the exact firmware VM, for the browser's offline effect
//! preview (docs/design/effects-runtime.md). The app compiles a script to
//! `.fxb` (fx_compiler), hands the bytes here, sets uniforms, ticks update()
//! per rAF, and shades the current map's LED positions → colors for MapView.
//! Running the SAME VM means the preview cannot drift from the device.

use ledmapper_fx_vm::{Frame, Led, Program, Vm};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct FxPreview {
    bytes: Vec<u8>, // owned .fxb; re-parsed per tick (cheap header parse)
    vm: Vm,
    frame: Frame,
    // Per-LED topology (LED order), mirroring the device's FX_LED_TOPO cache so
    // led.seg / led.s / led.branch preview identically to the firmware. Empty
    // until set_topology() is called (then shade() reads seg=-1/s=0/branch=false,
    // like a map with no topology). See firmware/player_app/ffi.rs fx_rebuild_topo.
    topo_seg: Vec<i32>,
    topo_s: Vec<f32>,
    topo_branch: Vec<u8>,
}

#[wasm_bindgen]
impl FxPreview {
    #[wasm_bindgen(constructor)]
    pub fn new(fxb: &[u8]) -> Result<FxPreview, JsValue> {
        Program::parse(fxb).map_err(|_| JsValue::from_str("invalid .fxb"))?;
        Ok(FxPreview {
            bytes: fxb.to_vec(),
            vm: Vm::new(),
            frame: Frame::default(),
            topo_seg: Vec::new(),
            topo_s: Vec::new(),
            topo_branch: Vec::new(),
        })
    }

    /// Set a uniform's value(s) live (slot count = its width).
    pub fn set_uniform(&mut self, slot: usize, vals: &[f32]) {
        self.vm.set_uniform(slot, vals);
    }

    /// Provide per-LED topology (LED order) so shade() sees led.seg / led.s /
    /// led.branch — the browser mirror of the device's FX_LED_TOPO cache. `seg`
    /// is the segment index (-1 = none), `s` normalized 0..1, `branch` 0/1. The
    /// three slices must be LED-count long; pass empty slices to clear.
    pub fn set_topology(&mut self, seg: &[i32], s: &[f32], branch: &[u8]) {
        self.topo_seg = seg.to_vec();
        self.topo_s = s.to_vec();
        self.topo_branch = branch.to_vec();
    }

    /// Advance one frame: sets time/dt/frame and runs update().
    pub fn update(&mut self, time: f32, dt: f32, frame: u32, led_count: u32) {
        self.frame = Frame {
            time,
            dt,
            frame,
            led_count,
            ..Default::default()
        };
        if let Ok(prog) = Program::parse(&self.bytes) {
            self.vm.run_update(&prog, &self.frame);
        }
    }

    /// Shade all LEDs. `positions` is flat xyz (len = 3*N); returns flat RGB
    /// u8 (len = 3*N) aligned to the map's LED order.
    pub fn shade_all(&self, positions: &[f32]) -> Vec<u8> {
        let n = positions.len() / 3;
        let mut out = Vec::with_capacity(n * 3);
        if let Ok(prog) = Program::parse(&self.bytes) {
            for i in 0..n {
                let led = Led {
                    pos: [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]],
                    idx: i as u32,
                    seg: self.topo_seg.get(i).copied().unwrap_or(-1),
                    s: self.topo_s.get(i).copied().unwrap_or(0.0),
                    branch: self.topo_branch.get(i).copied().unwrap_or(0) != 0,
                };
                let (r, g, b) = self.vm.run_shade(&prog, &self.frame, &led);
                out.push(r);
                out.push(g);
                out.push(b);
            }
        }
        out
    }
}
