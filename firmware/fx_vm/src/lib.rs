//! Effects bytecode VM (see docs/design/effects-runtime.md).
//!
//! A tiny stack machine over `f32` slots (a `vecN` is N contiguous slots; the
//! compiler guarantees types so the VM is untyped at runtime). It runs a
//! program's `update()` once per frame (evolving `state`) and `shade(led)` once
//! per LED (returning linear RGB). no_std, no alloc — bounded fixed arrays,
//! borrows the `.fxb` bytes so the firmware can execute straight from the flash
//! range LittleFS mapped. The SAME crate compiles to wasm for the offline
//! preview, so the browser and the device render identically.
#![no_std]

pub type Rgb = (u8, u8, u8);

pub const MAX_STACK: usize = 128; // f32 slots
pub const MAX_STATE: usize = 128; // raised for arrays/structs (agent sims live here)
pub const MAX_LOCALS: usize = 128;
pub const MAX_UNIFORM_SLOTS: usize = 128;

// Topology graph tables the VM carries for graph-walking effects (agentic
// chasers): segments (length + the two endpoint node ids) and, per node, the
// incident segments. Bounded (≈2.6 KiB) and filled via [`Vm::set_graph`] when
// the topology changes — the graph-query intrinsics (seg_len/node_seg/…) read
// these. Excess segments/nodes/degree are dropped (queries clamp/return 0).
pub const MAX_SEG: usize = 64;
pub const MAX_NODE: usize = 96;
pub const MAX_NODE_DEG: usize = 6;

/// Opcodes. Operands follow inline in the code stream (little-endian).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Op {
    PushConst = 0, // u16 const idx        -> push consts[idx] (1 slot)
    LoadUniform,   // u8 slot, u8 n        -> push uniforms[slot..slot+n]
    LoadState,     // u8 slot, u8 n        -> push state[..]
    StoreState,    // u8 slot, u8 n        -> pop n into state[..]
    LoadLocal,     // u8 slot, u8 n
    StoreLocal,    // u8 slot, u8 n
    LoadCtx,       // u8 id                -> push a context value (size by id)
    // element-wise arithmetic, operand u8 n (components)
    Add,
    Sub,
    Mul,
    Div,
    Neg,
    Scale, // u8 n: pop n-vec then scalar -> n-vec * scalar
    // unary math applied per component, operand: u8 fn, u8 n
    UnMath,
    // binary math per component, operand: u8 fn, u8 n
    BinMath,
    Clamp,      // u8 n: pop x(n),lo(n),hi(n)
    Mix,        // u8 n: pop a(n),b(n),t(1) -> a+(b-a)*t
    Smoothstep, // u8 n: pop e0(n),e1(n),x(n)
    Dot,        // u8 n -> scalar
    Cross,      // (n=3) pop a(3),b(3) -> 3
    Length,     // u8 n -> scalar
    Normalize,  // u8 n
    Distance,   // u8 n -> scalar
    Swizzle,    // u8 srcN, u8 dstN, dstN bytes of component indices
    Cmp,        // u8 kind (0lt 1le 2gt 3ge 4eq 5ne) scalar -> bool(0/1)
    Logic,      // u8 kind (0and 1or 2not)
    BrFalse,    // i16 rel: pop bool; branch if 0
    Jmp,        // i16 rel
    Hash1,      // scalar -> scalar in [0,1)
    Hash3,      // pop vec3 -> scalar
    Hsv2Rgb,    // pop vec3(h,s,v) -> vec3 rgb
    Palette,    // u8 id: pop scalar t -> vec3
    Pop,        // u8 n
    Ret,        // return `n` slots (0 for update, 3 for shade) : u8 n
    // --- integer / Q16.16 fixed-point fast path (scalar, no FPU) ------------
    Swap,   // u8 an, u8 bn : swap the top bn slots with the an below (broadcast)
    AddI,   // i32 add
    SubI,
    MulI,
    DivI,
    ModI,
    NegI,
    CmpI,   // u8 kind : integer compare -> bool
    MulFix, // Q16.16: (a*b)>>16
    DivFix, // Q16.16: (a<<16)/b
    I2F,    // i32 -> f32
    F2I,    // f32 -> i32 (trunc)
    Fix2F,  // Q16.16 -> f32
    F2Fix,  // f32 -> Q16.16
    I2Fix,  // i32 -> Q16.16 (<<16)
    Fix2I,  // Q16.16 -> i32 (>>16)
    // --- user functions -----------------------------------------------------
    Call,  // u16 target : push return pc, jump
    RetFn, // pop return pc, jump back (values left on the operand stack)
    // --- indexed array/struct access (dynamic index) ------------------------
    // Address = base + clamp(i, 0, count-1)*stride + off. The index i (int, in
    // f32 bits) is popped; the clamp keeps a runaway index in-bounds (safe,
    // deterministic) rather than reading/writing past the slot arrays.
    LoadStateIdx, // base:u8 stride:u8 off:u8 n:u8 count:u8 ; pop i -> push n slots
    StoreStateIdx, // base:u8 stride:u8 off:u8 n:u8 count:u8 ; pop n vals then i
    LoadLocalIdx,  // same, over locals
    StoreLocalIdx,
    // --- topology graph queries (agentic/graph-walking effects) --------------
    // u8 kind: 0 seg_count()->int, 1 seg_len(seg)->float, 2 seg_node(seg,side)->int,
    // 3 node_deg(node)->int, 4 node_seg(node,k)->int, 5 node_side(node,k)->int.
    // Int args are popped (2,4,5 pop two; 1,3 pop one; 0 pops none); the result
    // is pushed as a float slot (int results carry their i32 bits). Reads the
    // graph tables the VM was given via set_graph.
    GraphQuery,
    // --- declared buffers / textures (feedback, pixel-space) -----------------
    // LoadBuf u8 id: pop an int index -> push the buffer element's `elem` slots
    // from the arena. StoreBuf u8 id: pop `elem` value slots then an int index ->
    // write the element. The element width/count come from the .fxb buffer desc;
    // the index is clamped in-bounds. No-op / 0 when no arena is bound.
    LoadBuf,
    StoreBuf,
    // --- 2D texture sampling (kind=1 buffers) --------------------------------
    // SampleTex u8 id: pop a uv (vec2, 0..1) -> push `elem` slots, BILINEARLY
    // sampled from the WxH texture (edge-clamped). PaintTex u8 id: pop `elem`
    // colour slots then a uv -> write the NEAREST texel. w/h/elem come from the
    // .fxb buffer desc. No-op / 0 when no arena is bound or the buffer isn't a
    // texture (kind != 1).
    SampleTex,
    PaintTex,
}

