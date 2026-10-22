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
//! - **Ladder.** Targets live on a 5-fps grid from [`LADDER_MIN_FPS`] to
//!   [`MAX_FPS`] (5..80). Discrete steps make the cadence legible to the app and
//!   damp oscillation vs. a continuous controller.
//! - **5% headroom.** A frame is *missed* when its measured cost exceeds
//!   [`HEADROOM_PCT`]% of the current target's period — i.e. we want at least
//!   5% of every frame period left for the other threads.
//! - **x/N window.** Over a sliding window of [`WINDOW_N`] frames, if more than
//!   [`miss_limit`](FpsController::miss_limit) frames were missed, drop one
//!   rung. A clean window whose worst frame still fits the *next* rung's
//!   headroom budget steps up one rung.
//! - **Abort.** If we are already at the floor ([`MIN_FPS`] = 25 fps for a strip
//!   of up to 512 LEDs, proportionally lower for a longer one — see
//!   [`floor_fps_for`] — or a user-pinned target) and a window still fails, the
//!   effect can't run within budget:
//!   [`take_abort`](FpsController::take_abort) reports it so the caller parks
//!   the effect (freeing the CPU) and notifies the app.
//! - **Override.** The app can pin an exact target with [`set_target`]; the
//!   controller stops autoscaling and holds that rung. If the pinned rung keeps
//!   missing, it aborts (the user asked for a rate this effect can't hit).
//! - **Hold (no abort).** A benchmark / profiling client that must measure an
//!   effect whatever it costs (the HITL fx_bench sweep runs programs up to
//!   ~130 ms/frame) turns the abort off with [`set_abort_enabled`]: a failing
//!   floor/pinned window then just holds the rung.
//! - **Wire ceiling.** The WS2812 wire itself bounds the rate: 24 bits at
//!   ~833 kHz is [`WIRE_NS_PER_LED`] = 28.8 µs per LED, plus the latch low, on the
//!   LONGEST channel (the two channels clock out in parallel). The caller reports
//!   that floor with [`set_wire_us`](FpsController::set_wire_us); the ladder never
//!   climbs (and a pin never lands) above the highest rung whose headroom budget
//!   still holds one wire frame, and a frame that is slow ONLY because the wire is
//!   is not the effect's fault — it never counts toward an abort.
//! - **Minimum yield.** Even a frame that overran its period sleeps at least
//!   `cost / 19` (≥ 5% of the wall clock to the lower-priority network task),
//!   so an over-budget effect can't starve WiFi/TLS while the window decides.
//!
//! Pure, `no_std`, zero-dependency, integer-only (no hardware f64 on the C6) so
//! it unit-tests on the host and compiles unchanged for the device.

#![no_std]

/// The abort floor, in FPS, for a strip of up to [`FLOOR_REF_LEDS`] LEDs: below
/// it an effect is deemed unrunnable (abort). A longer strip's floor scales down
/// with its length ([`floor_fps_for`]) — shading 2048 LEDs at 10 fps is the same
/// per-LED throughput as 512 at 40 — so a big fixture runs heavy effects slower
/// instead of having them parked.
pub const MIN_FPS: u32 = 25;
/// Strip length the [`MIN_FPS`] floor is defined for (the LED cap before 1024
/// LEDs per channel): the floor holds 25 x 512 = 12,800 shaded LEDs/s.
pub const FLOOR_REF_LEDS: u32 = 512;
/// The ladder's bottom rung: the lowest floor a long strip can scale down to.
pub const LADDER_MIN_FPS: u32 = 5;
/// Above the ceiling there is nothing to gain from a faster strip write than
/// the eye resolves.
pub const MAX_FPS: u32 = 80;
/// Ladder step. Rungs are LADDER_MIN_FPS, LADDER_MIN_FPS+STEP, ..., MAX_FPS.
pub const FPS_STEP: u32 = 5;

