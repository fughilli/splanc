# A synced show: ~10 fixtures in step for hours

Status: drift correction (bridge), shared-time `dt` (firmware) and scheduled
changes (`apply_at`, C6/P4 firmware + bridge) implemented; the Pi/host player has
the time base but doesn't schedule changes yet; the HITL long-run measurement is
planned (below).

## Goal

A live poetry reading. A speech recogniser turns the reader's voice into text; a
fast LLM scores each phrase semantically (mood, intensity, imagery) and the agent
bridge turns the scores into uniform changes (`set_uniforms`, `ramp_uniforms`,
`crossfade_to`, `set_brightness`) on about ten fixtures (ESP32-C6 and P4 players)
in one room. Every fixture runs the same effect or complementary ones, and the room
must read as ONE light: a pulse that crosses the room, a hue that shifts on every
fixture at once. That has to hold for the whole show — hours — with the bridge,
the Wi-Fi and the players' crystals all imperfect.

## Sync budget

| Effect | Visible skew |
|---|---|
| Slow washes, breathing (≥ 2 s periods) | ~50 ms |
| Chases and pulses travelling across fixtures | ~20 ms |
| Fast strobes, beat-locked flashes | < 10 ms |

**Target: < 10 ms between any two fixtures, all show long**, so the fast effects
are safe. The shares of that budget:

| Source | Bound | Notes |
|---|---|---|
| Clock-offset estimate | ≈ min-RTT / 2 per player (3-10 ms on a quiet C6 link) | time_sync min-RTT; asymmetry is invisible to it |
| Drift between corrections | ≤ `maxStepMs` (2 ms) once locked | the discipline below |
| Render phase (frames not phase-locked) | up to one frame (16-33 ms) | **gap**, see below |
| Uniform-change arrival | Wi-Fi delivery spread (5-100 ms) | fixed by scheduled changes (`apply_at`) |

The render phase is the biggest term left: two players at 30 fps sample the same
effect time up to 33 ms apart. A shared *time* makes each frame show the right
picture for when it is drawn; it does not make the frames coincide.

## Clock sync and drift correction

