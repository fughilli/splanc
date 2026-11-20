# Hue code v2: staggered cycles, stronger codewords, faster alphabets

Status: decided. Phase 1 (measurement) is implemented. Phase 0 (one Rust
kernel) is PR #488 (merged). Phase 2 is implemented wall-first (kernel,
virtual wall, phone decoder; C6/P4 firmware advertises it too): see "Phase 2 as
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
`φ(id) = (id · S + h(id div C)) mod C`, where C = cycleFrames, S is the spec
value for that C (see Decisions) and h is a keyed per-block offset (see
"Non-linear pilot phase"). Consecutive ids, which are usually physical
neighbours on a strip, therefore land far apart in phase. At any frame, only about 2/C of the
LEDs are in their pilot (2 of 18 today). The rest keep showing data colours, so
they stay detected and tracked through every frame.

The rotation happens inside the kernel's `color_for_frame`, on the coded id
(`led + code_offset`). Callers keep passing the global frame index. Firmware
does one multiply, two mods and one to three integer hashes per LED per frame
(no floats).

**Pilot sequence.** The sync position no longer shows white then green. It shows
a short pilot of known hues on different colour channels:

- Every pilot hue has the same luminance as the data hues, so an LED in its
  pilot does not flash. Combined with the stagger, there is no luminance spike
  anywhere in the frame, so no bloom.
- The pilot is made of the active alphabet's own colours and is unique by
  structure: the code book is pruned of every id whose cycle contains the pilot
  anywhere but at its sync position. No hue is reserved, so data keeps the full
  alphabet (see "Phase 2 as built").
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
- S is applied within each block of C consecutive ids; a keyed offset per block
  makes φ non-linear across blocks (next section). Each complete block still
  covers every phase once, so the census stays flat.

This rule gives the pinned values (11, 7, 5, 5 for C = 18, 10, 8, 6). It also
covers every other C a code-book can have. The table for C = 3 to 34 is pinned
in the kernel test and in the golden (`staggerSteps`).

**The pilot: a fixed run of palette colours, unique by code-book pruning.**
The sync position shows a short, fixed sequence of symbols from the active
alphabet, at the same drive as the data:

| Alphabet  | Pilot                                | Frames |
| --------- | ------------------------------------ | ------ |
| 2 symbols | blue, blue, red, red, blue           | 5      |
| 4 symbols | blue, yellow, magenta                | 3      |

- **No reserved hue.** Every pilot colour is a data colour, and data keeps the
  full alphabet. This holds for any alphabet, including phase 3's 8 and 16
  hues.
- **Per-channel on/off calibration.** Every channel the palette uses is lit in
  some pilot frame and dark in another. Blue and yellow are complementary, and
  red and blue cover the binary palette. Green is never lit at 2 symbols; it
  reads relative to its pilot mean. The decoder normalises each data window per
  channel as `(x − off) / (on − off)`. v1's white frame measures only the
  gains, so a veil that v1 divides into every window, the pilot subtracts out.
- **No white, no bloom.** No LED ever shows white, and no frame's drive exceeds
  the data's. Combined with the stagger, the fixture never flashes.
- **Robust to hue bias and white balance.** The pilot score is per-channel
  contrast between the pilot's lit and dark frames: (min lit − max dark) /
  (min lit + max dark), taking the worst channel. Per-channel gain and colour
  correction cancel out of it, so no locked white balance is assumed. A veil v
  at LED level L lowers the score to L / (L + 2v).

**Uniqueness by pruning, not by symbol constraints.** Each LED's cycle content
is fixed: its pilot, then its id's codeword. The kernel therefore drops every
coded index whose whole cycle, read cyclically and including the pilot,
contains the pilot at any offset other than the sync position
(`stagger_valid`).

- **The id map.** Ids map in order onto the coded indices that survive. Id i
  carries the (i+1)-th valid index n, transmitted as SEC-DED(gray(n)).
