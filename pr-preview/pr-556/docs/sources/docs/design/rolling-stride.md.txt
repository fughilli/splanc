# Rolling stride: diffuse capture with live tracks at every moment

Status: proposed (design only). Follows #555 (adaptive diffuse detector,
negotiated exposure and bit rate). Owner review needed on the
[boundary rule](#spacing-at-block-boundaries) before implementation.

## Problem

Strided capture ([strided-capture.md](strided-capture.md)) lights a sparse,
spaced-out subset of LEDs per **phase** and rotates the phase. The phone
drives the rotation: every few seconds it sends `configure { stridePhase }`.
The lamp restamps its pattern epoch, and the phone rebuilds its decode
pipeline (`applyReconfigure` in `web/src/ui/screens/capture.ts`).

A phase change is global. Every lit LED goes dark in the same frame, a
disjoint class lights up, and every track and decoder state is thrown away.
That breaks a hue code v2 goal: **some LEDs should hold a valid,
solvable track at every moment**. v2 staggers each LED's code cycle
(`stagger_phase`) so sync and decode events spread over time. The global
phase step undoes that, with a dead gap at every step while the pilot
re-locks and cycles re-confirm.

Measured on the DemoPixieLamp (250-LED diffused rope, stride 3, Pixel 10 Pro
Fold, #555 build, v2 code): the decoder resets on every phase change
(`reneg` climbs, `cyc` and the pilot lock `k` go back to 0). Decodes then land
only in the second half of each about-4-second dwell.

## Goals

1. **Live tracks at all times.** At every frame, a steady fraction of the lit
   LEDs is mid-dwell: they have been lit long enough to have decoded, and will
   stay lit long enough to decode again.
2. **Spacing is never violated.** No two simultaneously lit LEDs are closer
   than `S` (the stride spacing, the diffuser knob) in LED index.
3. **Full coverage.** Every LED is lit for whole code cycles of its own, often
   enough to decode and confirm (`confirmCycles = 2`).
4. **No reconfigures for striding.** The lit schedule is a pure function of
   (LED, pattern-clock frame). The lamp and the phone compute it with the same
   kernel function, so striding never restamps the epoch or rebuilds a decoder.
   Only real rate or alphabet changes do.
5. **Registration still works.** The co-observation graph (LEDs seen in the
   same frames) stays connected with a small diameter, so the bundle
   adjustment holds one rigid fixture together.

## Proposal

### Blocks with their own clocks

Cut the strip into blocks of `B = A·S` LEDs (`A` = anchor density, at least 3,
as today). Within a block, the lit LEDs are a stride-`S` grid at **offset**
`o_b(t) ∈ [0, S)`, which steps through `0, 1, …, S-1` once per period. Each
offset is held for a **dwell** of `D` code cycles.

Each block runs that same schedule shifted by its own time offset `τ_b`. The
offsets are spread over one dwell with a low-discrepancy sequence, so the
blocks don't switch together:

```
τ_b  = frac(b · φ) · D · cycleMs        (φ = golden ratio conjugate)
o_b(t) = floor((t − τ_b) / (D · cycleMs)) mod S
```

At any moment, about `1/D` of the blocks are in the first cycle of a dwell,
where tracks are still forming. The other `(D−1)/D` are mid-dwell and holding
valid tracks. With `D = 3` that's about two thirds of lit LEDs always
decodable, against near zero right after a global phase step today.

### Dwells aligned to each LED's own cycle (v2)

Under v2, LED `i` runs its cycle rotated by `stagger_phase(i)`. A dwell that
starts or ends mid-cycle wastes that cycle and can corrupt a decode. So LED `i`
is lit only for its **own** whole cycles inside its block's dwell window:
from the first own-cycle start at or after the window opens to the last own
cycle that finishes before it closes. That is `D−1` or `D` full cycles, and
never a partial one. Under v1, own cycles are global cycles and this reduces
to the plain window.

### Spacing at block boundaries

Within a block, spacing holds by construction: lit LEDs are `S` apart. Across
a boundary, block `b` lights `bB + o_b + kS` and block `b+1` lights
`(b+1)B + o_{b+1} + kS`. The closest pair across the boundary is
`S + o_{b+1} − o_b` apart, which is less than `S` whenever `o_{b+1} < o_b`.
Because neighbouring blocks run on different clocks, that happens.

**Proposed rule:** when the two LEDs nearest a boundary would be closer than
`S`, the one in the block whose current dwell started **later** stays dark
for the overlap. It has the most time left to be lit later. The kernel
evaluates this from both blocks' clocks, so it stays a pure function and the
lamp and phone agree.

Cost: at most one LED per boundary is blanked, and only while the offsets
are inverted. To stop the same edge LED always losing, the block grid shifts
by `S` every full period (`S · D` cycles), so a different LED sits at each
edge. Coverage stays complete. A property test pins the duty-cycle loss
(target: every LED lit for at least `D−1` own cycles every two periods).

**Alternatives for the owner to choose between:**

- *Guard LED:* keep the boundary LED dark whenever the neighbouring offsets
  differ. Simpler, but blanks more.
- *Monotone wave:* make neighbouring offsets never invert, by advancing the
  blocks strictly in order like a travelling wave. Spacing then holds without
  blanking, except at the wave's wrap point, which still needs the rule above.
  It also makes the switching pattern sweep along the strip, which is
  clustered in time rather than spread.

### Registration (fusion)

Today, coverage phases light one class everywhere, so LEDs of different
classes are never co-observed except through the separate **bridge** phases
(`S−1` star phases through class 0). With rolling blocks, neighbouring blocks
are routinely at different offsets, so every frame co-observes LEDs of
several classes across the whole strip. The co-observation graph is connected
by construction and its diameter is small. **Bridges become unnecessary.**
This needs confirming in the solver scenarios
(`solver/src/scenario.rs` `stride`) before the bridge phases are dropped.

## Wire and code changes

| Piece | Change |
|---|---|
| Kernel (`firmware/pattern/src/lib.rs`) | `stride_lit_rolling(led, frame, spec, spacing, anchor_density, dwell_cycles) -> bool`, `const` and allocation-free (the player evaluates it per LED per render); `stride_lit` stays for phased mode. Goldens + a wasm export for the web (`web/src/code/stride.ts`). |
| Protocol | `start_mapping` gains `strideMode: "phased" \| "rolling"` and `dwellCycles`, and the player advertises a `stride_rolling` feature. Old firmware keeps phased, like `hue_stagger_pilot`. |
| Player (`firmware/player`) | Masks output with the rolling function at the pattern-clock frame; ignores `stridePhase` in rolling mode. |
| Phone (`capture.ts`) | In rolling mode: no phase rotation and no stride reconfigures. Coverage becomes the set of decoded ids. Stop and dwell UI comes from coverage. Per-channel capture (`channelCapture.ts`) gets the same switch. |
| Rate negotiation | `D` is in code cycles, so it follows the negotiated bit period automatically: at 40 ms bits and 4 symbols, `D = 3` is about 1.1 s per dwell. |

## Test plan

- Kernel property tests, exhaustive over `S ∈ 2..6`, `A ∈ 3..6`, LED counts up
  to 600, and a long frame range:
  - every frame: lit LEDs pairwise at least `S` apart;
  - every LED: at least `D−1` whole own cycles lit per two periods;
  - every frame: at least `(D−1)/D − ε` of lit LEDs are mid-dwell;
  - lamp (Rust) and phone (wasm) agree, pinned by goldens.
- Simulation: the decode-yield link sim (`web/tests/linkSim.ts`) with rolling
  vs phased schedules, comparing decodes/s and the minimum live-track count
  over time.
- Solver: `solver/src/scenario.rs` rolling-stride scenario, with and without
  bridges.
- Device: DemoPixieLamp hand-held v2 maps, phased vs rolling, at the
  negotiated rate; HITL scanner rigs once built.

## Open questions

1. Boundary rule: later-started block yields (proposed), a guard LED, or a
   monotone wave?
2. `D`: 3 cycles (two thirds of lit LEDs mid-dwell, needs the pilot and two
   confirmations inside 2–3 cycles) or 4 (more margin, slower coverage)?
3. Drop bridge phases outright in rolling mode, or keep one bridge period as
   insurance until the solver scenarios confirm?
