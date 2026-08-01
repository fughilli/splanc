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
    // Hidden-buffer/texture arena (the browser mirror of the device's fx arena).
    // BYTE-addressed (FUG-10 packed storage). Sized to prog.arena_bytes(led_count)
    // in update(); resize preserves contents so buffers persist across frames
    // (only grows/pads when led_count changes).
    arena: Vec<u8>,
    // Per-LED topology (LED order), mirroring the device's FX_LED_TOPO cache so
    // led.seg / led.s / led.branch preview identically to the firmware. Empty
    // until set_topology() is called (then shade() reads seg=-1/s=0/branch=false,
    // like a map with no topology). See firmware/player_app/ffi.rs fx_rebuild_topo.
    topo_seg: Vec<i32>,
    topo_s: Vec<f32>,
    topo_branch: Vec<u8>,
    topo_dist: Vec<f32>,
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
            arena: Vec::new(),
            topo_seg: Vec::new(),
            topo_s: Vec::new(),
            topo_branch: Vec::new(),
            topo_dist: Vec::new(),
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
    pub fn set_topology(&mut self, seg: &[i32], s: &[f32], branch: &[u8], dist: &[f32]) {
        self.topo_seg = seg.to_vec();
        self.topo_s = s.to_vec();
        self.topo_branch = branch.to_vec();
        self.topo_dist = dist.to_vec();
    }

    /// Provide the topology graph (per-segment length + endpoint node ids) so the
    /// graph-query intrinsics (seg_len/node_seg/…) work in the preview — the
    /// browser mirror of the device's set_graph. Pass empty slices to clear.
    pub fn set_graph(&mut self, seg_len: &[f32], seg_a: &[i32], seg_b: &[i32]) {
        self.vm.set_graph(seg_len, seg_a, seg_b);
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
            // Size + (re)bind the hidden-buffer arena for this led_count. Resize
            // preserves existing contents (persistence); rebind every tick since
            // a resize may move the Vec's backing store.
            let need = prog.arena_bytes(led_count as usize);
            if self.arena.len() != need {
                self.arena.resize(need, 0);
            }
            self.vm.set_arena(&mut self.arena);
            self.vm.run_update(&prog, &self.frame);
        }
    }

    /// Shade all LEDs. `positions` is flat xyz (len = 3*N); returns flat RGB
    /// u8 (len = 3*N) aligned to the map's LED order.
    pub fn shade_all(&self, positions: &[f32]) -> Vec<u8> {
        let n = positions.len() / 3;
        let mut out = Vec::with_capacity(n * 3);
        // Map XY bounds for led.uv (mirrors the device's fx_rebuild_topo): a
        // top-down projection of the LED positions to 0..1.
        let mut mn = [f32::INFINITY; 2];
        let mut mx = [f32::NEG_INFINITY; 2];
        for i in 0..n {
            for k in 0..2 {
                let v = positions[3 * i + k];
                mn[k] = mn[k].min(v);
                mx[k] = mx[k].max(v);
            }
        }
        let inv = [
            if mx[0] - mn[0] > 1e-6 { 1.0 / (mx[0] - mn[0]) } else { 0.0 },
            if mx[1] - mn[1] > 1e-6 { 1.0 / (mx[1] - mn[1]) } else { 0.0 },
        ];
        if let Ok(prog) = Program::parse(&self.bytes) {
            for i in 0..n {
                let uv = [
                    ((positions[3 * i] - mn[0]) * inv[0]).clamp(0.0, 1.0),
                    ((positions[3 * i + 1] - mn[1]) * inv[1]).clamp(0.0, 1.0),
                ];
                let led = Led {
                    pos: [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]],
                    idx: i as u32,
                    seg: self.topo_seg.get(i).copied().unwrap_or(-1),
                    s: self.topo_s.get(i).copied().unwrap_or(0.0),
                    branch: self.topo_branch.get(i).copied().unwrap_or(0) != 0,
                    dist: self.topo_dist.get(i).copied().unwrap_or(0.0),
                    uv,
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
