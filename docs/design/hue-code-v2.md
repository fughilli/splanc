# Hue code v2: staggered cycles, stronger codewords, faster alphabets

Status: decided. Phase 1 (measurement) is implemented. Phase 0 (one Rust
kernel) is PR #488. The owner has confirmed the pilot sequence and the other
decisions below; phases 2 and 3 are ready for implementation.

## Why

The radiolarian captures (2026-11-12, 1260 LEDs on dodecahedra, rings ~13 px
apart) exposed three limits of the v1 code:

1. **All LEDs sync together.** Every cycle opens with a white frame then a green
   frame on every LED at once. On a dense fixture the white frame blooms and
   merges neighbouring blobs, so every track loses its blob in the same frame.
   The 3D overlay's registration fails at every sync, and the tracker has no
   reliable track left to recover from.
2. **A track hop can pass as a valid decode.** A cycle stitched from two LEDs'
   colours (a track that hopped mid-cycle) is checked only by SEC-DED (distance
   4). Shifting cycle boundaries give it no further check.
3. **The rate gets stuck at 1 bit/symbol.** The upgrade needed a bright scene
   (mean luma ≥ 0.12) and a healthy decode-margin average. A dark room never
   passes the first, and on dense fixtures track hops dragged down the second.
   All five radiolarian captures ran at 2 symbols. Only 2 and 4 symbols exist.

## Decisions

The owner settled these points:

- **One kernel.** The colour code lives in one Rust kernel (phase 0). Phases 2
  and 3 are written only there.
- **Pilot, not white.** The global white sync frame is replaced by a per-LED
  pilot sequence (phase 2).
- **S is in the spec.** The stagger step S is pinned per cycle length C:

  | C   | 18  | 10  | 8   | 6   |
  | --- | --- | --- | --- | --- |
  | S   | 11  | 7   | 5   | 5   |

- **No new wire field.** The stagger is carried by the existing
  `CodeParams.syncPattern`.
- **Golay ships with the new alphabets.** The Golay code and the 8/16-hue
  alphabets land together in phase 3. SEC-DED stays for low bit rates.
- **White balance is never assumed locked.** Not all phones expose a lock. The
  decoder recalibrates every cycle instead.
- **Complexity stays in the app.** Firmware plays the palette it is given. The
  app does calibration, drive levels and rate choice.
- **Frame telemetry is used.** The player's `get_frame_timing` reports are wired
  into the capture screen.

## Phase 0: one colour-code kernel (PR #488)

Today the code has three implementations kept in step by hand:
`pi/led_driver/graycode.py`, `firmware/pattern` and `web/src/code/gray.ts`. A
fourth copy of the Python sits in `pi/provisioning/nix/ledapp/`.

Phase 0 converges them into one Rust kernel in `firmware/pattern` (no_std):

- firmware links it directly;
- the web app loads it as WASM;
- Python binds it through ctypes.

Golden fixtures are pinned in the kernel. Binding tests check that the WASM and
ctypes builds match them. From here on, phases 2 and 3 change only the kernel
and its callers.

## Phase 1: measure the channel (done; PR on `agent/hue-code-v2`)

`web/src/cv/channelQuality.ts`. Once a track's id is confirmed, the symbol each
window carried is known. Each data window's white-normalised colour then gives a
hue error against the sent symbol. Pooled over tracks, the errors give a hue
bias per target, a robust noise σ around it, and the share of washed-out
windows. None of these depends on the alphabet in use.

- **Prediction:** for every alphabet (2, 4, 8, 16), predict the per-window
  chance of a confidence-gate reject and of a decisive misread, and from those
  the chance a whole cycle decodes under the code's FEC.
- **Choice:** the planner picks the alphabet with the best decoded-cycle
  throughput. Upgrading needs a 25% gain. Downgrading happens when fewer than
  35% of cycles would decode, or when the decode yield is starved (under 10% of
  at least 40 sync-valid cycles, with nothing left to measure).
- **Backoff:** an abandoned alphabet is blocked for an exponential backoff (10
  s, doubling up to 80 s), so an over-optimistic prediction costs one probe
  rather than an oscillation.

Link-sim results compared with the old rule:

- Dark scenes are no longer pinned at 2 symbols (orbit-dark: 90% of the run on 4
  symbols, 14% more records).
- Lit scenes are unchanged.
- In a heavy veil, one failed probe delays 90% coverage by 2 s.

