# Wall clock (software RTC, time zone, time from the app and the bridge)

Status: PR-2 of the real-time effects plan (desk D-559), plus the `clock*` effect
uniforms (PR-3). The clock is set from the app and the bridge; SNTP on the device,
a hardware RTC and schedules come in later PRs.

## What the lamp keeps

- **UTC on a software RTC**: `//firmware/clock`'s `WallClock` on `esp_timer` µs
  (`firmware/player_app/clock_ffi.rs`). Sources make offers with an error bound that
  grows with age at the crystal's rate; the clock keeps the lowest current error,
  steps corrections over 1 s and slews smaller ones (≤ 500 ppm), and fits the
  crystal's rate from successive samples.
- **A time zone as a POSIX TZ rule** (D-562), e.g. `CET-1CEST,M3.5.0,M10.5.0/3`,
  plus the IANA name for display. Persisted in NVS (`clk_tz`) on change only. A
  rule keeps DST right for years with no network.
- **Effect time never moves with it.** `time` / `dt` stay on the show epoch.

## Sources in this PR

| Source | How | Error |
|---|---|---|
| App push | `set_wall_clock{pushed_by: APP}` on every connect (wss and BLE), 2.5 s after the welcome | min-RTT/2 of 6 `time_sync_ping` rounds + 20 ms (the phone against UTC) |
| Bridge push | `set_wall_clock{pushed_by: BRIDGE}` on every session connect, from the host's clock and `/etc/localtime` | the same |
| Manual | the app's "Set from this phone", MCP `set_clock{time}`: replaces even a more certain time | as given |
| Soft-reset carry-over | the `CarryRecord` in RTC no-init RAM, rewritten at 20 Hz, restored after SW / panic / watchdog resets | the carried error + 1 s |

`set_wall_clock` carries `unix_ms` that was true at `at_device_ms` (the
`TimeSyncPong` device-ms domain), exactly like `set_time_base`, so the push is as
good as the sync. A later, worse push does not move the clock (`NOT_BETTER`).

## Rules

- **Who may set it (D-569).** Owners, the bridge, SNTP and an RTC always. A locked
  kiosk session (a visitor) only while the clock is unset, and its zone only while
  none is set. Both arms are Read-class at the kiosk gate; `clock_ffi.rs` enforces
  the rest and answers `last_set = LOCKED`.
- **Power loss (D-568).** Without a hardware RTC the clock is invalid after a cold
  boot until a source returns. A soft reset keeps it.
- **esp_timer step-backs.** The C6's esp_timer has been seen stepping back by whole
  multiples of 2^24 systimer ticks. The clock reads esp_timer through its own
  `StepGuard` on every read and on every loop pass, so the wall clock stays
  continuous (reported as `mono_jumps`).
- **Off the render path.** Every clock entry point runs on the loop task (the
  handlers, and `lm_clock_tick` under a try-lock of the player mutex). Render
  never touches the clock; the carry record is a 28-byte RAM write.

## P4 + C6 split: the P4 owns the clock

The P4 renders and owns the show epoch (`p4-c6-split.md` §2.1), so it owns wall
time too: the same `clock_ffi.rs` runs in the P4 image, and its RTC no-init RAM
carries the time over the P4's soft resets. The C6 front end forwards
`set_wall_clock` / `get_clock` like any player arm. When SNTP lands on the C6
(PR-4) the front end becomes a source: it forwards a `set_wall_clock` with
`pushed_by = FRONTEND` over the link, whose latency is well under 1 ms.

## Protocol

`set_wall_clock` (C 111), `get_clock` (C 112) → `clock_state` (S 61); C 110 and S 60 are taken by the open OSC-over-wss PR; feature
`wall_clock`. `clock_state` reports validity, the reading (`unix_ms` at
`device_ms`), the source and who pushed it, the error and its age, the drift fit,
the zone (rule, name, current offset and abbreviation), counters, and the result
of the set it answers.

## Effect uniforms (PR-3)

Effects read the lamp's LOCAL time through the uniform pool (`uniform_pool.rs`
`CLOCK_ENTRIES`), bound BY NAME like `imu_*`: no compiler, VM or `.fxb` change,
and an unbound effect pays nothing new (the per-frame `ANY_BOUND` check is the
one it already had).

| Uniform | Type | Value |
|---|---|---|
| `clock` | `vec4` | (hour 0-23, minute 0-59, second 0-59.999, weekday 0-6, Sunday = 0) |
| `clock_day` | `float` | local seconds since midnight / 86400, 0..1 |
| `clock_date` | `vec3` | (year, month 1-12, day 1-31) |
| `clock_valid` | `float` | 1 while the clock is set, else 0 |

- **Render never reads the clock.** The loop task (`lm_clock_tick`, under the
  player mutex) caches the local time of day at a raw esp_timer anchor plus the
  date, every 250 ms and on every accepted time or zone change, only while some
  deck binds a `clock*` uniform (and once at bind, so the first frame is right).
  Render extrapolates from the anchor with one esp_timer read, wraps the time of
  day (and the weekday) at local midnight until the next refresh brings the new
  date, clamps a step-back to the anchor, and stops extrapolating after 60 s
  without a refresh rather than guess.
- **An unset clock** writes only `clock_valid = 0`; the others keep their UI /
  default values, so an effect previews and can fall back to a neutral look.
- **Preview.** The editor feeds the same values from the phone's clock
  (`web/src/fx/clockUniforms.ts`), with a "Preview time" slider
  (`effects/editor/clockScrubber.ts`) shown only for an effect that binds one;
  a picked time runs on in real time. MCP `preview_effect` takes them as explicit
  uniforms (`clock_day: 0.27` = 06:30).
- The AI system prompts and the agent skill document them (use `clock_day` for
  daylight curves; never time of day from `time`); `agent/skill/examples/daylight.fx`
  is the library example.

## Status line and console

`[clock] valid=1 src=push/app unix_ms=… local=2026-11-25T09:00:00 CET off=3600
err_ms=25 age_s=0 drift_ppb=0 gen=1 steps=1 jumps=0 tz="CET-1CEST,…"`: at boot, on
every accepted set and every 10 minutes. The USB console takes `CLOCK STATUS` and
`CLOCK RESTART` (a soft reset with a fresh carry record, the HITL test's hook).

## Tests

- `//firmware/clock:tz_test`: the POSIX parser and evaluator against tzdata vectors.
- `//firmware/player_app:clock_test`: the arms through the C ABI, the zone record,
  the step guard, the carry-over, the kiosk visitor rule.
- `//firmware/player_app:clock_pool_test`: the `clock*` uniforms (unset, local
  time in the lamp's zone, extrapolation, the midnight wrap, a step-back).
- `//web:clockUniforms_test`: the preview values and the picked preview time.
- `//web:posixTz_test`, `//web:wallClock_test`, agent tests.
- HITL `//pi/hitl/harness:clock_app_netstack`: an app-style sync, then a soft reset
  keeps the clock, while render keeps running with no late frames.
