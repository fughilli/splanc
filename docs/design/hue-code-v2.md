# Hue code v2: staggered cycles, stronger codewords, faster alphabets

Status: proposal. Phase 1 (measurement) is implemented; phases 2 and 3 need
review before the firmware work starts.

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

## Phase 1: measure the channel (done; PR on `agent/hue-code-v2`)

`web/src/cv/channelQuality.ts`. Once a track's id is confirmed, the symbol each
window carried is known. Each data window's white-normalised colour then gives
a hue error against the sent symbol. Pooled over tracks, the errors give a hue
bias per target, a robust noise σ around it, and the share of washed-out
windows. None of these depends on the alphabet in use.

- **Prediction:** for every alphabet (2, 4, 8, 16), predict the per-window
  chance of a confidence-gate reject and of a decisive misread, and from those
  the chance a whole cycle decodes under the code's FEC.
- **Choice:** the planner picks the alphabet with the best decoded-cycle
  throughput. Upgrading needs a 25% gain. Downgrading happens when fewer than
  35% of cycles would decode, or when the decode yield is starved (under 10%
  of at least 40 sync-valid cycles, with nothing left to measure).
- **Backoff:** an abandoned alphabet is blocked for an exponential backoff
  (10 s, doubling up to 80 s), so an over-optimistic prediction costs one probe
  rather than an oscillation.

Link-sim results compared with the old rule:

- Dark scenes are no longer pinned at 2 symbols (orbit-dark: 90% of the run on
  4 symbols, 14% more records).
- Lit scenes are unchanged.
- In a heavy veil, one failed probe delays 90% coverage by 2 s.

The HUD shows `chan σ… bias… · 2:…% 4:…% 8:…% 16:…%`, and capture bundles record
the same figures (`capture.channel`). **Those numbers from real captures decide
phase 3's alphabets.**

## Phase 2: staggered cycles

**Schedule.** LED `id` runs the same cycle as before, rotated by a phase
`φ(id) = (id · S) mod C`, where C = cycleFrames and S is coprime with C, near
C/φ_golden. Consecutive ids, which are usually physical neighbours on a strip,
therefore land far apart in phase. At any frame, only about 2/C of the LEDs show
the white/green delimiter (2 of 18 today). The rest keep showing data colours,
so they stay detected and tracked through every frame.

**Decoding.**

- Each track looks for its own delimiter: a white window followed by a green
  one.
- It decodes the C − 2 windows that follow, cyclically.
- The decoded id must satisfy `φ(id) ≡ observed phase (mod C)`. This adds about
  log2(C) bits of check (1 in 18 random acceptances) that FEC can't provide.
- A hop produces either two delimiters at the wrong spacing or a phase that
  disagrees with the id, and is rejected.
- Decodes happen continuously, on each track's own boundary, rather than for
  everyone at the global cycle end.

**Alignment.** Today's sub-frame alignment scans for the frame shift that
maximises the global green census. A staggered fixture has a flat census, so
the alignment instead scores within-window colour consistency, pooled over
tracks. Every LED changes colour on the same frame grid, so this scan still
finds the camera → display latency. Cycle phase is per track and comes from
each track's delimiter.

**Wire.**
- `CodeParams.stagger` (optional int32 S; unset or 0 means v1, all in phase).
- Players advertise it in `welcome` (`code_caps.stagger = true`).
- The app only asks for it from players that advertise it. Old players keep v1.

**Implementations, in lockstep and pinned by new golden fixtures:**
- `pi/led_driver/graycode.py` (the reference implementation);
- `firmware/pattern` (no_std Rust);
- `web/src/code/gray.ts`, plus the decoder rewrite.

Also affected: the server codebook (`pi/server/server/codebook.py`), the host
player, the wall page and the mock devices.

## Phase 3: stronger codewords and faster alphabets

**Code book.** The extended Golay code **[24,12,8]**:
- 12 data bits, which covers 4094 LEDs with the id+1 offset (the largest
  fixture today is 1260);
- corrects 3 bit errors and detects up to 7, against SEC-DED's 1 and 3;
- a stitched cycle from a hop is far less likely to land on a valid codeword.

Encode and decode are table-free and cheap enough for the C6. SEC-DED stays for
compatibility and for fixtures where cycle length matters more.

**Alphabets.**
- 8 hues (3 bits/symbol) and 16 hues (4 bits/symbol) on the hue circle, in Gray
  order, so an adjacent-hue misread flips one bit.
- With per-LED delimiters, data symbols may include green: only white → green
  is a delimiter, and white never appears in data.
- The classifier learns the palette's camera-space centroids from confirmed
  decodes, absorbing the camera's hue bias that phase 1 measures, instead of
  assuming ideal targets.
- 16 hues is likely viable only close up and in good light. Phase 1's
  `16:…%` figure says whether it ever is.

**Cycle lengths** (frames, 2 sync + data):

| | 1 bit | 2 bits | 3 bits | 4 bits |
|---|---|---|---|---|
| SEC-DED [16,11,4] (today) | 18 | 10 | 8 | 6 |
| Golay [24,12,8] | 26 | 14 | 10 | 8 |

Golay at 3 bits/symbol is 10 frames: shorter than today's 18, with 3-error
correction.

**Rate selection.** Phase 1's planner extends to (alphabet × code) pairs. The
prediction already accounts for the code's correction capability.

## Order and testing

Phase 2 goes first. It fixes the sync-time registration loss and adds the hop
check independently of phase 3, and it is the largest change (decoder rewrite).

Each phase gets:
- golden fixtures shared by Python, Rust and TypeScript;
- the dense-fixture simulator (`web/tests/denseFixture_sim.test.ts`) extended
  with staggered rendering (no simultaneous sync blackout) and hop injection;
- link-sim policies for the new code and alphabets;
- HITL: the C6 and P4 players on the rigs, with the Android journeys on the
  phone bench.