/// The abort floor for a strip of `leds` shaded LEDs: [`MIN_FPS`] up to
/// [`FLOOR_REF_LEDS`], then the rung (rounded down) that keeps the same shaded
/// LEDs per second, never below [`LADDER_MIN_FPS`] (1024 LEDs -> 10 fps,
/// 2048 -> 5 fps).
#[inline]
pub fn floor_fps_for(leds: u32) -> u32 {
    if leds <= FLOOR_REF_LEDS {
        return MIN_FPS;
    }
    let f = (MIN_FPS * FLOOR_REF_LEDS) / leds;
    ((f / FPS_STEP) * FPS_STEP).max(LADDER_MIN_FPS)
}
/// WS2812 wire time per LED, in ns: 24 bits x 1.2 µs. Both C6 backends clock
/// each bit as three 400 ns samples (0.4/0.8 µs high, 1.2 µs period — inside the
/// WS2812 1.25 µs ± 600 ns window), so this is 28.8 µs, a hair under the
/// nominal 800 kHz's 30 µs.
pub const WIRE_NS_PER_LED: u32 = 28_800;
/// The latch (reset) low after a frame's last bit before the strip shows it:
/// WS2812B-V5 and later need >= 280 µs (the original WS2812 50 µs).
pub const LATCH_US: u32 = 300;
/// Measured transmit spans jitter a little over the ideal wire time (DMA
/// set-up, the transmit task's wake-up): a frame within this of the wire floor
/// is the wire's cost, not the effect's.
pub const WIRE_SLACK_US: u32 = 1_000;

/// Wire time of one frame whose longest channel carries `leds` LEDs (channels
/// clock out in parallel), including the latch. 0 LEDs = no wire floor.
#[inline]
pub fn wire_frame_us(leds: u32) -> u32 {
    if leds == 0 {
        0
    } else {
        ((leds as u64 * WIRE_NS_PER_LED as u64) / 1000) as u32 + LATCH_US
    }
}

/// Number of rungs on the ladder (5,10,...,80 = 16).
pub const LADDER_LEN: u32 = (MAX_FPS - LADDER_MIN_FPS) / FPS_STEP + 1;

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

/// FPS of ladder index `i` (0 = LADDER_MIN_FPS). Saturates at the ceiling.
#[inline]
pub fn fps_at(idx: u32) -> u32 {
    let f = LADDER_MIN_FPS + idx.min(LADDER_LEN - 1) * FPS_STEP;
    if f > MAX_FPS {
        MAX_FPS
    } else {
        f
    }
}

/// Ladder index whose rung is closest to `fps`, clamped to
/// [LADDER_MIN_FPS, MAX_FPS]. A user override that isn't exactly on the grid
/// snaps to the nearest rung.
#[inline]
pub fn idx_for_fps(fps: u32) -> u32 {
    let clamped = fps.clamp(LADDER_MIN_FPS, MAX_FPS);
    // Round to the nearest step rather than truncating.
    ((clamped - LADDER_MIN_FPS) + FPS_STEP / 2) / FPS_STEP
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
    /// False = never abort (hold the floor / pinned rung instead); for
    /// benchmark/profiling clients. Survives [`reset`](Self::reset), like a pin.
    abort_enabled: bool,
    /// The WS2812 wire floor of the frames being shown, in µs (0 = unknown /
    /// none): a hardware property of the strip lengths, so it survives reset.
    wire_us: u32,
    /// LEDs each frame shades (0 = unknown): sets the abort floor
    /// ([`floor_fps_for`]). Survives reset, like the wire floor.
    leds: u32,
}

impl Default for FpsController {
    fn default() -> Self {
        Self::new()
    }
}

impl FpsController {
    pub const fn new() -> Self {
        FpsController {
            idx: (DEFAULT_FPS - LADDER_MIN_FPS) / FPS_STEP,
            pinned_fps: 0,
            win_frames: 0,
            win_missed: 0,
            win_max_cost_us: 0,
            abort: false,
            abort_enabled: true,
            wire_us: 0,
            leds: 0,
        }
    }

