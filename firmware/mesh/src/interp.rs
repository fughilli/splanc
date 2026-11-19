//! On-device interpolation of live uniform updates (design §6.4, Q13).
//!
//! The mesh carries live moves (fader drags) at whatever rate its airtime allows: about
//! 30 Hz to 16 fixtures at 6 Mb/s, less to more. Each update is a keyframe stamped with the
//! mesh time it applies at (`apply_at` = send time + a playout delay). A member renders on its
//! own clock (60 fps or more) and samples each uniform's [`Track`] at
//! `mesh time − playout delay`, so motion is smooth whatever the update rate:
//!
//! | Uniform type            | Between keyframes                        | Past the last keyframe (loss)          |
//! | ----------------------- | ---------------------------------------- | -------------------------------------- |
//! | float (fader, speed)    | Catmull-Rom (Hermite); linear at the ends | keep its velocity for ≤ 1 interval, ease to a hold over the next; hold after |
//! | colour                  | linear, per channel in linear RGB         | hold                                   |
//! | int, enum, bool, effect | step at `apply_at`                        | hold                                   |
//!
//! The playout delay is 2.5 keyframe intervals, at least 33 ms ([`playout_delay_us`]): late
//! enough that the keyframes around the render time have arrived, early enough to feel
//! immediate. Pure, no allocation: 8 keyframes per track (enough for that delay at 120 Hz).

/// How a uniform is interpolated.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Float,
    Color,
    Discrete,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Keyframe {
    /// Mesh time the value applies at (µs).
    pub t_us: i64,
    pub v: f32,
}

/// How a sample was produced.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Sampled {
    /// Between two keyframes.
    Interpolated,
    /// Past the last keyframe, still moving on its velocity.
    Extrapolated,
    /// Holding a value (no keyframes ahead, or a discrete uniform).
    Held,
    /// Nothing received yet.
    Empty,
}

/// The playout delay for keyframes `interval_us` apart.
pub const fn playout_delay_us(interval_us: i64) -> i64 {
    let d = interval_us * 5 / 2;
    if d < 33_000 {
        33_000
    } else {
        d
    }
}

const N: usize = 8;

/// The last 8 keyframes of one uniform.
#[derive(Clone, Copy, Debug, Default)]
pub struct Track {
    k: [Option<Keyframe>; N],
}

fn lerp(a: f32, b: f32, x: f32) -> f32 {
    a + (b - a) * x
}

impl Track {
    pub const fn new() -> Track {
        Track { k: [None; N] }
    }

    /// A keyframe arrived (out-of-order or duplicate ones are ignored).
    pub fn push(&mut self, kf: Keyframe) {
        if self.k[N - 1].is_some_and(|l| kf.t_us <= l.t_us) {
            return;
        }
        self.k.rotate_left(1);
        self.k[N - 1] = Some(kf);
    }