The HUD shows `chan σ… bias… · 2:…% 4:…% 8:…% 16:…%`, and capture bundles record
the same figures (`capture.channel`). **Those numbers from real captures decide
phase 3's alphabets.**

## Phase 2: staggered cycles with a pilot sequence

**Schedule.** LED `id` runs the same cycle as before, rotated by a phase
`φ(id) = (id · S) mod C`, where C = cycleFrames and S is the spec value for that
C (see Decisions). Consecutive ids, which are usually physical neighbours on a
strip, therefore land far apart in phase. At any frame, only about 2/C of the
LEDs are in their pilot (2 of 18 today). The rest keep showing data colours, so
they stay detected and tracked through every frame.

The rotation happens inside the kernel's `color_for_frame`, on the coded id
(`led + code_offset`). Callers keep passing the global frame index. Firmware
does one multiply and one mod per LED per frame.

**Pilot sequence.** The sync position no longer shows white then green. It shows
a short pilot of known hues on different colour channels:

- Every pilot hue has the same luminance as the data hues, so an LED in its
  pilot does not flash. Combined with the stagger, there is no luminance spike
  anywhere in the frame, so no bloom.
- The pilot is unique because it contains a transition that never occurs in
  data. No hue is reserved, so data keeps the full alphabet.
- Each pilot gives the decoder a fresh colour calibration for that track, every
  cycle: the camera-space centroids of the palette. This replaces the white
  reference and absorbs white-balance drift, which the decoder must assume is
  present.

**Palette.** The app computes the per-hue drive levels that give constant
luminance on this fixture. The calibration lives in the app. Firmware just plays
`palette[symbol]`, rotated by the LED's phase.

**Decoding.**

- Each track looks for its own pilot.
- It decodes the data windows that follow, cyclically, against the centroids
  that pilot gave.
- The decoded id must satisfy `φ(id) + k ≡ observed phase (mod C)`, where k is
  the whole-frame part of the latency (see Alignment). This adds about log2(C)
  bits of check (1 in 18 random acceptances) that FEC can't provide.
- A hop produces either two pilots at the wrong spacing or a phase that
  disagrees with the id, and is rejected.
- Decodes happen continuously, on each track's own boundary, rather than for
  everyone at the global cycle end.

**Alignment.** Today's sub-frame alignment scans for the frame shift that
maximises the global green census. A staggered fixture has a flat census, so
the scan instead scores within-window colour consistency, pooled over tracks.
Every LED changes colour on the same frame grid, so this finds the camera →
display latency, but only modulo bitPeriod. The φ check also needs the
whole-frame part k. The decoder gets it from FEC-only decodes: the mode of
(observed pilot phase − φ(id)) mod C. Once enough decodes agree, k locks and the
φ check is enforced. The player's `get_frame_timing` reports give display-side
frame times on the player clock, which removes render jitter and clock drift
from this estimate. They do not measure camera latency, so they supplement the
scan rather than replace it.

**Wire.**

- `CodeParams.syncPattern` gains a staggered value next to today's `"on_off"`.
  No new field. S follows from C by the spec table.
- Players advertise support in `welcome`. The app asks for the staggered pattern
  only from players that advertise it. Old players keep v1.
- The app sends the palette's drive levels with the code parameters.

**Pilot vs white.** Before the decoder rewrite lands, the link sim compares the
pilot with a staggered white delimiter on the same scenes (dense fixture, dark
room, heavy veil): records, hop rejects, false delimiters and servo
trajectories.

Also affected: the server codebook (`pi/server/server/codebook.py`), the host
player, the wall page and the mock devices. They pick up the change through the
kernel.

## Phase 3: stronger codewords and faster alphabets

**Code book.** The extended Golay code **[24,12,8]**:

- 12 data bits, which covers 4094 LEDs with the id+1 offset (the largest fixture
  today is 1260);
- corrects 3 bit errors and detects up to 7, against SEC-DED's 1 and 3;
- a stitched cycle from a hop is far less likely to land on a valid codeword.

Encode and decode are table-free and cheap enough for the C6. Golay ships
together with the 8- and 16-hue alphabets. SEC-DED stays for low bit rates,
where cycle length matters more.

**Alphabets.**

- 8 hues (3 bits/symbol) and 16 hues (4 bits/symbol) on the hue circle, in Gray
  order, so an adjacent-hue misread flips one bit.
- Data uses the full alphabet. Only the pilot's forbidden transition marks the
  sync position.
