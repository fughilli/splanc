//! Optional strip prior.
//!
//! Most fixtures are a strip, rope or string: LED ids are wired in order, so
//! LED `i` and LED `i + k` can be no further apart than `k` LED pitches (a
//! chord is never longer than the arc it spans). Diffuse capture is the case
//! that needs this most — striding cuts each LED's observation rate N×, and
//! bloomed blobs give poor ray vergence — so a geometric prior that ties each
//! LED to its index neighbours recovers a lot of what the photometry loses.
//!
//! The prior has three parts, all driven from `pipeline::reconstruct_vio`:
//!
//!  1. [`estimate_spacing`] — the LED pitch, measured from the unconstrained
//!     solve (median distance between consecutive mapped ids; noise only
//!     inflates it, so it is a safe upper bound on the true pitch).
//!  2. [`chain_links`] — "rope" links between consecutive mapped LEDs, fed to
//!     the bundle adjustment as one-sided penalties (`vio::SolveOptions::chain`):
//!     zero while two LEDs are within `k · spacing · (1 + tolerance)` of each
//!     other, growing linearly past it. A gap that is far too long between
//!     two LEDs that each agree with their other neighbour is treated as a
//!     genuine break (a jumper wire between strip segments) and left unlinked.
//!  3. [`chain_outliers`] + [`fill_gaps`] — after the constrained solve, an LED
//!     still too far from BOTH its neighbours (while they agree with each
//!     other) is demoted to unmapped, and every interior run of unmapped LEDs
//!     is placed on the straight segment between its mapped neighbours, at
//!     equal spacing. Runs before the first / after the last mapped LED are
//!     left unmapped: with one neighbour there is no segment to place them on.
//!
//! Everything here is pure geometry over (sorted id, position) lists, so it
//! is unit-tested without a solve.

use crate::linalg::{add, norm, scale, sub, Vec3};

/// Minimum consecutive-id pairs needed to trust a spacing estimate.
pub const MIN_SPACING_PAIRS: usize = 4;
/// Prefer pairs between confident LEDs when there are at least this many.
const MIN_CONFIDENT_PAIRS: usize = 8;
/// Largest id gap whose chord is used (÷ gap) as a fallback spacing sample
/// when too few directly adjacent pairs were both mapped.
const MAX_FALLBACK_GAP: u32 = 3;
/// A gap longer than this many times its bound, between two LEDs that each
/// agree with their other neighbour, is a break in the strip, not an error.
pub const BREAK_FACTOR: f64 = 3.0;
/// Extra slack (in pitches) beyond the bound before the post-solve checks
/// call a link violated — the bundle adjustment's penalty is soft, so a
/// small overshoot is expected and is not evidence of a bad LED.
pub const VIOLATION_SLACK_PITCH: f64 = 0.5;

/// One rope link: LEDs `a < b` may be at most `max_dist` apart.
#[derive(Clone, Debug, PartialEq)]
pub struct ChainLink {
    pub a: u32,
    pub b: u32,
    pub max_dist: f64,
}

/// Maximum allowed distance between LEDs `gap` ids apart.
pub fn bound(gap: u32, spacing: f64, tolerance: f64) -> f64 {
    gap as f64 * spacing * (1.0 + tolerance)
}