    /// The value at mesh time `t_us`. `interval_us` is the expected keyframe spacing (the
    /// extrapolation limit).
    pub fn sample(&self, kind: Kind, t_us: i64, interval_us: i64) -> (f32, Sampled) {
        let ks: [Option<Keyframe>; N] = self.k;
        let Some(last) = ks[N - 1] else { return (0.0, Sampled::Empty) };
        // Find the segment [i, i+1] containing t.
        for i in (0..N - 1).rev() {
            let (Some(a), Some(b)) = (ks[i], ks[i + 1]) else { continue };
            if t_us >= a.t_us && t_us < b.t_us {
                let x = (t_us - a.t_us) as f32 / (b.t_us - a.t_us) as f32;
                return match kind {
                    Kind::Discrete => (a.v, Sampled::Held),
                    Kind::Color => (lerp(a.v, b.v, x), Sampled::Interpolated),
                    Kind::Float => {
                        // Catmull-Rom with the neighbours when they exist, else linear.
                        let p0 = if i > 0 { ks[i - 1] } else { None };
                        let p3 = if i + 2 < N { ks[i + 2] } else { None };
                        let dt = (b.t_us - a.t_us) as f32;
                        let m0 = p0.map_or(b.v - a.v, |p| (b.v - p.v) * dt / (b.t_us - p.t_us) as f32);
                        let m1 = p3.map_or(b.v - a.v, |p| (p.v - a.v) * dt / (p.t_us - a.t_us) as f32);
                        let (x2, x3) = (x * x, x * x * x);
                        let v = (2.0 * x3 - 3.0 * x2 + 1.0) * a.v + (x3 - 2.0 * x2 + x) * m0 + (-2.0 * x3 + 3.0 * x2) * b.v + (x3 - x2) * m1;
                        (v, Sampled::Interpolated)
                    }
                };
            }
        }
        if t_us < ks.iter().flatten().next().map_or(last.t_us, |k| k.t_us) {
            // Before the first keyframe we hold: the first one.
            return (ks.iter().flatten().next().map_or(last.v, |k| k.v), Sampled::Held);
        }
        // Past the last keyframe.
        match (kind, ks[N - 2]) {
            (Kind::Float, Some(prev)) if interval_us > 0 => {
                let vel = (last.v - prev.v) / (last.t_us - prev.t_us).max(1) as f32;
                let over = t_us - last.t_us;
                if over <= interval_us {
                    (last.v + vel * over as f32, Sampled::Extrapolated)
                } else {
                    // Ease to a hold over the next interval: integrate the decaying velocity.
                    let e = ((over - interval_us) as f32 / interval_us as f32).min(1.0);
                    let extra = vel * interval_us as f32 * (e - e * e / 2.0);
                    (last.v + vel * interval_us as f32 + extra, if e < 1.0 { Sampled::Extrapolated } else { Sampled::Held })
                }
            }
            _ => (last.v, Sampled::Held),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kf(t_ms: i64, v: f32) -> Keyframe {
        Keyframe { t_us: t_ms * 1000, v }
    }

    #[test]
    fn interpolates_extrapolates_and_holds() {
        let mut t = Track::new();
        assert_eq!(t.sample(Kind::Float, 0, 33_000).1, Sampled::Empty);
        for (ms, v) in [(0, 0.0), (33, 1.0), (66, 2.0), (100, 3.0)] {
            t.push(kf(ms, v));
        }
        // On a straight line every method is exact.
        let (v, s) = t.sample(Kind::Float, 50_000, 33_000);
        assert!((v - 1.5).abs() < 0.05 && s == Sampled::Interpolated, "{v}");
        assert_eq!(t.sample(Kind::Color, 50_000, 33_000).0, 1.0 + 17.0 / 33.0);
        assert_eq!(t.sample(Kind::Discrete, 50_000, 33_000), (1.0, Sampled::Held));
        // Past the end: keep the velocity one interval, then ease to a hold.
        let (v, s) = t.sample(Kind::Float, 120_000, 33_000);
        assert!((v - 3.6).abs() < 0.05 && s == Sampled::Extrapolated, "{v}");
        let (v2, s2) = t.sample(Kind::Float, 1_000_000, 33_000);
        assert_eq!(s2, Sampled::Held);
        assert!(v2 > 3.9 && v2 < 4.6, "{v2}");
        // Old or duplicate keyframes are ignored.
        t.push(kf(50, 9.0));
        assert!((t.sample(Kind::Float, 60_000, 33_000).0 - 1.8).abs() < 0.1);
    }

    /// A sine fader at 60 fps from 30 Hz keyframes: Hermite beats linear beats step.
    #[test]
    fn hermite_is_smoothest() {
        let f = |t: f64| (t * std::f64::consts::TAU * 0.5).sin() as f32;
        let mut err = [0.0f64; 3];
        let mut tr = Track::new();
        let mut next_kf = 0i64;
        for frame in 0..600i64 {
            let t = frame * 16_667;
            while next_kf <= t + 100_000 {
                tr.push(Keyframe { t_us: next_kf, v: f(next_kf as f64 / 1e6) });
                next_kf += 33_333;
            }
            for (k, kind) in [Kind::Discrete, Kind::Color, Kind::Float].iter().enumerate() {
                let (v, _) = tr.sample(*kind, t, 33_333);
                err[k] += ((v - f(t as f64 / 1e6)) as f64).powi(2);
            }
        }
        let rms: Vec<f64> = err.iter().map(|e| (e / 600.0).sqrt()).collect();
        assert!(rms[2] < rms[1] && rms[1] < rms[0], "{rms:?}");
        assert!(rms[2] < 0.002, "{rms:?}");
    }
}