/// Graph-query kinds (the `GraphQuery` opcode operand).
pub mod gq {
    pub const SEG_COUNT: u8 = 0;
    pub const SEG_LEN: u8 = 1;
    pub const SEG_NODE: u8 = 2;
    pub const NODE_DEG: u8 = 3;
    pub const NODE_SEG: u8 = 4;
    pub const NODE_SIDE: u8 = 5;
}

pub const FIX_ONE: i32 = 1 << 16;

/// Default per-invocation instruction budget (one `update()` or one `shade()`).
/// A pathological loop trips this deterministically on every platform, so the
/// render task can never hang on a user script. See [`Budget`].
pub const DEFAULT_BUDGET: u32 = 100_000;

/// A bounded-execution guard for one VM invocation (the DECISION in
/// docs/design/effects-runtime.md "Open questions").
///
/// Two independent guards, primary first:
/// 1. **instruction budget** — a hard, deterministic op count. It is the
///    portable, host-testable wall against runaway loops; when it hits zero the
///    invocation unwinds to a [`Outcome::Budget`] timeout.
/// 2. **wall-time deadline flag** — an optional pointer to a flag the VM loop
///    polls each op. On-device a hardware timer (esp_timer/systimer) raises it
///    at a frame-relative deadline (the C++ side owns that timer); the VM sees
///    the raised flag and unwinds to [`Outcome::Timeout`]. On the host it is
///    left `None`, so tests exercise the budget guard alone.
#[derive(Clone, Copy)]
pub struct Budget {
    /// Max instructions before the invocation is cancelled.
    pub instructions: u32,
    /// Optional wall-time cancel flag (raised asynchronously by a hw timer).
    /// `None` = no time guard (host/preview). Read-only from the VM's view.
    pub deadline: Option<*const core::sync::atomic::AtomicBool>,
}

impl Default for Budget {
    fn default() -> Self {
        Budget { instructions: DEFAULT_BUDGET, deadline: None }
    }
}

impl Budget {
    /// A budget with just an instruction cap (no wall-time guard).
    pub fn instructions(n: u32) -> Self {
        Budget { instructions: n, deadline: None }
    }
}

/// Why a VM invocation stopped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    /// Ran to a `Ret`/`RetFn`/end-of-code normally.
    Ok,
    /// The instruction budget was exhausted (runaway loop) — treat as timeout.
    Budget,
    /// The wall-time deadline flag was raised (hardware timer) — treat as
    /// timeout. The caller holds last/black for the affected LED.
    Timeout,
}

impl Outcome {
    /// Whether execution was cancelled by a guard (budget or wall-time).
    #[inline]
    pub fn timed_out(self) -> bool {
        !matches!(self, Outcome::Ok)
    }
}

/// Cheap Tier-1 profiling counters for one VM invocation (perf-monitoring.md
/// "Metrics collected"). Both are near-free by construction: `instrs` is one
/// add per opcode next to the budget decrement already in the dispatch loop,
/// and `stack_max` piggybacks the running stack pointer. Integer-only — no
/// float on the perf path. See [`Vm::run_shade_counted`] / [`run_update_counted`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    /// Opcodes retired this invocation.
    pub instrs: u32,
    /// High-water operand-stack depth (f32 slots) reached this invocation.
    pub stack_max: u16,
}

impl Op {
    #[inline]
    fn from_u8(b: u8) -> Option<Op> {
        // Op is a contiguous enum 0..=PaintTex; guard the range then transmute.
        if b <= Op::PaintTex as u8 {
            Some(unsafe { core::mem::transmute::<u8, Op>(b) })
        } else {
            None
        }
    }
}

// unary math fn ids
pub const F_SIN: u8 = 0;
pub const F_COS: u8 = 1;
pub const F_ABS: u8 = 2;
pub const F_FLOOR: u8 = 3;
pub const F_CEIL: u8 = 4;
pub const F_FRACT: u8 = 5;
pub const F_SQRT: u8 = 6;
pub const F_EXP: u8 = 7;
pub const F_LOG: u8 = 8;
pub const F_SIGN: u8 = 9;
pub const F_TAN: u8 = 10;
// binary math fn ids
pub const B_MIN: u8 = 0;
pub const B_MAX: u8 = 1;
pub const B_POW: u8 = 2;
pub const B_MOD: u8 = 3;
pub const B_STEP: u8 = 4; // step(edge, x)
pub const B_ATAN2: u8 = 5;

// context value ids (LoadCtx)
pub const C_TIME: u8 = 0; // 1
pub const C_DT: u8 = 1; // 1
pub const C_FRAME: u8 = 2; // 1
pub const C_LED_POS: u8 = 3; // 3
pub const C_LED_IDX: u8 = 4; // 1
pub const C_LED_COUNT: u8 = 5; // 1
pub const C_LED_SEG: u8 = 6; // 1
pub const C_LED_S: u8 = 7; // 1
pub const C_LED_BRANCH: u8 = 8; // 1
pub const C_IMU_ACCEL: u8 = 9; // 3
pub const C_IMU_GYRO: u8 = 10; // 3
pub const C_LED_DIST: u8 = 11; // 1 — geodesic distance along the topology, 0..1
pub const C_LED_UV: u8 = 12; // 2 — per-LED texture coord (pos.xy over map bounds)

pub const MAGIC: [u8; 4] = *b"FXB1";
pub const NO_ENTRY: u16 = 0xFFFF;

/// A parsed program, borrowing the `.fxb` byte buffer.
pub struct Program<'a> {
    consts: &'a [u8], // n_consts * 4 bytes (LE f32; read unaligned)
    code: &'a [u8],
    pub n_state: u8,
    pub n_uniform_slots: u8,
    pub update_entry: u16, // NO_ENTRY if absent
    pub shade_entry: u16,
    /// The raw uniforms manifest (for the app; the VM ignores it).
    pub manifest: &'a [u8],
    /// Buffer descriptor table (present when flags & FLAG_BUFFERS): `n_buffers`
    /// entries of `BUF_DESC_LEN` bytes each — kind(u8) elem(u8) w(u16) h(u16).
    /// A buffer of `kind=0` is LED-arity (arity = led_count); `kind=1` is a WxH
    /// 2D texture (Phase 3). Held raw; [`buf_desc`] decodes an entry.
    pub n_buffers: u8,
    buffers: &'a [u8],
}

/// flags bit: a buffer descriptor table follows `code` in the `.fxb`.
pub const FLAG_BUFFERS: u8 = 0x01;
/// Bytes per buffer descriptor: kind(u8) elem(u8) w(u16) h(u16).
pub const BUF_DESC_LEN: usize = 6;

