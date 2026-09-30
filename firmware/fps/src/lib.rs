//! Framerate autoscaler (FUG-82): keep effects at a *consistent* FPS by picking
//! a target from a fixed ladder and adapting it to the effect's real per-frame
//! cost on this device.
//!
//! The player runs `.fxb` shader effects whose per-frame cost (update + per-LED
//! shade + the FastLED strip write) varies wildly with the program and the LED
//! count, in soft-float on the C6. A fixed frame period therefore either wastes
//! headroom (cheap effect) or starves the WiFi/BLE tasks and stutters (heavy
//! effect). This controller closes the loop:
//!
//! - **Ladder.** Targets live on a 5-fps grid from [`MIN_FPS`] to [`MAX_FPS`]
//!   (25..80). Discrete steps make the cadence legible to the app and damp
//!   oscillation vs. a continuous controller.
//! - **5% headroom.** A frame is *missed* when its measured cost exceeds
//!   [`HEADROOM_PCT`]% of the current target's period — i.e. we want at least
//!   5% of every frame period left for the other threads.
//! - **x/N window.** Over a sliding window of [`WINDOW_N`] frames, if more than
//!   [`miss_limit`](FpsController::miss_limit) frames were missed, drop one
//!   rung. A clean window whose worst frame still fits the *next* rung's
//!   headroom budget steps up one rung.
//! - **Abort.** If we are already at the floor (25 fps, or a user-pinned
//!   target) and a window still fails, the effect can't run within budget:
//!   [`take_abort`](FpsController::take_abort) reports it so the caller parks
//!   the effect (freeing the CPU) and notifies the app.
//! - **Override.** The app can pin an exact target with [`set_target`]; the
//!   controller stops autoscaling and holds that rung. If the pinned rung keeps
//!   missing, it aborts (the user asked for a rate this effect can't hit).
//!
//! Pure, `no_std`, zero-dependency, integer-only (no hardware f64 on the C6) so
//! it unit-tests on the host and compiles unchanged for the device.

#![no_std]

/// Lowest / highest ladder rungs, in FPS. Below the floor an effect is deemed
/// unrunnable (abort); above the ceiling there is nothing to gain from a faster
/// strip write than the eye resolves.
pub const MIN_FPS: u32 = 25;
pub const MAX_FPS: u32 = 80;
/// Ladder step. Rungs are MIN_FPS, MIN_FPS+STEP, ..., MAX_FPS.
pub const FPS_STEP: u32 = 5;
/// Number of rungs on the ladder (25,30,...,80 = 12).
pub const LADDER_LEN: u32 = (MAX_FPS - MIN_FPS) / FPS_STEP + 1;

/// A frame "misses" when its cost exceeds this percent of the target period —
/// i.e. we insist on (100 - this)% = 5% headroom for the other tasks.
pub const HEADROOM_PCT: u32 = 95;

/// Frames per evaluation window. ~1 s at 30 fps: long enough that one stray
/// WiFi/BLE IRQ stealing a frame doesn't trigger a step, short enough to react
/// within a second.
pub const WINDOW_N: u32 = 30;

/// Default starting rung: 30 fps (the historical fixed rate). The controller
/// climbs from here when there is headroom, so a fresh effect never opens with
/// a visible stutter while it finds its ceiling.
pub const DEFAULT_FPS: u32 = 30;

/// FPS of ladder index `i` (0 = MIN_FPS). Saturates at the ceiling.
#[inline]
pub fn fps_at(idx: u32) -> u32 {
    let f = MIN_FPS + idx.min(LADDER_LEN - 1) * FPS_STEP;
    if f > MAX_FPS {
        MAX_FPS
    } else {
        f
    }
}

/// Ladder index whose rung is closest to `fps`, clamped to [MIN_FPS, MAX_FPS].
/// A user override that isn't exactly on the grid snaps to the nearest rung.
#[inline]
pub fn idx_for_fps(fps: u32) -> u32 {
    let clamped = fps.clamp(MIN_FPS, MAX_FPS);
    // Round to the nearest step rather than truncating.
    ((clamped - MIN_FPS) + FPS_STEP / 2) / FPS_STEP
}

/// Target-period in microseconds for `fps` (integer; 80 fps = 12_500 µs).
#[inline]
pub fn period_us(fps: u32) -> u32 {
    if fps == 0 {
        return 1_000_000;
    }
    1_000_000 / fps
}