- **Data width.** The data word widens one bit at a time until enough indices
  survive for the fixture (`CodeSpec::derive_sync`).
- **Decoding.** A track that finds the pilot has found its sync position. The
  decoder takes the best-scoring pilot within ±C/2 windows, so the true pilot
  is the only exact candidate in the cycle. An excluded index decodes to no
  id.
- **Safety net.** Wider margins come from the φ(id) check and FEC.

Near-matches (one symbol off the pilot at another offset) are **not** pruned.
At 2 symbols, pruning them leaves 28 of 4095 indices; at 4 symbols, 504 of
2047. Fewer than 1260 either way. They score low by construction: changing one
symbol of the pilot breaks a channel's lit/dark contrast. Uniqueness among them
is left to the best-in-cycle rule, φ and FEC.

**Capacity and cost.** The table below is for the largest fixture (1260 LEDs).
Rows for SEC-DED at 2 and 4 symbols are pinned by kernel tests. Rows for 8 and
16 hues (hue circle, Gray order) and for Golay [24,12,8] are a phase 3
prototype, computed with the same rule.

| Alphabet | Code    | Pilot (values) | L   | Data bits k | Ids left / book | Cycle C (v1 C) |
| -------- | ------- | -------------- | --- | ----------- | --------------- | -------------- |
| 2        | SEC-DED | 0,0,1,1,0      | 5   | 12          | 2443 / 4095     | 23 (18)        |
| 4        | SEC-DED | 0,2,1          | 3   | 11          | 1863 / 2047     | 11 (10)        |
| 8        | SEC-DED | 2,5            | 2   | 11          | 1923 / 2047     | 8 (8)          |
| 16       | SEC-DED | 0,15           | 2   | 11          | 2024 / 2047     | 6 (6)          |
| 2        | Golay   | 0,0,1,1,1      | 5   | 12          | 2002 / 4095     | 29 (26)        |
| 4        | Golay   | 2,0            | 2   | 12          | 1924 / 4095     | 14 (14)        |
| 8        | Golay   | 1,6            | 2   | 12          | 3663 / 4095     | 10 (10)        |
| 16       | Golay   | 4,11           | 2   | 12          | 4016 / 4095     | 8 (8)          |

- **Choosing the pilots.** Each pilot is the one with the most surviving
  indices among all pilots of its length that cover every channel. Its length
  is the shortest that leaves comfortably more than 1260 ids at the code's
  natural k.
- **The binary price.** A short binary pattern recurs in almost every random
  codeword: 2 frames leave 0 ids, 3 leave 602 even at k = 13, and 4 need
  k = 13. So the 2-symbol pilot costs 5 frames and one extra data bit, giving
  23 frames per cycle instead of 18.
- **The 4-symbol choice.** At 4 symbols a 2-frame pilot (blue, yellow) keeps
  only 1265 ids, so the pilot takes 3 frames.
- **Phase 3 alphabets.** At 8 and 16 hues, 2 frames are enough.
- **Stagger step.** The S rule simply takes the new C: S = 14 for C = 23 and
  S = 7 for C = 11.

Costs:

- **Validity check.** One cycle-stream scan, O(C) (the first compared symbol
  almost always differs).
- **Code-book derivation.** Counts the book once per capture: 4095 checks for
  1260 LEDs at 2 symbols.
- **Renderers.** They walk ids in order with `stagger_next`: about 1/0.6 checks
  per LED, amortised, with no table and no allocation. The host player memoises
  the walk inside `pattern_color`. The phone builds an id ↔ index table once
  per code book (`pk_stagger_fill`, 4 bytes per id).
- **Decode.** Maps the index back by rank, O(n) checks, in the app only.
- **Firmware.** C6/P4 firmware runs the same path: its render loop calls
  `pattern_color` in LED order, so the memoised walk is amortised there too.

One part of the decided design is deferred: **constant luminance**. The pilot
and data use the same full-drive palette colours. The app-computed drive
levels need a wire field and firmware.