/// One decoded buffer descriptor.
#[derive(Clone, Copy, Default)]
pub struct BufDesc {
    pub kind: u8,  // 0 = LED-arity, 1 = 2D texture
    pub elem: u8,  // slots per element (1 = float, 3 = vec3, …)
    pub w: u16,    // texture width (kind 1); 0 for LED-arity
    pub h: u16,    // texture height (kind 1); 0 for LED-arity
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseErr {
    TooShort,
    BadMagic,
    BadVersion,
}

fn rd_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

impl<'a> Program<'a> {
    /// Header: magic(4) ver(1) flags(1) n_state(1) n_uniform_slots(1)
    /// manifest_len(2) n_consts(2) code_len(2) update_entry(2) shade_entry(2)
    pub fn parse(buf: &'a [u8]) -> Result<Program<'a>, ParseErr> {
        if buf.len() < 18 {
            return Err(ParseErr::TooShort);
        }
        if buf[0..4] != MAGIC {
            return Err(ParseErr::BadMagic);
        }
        if buf[4] != 1 {
            return Err(ParseErr::BadVersion);
        }
        let flags = buf[5];
        let n_state = buf[6];
        let n_uniform_slots = buf[7];
        let manifest_len = rd_u16(buf, 8) as usize;
        let n_consts = rd_u16(buf, 10) as usize;
        let code_len = rd_u16(buf, 12) as usize;
        let update_entry = rd_u16(buf, 14);
        let shade_entry = rd_u16(buf, 16);
        let mut o = 18;
        let manifest = buf.get(o..o + manifest_len).ok_or(ParseErr::TooShort)?;
        o += manifest_len;
        let consts = buf.get(o..o + n_consts * 4).ok_or(ParseErr::TooShort)?;
        o += n_consts * 4;
        let code = buf.get(o..o + code_len).ok_or(ParseErr::TooShort)?;
        o += code_len;
        // Optional buffer descriptor table (appended after code, back-compatible).
        let (n_buffers, buffers) = if flags & FLAG_BUFFERS != 0 {
            let nb = *buf.get(o).ok_or(ParseErr::TooShort)?;
            o += 1;
            let bytes = buf
                .get(o..o + nb as usize * BUF_DESC_LEN)
                .ok_or(ParseErr::TooShort)?;
            (nb, bytes)
        } else {
            (0, &buf[buf.len()..])
        };
        Ok(Program {
            consts,
            code,
            n_state,
            n_uniform_slots,
            update_entry,
            shade_entry,
            manifest,
            n_buffers,
            buffers,
        })
    }

    /// Decode buffer descriptor `i` (or `None`).
    pub fn buf_desc(&self, i: usize) -> Option<BufDesc> {
        let b = self.buffers.get(i * BUF_DESC_LEN..i * BUF_DESC_LEN + BUF_DESC_LEN)?;
        Some(BufDesc {
            kind: b[0],
            elem: b[1],
            w: u16::from_le_bytes([b[2], b[3]]),
            h: u16::from_le_bytes([b[4], b[5]]),
        })
    }

    /// Total arena slots the program's buffers need, given `led_count`. Each
    /// LED-arity buffer is `elem * led_count`; each 2D texture is `elem * w * h`.
    pub fn arena_slots(&self, led_count: usize) -> usize {
        let mut n = 0;
        for i in 0..self.n_buffers as usize {
            if let Some(d) = self.buf_desc(i) {
                let count = if d.kind == 0 {
                    led_count
                } else {
                    d.w as usize * d.h as usize
                };
                n += d.elem as usize * count;
            }
        }
        n
    }

    /// Byte-offset (in slots) of buffer `id`'s region within the arena.
    fn buf_base(&self, id: usize, led_count: usize) -> usize {
        let mut base = 0;
        for i in 0..id.min(self.n_buffers as usize) {
            if let Some(d) = self.buf_desc(i) {
                let count = if d.kind == 0 {
                    led_count
                } else {
                    d.w as usize * d.h as usize
                };
                base += d.elem as usize * count;
            }
        }
        base
    }

    #[inline]
    fn const_f32(&self, idx: usize) -> f32 {
        let o = idx * 4;
        f32::from_le_bytes([
            self.consts[o],
            self.consts[o + 1],
            self.consts[o + 2],
            self.consts[o + 3],
        ])
    }
}

/// Per-frame context (constant across all LEDs of one frame).
#[derive(Clone, Copy, Default)]
pub struct Frame {
    pub time: f32,
    pub dt: f32,
    pub frame: u32,
    pub led_count: u32,
    pub imu_accel: [f32; 3],
    pub imu_gyro: [f32; 3],
}

/// Per-LED context.
#[derive(Clone, Copy, Default)]
pub struct Led {
    pub pos: [f32; 3],
    pub idx: u32,
    pub seg: i32,
    pub s: f32,
    pub branch: bool,
    /// Geodesic distance from the topology root, normalized 0..1 along the
    /// segment graph (accumulates across segments, unlike `s` which is per
    /// segment). 0 when there is no topology. Enables flood/pulse effects.
    pub dist: f32,
    /// Per-LED texture coordinate in 0..1, the LED's XY position normalized over
    /// the map's bounding box (a top-down projection of the gravity-leveled
    /// frame). Feeds `led.uv` for texture-mapped effects (`sample(tex, led.uv)`).
    pub uv: [f32; 2],
}

/// Persistent VM state across frames: uniform values + `state` vars + the
/// topology graph tables (for graph-walking effects — see [`Vm::set_graph`]).
pub struct Vm {
    pub uniforms: [f32; MAX_UNIFORM_SLOTS],
    pub state: [f32; MAX_STATE],
    // -- topology graph (read-only; filled by set_graph) --
    n_seg: u32,
    seg_len: [f32; MAX_SEG],       // segment arclength (meters)
    seg_node: [[i32; 2]; MAX_SEG], // endpoint node ids (a, b); -1 = free end w/o node
    node_deg: [u8; MAX_NODE],      // incident-segment count per node (clamped to MAX_NODE_DEG)
    node_seg: [[i16; MAX_NODE_DEG]; MAX_NODE], // incident segment ids
    node_side: [[u8; MAX_NODE_DEG]; MAX_NODE], // which end (0=a,1=b) of that segment touches the node
    // Buffer arena (LED-arity buffers / textures): external memory bound per
    // program via set_arena. Raw ptr so Vm needs no lifetime; the caller keeps
    // it alive and disjoint from `state`. Null/0 = no buffers.
    arena_ptr: *mut f32,
    arena_len: usize,
}

impl Default for Vm {
    fn default() -> Self {
        Vm {
            uniforms: [0.0; MAX_UNIFORM_SLOTS],
            state: [0.0; MAX_STATE],
            n_seg: 0,
            seg_len: [0.0; MAX_SEG],
            seg_node: [[-1; 2]; MAX_SEG],
            node_deg: [0; MAX_NODE],
            node_seg: [[0; MAX_NODE_DEG]; MAX_NODE],
            node_side: [[0; MAX_NODE_DEG]; MAX_NODE],
            arena_ptr: core::ptr::null_mut(),
            arena_len: 0,
        }
    }
}

impl Vm {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a uniform's value (`vals` length = its slot count).
    pub fn set_uniform(&mut self, slot: usize, vals: &[f32]) {
        for (i, v) in vals.iter().enumerate() {
            if slot + i < MAX_UNIFORM_SLOTS {
                self.uniforms[slot + i] = *v;
            }
        }
    }

