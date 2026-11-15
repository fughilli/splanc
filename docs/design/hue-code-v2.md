# Hue code v2: staggered cycles, stronger codewords, faster alphabets

Status: decided. Phase 1 (measurement) is implemented. Phase 0 (one Rust
kernel) is PR #488 (merged). Phase 2 is implemented wall-first (kernel,
virtual wall, phone decoder; no firmware advertisement yet): see "Phase 2 as
built" below. The owner has confirmed the pilot sequence and the other
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
trajectories. The results, and the pilot hues chosen from them, are under
"Phase 2 as built".

Also affected: the server codebook (`pi/server/server/codebook.py`), the host
player, the wall page and the mock devices. They pick up the change through the
kernel.

## Phase 2 as built (wall-first)

The wire value is `syncPattern: "stagger_pilot"`. v1 (`"on_off"`) is still the
default everywhere. Every existing player sends `"on_off"`, and the phone decodes
it with the v1 decoder (`web/src/cv/decoder.ts`), which this phase does not
change. The staggered decoder runs only when the code-book the phone receives
says `"stagger_pilot"`.

**The stagger step.** The kernel computes S as the integer coprime with C that
is nearest to C/Φ (Φ is the golden ratio):

- Being coprime with C, `id·S mod C` lands on every phase equally often. The
  number of LEDs in their pilot is the same on every frame (unit-tested for 16,
  64 and 1260 LEDs).
- Using the golden ratio puts consecutive ids far apart in phase.

This rule gives the pinned values (11, 7, 5, 5 for C = 18, 10, 8, 6). It also
covers every other C a code-book can have. The table for C = 3 to 34 is pinned
in the kernel test and in the golden (`staggerSteps`).

**The pilot: green, then magenta.** The sync position shows pure green for one
frame and magenta (red + blue) for the next. Reasons:

- **Channel separation.** Green and magenta are complementary and use disjoint
  channels: G alone, then R and B together. Each channel is driven in exactly
  one of the two frames, so the sum of the two pilot windows is a full
  white-equivalent calibration. The decoder divides each data window by that
  sum, which is exactly the v1 white-reference normalisation. It is refreshed on
  every cycle for every track, and no LED ever has to show white.
- **A richer calibration than white.** Each channel is on in one pilot window
  and off in the other. The pilot therefore measures every channel's on level
  and its off level (ambient veil, sensor black level, glare). The decoder
  normalises each data window per channel as `(x − off) / (on − off)`. v1's
  white frame measures only the gains. A veil that v1 divides into every
  window, the pilot subtracts out. This is why the pilot beats v1 in the heavy
  veil below.
- **No white, no bloom.** At most two channels are lit in any pilot frame,
  never more than in the data frames (magenta and yellow are already
  two-channel). Combined with the stagger, the peak drive of the whole fixture
  is flat: there is no frame where every LED shows white, and no frame where
  any LED does.