**Decoder** (`web/src/cv/staggerDecoder.ts`). Per track, on its own cycle
boundary:

1. Bucket the track's samples into absolute frame windows, with v1's
   centrality weights.
2. Score every run of L windows as a pilot, and take the best one per cycle.
3. Calibrate from the pilot (per-channel off and span) and classify the C − L
   data windows that follow against the palette. Margins and the confidence gate are the same as v1.
4. Decode with SEC-DED, and map the index back to its id by rank.
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
| 2   | Green census, no-cyan rule     | Unused under stagger: the pipeline still computes the census, and only the v1 decoder reads it. The no-cyan palette rule is v1's and untouched; the pilot needs no reserved colour.                               |
| 3   | Cycle framing, dedup, pruning  | Done: per-track rolling decode, dedup per (id, pilot frame), pruning at the oldest window a pending decode can still need (`pruneCutoffServerMs`).                                                                          |
| 4   | White reference → pilot        | Done: per-channel on and off levels from the pilot, per track and per cycle. `channelQuality` receives the same pilot-normalised colour.                                                                                   |
| 5   | Record anchor, latency         | Done: mid-cycle anchor, latency = shift + k·bitPeriod. The design's median of window centroids is replaced by the mid-cycle sample, which pairs with one pose.                                                              |
| 6   | Exposure and brightness servos | No change needed: pilot windows are saturated hues, so they never count as gray. A staggered white would put about 1/C gray blobs into every frame. The servo comparison is in the table below.                           |
| 7   | Split-blob colour (`haloHue`)  | Deferred. Splits come from bloom, which the pilot removes.                                                                                                                                                                 |
| 8   | Tracker, 3D overlay, IMU lock  | None needed.                                                                                                                                                                                                               |
| 9   | Group capture                  | Deferred. The φ check uses the coded id, so it holds across fixtures, but k is a single value. Fixtures whose latencies differ by a whole frame need a k per fixture.                                                      |
| 10  | Generators and renderers       | Done in the kernel (`color_index_for_frame`). The host player (`pi/player_rs`, the wall player), the wall page, the phone's synthetic source and the Python binding (`sync_pattern=`) render it. C6/P4 firmware links the same core and advertises the feature too. |
| 11  | Telemetry                      | Done: `pilotCycles`, `delimiterMisses`, `phaseRejects`, `rejectedPhaseUnlocked` and `phaseK`. The first three are folded into link telemetry. The HUD shows `pilot k … cyc … miss … φrej …`.                               |

**Wire, for now.**

- **Request.** `StartMappingOptions.sync_pattern` (field 12) asks for
  `"stagger_pilot"`. The phone sends it by default to every player whose welcome
  advertises `hue_stagger_pilot` (`requestedSyncPattern`, web/src/code/gray.ts).
  `?sync=` on the capture page is a debug override (`?sync=v1` forces the old
  pattern). Group captures still request nothing, so mixed fleets share v1.
- **Who honours it.** The shared player core (`firmware/player`) runs the
  staggered pilot only if the build advertises the `hue_stagger_pilot` feature.
  The host player (`pi/player_rs` `player_host`, and so the virtual wall
  player) and the C6/P4 firmware (`firmware/player_app` FEATURES) advertise
  it. A player without it replies with `"on_off"`. The dev backend honours it too, and its `--sync-pattern
  stagger_pilot` flag can hand the code out unrequested.
- **What the phone decodes.** Whatever the reply's `codeParams.syncPattern`
  says, so an unsupported request is v1 end to end. A configure keeps the
  capture's pattern.

### Simulation results

Two simulators run the production pipeline and negotiation. They compare v1,
the staggered palette pilot (the wire value), and two sim-only comparators over
the unpruned v1 book: a staggered white/green delimiter (`"stagger_white"`) and
the first draft's green/magenta pilot, which reserves a hue (`"stagger_gm"`).
The tables in this section were measured with the first, linear φ; the
non-linear φ that replaced it changes them by at most about 1% (see
"Non-linear pilot phase").