    /// Fill the topology graph tables from per-segment arclengths and endpoint
    /// node ids (`seg_a`/`seg_b`, -1 for a free end with no shared node), then
    /// build the per-node incident-segment lists. Call whenever the topology
    /// changes; pass empty slices to clear. The graph-query intrinsics read this.
    pub fn set_graph(&mut self, seg_len: &[f32], seg_a: &[i32], seg_b: &[i32]) {
        let n = seg_len.len().min(seg_a.len()).min(seg_b.len()).min(MAX_SEG);
        self.n_seg = n as u32;
        self.node_deg = [0; MAX_NODE];
        for i in 0..n {
            self.seg_len[i] = seg_len[i];
            self.seg_node[i] = [seg_a[i], seg_b[i]];
            for side in 0..2usize {
                let node = self.seg_node[i][side];
                if node >= 0 && (node as usize) < MAX_NODE {
                    let d = self.node_deg[node as usize] as usize;
                    if d < MAX_NODE_DEG {
                        self.node_seg[node as usize][d] = i as i16;
                        self.node_side[node as usize][d] = side as u8;
                        self.node_deg[node as usize] = (d + 1) as u8;
                    }
                }
            }
        }
        for i in n..MAX_SEG {
            self.seg_len[i] = 0.0;
            self.seg_node[i] = [-1; 2];
        }
    }

    /// Bind the buffer arena (LED-arity buffers / textures). The slice must
    /// outlive the following run calls and be disjoint from any other access.
    /// Pass an empty slice to unbind. Size it to `Program::arena_slots(led_count)`.
    pub fn set_arena(&mut self, arena: &mut [f32]) {
        self.arena_ptr = arena.as_mut_ptr();
        self.arena_len = arena.len();
    }

    fn graph_ref(&self) -> GraphRef<'_> {
        GraphRef {
            n_seg: self.n_seg,
            seg_len: &self.seg_len,
            seg_node: &self.seg_node,
            node_deg: &self.node_deg,
            node_seg: &self.node_seg,
            node_side: &self.node_side,
        }
    }

    /// Run `update()` (if present), evolving `state`. Uses the default budget.
    pub fn run_update(&mut self, prog: &Program, frame: &Frame) {
        self.run_update_bounded(prog, frame, &Budget::default());
    }

    /// Run `update()` under an explicit [`Budget`], evolving `state`. If the
    /// invocation is cancelled (budget/timeout) `state` is still committed —
    /// update() writes state incrementally and a partial advance is harmless
    /// (the next frame simply continues). Returns why it stopped.
    pub fn run_update_bounded(&mut self, prog: &Program, frame: &Frame, budget: &Budget) -> Outcome {
        self.run_update_counted(prog, frame, budget).0
    }

    /// Like [`run_update_bounded`], additionally returning Tier-1 [`Counters`]
    /// (opcodes retired + stack high-water) for the perf stream. The counters
    /// cost one add/compare per opcode; the firmware gates FULL mode so BASIC
    /// callers stay on the plain path.
    pub fn run_update_counted(
        &mut self,
        prog: &Program,
        frame: &Frame,
        budget: &Budget,
    ) -> (Outcome, Counters) {
        if prog.update_entry == NO_ENTRY {
            return (Outcome::Ok, Counters::default());
        }
        let led = Led::default();
        let mut st = self.state;
        let g = self.graph_ref();
        let arena: &mut [f32] = if self.arena_ptr.is_null() || self.arena_len == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(self.arena_ptr, self.arena_len) }
        };
        let (_out, outcome, counters) = run(
            prog,
            self.uniforms,
            &mut st,
            frame,
            &led,
            &g,
            arena,
            prog.update_entry as usize,
            budget,
        );
        self.state = st;
        (outcome, counters)
    }

    /// Run `shade(led)` → RGB. Does not mutate `state` (read-only in shade).
    /// Uses the default budget.
    pub fn run_shade(&self, prog: &Program, frame: &Frame, led: &Led) -> Rgb {
        self.run_shade_bounded(prog, frame, led, &Budget::default()).0
    }

    /// Run `shade(led)` under an explicit [`Budget`]. On a cancelled invocation
    /// (budget/timeout) the returned RGB is black — the caller may instead hold
    /// the LED's previous colour. Returns `(rgb, outcome)`.
    pub fn run_shade_bounded(
        &self,
        prog: &Program,
        frame: &Frame,
        led: &Led,
        budget: &Budget,
    ) -> (Rgb, Outcome) {
        let (rgb, outcome, _counters) = self.run_shade_counted(prog, frame, led, budget);
        (rgb, outcome)
    }

    /// Like [`run_shade_bounded`], additionally returning Tier-1 [`Counters`]
    /// (opcodes retired + stack high-water) for the perf stream.
    pub fn run_shade_counted(
        &self,
        prog: &Program,
        frame: &Frame,
        led: &Led,
        budget: &Budget,
    ) -> (Rgb, Outcome, Counters) {
        let mut st = self.state; // copy; shade shouldn't write it, but be safe
        let g = self.graph_ref();
        let arena: &mut [f32] = if self.arena_ptr.is_null() || self.arena_len == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(self.arena_ptr, self.arena_len) }
        };
        let (out, outcome, counters) = run(
            prog,
            self.uniforms,
            &mut st,
            frame,
            led,
            &g,
            arena,
            prog.shade_entry as usize,
            budget,
        );
        if outcome.timed_out() {
            return ((0, 0, 0), outcome, counters);
        }
        let r = clamp01(out[0]);
        let g = clamp01(out[1]);
        let b = clamp01(out[2]);
        (
            ((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8),
            outcome,
            counters,
        )
    }
}

#[inline]
fn clamp01(x: f32) -> f32 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else if x.is_nan() {
        0.0
    } else {
        x
    }
}

/// A borrow of the VM's topology graph tables, passed to `run()` so the
/// graph-query opcode can read them without giving `run` the whole `Vm`.
struct GraphRef<'a> {
    n_seg: u32,
    seg_len: &'a [f32; MAX_SEG],
    seg_node: &'a [[i32; 2]; MAX_SEG],
    node_deg: &'a [u8; MAX_NODE],
    node_seg: &'a [[i16; MAX_NODE_DEG]; MAX_NODE],
    node_side: &'a [[u8; MAX_NODE_DEG]; MAX_NODE],
}