/// The controller's decision after a frame: how long to sleep before the next
/// one, and whether the effect just became unrunnable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    /// Milliseconds to sleep before rendering the next frame (period − work),
    /// so the *interval* between frame starts tracks the target period. Always
    /// at least 1 ms so the render task yields.
    pub delay_ms: u32,
    /// The effect can't hold even the floor / pinned rung — the caller should
    /// park it and notify the app. Latched; read once via [`take_abort`].
    pub abort: bool,
}

/// Framerate autoscaler state. One instance drives the active effect; reset it
/// when the effect changes so a new program starts its own search.
#[derive(Clone, Copy, Debug)]
pub struct FpsController {
    /// Current ladder index (autoscaled, or held at the pinned rung).
    idx: u32,
    /// User-pinned target FPS (snapped to a rung), or 0 for autoscale.
    pinned_fps: u32,
    /// Frames counted in the current window.
    win_frames: u32,
    /// Frames in the current window that missed the headroom budget.
    win_missed: u32,
    /// Worst (largest) frame cost seen this window, in µs — gates step-up.
    win_max_cost_us: u32,
    /// Latched abort request, drained by [`take_abort`].
    abort: bool,
}

impl Default for FpsController {
    fn default() -> Self {
        Self::new()
    }
}

impl FpsController {
    pub const fn new() -> Self {
        FpsController {
            idx: (DEFAULT_FPS - MIN_FPS) / FPS_STEP,
            pinned_fps: 0,
            win_frames: 0,
            win_missed: 0,
            win_max_cost_us: 0,
            abort: false,
        }
    }

    /// Reset to a fresh search (new effect loaded / (de)activated). A user pin
    /// is preserved — the app's chosen rate should survive an effect reload —
    /// but the abort latch and window clear so the new program starts clean.
    pub fn reset(&mut self) {
        self.idx = if self.pinned_fps != 0 {
            idx_for_fps(self.pinned_fps)
        } else {
            (DEFAULT_FPS - MIN_FPS) / FPS_STEP
        };
        self.win_frames = 0;
        self.win_missed = 0;
        self.win_max_cost_us = 0;
        self.abort = false;
    }

    /// Current target FPS.
    pub fn current_fps(&self) -> u32 {
        fps_at(self.idx)
    }

    /// User-pinned FPS (0 = autoscale).
    pub fn pinned_fps(&self) -> u32 {
        self.pinned_fps
    }

    /// True while the app has pinned a fixed rate.
    pub fn is_pinned(&self) -> bool {
        self.pinned_fps != 0
    }

    /// Miss threshold: drop a rung when a window has *more than* this many
    /// missed frames. x/N = a quarter of the window (rounded down).
    pub fn miss_limit(&self) -> u32 {
        WINDOW_N / 4
    }

    /// Pin the target to `fps` (snapped to the ladder), or pass 0 to return to
    /// autoscale. Clears the window + abort latch so the new mode starts fresh;
    /// an autoscale hand-back keeps the current rung as its starting point.
    pub fn set_target(&mut self, fps: u32) {
        if fps == 0 {
            self.pinned_fps = 0;
        } else {
            let idx = idx_for_fps(fps);
            self.pinned_fps = fps_at(idx);
            self.idx = idx;
        }
        self.win_frames = 0;
        self.win_missed = 0;
        self.win_max_cost_us = 0;
        self.abort = false;
    }

    /// Account for one rendered frame whose measured cost (update + shade +
    /// show) was `cost_us`, and return the sleep + abort decision.
    ///
    /// The window drives the rung: on the N-th frame we drop if too many missed,
    /// or step up if the window was clean and the next rung would still fit. A
    /// floor/pinned failure latches an abort. The returned delay is period−work
    /// so the frame *interval* holds the target, not work+period.
    pub fn on_frame(&mut self, cost_us: u32) -> Decision {
        let fps = self.current_fps();
        let period = period_us(fps);
        let headroom_budget = headroom_budget_us(period);

        self.win_frames += 1;
        if cost_us > headroom_budget {
            self.win_missed += 1;
        }
        if cost_us > self.win_max_cost_us {
            self.win_max_cost_us = cost_us;
        }

        if self.win_frames >= WINDOW_N {
            self.evaluate_window();
        }

        // Sleep = period − work already spent this frame, so successive frame
        // starts land one period apart regardless of how long the frame took.
        // Clamp to ≥1 ms (yield) and round to whole ms (the render task's
        // vTaskDelay is ms-granular).
        let remaining_us = period.saturating_sub(cost_us);
        let delay_ms = ((remaining_us + 500) / 1000).max(1);

        Decision {
            delay_ms,
            abort: self.abort,
        }
    }