**Dense fixture** (`web/tests/denseFixture_sim.test.ts`): radiolarian
geometry with the 1260-LED, 2-symbol code. That is a 23-frame cycle for the
palette pilot (12-bit pruned book, S = 14) and 18 frames for the others. The
camera is hand-held, 15% of blobs drop out, and the latency is 225 ms, so the
whole-frame k is exercised. A bloom of about one pitch merges spots: in v1
every LED blooms on the global white frame, and under the staggered white each
LED blooms on its own white frame. Neither pilot has a white frame.

| Run                                 | Wrong (> 4 px) | Gross (> 12 px) | Good records / LED / s |
| ----------------------------------- | -------------- | --------------- | ---------------------- |
| v1, no bloom                        | 2.7%           | 0.1%            | 2.49                   |
| Palette pilot, no bloom             | 1.2%           | 0.0%            | 2.02                   |
| v1, 14 px bloom                     | 12.3%          | 4.2%            | 0.55                   |
| Staggered white, 14 px bloom        | 0.1%           | 0.0%            | 0.51                   |
| Green/magenta draft, 14 px bloom    | 2.6%           | 0.0%            | 2.49                   |
| Palette pilot, 14 px bloom          | 1.2%           | 0.0%            | 2.02                   |

- **Phase lock.** k locked, and the latency estimate came out at 224 ms against
  the true 225 ms.
- **Bloom.** The palette pilot is unaffected by bloom (3.7× v1's yield under
  bloom), and it halves the wrong records.
- **The cost.** Its yield is 19% below the bloom-free v1 and the green/magenta
  draft: 23-frame cycles against 18 (the 5-frame binary pilot plus one data
  bit).
- **Hops.** Under the first, linear φ, 25 of the 179 neighbour-hop stitches
  that SEC-DED accepts as a third id also passed the φ check (14%; 1/C is
  4.3%). The non-linear φ cuts this to 2 of 177 (see "Non-linear pilot
  phase"). The forced hop through the pipeline is rejected (phase check plus
  confirmation), and both real ids still land.

**Link sim** (`web/tests/staggerLink_sim.test.ts`): helix fixture, 120 LEDs,
30 s per scene, 140 ms camera latency, the measured alphabet rule, and the
exposure servo running. Records by scene:

| Scene        | v1                 | Palette pilot      | Staggered white    | Green/magenta      |
| ------------ | ------------------ | ------------------ | ------------------ | ------------------ |
| hold-dark    | 11139 (t90 4.1 s)  | 10731 (5.5 s)      | 11425 (4.3 s)      | 11425 (4.3 s)      |
| orbit-dark   | 9845 (21.9 s)      | 9031 (23.5 s)      | 10190 (21.4 s)     | 10185 (21.4 s)     |
| orbit-lit    | 11822 (19.3 s)     | 11403 (20.3 s)     | 11980 (19.0 s)     | 11980 (19.0 s)     |
| bright-veil  | 6911 (never)       | 11143 (21.3 s)     | 5095 (never)       | 11869 (19.7 s)     |
| ambient-ramp | 8782 (20.1 s)      | 8143 (20.3 s)      | 8791 (19.0 s)      | 8815 (19.0 s)      |

- **Wrong ids and phase rejects.** No scene produced either.
- **Heavy veil.** The pilots' on/off calibration gives +61% records over v1,
  and both pilots reach 90% coverage, which v1 and the staggered white never
  do. Folding the pilot score into the confidence cut those records down while
  the calibration was already removing the veil, so it was dropped: the score
  gates the delimiter, and the data margins set the confidence.
- **Other scenes.** The palette pilot runs 4–8% fewer records than v1, again
  the longer cycle.
