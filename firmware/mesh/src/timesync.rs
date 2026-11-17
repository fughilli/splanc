//! Mesh time that no single peer controls (design §6, revised). Pure logic; M4 feeds it the
//! beacon timestamps and maps the show clock on it.
//!
//! Each peer's beacon gives a sample: its clock minus ours, ± an error bound (RX timestamp
//! jitter, its own uncertainty). [`aggregate`] intersects the intervals (Marzullo's
//! algorithm): the offset the most peers agree on wins. With `n ≥ 2f + 1` sources of which at
//! least `n - f` agree, up to `f` liars cannot move it. [`MeshClock`] applies estimates:
//!
//! - **Step** (jump to the estimate) only with high confidence (the quorum above, and at
//!   least [`STEP_QUORUM`] agreeing peers), and an error larger than [`STEP_US`].
//! - **Slew** otherwise, at most [`MAX_SLEW_PPM`]: a single visible peer, or peers that
//!   disagree, can move this node's time only slowly. Low confidence is reported.
//! - Effects keep running whatever happens here: the renderer's clock never stops or waits;
//!   mesh time only shifts when `apply_at` lands.
//!
//! What remains: an **eclipsed** node (its only neighbours are malicious) can be desynced
//! (slowly, by the slew bound) or starved of traffic. It cannot be made to accept forged or
//! replayed commands: those are refused by the per-receiver MACs and the counter-based
//! freshness ([`crate::admin`]), which do not depend on time.

use crate::backhaul::NodeId;

