# WORKLOG

Handoff notes for picking up in-flight work. Git history has the details; this
file orients a fresh session and records what's next. Newest entry on top.

## FX VM hill-climb + effects-AI (branch `kbalke/vm-hill-climb`)

Making effect programs cheaper on the FPU-less ESP32-C6 (RV32IMAC, no FPU → all
f32 is soft-float). Measured on the real rig via the fx_bench HITL.

**Done (all committed, hardware-measured):**

- **effects-AI prompt** now teaches the perf model — fixed-point types
  (`fixed`/`fixed16`/`fixed8`, `: fixed8`/`: fixed16` storage), soft-float cost,
  hoisting to `update()`, and a measured multi-turn optimize loop
  (`estimate_performance` → hypothesis → apply → re-estimate → report).
- **Per-device builtin cost listing** injected into the agent (uncached system
  block) from the device cost table — `builtinCostsToPrompt` in
  `web/src/effects/perfContext.ts`.
- **fx_profile** (`//tools/fx_profile`) — host opcode/adjacent-pair histogram +
  soft-float-vs-cheap split over a corpus, behind the `profile` cargo feature on
  `//firmware/fx_vm:fx_vm_profile` (zero cost in the shipped build). This is the
  data source for the follow-ups below.
- **LUT float sin/cos** (`fx_vm`) — compile-time f32 table in flash, 0 RAM.
  Measured cos −46%/op; cascades to tan + hash.
- **Integer bit-mix hash** replacing `fract(sin())` — measured −47…−68%.
- **Native int/fixed builtins.** `min`/`max`/`abs`/`clamp`/`mod` used to lower to
  the FLOAT ops, which reinterpret an int/fixed scaled-integer stack word as f32
  (wrong for negatives + all fixed formats). Added VM `AbsI`/`MinI`/`MaxI`/`ClampI`
  (one integer opcode serves int + every fixed format); `mod`→`ModI`; `floor`/
  `ceil`(int)→identity; float-only unary builtins now convert (not reinterpret)
  an int/fixed arg. No golden impact (float calibration set unchanged).
- Golden (`web/tests/testdata/device-bench-esp32c6.json`) regenerated from a
  full rig sweep after each firmware change; default cost model refreshed to match.

**Key finding:** typical effects are ~53–81% soft-float by _cycles_ (math-bound),
but instruction _count_ is dominated by cheap stack/load ops. So soft-float LUTs +
fixed-point (above) were the big cycle wins; dispatch reduction is the remaining
lever for the loop-heavy / cheap-op-heavy programs.

### FOLLOW-UPS (next up)

1. **Superinstructions / peephole fusion (compiler + VM).** Fuse the hottest
   adjacent bytecode pairs into single opcodes to cut dispatch + stack traffic.
   Shortlist from the `fx_profile` pair histogram (run `bazel run //tools/fx_profile`):
   `Mul→Add` (FMA), `StoreLocal→LoadLocal` (store-then-reload elimination), and the
   loop trio `CmpI→BrFalse` / `PushConst→AddI` / `AddI→StoreLocal` (dominates the
   loop-heavy `agents`/`texmap`). Also `Swizzle→Mul`, `LoadLocal→PushConst`.
   Touches: `fx_compiler` emitter + `fx_vm` dispatch + `costModel.ts` + golden regen.
2. **Keyhole JIT for dispatch-bound programs (potential, gated on data).** Only if
   `fx_profile` shows genuinely dispatch-bound hot effects after superinstructions
   (most measured so far are math-bound). Would emit position-independent RISC-V
   for hot basic blocks. High cost/risk and it fights the "RAM is scarce" constraint
   (executable code buffer lives in RAM/IRAM) — spike a microbench + feasibility
   check before committing. Likely last / may not be justified.

Remaining builtin int/fixed gaps (still on the float / reinterpret path): `sign`
(add native `SignI`), `step`, fixed `floor`/`ceil`/`fract` (need a frac-mask
opcode), and int/fixed args to the BINARY/ternary float builtins
`pow`/`atan2`/`mix`/`smoothstep` (needs per-arg coercion, e.g. coerce during
`call_args` from a declared builtin signature). `sin`/`cos`/`exp` on a `fixed`
(Q16.16) arg go to float too — only `fixed8`/`fixed16` hit the LUT path.

Other candidates if wanted: LUT `exp` (untouched, still soft-float poly), SWAR
"vectorization" of narrow fixed8/fixed16 lanes, `Normalize` reciprocal-multiply.

**How to measure:** `HITL_OWNER=… bazel run //pi/hitl/harness:fx_bench -- --no-golden-check`
(needs Tailscale up: `sudo tailscale ... up --authkey=$(cat credentials/tailscale.key)`),
then refresh the golden from the run's bundle. Host-only op-mix: `bazel run //tools/fx_profile`.