    /// Close the current window: decide whether to drop, hold, step up, or
    /// abort, then reset the window counters.
    fn evaluate_window(&mut self) {
        let missed = self.win_missed;
        let max_cost = self.win_max_cost_us;
        let over_limit = missed > self.miss_limit();

        if over_limit {
            // Too many missed frames at this rung.
            if self.idx == 0 || self.is_pinned() {
                // Already at the floor, or the app pinned this rate — the effect
                // cannot run within budget. Ask the caller to park + notify.
                self.abort = true;
            } else {
                // Back off one rung and try again.
                self.idx -= 1;
            }
        } else if !self.is_pinned() && missed == 0 && self.idx + 1 < LADDER_LEN {
            // Clean window and room to climb: step up only if the worst frame we
            // saw would still leave 5% headroom at the FASTER rung, so we don't
            // immediately bounce back down.
            let next_period = period_us(fps_at(self.idx + 1));
            if max_cost <= headroom_budget_us(next_period) {
                self.idx += 1;
            }
        }

        self.win_frames = 0;
        self.win_missed = 0;
        self.win_max_cost_us = 0;
    }

    /// Read and clear the abort latch. The render loop calls this each frame; on
    /// true it parks the effect and the network loop notifies the app.
    pub fn take_abort(&mut self) -> bool {
        let a = self.abort;
        self.abort = false;
        a
    }
}