fn dist(a: Vec3, b: Vec3) -> f64 {
    norm(sub(a, b))
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

/// Estimate the LED pitch from mapped LEDs (`ids` sorted ascending, `pos` and
/// `confident` parallel). Uses directly adjacent ids, preferring pairs where
/// both LEDs are confidently solved; falls back to gaps of up to
/// `MAX_FALLBACK_GAP` (chord ÷ gap) when adjacent pairs are scarce. `None`
/// when there is not enough evidence — the caller then skips the prior.
pub fn estimate_spacing(ids: &[u32], pos: &[Vec3], confident: &[bool]) -> Option<f64> {
    let mut adjacent_conf = Vec::new();
    let mut adjacent_all = Vec::new();
    let mut fallback = Vec::new();
    for w in 0..ids.len().saturating_sub(1) {
        let gap = ids[w + 1] - ids[w];
        let d = dist(pos[w], pos[w + 1]);
        if !d.is_finite() || d <= 0.0 {
            continue;
        }
        if gap == 1 {
            adjacent_all.push(d);
            if confident[w] && confident[w + 1] {
                adjacent_conf.push(d);
            }
        }
        if gap <= MAX_FALLBACK_GAP {
            fallback.push(d / gap as f64);
        }
    }
    let pick = if adjacent_conf.len() >= MIN_CONFIDENT_PAIRS {
        adjacent_conf
    } else if adjacent_all.len() >= MIN_SPACING_PAIRS {
        adjacent_all
    } else if fallback.len() >= MIN_SPACING_PAIRS {
        fallback
    } else {
        return None;
    };
    let mut pick = pick;
    let s = median(&mut pick);
    (s.is_finite() && s > 0.0).then_some(s)
}

/// Is mapped LED `w` (index into the sorted lists) consistent with its
/// neighbour on the side away from `other` (`other` = w ± 1)? An end LED with
/// no such neighbour counts as consistent only if `confident`.
fn agrees_with_far_neighbour(
    ids: &[u32],
    pos: &[Vec3],
    confident: &[bool],
    w: usize,
    toward_next: bool,
    spacing: f64,
    tolerance: f64,
) -> bool {
    let far = if toward_next {
        w.checked_sub(1)
    } else {
        (w + 1 < ids.len()).then_some(w + 1)
    };
    match far {
        Some(f) => {
            let gap = ids[w].abs_diff(ids[f]);
            dist(pos[w], pos[f]) <= bound(gap, spacing, tolerance) + VIOLATION_SLACK_PITCH * spacing
        }
        None => confident[w],
    }
}

/// Rope links between consecutive mapped LEDs, and the gaps judged to be
/// genuine breaks (returned as `(a, b)` id pairs and left unlinked).
pub fn chain_links(
    ids: &[u32],
    pos: &[Vec3],
    confident: &[bool],
    spacing: f64,
    tolerance: f64,
) -> (Vec<ChainLink>, Vec<(u32, u32)>) {
    let mut links = Vec::new();
    let mut breaks = Vec::new();
    for w in 0..ids.len().saturating_sub(1) {
        let (a, b) = (ids[w], ids[w + 1]);
        let max_dist = bound(b - a, spacing, tolerance);
        let d = dist(pos[w], pos[w + 1]);
        let is_break = d > BREAK_FACTOR * max_dist
            && confident[w]
            && confident[w + 1]
            && agrees_with_far_neighbour(ids, pos, confident, w, true, spacing, tolerance)
            && agrees_with_far_neighbour(ids, pos, confident, w + 1, false, spacing, tolerance);
        if is_break {
            breaks.push((a, b));
        } else {
            links.push(ChainLink { a, b, max_dist });
        }
    }
    (links, breaks)
}

fn is_break(breaks: &[(u32, u32)], a: u32, b: u32) -> bool {
    breaks.iter().any(|&(x, y)| x == a && y == b)
}

/// Mapped LEDs that still violate the rope bound to their neighbours after the
/// constrained solve: an interior LED too far from BOTH neighbours while those
/// two agree with each other, or an end LED too far from its only neighbour
/// while that one agrees with the next. Breaks are respected (a chain segment
/// end next to a break is treated as an end).
pub fn chain_outliers(
    ids: &[u32],
    pos: &[Vec3],
    spacing: f64,
    tolerance: f64,
    breaks: &[(u32, u32)],
) -> Vec<u32> {
    let n = ids.len();
    let slack = VIOLATION_SLACK_PITCH * spacing;
    let ok = |i: usize, j: usize| -> bool {
        dist(pos[i], pos[j]) <= bound(ids[i].abs_diff(ids[j]), spacing, tolerance) + slack
    };
    let linked = |i: usize, j: usize| -> bool { !is_break(breaks, ids[i], ids[j]) };
    let mut out = Vec::new();
    for w in 0..n {
        let prev = (w > 0 && linked(w - 1, w)).then(|| w - 1);
        let next = (w + 1 < n && linked(w, w + 1)).then_some(w + 1);
        let outlier = match (prev, next) {
            (Some(p), Some(q)) => !ok(p, w) && !ok(w, q) && ok(p, q),
            (None, Some(q)) => {
                let qq = (q + 1 < n && linked(q, q + 1)).then_some(q + 1);
                !ok(w, q) && qq.is_some_and(|qq| ok(q, qq))
            }
            (Some(p), None) => {
                let pp = (p > 0 && linked(p - 1, p)).then(|| p - 1);
                !ok(p, w) && pp.is_some_and(|pp| ok(pp, p))
            }
            (None, None) => false,
        };
        if outlier {
            out.push(ids[w]);
        }
    }
    out
}

/// Place every interior run of unmapped ids on the straight segment between
/// its mapped neighbours, equally spaced. A gap that is a break, or whose
/// endpoints are too far apart for the run to fit on the strip, is left
/// unmapped. Returns `(id, xyz)` for the placed LEDs, ascending.
pub fn fill_gaps(
    ids: &[u32],
    pos: &[Vec3],
    spacing: f64,
    tolerance: f64,
    breaks: &[(u32, u32)],
) -> Vec<(u32, Vec3)> {
    let slack = VIOLATION_SLACK_PITCH * spacing;
    let mut out = Vec::new();
    for w in 0..ids.len().saturating_sub(1) {
        let (a, b) = (ids[w], ids[w + 1]);
        let gap = b - a;
        if gap < 2 || is_break(breaks, a, b) {
            continue;
        }
        let seg = sub(pos[w + 1], pos[w]);
        if norm(seg) > bound(gap, spacing, tolerance) + slack {
            continue;
        }
        for i in 1..gap {
            let t = i as f64 / gap as f64;
            out.push((a + i, add(pos[w], scale(seg, t))));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A helix strip: `n` LEDs at `pitch` along a coil of radius `r`.
    fn helix(n: usize, pitch: f64, r: f64, rise_per_turn: f64) -> Vec<Vec3> {
        let arc_per_turn = (std::f64::consts::TAU * r).hypot(rise_per_turn);
        (0..n)
            .map(|i| {
                let s = i as f64 * pitch;
                let th = std::f64::consts::TAU * s / arc_per_turn;
                [
                    r * th.cos(),
                    rise_per_turn * th / std::f64::consts::TAU,
                    r * th.sin(),
                ]
            })
            .collect()
    }

    fn subset(all: &[Vec3], keep: &[u32]) -> (Vec<u32>, Vec<Vec3>) {
        (
            keep.to_vec(),
            keep.iter().map(|&i| all[i as usize]).collect(),
        )
    }

    #[test]
    fn spacing_is_recovered_from_adjacent_pairs() {
        let all = helix(60, 0.02, 0.065, 0.021);
        let keep: Vec<u32> = (0..60).filter(|i| i % 7 != 3).collect();
        let (ids, pos) = subset(&all, &keep);
        let conf = vec![true; ids.len()];
        let s = estimate_spacing(&ids, &pos, &conf).unwrap();
        // chord of a 20 mm arc on a 65 mm coil is within 0.5% of the pitch
        assert!((s - 0.02).abs() < 0.0002, "spacing {s}");
    }

    #[test]
    fn spacing_falls_back_to_short_gaps_when_no_adjacent_pairs() {
        let all = helix(60, 0.02, 0.065, 0.021);
        let keep: Vec<u32> = (0..60).step_by(2).collect(); // never two adjacent
        let (ids, pos) = subset(&all, &keep);
        let s = estimate_spacing(&ids, &pos, &vec![true; ids.len()]).unwrap();
        assert!((s - 0.02).abs() < 0.0005, "spacing {s}");
        assert!(estimate_spacing(&ids[..3], &pos[..3], &[true; 3]).is_none());
    }

    #[test]
    fn links_cover_every_gap_and_scale_with_it() {
        let all = helix(30, 0.02, 0.065, 0.021);
        let (ids, pos) = subset(&all, &[0, 1, 2, 5, 6, 12]);
        let (links, breaks) = chain_links(&ids, &pos, &[true; 6], 0.02, 0.25);
        assert!(breaks.is_empty());
        assert_eq!(links.len(), 5);
        assert_eq!(
            links[2],
            ChainLink {
                a: 2,
                b: 5,
                max_dist: 3.0 * 0.02 * 1.25
            }
        );
    }

    #[test]
    fn a_jumper_between_two_strips_is_a_break_not_a_link() {
        // Two straight runs 0.5 m apart joined by a jumper between ids 9 and 10.
        let pos: Vec<Vec3> = (0..20)
            .map(|i| {
                if i < 10 {
                    [i as f64 * 0.03, 0.0, 0.0]
                } else {
                    [i as f64 * 0.03, 0.5, 0.0]
                }
            })
            .collect();
        let ids: Vec<u32> = (0..20).collect();
        let (links, breaks) = chain_links(&ids, &pos, &[true; 20], 0.03, 0.25);
        assert_eq!(breaks, vec![(9, 10)]);
        assert_eq!(links.len(), 18);
        // ...and no LED is demoted for sitting next to it, nor is anything filled across it.
        assert!(chain_outliers(&ids, &pos, 0.03, 0.25, &breaks).is_empty());
    }

    #[test]
    fn a_weak_far_endpoint_is_linked_not_broken() {
        // Same geometry, but LED 10 is low-confidence: it is far more likely a
        // bad solve than a jumper, so it stays linked (the rope pulls it in).
        let mut pos: Vec<Vec3> = (0..20).map(|i| [i as f64 * 0.03, 0.0, 0.0]).collect();
        pos[10] = [0.30, 0.5, 0.0];
        let ids: Vec<u32> = (0..20).collect();
        let mut conf = vec![true; 20];
        conf[10] = false;
        let (links, breaks) = chain_links(&ids, &pos, &conf, 0.03, 0.25);
        assert!(breaks.is_empty());
        assert_eq!(links.len(), 19);
    }

    #[test]
    fn an_isolated_misplaced_led_is_an_outlier() {
        let all = helix(40, 0.02, 0.065, 0.021);
        let mut pos = all.clone();
        pos[17] = all[30]; // a decode swap put LED 17 where LED 30 is
        let ids: Vec<u32> = (0..40).collect();
        assert_eq!(chain_outliers(&ids, &pos, 0.02, 0.25, &[]), vec![17]);
        // End LEDs are judged against the next pair in.
        let mut pos = all.clone();
        pos[0] = add(all[0], [0.0, 0.2, 0.0]);
        assert_eq!(chain_outliers(&ids, &pos, 0.02, 0.25, &[]), vec![0]);
        // A clean strip has none.
        assert!(chain_outliers(&ids, &all, 0.02, 0.25, &[]).is_empty());
    }

    #[test]
    fn interior_runs_are_divided_equally_on_the_segment() {
        let all = helix(40, 0.02, 0.065, 0.021);
        let (ids, pos) = subset(&all, &[2, 3, 4, 9, 10, 11]);
        let fills = fill_gaps(&ids, &pos, 0.02, 0.25, &[]);
        let fid: Vec<u32> = fills.iter().map(|f| f.0).collect();
        assert_eq!(fid, vec![5, 6, 7, 8]); // 0,1 and 12.. are end runs: left unmapped
                                           // equal division of the 4 → 9 segment
        for (k, (id, x)) in fills.iter().enumerate() {
            let t = (k + 1) as f64 / 5.0;
            let want = add(all[4], scale(sub(all[9], all[4]), t));
            assert!(dist(*x, want) < 1e-12, "id {id}");
        }
        // and every placed LED is within one pitch of its true spot on this gentle coil
        for (id, x) in &fills {
            assert!(dist(*x, all[*id as usize]) < 0.02, "id {id}");
        }
    }

    #[test]
    fn impossible_or_broken_gaps_are_not_filled() {
        let ids = vec![0, 4, 5, 9];
        let pos = vec![
            [0.0, 0.0, 0.0],
            [0.5, 0.0, 0.0],
            [0.52, 0.0, 0.0],
            [0.6, 0.0, 0.0],
        ];
        // 0→4 spans 0.5 m for 4 pitches of 2 cm: impossible, so not filled; 5→9 fits.
        let fills = fill_gaps(&ids, &pos, 0.02, 0.25, &[]);
        assert_eq!(fills.iter().map(|f| f.0).collect::<Vec<_>>(), vec![6, 7, 8]);
        let fills = fill_gaps(&ids, &pos, 0.02, 0.25, &[(5, 9)]);
        assert!(fills.is_empty());
    }
}