- **The forbidden transition.** Green appears in neither data palette (2
  symbols: blue/red; 4 symbols: blue/magenta/yellow/red). So the transition
  "into green, then magenta" never occurs in data, and data keeps its full
  alphabet. The pilot score normalises the two windows by their own sum.
  Per-channel gain, white balance and colour correction therefore cancel
  exactly, and no locked white balance is assumed. An ideal pilot scores 1.
  The data pair that looks most like a pilot is yellow then magenta, and it
  scores at most 0.5. A veil v at LED level L lowers a real pilot's score to
  L/(L + 2v). A candidate is therefore accepted when it scores at least 0.15
  (v1's green-sync floor, translated) and is the best pair within ±C/2
  windows. Uniqueness comes from that local maximum, together with FEC and
  the φ check.
- **Robust to hue bias.** The score depends only on which channels dominate
  each window, not on hue angles, so a camera that rotates hues by tens of
  degrees still sees the pilot.

Two parts of the decided design are deferred:

- **Constant luminance.** Pure green and magenta are not iso-luminant on a
  real LED. The design calls for app-computed drive levels sent with the code
  parameters, which needs a wire field and firmware. Until then the pilot uses
  the same full-drive 1- and 2-channel colours as the data. Its peak drive
  stays within the data's, so it does not flash brighter than the data.
- **Phase 3 alphabets.** The 8- and 16-hue alphabets will include green, so the
  "into green" rule stops holding there. Phase 3 must either keep a gap at
  green on the hue circle or rely on the φ check plus Golay for delimiter
  uniqueness. That choice belongs to phase 3.

**Decoder** (`web/src/cv/staggerDecoder.ts`). Per track, on its own cycle
boundary:

1. Bucket the track's samples into absolute frame windows, with v1's
   centrality weights.
2. Score every adjacent window pair as a pilot, and take the best one per
   cycle.
3. Calibrate from the pilot (per-channel off and span) and classify the C − 2 data windows that follow
   against the palette. Margins and the confidence gate are the same as v1.
4. Decode with SEC-DED.
5. Run the phase check `(a − φ(id)) mod C = k`, where `a` is the pilot's
   absolute frame.

Alignment works in two parts:

- **Sub-frame part.** Chromaticity scatter is pooled within windows across up
  to 160 tracks, and the decoder takes the shift (mod bitPeriod) that minimises
  it. The shift is kept continuous, never wrapped.
- **Whole-frame part k.** k comes from a decaying histogram of
  `(a − φ(id)) mod C` over decodes that pass FEC and the confidence gate. It
  locks once the top bin has at least 4 votes and at least 50% of the mass.
  Records are emitted only after k locks, and every record is phase-checked.

Records anchor at the sample nearest mid-cycle. Their pose is paired at the
exposure time, corrected by shift + k·bitPeriod. Reflections are deduplicated
per id and per pilot frame.

**The 11 consumers, for the wall test:**

| #   | Consumer                       | Status                                                                                                                                                                                                                     |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alignment                      | Done: pooled consistency plus the k histogram. `get_frame_timing` is not wired in yet (deferred).                                                                                                                          |
| 2   | Green census, no-cyan rule     | Unused under stagger: the pipeline still computes the census, and only the v1 decoder reads it. The no-cyan rule stays, because cyan would sit between the green pilot and the data palette.                               |
| 3   | Cycle framing, dedup, pruning  | Done: per-track rolling decode, dedup per (id, pilot frame), pruning at the oldest window a pending decode can still need (`pruneCutoffServerMs`).                                                                          |
| 4   | White reference → pilot        | Done: per-channel on and off levels from the pilot, per track and per cycle. `channelQuality` receives the same pilot-normalised colour.                                                                                   |
| 5   | Record anchor, latency         | Done: mid-cycle anchor, latency = shift + k·bitPeriod. The design's median of window centroids is replaced by the mid-cycle sample, which pairs with one pose.                                                              |
| 6   | Exposure and brightness servos | No change needed: pilot windows are saturated hues, so they never count as gray. A staggered white would put about 1/C gray blobs into every frame. The servo comparison is in the table below.                           |
| 7   | Split-blob colour (`haloHue`)  | Deferred. Splits come from bloom, which the pilot removes.                                                                                                                                                                 |
| 8   | Tracker, 3D overlay, IMU lock  | None needed.                                                                                                                                                                                                               |
| 9   | Group capture                  | Deferred. The φ check uses the coded id, so it holds across fixtures, but k is a single value. Fixtures whose latencies differ by a whole frame need a k per fixture.                                                      |
| 10  | Generators and renderers       | Done in the kernel (`color_index_for_frame`). The host player (`pi/player_rs`, the wall player), the wall page, the phone's synthetic source and the Python binding (`sync_pattern=`) render it. C6/P4 firmware links the same core but does not advertise the feature, so it stays on v1. |
| 11  | Telemetry                      | Done: `pilotCycles`, `delimiterMisses`, `phaseRejects`, `rejectedPhaseUnlocked` and `phaseK`. The first three are folded into link telemetry. The HUD shows `pilot k … cyc … miss … φrej …`.                               |

**Wire, for now.**

- **Request.** `StartMappingOptions.sync_pattern` (field 12) asks for
  `"stagger_pilot"`. The phone sends it only when the capture page is opened
  with `?sync=stagger_pilot`.
- **Who honours it.** The shared player core (`firmware/player`) runs the
  staggered pilot only if the build advertises the `hue_stagger_pilot` feature.
  Only the host player (`pi/player_rs` `player_host`, and so the virtual wall
  player) advertises it. C6 and P4 firmware do not, so they reply with
  `"on_off"`. The dev backend honours it too, and its `--sync-pattern
  stagger_pilot` flag can hand the code out unrequested.
- **What the phone decodes.** Whatever the reply's `codeParams.syncPattern`
  says, so an unsupported request is v1 end to end. A configure keeps the
  capture's pattern.
- **Next.** Requesting the code automatically from players that advertise it,
  and firmware support.

### Simulation results

Two simulators run the production pipeline and negotiation. They compare v1,
the staggered green/magenta pilot, and a staggered white/green delimiter (the
comparator, `"stagger_white"`, which is not a wire value).

**Dense fixture** (`web/tests/denseFixture_sim.test.ts`): radiolarian
geometry, 1260-LED code with C = 18 and S = 11, hand-held camera, 15% blob
dropout, and 225 ms of camera latency, so the whole-frame k is exercised. A
bloom of about one pitch merges spots: in v1 every LED blooms on the global
white frame; under the staggered white each LED blooms on its own white frame;
the pilot has no white frame.

| Run                         | Wrong (> 4 px) | Gross (> 12 px) | Good records / LED / s |
| --------------------------- | -------------- | --------------- | ---------------------- |
| v1, no bloom                | 2.7%           | 0.1%            | 2.49                   |
| Pilot, no bloom             | 2.6%           | 0.0%            | 2.50                   |
| v1, 14 px bloom             | 12.3%          | 4.2%            | 0.55                   |
| Staggered white, 14 px bloom | 0.0%          | 0.0%            | 0.50                   |
| Pilot, 14 px bloom          | 2.6%           | 0.0%            | 2.50                   |

- **Phase lock.** k locked, and the total latency estimate (shift + k·140 ms)
  came out at 224 ms against the true 225 ms.
- **The pilot under bloom.** The pilot is unaffected by bloom: its result
  equals the bloom-free one, 4.5× v1's yield, which closes failure mode 1. A
  staggered white avoids v1's wrong ids, but its yield is as bad as v1's: an
  LED blooms on its own white frame, so its window carries a merged colour,
  and FEC rejects the cycle.
- **Hops.** Of 686 neighbour-hop stitches that SEC-DED accepts as a third id,
  17 also pass the φ check (2.5%; random chance is 1/C = 5.6%). The forced
  hop through the pipeline is rejected by the phase check, and both real ids
  still land.

**Link sim** (`web/tests/staggerLink_sim.test.ts`): helix fixture, 120 LEDs,
30 s per scene, 140 ms camera latency, the measured alphabet rule, and the
exposure servo running.

| Scene        | Sync            | Records | Wrong ids | t90    | Delimiter misses | Exposure median / max |
| ------------ | --------------- | ------- | --------- | ------ | ---------------- | --------------------- |
| hold-dark    | v1              | 11139   | 0         | 4.1 s  | –                | 0.29 / 0.65           |
| hold-dark    | pilot           | 11425   | 0         | 4.3 s  | 98               | 0.37 / 0.65           |
| hold-dark    | staggered white | 11425   | 0         | 4.3 s  | 86               | 0.29 / 0.65           |
| orbit-dark   | v1              | 9845    | 0         | 21.9 s | –                | 0.29 / 0.65           |
| orbit-dark   | pilot           | 10185   | 0         | 21.4 s | 185              | 0.39 / 0.65           |
| orbit-dark   | staggered white | 10190   | 0         | 21.4 s | 176              | 0.29 / 0.65           |
| orbit-lit    | v1              | 11822   | 0         | 19.3 s | –                | 0.25 / 0.25           |
| orbit-lit    | pilot           | 11980   | 0         | 19.0 s | 141              | 0.25 / 0.25           |
| orbit-lit    | staggered white | 11966   | 0         | 19.0 s | 134              | 0.25 / 0.25           |
| bright-veil  | v1              | 6911    | 0         | never  | –                | 0.13 / 0.25           |
| bright-veil  | pilot           | 8437    | 0         | 28.5 s | 177              | 0.13 / 0.25           |
| bright-veil  | staggered white | 7939    | 0         | 26.5 s | 222              | 0.13 / 0.25           |
| ambient-ramp | v1              | 8782    | 0         | 20.1 s | –                | 0.25 / 0.25           |
| ambient-ramp | pilot           | 8815    | 0         | 19.0 s | 172              | 0.25 / 0.25           |
| ambient-ramp | staggered white | 8723    | 0         | 19.4 s | 169              | 0.25 / 0.25           |

- **Wrong ids and phase rejects.** No scene produced a wrong id or a phase
  reject. On this sparse fixture, hops and false delimiters do not reach the
  φ check.
- **Heavy veil.** The pilot's on/off calibration gives 22% more records than
  v1. It also reaches 90% coverage, which v1 never does.
- **Servo trajectories.** In the dark scenes the servo settles on a longer
  exposure under the pilot (median 0.37–0.39 against 0.29). v1's global white
  frame and the staggered white keep about 1/C of the blobs gray, which holds
  the servo back. The pilot has no gray windows.
- **Delimiter misses.** Misses are cycles in which a fully lit track found no
  pilot (motion smear across the pilot pair, or blobs entering the frame).
  They cost nothing measurable here.

**Decision.** The green/magenta pilot. It matches or beats v1 in every scene.
It beats the staggered white under bloom (5× the yield) and under veil
(+6% records, the on/off calibration). It also leaves the exposure servo free
of the white frame's gray floor.

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
