# Moving-camera mapping HITL rig (design, #448)

**Status:** design only. The software half is in: capture bundles record the
mapping optical-link telemetry (bundle v2, `web/src/cv/linkTelemetry.ts`), and
`bazel run //web:link_bench` turns bundles (or the moving-camera simulator,
`web/tests/linkSim.ts`) into baseline-vs-candidate throughput reports. The rig
below is what lets those numbers come from a real camera instead of the
simulator.

## Why

Mapping time on hard fixtures (the 650-LED diffused demo fixture: 5–8 min) is
bounded by how many ids per second the camera ⇄ LED link decodes, and the
negotiation (exposure servo, 2/4-symbol alphabet, bit period —
`web/src/cv/exposure.ts`) is tuned conservatively from a handful of field
traces. Tuning it needs **repeatable** runs: the same trajectory, the same
light, a known fixture, so a change can be compared with a baseline and
rejected when it costs decoded-ID correctness. A hand-held phone is not
repeatable; the synthetic camera (`web/src/xr/syntheticCaptureSource.ts`) and
`linkSim.ts` do not reproduce bloom, rolling shutter, sensor noise or
auto-exposure.

## Hardware

The camera must move, not the fixture: the on-phone VIO solver needs the
phone's IMU to see the motion (a turntable under the fixture leaves the IMU
still and the solve has no scale).

| Item                                                                                                                                                            | Notes                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Motorized boom: a NEMA-17 stepper + 1:5 belt reduction on a bearing turntable, with a 1.0–1.5 m counterweighted boom                                            | the camera orbits the fixture at a fixed radius; 5–60 °/s                |
| Phone clamp on the boom, tilt adjustable, with a 2-axis vibration mount (small eccentric-mass motor, PWM)                                                       | adds repeatable "hand shake" (0.3–1.5° at 2–3 Hz)                        |
| Slip ring (6-wire USB 2.0 + 5 V) or an on-boom battery + USB hub                                                                                                | adb + power to the phone through continuous rotation                     |
| Stepper driver (TMC2209, UART) + an optical home switch                                                                                                         | absolute start angle, so trajectories repeat                             |
| Controller: the rig's Pi (GPIO/UART)                                                                                                                            | exposes motion + light over the station (below)                          |
| 2–4 dimmable LED panels (high-CRI, flicker-free PWM > 20 kHz or DC dimming) on MOSFET PWM from the Pi, plus one deliberately-flickering 100/120 Hz lamp channel | ambient sweeps: dark → lit → bright veil, and mains flicker              |
| BH1750 (or TSL2591) lux sensor on I2C, at the fixture                                                                                                           | ground truth for "ambient", logged with every run                        |
| Blackout enclosure / curtain around the volume                                                                                                                  | removes daylight drift between runs                                      |
| Reference fixtures with SURVEYED maps (`.binpb`): the diffused demo fixture, plus an easy one (rigid strip or planar grid)                                      | the regression set: improve the hard one without regressing the easy one |
| ESP32-C6 driving the fixture (an existing rig DUT)                                                                                                              | firmware under test, as in the other HITL lanes                          |
| Phone: the amd-rig `android-phone` unit (Galaxy A11) first, then an iPhone on the Mac station                                                                   | the device class matters (cadence, AE)                                   |

## How it plugs into the phone HITL station

It is one more backend + journey for the station in [README.md](README.md),
reserved like the `android-phone` unit:

1. **Reservation:** a new catalog unit (`orbit-rig`) on the phone daemon that
   bundles the phone, the fixture's C6 and the motion/light controller, so one
   reservation owns all three (no other run can move the boom mid-capture).
2. **Rig controller** (`pi/hitl/phone/orbit_rig.py`, to write): a small service
   on the rig Pi — `home()`, `orbit(deg_per_s, degrees)`, `shake(deg, hz)`,
   `ambient(profile)` (a time series of panel levels + flicker channel),
   `lux()` — with every command and the lux readings timestamped on the same
   clock the run log uses.