    /// Reset to a fresh search (new effect loaded / (de)activated). A user pin
    /// is preserved — the app's chosen rate should survive an effect reload —
    /// but the abort latch and window clear so the new program starts clean.
    pub fn reset(&mut self) {
        self.idx = self.clamp_idx(if self.pinned_fps != 0 {
            idx_for_fps(self.pinned_fps)
        } else {
            (DEFAULT_FPS - LADDER_MIN_FPS) / FPS_STEP
        });
        self.win_frames = 0;
        self.win_missed = 0;
        self.win_max_cost_us = 0;
        self.abort = false;
    }

    /// Current target FPS.
    pub fn current_fps(&self) -> u32 {
        fps_at(self.idx)
    }

    /// Report the wire floor of the frames being shown ([`wire_frame_us`] of the
    /// longest channel). Cheap; the render loop calls it every frame. A rung
    /// above the new ceiling (a strip just grew) is clamped down immediately.
    pub fn set_wire_us(&mut self, us: u32) {
        if us == self.wire_us {
            return;
        }
        self.wire_us = us;
        let ceil = self.ceiling_idx();
        if self.is_pinned() {
            // A pin tracks the wire both ways: held at the ceiling while the strip
            // is too long for it, back on the asked rung once it isn't.
            self.idx = self.clamp_idx(idx_for_fps(self.pinned_fps));
        } else if self.idx > ceil {
            self.idx = ceil;
        }
    }

    /// Report how many LEDs each frame shades: a strip past [`FLOOR_REF_LEDS`]
    /// lowers the abort floor ([`floor_fps_for`]), so its heavy effects step down
    /// to a slower rung instead of being parked. A rung below a risen floor (the
    /// strip got shorter) is lifted to it.
    pub fn set_leds(&mut self, leds: u32) {
        if leds == self.leds {
            return;
        }
        self.leds = leds;
        if self.is_pinned() {
            self.idx = self.clamp_idx(idx_for_fps(self.pinned_fps));
        } else {
            let lift = self.floor_idx().min(self.ceiling_idx());
            if self.idx < lift {
                self.idx = lift;
            }
        }
    }

    /// The abort floor for the reported strip ([`MIN_FPS`] until one is).
    pub fn min_fps(&self) -> u32 {
        floor_fps_for(self.leds)
    }

    /// `i` held to [floor, ceiling]; the wire ceiling wins when it is the lower.
    fn clamp_idx(&self, i: u32) -> u32 {
        i.max(self.floor_idx()).min(self.ceiling_idx())
    }

    /// Ladder index of [`min_fps`](Self::min_fps).
    fn floor_idx(&self) -> u32 {
        idx_for_fps(self.min_fps())
    }

    /// The wire floor last reported via [`set_wire_us`](Self::set_wire_us).
    pub fn wire_us(&self) -> u32 {
        self.wire_us
    }

    /// The highest ladder index the wire allows: the fastest rung whose headroom
    /// budget still fits one wire frame (the floor when even it doesn't — the
    /// wire then sets the rate and the effect isn't blamed for it).
    pub fn ceiling_idx(&self) -> u32 {
        let mut i = LADDER_LEN - 1;
        while i > 0 && headroom_budget_us(period_us(fps_at(i))) < self.wire_us {
            i -= 1;
        }
        i
    }

    /// The fastest rate this strip's wire allows ([`MAX_FPS`] when unbounded).
    pub fn max_fps(&self) -> u32 {
        fps_at(self.ceiling_idx())
    }

    /// True when the wire alone can't fit even the current rung's budget.
    fn wire_bound(&self) -> bool {
        self.wire_us > headroom_budget_us(period_us(self.current_fps()))
    }

    /// User-pinned FPS (0 = autoscale).
    pub fn pinned_fps(&self) -> u32 {
        self.pinned_fps
    }

    /// True while the app has pinned a fixed rate.
    pub fn is_pinned(&self) -> bool {
        self.pinned_fps != 0
    }

