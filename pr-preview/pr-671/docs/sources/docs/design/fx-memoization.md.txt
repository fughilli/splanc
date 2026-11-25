# FX memoization: per-frame hoisting and the per-LED cache

**Question (user):** *Can the JIT decide on constant propagation? For a
cylindrical texture mapping we might want to memoize `atan2(pos.x, pos.z)`.*

**Answer:** yes, it is memoized now, but the compiler decides it rather than the
JIT. The compiler's variance pass (`fx_compiler/src/memo.rs`) proves which
`shade()` subexpressions can't change per frame or per LED and rewrites the
bytecode. The VM (`firmware/fx_vm`) runs the result, and the firmware gives the
per-LED cache whatever arena RAM is spare. `atan2(led.pos.x, led.pos.z)` becomes a
table load. `sin(time * speed)` is computed once per frame instead of once per LED.

## Why the compiler decides, not the JIT

| | compiler (static) | on-device JIT (speculative) |
|---|---|---|
| Knowledge | Whole program: data flow of every value, every reader of every local | One straight-line integer block at a time |
| Soundness | Exact: "depends only on `led.pos`" is a syntactic property of the bytecode | Would need guards plus de-optimization when a guess fails |
| Where the win is | Soft-float `atan2`/`length`/`pow` (~1,000–1,800 cycles each on the FPU-less C6) | Integer/fixed ops only; it can't compile soft-float calls |
| RAM / flash | Runs on the host; costs nothing on the device | Planner scratch is ~1.4 KB and the exec region 2 KB |
| Testability | Differential tests on the host: cached and uncached builds are bit-identical | Hardware-in-the-loop only |

The one thing only the device knows is **how much RAM is free** and **how many
LEDs the map has**. So that part stays at load time. The compiler emits the cache
groups in priority order. The firmware binds the largest prefix that fits in the
deck's spare arena (`Program::led_cache_fit`), and binds nothing when the arena
is full. The JIT keeps compiling the integer blocks around the cache ops. A
cache hit's skip target is treated as a branch target, so no JIT block spans it.

## Variance analysis

Every value `shade()` pushes is classified by abstract interpretation of the
operand stack within each basic block:

| class | depends on | done with it |
|---|---|---|
| Const | literals, the topology graph | hoisted (if not folded) |
| Led | `led.pos/uv/idx/seg/s/branch`, `LoadCtxFix` of those | per-LED cache |
| Frame | `time/dt/frame/led.count/imu/room box`, uniforms, `state` | per-frame prep |
| Dynamic | anything else | left alone |

The join rules are `Const ⊔ x = x` and `Led ⊔ Frame = Dynamic`. A local has a
class only if it is written exactly once in the code `shade()` can run, so loop
counters and reassigned accumulators are Dynamic. `led.dist` follows
`flood_from()` and `led.room` follows the fixture pose, so both are Dynamic.
Buffers, textures and `LoadLocalIdx` are Dynamic.

A value can only move if it has a **range**: a contiguous run of instructions
that computes exactly that value, with no side effects, that never dips below
its starting stack depth. Only code in `shade()`'s own body is rewritten. Code a
user function shares with `update()` is not, because `update()` runs with a
default `Led`.

## Per-frame hoisting (the "prepare" entry)

Frame-class ranges, and constant ranges that weren't folded, move into a
**prepare entry** that writes fresh `state` slots. `shade()` replaces each range
with a `LoadState`. The entry's offset rides in the `.fxb` memo trailer. The
**VM runs it by itself** before the first `shade()` of a frame. It runs it again
whenever the frame changes: program, frame counter, time, dt, LED count, IMU, or
room box. It also re-runs it after `set_uniform`, `run_update` or `set_graph`.
So no host has to change, and the semantics hold for hosts that call `shade()`
without `update()` (most unit tests do). Single-definition locals that the
hoisted code reads are re-derived inside the prep entry.

## Per-LED cache

A Led-class range is bracketed like this:

```
LoadLedCache slot,n,+skip   ; hit: push the n cached words, jump past the store
<expression>                ; miss: compute as before
StoreLedCache slot,n        ; record the top n words (no pop) + mark the slot filled
```

The words are the raw stack bits, f32 or int/fixed, so a hit is bit-identical to
recomputing. The precision is whatever the expression produced. Each LED's
record holds a 1-bit-per-word validity mask and the words: 1 B + 4 B per word,
so 500 LEDs × 2 words ≈ 4.5 KB. The cache fills lazily: the first frame after a
load or a map change computes and records each value. Values under branches fill
the first time that branch runs.

The firmware (`firmware/player_app/ffi.rs`) gives each deck the tail of its
FX_ARENA slice, after its buffers' worst-case need. Deck B reserves up to half
the spare arena when it loads. Deck A's cache shrinks or regrows when B claims or
frees the shared region. The cache is re-bound (emptied) on:

- map upload;
- topology upload (`reset_topo_cache`);
- an LED-count change;
- any deck (re)bind.

Caveat: the cache is keyed by `led.idx`. A host that shades one index with
changing positions, without a map upload, must call
`Vm::invalidate_led_cache()`.

## Cost model and budget

`memo.rs::op_cycles` is a C6 cycle model, the same table as the app's default
cost table (see Calibration). A candidate is kept only if:

- **Hoist:** the range costs at least 60 cycles more than the `LoadState` that
  replaces it. A lone uniform load or broadcast stays put.
- **Cache:** it saves at least `min_memo_saving` = 150 cycles per LED per frame
  over a cache hit.