impl GraphRef<'_> {
    /// Evaluate a graph query. Int results carry their i32 bits in the f32 slot
    /// (the compiler types the result, so consumers read them back as int).
    #[inline]
    fn query(&self, kind: u8, a: i32, b: i32) -> f32 {
        let asi = |v: i32| f32::from_bits(v as u32);
        let node_ok = |n: i32| n >= 0 && (n as usize) < MAX_NODE;
        match kind {
            gq::SEG_COUNT => asi(self.n_seg as i32),
            gq::SEG_LEN => {
                if a >= 0 && (a as usize) < (self.n_seg as usize).min(MAX_SEG) {
                    self.seg_len[a as usize]
                } else {
                    0.0
                }
            }
            gq::SEG_NODE => {
                let v = if a >= 0 && (a as usize) < MAX_SEG && (b == 0 || b == 1) {
                    self.seg_node[a as usize][b as usize]
                } else {
                    -1
                };
                asi(v)
            }
            gq::NODE_DEG => asi(if node_ok(a) { self.node_deg[a as usize] as i32 } else { 0 }),
            gq::NODE_SEG | gq::NODE_SIDE => {
                let ok = node_ok(a)
                    && b >= 0
                    && (b as usize) < MAX_NODE_DEG
                    && (b as usize) < self.node_deg[a as usize] as usize;
                let v = if !ok {
                    if kind == gq::NODE_SEG {
                        -1
                    } else {
                        0
                    }
                } else if kind == gq::NODE_SEG {
                    self.node_seg[a as usize][b as usize] as i32
                } else {
                    self.node_side[a as usize][b as usize] as i32
                };
                asi(v)
            }
            _ => 0.0,
        }
    }
}