/// The per-frame cost ceiling that still leaves the required headroom.
#[inline]
fn headroom_budget_us(period_us: u32) -> u32 {
    // period * HEADROOM_PCT / 100, computed in u64 to avoid overflow (period is
    // ≤ 1_000_000 for the 1-fps floor, so u32 would actually be fine, but keep
    // it robust).
    ((period_us as u64 * HEADROOM_PCT as u64) / 100) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    // Cost (µs) that lands exactly at the headroom budget for `fps` (the
    // largest cost that is NOT a miss), and one microsecond over it (a miss).
    fn budget(fps: u32) -> u32 {
        headroom_budget_us(period_us(fps))
    }
    fn just_missing(fps: u32) -> u32 {
        budget(fps) + 1
    }
    fn comfortable(_fps: u32) -> u32 {
        // Well under budget so even the faster rung's budget is satisfied.
        period_us(MAX_FPS) / 3
    }

    #[test]
    fn ladder_maps_indices_and_fps() {
        assert_eq!(LADDER_LEN, 12);
        assert_eq!(fps_at(0), 25);
        assert_eq!(fps_at(1), 30);
        assert_eq!(fps_at(11), 80);
        assert_eq!(fps_at(99), 80); // saturates
        assert_eq!(idx_for_fps(25), 0);
        assert_eq!(idx_for_fps(80), 11);
        assert_eq!(idx_for_fps(10), 0); // clamps up to the floor
        assert_eq!(idx_for_fps(200), 11); // clamps down to the ceiling
        assert_eq!(idx_for_fps(58), idx_for_fps(60)); // snaps to nearest rung
        assert_eq!(fps_at(idx_for_fps(58)), 60);
    }

    #[test]
    fn starts_at_default_rung() {
        let c = FpsController::new();
        assert_eq!(c.current_fps(), DEFAULT_FPS);
        assert!(!c.is_pinned());
    }

    #[test]
    fn holds_target_when_frames_are_cheap() {
        let mut c = FpsController::new();
        // Cheap enough for 30 but not for 35 (so it holds, doesn't climb).
        let cost = budget(30);
        for _ in 0..WINDOW_N {
            let d = c.on_frame(cost);
            assert!(!d.abort);
        }
        assert_eq!(c.current_fps(), 30);
    }

    #[test]
    fn climbs_when_there_is_headroom() {
        let mut c = FpsController::new();
        let cheap = comfortable(80);
        // Each clean window should bump one rung until it reaches the ceiling.
        for _ in 0..(LADDER_LEN * WINDOW_N) {
            c.on_frame(cheap);
        }
        assert_eq!(c.current_fps(), MAX_FPS);
    }

    #[test]
    fn does_not_climb_if_next_rung_would_miss() {
        let mut c = FpsController::new();
        // Fits 30's budget with zero misses, but exceeds 35's budget — so a
        // clean window must NOT step up (it would immediately drop back).
        let cost = budget(35) + 1; // a miss at 35, comfortable at 30
        assert!(cost <= budget(30));
        for _ in 0..(WINDOW_N * 3) {
            let d = c.on_frame(cost);
            assert!(!d.abort);
        }
        assert_eq!(c.current_fps(), 30);
    }

    #[test]
    fn drops_a_rung_when_too_many_missed() {
        let mut c = FpsController::new();
        c.set_target(0); // autoscale
        // Force it up to a high rung first with cheap frames.
        for _ in 0..(LADDER_LEN * WINDOW_N) {
            c.on_frame(comfortable(80));
        }
        assert_eq!(c.current_fps(), MAX_FPS);
        // Now every frame misses the top rung's budget -> it should step down.
        let start = c.current_fps();
        for _ in 0..WINDOW_N {
            c.on_frame(just_missing(start));
        }
        assert!(c.current_fps() < start);
    }

    #[test]
    fn tolerates_a_few_misses_under_the_limit() {
        let mut c = FpsController::new();
        // miss_limit misses in a window (not MORE than the limit) must NOT drop.
        let limit = c.miss_limit();
        for i in 0..WINDOW_N {
            let cost = if i < limit {
                just_missing(30)
            } else {
                budget(30)
            };
            c.on_frame(cost);
        }
        assert_eq!(c.current_fps(), 30);
    }

    #[test]
    fn aborts_at_the_floor() {
        let mut c = FpsController::new();
        // Drive it all the way down: every frame blows even 25 fps.
        let mut aborted = false;
        for _ in 0..(LADDER_LEN * WINDOW_N * 2) {
            let d = c.on_frame(period_us(MIN_FPS) * 2); // 2× the floor period
            if d.abort {
                aborted = true;
                break;
            }
        }
        assert!(aborted, "should abort once it can't hold 25 fps");
        assert_eq!(c.current_fps(), MIN_FPS);
        // take_abort drains the latch.
        c.abort = true;
        assert!(c.take_abort());
        assert!(!c.take_abort());
    }

    #[test]
    fn pinned_target_does_not_autoscale() {
        let mut c = FpsController::new();
        c.set_target(60);
        assert_eq!(c.current_fps(), 60);
        assert!(c.is_pinned());
        // Cheap frames: a free autoscaler would climb, a pin must stay at 60.
        for _ in 0..(WINDOW_N * 4) {
            let d = c.on_frame(comfortable(80));
            assert!(!d.abort);
        }
        assert_eq!(c.current_fps(), 60);
    }

    #[test]
    fn pinned_target_aborts_when_unachievable() {
        let mut c = FpsController::new();
        c.set_target(75);
        let mut aborted = false;
        for _ in 0..(WINDOW_N * 2) {
            let d = c.on_frame(just_missing(75));
            if d.abort {
                aborted = true;
                break;
            }
        }
        assert!(aborted, "a pinned rate it can't hit must abort, not drop");
        assert_eq!(c.current_fps(), 75); // stayed pinned, didn't step down
    }

    #[test]
    fn unpin_returns_to_autoscale_from_current_rung() {
        let mut c = FpsController::new();
        c.set_target(50);
        assert!(c.is_pinned());
        c.set_target(0);
        assert!(!c.is_pinned());
        assert_eq!(c.current_fps(), 50); // keeps the rung as the new start point
    }

    #[test]
    fn delay_is_period_minus_work() {
        let mut c = FpsController::new(); // 30 fps -> ~33_333 µs period
        let d = c.on_frame(10_000); // 10 ms of work
        // remaining ≈ 23_333 µs -> 23 ms.
        assert_eq!(d.delay_ms, 23);
        // A frame that eats the whole period still yields ≥1 ms.
        let d2 = c.on_frame(period_us(30) + 5_000);
        assert_eq!(d2.delay_ms, 1);
    }

    #[test]
    fn reset_preserves_pin_but_clears_window() {
        let mut c = FpsController::new();
        c.set_target(45);
        // Accumulate some misses, then reset.
        c.on_frame(just_missing(45));
        c.reset();
        assert_eq!(c.current_fps(), 45); // pin preserved
        assert!(c.is_pinned());
        assert!(!c.take_abort());
    }
}
