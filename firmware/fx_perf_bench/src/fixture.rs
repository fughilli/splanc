//! Synthetic fixtures the bench shades over. Everything is a fixed-size static
//! (no alloc) sized for the C6's 2048-LED cap.
//!
//! - `Helix`: a 3-D lamp-like fixture — a 10-turn helix, r = 8 cm, 30 cm tall,
//!   +Y up (like the user's 500-LED FugWidget, which is 3-D mapped). Topology: 8
//!   equal segments chained through nodes 0..8, so `led.seg/s/dist` and
//!   `flood_from` are meaningful.
//! - `Sign`: a planar two-row letter sign standing in for the user's FugWidget
//!   ("CAMP / THERAPY", ~500 LEDs): 29 straight/polyline strokes in a crude stroke
//!   font, ~1 m × 0.45 m, z = 0, one topology segment per stroke (each with its
//!   own two end nodes), LEDs spread along the strokes by arclength. SYNTHESIZED —
//!   the real map was not available; the stroke numbering is ours, not the sign's.
//! - `Linear`: fx_bench's map (x = i/(n-1), y = z = 0, no topology) — used only
//!   to re-measure fx_bench programs against their goldens.

pub const MAX_LEDS: usize = 2048;
pub const N_SEG: usize = 8;
pub const MAX_SEG: usize = 64;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Helix,
    Linear,
    Sign,
}

/// Per-LED inputs, precomputed once per map (what a native implementation
/// would cache at map load). The VM's per-frame `Led` is rebuilt from these
/// the way firmware/player_app/ffi.rs `fx_shade_one` does it.
#[derive(Clone, Copy, Default)]
pub struct LedIn {
    pub pos: [f32; 3],
    pub uv: [f32; 2],
    pub seg: i32,
    pub s: f32,
    pub dist: f32,
    /// Q16.16 mirrors (native fixed-point paths).
    pub posq: [i32; 3],
    pub uvq: [i32; 2],
}

pub struct Fixture {
    pub n: usize,
    pub kind: Kind,
    pub uv_min: [f32; 2],
    pub uv_inv: [f32; 2],
    pub seg_len: [f32; MAX_SEG],
    pub seg_a: [i32; MAX_SEG],
    pub seg_b: [i32; MAX_SEG],
    pub n_seg: usize,
}

pub static mut LEDS: [LedIn; MAX_LEDS] = [LedIn {
    pos: [0.0; 3],
    uv: [0.0; 2],
    seg: -1,
    s: 0.0,
    dist: 0.0,
    posq: [0; 3],
    uvq: [0; 2],
}; MAX_LEDS];

pub static mut FIX: Fixture = Fixture {
    n: 0,
    kind: Kind::Linear,
    uv_min: [0.0; 2],
    uv_inv: [0.0; 2],
    seg_len: [0.0; MAX_SEG],
    seg_a: [-1; MAX_SEG],
    seg_b: [-1; MAX_SEG],
    n_seg: 0,
};

#[inline]
pub fn q16(x: f32) -> i32 {
    (x * 65536.0) as i32
}

fn cos_sin(a: f32) -> (f32, f32) {
    // Host-quality trig for building the map only (not on any timed path).
    (ledmapper_fx_vm::cosf(a), ledmapper_fx_vm::sinf(a))
}