/// Below this error a correction is always a slew.
pub const STEP_US: i64 = 50_000;
/// The fastest a low-confidence correction moves mesh time (500 ppm: 0.5 ms per second).
pub const MAX_SLEW_PPM: i64 = 500;
/// Sources that must agree before a step, whatever `f` is.
pub const STEP_QUORUM: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub peer: NodeId,
    /// The peer's clock minus ours (µs).
    pub offset_us: i64,
    /// Half-width of the interval the true offset is in.
    pub err_us: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Confidence {
    None,
    /// One peer, or no quorum: slew only.
    Low,
    /// `n ≥ 2f + 1` sources and `n - f` of them agree.
    High,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Estimate {
    pub offset_us: i64,
    pub err_us: i64,
    /// Sources whose intervals contain the estimate.
    pub agree: usize,
    pub confidence: Confidence,
}

/// The robust offset of `samples`, tolerating `f` liars (Marzullo intersection; ties broken
/// toward the narrower interval). Without a quorum it falls back to the median offset at
/// low confidence.
pub fn aggregate(samples: &[Sample], f: usize) -> Estimate {
    if samples.is_empty() {
        return Estimate { offset_us: 0, err_us: i64::MAX, agree: 0, confidence: Confidence::None };
    }
    // Sweep the interval ends: +1 at a start, -1 after an end.
    let mut best = (0usize, 0i64, 0i64);
    for s in samples {
        let lo = s.offset_us - s.err_us;
        // The best overlap starts at some interval's start: count who covers `lo`, and the
        // tightest end among them.
        let covering: usize = samples.iter().filter(|t| t.offset_us - t.err_us <= lo && lo <= t.offset_us + t.err_us).count();
        let hi = samples
            .iter()
            .filter(|t| t.offset_us - t.err_us <= lo && lo <= t.offset_us + t.err_us)
            .map(|t| t.offset_us + t.err_us)
            .min()
            .unwrap_or(lo);
        if covering > best.0 || (covering == best.0 && hi - lo < best.2 - best.1) {
            best = (covering, lo, hi);
        }
    }
    let (agree, lo, hi) = best;
    let n = samples.len();
    if n > 2 * f && agree + f >= n && agree >= 2 {
        return Estimate { offset_us: lo + (hi - lo) / 2, err_us: (hi - lo) / 2, agree, confidence: Confidence::High };
    }
    let mut v: [i64; 16] = [0; 16];
    let n = samples.len().min(16);
    for (x, s) in v.iter_mut().zip(samples) {
        *x = s.offset_us;
    }
    v[..n].sort_unstable();
    let median = v[n / 2];
    let err = samples.iter().map(|s| s.err_us).min().unwrap_or(i64::MAX);
    Estimate { offset_us: median, err_us: err, agree, confidence: Confidence::Low }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Adjust {
    Hold,
    Step(i64),
    Slew(i64),
}

/// This node's correction from its local clock to mesh time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MeshClock {
    pub offset_us: i64,
    pub confidence: Option<Confidence>,
}

impl MeshClock {
    /// Apply an estimate `dt_us` after the previous one. `f` is the liars tolerated.
    pub fn update(&mut self, est: &Estimate, f: usize, dt_us: i64) -> Adjust {
        self.confidence = Some(est.confidence);
        let delta = est.offset_us - self.offset_us;
        let adj = match est.confidence {
            Confidence::None => Adjust::Hold,
            Confidence::High if delta.abs() > STEP_US && est.agree >= (f + 1).max(STEP_QUORUM) => Adjust::Step(delta),
            _ => {
                let max = (dt_us.max(0) * MAX_SLEW_PPM) / 1_000_000;
                let d = delta.clamp(-max, max);
                if d == 0 {
                    Adjust::Hold
                } else {
                    Adjust::Slew(d)
                }
            }
        };
        match adj {
            Adjust::Step(d) | Adjust::Slew(d) => self.offset_us += d,
            Adjust::Hold => {}
        }
        adj
    }

    pub fn mesh_us(&self, local_us: i64) -> i64 {
        local_us + self.offset_us
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(peer: NodeId, o: i64) -> Sample {
        Sample { peer, offset_us: o, err_us: 500 }
    }

    #[test]
    fn honest_majority_wins_over_f_liars() {
        // 5 sources, f = 2: two liars far off.
        let e = aggregate(&[s(1, 10_000), s(2, 10_300), s(3, 9_800), s(4, 900_000), s(5, -400_000)], 2);
        assert_eq!(e.confidence, Confidence::High);
        assert_eq!(e.agree, 3);
        assert!((9_800..=10_300).contains(&e.offset_us), "{e:?}");
        // Liars that agree with each other but are outnumbered.
        let e = aggregate(&[s(1, 0), s(2, 100), s(3, -100), s(4, 50_000), s(5, 50_100)], 2);
        assert!(e.offset_us.abs() < 600 && e.agree == 3, "{e:?}");
    }

    #[test]
    fn steps_need_a_quorum_slews_are_bounded() {
        let mut c = MeshClock::default();
        // Three agree on +1 s: step.
        let e = aggregate(&[s(1, 1_000_000), s(2, 1_000_200), s(3, 999_900)], 1);
        assert!(matches!(c.update(&e, 1, 1_000_000), Adjust::Step(_)));
        assert!((c.offset_us - 1_000_000).abs() < 500);
        // A single peer claiming +10 s: low confidence, slew at most 500 ppm.
        let e = aggregate(&[s(9, 11_000_000)], 1);
        assert_eq!(e.confidence, Confidence::Low);
        assert_eq!(c.update(&e, 1, 1_000_000), Adjust::Slew(500));
        // One honest peer and one liar (n = 2 < 2f + 1 with f = 1): low confidence, slew only.
        let e = aggregate(&[s(1, 1_000_000), s(3, 5_000_000)], 1);
        assert_eq!(e.confidence, Confidence::Low);
        assert!(matches!(c.update(&e, 1, 1_000_000), Adjust::Slew(d) if d.abs() <= 500));
        // Two agree and one lies (n = 3, f = 1): high confidence, but a step needs three
        // agreeing peers, so a large correction from only two is still a slew.
        let e = aggregate(&[s(1, 3_000_000), s(2, 3_000_100), s(3, 9_000_000)], 1);
        assert_eq!((e.confidence, e.agree), (Confidence::High, 2));
        assert!(matches!(c.update(&e, 1, 1_000_000), Adjust::Slew(500)));
        // Nothing heard: hold.
        assert_eq!(c.update(&aggregate(&[], 1), 1, 1_000_000), Adjust::Hold);
    }

    /// An eclipsed node: its only peer lies. A minute of lies moves it by 30 ms at most.
    #[test]
    fn an_eclipsed_node_drifts_only_by_the_slew_bound() {
        let mut c = MeshClock::default();
        for _ in 0..60 {
            let e = aggregate(&[s(66, 3_600_000_000)], 1);
            c.update(&e, 1, 1_000_000);
        }
        assert_eq!(c.offset_us, 60 * 500);
    }
}