**Once (existing, #3 of [agent-multi-fixture.md](agent-multi-fixture.md)).**
`align_time` (and every multi-player deploy / crossfade) estimates each player's
clock offset with TimeSyncPing/Pong (min-RTT of several rounds), picks ONE room
epoch on the bridge's monotonic clock and gives each player that epoch in its own
clock (`SetTimeBase`). The firmware renders `time = (now - epoch) / 1000`.

**Then nothing corrected drift.** Device crystals differ by tens of ppm (±40 ppm is
normal for the C6's 40 MHz crystal): 0.1-0.3 s apart per hour.

**The discipline (agent/src/timesync.ts, `TimeDiscipline`).** Every player that
took a time base is adopted by the hub's discipline and, from then on:

- **Re-sampled every 30 s** (4 ping rounds, min-RTT; `intervalMs`), every 5 s while
  a slew is still under way (`slewIntervalMs`). The pings are the session's traffic:
  they count as signs of life for the heartbeat (liveness.ts), so a disciplined
  session doesn't also need its idle heartbeat. They are *quiet*: serialized with
  tool calls but not counted as activity, so they never keep an idle session open
  against the phone app (#444).
- **Fitted** (`DriftEstimator`): weighted least squares of offset over hub time on
  the last 10 minutes (≤ 24 samples), weights 1/rtt². A sample whose round trip is
  above 1.5 × the window's best + 2 ms is kept but not fitted (a retransmit makes
  its offset wrong by up to rtt/2). The drift rate is only fitted once samples
  span ≥ 60 s, and clamped to ±500 ppm. A sample off the line by more than its
  round trip can explain (> 50 ms beyond rtt/2 + the fit's uncertainty) is a clock
  **discontinuity** — a reboot, a reconnect to a re-flashed player, the firmware's
  own millis() step guard (`lm_clock_observe`) — and restarts the model.
- **Corrected by slewing**: the wanted epoch is `room epoch + predicted offset`;
  the error is `applied - wanted`. Below 1 ms (`deadbandMs`; epochs are integer
  ms): nothing. Up to 50 ms: move the epoch by at most **2 ms** per correction
  (`maxStepMs`) with a plain `SetTimeBase`. Each such step is a 1-2 ms step of
  effect time — invisible — and at one step per 5 s the slew absorbs up to 400 ppm.
  Above 50 ms (`realignMs`) or after a discontinuity: **re-align at once** (one
  `SetTimeBase` to the wanted epoch; a reboot has lost the time base anyway).

The protocol has no "adjust the epoch smoothly" message, and it doesn't need one:
firmware `shift_time_base(delta)` is internal (only the clock-step guard calls it),
and `SetTimeBase` with an epoch 1-2 ms off the last is exactly that shift. Each
`SetTimeBase` costs one small message (and a welcome back); in lock that is one
per player per 30 s at most.

**What the bridge reports.** `align_time`'s result carries `drift` and the new
read-only `time_sync_status` tool (also offered to the stage agent) returns, per
player: `offset_ms`, `drift_ppm`, `error_ms` (applied - wanted epoch now, with the
model's drift since the last correction), `uncertainty_ms` (best rtt/2 + fit
residual), `samples`, `last_sample_age_s`, `last_correction` (`slew` / `realign`,
step, error, age), counts of slews / re-aligns / failed samples; and
`skew_bound_ms`, the worst pair: the sum of the two largest `|error| +
uncertainty`. `align_time` also uses a fresh model's offset instead of a new
one-shot sync (`clockFor`), so re-aligns (crossfade_to onto the shared epoch) don't
reintroduce a single noisy sample's error.

The simulation in agent/tests/timesync.test.ts runs ten players at -80..+75 ppm
through exponential Wi-Fi jitter with 5 % retransmit spikes for three hours: worst
error stays < 10 ms (the same show uncorrected is > 200 ms apart after one hour),
every correction is ≤ 2 ms, the fitted rates are within 5 ppm, and a reboot
re-aligns within one interval without moving anyone else.

**Limits of the discipline.**

- A released session (idle > 45 s with no call, #444) isn't sampled: the bridge
  never reopens a socket just to sync. During a show something is always sent
  (uniform changes, a live show lock, an attached app); after a long silence the
  first samples slew the accumulated error out (50 ppm × 5 min = 15 ms: ~40 s at
  2 ms / 5 s), or re-align when it is beyond 50 ms.
- Path asymmetry (an AP that buffers one direction) biases a player's offset by up
  to rtt/2 and no ping can see it; the HITL measurement below is the check.

## Stateful effects

`time` is shared, but an effect that keeps state in `update()` integrates `dt`:

```glsl
state float ph;
void update() { ph = fract(ph + dt * speed); }   // the skill's recommended form
```

`dt` used to be the local frame period (millis() deltas, main.cpp). Two players on
one epoch then integrate their own crystals (the same tens of ppm the epoch was
meant to cancel), and the drift corrections move `time` but never `ph`: the
phases walk apart exactly as unsynced `time` used to. And with `fixed(dt)` (the
fast path on the C6) every frame's dt is truncated to Q16.16, losing ~0.5 tick
(8 µs) per frame — ~1 s/hour at 30 fps, a different amount at each player's frame
rate.

**Fix (firmware, minimal): `dt` derives from the shared time base.** When a time
base is set, main.cpp now asks `lm_fx_clock(now, wall_dt, &time, &dt)`
(firmware/player_app/ffi.rs, `time_base_frame`) instead of computing `time` alone:

- `time = (now - epoch) / 1000`, held at 0 before the epoch — unchanged;
- `dt = (now - epoch) - (previous frame's now - epoch)`, i.e. the change of the
  *shared* time, so `Σ dt` over the show is the elapsed shared time on every player
  — including the bridge's 1-2 ms slew steps, which move integrated phases exactly
  as they move `time`;
- dt is a whole number of Q16.16 ticks (difference of the shared time's tick
  counts), so `dt` and the VM's `dt_fix` mirror are both exact and both telescope:
  `fixed(dt)` integrators no longer leak per frame;
- held at 0 before the epoch (so an epoch set slightly in the future starts every
  player's integration at the same instant); 0 on a step back (an epoch moved later
  by more than a frame: integrators hold instead of rewinding); the wall frame
  period on a jump forward beyond the frame + 250 ms (a re-align onto an older
  epoch must not fast-forward an exponential smoother by an hour).

What it changes: only frames rendered while a time base is set, and only `dt` (the
frame-period statistics, the autoscaler, the debugger's step keep the wall
period). Single-fixture use (no time base) is untouched.

**What it does not do alone.** Integrated state matches only if every player starts
integrating at the same shared instant and sees every uniform change (`speed`) at
the same shared instant. The first holds for players that loaded the effect before
one epoch; an effect deployed while the epoch is already running starts on each
player when its upload lands (a constant offset of `speed × arrival skew`, no
longer growing). Both need scheduled changes — the section below.

## Scheduled changes (apply_at)

A control change sent to N players applies on arrival, so a room changes spread
over each player's Wi-Fi latency (tens of ms, more under load). With the shared
time base (`set_time_base`, `agent/src/hub.ts` `alignTime`) every player already
agrees on effect time; `apply_at_ms` uses the same clock for the change itself.

**Protocol.** `SetUniforms`, `SetEffect`, `SetCrossfade` and `SetBrightness` carry
`optional uint32 apply_at_ms`: ms on the time base (effect time, like
`SetTexture.present_at_ms`). Firmware advertises `apply_at`. Unset, no time base,
already due, or more than 10 s ahead (a stale epoch) means apply on arrival,
today's behaviour. The reply goes out on arrival (it shows the state before the
change); persistence flags are recorded on arrival too.

**Firmware.** `lm_player_handle` holds a scheduled frame, as raw bytes, in
`SCHED` (`firmware/player/src/apply_queue.rs`: 8 frames sharing 512 B on the C6,
16 / 2 KB on the P4). The render task calls `lm_sched_apply(millis())` at the top
of every frame, under the player mutex, before anything reads the effect, the
crossfade or the brightness. Every frame due by then is applied in due order (ties
keep arrival order), through the same apply code as the immediate path. Nothing is
dropped, unlike video frames: a late change applies on arrival. When the queue is
full, its earliest frame is applied early to make room. A device-clock step moves
the queue with the time base (`lm_clock_observe`). A scheduled live move
(`seq` + `commit:false`) skips the unlocked live mailbox and is queued like the
rest; it is still acked on arrival.

**Bridge.** `set_uniforms`, `ramp_uniforms`, `set_effect`, `crossfade_to` and
`set_brightness` take `lead_ms`. By default the lead is 150 ms when several players
are targeted and all of them have `apply_at`. Otherwise changes apply on arrival,
and the result says which players caused that. An explicit lead schedules every
player that can take it and names the others. `0` means on arrival. The hub picks
one instant `at` on its own clock and gives each player
`apply_at = at - epoch`, where `epoch` is the room epoch `alignTime` gave that
player. The player's clock offset is already folded into its epoch, so the
instant is the same everywhere. If a capable target has no epoch yet, the hub
aligns first, re-using the epoch the others share so running effects don't jump.
Ramps and crossfades run on one shared timeline: step *i* is scheduled for
`at + i·step`, sent a lead ahead, and paced on the player's ack. A player that
falls behind skips steps instead of drifting late. The final committed set or
landing position is scheduled too. Residual skew is the time-base skew (half the
clock-sync round trips) plus at most one render frame.

## Gaps not covered yet

- **Pi player_rs and the host player don't schedule changes yet.** They follow the
  shared time base (#498, with `--output-latency-ms` for DDP/WLED latency) but
  don't advertise `apply_at`, so the bridge sends them changes on arrival.
- **Render frames are not phase-locked.** Each player renders on its own frame
  clock, so two players sample the shared time up to one frame apart (33 ms at
  30 fps). For strobes this is the dominant error. A fix would align frame starts
  to the shared time (render when `(now - epoch) mod period ≈ 0`, a PLL on the
  frame timer); not attempted here.
- **float32 effect time loses precision.** `time` is f32 seconds: its resolution is
  0.24 ms at 1 h, 1 ms from 2.3 h, 2 ms from 4.6 h, 8 ms at 1.5 days. Effects that use `time`
  directly (`sin(time * 30)`) get visibly coarser after a day of uptime on one
  epoch. Re-aligning to a new epoch between sets (crossfade with a fresh epoch)
  resets it; a real fix is a wrapped time or an f64/Q32.32 time mirror.
- **millis() is 32-bit**: the device clock wraps after 49.7 days; the epoch math
  (int64 from a u32 now) breaks across the wrap.
- **Asymmetric Wi-Fi paths** bias the offset estimate (see Limits above).
- **Released sessions** aren't disciplined (see Limits above).

## Test plan

**Unit (done).**

- agent/tests/timesync.test.ts: the estimator (rate fit through jitter, retransmit
  outliers, discontinuity reset, rate clamp) and the discipline on simulated clocks:
  ten players for three hours with ppm drift and heavy-tailed RTT (worst < 10 ms,
  every step ≤ 2 ms); the uncorrected control (> 200 ms); a mid-show reboot
  (re-aligned within one interval, others untouched); a 30 ms error slewed in
  ≤ 2 ms steps; a 400 ms error re-aligned in one; a silent player retried.
- firmware/player_app/tests/shared_dt.rs: `time_base_frame` (held before the epoch,
  slew-step dts, re-align clamps, dt in whole Q16.16 ticks summing exactly to the
  elapsed shared time where truncation loses thousands of ticks), three simulated
  players with different crystals and frame cadences integrating `phase += dt` for
  an hour (in step to < 6 ms vs > 200 ms with local dt), and the C ABI path
  (SetTimeBase → lm_fx_clock → lm_fx_update) integrating `phase` equal to `time`
  through an epoch nudge.

**HITL (planned).** Extend `pi/hitl/harness/hitl_time_base_skew.py` (today: two
analyzer-tapped DUTs, one capture, `timeBaseClock.fx` binary clock) into a long run:

1. Hold every analyzer-tapped DUT the rigs allow (two per rig today; more needs a
   wider analyzer tap), flash the build under test, load the binary-clock effect
   and a **stateful** twin (`ph = fract(ph + fixed(dt) * speed)` shown as the bit
   clock) on alternate LEDs.
2. Align once through the bridge's hub (not the harness's own sync), then let the
   discipline run.
3. Every 5 minutes for ≥ 3 hours, one analyzer capture of all taps: per DUT the
   wire-time minus effect-time offset (time_base_skew_core), for both the `time`
   clock and the integrated one; record `time_sync_status` alongside.
4. Pass: p99 pairwise skew of both clocks < 10 ms + one frame period at every
   capture, no growth over the run, every reported `skew_bound_ms` ≥ the measured
   skew. Mid-run, reset one DUT and check it is back within budget after one
   interval while the others' captures don't move.
5. Control run with the discipline off (`drift: false`): the skew grows ~ppm × t.

Cross-rig DUTs share no analyzer clock, so a ten-player run needs either one rig
with a wider tap or a common reference (a photodiode or GPIO pulse captured on both
analyzers).