/// Execute from `entry`, returning `(up to 3 result slots, outcome)`. Two
/// bounded-execution guards hard-cap frame time and trap runaway loops (see
/// [`Budget`]): a per-invocation instruction budget (primary, deterministic)
/// and an optional wall-time deadline flag raised by a hardware timer
/// (secondary). Either firing unwinds to the caller with a timeout outcome.
fn run(
    prog: &Program,
    uniforms: [f32; MAX_UNIFORM_SLOTS],
    state: &mut [f32; MAX_STATE],
    frame: &Frame,
    led: &Led,
    graph: &GraphRef,
    arena: &mut [f32],
    entry: usize,
    guard: &Budget,
) -> ([f32; 3], Outcome, Counters) {
    use core::sync::atomic::Ordering;
    let code = prog.code;
    let mut stack = [0.0f32; MAX_STACK];
    let mut locals = [0.0f32; MAX_LOCALS];
    let mut sp: usize = 0;
    let mut pc: usize = entry;
    let mut budget: u32 = guard.instructions; // instructions per invocation
    // Tier-1 counters (perf-monitoring.md): opcodes retired + stack high-water.
    // Cheap-by-construction — one add + one max next to the budget decrement.
    let mut instrs: u32 = 0;
    let mut sp_max: usize = 0;
    // Poll the wall-time flag every N ops (an atomic load per op would dominate
    // the tiny opcodes); the instruction budget bounds the slop between polls.
    const DEADLINE_POLL_MASK: u32 = 0x3FF;
    let mut call_stack = [0usize; 16];
    let mut csp: usize = 0;
    let mut outcome = Outcome::Ok;

    macro_rules! push {
        ($v:expr) => {{
            if sp < MAX_STACK {
                stack[sp] = $v;
                sp += 1;
            }
        }};
    }
    macro_rules! pop {
        () => {{
            sp = sp.saturating_sub(1);
            stack[sp]
        }};
    }
    // Integers/fixed ride in the f32 slots bit-for-bit (the compiler types every
    // op, so the runtime interpretation is unambiguous).
    macro_rules! popi {
        () => {{
            pop!().to_bits() as i32
        }};
    }
    macro_rules! pushi {
        ($v:expr) => {{
            let vv: i32 = $v;
            push!(f32::from_bits(vv as u32));
        }};
    }

    while pc < code.len() {
        if budget == 0 {
            outcome = Outcome::Budget;
            break;
        }
        budget -= 1;
        instrs += 1;
        // Stack high-water: the sp before this op ran (post-op depth is folded
        // in via the NEXT iteration's read, and the terminal Ret is small).
        if sp > sp_max {
            sp_max = sp;
        }
        // Secondary wall-time guard: a hardware timer raises this flag at a
        // frame-relative deadline; polled sparsely so the load isn't hot.
        if budget & DEADLINE_POLL_MASK == 0 {
            if let Some(flag) = guard.deadline {
                // SAFETY: `flag` points at a live AtomicBool owned by the
                // caller for the duration of this call (the C++ FFI holds it
                // in a static). Atomic load is sound through a shared ref.
                if unsafe { (*flag).load(Ordering::Relaxed) } {
                    outcome = Outcome::Timeout;
                    break;
                }
            }
        }
        let op = match Op::from_u8(code[pc]) {
            Some(o) => o,
            None => break,
        };
        pc += 1;
        match op {
            Op::PushConst => {
                let idx = rd_u16(code, pc) as usize;
                pc += 2;
                push!(prog.const_f32(idx));
            }
            Op::LoadUniform => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*uniforms.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::LoadState => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*state.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::StoreState => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in (0..n).rev() {
                    let v = pop!();
                    if slot + i < MAX_STATE {
                        state[slot + i] = v;
                    }
                }
            }
            Op::LoadLocal => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*locals.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::StoreLocal => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in (0..n).rev() {
                    let v = pop!();
                    if slot + i < MAX_LOCALS {
                        locals[slot + i] = v;
                    }
                }
            }
            Op::LoadCtx => {
                let id = code[pc];
                pc += 1;
                match id {
                    C_TIME => push!(frame.time),
                    C_DT => push!(frame.dt),
                    C_FRAME => push!(frame.frame as f32),
                    C_LED_POS => {
                        push!(led.pos[0]);
                        push!(led.pos[1]);
                        push!(led.pos[2]);
                    }
                    C_LED_IDX => push!(led.idx as f32),
                    C_LED_COUNT => push!(frame.led_count as f32),
                    C_LED_SEG => push!(led.seg as f32),
                    C_LED_S => push!(led.s),
                    C_LED_BRANCH => push!(if led.branch { 1.0 } else { 0.0 }),
                    C_IMU_ACCEL => {
                        push!(frame.imu_accel[0]);
                        push!(frame.imu_accel[1]);
                        push!(frame.imu_accel[2]);
                    }
                    C_IMU_GYRO => {
                        push!(frame.imu_gyro[0]);
                        push!(frame.imu_gyro[1]);
                        push!(frame.imu_gyro[2]);
                    }
                    C_LED_DIST => push!(led.dist),
                    C_LED_UV => {
                        push!(led.uv[0]);
                        push!(led.uv[1]);
                    }
                    _ => push!(0.0),
                }
            }
            Op::Add | Op::Sub | Op::Mul | Op::Div => {
                let n = code[pc] as usize;
                pc += 1;
                // stack: a(n) b(n) ; result a op b
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = match op {
                        Op::Add => a + b,
                        Op::Sub => a - b,
                        Op::Mul => a * b,
                        _ => {
                            if b == 0.0 {
                                0.0
                            } else {
                                a / b
                            }
                        }
                    };
                }
                sp = base + n;
            }
            Op::Neg => {
                let n = code[pc] as usize;
                pc += 1;
                for i in 0..n {
                    stack[sp - n + i] = -stack[sp - n + i];
                }
            }
            Op::Scale => {
                let n = code[pc] as usize;
                pc += 1;
                let s = pop!();
                for i in 0..n {
                    stack[sp - n + i] *= s;
                }
            }
            Op::UnMath => {
                let f = code[pc];
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    let x = stack[sp - n + i];
                    stack[sp - n + i] = un_math(f, x);
                }
            }
            Op::BinMath => {
                let f = code[pc];
                let n = code[pc + 1] as usize;
                pc += 2;
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = bin_math(f, a, b);
                }
                sp = base + n;
            }
            Op::Clamp => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 3 * n;
                for i in 0..n {
                    let x = stack[base + i];
                    let lo = stack[base + n + i];
                    let hi = stack[base + 2 * n + i];
                    stack[base + i] = if x < lo {
                        lo
                    } else if x > hi {
                        hi
                    } else {
                        x
                    };
                }
                sp = base + n;
            }
            Op::Mix => {
                let n = code[pc] as usize;
                pc += 1;
                let t = pop!(); // scalar t
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = a + (b - a) * t;
                }
                sp = base + n;
            }
            Op::Smoothstep => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 3 * n;
                for i in 0..n {
                    let e0 = stack[base + i];
                    let e1 = stack[base + n + i];
                    let x = stack[base + 2 * n + i];
                    let t = clamp01(if e1 == e0 { 0.0 } else { (x - e0) / (e1 - e0) });
                    stack[base + i] = t * t * (3.0 - 2.0 * t);
                }
                sp = base + n;
            }
            Op::Dot => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 2 * n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + n + i];
                }
                sp = base;
                push!(acc);
            }
            Op::Cross => {
                pc += 1; // n operand (always 3), ignore
                let base = sp - 6;
                let a = [stack[base], stack[base + 1], stack[base + 2]];
                let b = [stack[base + 3], stack[base + 4], stack[base + 5]];
                stack[base] = a[1] * b[2] - a[2] * b[1];
                stack[base + 1] = a[2] * b[0] - a[0] * b[2];
                stack[base + 2] = a[0] * b[1] - a[1] * b[0];
                sp = base + 3;
            }
            Op::Length => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + i];
                }
                sp = base;
                push!(sqrtf(acc));
            }
            Op::Distance => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 2 * n;
                let mut acc = 0.0;
                for i in 0..n {
                    let d = stack[base + i] - stack[base + n + i];
                    acc += d * d;
                }
                sp = base;
                push!(sqrtf(acc));
            }
            Op::Normalize => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + i];
                }
                let len = sqrtf(acc);
                if len > 1e-9 {
                    for i in 0..n {
                        stack[base + i] /= len;
                    }
                }
            }
            Op::Swizzle => {
                let src_n = code[pc] as usize;
                let dst_n = code[pc + 1] as usize;
                pc += 2;
                let mut tmp = [0.0f32; 4];
                let base = sp - src_n;
                for i in 0..dst_n {
                    let ci = code[pc + i] as usize;
                    tmp[i] = *stack.get(base + ci).unwrap_or(&0.0);
                }
                pc += dst_n;
                for i in 0..dst_n {
                    stack[base + i] = tmp[i];
                }
                sp = base + dst_n;
            }
            Op::Cmp => {
                let kind = code[pc];
                pc += 1;
                let b = pop!();
                let a = pop!();
                let r = match kind {
                    0 => a < b,
                    1 => a <= b,
                    2 => a > b,
                    3 => a >= b,
                    4 => a == b,
                    _ => a != b,
                };
                push!(if r { 1.0 } else { 0.0 });
            }
            Op::Logic => {
                let kind = code[pc];
                pc += 1;
                if kind == 2 {
                    let a = pop!();
                    push!(if a != 0.0 { 0.0 } else { 1.0 });
                } else {
                    let b = pop!();
                    let a = pop!();
                    let r = if kind == 0 {
                        (a != 0.0) && (b != 0.0)
                    } else {
                        (a != 0.0) || (b != 0.0)
                    };
                    push!(if r { 1.0 } else { 0.0 });
                }
            }
            Op::BrFalse => {
                let rel = i16::from_le_bytes([code[pc], code[pc + 1]]);
                pc += 2;
                let c = pop!();
                if c == 0.0 {
                    pc = (pc as isize + rel as isize) as usize;
                }
            }
            Op::Jmp => {
                let rel = i16::from_le_bytes([code[pc], code[pc + 1]]);
                pc += 2;
                pc = (pc as isize + rel as isize) as usize;
            }
            Op::Hash1 => {
                let x = pop!();
                push!(hash1(x));
            }
            Op::Hash3 => {
                let z = pop!();
                let y = pop!();
                let x = pop!();
                push!(hash1(x * 127.1 + y * 311.7 + z * 74.7));
            }
            Op::Hsv2Rgb => {
                let v = pop!();
                let s = pop!();
                let h = pop!();
                let (r, g, b) = hsv2rgb(h, s, v);
                push!(r);
                push!(g);
                push!(b);
            }
            Op::Palette => {
                let id = code[pc];
                pc += 1;
                let t = pop!();
                let (r, g, b) = palette(id, t);
                push!(r);
                push!(g);
                push!(b);
            }
            Op::Pop => {
                let n = code[pc] as usize;
                pc += 1;
                sp = sp.saturating_sub(n);
            }
            Op::Ret => {
                let n = code[pc] as usize;
                let mut out = [0.0f32; 3];
                let base = sp.saturating_sub(n);
                for i in 0..n.min(3) {
                    out[i] = stack[base + i];
                }
                if sp > sp_max {
                    sp_max = sp;
                }
                return (out, Outcome::Ok, Counters { instrs, stack_max: sp_max as u16 });
            }
            Op::Swap => {
                let an = code[pc] as usize;
                let bn = code[pc + 1] as usize;
                pc += 2;
                // stack: [.. a(an) b(bn)] -> [.. b(bn) a(an)]
                let base = sp - an - bn;
                let mut tmp = [0.0f32; 8];
                for i in 0..an {
                    tmp[i] = stack[base + i];
                }
                for i in 0..bn {
                    stack[base + i] = stack[base + an + i];
                }
                for i in 0..an {
                    stack[base + bn + i] = tmp[i];
                }
            }
            Op::AddI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_add(b));
            }
            Op::SubI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_sub(b));
            }
            Op::MulI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_mul(b));
            }
            Op::DivI => {
                let b = popi!();
                let a = popi!();
                pushi!(if b == 0 { 0 } else { a.wrapping_div(b) });
            }
            Op::ModI => {
                let b = popi!();
                let a = popi!();
                pushi!(if b == 0 { 0 } else { a.wrapping_rem(b) });
            }
            Op::NegI => {
                let a = popi!();
                pushi!(a.wrapping_neg());
            }
            Op::CmpI => {
                let kind = code[pc];
                pc += 1;
                let b = popi!();
                let a = popi!();
                let r = match kind {
                    0 => a < b,
                    1 => a <= b,
                    2 => a > b,
                    3 => a >= b,
                    4 => a == b,
                    _ => a != b,
                };
                push!(if r { 1.0 } else { 0.0 });
            }
            Op::MulFix => {
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(((a * b) >> 16) as i32);
            }
            Op::DivFix => {
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(if b == 0 { 0 } else { ((a << 16) / b) as i32 });
            }
            Op::I2F => {
                let a = popi!();
                push!(a as f32);
            }
            Op::F2I => {
                let a = pop!();
                pushi!(a as i32);
            }
            Op::Fix2F => {
                let a = popi!();
                push!(a as f32 / FIX_ONE as f32);
            }
            Op::F2Fix => {
                let a = pop!();
                pushi!((a * FIX_ONE as f32) as i32);
            }
            Op::I2Fix => {
                let a = popi!();
                pushi!(a.wrapping_shl(16));
            }
            Op::Fix2I => {
                let a = popi!();
                pushi!(a >> 16);
            }
            Op::Call => {
                let target = rd_u16(code, pc) as usize;
                pc += 2;
                if csp < call_stack.len() {
                    call_stack[csp] = pc;
                    csp += 1;
                }
                pc = target;
            }
            Op::RetFn => {
                if csp == 0 {
                    break;
                }
                csp -= 1;
                pc = call_stack[csp];
            }
            // Indexed load: pop the (int) index, push `n` slots from
            // base + clamp(i,0,count-1)*stride + off.
            Op::LoadStateIdx | Op::LoadLocalIdx => {
                let base = code[pc] as usize;
                let stride = code[pc + 1] as usize;
                let off = code[pc + 2] as usize;
                let n = code[pc + 3] as usize;
                let count = code[pc + 4] as usize;
                pc += 5;
                let i = popi!();
                let hi = count.saturating_sub(1) as i32;
                let idx = i.clamp(0, hi) as usize;
                let p = base + idx * stride + off;
                let src: &[f32] = if op == Op::LoadStateIdx { &state[..] } else { &locals[..] };
                for k in 0..n {
                    push!(*src.get(p + k).unwrap_or(&0.0));
                }
            }
            // Indexed store: the `n` values are on top, the (int) index just
            // below them. Writes to base + clamp(i,0,count-1)*stride + off.
            Op::StoreStateIdx | Op::StoreLocalIdx => {
                let base = code[pc] as usize;
                let stride = code[pc + 1] as usize;
                let off = code[pc + 2] as usize;
                let n = code[pc + 3] as usize;
                let count = code[pc + 4] as usize;
                pc += 5;
                if sp >= n + 1 {
                    let i = stack[sp - n - 1].to_bits() as i32;
                    let hi = count.saturating_sub(1) as i32;
                    let idx = i.clamp(0, hi) as usize;
                    let p = base + idx * stride + off;
                    let cap = if op == Op::StoreStateIdx { MAX_STATE } else { MAX_LOCALS };
                    for k in 0..n {
                        let v = stack[sp - n + k];
                        if p + k < cap {
                            if op == Op::StoreStateIdx {
                                state[p + k] = v;
                            } else {
                                locals[p + k] = v;
                            }
                        }
                    }
                    sp -= n + 1;
                }
            }
            Op::GraphQuery => {
                let kind = code[pc];
                pc += 1;
                let (a, b) = match kind {
                    gq::SEG_LEN | gq::NODE_DEG => (popi!(), 0),
                    gq::SEG_NODE | gq::NODE_SEG | gq::NODE_SIDE => {
                        let b = popi!();
                        (popi!(), b)
                    }
                    _ => (0, 0),
                };
                push!(graph.query(kind, a, b));
            }
            Op::LoadBuf => {
                let id = code[pc] as usize;
                pc += 1;
                if let Some(d) = prog.buf_desc(id) {
                    let lc = frame.led_count as usize;
                    let elem = d.elem as usize;
                    let count = if d.kind == 0 { lc } else { d.w as usize * d.h as usize };
                    let i = popi!().clamp(0, count.saturating_sub(1) as i32) as usize;
                    let base = prog.buf_base(id, lc) + i * elem;
                    for k in 0..elem {
                        push!(arena.get(base + k).copied().unwrap_or(0.0));
                    }
                }
            }
            Op::StoreBuf => {
                let id = code[pc] as usize;
                pc += 1;
                if let Some(d) = prog.buf_desc(id) {
                    let lc = frame.led_count as usize;
                    let elem = d.elem as usize;
                    let count = if d.kind == 0 { lc } else { d.w as usize * d.h as usize };
                    if sp >= elem + 1 {
                        let i = stack[sp - elem - 1].to_bits() as i32;
                        let idx = i.clamp(0, count.saturating_sub(1) as i32) as usize;
                        let base = prog.buf_base(id, lc) + idx * elem;
                        for k in 0..elem {
                            let v = stack[sp - elem + k];
                            if base + k < arena.len() {
                                arena[base + k] = v;
                            }
                        }
                        sp -= elem + 1;
                    }
                }
            }
            Op::SampleTex => {
                let id = code[pc] as usize;
                pc += 1;
                let d = prog.buf_desc(id).unwrap_or_default();
                let elem = d.elem as usize;
                // pop uv (2 slots): stack [.., u, v]
                let (u, v) = if sp >= 2 {
                    let v = stack[sp - 1];
                    let u = stack[sp - 2];
                    sp -= 2;
                    (u, v)
                } else {
                    (0.0, 0.0)
                };
                if d.kind == 1 && d.w > 0 && d.h > 0 {
                    let w = d.w as usize;
                    let h = d.h as usize;
                    let base = prog.buf_base(id, frame.led_count as usize);
                    // Bilinear, edge-clamped.
                    let fx = u.clamp(0.0, 1.0) * (w as f32 - 1.0);
                    let fy = v.clamp(0.0, 1.0) * (h as f32 - 1.0);
                    let x0 = floorf(fx) as usize;
                    let y0 = floorf(fy) as usize;
                    let x1 = (x0 + 1).min(w - 1);
                    let y1 = (y0 + 1).min(h - 1);
                    let tx = fx - x0 as f32;
                    let ty = fy - y0 as f32;
                    for k in 0..elem {
                        let tap = |x: usize, y: usize| {
                            arena.get(base + (y * w + x) * elem + k).copied().unwrap_or(0.0)
                        };
                        let a = tap(x0, y0) * (1.0 - tx) + tap(x1, y0) * tx;
                        let b = tap(x0, y1) * (1.0 - tx) + tap(x1, y1) * tx;
                        push!(a * (1.0 - ty) + b * ty);
                    }
                } else {
                    for _ in 0..elem {
                        push!(0.0);
                    }
                }
            }
            Op::PaintTex => {
                let id = code[pc] as usize;
                pc += 1;
                let d = prog.buf_desc(id).unwrap_or_default();
                let elem = d.elem as usize;
                // stack: [.., u, v, c0..c_elem] — uv below the colour slots.
                if sp >= elem + 2 {
                    let v = stack[sp - elem - 1];
                    let u = stack[sp - elem - 2];
                    if d.kind == 1 && d.w > 0 && d.h > 0 {
                        let w = d.w as usize;
                        let h = d.h as usize;
                        let base = prog.buf_base(id, frame.led_count as usize);
                        // Nearest texel.
                        let x = floorf(u.clamp(0.0, 1.0) * (w as f32 - 1.0) + 0.5) as usize;
                        let y = floorf(v.clamp(0.0, 1.0) * (h as f32 - 1.0) + 0.5) as usize;
                        let off = base + (y.min(h - 1) * w + x.min(w - 1)) * elem;
                        for k in 0..elem {
                            let c = stack[sp - elem + k];
                            if off + k < arena.len() {
                                arena[off + k] = c;
                            }
                        }
                    }
                    sp -= elem + 2;
                }
            }
        }
    }
    ([0.0, 0.0, 0.0], outcome, Counters { instrs, stack_max: sp_max as u16 })
}

