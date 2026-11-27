# Wall clock (software RTC, time zone, time from the app and the bridge)

Status: PR-2 of the real-time effects plan (desk D-559), plus the `clock*` effect
uniforms (PR-3), network time (SNTP, D-561) and PR-5: the hardware RTC and the
module time-source surface (below). The clock is set from the app, the bridge, SNTP
and an RTC chip; schedules come in a later PR. `set_clock_config` carries both
settings: fields 1-15 network time, 16 on the RTC chip.

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
| Hardware RTC (PR-5) | a DS3231 / PCF8563 / RV-3028 on the sensor I2C bus, read at boot and hourly | ±0.5 s + the chip's spec × time since this lamp last wrote it |
| A player module (PR-5) | `lm_clock_offer` (player_module.h): GNSS, a radio clock, ... | as the module says |

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

## Hardware RTC

A real-time-clock chip on the **sensor I2C bus** (the IMU's SDA/SCL, default GPIO 6/7)
keeps the time across a power loss. Native Rust drivers in `//firmware/rtc`, not
driver-VM programs: the VM has one slot (the COIL lamp's touch sensor holds it), no
boot-time load and no way to *set* anything, and polls under the player mutex.

| Chip | Address | Accuracy | Extras |
|---|---|---|---|
| DS3231 (and -M, -SN) | 0x68 | ±2 ppm (TCXO) | temperature (`temp_cc`), two alarms, aging trim |
| PCF8563 / BM8563 | 0x51 | ~±20 ppm + the crystal | minute alarm |
| RV-3028-C7 | 0x52 | ±1 ppm (±3 over temperature), 45 nA | minute alarm, EEPROM trim |

- **Detection** (`ledmapper_rtc::detect`, config `auto`): RV-3028 (ID register), then
  PCF8563 (its fixed-zero control bits), then DS3231. Probes only read; nothing is
  written to a device that did not identify itself.
- **0x68: DS3231 or MPU-6050.** Both default to 0x68 (a GY-521 with AD0 low). The
  DS3231 probe needs all 19 registers to look like one (BCD time, weekday 1..7, the
  status and temperature zero bits, a temperature in -40..85 °C) **and** a WHO_AM_I
  (0x75) that is not an MPU's; the sensor core refuses the DS3231 from its side (an
  unknown WHO_AM_I). Each identifies only itself (`//firmware/rtc:rtc_test`). Two
  parts at 0x68 on one bus can't work: strap the IMU to 0x69 (AD0 high) or use a
  PCF8563 / RV-3028 on an IMU lamp.
- **The chip holds UTC**, never local time, 2000–2099. A chip that lost time
  (DS3231 OSF, PCF8563 VL or STOP, RV-3028 PORF) is not a source; it reads as
  `time_valid = false` and `battery_low = true` (no coin cell, or a flat one).
- **As a source:** a reading of whole seconds is offered as the middle of its second
  (±0.5 s) plus the chip's drift spec times the time since this lamp last wrote it
  (NVS `rtc_wb`; 30 days assumed for a chip it never wrote). After a cold boot the
  chip is usually the only source, so the clock is valid within a second of boot;
  any push or SNTP sample is far more certain and takes over.
- **Write-back** (`ledmapper_rtc::policy::writeback_due`): when SNTP, the mesh or a
  push holds the clock to ≤ 250 ms and the chip lost time, is off by more than 1 s,
  was never written by this lamp, or was last written a day ago; never from the
  chip's own reading or from the soft-reset carry-over onto a chip that kept time;
  at most once per 10 min unless forced. `set_wall_clock{write_rtc}` forces it (an
  owner's explicit set). The write waits for the chip's set phase so the chip
  ticks on the wall clock's second (the start of a second; 492 ms into it for a
  PCF8563, whose first tick comes ~0.508 s after STOP is released) and a read 2 s
  later verifies it (`offset_ms`).
- **RV-3028 backup switch-over.** The factory EEPROM leaves it off, so such a module
  loses time at power-off even with a cell. The first write turns on level
  switching (BSM = 11) and persists it with an EEPROM update; nothing waits for the
  ~10–60 ms EEPROM write.
- **ZS-042 DS3231 boards** charge their coin cell through a diode + 200 Ω resistor:
  with a non-rechargeable CR2032 remove that resistor, or fit an LIR2032.
- **Where it runs.** `rtc_ffi.rs`, all on the loop task: `lm_rtc_begin` in setup
  (after the IMU probe; the bus is kept when an RTC answered even with no IMU),
  `lm_rtc_poll` every pass **without** the player mutex (the I2C waits never hold a
  render frame; ~0.5 ms per read, hourly), and the clock side in `lm_clock_tick`.
  Render never reaches it. An absent RTC costs three address NACKs at boot and
  nothing after (no bus, no task, no reads).
- **Config:** `set_clock_config{rtc_chip, rtc_addr}` (C 113, owner only: refused on
  a locked kiosk), NVS `rtc_cfg`: `AUTO` (default), `OFF`, or a chip taken at an
  address without the signature check. Re-detected at once.
- **State:** `clock_state.rtc` (`RtcState`): configured and found chip, address,
  `time_valid`, `battery_low`, temperature, `offset_ms` (chip − clock at its last
  read), read / write ages and counters. Feature `rtc`. MCP `get_clock` shows it as
  `hardware_clock`; `set_clock{write_rtc, rtc_chip, rtc_addr}`; `scan_i2c` labels
  0x51 / 0x52 / 0x68 with the RTC parts (`web/src/hardware/sensorDb.ts`, `native`).
- **Status line:** `[rtc] RV-3028@0x52 (auto) time_valid=1 battery_low=0 off_ms=-120
  reads=3 writes=1 errors=0 last_write=drifted` at detect, on a change and after a
  write; the `[clock]` line gains `rtc=RV-3028`.
- **P4:** the same `rtc_ffi.rs` is in the P4 image; its I2C (GPIO 7/8,
  `board_caps_p4.textproto`) is a separate bring-up.

## Time sources for module authors

A player module (`LmPlayerModule`, `firmware/player_app/player_module.h`) can be a
wall-clock source and read the clock without touching the core:

```c
#include "firmware/player_app/player_module.h"

// A GNSS module: at each PPS edge it knows the UTC second exactly.
static void gnss_poll(void) {
  if (pps_edge_seen) {
    lm_clock_offer(utc_second_ms, pps_edge_esp_timer_us, /*err_ms=*/1, LM_CLOCK_SRC_REFERENCE);
  }
  int64_t now_ms;
  uint32_t err_ms;
  if (lm_clock_now(&now_ms, &err_ms) && err_ms < 50) { /* act on the time */ }
}
```

- `lm_clock_offer(unix_ms, at_us, err_ms, source)`: `unix_ms` (UTC) was true when
  `esp_timer_get_time()` read `at_us`, ± `err_ms` (> 0; be honest: the clock keeps
  the lowest current error). Sources: `LM_CLOCK_SRC_REFERENCE` (GNSS, DCF77 / MSF /
  WWVB, a protocol of the module's own; ranks with SNTP and shows as SNTP),
  `LM_CLOCK_SRC_PUSH` (ranks with the app), `LM_CLOCK_SRC_RTC` (a clock chip on the
  module's own bus). Any task, never blocks: a one-slot mailbox the loop task takes
  at its next pass (returns 0 queued, 1 busy: retry, -1 refused). The same rules as
  every source apply: an offer > 60 s off a fresh, better-ranked source is refused,
  and so is one before the firmware's floor (2026-01-01).
- `lm_clock_now(&unix_ms, &err_ms)`: false while the clock is not set. Any task,
  including the `frame()` hook on render: it reads a seqlocked snapshot the loop task
  publishes every pass (a few integer ops; it can lag a correction by one pass).
- Effect time (`time`, `dt`) never moves with the wall clock; schedule on the wall
  clock, animate on the effect clock.

## Status line and console

`[clock] valid=1 src=push/app unix_ms=… local=2026-11-25T09:00:00 CET off=3600
err_ms=25 age_s=0 drift_ppb=0 gen=1 steps=1 jumps=0 tz="CET-1CEST,…"`: at boot, on
every accepted set and every 10 minutes. The USB console takes `CLOCK STATUS` and
`CLOCK RESTART` (a soft reset with a fresh carry record, the HITL test's hook).

## Tests

- `//firmware/rtc:rtc_test`: the three drivers on register-file fakes (BCD, 12/24 h,
  the century bit, OSF / VL / STOP / PORF, exact set bytes, temperature, alarms, the
  RV-3028 EEPROM switch-over), the registry (order, `OFF`, forced chips), the 0x68
  DS3231 / MPU-6050 coexistence, the read-offer error and the write-back rules.
- `//firmware/player_app:rtc_test`: `rtc_ffi.rs` through the C ABI on the fakes: no
  chip changes nothing; a lost-time chip filled by the first push at a second's
  start; a kept-time chip sets the clock at boot and is written back when a push
  disagrees (verified, throttled, forced by `write_rtc`); `set_clock_config`; the
  PCF8563's 492 ms set phase; `lm_clock_offer` / `lm_clock_now`.
- HITL `//pi/hitl/harness:clock_rtc_absent_netstack`: on a rig DUT with no RTC (every
  rig today), the RTC changes nothing: `clock_state.rtc` absent, the app push still
  sets the clock, no `[rtc]` errors, render unaffected.

- `//firmware/clock:tz_test`: the POSIX parser and evaluator against tzdata vectors.
- `//firmware/player_app:clock_test`: the arms through the C ABI, the zone record,
  the step guard, the carry-over, the kiosk visitor rule.
- `//firmware/player_app:clock_pool_test`: the `clock*` uniforms (unset, local
  time in the lamp's zone, extrapolation, the midnight wrap, a step-back).
- `//web:clockUniforms_test`: the preview values and the picked preview time.
- `//web:posixTz_test`, `//web:wallClock_test`, agent tests.
- HITL `//pi/hitl/harness:clock_app_netstack`: an app-style sync, then a soft reset
  keeps the clock, while render keeps running with no late frames.

## Network time (SNTP, D-561)

The lamp sets its own clock from the network (`Source::Sntp`, the best-ranked source), with
no app or bridge needed. Feature `sntp`.

- **Which server.** The owner's override (`set_clock_config.ntp_servers`, up to two host
  names or IPv4 literals) when set. Otherwise the NTP servers the DHCP lease offers
  (option 42, now requested), topped up with `pool.ntp.org`, resolved through the lease's
  DNS servers (option 6), else the router. `use_dhcp_ntp` turns the option-42 part off;
  `ntp_enabled` turns SNTP off. The settings persist in NVS (`clk_ntp`).
- **Cross-check.** A round asks two servers when it can (two option-42 servers, or one
  plus the pool, or two pool addresses) and takes the time only when they agree (offsets
  within the two error bounds + 50 ms). A lone answer counts when the round had one server
  or when it matches the last accepted sample within 1 s (+500 ppm of the time since).
  Otherwise the round fails (`DISAGREE`, `UNCONFIRMED`) and the clock is left alone.
- **Backoff.** After a good round 64 s, doubling to 1 h. After a failed round 15 s,
  doubling to 5 min. A kiss-o'-death waits 5 min. A random 1/8 of the interval is added.
- **Error.** δ/2 + the server's root delay/2 + root dispersion. T4 is the radio's
  arrival: while a request is out, the netstack reaps with the MAC's RX vector and the
  client maps its 1 MHz stamp onto esp_timer by the reap-lag floor (`firmware/sntp`
  `stamp.rs`), so a TLS record or a flash write in the loop doesn't add to the error.
- **Next hop.** The netstack now reads DHCP options 1, 3, 6 and 42 and sends a one-shot
  ARP who-has for the router (up to 3 tries, never beside a live wss). Off-subnet traffic
  to a peer it hasn't heard from goes to the router's MAC once known, else the BSSID as
  before. That is what makes DNS and NTP work on mesh or commercial APs where the AP is
  not the router.
- **No blipping.** Everything runs on the loop task: a round is one small DNS query and
  two 48-byte requests, a few times an hour. The sample is offered to the clock on the
  next `lm_clock_tick` (under the player mutex); one measured across an esp_timer
  step-back is dropped.
- **Mesh-only members** never get a lease, so they never run SNTP; they take wall time
  from the mesh (PR-8).
- **P4.** With Ethernet the P4 runs IDF lwIP's `esp_sntp` with the same settings and
  offers each sync through `lm_clock_offer_sntp` (error 50 ms: lwIP gives none). A P4 + C6
  lamp without Ethernet gets its time from the app and the bridge (the front end runs no
  SNTP yet).
- **Protocol.** `set_clock_config` (C 113, owner only: kiosk refuses it) → `clock_state`,
  which now carries `ntp` (`ClockNtp`: settings, the lease's servers, the last round's
  result, server, round trip, age, next poll).
- **Console.** `CLOCK SNTP` prints the `[sntp]` line (also logged after every round);
  `CLOCK SNTP NOW` runs a round now.
- **Tests.** `//firmware/sntp:codec_test` (golden DNS/NTP packets, KoD, LI 3, era
  pivot, RX floor), `//firmware/sntp:client_test` (server choice, cross-check, backoff,
  strays, spoofs), `//firmware/player_app:sntp_test` (the C ABI end to end into the
  clock), `//firmware/player_app:dhcp_reply_test` (the options), HITL
  `//pi/hitl/harness:clock_sntp_netstack`.