- The classifier uses the palette centroids from each track's latest pilot,
  absorbing the camera's hue bias that phase 1 measures, instead of assuming
  ideal targets.
- 16 hues is likely viable only close up and in good light. Phase 1's `16:…%`
  figure says whether it ever is.

**Cycle lengths** (frames, 2 sync + data):

|                           | 1 bit | 2 bits | 3 bits | 4 bits |
| ------------------------- | ----- | ------ | ------ | ------ |
| SEC-DED [16,11,4] (today) | 18    | 10     | 8      | 6      |
| Golay [24,12,8]           | 26    | 14     | 10     | 8      |

Golay at 3 bits/symbol is 10 frames: shorter than today's 18, with 3-error
correction. The spec pins S for every cycle length in use.

**Rate selection.** Phase 1's planner extends to (alphabet × code) pairs. The
prediction already accounts for the code's correction capability.

## Replacing the global flash

The v1 code relies on every LED showing white at the same frame. A survey of
this branch found 11 consumers of that global flash. Each needs a replacement
under the stagger:

| #   | Consumer                                                     | Replacement                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Decoder sub-frame alignment (`decoder.ts` `updateAlignment`) | Consistency score pooled over tracks. It finds latency only modulo bitPeriod, so add the integer-frame k from the (observed phase − φ(id)) histogram before enforcing the φ check. `get_frame_timing` supplements it. |
| 2   | Pipeline green census and the no-cyan palette rule           | Delete both. The pilot's forbidden transition is the delimiter.                                                                                                                                                       |
| 3   | Decoder cycle framing, reflection dedup, sample pruning      | Per-track cycle framing: a rolling decode per track, dedup per id over one cycle, prune at `now − 2·cycleMs`.                                                                                                         |
| 4   | Per-track white reference (decoder, `channelQuality`)        | Per-track pilot calibration (palette centroids), refreshed every cycle.                                                                                                                                               |
| 5   | Record anchor and pose-pairing latency                       | Latency = sub-frame shift + k·bitPeriod. Anchor on the median of the cycle's window centroids.                                                                                                                        |
| 6   | Exposure and brightness servos (`exposure.ts`)               | Phase-aware populations that skip pilot windows. A staggered white would give grayFrac a ≈1/C baseline (6% at C = 18, 17% at C = 6); the pilot avoids that, and replay checks the servo trajectories.                 |
| 7   | Split-blob colour (`ccl.ts` `haloHue`)                       | Keep the member-mean colour alongside the halo hue. Use the member mean for pilot detection and calibration.                                                                                                          |
| 8   | Tracker, 3D overlay, IMU-cal lock gate                       | None needed. They only tolerated the blackout, and it is gone.                                                                                                                                                        |
| 9   | Group capture (one shared alignment)                         | Per-fixture k from the same histogram. φ is computed on the coded id, so every fixture's check passes.                                                                                                                |
| 10  | Pattern generators and renderers                             | Rotate inside the kernel's `color_for_frame`. The 5 tests that assert frame 0 is all white change.                                                                                                                    |
| 11  | Telemetry (`cyclesCompleted`, sync-valid yield)              | Counters redefined per track, plus `delimiterMisses` and `phaseRejects`.                                                                                                                                              |

Notes:

- **Tests asserting frame 0 is all white:** `test_graycode.py`,
  `test_driver.py`, `firmware/player_app/tests/ffi.rs`,
  `pi/player_rs/src/render.rs`, and the golden in
  `firmware/player/tests/session.rs`. The golden survives if the rotation lives
  inside `color_for_frame`.
- **False delimiters.** A washed-out data window could mimic part of the pilot.
  The φ check and FEC must reject it, and the link sim injects this case.
- **Power.** v1 drives every LED at full RGB at once, the peak supply current.
  The stagger and the constant-luminance pilot flatten that peak.

## Order and testing

Phase 0 goes first: it gives phases 2 and 3 one place to change. Phase 2 goes
next. It fixes the sync-time registration loss and adds the hop check
independently of phase 3, and it is the largest change (decoder rewrite).

Each phase gets:

- golden fixtures in the kernel, checked through the WASM and ctypes bindings;
- the dense-fixture simulator (`web/tests/denseFixture_sim.test.ts`) extended
  with staggered rendering (no simultaneous sync blackout) and hop injection;
- link-sim policies for the new code and alphabets, including the pilot vs white
  comparison;
- HITL: the C6 and P4 players on the rigs, with the Android journeys on the
  phone bench.