// --- soft-float helpers (no libm dependency; small polynomial approximations
// good enough for LED effects, deterministic on host + wasm + device) ---------

fn sqrtf(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    // Newton from a bit-twiddle seed.
    let mut y = f32::from_bits(0x5f37_59df - (x.to_bits() >> 1));
    y = y * (1.5 - 0.5 * x * y * y);
    y = y * (1.5 - 0.5 * x * y * y);
    x * y // x * rsqrt(x) = sqrt(x)
}

fn floorf(x: f32) -> f32 {
    let t = x as i32 as f32;
    if t > x {
        t - 1.0
    } else {
        t
    }
}
fn fractf(x: f32) -> f32 {
    x - floorf(x)
}

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = 2.0 * PI;

fn sinf(x: f32) -> f32 {
    // range-reduce to [-PI,PI], then a 5th-order minimax-ish poly.
    let mut a = x - TAU * floorf(x / TAU + 0.5);
    // a in [-PI, PI]
    if a > PI {
        a -= TAU;
    }
    let a2 = a * a;
    a * (0.9999966 + a2 * (-0.16664824 + a2 * (0.00830629 + a2 * -0.00018363)))
}
fn cosf(x: f32) -> f32 {
    sinf(x + PI * 0.5)
}
fn expf(x: f32) -> f32 {
    // 2^(x/ln2) via bit manipulation + poly (adequate for decay curves).
    let xln = x * 1.442695; // x / ln2
    let i = floorf(xln);
    let f = xln - i;
    let poly = 1.0 + f * (0.6931472 + f * (0.2402265 + f * 0.0555041));
    let bits = ((i as i32 + 127) as u32) << 23;
    f32::from_bits(bits) * poly
}
fn logf(x: f32) -> f32 {
    if x <= 0.0 {
        return -87.0;
    }
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000); // [1,2)
    let p = -1.7417939 + m * (2.8212026 + m * (-1.4699568 + m * (0.4471623 - m * 0.0821854)));
    (e as f32) * 0.6931472 + p
}
fn powf(a: f32, b: f32) -> f32 {
    if a <= 0.0 {
        return 0.0;
    }
    expf(b * logf(a))
}
fn tanf(x: f32) -> f32 {
    let c = cosf(x);
    if c.abs() < 1e-6 {
        0.0
    } else {
        sinf(x) / c
    }
}