    /// Whether a failing floor/pinned window aborts (true, the default) or holds.
    pub fn abort_enabled(&self) -> bool {
        self.abort_enabled
    }

    /// Enable (default) or disable the abort. Disabling also drops a pending
    /// latch so a hold request can't be followed by a stale abort.
    pub fn set_abort_enabled(&mut self, enabled: bool) {
        self.abort_enabled = enabled;
        if !enabled {
            self.abort = false;
        }
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
            // A pin above the wire ceiling runs at the ceiling (no strip can be
            // driven faster than its wire), one below the floor at the floor; the
            // pin itself is kept as asked.
            self.idx = self.clamp_idx(idx);
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
        // A frame no slower than the wire floor is the wire's cost: only when the
        // wire alone overruns this rung (the ceiling is the floor rung) does that
        // matter, and then it isn't a miss — the effect can't fix the wire.
        let miss_over = if self.wire_bound() {
            headroom_budget.max(self.wire_us.saturating_add(WIRE_SLACK_US))
        } else {
            headroom_budget
        };
        if cost_us > miss_over {
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
        // Round to whole ms (the render task's vTaskDelay is ms-granular) and
        // never sleep less than the minimum yield (≥1 ms, and ≥5% of the wall
        // clock for an overrunning frame — see min_yield_ms).
        let remaining_us = period.saturating_sub(cost_us);
        let delay_ms = ((remaining_us + 500) / 1000).max(min_yield_ms(cost_us));

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
            if self.idx <= self.floor_idx() || self.is_pinned() {
                // Already at the floor, or the app pinned this rate — the effect
                // cannot run within budget. Ask the caller to park + notify
                // (unless a benchmark asked us to hold instead).
                if self.abort_enabled {
                    self.abort = true;
                }
            } else {
                // Back off one rung and try again.
                self.idx -= 1;
            }
        } else if !self.is_pinned() && missed == 0 && self.idx + 1 <= self.ceiling_idx() {
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

/// The shortest sleep after a frame that cost `cost_us`: at least 1 ms, and at
/// least `cost × (100 − HEADROOM_PCT) / HEADROOM_PCT` (rounded up) so the render
/// task — which outranks the network task — always cedes ≥ 5% of the wall clock,
/// even on a frame that blew through its period (an over-budget effect the window
/// hasn't stepped down / aborted yet, or a held benchmark program).
#[inline]
pub fn min_yield_ms(cost_us: u32) -> u32 {
    let free_us = (cost_us as u64 * (100 - HEADROOM_PCT) as u64).div_ceil(HEADROOM_PCT as u64);
    (free_us.div_ceil(1000) as u32).max(1)
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
        assert_eq!(LADDER_LEN, 16);
        assert_eq!(fps_at(0), 5);
        assert_eq!(fps_at(4), 25);
        assert_eq!(fps_at(5), 30);
        assert_eq!(fps_at(15), 80);
        assert_eq!(fps_at(99), 80); // saturates
        assert_eq!(idx_for_fps(5), 0);
        assert_eq!(idx_for_fps(25), 4);
        assert_eq!(idx_for_fps(80), 15);
        assert_eq!(idx_for_fps(1), 0); // clamps up to the ladder bottom
        assert_eq!(idx_for_fps(200), 15); // clamps down to the ceiling
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
        // A frame that eats the whole period still yields ≥5% of the wall clock:
        // 38.3 ms of work -> ceil(38.3 × 5/95) = 3 ms (not 1).
        let d2 = c.on_frame(period_us(30) + 5_000);
        assert_eq!(d2.delay_ms, 3);
    }

    #[test]
    fn min_yield_keeps_five_percent_for_the_network() {
        assert_eq!(min_yield_ms(0), 1);
        assert_eq!(min_yield_ms(10_000), 1); // 0.53 ms -> 1 ms floor
        assert_eq!(min_yield_ms(130_000), 7); // the heaviest fx_bench program
        for cost in [1_000u32, 33_000, 40_000, 130_000, 1_000_000] {
            let y = min_yield_ms(cost) * 1000;
            assert!(y * 100 >= (cost + y) * (100 - HEADROOM_PCT), "{cost}: yield {y} µs < 5%");
        }
        // An in-budget frame's period−work sleep already exceeds it.
        let mut c = FpsController::new();
        assert_eq!(c.on_frame(budget(30)).delay_ms, 2);
    }

    #[test]
    fn hold_mode_never_aborts_and_survives_reset() {
        let mut c = FpsController::new();
        c.set_abort_enabled(false);
        for _ in 0..(LADDER_LEN * WINDOW_N * 3) {
            assert!(!c.on_frame(period_us(MIN_FPS) * 3).abort);
        }
        assert_eq!(c.current_fps(), MIN_FPS, "still steps down to the floor, then holds");
        c.reset();
        assert!(!c.abort_enabled(), "hold survives an effect reload");
        c.set_target(60);
        for _ in 0..(WINDOW_N * 3) {
            assert!(!c.on_frame(just_missing(60)).abort);
        }
        assert_eq!(c.current_fps(), 60, "a held pin neither aborts nor steps down");
        c.set_abort_enabled(true);
        let mut aborted = false;
        for _ in 0..WINDOW_N {
            aborted |= c.on_frame(just_missing(60)).abort;
        }
        assert!(aborted, "re-enabled: the pinned rate it can't hold aborts");
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

    // -- wire ceiling (WS2812: 28.8 µs/LED on the longest channel) -------------

    #[test]
    fn wire_frame_time_is_30us_per_led_plus_latch() {
        assert_eq!(wire_frame_us(0), 0);
        assert_eq!(wire_frame_us(1), 28 + LATCH_US);
        assert_eq!(wire_frame_us(512), 14_745 + LATCH_US);
        assert_eq!(wire_frame_us(1024), 29_491 + LATCH_US);
    }

    #[test]
    fn ceiling_is_the_fastest_rung_one_wire_frame_fits() {
        let mut c = FpsController::new();
        assert_eq!(c.max_fps(), MAX_FPS, "no wire floor reported = unbounded");
        // The documented floor table (docs/user-guide.md "Hardware limits").
        for (leds, fps) in [
            (150, 80),
            (300, 80),
            (400, 80),
            (450, 70),
            (512, 60),
            (600, 50),
            (768, 40),
            (900, 35),
            (1024, 30),
        ] {
            c.set_wire_us(wire_frame_us(leds));
            assert_eq!(c.max_fps(), fps, "{leds} LEDs");
            // ...and the rung above really wouldn't fit one wire frame.
            if fps < MAX_FPS {
                assert!(headroom_budget_us(period_us(fps + FPS_STEP)) < wire_frame_us(leds));
            }
        }
    }

    #[test]
    fn never_climbs_above_the_wire_ceiling() {
        let mut c = FpsController::new();
        // 29.8 ms -> 30 fps ceiling.
        c.set_wire_us(wire_frame_us(1024));
        // A trivially cheap effect: the CPU alone would climb to MAX_FPS.
        for _ in 0..(WINDOW_N * 20) {
            c.on_frame(500);
        }
        assert_eq!(c.current_fps(), 30);
    }

    #[test]
    fn a_growing_strip_clamps_the_rung_at_once() {
        let mut c = FpsController::new();
        for _ in 0..(WINDOW_N * 20) {
            c.on_frame(500);
        }
        assert_eq!(c.current_fps(), MAX_FPS);
        c.set_wire_us(wire_frame_us(768));
        assert_eq!(
            c.current_fps(),
            40,
            "clamped on the report, not a window later"
        );
        c.set_wire_us(wire_frame_us(100));
        assert_eq!(
            c.current_fps(),
            40,
            "a shrink doesn't jump; the window climbs"
        );
    }

    #[test]
    fn a_pin_above_the_ceiling_runs_at_the_ceiling_without_aborting() {
        let mut c = FpsController::new();
        c.set_wire_us(wire_frame_us(1024));
        c.set_target(60);
        assert_eq!(c.pinned_fps(), 60, "the pin is kept as asked");
        assert_eq!(c.current_fps(), 30, "but runs at the wire ceiling");
        // Frames cost what the wire costs: never an abort.
        for _ in 0..(WINDOW_N * 4) {
            assert!(!c.on_frame(wire_frame_us(1024) + 200).abort);
        }
        assert_eq!(c.current_fps(), 30);
        // The strip gets shorter: the pin is honoured again.
        c.set_wire_us(wire_frame_us(256));
        assert_eq!(c.current_fps(), 60);
    }

    #[test]
    fn the_abort_floor_scales_down_with_the_strip() {
        assert_eq!(floor_fps_for(0), MIN_FPS);
        assert_eq!(floor_fps_for(512), MIN_FPS);
        assert_eq!(floor_fps_for(600), 20);
        assert_eq!(floor_fps_for(1024), 10);
        assert_eq!(floor_fps_for(2048), LADDER_MIN_FPS);
        assert_eq!(floor_fps_for(100_000), LADDER_MIN_FPS);
    }

    #[test]
    fn a_heavy_effect_on_a_long_strip_slows_down_instead_of_aborting() {
        // 2048 LEDs at ~3.6k cycles each (a plasma) = ~46 ms of shading: under
        // the 25 fps floor (38 ms budget) a 512-LED strip would park it.
        let mut c = FpsController::new();
        c.set_wire_us(wire_frame_us(1024)); // two parallel 1024-LED channels
        c.set_leds(2048);
        assert_eq!(c.min_fps(), 5);
        let cost = 46_000;
        for _ in 0..(WINDOW_N * 12) {
            assert!(!c.on_frame(cost).abort, "a long strip's floor is lower");
        }
        assert_eq!(c.current_fps(), 20, "the fastest rung that fits 46 ms");
        // The same cost on a reference-length strip is over its floor: abort.
        let mut c = FpsController::new();
        c.set_leds(512);
        let mut aborted = false;
        for _ in 0..(WINDOW_N * 12) {
            aborted |= c.on_frame(cost).abort;
        }
        assert!(aborted);
    }

    #[test]
    fn a_shorter_strip_lifts_the_rung_to_its_floor() {
        let mut c = FpsController::new();
        c.set_leds(2048);
        for _ in 0..(WINDOW_N * 12) {
            c.on_frame(120_000); // ~8 fps of work
        }
        assert_eq!(c.current_fps(), 5);
        c.set_leds(256);
        assert_eq!(c.current_fps(), MIN_FPS, "back on the short strip's floor");
    }

    #[test]
    fn a_wire_bound_floor_blames_the_effect_only_beyond_the_wire() {
        let mut c = FpsController::new();
        // A wire longer than even the 25-fps budget (38 ms) under the reference
        // floor (no strip length reported, so the floor stays 25 fps): the wire
        // ceiling (40.6 ms fits 20 fps) wins over the floor.
        let wire = wire_frame_us(1400);
        c.set_wire_us(wire);
        assert_eq!(c.min_fps(), MIN_FPS);
        assert_eq!(c.current_fps(), 20);
        for _ in 0..(WINDOW_N * 4) {
            assert!(
                !c.on_frame(wire + 300).abort,
                "the wire's own cost never aborts"
            );
        }
        let mut aborted = false;
        for _ in 0..WINDOW_N {
            aborted |= c.on_frame(wire + 10 * WIRE_SLACK_US).abort;
        }
        assert!(
            aborted,
            "an effect slower than the wire still aborts at the floor"
        );
    }

    #[test]
    fn reset_keeps_the_wire_ceiling() {
        let mut c = FpsController::new();
        c.set_wire_us(wire_frame_us(1024));
        c.reset();
        assert_eq!(c.wire_us(), wire_frame_us(1024));
        assert_eq!(c.current_fps(), 30);
    }
}
