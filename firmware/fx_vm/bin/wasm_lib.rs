//! wasm binding over the exact firmware VM, for the browser's offline effect
//! preview (docs/design/effects-runtime.md). The app compiles a script to
//! `.fxb` (fx_compiler), hands the bytes here, sets uniforms, ticks update()
//! per rAF, and shades the current map's LED positions → colors for MapView.
//! Running the SAME VM means the preview cannot drift from the device.

use ledmapper_fx_vm::{dbg, Budget, Frame, Led, Program, Vm, MAX_STATE};
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

    /// Stream a full-resolution RGBA frame into texture `tex_index`'s arena
    /// region, so the offline preview shows live video input WITHOUT a device
    /// (FUG-39). This is the browser mirror of the device's handle_set_texture
    /// (firmware/player_app/ffi.rs), minus the quantize/XOR-delta/RLE transport:
    /// the browser already holds raw pixels, so we write straight from RGBA,
    /// PACKED at the texture's component precision (FUG-10 — same luma rule for a
    /// scalar texture). `rgba` is width*height*4 bytes, row-major, top-left
    /// origin. `led_count` MUST match the value passed to update() so the
    /// texture's arena base lines up. Silently drops on any mismatch.
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
        let need = prog.arena_bytes(led_count as usize);
        if self.arena.len() != need {
            self.arena.resize(need, 0);
        }
        let base = prog.buf_base(tex_index, led_count as usize);
        let elem = d.elem as usize;
        let cb = ledmapper_fx_vm::comp_bytes(d.comp);
        let eb = d.elem_bytes();
        for t in 0..n_texels {
            let r = rgba[t * 4] as f32 / 255.0;
            let g = rgba[t * 4 + 1] as f32 / 255.0;
            let b = rgba[t * 4 + 2] as f32 / 255.0;
            let ab = base + t * eb;
            if elem == 1 {
                if ab + cb <= self.arena.len() {
                    let luma = 0.299 * r + 0.587 * g + 0.114 * b;
                    ledmapper_fx_vm::comp_store_num(d.comp, luma, &mut self.arena[ab..ab + cb]);
                }
            } else {
                let ch = [r, g, b, 1.0];
                for (k, &c) in ch.iter().enumerate().take(elem.min(4)) {
                    let o = ab + k * cb;
                    if o + cb <= self.arena.len() {
                        ledmapper_fx_vm::comp_store_num(d.comp, c, &mut self.arena[o..o + cb]);
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
        // Q16.16 mirrors so a fixed-only shader (LoadCtxFix) previews identically
        // to the device, which caches these fixed forms (FUG-122).
        let q16 = |x: f32| (x * 65536.0) as i32;
        self.frame = Frame {
            time,
            dt,
            frame,
            led_count,
            time_fix: q16(time),
            dt_fix: q16(dt),
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
    pub fn shade_all(&mut self, positions: &[f32]) -> Vec<u8> {
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
        // room.min / room.max: the preview shows one unposed fixture, so (like the
        // device) the room box is the map's own 3D box and led.room == led.pos.
        let mut rmn = [f32::INFINITY; 3];
        let mut rmx = [f32::NEG_INFINITY; 3];
        for i in 0..n {
            for k in 0..3 {
                rmn[k] = rmn[k].min(positions[3 * i + k]);
                rmx[k] = rmx[k].max(positions[3 * i + k]);
            }
        }
        let q16b = |x: f32| (x * 65536.0) as i32;
        for k in 0..3 {
            self.frame.room_min[k] = if rmn[k].is_finite() { rmn[k] } else { 0.0 };
            self.frame.room_max[k] = if rmx[k].is_finite() { rmx[k] } else { 0.0 };
            self.frame.room_min_fix[k] = q16b(self.frame.room_min[k]);
            self.frame.room_max_fix[k] = q16b(self.frame.room_max[k]);
        }
        if let Ok(prog) = Program::parse(&self.bytes) {
            for i in 0..n {
                let uv = [
                    ((positions[3 * i] - mn[0]) * inv[0]).clamp(0.0, 1.0),
                    ((positions[3 * i + 1] - mn[1]) * inv[1]).clamp(0.0, 1.0),
                ];
                let q16 = |x: f32| (x * 65536.0) as i32;
                let s = self.topo_s.get(i).copied().unwrap_or(0.0);
                let dist = self.topo_dist.get(i).copied().unwrap_or(0.0);
                let led = Led {
                    pos: [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]],
                    idx: i as u32,
                    seg: self.topo_seg.get(i).copied().unwrap_or(-1),
                    s,
                    branch: self.topo_branch.get(i).copied().unwrap_or(0) != 0,
                    dist,
                    uv,
                    // Q16.16 mirrors for LoadCtxFix (device↔preview parity).
                    pos_fix: [q16(positions[3 * i]), q16(positions[3 * i + 1]), q16(positions[3 * i + 2])],
                    uv_fix: [q16(uv[0]), q16(uv[1])],
                    s_fix: q16(s),
                    dist_fix: q16(dist),
                    // Unposed: the VM reads led.pos for led.room (frame.room_posed).
                    room: [0.0; 3],
                    room_fix: [0; 3],
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

/// Host replay of a device frame for the FX debugger (docs/design/fx-debugger.md,
/// web/src/fx/fxDebug.ts): the SAME VM, restored to a device snapshot (uniforms,
/// `state` + the flood field, buffer arena, topology graph) and fed the device's
/// exact frame context (FX_FRAME_V1) and per-LED inputs (FX_LED_V1 records), so
/// its output can be diffed against the device's bit for bit.
#[wasm_bindgen]
pub struct FxReplay {
    bytes: Vec<u8>,
    vm: Vm,
    frame: Frame,
    arena: Vec<u8>,
    budget: u32,
}

#[wasm_bindgen]
impl FxReplay {
    #[wasm_bindgen(constructor)]
    pub fn new(fxb: &[u8]) -> Result<FxReplay, JsValue> {
        Program::parse(fxb).map_err(|_| JsValue::from_str("invalid .fxb"))?;
        Ok(FxReplay {
            bytes: fxb.to_vec(),
            vm: Vm::new(),
            frame: Frame::default(),
            arena: Vec::new(),
            budget: ledmapper_fx_vm::DEFAULT_BUDGET,
        })
    }

    /// The per-invocation instruction budget (the device's `budget`).
    pub fn set_budget(&mut self, instructions: u32) {
        self.budget = if instructions == 0 {
            ledmapper_fx_vm::DEFAULT_BUDGET
        } else {
            instructions
        };
    }

    /// Every uniform slot (SECTION_UNIFORMS as f32s).
    pub fn set_uniforms(&mut self, vals: &[f32]) {
        for (dst, v) in self.vm.uniforms.iter_mut().zip(vals) {
            *dst = *v;
        }
    }

    /// SECTION_STATE as u32 words: `state` slots, then the flood_from field.
    pub fn set_state(&mut self, words: &[u32]) {
        for (dst, w) in self.vm.state.iter_mut().zip(words) {
            *dst = f32::from_bits(*w);
        }
        self.vm
            .set_flood_words(words.get(MAX_STATE..).unwrap_or(&[]));
    }

    /// The state in SECTION_STATE's layout (to diff against the device's).
    pub fn state(&self) -> Vec<u32> {
        let mut out: Vec<u32> = self.vm.state.iter().map(|v| v.to_bits()).collect();
        out.extend((0..Vm::FLOOD_WORDS).map(|k| self.vm.flood_word(k)));
        out
    }

    /// SECTION_GRAPH: n_seg, then (len f32, node a, node b) per segment, as words.
    pub fn set_graph_words(&mut self, words: &[u32]) {
        let n = words.first().copied().unwrap_or(0) as usize;
        let n = n.min(words.len().saturating_sub(1) / 3);
        let seg = |k: usize, j: usize| words[1 + 3 * k + j];
        let len: Vec<f32> = (0..n).map(|k| f32::from_bits(seg(k, 0))).collect();
        let a: Vec<i32> = (0..n).map(|k| seg(k, 1) as i32).collect();
        let b: Vec<i32> = (0..n).map(|k| seg(k, 2) as i32).collect();
        self.vm.set_graph(&len, &a, &b);
    }

    /// SECTION_ARENA: the deck's buffer arena, raw.
    pub fn set_arena(&mut self, bytes: &[u8]) {
        self.arena = bytes.to_vec();
        self.vm.set_arena(&mut self.arena);
    }

    pub fn arena(&self) -> Vec<u8> {
        self.arena.clone()
    }

    /// FX_FRAME_V1 (fx_debug.state.frame_ctx). False when malformed.
    pub fn set_frame(&mut self, ctx: &[u8]) -> bool {
        match dbg::frame_from_ctx(ctx) {
            Some(f) => {
                self.frame = f;
                true
            }
            None => false,
        }
    }

    /// Run update() once. Returns the outcome (0 ok, 1 budget, 2 timeout).
    pub fn update(&mut self) -> u32 {
        let Ok(prog) = Program::parse(&self.bytes) else {
            return 1;
        };
        self.vm.set_arena(&mut self.arena);
        self.vm
            .run_update_bounded(&prog, &self.frame, &Budget::instructions(self.budget))
            as u32
    }

    /// Shade LED `idx` from its FX_LED_V1 record: [r, g, b, outcome, has_ctx].
    /// No map entry -> black (the device holds black too).
    pub fn shade(&mut self, rec: &[u8], idx: u32) -> Vec<u8> {
        self.shade_inner(rec, idx, false).0
    }

    /// Like `shade`, but LED `idx`'s per-LED buffer elements are restored after
    /// the run (the device's debugger re-runs: no side effect on the state).
    pub fn shade_isolated(&mut self, rec: &[u8], idx: u32) -> Vec<u8> {
        let saved = self.save_led(idx);
        let out = self.shade_inner(rec, idx, false).0;
        self.restore_led(idx, &saved);
        out
    }

    /// The device's debug_fx_led run: isolated (as `shade_isolated`) on zeroed
    /// scratch. Returns [r, g, b, outcome, has_ctx, instrs (u32 LE), stack_max
    /// (u16 LE)]; read the locals with `locals()`.
    pub fn shade_debug(&mut self, rec: &[u8], idx: u32) -> Vec<u8> {
        let saved = self.save_led(idx);
        let (mut out, instrs, stack) = self.shade_inner(rec, idx, true);
        self.restore_led(idx, &saved);
        out.extend(instrs.to_le_bytes());
        out.extend(stack.to_le_bytes());
        out
    }

    /// The VM locals after the last shade (f32).
    pub fn locals(&self) -> Vec<f32> {
        self.vm.locals().to_vec()
    }
}

impl FxReplay {
    /// (offset, bytes) of LED `idx`'s per-LED buffer elements.
    fn save_led(&self, idx: u32) -> Vec<(usize, Vec<u8>)> {
        let mut out = Vec::new();
        if let Ok(prog) = Program::parse(&self.bytes) {
            dbg::led_elem_ranges(
                &prog,
                self.frame.led_count as usize,
                idx as usize,
                |o, l| {
                    if let Some(b) = self.arena.get(o..o + l) {
                        out.push((o, b.to_vec()));
                    }
                },
            );
        }
        out
    }

    fn restore_led(&mut self, _idx: u32, saved: &[(usize, Vec<u8>)]) {
        for (o, b) in saved {
            self.arena[*o..*o + b.len()].copy_from_slice(b);
        }
    }

    fn shade_inner(&mut self, rec: &[u8], idx: u32, debug: bool) -> (Vec<u8>, u32, u16) {
        let Ok(prog) = Program::parse(&self.bytes) else {
            return (vec![0, 0, 0, 1, 0], 0, 0);
        };
        let Some(led) = dbg::led_from_record(rec, idx) else {
            return (vec![0, 0, 0, 0, 0], 0, 0);
        };
        if debug {
            self.vm.clear_scratch();
        }
        self.vm.set_arena(&mut self.arena);
        let budget = Budget::instructions(self.budget);
        let ((r, g, b), oc, c) = self.vm.run_shade_counted(&prog, &self.frame, &led, &budget);
        (vec![r, g, b, oc as u8, 1], c.instrs, c.stack_max)
    }
}

/// The device's crossfade blend of two decks' colours (ledmapper_keypoint
/// blend_rgb8: mode 0 = linear RGB, 1 = HSV shortest hue).
#[wasm_bindgen]
pub fn fx_blend_rgb8(a: &[u8], b: &[u8], t: f32, mode: u32) -> Vec<u8> {
    let g = |s: &[u8]| {
        (
            s.first().copied().unwrap_or(0),
            s.get(1).copied().unwrap_or(0),
            s.get(2).copied().unwrap_or(0),
        )
    };
    let (r, gg, bl) = ledmapper_keypoint::blend_rgb8(g(a), g(b), t, mode);
    vec![r, gg, bl]
}
