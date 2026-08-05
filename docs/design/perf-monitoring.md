# Design: Effects performance monitoring

Status: **proposed**. Implements the `## PERFORMANCE MONITORING` section of
`next_steps.md`. Depends on the effects runtime (`effects-runtime.md`): the
metrics come from instrumenting **that** VM (hybrid `update()` / `shade()`,
stack-based f32 slots, soft-float on the C6). This doc does **not** redesign the
VM; it adds counters around it, a protocol channel to stream them, an app-side
perf panel, an offline cost model that predicts frame time from a compiled
`.fxb` without a device, a calibration flow to keep that model honest, and an
AI loop that consumes the metrics to suggest script edits.

The design deliberately mirrors the existing `FrameTiming` / `FrameTick` path
(see `shared/protocol/proto/ledmapper.proto`): integer-only firmware units,
drain-on-poll semantics, an explicit `dropped` counter. Perf monitoring is the
same shape one level up — timing the effects VM instead of the mapping-pattern
emitter.

---

## Goal

1. Give the user (and the AI) a truthful, real-time picture of where an effect
   spends its 33 ms frame budget on the C6 — split by phase (`update` vs
   `shade`), with instruction counts, stack depth, heap, and dropped frames.
2. Predict that same picture **offline**, from a compiled `.fxb` alone, using a
   calibrated per-opcode cost model — so a user editing a shader in the browser
   with no device plugged in still sees "this will overrun at 256 LEDs."
3. Keep the offline model accurate by measuring it against real hardware
   (calibration), not by guessing constants.
4. Feed metrics + script into the agent so it proposes concrete, measurable
   optimizations and can verify them against the next sample.

Non-goals: a general profiler for arbitrary firmware; sub-opcode
microarchitectural modeling (cache/branch prediction — the C6 is in-order with
no data cache, so a linear per-opcode model is adequate); modeling the FastLED
DMA/RMT transmit time (measured as one lumped constant, not per-LED-attributed).

---

## Metrics collected + cheap sampling

### What the firmware measures

Per rendered effect frame, around the render task that already runs
`update()` then `shade(led)` for each LED:

| Metric | Unit | Source |
| --- | --- | --- |
| `update_cycles` | CPU cycles | cycle counter delta around the single `update()` call |
| `shade_cycles` | CPU cycles | cycle counter delta around the whole per-LED `shade` loop |
| `frame_cycles` | CPU cycles | delta across the full effect frame (update + shade + buffer writeout, **excludes** the FastLED transmit, which is measured separately as `show_cycles`) |
| `show_cycles` | CPU cycles | delta around `FastLED.show()` (DMA/RMT push) |
| `led_count` | count | LEDs shaded this frame (≤ 256) |
| `instr_update` | count | opcodes retired in `update()` |
| `instr_shade` | count | opcodes retired across all `shade()` calls this frame |
| `stack_max` | f32 slots | high-water VM operand-stack depth this frame |
| `overruns` | count | frames whose `frame_cycles + show_cycles` exceeded the 33 ms budget, since last drain |
| `dropped_frames` | count | frames the render task skipped because it fell behind schedule, since last drain |
| `heap_free` | bytes | `esp_get_free_heap_size()` |
| `heap_min_free` | bytes | `esp_get_minimum_free_heap_size()` (low-water) |

Cycles are the native unit because the C6 has a free-running cycle counter and
because the cost model (below) is expressed in cycles/opcode. The app converts
to ms with the known core clock (≈160 MHz → 1 ms ≈ 160 000 cycles), carried
once in the stream header (`cpu_hz`) so we never hardcode it.

The 33 ms budget = 1 / 30 fps. `headroom_cycles = budget_cycles - (frame_cycles
+ show_cycles)`; negative headroom is an overrun.

### Cheap sampling

The instrumentation must not perturb what it measures. Rules:

- **Timing = two cycle-counter reads per span.** Use `esp_cpu_get_cycle_count()`
  (single CSR read, a handful of cycles) at the top/bottom of `update()`, of the
  `shade` loop, and of `show()`. `micros()` is derived from the same counter but
  costs a division; prefer the raw counter and subtract. Four spans/frame → ~8
  reads/frame, negligible against ~230k float ops/frame.
- **No per-LED timing.** We never time individual `shade(led)` calls — that
  would add a counter read to the hottest inner loop 256× per frame. We time the
  loop as a whole and divide by `led_count` when a per-LED figure is wanted.
- **Instruction counts are opt-in and cheap-by-construction.** The VM's dispatch
  loop increments a `u32` counter once per opcode (`instr++` next to the program
  counter advance — one add, no branch). `stack_max` piggybacks on the existing
  stack-pointer update: `if (sp > sp_max) sp_max = sp;`. Both live in the
  interpreter's hot struct, already in registers/L1-less SRAM.