fn un_math(f: u8, x: f32) -> f32 {
    match f {
        F_SIN => sinf(x),
        F_COS => cosf(x),
        F_ABS => x.abs(),
        F_FLOOR => floorf(x),
        F_CEIL => -floorf(-x),
        F_FRACT => fractf(x),
        F_SQRT => sqrtf(x),
        F_EXP => expf(x),
        F_LOG => logf(x),
        F_SIGN => {
            if x > 0.0 {
                1.0
            } else if x < 0.0 {
                -1.0
            } else {
                0.0
            }
        }
        F_TAN => tanf(x),
        _ => x,
    }
}
fn bin_math(f: u8, a: f32, b: f32) -> f32 {
    match f {
        B_MIN => {
            if a < b {
                a
            } else {
                b
            }
        }
        B_MAX => {
            if a > b {
                a
            } else {
                b
            }
        }
        B_POW => powf(a, b),
        B_MOD => a - b * floorf(a / b),
        B_STEP => {
            if b < a {
                0.0
            } else {
                1.0
            }
        } // step(edge=a, x=b)
        B_ATAN2 => atan2f(a, b),
        _ => a,
    }
}
fn atan2f(y: f32, x: f32) -> f32 {
    // crude atan2 adequate for effects (angles for radial patterns).
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let ax = x.abs();
    let ay = y.abs();
    let a = if ax >= ay { ay / ax } else { ax / ay };
    let s = a * a;
    let mut r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
    if ay > ax {
        r = PI * 0.5 - r;
    }
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 {
        r = -r;
    }
    r
}

fn hash1(x: f32) -> f32 {
    // fract(sin(x)*k) style, but with our sinf; deterministic.
    fractf(sinf(x * 12.9898) * 43758.547)
}

fn hsv2rgb(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let h6 = fractf(h) * 6.0;
    let c = v * s;
    let x = c * (1.0 - (fractf(h6 * 0.5) * 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match h6 as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    (r + m, g + m, b + m)
}

fn palette(id: u8, t: f32) -> (f32, f32, f32) {
    let t = clamp01(t);
    match id {
        // fire: black -> red -> orange -> yellow -> white
        0 => (clamp01(t * 3.0), clamp01(t * 3.0 - 1.0), clamp01(t * 3.0 - 2.0)),
        // ice: black -> blue -> cyan -> white
        1 => (clamp01(t * 3.0 - 2.0), clamp01(t * 3.0 - 1.0), clamp01(t * 2.0)),
        // rainbow
        _ => hsv2rgb(t, 1.0, 1.0),
    }
}