- **Servo trajectories.** In the dark the exposure servo settles longer under
  both pilots (median 0.37–0.39 against 0.29). The white frames keep about
  1/C of the blobs gray, which holds the servo back; the pilots show no gray.

**Decision.** The palette pilot, for these reasons:

- It reserves no hue, so it works unchanged for the phase 3 alphabets.
- It keeps the green/magenta draft's wins over v1: bloom, veil and the servo.
- It halves the dense-fixture wrong records.

Its price is the binary pilot's length: 23 frames instead of 18 at 2 symbols,
and 11 instead of 10 at 4. The price disappears at 8 and 16 hues, where 2
frames are enough (table above).

### Non-linear pilot phase

**The problem.** The first φ was linear: `φ(id) = (id·S) mod C`. Then
φ(c) − φ(a) = (c − a)·S mod C, so a wrong id c passes the phase check exactly
when c − a is a multiple of C. The stitches SEC-DED accepts cluster at those
offsets. In the dense-fixture neighbourhood one family at −414 = −18·23
dominated, so 14% of the FEC-accepted wrong ids passed φ (1/C is 4.3%). Over
all 12 panels of the 1260-LED fixture, every one of the 355 wrong ids that
passed was a multiple of C away (10.7%, 2.5× chance).

**The map.** The kernel (`stagger_phase`, firmware/pattern/src/lib.rs) now
computes

`φ(id) = (r·S + h(q)) mod C`, with q = id div C and r = id mod C.

- **Within a block** of C consecutive ids it is the golden-ratio stagger. Ids
  one apart are S apart in phase, and the block covers every phase once, so the
  pilot census stays flat (54–55 ids per phase for 1260 LEDs at C = 23, the same
  as before).
- **Across blocks** the offset h(q) is a keyed integer hash:
  lowbias32(q ⊕ 0x5eed) mod C. A wrong id in the same block as the true id never
  matches its phase. One a block or more away matches by chance, about 1 in C.
- **Block boundaries stay spread.** Even blocks take the hash. An odd block takes
  the first value of its own hash-ordered probe that keeps both of its
  boundaries at least d = C/8 + 1 frames apart in phase (3 at C = 23, 2 at
  C = 11). Its neighbours are even blocks, so there is no recursion. Each
  boundary excludes at most 2d − 1 values, and 2(2d − 1) < C for every C ≥ 3,
  so a value always exists.
- **Integer only, one implementation.** u32 multiply, xor-shift and mod, a
  `const fn` in the kernel. The phone gets it through the wasm binding
  (`pk_stagger_phase`) and Python through ctypes; neither has a port. The
  goldens pin it over 512 ids (`phasesWide`), and the TS, Python and Rust golden
  tests check every binding against them. S and the cycle lengths are
  unchanged: C = 23 (S = 14, k = 12) at 2 symbols and C = 11 (S = 7) at 4. So
  is the palette pilot.

**Chosen by measurement.** Candidates were scored on the dense-fixture stitch
analysis (`staggerStitches`), widened from one panel to all 12 (2-symbol,
C = 23):

| φ                                       | Wrong ids passing φ, 1 panel | All 12 panels    | Consecutive-id phase distance (min / mean / ≤ 1) | Census per phase |
| --------------------------------------- | ---------------------------- | ---------------- | ------------------------------------------------ | ---------------- |
| Linear (id·S) mod C (before)            | 25/179 (14.0%)               | 355/3323 (10.7%) | 9 / 9.00 / 0%                                    | 54–55            |
| Permutation P[(id·S) mod C], 3 seeds    | 23–37 (10–18%)               | 8.4–8.9%         | 1 / 4.7–6.7 / 4–17%                              | 54–55            |
| Full hash mix32(id) mod C               | 9/209 (4.3%)                 | 134/3542 (3.8%)  | 0 / 6.00 / 12.9%                                 | 41–73            |
| Block offset, unconstrained             | 3/158 (1.9%)                 | 117/3101 (3.8%)  | 0 / 8.89 / 0.4%                                  | 54–55            |
| **Block offset, spread boundaries**     | **2/177 (1.1%)**             | **94/3260 (2.9%)** | **3 / 8.88 / 0%**                              | **54–55**        |

