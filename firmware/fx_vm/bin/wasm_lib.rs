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
    // Sized to prog.arena_slots(led_count) in update(); resize preserves contents
    // so buffers persist across frames (only grows/pads when led_count changes).
    arena: Vec<f32>,
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

    /// Stream a full-resolution RGBA frame into texture `tex_index`'s arena
    /// slots, so the offline preview shows live video input WITHOUT a device
    /// (FUG-39). This is the browser mirror of the device's handle_set_texture
    /// (firmware/player_app/ffi.rs), minus the quantize/XOR-delta/RLE transport:
    /// the browser already holds raw pixels, so we dequantize-equivalent straight
    /// from RGBA into f32 slots (same luma rule for a scalar texture). `rgba` is
    /// width*height*4 bytes, row-major, top-left origin. `led_count` MUST match
    /// the value passed to update() so the texture's arena base lines up. Silently
    /// drops on any mismatch, exactly like the firmware.
    pub fn set_texture(&mut self, tex_index: usize, width: u32, height: u32, rgba: &[u8], led_count: u32) {
        let Ok(prog) = Program::parse(&self.bytes) else {
            return;
        };
        let Some(d) = prog.buf_desc(tex_index) else {
            return;
        };
        if d.kind != 1 || d.w as u32 != width || d.h as u32 != height {
            return; // not a texture, or dimensions don't match the declared one
        }
        let n_texels = width as usize * height as usize;
        if rgba.len() < n_texels * 4 {
            return;
        }
        // Size + (re)bind the arena for this led_count, mirroring update(): a
        // resize preserves other buffers' contents so feedback/textures persist.
        let need = prog.arena_slots(led_count as usize);
        if self.arena.len() != need {
            self.arena.resize(need, 0.0);
        }
        let base = prog.buf_base(tex_index, led_count as usize);
        let elem = d.elem as usize;
        for t in 0..n_texels {
            let r = rgba[t * 4] as f32 / 255.0;
            let g = rgba[t * 4 + 1] as f32 / 255.0;
            let b = rgba[t * 4 + 2] as f32 / 255.0;
            let ab = base + t * elem;
            if elem == 1 {
                if ab < self.arena.len() {
                    self.arena[ab] = 0.299 * r + 0.587 * g + 0.114 * b; // luma
                }
            } else {
                let ch = [r, g, b, 1.0];
                for (k, &c) in ch.iter().enumerate().take(elem.min(4)) {
                    if ab + k < self.arena.len() {
                        self.arena[ab + k] = c;
                    }
                }
            }
        }
        // A resize above may have moved the backing store; shade_all() reads the
        // arena via the pointer bound here (it never re-binds itself), so refresh
        // it now rather than wait for the next update().
        self.vm.set_arena(&mut self.arena);
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
            let need = prog.arena_slots(led_count as usize);
            if self.arena.len() != need {
                self.arena.resize(need, 0.0);
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
