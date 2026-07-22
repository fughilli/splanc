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