- **Two build/runtime tiers.** A compile-time `FX_PROFILE` gate:
  - **Tier 0 (always on):** the four cycle spans + heap + overrun/drop counters.
    Cost is a few cycle reads per frame — always safe to leave in.
  - **Tier 1 (toggled):** per-opcode instruction counting and `stack_max`.
    Enabled via a `set_perf(mode)` control (below) only while a perf panel is
    open, because the `instr++` is in the dispatch loop. Even so it's a single
    add; measured overhead target < 3% of frame time, verified during
    calibration (we can compare `shade_cycles` with Tier 1 on vs off).
- **Aggregation, not per-frame streaming.** The render task writes each frame's
  sample into a small fixed **ring buffer** in RAM (like `FrameTick`s). It does
  **not** send per frame. A separate, lower-priority path drains the ring on a
  timer / on poll and ships a batch. This keeps the render task free of any
  network work and bounds jitter.
- **Downsampling under load.** The ring holds N (say 64) recent frames. If the
  phone polls slower than we fill it, we keep the newest and bump `dropped` —
  same overflow discipline as `FrameTiming.dropped`. The app sees "we lost K
  samples" rather than silently smoothed data.

### Rollup vs raw

Two granularities travel in the stream:

- **Per-frame ticks** (ring-buffered): the newest ≤64 frames, for the live graph.
- **A rolling window summary** computed on-device cheaply (running min/mean/max
  + overrun/drop totals over ~1 s): so even a single poll shows a stable
  headroom number and the AI gets a denoised value, not one noisy frame.

---

## Transport & protocol additions

Reuse the drain-on-poll pattern of `GetFrameTiming` / `FrameTiming` exactly.
Perf is firmware↔phone only, so like `FrameTiming` it carries the firmware's
**native integer units** (cycles, bytes, counts) — no soft-float `f64` on the
device. Field numbers below continue the existing envelopes (next free client
arm `21`, server arm `16`).

### Control: turn the stream on/off and pick the tier

```proto
// Client -> server. Configure effect perf instrumentation. mode selects the
// instrumentation tier; interval_ms asks the device to push a perf_report
// unsolicited every interval_ms while a panel is open (0 = poll-only, phone
// pulls with get_perf_report). Reply: perf_report (immediate, current window).
message SetPerf {
  enum Mode { OFF = 0; BASIC = 1; FULL = 2; }  // OFF, Tier0, Tier0+Tier1
  Mode mode = 1;
  uint32 interval_ms = 2;   // 0 = poll-only; else server streams
}

// Client -> server. Drain the perf ring + current window now. Reply: perf_report.
message GetPerfReport {}
```

### Data: the report

```proto
// One instrumented effect frame. All integer, native firmware units.
message PerfFrame {
  uint32 seq = 1;             // effect frame index since effect (re)load
  uint32 update_cycles = 2;
  uint32 shade_cycles = 3;
  uint32 frame_cycles = 4;    // update + shade + buffer writeout (excl. show)
  uint32 show_cycles = 5;     // FastLED.show()
  uint32 led_count = 6;
  uint32 instr_update = 7;    // 0 unless FULL mode
  uint32 instr_shade = 8;     // 0 unless FULL mode
  uint32 stack_max = 9;       // f32 slots; 0 unless FULL mode
}

// Reply to get_perf_report / set_perf, and the unsolicited push when
// interval_ms > 0. Drains the ring (ticks) and carries a rolling-window
// summary so a single message is enough to render a stable panel.
message PerfReport {
  // --- identity: which effect these numbers belong to ---
  string effect_id = 1;       // active .fxb id ("" if none)
  uint32 fxb_hash = 2;        // truncated hash of the loaded bytecode; the app
                              // pins metrics to the exact compiled script so a
                              // hot-reload can't mis-attribute a frame
  // --- clock so ms conversion never hardcodes the core freq ---
  uint32 cpu_hz = 3;          // e.g. 160000000
  uint32 budget_cycles = 4;   // 33ms * cpu_hz (target frame budget)

  // --- rolling window (~1s), min/mean/max in cycles ---
  uint32 frame_cycles_min = 10;
  uint32 frame_cycles_mean = 11;
  uint32 frame_cycles_max = 12;
  uint32 update_cycles_mean = 13;
  uint32 shade_cycles_mean = 14;
  uint32 show_cycles_mean = 15;

  // --- counters since last drain ---
  uint32 overruns = 20;
  uint32 dropped_frames = 21;
  uint32 samples_dropped = 22; // ring overflow (phone polled too slowly)

  // --- memory ---
  uint32 heap_free = 30;
  uint32 heap_min_free = 31;

  // --- raw ticks for the live graph (newest last) ---
  repeated PerfFrame ticks = 40;
}
```

Envelope wiring:

```proto
// ClientMessage.oneof
SetPerf set_perf = 21;
GetPerfReport get_perf_report = 22;

// ServerMessage.oneof
PerfReport perf_report = 16;
```

`effect_id` + `fxb_hash` are load-bearing: the perf panel and the AI must know
metrics belong to the *currently running* compiled script. On `set_effect` /
recompile the device resets `seq`, clears the window, and stamps the new
`fxb_hash`; the app discards in-flight ticks whose hash differs.