/// (Re)build the fixture: positions, uv projection (exactly ffi.rs's bbox
/// normalisation), topology and the Q16 mirrors.
///
/// # Safety
/// Single-threaded bench; mutates the statics.
pub unsafe fn build(kind: Kind, n: usize) {
    let n = n.min(MAX_LEDS);
    let f = &mut *core::ptr::addr_of_mut!(FIX);
    let leds = &mut *core::ptr::addr_of_mut!(LEDS);
    f.n = n;
    f.kind = kind;
    let denom = if n > 1 { (n - 1) as f32 } else { 1.0 };
    let (turns, r, h) = (10.0f32, 0.08f32, 0.30f32);
    if kind == Kind::Sign {
        build_sign(f, leds, n);
    }
    for (i, l) in leds.iter_mut().enumerate().take(n) {
        if kind == Kind::Sign {
            break;
        }
        let t = i as f32 / denom;
        l.pos = match kind {
            Kind::Linear => [t, 0.0, 0.0],
            Kind::Helix => {
                let (c, s) = cos_sin(t * turns * core::f32::consts::TAU);
                [r * c, t * h, r * s]
            }
            Kind::Sign => unreachable!(),
        };
    }
    // uv = (pos.xy - min) / range, clamped — ffi.rs FX_UV_MIN / FX_UV_INV.
    let mut mn = [f32::INFINITY; 2];
    let mut mx = [f32::NEG_INFINITY; 2];
    for l in leds.iter().take(n) {
        for k in 0..2 {
            mn[k] = mn[k].min(l.pos[k]);
            mx[k] = mx[k].max(l.pos[k]);
        }
    }
    for k in 0..2 {
        let range = mx[k] - mn[k];
        f.uv_min[k] = if range.is_finite() { mn[k] } else { 0.0 };
        f.uv_inv[k] = if range > 1e-6 { 1.0 / range } else { 0.0 };
    }
    // Topology: 8 chained segments on the helix; none on the linear map.
    if kind != Kind::Sign {
        f.n_seg = 0;
    }
    if kind == Kind::Helix {
        let total = {
            let circ = turns * core::f32::consts::TAU * r;
            ledmapper_fx_vm::sqrtf(circ * circ + h * h)
        };
        f.n_seg = N_SEG;
        for k in 0..N_SEG {
            f.seg_len[k] = total / N_SEG as f32;
            f.seg_a[k] = k as i32;
            f.seg_b[k] = k as i32 + 1;
        }
    }
    let per = n.div_ceil(N_SEG).max(1);
    for (i, l) in leds.iter_mut().enumerate().take(n) {
        if kind == Kind::Sign {
            // topology already set by build_sign; just the uv + Q16 mirrors.
            let (x, y) = (l.pos[0], l.pos[1]);
            l.uv = [
                ((x - f.uv_min[0]) * f.uv_inv[0]).clamp(0.0, 1.0),
                ((y - f.uv_min[1]) * f.uv_inv[1]).clamp(0.0, 1.0),
            ];
            l.posq = [q16(l.pos[0]), q16(l.pos[1]), q16(l.pos[2])];
            l.uvq = [q16(l.uv[0]), q16(l.uv[1])];
            continue;
        }
        let x = l.pos[0];
        let y = l.pos[1];
        l.uv = [
            ((x - f.uv_min[0]) * f.uv_inv[0]).clamp(0.0, 1.0),
            ((y - f.uv_min[1]) * f.uv_inv[1]).clamp(0.0, 1.0),
        ];
        if f.n_seg > 0 {
            let k = (i / per).min(N_SEG - 1);
            let start = k * per;
            let len = (n - start).min(per);
            let s = if len > 1 { (i - start) as f32 / (len - 1) as f32 } else { 0.0 };
            l.seg = k as i32;
            l.s = s;
            l.dist = (k as f32 + s) / N_SEG as f32;
        } else {
            l.seg = -1;
            l.s = 0.0;
            l.dist = 0.0;
        }
        l.posq = [q16(l.pos[0]), q16(l.pos[1]), q16(l.pos[2])];
        l.uvq = [q16(l.uv[0]), q16(l.uv[1])];
    }
}

