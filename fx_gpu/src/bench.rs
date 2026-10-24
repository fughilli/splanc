//! Deterministic fixtures + the `.fxp` pack format shared by the host pack
//! tool (`fxgpu_pack`) and the on-Pi benchmarks (`fxvm_bench`, `gles2bench`).
//!
//! A *point* is a MAX-style layout of `channels` strips of `per_channel` LEDs.
//! The GPU render target is `per_channel` × `channels` (row = channel = one
//! FPGA output's address range), so 20×1024 is a 1024×20 target — inside the
//! vc4 2048×2048 limit with no tiling. LED `i` sits at pixel
//! `(i % per_channel, i / per_channel)`.
//!
//! The fixture and frame generators are pure f32 maths on the same aarch64
//! code path on host and Pi, so the host-computed VM goldens are exactly what
//! the Pi's VM produces (the VM is bit-exact across platforms by design).

use ledmapper_fx_vm as vm;

#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub channels: usize,
    pub per_channel: usize,
}

impl Layout {
    pub fn n(&self) -> usize {
        self.channels * self.per_channel
    }
    pub fn name(&self) -> String {
        format!("{}x{}", self.channels, self.per_channel)
    }
}

/// The sweep the design doc reports: 500, 2048, the 4×550 MAX layout today,
/// then up to the 20×1024 MAX target.
pub fn sweep() -> Vec<Layout> {
    [(1, 500), (1, 2048), (4, 550), (4, 1024), (8, 1024), (16, 1024), (20, 1024)]
        .iter()
        .map(|&(c, p)| Layout { channels: c, per_channel: p })
        .collect()
}

pub fn parse_layout(s: &str) -> Option<Layout> {
    let (c, p) = s.split_once('x')?;
    Some(Layout { channels: c.parse().ok()?, per_channel: p.parse().ok()? })
}

/// Per-LED context for a layout: each channel a gently curved strip, stacked
/// in y. Exercises pos/uv/s/seg/dist/idx like a real mapped fixture.
pub fn leds(l: &Layout) -> Vec<vm::Led> {
    let mut out = Vec::with_capacity(l.n());
    for c in 0..l.channels {
        for k in 0..l.per_channel {
            let i = c * l.per_channel + k;
            let s = k as f32 / (l.per_channel.max(2) - 1) as f32;
            let yc = (c as f32 + 0.5) / l.channels as f32;
            let pos = [s, yc, 0.15 * (s * 6.2831855).sin()];
            let uv = [s, yc];
            let mut led = vm::Led {
                pos,
                idx: i as u32,
                seg: c as i32,
                s,
                branch: false,
                dist: (c as f32 + s) / l.channels as f32,
                uv,
                room: pos,
                ..Default::default()
            };
            for j in 0..3 {
                led.pos_fix[j] = vm::f32_to_fix(pos[j], 16);
                led.room_fix[j] = led.pos_fix[j];
            }
            led.uv_fix = [vm::f32_to_fix(uv[0], 16), vm::f32_to_fix(uv[1], 16)];
            led.s_fix = vm::f32_to_fix(s, 16);
            led.dist_fix = vm::f32_to_fix(led.dist, 16);
            out.push(led);
        }
    }
    out
}

pub fn frame_at(f: u32, n: usize) -> vm::Frame {
    let dt = 1.0 / 30.0;
    let time = f as f32 * dt;
    let mut fr = vm::Frame {
        time,
        dt,
        frame: f,
        led_count: n as u32,
        imu_accel: [0.1 * (time * 0.7).sin(), 0.98, -0.05],
        imu_gyro: [0.02, -0.01, 0.03 * (time * 1.3).cos()],
        ..Default::default()
    };
    fr.time_fix = vm::f32_to_fix(time, 16);
    fr.dt_fix = vm::f32_to_fix(dt, 16);
    for c in 0..3 {
        fr.imu_accel_fix[c] = vm::f32_to_fix(fr.imu_accel[c], 16);
        fr.imu_gyro_fix[c] = vm::f32_to_fix(fr.imu_gyro[c], 16);
    }
    fr
}

/// Frames whose output is checked against the VM golden (both benches reach
/// them even under a tight time budget).
pub const CHECK_FRAMES: [u32; 3] = [0, 1, 2];

/// `.fxp` pack header (little endian u32s after the 4-byte magic).
pub const MAGIC: &[u8; 4] = b"FXP1";

pub struct Pack {
    pub w: u32,
    pub h: u32,
    pub n: u32,
    /// per-LED input words (`n * a`), attribute order
    pub a: u32,
    pub led_words: Vec<u32>,
    /// per-frame input words (`frames * u`), uniform order
    pub u: u32,
    pub frames: u32,
    pub frame_words: Vec<u32>,
    /// VM golden RGB for each CHECK_FRAMES entry (`n * 3` bytes each)
    pub golden: Vec<Vec<u8>>,
}

impl Pack {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut b = Vec::new();
        b.extend_from_slice(MAGIC);
        for v in [self.w, self.h, self.n, self.a, self.u, self.frames, CHECK_FRAMES.len() as u32] {
            b.extend_from_slice(&v.to_le_bytes());
        }
        for &f in &CHECK_FRAMES {
            b.extend_from_slice(&f.to_le_bytes());
        }
        for w in self.led_words.iter().chain(self.frame_words.iter()) {
            b.extend_from_slice(&w.to_le_bytes());
        }
        for g in &self.golden {
            b.extend_from_slice(g);
        }
        b
    }

    pub fn golden_from_bytes(bytes: &[u8]) -> Option<(u32, Vec<Vec<u8>>)> {
        if bytes.get(0..4)? != MAGIC {
            return None;
        }
        let rd = |o: usize| u32::from_le_bytes(bytes[o..o + 4].try_into().unwrap());
        let (n, a, u, frames, k) = (rd(12), rd(16), rd(20), rd(24), rd(28) as usize);
        let mut o = 32 + 4 * k;
        o += 4 * (n as usize * a as usize + frames as usize * u as usize);
        let mut g = Vec::new();
        for _ in 0..k {
            g.push(bytes.get(o..o + 3 * n as usize)?.to_vec());
            o += 3 * n as usize;
        }
        Some((n, g))
    }
}