3. **Journey** `journeys/mapping_orbit.json`: `connect` → `ambient(profile)` →
   `openCapture` with the REAL camera (no `?synthetic`) → start `orbit` →
   `finishCapture` → a new driver query `captureBundle` (returns the run's v2
   bundle — the same object Settings ▸ Debugging exports; needs the debug
   "Keep successful runs too" pref set by the harness) → saved as a CI
   artifact next to the rig log + lux trace + DUT serial log (HITL rule).
4. **Analysis:** `bazel run //web:link_bench -- <bundles…>` per run;
   `--json` + `--baseline` for A/B across a policy change. Geometry quality
   comes from the bundle's final map vs the surveyed `.binpb` (similarity
   alignment RMS — to add to the bench alongside the link metrics).

The trajectory/light profiles mirror `linkSim.ts`'s scenario suite
(`hold-*`, `orbit-lit`, `orbit-dark`, `orbit-fast-shaky`, `ambient-ramp`,
`bright-veil`) so a rig run and a sim run of the same name are comparable — and
the rig's numbers are what the simulator's photometric constants get
calibrated against (it currently predicts relative, not absolute, behavior).

## What every run records (bundle v2 `link`)

- **Selected exposure:** the exposure servo target, LED brightness, detector
  threshold per ~2 s tick, with the frame interval, scene luma / clip and the
  decoder's margin EMA it was decided on.
- **Symbol count + timing:** every negotiated config (start + each configure):
  2/4 symbols, bit period, cycle length and the frames/bit it implied.
- **Frame timing:** interval histogram + p50/p90/p99, clipped frames, every
  frame-gap dropout (≥ 3 nominal intervals) and the time lost.
- **Decode coverage over time:** 1 s timeline of distinct ids, records,
  cycles and every rejection class; each id's first-decode time (exact
  time-to-X% coverage).
- **ID correctness:** ground-truth-free — track id flips, out-of-range words,
  SEC-DED corrections / rejects — on every run. Exact correct/incorrect ids
  need a truth oracle: the simulator has one; on the rig it is the surveyed map
  (a record is wrong when its pixel is far from its claimed LED's reprojection
  under the solved pose — to add to the bench with the geometry check).

## A/B protocol

- ≥ 5 reps per (profile, policy), alternating baseline and candidate so drift
  hits both; same phone, fixture, firmware, app build except the change.
- Report the median time to 90 % coverage of the fixture's visible LEDs, the
  summed wrong-id rate, decode stalls, final coverage and geometry RMS.
- Verdict rules = `compareReports` (`web/src/cv/linkReport.ts`): **unsafe**
  if the wrong-id rate rises (> 0.1 pp), id flips jump, or any config falls
  under 3 camera frames per bit (the web/README timing constraint) — whatever
  it does for speed. A candidate ships only if it is better on the diffused
  fixture and not worse/unsafe on the easy one, and the conservative fallback
  (4 → 2 symbols on low margin, the bit period following the measured fps)
  stays in place.

## Candidate tunings to try first

From the simulator (`bazel run //web:link_bench`), held camera:

- **Dark room alphabet:** the pre-capture pick and the mid-capture upgrade are
  luma-gated, so a dark room stays on 2 symbols for the whole run; in the
  simulator 4 symbols reaches 90 % coverage in 1.5 s vs 2.5 s there. Not
  shipped: field traces (2026-07-07) show auto-exposure clipping the LEDs in
  dark rooms, which the simulator does not model, and the margin-only upgrade
  (`upgrade-dark`) raised track id flips in the orbiting dark scenario.
- **Exposure servo start / step sizes** (`exp-start-0.5` was worse in sim).
- **Dense-record id labels under shake:** the simulator's wrong-id records
  come almost entirely from shake (zero when the camera is steady): a
  tracker swap carries the old track's id onto a neighboring blob until the
  next cycle re-decodes it. Worth measuring on the rig before touching the
  tracker.