// --- the synthetic sign -------------------------------------------------------
// Letter-local polylines in a unit box (x right, y up); `!` ends a stroke.
type Pt = (f32, f32);
const C: &[&[Pt]] = &[&[(1.0, 1.0), (0.0, 1.0), (0.0, 0.0), (1.0, 0.0)]];
const A: &[&[Pt]] = &[&[(0.0, 0.0), (0.5, 1.0)], &[(0.5, 1.0), (1.0, 0.0)], &[(0.25, 0.5), (0.75, 0.5)]];
const M: &[&[Pt]] = &[
    &[(0.0, 0.0), (0.0, 1.0)],
    &[(0.0, 1.0), (0.5, 0.5)],
    &[(0.5, 0.5), (1.0, 1.0)],
    &[(1.0, 1.0), (1.0, 0.0)],
];
const P: &[&[Pt]] = &[&[(0.0, 0.0), (0.0, 1.0)], &[(0.0, 1.0), (1.0, 1.0), (1.0, 0.5), (0.0, 0.5)]];
const T: &[&[Pt]] = &[&[(0.0, 1.0), (1.0, 1.0)], &[(0.5, 1.0), (0.5, 0.0)]];
const H: &[&[Pt]] = &[&[(0.0, 0.0), (0.0, 1.0)], &[(1.0, 0.0), (1.0, 1.0)], &[(0.0, 0.5), (1.0, 0.5)]];
const E: &[&[Pt]] = &[
    &[(0.0, 0.0), (0.0, 1.0)],
    &[(0.0, 1.0), (1.0, 1.0)],
    &[(0.0, 0.5), (0.8, 0.5)],
    &[(0.0, 0.0), (1.0, 0.0)],
];
const R: &[&[Pt]] = &[
    &[(0.0, 0.0), (0.0, 1.0)],
    &[(0.0, 1.0), (1.0, 1.0), (1.0, 0.5), (0.0, 0.5)],
    &[(0.3, 0.5), (1.0, 0.0)],
];
const Y: &[&[Pt]] = &[&[(0.0, 1.0), (0.5, 0.5), (1.0, 1.0)], &[(0.5, 0.5), (0.5, 0.0)]];
/// (letter, row): row 1 = top ("CAMP"), row 0 = bottom ("THERAPY").
const WORDS: &[(&[&[Pt]], u8, u8)] = &[
    (C, 1, 0), (A, 1, 1), (M, 1, 2), (P, 1, 3),
    (T, 0, 0), (H, 0, 1), (E, 0, 2), (R, 0, 3), (A, 0, 4), (P, 0, 5), (Y, 0, 6),
];
const LW: f32 = 0.11; // letter width (m)
const LH: f32 = 0.20; // letter height
const PITCH: f32 = 0.145;

fn to_world(row: u8, col: u8, p: Pt, top_off: f32) -> (f32, f32) {
    let x0 = col as f32 * PITCH + if row == 1 { top_off } else { 0.0 };
    let y0 = if row == 1 { 0.25 } else { 0.0 };
    (x0 + p.0 * LW, y0 + p.1 * LH)
}

fn poly_len(pts: &[Pt]) -> f32 {
    let mut l = 0.0;
    for w in pts.windows(2) {
        let (dx, dy) = ((w[1].0 - w[0].0) * LW, (w[1].1 - w[0].1) * LH);
        l += crate::fixture::sqrt(dx * dx + dy * dy);
    }
    l
}

pub(crate) fn sqrt(x: f32) -> f32 {
    ledmapper_fx_vm::sqrtf(x)
}

unsafe fn build_sign(f: &mut Fixture, leds: &mut [LedIn; MAX_LEDS], n: usize) {
    let top_off = 1.5 * PITCH; // centre "CAMP" over "THERAPY"
    // Stroke list + total length.
    let mut total = 0.0f32;
    let mut ns = 0usize;
    for (letter, _, _) in WORDS {
        for st in letter.iter() {
            total += poly_len(st);
            ns += 1;
        }
    }
    f.n_seg = ns.min(MAX_SEG);
    let mut i = 0usize;
    let mut k = 0usize;
    let mut placed_len = 0.0f32;
    for (letter, row, col) in WORDS {
        for st in letter.iter() {
            let len = poly_len(st);
            // LEDs for this stroke: cumulative-length rounding so the total is n.
            let end = if k + 1 == ns { n } else { (((placed_len + len) / total) * n as f32) as usize };
            let cnt = end.saturating_sub(i);
            placed_len += len;
            f.seg_len[k] = len;
            f.seg_a[k] = (2 * k) as i32;
            f.seg_b[k] = (2 * k + 1) as i32;
            for j in 0..cnt {
                let s = if cnt > 1 { j as f32 / (cnt - 1) as f32 } else { 0.0 };
                // walk the polyline to arclength s*len
                let mut want = s * len;
                let mut p = st[0];
                for w in st.windows(2) {
                    let (dx, dy) = ((w[1].0 - w[0].0) * LW, (w[1].1 - w[0].1) * LH);
                    let sl = sqrt(dx * dx + dy * dy);
                    if want <= sl || sl == 0.0 {
                        let t = if sl > 0.0 { want / sl } else { 0.0 };
                        p = (w[0].0 + (w[1].0 - w[0].0) * t, w[0].1 + (w[1].1 - w[0].1) * t);
                        want = -1.0;
                        break;
                    }
                    want -= sl;
                    p = w[1];
                }
                let (x, y) = to_world(*row, *col, p, top_off);
                let l = &mut leds[i + j];
                l.pos = [x, y, 0.0];
                l.seg = k as i32;
                l.s = s;
                l.dist = s;
            }
            i = end.max(i);
            k += 1;
        }
    }
}