The existing status/heap log line the device already emits stays as-is; this is
the structured, machine-readable superset the app and agent consume.

---

## Real-time UI (device connected)

A **perf panel** in the mapping-workspace effects view, visible whenever a
device is connected and an effect is running. Opening it sends
`set_perf(FULL, interval_ms=250)`; closing it sends `set_perf(OFF)` so Tier 1
instrumentation isn't paid for when nobody's looking.

Panel contents, all tied to the running effect (`effect_id` shown in the
header):

- **Frame-time graph.** Scrolling line/area chart of `frame_cycles + show_cycles`
  per tick, converted to ms via `cpu_hz`. A horizontal **budget line at 33 ms**.
  Bars/area above the line are red (overrun). ~64-frame window ≈ 2 s at 30 fps.
- **Per-phase breakdown.** A stacked view (or three sub-series) of `update`,
  `shade`, `show` so the user sees which phase dominates. Typically `shade`
  (per-LED × 256) is the tall bar; `show` is a near-constant transmit floor.
- **Headroom gauge.** `budget - (frame_mean + show_mean)` as ms and % of budget.
  Green > 30% headroom, amber 0–30%, red negative. Uses the **window mean**, not
  a single noisy frame, so the number is stable.
- **Overrun / drop warnings.** A badge with `overruns` and `dropped_frames`
  since the panel opened, plus a transient toast the first time headroom goes
  negative ("Effect overruns the 30 fps budget at 256 LEDs"). If
  `samples_dropped > 0`, a subtle "metrics thinned under load" note so the graph
  isn't misread as complete.