Cache candidates compete for `max_led_cache_bytes` = 16 B per LED by cycles
saved per byte. Identical expressions share a slot. Losers are reported as
`over_budget`. `fx_compile --disasm` prints the decisions, and `--no-memo`
disables the pass for A/B runs.

## Calibration

The old default cost table priced PushConst/LoadLocal at 2–3 cycles and had no
dispatch term. The offline walker also **stopped at the first opcode numbered 70
or above**: every fixed-point op and every FUG-125 superinstruction. So an effect
made of many cheap and fixed ops was estimated at ~3 ms and ran at 132 ms on a
500-LED C6.

Fixes:

- **Model form:** `Σ ops × @dispatch + Σ lane-weighted ops × cost[op]`. Fitted by
  relative least squares to the 72-program fx_bench bundle
  (`web/tests/testdata/device-bench-esp32c6.json`): rms 0.4%, worst 1.5% in
  sample. Dispatch is 69 cycles per op, and a slot move is 18 cycles per word.
- **Default table:** 4.5% rms over the whole bundle.
- **Per-device fits:** the fit subtracts every seeded (unfitted) cost,
  `@dispatch` included, before solving, so a fitted op cost is its compute
  alone — the same form the estimator prices. The held-out RMS of the
  per-device fit dropped from 12.2% to 1.7% (the hardware test's gate went from
  13% to 6%).
- **Walker:**
  - knows opcodes 70–109 (BrCmpI as a branch; LoadLedCache takes the
    steady-state hit path);
  - prices the prep entry once per frame;
  - walks a structured if/else once instead of once per path;
  - follows counted `for` loops for their real trip count, using known-int
    locals and known uniform values.
- **Calibration runs:** the calibration micro-benchmarks compile with the memo
  pass off (fx_bench already uses `--no-opt`; the browser uses
  `fx_compile_no_memo`), so they measure the op and not a cache hit. Fits use
  relative (1/measured²) least squares so cheap programs count as much as dear
  ones.

C6 cycles per op (dispatch included), from the fit:

| op | cycles | op | cycles |
|---|---|---|---|
| PushConst | 69 | atan2 | 1,038 |
| LoadLocal (scalar) | 87 | pow | 1,810 |
| Add / Sub / Mul | 193 / 200 / 195 | sin / cos (LUT) | 573 / 646 |
| Div | 347 | sqrt | 683 |
| Length (vec2) | 701 | Normalize (vec3) | 1,584 |
| Hash1 | 184 | Hsv2Rgb | 1,311 |

The integer/fixed ISA was **measured** on the C6 for this PR with M/2M chains
(32 vs 64 statements, 128 LEDs; known costs subtracted). These are the compute
extras on top of the 69-cycle dispatch:

| op | extra cycles | op | extra cycles |
|---|---|---|---|
| AddI | 32 | Atan2Fix (LUT) | 279 |
| MulFixN | 45 | SqrtFix | 414 |
| SinFix (LUT) | 79 | FixFromF (soft-float convert) | 249 |

The other int/fixed rows are set by analogy to these (marked in
`costTableStore.ts`). The old seeds (4–150) were 2–8× too low.

## Results

On-device (HITL `fx_bench_netstack`, rig-1 C6 @160 MHz, interpreter, 500
LEDs, one firmware; each effect compiled optimized with and without the pass;
window-minimum frame cycles = update + shade):

| effect | memo off | memo on | change | LED cache RAM |
|---|---|---|---|---|
| cylinder (atan2 + length + `sin(t)`) | 4,904,229 cy = 30.7 ms | 3,112,015 cy = 19.5 ms | **−36.5%** (−3,584 cy/LED) | 2 words → 4.5 KB of spare arena |
| rain (user's, hand-cached clouds) | 3,736,880 cy = 23.4 ms | 3,683,721 cy = 23.0 ms | −1.4% | 4 words → 8.5 KB of spare arena |

The extra static RAM is 9 B of statics plus ~24 B per deck VM; the cache
itself only uses arena that was already reserved and idle.

An earlier rain run regressed by +1.2%. Its 12-word prep frame-key compare
cost ~90 cycles on every LED. The key is now 3 words, and a prep entry is only
emitted when its hoists save at least 150 cycles per LED.

Host results:

- 99 corpus programs (calibration benchmarks, demos, examples, library seeds,
  rain, cylinder): **0 mismatches** between cached and uncached RGB, across 8
  frames, three cache modes (full / unbound / starved) and a map change.
- 88 of the 99 were transformed.
- The FUG-125 optimizer hill-climb corpus (`fx_compiler/tests/optimizer.rs`,
  cache bound as on the device) retires 20.3% fewer ops than unoptimized
  bytecode over 4 frames, the first of which fills the cache.
- Cylinder: ~4,160 C6 cycles per LED per frame saved (atan2 + length cached;
  `t` and `sin(t)` hoisted). The offline estimate at 500 LEDs drops from
  38.5 ms to 25.6 ms.
- Rain: ~330 cycles per LED. Its clouds change every frame, so only the column
  index (`min(int(ux*16), 15)`) is LED-invariant. Its hand-rolled 1/16 cloud
  cache is still the right tool for slow per-frame state.

## Not done / follow-ups

- **Literal narrowing.** `fixed x; x * 0.6` silently promotes `x` to soft-float.
  Narrowing the literal to fixed automatically would change results, and for
  `sin` the meaning too: `sin` on a fixed value takes turns, not radians. It
  should be a compiler perf hint, not a silent rewrite.
- **User functions.** Helper bodies aren't memoized (`cyl(led)` helpers called
  from `shade()`); inlining or per-call-site analysis would cover them.
- **wasm preview.** The browser preview binds no LED cache. That is correct,
  because the original code runs, but it isn't faster.