- **Permutation of the linear phase.** This was the first suggestion, and it
  does not help. It is still a function of id mod C, so the multiple-of-C
  family keeps passing. It also loses the golden spread.
- **Full hash.** It reaches chance, but neighbour spread becomes random (13% of
  consecutive ids are within one frame) and the census is no longer flat.
- **Block offset.** It reaches chance with the spread and the flat census
  intact. Constraining the boundaries removes the remaining close neighbours.
- **±1 frame.** The decoder's check is exact (dk must equal k). If it allowed
  ±1 frame, the chosen map would pass 9.9% (3/C is 13%), against 17.5% for the
  linear map.
- **4 symbols** (C = 11). The linear map was already at chance (9.7%, 1/C =
  9.1%). The new map gives 9.1%, with consecutive-id distance min 2 and mean
  3.93 (it was a constant 4).
- **Physical neighbours** on a panel (within 1.5 pitches, which are not
  consecutive ids): mean phase distance 6.57 against 6.60, and 8.2% within one
  frame against 8.1%. The ring geometry put some neighbours at equal phase
  before too.

**Before and after, end to end** (production pipeline, same seeds):

| Sim                                         | Metric                              | Linear φ      | Non-linear φ  |
| ------------------------------------------- | ----------------------------------- | ------------- | ------------- |
| Dense fixture, hand-held (palette pilot)    | Good records / LED / s              | 2.02          | 2.01          |
|                                             | Wrong (> 4 px) / gross (> 12 px)    | 1.2% / 0.0%   | 0.8% / 0.0%   |
|                                             | Coverage (LEDs with a good record)  | 41.3%         | 41.9%         |
|                                             | Off-fixture ids recorded            | 0             | 0             |
|                                             | φ-rejects, k, latency               | 3, 2, 224 ms  | 3, 2, 224 ms  |
| Dense fixture, 14 px bloom (palette pilot)  | Good records / LED / s, wrong       | 2.02, 1.2%    | 2.01, 0.8%    |
| Dense stitches (FEC-accepted wrong ids)     | Passing φ, one panel                | 25/179 (14.0%)| 2/177 (1.1%)  |
|                                             | Passing φ, all 12 panels            | 355/3323 (10.7%) | 94/3260 (2.9%) |
| Link sim, palette pilot: hold-dark          | Records (t90), coverage             | 10731 (5.5 s), 100% | 10692 (5.5 s), 100% |
| orbit-dark                                  |                                     | 9031 (23.5 s), 100% | 8956 (23.8 s), 100% |
| orbit-lit                                   |                                     | 11403 (20.3 s), 100% | 11410 (19.7 s), 100% |
| bright-veil (heavy veil)                    |                                     | 11143 (21.3 s), 100% | 11122 (20.6 s), 100% |
| ambient-ramp                                |                                     | 8143 (20.3 s), 100% | 8179 (19.7 s), 99.2% |
| Link sim, every scene                       | Wrong ids, φ-rejects                | 0, 0          | 0, 0          |

- **Yield and coverage.** These move by less than 1% either way. The sims are
  deterministic given φ, and φ changes which LEDs pilot on which frame, so this
  is reshuffling, not a trend.
- **ambient-ramp coverage** drops from 100% to 99.2%: one of 120 LEDs got no
  record in the 30 s run. t90 improves (19.7 s against 20.3 s).
- **The test** (`staggered hops`, denseFixture_sim) now asserts a pass rate
  below 2/C on the panel and below 1.5/C over all 12 panels. The linear map
  fails the second.

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
| 2   | Pipeline green census and the no-cyan palette rule           | Delete both. The pilot, unique by code-book pruning, is the delimiter.                                                                                                                                                       |
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