- **Detail readout** (FULL mode): `instr_shade / led_count` = ops per LED,
  `instr_update`, `stack_max` (against the VM's max stack), heap free /
  min-free. These are the levers the AI acts on.

The panel subscribes to `perf_report` pushes; if `interval_ms == 0` it falls
back to polling `get_perf_report` on a UI timer. The same chart component is
reused by the offline model (below) with a "predicted" styling (dashed) so
online-vs-predicted read consistently.

---

## Offline device model (cost table + estimation)

Goal: with **no device**, estimate an effect's frame time from its compiled
`.fxb`. The browser already has the compiler and the VM (wasm); it also has the
current map (LED count + positions). The model turns "what opcodes does this
program run, and how many times" into cycles.

### Model form

Frame time is modeled as **linear in opcode execution counts** plus fixed
per-phase and per-LED overheads:

```
frame_cycles_est =
    update_fixed
  + Σ_op ( count_update[op]  * cost[op] )          // update() runs once
  + led_count * (
        shade_fixed                                 // per-LED loop overhead:
                                                    //   call/ret, ctx load, buffer store
      + Σ_op ( count_shade_per_led[op] * cost[op] ) // shade() body, per LED
    )
show_cycles_est = show_fixed + led_count * show_per_led   // FastLED transmit
total_est = frame_cycles_est + show_cycles_est
```

Where:

- `cost[op]` — a **per-opcode cycle cost table**, one entry per VM opcode
  (`PushConst`, `Add`, `Mul`, `Sin`, `Dot`, `MakeVec`, `LoadUniform`,
  `BrFalse`, `Call`, …). Soft-float ops are expensive and dominate: expect
  `Mul`/`Div` ≫ `Add`, transcendentals (`Sin`, `Exp`, `Pow`, `Log`) the most
  costly; integer/branch/stack ops cheap. Vector ops are element-wise, so their
  cost ≈ N × the scalar op (the table can store them expanded, or store scalar
  costs and multiply by lane count from the opcode's size field).
- `update_fixed`, `shade_fixed`, `show_fixed`, `show_per_led` — measured
  overhead constants (function-call framing, buffer writeout, DMA setup).

All constants come from **calibration** (next section), stored as a versioned
JSON `cost table` keyed by `{soc: "esp32c6", cpu_hz, table_version}` and shipped
with the app (with the last on-device calibration overriding it).

### Getting the opcode counts

Two count vectors are needed. The compiler/`.fxb` gives us both:

- **`count_update[op]` — static, exact-ish.** `update()` is straight-line-ish
  with only compile-time-bounded `for` loops (the VM forbids unbounded loops on
  the hot path). The browser **abstract-interprets** the `update` bytecode:
  walk the CFG, multiply basic-block opcode counts by their loop trip bounds
  (known at compile time), and for data-dependent branches assume the worse arm
  (or both, flagged as a range). Result: a per-opcode count for one `update()`.
- **`count_shade_per_led[op]` — the crux.** `shade` is per-LED and can branch on
  `led.pos`, so a purely static count is a *range* (min/typical/max over the
  branch space). Two estimators, both offered:
  1. **Static bound:** same abstract interpretation as `update`, giving a
     worst-case (all expensive arms taken) and best-case count → a predicted
     frame-time **band**, not a point. Zero execution; instant; conservative.
  2. **Dynamic profile (preferred when a map is loaded):** run the **same wasm
     VM** that already powers the preview over the **actual map's LED
     positions**, with Tier 1 instruction counting compiled into the wasm build.
     This yields the *real* executed opcode histogram for this specific map
     (branch outcomes resolved by real positions), summed across LEDs → divide
     by `led_count` for per-LED. This is exact for the executed path and is
     essentially free because the preview already iterates every LED each frame;
     we just also accumulate the opcode histogram once (or every K frames if
     `update` state changes which branches fire).

The dynamic profile is the headline: **the browser already runs the VM for the
preview**, so counting opcodes there costs one extra `instr++` per opcode in the
wasm — the same instrumentation as firmware Tier 1 — and gives a per-map-accurate
count. Multiply that histogram by the calibrated cost table → predicted cycles →
predicted ms and predicted headroom, rendered in the **same perf panel** with
dashed "predicted" styling. When a real device later connects, online and
predicted overlay for a sanity check.

### Accuracy expectations

The C6 is in-order, no data cache, so a linear opcode-cost model is a good fit
and we expect prediction within a small percentage of measured (validated during
calibration by predicting a held-out benchmark and comparing). The dominant term
is soft-float in `shade` × `led_count`; getting the float-op costs right matters
most. Known unmodeled effects (function-call overhead variance, RMT jitter) are
folded into the fixed constants and the residual is reported so users know the
error bar.

---

## Calibration flow

The cost table is only as good as its constants. Calibration **measures** them
on a real device by running known bytecode and fitting.

### Micro-benchmarks

A set of tiny, hand-authored `.fxb` **calibration programs**, each isolating one
cost:

- **Per-opcode isolation:** a shader whose `shade` is a long unrolled chain of a
  single opcode repeated M times over a trivial value (e.g. M `Mul`s, M `Sin`s,
  M `Add`s). Two variants with M and 2M reps: the **slope** `(cycles_2M -
  cycles_M) / M` isolates that opcode's cost, cancelling all fixed overhead. Run
  for each opcode of interest (the expensive float ops especially; cheap ops can
  share a coarser bucket).
- **Fixed-overhead isolation:** an empty `shade` (`return vec3(0)`) and an empty
  `update` → measures `shade_fixed` (per-LED loop framing) and `update_fixed`.
- **Per-LED / transmit isolation:** sweep `led_count` (e.g. 16, 64, 128, 256)
  with a fixed trivial shader; regress `frame_cycles` and `show_cycles` vs
  `led_count` → the per-LED slope (`shade_fixed`-adjusted) and `show_per_led`,
  `show_fixed`.
- **Vector-lane check:** the same op at 1/2/3/4 lanes to confirm the
  element-wise ×N assumption (and catch any per-op fixed cost).

These ship as data (part of the app), pushed to the device with the normal
`submit_effect` path, selected with `set_effect`, and measured via the same
`PerfReport` stream — no special firmware mode beyond FULL instrumentation.

### Fit

For each benchmark the app collects a stable window (mean over ~1 s, discarding
warmup frames) and solves the small linear system:

- Opcode costs from the two-point slopes (or a least-squares fit over
  multiple M values if we want error bars).
- Fixed/per-LED constants from the `led_count` regression.

Output: a new versioned cost table stamped with `{soc, cpu_hz, firmware_build,
timestamp, residual_error}`. It supersedes the shipped default for that SoC.
Store it locally (and optionally sync so all the user's sessions share it).

### Calibration UX

A one-tap **"Calibrate this device"** action in the perf panel / device
settings, available when connected:

1. Explain ("Runs ~30 s of tiny test effects to learn how fast this board is —
   your current effect will resume after"). Confirm.
2. Progress bar as it cycles through the benchmark `.fxb`s, uploading, selecting,
   sampling each. Show live "measuring `Mul`… 41 cyc" ticks so it feels honest.
3. On finish: a **before/after accuracy** readout — re-predict a held-out
   benchmark with the new table and show predicted-vs-measured error ("model now
   within X%"). Restore the user's previous effect + uniforms.
4. Persist the table; badge the offline predictions with "calibrated on <device>
   <date>" vs "using default model" so the user knows the trust level.

Recalibrate prompts when: firmware build changes (`fxb`/build id in
`PerfReport`), a new SoC connects, or measured-vs-predicted drift exceeds a
threshold while a device is connected (we're always cross-checking online vs the
model and can flag "predictions drifting, recalibrate?").

---

## AI optimization loop

The agent's job: given metrics (real or predicted) + the script, propose
concrete edits that reduce frame time, then verify them on the next sample.

### What the agent ingests

A compact, structured **perf context** assembled by the app (not raw ticks):

- **Source** of the effect + its compiled `.fxb` **manifest** (uniforms, entry
  points).
- **Metrics summary:** the window means/max from `PerfReport` (online) or the
  cost-model estimate (offline), both normalized to the same schema so the agent
  doesn't care which it got — with a `source: measured|predicted` and, offline,
  the error band. Key fields: total ms vs 33 ms budget, `update` vs `shade` vs
  `show` split, **ops-per-LED**, `stack_max`, heap headroom, overrun/drop counts.
- **Hot-opcode histogram:** the per-opcode execution counts (from firmware FULL
  mode or the wasm profile) × their calibrated cost, sorted by contribution —
  i.e. "these opcodes cost the most cycles." This is the single most actionable
  input: it points the model straight at the expensive lines. Where possible the
  compiler maps hot opcodes back to source spans so the agent can cite lines.
- **The cost table** (or at least the relative op costs) so the agent reasons
  with the device's actual economics: on this SoC `Sin`/`Div`/`Pow` are dear,
  `Add`/branches cheap, everything in `shade` pays ×`led_count`.

### System-prompt knowledge

The agent's effects system prompt (shared with the generation flow in
`effects-compiler`) is extended with an **optimization playbook** grounded in
this VM's economics:

- Move loop-invariant / non-per-LED work from `shade` into `update` (it runs 1×
  vs 256×).
- Prefer cheap builtins: `step`/`mix`/polynomial approximations over
  `sin`/`pow`/`exp`; precompute constants; avoid `normalize`/`length` (hidden
  `sqrt`) where a squared compare suffices.
- Reduce per-LED float ops; where precision allows, suggest fixed-point (Q16.16)
  patterns — consistent with the runtime doc's note that the ISA is
  width-agnostic and fixed-point is the sanctioned next optimization.
- Hoist redundant swizzles/`MakeVec`; reuse subexpressions (the compiler is
  simple and won't CSE for you).
- Respect the per-frame **instruction budget** (the runtime's hard frame-time
  bound) — flag scripts near it.

### The loop

1. User (or the panel's "Optimize" action) asks the agent to speed up the effect.
2. App hands over the perf context + source. Agent proposes an edited script
   **and a predicted improvement** ("~35% fewer shade ops; ~22 ms → ~15 ms").
3. The app **compiles the edit in-browser** and immediately re-runs the **offline
   cost model** (no device needed) to check the prediction — a fast, free
   verification gate. Reject/iterate if it didn't actually improve.
4. If a device is connected, hot-reload the `.fxb` (`submit_effect` /
   `set_effect`) and read the next `PerfReport`; show measured before/after in the
   perf panel. The `fxb_hash` guarantees the numbers belong to the new script.
5. Present a diff + before/after headroom; user accepts or iterates. The measured
   result (or model estimate) feeds back as the metrics for the next round, so
   the loop is closed and self-correcting.

Because online and offline metrics share one schema, the exact same agent loop
runs with or without hardware — offline it optimizes against the calibrated
model; online it optimizes against ground truth and also **re-validates the
model** as a side effect.

---

## Open questions

- **Branch-dependent `shade` counts.** Static counting gives a band; the wasm
  dynamic profile gives the real path but only for the current uniforms/map. Do
  we profile once, on uniform change, or every N preview frames? (Lean: profile
  on load + on uniform change, since uniforms can flip branches.)
  DECISION: agree, profile both
- **Opcode granularity of the cost table.** Per-opcode for the expensive float
  ops for sure; do cheap ops (stack/branch/int) get individual costs or one
  shared "cheap" bucket? Fewer benchmarks vs finer accuracy.
  DECISION: can explore this--start with fewer benchmarks and see what the fit loss is
- **Vector cost model.** Store expanded per-lane costs, or scalar cost × lane
  count from the opcode size field? The lane-check benchmark decides whether a
  per-op fixed component exists.
  DECISION: scalar cost x lane count
- **`show` attribution.** Model FastLED transmit as `show_fixed + per_led`, or
  measure it as one lumped constant per LED count? WS2812 timing is fixed per
  LED, so `per_led` should be near-exact — confirm it isn't contention-dependent.
  DECISION: we may support other LED types in the future as a runtime configuration option--should be able to model different LED types which may have variable per-frame timing
- **Tier 1 overhead honesty.** The `instr++` cost should be measured (Tier 1 on
  vs off during calibration) and *subtracted* from reported cycles, so FULL-mode
  numbers match BASIC-mode reality. Is one global correction factor enough?
  DECISION: one global correction factor probably enough--can check r^2 to see after we build out
- **Instruction budget vs `for` bound.** The runtime doc leaves open whether the
  hard frame bound is a compile-time loop cap or a global per-frame instruction
  budget. If it's an instruction budget, the perf stream should also report
  budget consumed / remaining per frame — cheap, and a great AI signal.
  DECISION: see other doc. We'll want to estimate how much of the budget we've consumed (preferably in terms of wall time using our model)
- **Where residual/error bars live.** Do we surface the model's error band in the
  UI always, or only when uncalibrated? (Lean: always show it offline; hide once
  calibrated within threshold.)
  DECISION: always surface--error bars should be smaller once calibrated. Use error bars to determine confidence level -> colorization of the report (red=unlikely to fit, yellow=might fit, green=likely to fit)
- **Multi-SoC.** Cost tables are keyed by SoC; when non-C6 targets appear, is the
  linear model still adequate (in-order assumption) or do cached cores need a
  richer model?
  DECISION: other cores might need a richer model. Let's not worry about that for now, we can always revisit when we support other cores. Make sure there's some way to save/restore models and that the save files have some metadata, perhaps even including the direct experimental observations so they can be rederived if the modeling approach changes.

---

## FUG-11: portable profiles, semihost benchmark, and the budget bar

FUG-11 turns the offline model above into a *portable, target-agnostic* pipeline
and adds an available-budget signal the AI can optimize against.

### Common execution-profile format

Every execution target emits the **same** versioned JSON artifact — an
`ExecutionProfile` (`web/src/effects/executionProfile.ts`, mirrored by the Rust
`tools/fx_semihost_bench`): provenance (`source: device|semihost|default`, `soc`,
`cpuHz`, `unit: cycles`, tool/build/timestamp), the per-opcode `costs` (keyed by
the canonical VM opcode names, 0..=`ExpFix`), `fixed`/per-LED overheads, the
`budget` model (below), a `residualError`, and the raw `observations` so the fit
is re-derivable if the modelling form changes. The simulator consumes any
profile uniformly (`profileToCostTable`), and a profile persists through the
existing cost-table store (`profileToStored`, `origin: semihost|calibrated`),
so a device calibration supersedes a semihost seed for the same SoC.

### Semihost benchmark (no hardware)

`tools/fx_semihost_bench` runs the **real** firmware VM (`ledmapper_fx_vm`)
natively over single-opcode calibration micro-programs and fits a per-opcode
cost model via a least-squares slope over multiple rep counts. Because the host
executes the exact same dispatch loop as the C6, the interpreter **dispatch** and
fixed **framing** costs are measured directly; the FPU-less C6's **soft-float**
arithmetic cannot be represented on an FPU host (there `sin ≈ add`), so each
opcode's cost is split `cost = dispatch(measured) + softfloat(modeled)`, the
measured host-ns are pinned to device cycles via an anchor opcode, and the
profile is stamped `source: semihost` with a deliberately wide residual until an
on-device (or cycle-accurate-emulator) profile refines the arithmetic terms. The
deterministic core (program builders, fit, serde) is unit-tested; the wall-clock
timing lives in the CLI.

### Available-execution-budget model + the budget bar

The frame period is not all the FX engine's: transmit (`show`) and other system
tasks (wss, scheduler) eat into it. The `BudgetModel` (`fps`,
`cpuAvailableFraction`, `transmitReservesCpu`) yields the CPU actually available
to `update()`+`shade()`:

```
frameMs          = 1000 / fps
systemReservedMs = frameMs * (1 - cpuAvailableFraction)
availableFxMs    = frameMs - systemReservedMs - showMs
```

`cpuAvailableFraction` is modeled offline and *measured* on-device
(`measureAvailableFraction`, from the mean per-frame time spent outside the
effect+transmit). `budget.ts` turns an offline estimate or an on-device
PerfReport into the same `BudgetStatus` (consumed FX ms / available ms), so the
UI reads identically online and offline.

The **budget progress bar** (`web/src/ui/screens/budgetBar.ts`, in the perf
panel) shows what fraction of the available budget the current program consumes,
color-coded per the FUG-11 spec: **≤70% green, >70% yellow, >90% red** (an
overrun or a starved frame pins red). This is distinct from the headroom gauge
(which colors by whether the *whole* frame fits): the bar is specifically the
FX-engine-vs-available-CPU signal the AI tunes toward a target framerate.

---

## FUG-11: portable profiles, the semihost benchmark & the budget bar

This section is **implemented**. It closes the loop the sections above left open:
a single portable profile format across execution targets, a way to produce one
with no hardware, an *available*-budget model (the frame isn't all the FX
engine's), and the progress bar the issue asks for.

### Common execution-profile format

Every target — a device calibration, the semihost benchmark, or the shipped
default — emits the same versioned artifact, so the simulator, the budget bar,
and the AI loop don't care which produced the numbers. It is the cost table
above plus provenance and the raw observations (the multi-SoC DECISION:
save/restore with metadata + experimental observations so a model can be
re-derived under a new form).

- Schema + (de)serialize + validation: `web/src/effects/executionProfile.ts`
  (`ExecutionProfile`), mirrored by the Rust `ExecutionProfile` in
  `tools/fx_semihost_bench` (serde, camelCase top-level + snake_case `fixed` to
  match `FixedOverhead`). A golden profile at `web/tests/testdata/` pins the
  cross-language contract.
- Fields: `soc`, `source` (`device | semihost | default`), `cpuHz`, `unit`
  (`cycles`), `toolVersion`, `timestamp`, per-opcode `costs`, `fixed`,
  `fallbackCost`, `residualError`, the `budget` model, and `observations`.
- Converts to/from the runtime `CostTable` and bridges into the persisted
  cost-table store (new `semihost` origin).

### Semihost benchmark (no hardware)

`tools/fx_semihost_bench` runs the **real firmware VM** (`ledmapper_fx_vm`)
natively over the same style of single-opcode micro-programs the device
calibration uses, and fits a profile — a usable model with nothing plugged in.

The honest catch, and the "tuning" in the issue title: a native host has an FPU,
so it *cannot* reproduce the FPU-less C6's soft-float economics (on the host
`sin ≈ add`; on the C6 `sin` is ~10× an `add`). So each opcode cost is split:

```
cost[op] = dispatch[op]     (MEASURED: host slope × k, ISA-portable interpreter overhead)
         + softfloat[op]     (MODELED: the C6 soft-float weight the host can't measure)
```

where `k = dispatch_ref_cycles / slope[anchor]` maps host ns → device dispatch
cycles via the anchor op (whose host time is ~pure dispatch). The fixed
per-frame/per-LED overheads are measured directly (empty update/shade). Raw host
observations are retained; the residual is deliberately wide (`source =
semihost`) until a device — or a future cycle-accurate emulator target, which
drops straight into this same format — refines the arithmetic terms. This is why
the format exists: an emulator or on-device run supersedes the semihost profile
without any consumer change.

### Available execution budget + the progress bar

The frame period (1/fps) is not all available to the FX engine: the LED transmit
(`show`) and other system tasks (wss, scheduler, telemetry) eat into it. The
`BudgetModel` (`fps`, `cpuAvailableFraction`, `transmitReservesCpu`) captures
this, and `web/src/effects/budget.ts` computes:

```
frameMs          = 1000 / fps
systemReservedMs = frameMs * (1 - cpuAvailableFraction)   // other tasks
availableFxMs    = frameMs - systemReservedMs - showMs     // for update+shade
consumedFxMs     = updateMs + shadeMs                       // the FX engine
fraction         = consumedFxMs / availableFxMs
```

`cpuAvailableFraction` is modeled offline (default 0.85) and can be *measured* on
a device (`measureAvailableFraction`, from the mean CPU time other tasks spend
per frame). The **progress bar** (`web/src/ui/screens/budgetBar.ts`, wired into
the perf panel) shows `fraction` with the FUG-11 color bands — **≤70% green,
>70% yellow, >90% red** — plus 70/90 threshold guides and an overrun state. The
same bar renders online (device PerfReport phase split) and offline (cost-model
estimate), since both flow through `budgetConsumption`.

---

## FUG-11 (review): device-measured profiles, validation, management, fleet

Follow-up to the section above, addressing the review: the authoritative model
must be **measured on real hardware**, profiles must be **manageable**, and
estimation must span **multiple devices**.

### The host benchmark is a smoke test, not a device model

An FPU host has far too much compute to predict the FPU-less C6 (natively `sin ≈
add`). So `tools/fx_semihost_bench` now emits `source: "host"` and is documented
as a pipeline/format smoke test only. It exercises the common format + the fit
end-to-end in CI with no hardware; it never seeds an authoritative cost table.

### Authoritative measurement via the HITL rig

`pi/hitl/harness/fx_bench.py` runs the benchmark on the **real C6** through the
HITL rig (pi/hitl). It is fully self-contained — it reaches the board the same
proven way the e2e does, because the DUT lives on the rig's WiFi LAN, not the
harness host's network:

1. reserve a free rig from the pool,
2. flash the firmware flash-bundle with a clean FS (`hitl-flash --erase-fs`),
3. **ImprovBLE-provision** the DUT onto the rig's own provisioning AP
   (`provision.py`, shared with the e2e — one implementation of the flaky
   single-core WiFi/BLE join + reset-and-retry),
4. **forward-tunnel** to the DUT's player socket through the rig
   (`hitl forward`; the tunnel's far end dials the DUT from the Pi),
5. per calibration micro-program: **submit a synthetic linear map** of the
   program's Intended-LED-count (`set_led_count` + a `submit_map` of that many
   fixture positions — the shade loop iterates over `lm_map_len()`, so a fresh
   erase-fs board with no map renders nothing and perf stays empty; a real user
   device already has a map, the bench must supply one), `submit_effect` (await
   `result_ready`), `set_perf(FULL)`, settle, drain a stable `PerfReport`.

It writes a **device-measurement bundle** (base64 `.fxb` + cycle-accurate
measured cycles). The loop is resilient to the DUT dropping the socket mid-sweep
(a heavy program under FULL perf can trip the watchdog and reboot): it reconnects
and retries per program, measures the lightest programs first, and keeps partial
results if the board goes unreachable. The pure perf→sample mapping, bundle
schema, and LED-hint parse live in `fx_bench_core.py` and are unit-tested
(`//pi/hitl/tests`, no hardware); `--replay` rebuilds a bundle from a recorded
session.

The calibration micro-programs are committed as `.fx` under
`pi/hitl/harness/benchmarks/` (fit programs) + `*.heldout.fx` (validation). They
are **generated from the in-browser calibration source of truth**
(`web/src/effects/calibrationBenchmarks.ts` via `benchmarkExport.ts`), so the
in-browser and on-hardware runs measure the identical programs — a drift test
(`web/tests/benchmarkExport.test.ts`) pins that, and every file is verified to
compile under `//fx_compiler`. The programs, the `fx_compile` CLI, the `hitl`
CLI, and the firmware flash-bundle all ride in runfiles, so a real run is one
command:

```
# measure on real hardware -> a device bundle. Reserves a rig, flashes + BLE-
# provisions + tunnels automatically; no external network (uses the rig AP).
bazel run //pi/hitl/harness:fx_bench -- \
  --server http://<rig>:8087 --device-key <mac> --device-label "rig-01" \
  --out /tmp/device-bundle.json

# fit + VALIDATE the bundle headlessly through the SAME code path the app uses
# (deviceProfile.buildDeviceProfile) -> an app-importable, authoritative profile.
# Prints the per-program predicted-vs-measured table; nonzero exit if held-out
# RMS exceeds tolerance, so it doubles as a regression gate.
bazel run //web:fit_device_profile -- /tmp/device-bundle.json /tmp/profile.json

# (or, equivalently, in the app: Performance ▸ Manage profiles ▸ "Import device
#  measurements" -> buildDeviceProfile fits + validates and saves it.)
```

Overrides: `--no-bundle` measures whatever is already flashed; `--device-ws
wss://<ip>/ws` skips the rig when the DUT is already reachable; `--ws-scheme
wss`, `--wifi-ssid/--wifi-pass`, `--improv-attempts/--improv-timeout`, `--debug`.

### Validation (predicted vs measured)

`web/src/effects/deviceProfile.ts` `buildDeviceProfile` reuses the calibration
fit for the cost table, then `web/src/effects/profileValidation.ts`
`validateCostModel` predicts the **held-out** programs (named `*.heldout.fx`,
never in the fit) and compares to what the hardware measured — RMS/max relative
error, R², pass/fail. The RMS is stamped as the profile's `measuredError`: the
trustworthy accuracy signal (vs `residualError`, an in-sample fit quality).

**Measured on a real ESP32-C6.** A full sweep captured over the rig (13
isolation programs + 1 held-out, `web/tests/testdata/device-bench-esp32c6.json`)
fits a `source: device` profile whose model predicts the held-out program (a
sin/mul mix at 200 LEDs) at **65.2 ms vs the 58.1 ms the hardware measured —
+12.2%, inside the 15% tolerance → PASS**. The raw cycles show why the host VM
can't stand in: at 128 LEDs and equal instruction counts, `sinM` costs ~6.0 M
cycles vs `addM`'s ~2.4 M — the FPU-less C6 pays dearly for transcendentals that
are ≈free on the host. `web/tests/deviceProfileHardware.test.ts` pins this
predicted-vs-measured gate in CI from the committed bundle, so a VM/opcode/
precision change that breaks the model's real-hardware accuracy fails the build —
no rig needed to re-check. (The in-sample fit residual is wide, ~29%: a single
linear per-opcode model over reduced-precision fixed-point ops is approximate;
the held-out generalization is the number that matters, and it holds.)

### Profile management

`web/src/ui/screens/perfProfiles.ts` (route `/perf/profiles`, from the perf
panel) lists every stored profile ranked device > host > default, with
provenance, fit residual, held-out `measuredError`, and device identity. It
supports export (download JSON), import (a profile file OR a raw device bundle to
fit), and delete. Profiles are keyed per-device (`costTableId` with a
`deviceKey`) so a heterogeneous fleet each keeps its own measured model;
`resolveTable(soc, cpuHz, deviceKey?)` resolves most-specific-first.

### Multi-device estimation

`web/src/effects/multiDevice.ts` `estimateAcrossDevices` estimates one compiled
effect across a set of device targets (each its own profile + LED count),
returning per-device frame time + budget status, the **binding** device (highest
budget fraction), and whether all fit. `describeFleet` renders this — plus the
binding device's hottest opcodes and cut-cost guidance — for the AI generator.

The **estimation fleet** is user-selected: `web/src/store/fleetStore.ts`
persists which stored profiles (+ per-device LED counts) form the fleet, toggled
per row in the profile manager ("Use in AI estimates"). `web/src/effects/fleet.ts`
`resolveFleetTargets` bridges that selection and the stored profiles into
`DeviceTarget`s (self-healing stale ids; falling back to the active device /
default so there's always ≥1 target).

### Wiring the feedback signal into the AI generator

This is the point of FUG-11: the agent needs a framerate signal while it writes
effects. The editor's chat loop (`web/src/effects/ai/generate.ts` `chatTurn`)
exposes a client-fulfilled **`estimate_performance`** tool. The model calls it
after `set_script` when a framerate/budget/optimization goal is in play; the
editor (`effectEditor.ts`) resolves the fleet, runs `estimateAcrossDevices` on
the latest compiled bytecode, and hands back `describeFleet` — each device's
frame time, % of the FX budget used with the green/yellow/red band, the binding
device, and the opcodes to cut. The system prompt tells the model to optimize
for the binding device first, then re-estimate to confirm it fits. Online
(device PerfReport) and offline (cost model) share one schema, so the same loop
runs with or without hardware; per-device calibrations make each fleet member's
estimate as trustworthy as its `measuredError`.
