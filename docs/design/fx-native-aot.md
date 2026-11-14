# Native (AOT) effect execution on the ESP32-C6

Status: **design + stages 1–2, rebased onto main (#350 fused ops, #328 memo),
plus the signature-checking infrastructure** (this PR). The trust model is
decided (2026-10-28, "Trust" below): unsigned on-device lowering, and
user-key HMAC signatures for prebuilt images, with a public dev key on every
device for now. Stage 3 (wiring both into `player_app`) remains. Background numbers:
[fx-perf-study.md](fx-perf-study.md), "Q1 — the native ceiling" and "A native
AOT path: feasibility".

## Why

Through the VM, a typical effect costs 5–35 k cycles per LED on the C6. That's
2–5× more than native code doing the same float maths, and 7–70× more than a
fixed-point native version (study, Q1). Most of the gap is interpretation:
~54 cycles of dispatch per opcode, operand-stack traffic, and a fixed
~1,790 cycles per VM invocation. At 2048 LEDs, only a solid fill fits a 33 ms
frame through the VM. Native code is the only route to 2048 LEDs at 30 fps for
non-trivial effects.

## What gets lowered

**Input: verified `.fxb` bytecode, not source.** The AOT lowering
(`firmware/fx_aot`, a `no_std` + `alloc` crate) takes exactly the bytes the
device already accepts and executes. The VM stays the semantic reference. The
native code is a translation of that bytecode, and the differential tests
check it against the VM.

**Load-time verification inside the lowering.** It refuses (and the VM keeps
the effect) unless all of these hold:

- every opcode decodes, and every branch, jump and call target is an
  instruction boundary inside the code;
- the operand-stack depth at every instruction is the same along every path
  (abstract interpretation over the CFG). For a user function, depth is
  measured relative to the function's entry;
- depth never goes below 0 or above `MAX_STACK`; every local, state and uniform
  slot operand is in range;
- no opcode outside the supported set appears. `JitCall` and the I2C intrinsics
  are always refused; drivers (`FLAG_DRIVER`) stay on the VM.

**Fused superinstructions and the memo cache (main, #350/#328).** Before
lowering, `fx_aot::defuse` expands `BinTop`, `BinPair`, `PushConsts`,
`LoadCtxLanes` and `MulAdd` into the base opcodes they fuse (each fusion is
exact in `fx_vm`), and turns the per-LED memo brackets
`LoadLedCache`/`StoreLedCache` into no-ops. Native code binds no memo cache,
which the VM defines as running the original code. Branches are re-targeted.
Each expansion carries a budget weight (1 on its first op, 0 on the rest), so
the native per-block budget decrement still counts a fused op once, as the
VM does. The generic helper reads operand bytes from the *expanded* stream,
so an image ships them as `Image::op_code` (and a `.fxn` carries them). The
memo pass's per-frame **prepare entry** (`Program::prep_entry`) is lowered as
a third entry (`Image::prep_off`); the host runs it once per frame after
`update()`, where the VM runs it lazily before the first LED. A fixed-point
`frac` operand above 30, which the VM now faults on, keeps the effect on the
VM.

Because depth is static, **every operand-stack slot has a fixed home at compile
time**, and no runtime stack pointer is needed:

- slots 0..7 live in callee-saved registers `s2..s9`, so they survive helper
  calls without spills;
- deeper slots live in a frame next to the locals, at fixed offsets from one
  base register.

**Registers:**

| reg | role |
|---|---|
| `s0` | `NativeCtx*`: helper table, frame/LED context fields, region pointers |
| `s1` | frame base: locals (128 words), then deep stack slots |
| `s2..s9` | operand-stack slots 0..7 |
| `s10` | remaining instruction budget |
| `s11` | state base (update writes state) |
| `t*`, `a*` | scratch / helper arguments |

**Opcode lowering:**

- **Inline:** const pushes (`lui`/`addi`), local/state/uniform loads and stores
  at static offsets, every integer and fixed-point op, compares, branches and
  jumps, `Swizzle`/`Swap`/`Pop` (register moves), `LoadCtxFix`, the
  superinstructions, `Ret`/`RetRgb8`/`RetRgbFix`.
  - `MulFix` is `mul` + `mulh` + shift-combine.
  - `DivI`/`ModI` inline the VM's divide-by-zero → 0 rule. RISC-V's
    `INT_MIN / -1` already matches Rust's `wrapping_div`.
- **Helper calls:** soft-float arithmetic and compares, the maths opcodes,
  colour, hash, palette, the vector float ops, i64 fixed divides, indexed
  (dynamic) array access, buffers and textures, graph queries. A helper is a
  plain `extern "C"` Rust function. It calls the **same `fx_vm` function** the
  interpreter's arm calls, or repeats the arm's expression exactly, so results
  are bit-identical by construction. On the host, the emulator dispatches the
  helper table to the same Rust functions.

**Expected speed.** The study's f32 twins call the same helpers and measure
2–5× over the VM. This lowering is simpler than hand-written Rust: no register
allocation of locals, and one helper call per float op. It should land
between the JIT and the f32 twins on float effects. On integer/fixed effects,
where almost everything is inline, it should land close to the q16 twins.
Stage 2 measures it on a real C6.

## Sandbox (applies to every native image, signed or not)

The lowering emits a deliberately narrow instruction grammar. A separate
**instruction-stream verifier** (`fx_aot::verify`, run on the device after
lowering or after signature checks) re-checks it independently. It decides
from three inputs only: the words, the declared entry offsets, and a
`VerifyLimits { frame_bytes, state_bytes, budget }`. The lowerer/arena that
allocates the buffers supplies the limits; nothing is inferred from the image.
`Image::verify()` uses `VerifyLimits::DEFAULT`: a `FRAME_WORDS` frame,
`MAX_STATE` state words, and the VM's default budget. A rejected image stays on
the VM.

### Verifier rules

An image is a sequence of *fixed sequences* and *body* words. The fixed
sequences are byte-exact copies of `prologue_words(budget)`,
`epilogue_words()` and `exit_stub_words()` in `verify.rs`. The lowerer emits
those same functions, so the two can't drift.

- **R1 Entries and fallthrough.** Each declared entry holds the exact prologue:
  `addi sp,sp,-64`, save `ra,s0..s11` to `0..48(sp)`, then `s0=a0`, `s1=a1`,
  `s11=a2`, and `li s10, budget`. Each entry is word 0 or follows an
  unconditional transfer (`ret` / `jal x0`). A prologue anywhere else is
  rejected. The image's last word must be unconditional, so nothing falls off
  the end. The caller calls only declared entries, with `a0` = its
  `NativeCtx`, `a1` = a `frame_bytes` frame, and `a2` = a `state_bytes` state
  array.
- **R2 Reserved registers.** A body instruction may write only `x0`,
  `t0..t6`, `a0..a7` and `s2..s9`. `ra`, `sp`, `gp`, `tp`, `s0`, `s1`, `s10`
  and `s11` are written only by the fixed sequences. There are two
  exceptions: the helper call (`jalr ra, 0(t0)`) writes `ra`, and the
  canonical budget decrement (R7) writes `s10`. This also covers loads: a
  `lw` into any of those registers is rejected outside the epilogue.
- **R3 Return.** `ret` (`jalr x0, 0(ra)`) is legal only as the last word of an
  exact epilogue. The epilogue reloads `ra,s0..s11` from the prologue's save
  slots, then runs `addi sp,sp,64` and `ret`. The body can't address `sp`
  (R4), `sp` is never written outside the fixed sequences, and no branch may
  enter an epilogue past its first word (R6). So every `ret` returns to the
  caller's own `ra` with the caller's callee-saved registers restored. `ra`
  values written by helper calls are dead.
- **R4 Memory.** Only `lw`/`sw`, word-aligned, with these bases:
  - `s1`: offset in `[0, frame_bytes)`.
  - `s11`: offset in `[0, state_bytes)`.
  - `s0` stores: only the `NativeCtx` output words (`out[0..3]`, `ret_kind`,
    `ret_frac`, offsets 0..=16). The helper pointer and table are never
    writable.
  - `s0` loads: only `lw t0, E(s0)` for an exact, aligned helper-table entry
    `E` (the generic helper at 24, or a direct entry at `32 + 8·i`,
    `i < COUNT`).

  No other base is allowed, `sp` included (it appears only in the fixed
  sequences), and there are no computed addresses. Every dynamic index goes
  through a Rust helper that clamps it, exactly like the VM. Region pointers
  in `t6` are planned for buffers but not allowed yet.
- **R5 Helper calls.** The only `jalr` in a body is `jalr ra, 0(t0)`, with
  funct3 = 0 and offset = 0. It must directly follow an R4 table load.
  Pointer arguments are pinned by fixed instructions right before the call:
  - Generic helper: `addi a0,s0,0; addi a1,s1,WIN; lui/addi a2; lui/addi a3;
    lw t0,24(s0); jalr`. So `ctx` is the real context and the window is the
    frame's helper window. The verifier also requires
    `frame_bytes >= (WIN_OFF+WIN_WORDS)·4`.
  - HSV/palette: `addi a3,s1,WIN; lw t0,E(s0); jalr`. `a3` is the blue output
    pointer.
  - Scalar direct helpers take only scalar words.
- **R6 Control flow.** `jal` must have `rd = x0`. Branch funct3 must be one of
  the six real branches. Every branch and `jal` target must be word-aligned,
  inside the image, and outside these places:
  - any prologue;
  - an epilogue past its first word;
  - a helper call's protected window. For the generic helper that is the
    words after its `a1` pin through the call. For a colour helper it is the
    table load and the call. For a scalar helper it is the call.
- **R7 Budget.** Any branch or `jal` whose target is at or before its own pc
  (every back edge and loop header) must land on a canonical budget check:
  `addi s10,s10,-n` (with `1 ≤ n ≤ 2048`), `bge s10,x0,+8`, `jal x0,STUB`.
  `STUB` is the exact exit stub (`out = 0`, `ret_kind = RET_RET`), and the
  exact epilogue follows it directly. `s10` is callee-saved across helpers and
  written nowhere else (R2). Every other transfer moves strictly forward, and
  helpers return to pc+4, so every cycle passes through a decrement of at
  least 1. Once `s10 < 0`, the next back edge takes the straight-line
  stub → epilogue → `ret`. A cycle can't skip the decrement by entering the
  middle of a check, because that target isn't a check, and helper-call return
  points are not checks either. The lowerer puts a check at the head of every
  basic block (each branch target is a block header). It refuses a block with
  more than 2048 ops, which would leave the native budget and the VM's out of
  step.
- **R8 Nothing else.** `lui`, OP-IMM and OP (base and M; reserved
  funct7/shift encodings rejected) are allowed. `auipc`,
  `ecall`/`ebreak`/CSR, `fence`/`fence.i`, AMOs, and all other opcodes are
  rejected.

Not covered by the verifier, and not an escape: the generic helper's `a2`
(opcode) and `a3` (operand offset) are image-chosen. The helper reads operands
through `ctx.code.get()` and a `WIN_WORDS` slice. A crafted pair can make it
panic, which is a crash and not a write outside its slices. Images lowered on
the device always pass the real pair. Wall-time deadline polling at loop
headers is still planned. The instruction budget above is the deterministic
bound, and the watchdog stays the backstop.

`firmware/fx_aot/src/verify_tests.rs` pins each rule with negative tests. That
includes the four sandbox escapes the #351 review found (`ra`, reserved
bases, unbounded base offsets, unbudgeted loops), each as the original PoC
plus variants, and unpinned helper pointer arguments. The positive side has
three parts: `fx_aot_diff_test` verifies every image it lowers before the
bit-exact comparison, `native_vs_vm_test` verifies every image embedded in the
C6 bench, and the bench generator refuses to embed an image that fails.

- **Execution region (W^X):** the image is copied into its region while the
  region is plain data memory, then it is made **R+X without W** for the run and
  restored to writable when the effect is swapped out. See "Where native code
  lives" for how that is enforced in machine mode.

The sandbox doesn't depend on who produced the code. That matters for the
trust options below: option (a) relies on it entirely, and options (b) and (c)
use it as defence in depth.

## Where native code lives

**Owner decision (2026-10-23): native code is allocated from the FX arena — the
same memory budget the decks' programs and buffers already use — never from the
general heap, so it can never starve TLS or anything else. littlefs only stores
a (future, stage 3) prebuilt image; nothing ever executes from flash, and there
is no new flash partition.** If a translated image doesn't fit the deck's arena
share, that effect stays on the VM (never heap).

The FX arena is the 24 KB `FX_ARENA` split per deck (deck A from the front, deck
B from the back; `firmware/player_app/ffi.rs`). A native effect carves a code
sub-region at the **top** of its deck's share; the effect's buffers grow from
the bottom. `fx_aot::arena::plan_region` does the placement and refuses (→ VM)
when the code plus the buffers don't fit.

### Making arena memory executable and non-writable (W^X), in machine mode

This firmware runs entirely in machine mode, where a RISC-V PMP entry that
matches grants permission but a **locked** entry is needed to *deny* a
permission — and a locked entry can't be changed until reset, so it can't be
re-protected on an effect swap. An **unlocked** PMP entry therefore can grant
execute (as the JIT's region already does) but cannot take write away.

The ESP32-C6 also has Espressif's **PMA** checker (CSRs `0xBC0+n`/`0xBD0+n`, 16
entries; IDF uses 0–12 locked and leaves 13–15 free). A hardware probe
(`firmware/fx_perf_bench:pma_probe`, run on rig-3 `c6-117d10`, 2026-10-23)
confirmed that an **unlocked PMA entry (TOR, R+X, no W) denies a machine-mode
store** to a RAM window while an unlocked PMP entry grants execute on it:

```
fxpb-pma boot ... win=0x4080e000
fxpb pma exec=42 about_to_store      # executed from the window: OK
Guru Meditation Error: ... (Store access fault)  MCAUSE=0x7 MTVAL=0x4080e800
```

So an arena code region gets **execute from a PMP entry + no-write from a PMA
entry**, both unlocked so they are cleared on swap/park to restore write for the
allocator:

| region        | PMP entry (execute) | PMA entry (R+X, no W) |
|---------------|---------------------|-----------------------|
| deck A code   | 3 (NAPOT)           | 13 (NAPOT)            |
| deck B code   | 4 (NAPOT)           | 14 (NAPOT)            |

Two NAPOT regions (not one TOR pair) so **both decks can be protected at once
during a crossfade**. NAPOT needs a power-of-two size and a size-aligned base,
so `FX_ARENA` is aligned to the max code region and `plan_region` rounds the
image up to a power-of-two sub-region (4-byte PMP/PMA granularity otherwise). On
an effect swap or when a deck parks, the firmware clears that deck's PMP+PMA
entries before reusing the memory, and re-programs them for the new image.

### Placement options considered

| option | RAM | flash | notes |
|---|---|---|---|
| **arena sub-region (chosen)** | within the deck's existing arena share, 0 extra | 0 | never touches general heap; VM fallback if it doesn't fit |
| bench image: static 8 KB region | 8 KB | 0 | stages 1–2 measurement only (no radios); RWX is fine there |
| ~~netstack heap block~~ | ~~image size~~ | 0 | rejected by the owner: must not take general heap |
| ~~dedicated flash partition~~ | 0 | ~~64 KB~~ | rejected: no new partition; nothing executes from flash |

### Netstack wiring (stage 3 is a wiring job)

The allocation math and the W^X mechanism exist now; the netstack port wires
them into `fx_load`/`fx_clear`/park in `ffi.rs`:

1. on load, after the device lowers (option a) or verifies a signed image
   (option b), call `fx_aot::arena::plan_region(deck_off, deck_len,
   arena_need(prog), image_bytes)`; `None` ⇒ keep the VM;
2. copy the image words into the arena at `code_off`, `fence.i`;
3. program this deck's PMP entry (3 or 4) R+X and PMA entry (13 or 14) no-W over
   `[base, base+code_size)` using `arena::pmp_napot_addr` (the same CSR writes
   as `pma_probe`/the JIT arming);
4. on swap/park (`fx_clear`, deck re-point), clear that deck's PMP+PMA entries
   first so the bump allocator can reuse the bytes writably;
5. the buffers of that deck live below `buffers_avail`, so `arena_need` must
   leave room — `plan_region` enforces it.

## Trust: who may produce native code the device runs?

**Owner decision (2026-10-28).** "Users should be able to sign effects for
their own fixtures — we need an efficient way to check those signatures. 4
bytes of an HMAC computed against a user's provisioned key would be sufficient
as a signature. We don't currently have a provisioning scheme that allows users
to 'pair' their fixtures so that only their authenticated commands can run, so
for now let's just provision a dev key and get the signature checking infra
brought up." Follow-up the same day: don't bind a signature to the firmware
build (that would invalidate every user's signed effects on each release).
Bind a small **native ABI** version and a non-downgrade **minimum firmware**
instead, and retire old blobs by **key epoch / key revocation**.

This replaces the earlier recommendation ("(a) everywhere + a CI-held P-256
native key; per-owner keys rejected"). The reasoning that changed is in
"Threat model" below: every image passes the sandbox verifier and runs under
arena W^X whoever signed it, so a stolen user key yields sandboxed native
code, not arbitrary machine code.

### The three paths and how they relate

| path | who produces the code | signature | status |
|---|---|---|---|
| **(a) on-device lowering** | the firmware's own `fx_aot`, from the `.fxb` it already accepted | **none needed**: the only code involved is inside the OTA-signed firmware | lowering + verifier exist; `player_app` wiring is stage 3 |
| **(b) user-signed prebuilt `.fxn`** | the user's tools (`fx_sign`, later the app/agent) | **4-byte HMAC-SHA256** under a key the device holds: the public **dev key** on every device today, a per-user paired key later | **built** (`firmware/fx_sig`), wired into the bench load path |
| (c) first-party P-256-signed prebuilt | CI | ECDSA under a dedicated `native` key id | **not built**; see below |

For one effect the device prefers, in order: a valid `.fxn` for exactly that
`.fxb` (b) → lowering it itself (a) → the VM. Any failure at any step falls
through to the next, and the VM always works: **an effect never refuses to
play** because of a signature. What (a) and (b) share, and what the signature
never bypasses:

- the instruction-stream **verifier** (`fx_aot::verify`) on every image;
- placement **only in the FX arena** (no fit → VM), executed under PMP X +
  PMA no-W;
- the instruction budget mirrored into native code.

The signature only decides whether a prebuilt image is *considered*. (b)
exists for code the device can't or shouldn't produce itself: a heavier host
optimiser, hand-tuned images, or skipping on-device lowering time and transient
heap at load.

**(c) P-256 first-party images: not needed now.** The HMAC path already
carries prebuilt images, and there is no first-party native library yet. If one
appears that must run on devices sharing no symmetric key with CI, add it as an
asymmetric variant of the same container (format version 2 or a flag bit: the
header has both) under a key id that is never in the loader ring and never an
epoch signer. The earlier role-separation argument for that key still holds.
The relay compile-and-sign option stays rejected: an online signing oracle
proves nothing that (a) doesn't.

### Signature format (`firmware/fx_sig`)

A `.fxn` is a 40-byte header, the RV32 code words, and the operand bytes the
image's generic helper reads (`fx_aot::Image::op_code`: the `.fxb` code with the
fused superinstructions expanded). All integers are little-endian.

| off | size | field | notes |
|---:|---:|---|---|
| 0 | 4 | magic `FXN1` | |
| 4 | 1 | format version | 1 |
| 5 | 1 | `key_id` | 0 = dev key; 1.. = user keys |
| 6 | 2 | `key_epoch` | must be ≥ the device's `min_epoch` |
| 8 | 2 | `abi` | `fx_aot::NATIVE_ABI`; must be one the firmware lists |
| 10 | 2 | `flags` | 0 (reserved for an asymmetric variant) |
| 12 | 4 | `min_fw` | firmware must be ≥ this (see below) |
| 16 | 8 | `scope` | all-zero = fleet (any device with the key), else a device id (MAC, zero-padded) |
| 24 | 2 | `code_words` | |
| 26 | 2 | `op_code_len` | |
| 28 | 2 | `update_off` | word offset, `0xFFFF` = none |
| 30 | 2 | `shade_off` | word offset |
| 32 | 2 | `prep_off` | per-frame prepare entry, `0xFFFF` = none |
| 34 | 2 | reserved | must be 0 |
| 36 | 4 | **tag** | |

```text
digest = SHA-256(code bytes || op_code || the .fxb it was lowered from)
tag    = HMAC-SHA256(key, "splanc-fx-sig-v1" || header[0..36] || digest)[0..4]
```

- **Domain separation**: the 16-byte prefix `splanc-fx-sig-v1` and the magic and
  format version inside `header[0..36]`. A tag for anything else under the same
  key can't be replayed here.
- **Everything is bound**: every header field (key id, epoch, ABI, `min_fw`,
  scope, sizes, entry offsets), the code, the operand bytes, and the exact
  `.fxb`. The device already holds the `.fxb`, so it is hashed, not shipped
  twice. A blob checked against any other bytecode fails. `abi` and `min_fw`
  sit in the header **and** in the MAC'd message, so they can't be relabelled.
- **Not bound**: the firmware build. A blob stays valid on every firmware ≥
  `min_fw` that lists its `abi`.
- Comparison is constant-time (XOR-fold, no early exit).
- Host signer: `bazel run //firmware/fx_sig:fx_sign -- sign --fxb e.fxb --out e.fxn
  [--key-file K --key-id N] [--epoch E] [--min-fw X.Y.Z] [--scope fleet|aa:bb:..]`.
  It lowers with `fx_aot`, runs the verifier, then signs. With no
  `--key-file` it signs with the dev key. `fx_sign verify` checks a blob. The
  bench generator (`firmware/fx_perf_bench/gen_effects.rs`, the place this PR
  produces prebuilt images) signs every embedded image with the dev key
  automatically.

**Firmware version** (`min_fw`): the OTA manifest's monotonic packing,
`major * 1_000_000 + minor * 1_000 + patch` (1.6.0 → 1006000), parsed from the
build's `firmware-v*` version (`fx_sig::parse_fw_version`, the same function
as `ota_parse_version`). Untagged development builds report 0, so they run
only `min_fw = 0` blobs. Firmware older than `min_fw` keeps the effect on the
VM.

**Native ABI** (`abi`, `fx_aot::NATIVE_ABI`, currently 1) covers everything a
prebuilt image hard-codes about the firmware that runs it:

- the `NativeCtx` layout and its baked offsets;
- the direct-helper table order and the generic helper's
  `(ctx, win, op, code_off)` convention;
- the register/frame layout and the entry calling convention;
- the budget mirror;
- the `op_code` contract.

Bump it when any of those change. A firmware lists the ABIs it can run; any
other ABI keeps the effect on the VM. Retiring an ABI is also a blunt
revocation lever (every blob of that ABI drops to the VM or on-device
lowering).

**What the client sees on a fallback.** The device reports a stable reason
token (`malformed`, `unknown_key`, `revoked_key`, `old_epoch`, `wrong_scope`,
`abi_unsupported`, `fw_too_old`, `rate_limited`, `bad_tag`) together with its
running `fw` version and native `abi`. The bench logs
`aot <effect> ... ok=0 reason=sig:<token> fw=<n> abi=<n> vm=1`. In
`player_app` this becomes a field of the effect-load reply (stage 3).

### Why a 32-bit tag is enough, and what makes it so

- HMAC-SHA256 is a PRF. Without the key, the tag of a new message is
  unpredictable, so a forgery is a **guess**: success probability 2^-32 per
  attempt. Seeing any number of valid tags doesn't help forge one for
  different code.
- Guesses can only be checked **online**, against a device. So the device
  bounds the rate (`fx_sig::Limiter`):
  - the first 3 consecutive bad tags are free (developer mistakes);
  - after that each attempt waits 0.5 s, doubling, capped at **60 s**.
  - At the cap that is one guess a minute: an expected 2^31 minutes (about
    4,000 years) per forgery, about 8 years for a 1-in-500 chance.
- The limiter is **device-wide**, not per connection, so new sessions don't
  reset it.
- Its consecutive-failure count is **persisted in NVS** and re-armed at boot,
  so a reboot doesn't reset it either. Writes happen once per failure (bounded
  by the backoff) and once on the next success.
- Structural refusals (ABI, `min_fw`, key, epoch, scope) happen before the
  limiter and the MAC. They are about public header fields and reveal nothing
  about the key.
- The limiter runs *before* the MAC, so during a backoff even a valid blob is
  held off (`rate_limited`) and timing reveals nothing.
- Every failure is logged (`sig reject reason=… boot_fails=…`).
- Cost of a device-wide limiter: anyone flooding bad tags delays legitimate
  native loads by up to a minute. Those effects keep running on the VM, so
  this degrades speed, not function.
- Birthday bounds don't apply: an attacker can't evaluate tags offline.
- A valid blob replayed later is the same code its signer authorised. Retire
  old blobs with the epoch or key revocation (below), not with a version
  field. Device-scoped blobs can't be replayed onto other devices.

### Threat model

- **Today (dev key everywhere): the signature authenticates nothing.** The dev
  key (`fx_sig::DEV_KEY`, key id 0, the ASCII string
  `splanc-fx-dev-key-NOT-SECRET-v1!`) is in the repository. Anyone can sign
  anything. What stands between a malicious `.fxn` and the device is the
  sandbox: the verifier's narrow instruction grammar, calls only through the
  trusted helper table, loads and stores only to the frame/state/output
  words, the budget, and arena placement under W^X. That is the same bar
  on-device lowering (a) has to meet. The infrastructure exists so the
  user-key future is a provisioning change, not a format change.
- **With per-user keys:**
  - An attacker on the LAN without the key can submit blobs but faces 2^-32
    per guess under the backoff above.
  - An attacker **with** a user's key can sign native code for that user's
    devices. The key might come from XSS in the app, a malicious MCP client
    or a compromised agent host. That code is still confined to the sandbox
    above. So a stolen key yields "whatever the verifier admits", the same
    class of risk as a bug in on-device lowering. It does not yield
    arbitrary code execution, firmware replacement (OTA has its own P-256
    ring that this key is never part of), or access outside the effect's
    arena region.
  - Recovery: revoke the key id or raise `min_epoch`. The affected effects
    keep playing on the VM.
- **Not covered:**
  - confidentiality of effects;
  - authenticating the *commands* that deliver a blob, which is the pairing
    work below;
  - side channels in the soft SHA. The software path isn't constant-time
    with respect to the payload, which is public anyway. The key-dependent
    part is the precomputed HMAC pads.

### Keys, revocation and the provisioning seam

- **Key ring** (`fx_sig::KeyRing`): up to 4 keys, each stored as its
  precomputed HMAC inner/outer SHA-256 states, so a verify skips the pad
  compressions. Key id 0 is the dev key, compiled in and installed on every
  device by default. User keys use ids 1..31.
- **Device policy** (`fx_sig::Policy`, persisted, never lowered, like the OTA
  keyring's `kepoch`/`krevoked`):
  - `min_epoch` (u16): blobs signed under a lower `key_epoch` are refused.
    Raising it retires every older blob at once.
  - `revoked` (u32): one bit per key id 0..31. Setting bit 0 retires every
    dev-signed blob once user keys exist.
- **NVS** (namespace `splanc_fxsig`):
  - `k1`..`k3`: 32-byte user keys;
  - `minep`, `revoked`: the policy;
  - `fails`: the persisted backoff.

  The bench image reads and writes exactly these. An erased NVS falls back to
  dev key only, policy 0, no backoff.
- **Provisioning seam (placeholder, not implemented).** Pairing must deliver a
  key over an authenticated channel, never in clear over the LAN. One
  candidate is ECDH during BLE Improv provisioning, confirmed by physical
  presence (a button press or a code shown on the fixture). Proposed protocol
  shape, reusing the Rust API that exists now (`KeyRing::install`/`remove`,
  `Policy::raise_min_epoch`/`revoke`):
  - `fx_key_status` → `{key_ids, min_epoch, revoked, fw_version, abis,
    sig_fails, retry_ms}`. Unauthenticated, public facts only.
  - `fx_key_provision{key_id, key_epoch, wrapped_key, proof}`: install or
    replace a user key. `wrapped_key` is encrypted to the pairing session.
    `proof` is the pairing transcript's MAC.
  - `fx_key_revoke{key_id | min_epoch, auth}`: `auth` is an HMAC under a
    currently valid user key (or physical presence), over the request and a
    device nonce.
  - A load-reply field `native: {ok, reason, fw_version, abi, retry_ms}` for
    the fallback report above.

  Migration off the dev key: pair (install key id 1), re-sign the user's
  blobs, then revoke id 0. Dev-signed blobs then run on the VM or on-device
  lowering; they never fail to play.

### Device cost (measured)

Rig-1 C6 (`c6-123170`, 2026-10-28), `fxpb sig` lines from the bench image's
signature pass (`firmware/fx_perf_bench`, `sig_pass` in `src/device.rs`). One
verify is one SHA-256 over code + op_code + `.fxb`, plus one HMAC from the
ring's precomputed pad states (three software compressions). Best of 3:

| image | payload bytes | software SHA µs | hardware SHA µs |
|---|---:|---:|---:|
| sparkle | 1,552 | 939 | 269 |
| solid | 1,569 | 939 | 269 |
| sweep | 1,662 | 1,005 | 291 |
| cylinder | 2,112 | 1,231 | 307 |
| pulses | 2,234 | 1,295 | 332 |
| gradient | 2,277 | 1,295 | 309 |
| plasma | 2,556 | 1,464 | 340 |
| noise | 4,910 | 2,632 | 475 |
| particles | 5,136 | 2,767 | 484 |
| rain_naive | 9,376 | 4,921 | 747 |

- **About 0.3–0.75 ms per load with the C6's SHA accelerator** (mbedtls,
  already linked in `player_app` for TLS and OTA). The software SHA costs
  about 0.6 µs per byte (0.9–4.9 ms). It is a once-per-load cost, never
  per frame.
- **RAM:**
  - the device state (4-slot key ring with precomputed pads, policy,
    backoff, device id) is **1,000 bytes static**;
  - **no heap**;
  - a verify uses a few hundred bytes of stack (two cloned SHA states and
    the digest).
- **Flash:** about 3.5 KB of code for `fx_sig` plus the SHA (bench ELF
  symbols).
- `player_app` doesn't link `fx_sig` yet (stage 3), so the netstack image's
  static RAM/IRAM is unchanged by this PR (`esp32c6_netstack`: `.bss` and
  `.data` identical; flash +26 bytes from the `fx_vm` merge).
- All 11 signature cases gave the expected reason on the device: good →
  `ok`; tampered code, op_code or tag → `bad_tag`; validly signed for
  firmware 99.0.0 → `fw_too_old`; for ABI 2 → `abi_unsupported`; the
  `min_fw` or epoch relabelled to an accepted value → `bad_tag`; wrong key →
  `bad_tag`; unknown key id → `unknown_key`; the right blob against another
  effect's `.fxb` → `bad_tag`.
- Backoff on the device: `bad_tag ×3`, then `rate_limited`, with the good blob
  held off during the window and accepted after it.
- End to end on the device-wide path: the tampered `cylinder` blob logged
  `aot cylinder helix n=500 ok=0 reason=sig:bad_tag fw=0 abi=1 vm=1` (the VM
  frame stands); the good blob ran native with `maxdiff=0 off2=0`.
- `tools/fx_perf/run_bench.py` now fails the run unless this whole pass holds.

## Decisions needed from the owner before production

1. **Pairing scheme** for per-user keys: which channel delivers the key (BLE
   Improv ECDH + physical presence is the proposal), and whether one key per
   user covers all their fixtures (fleet scope) or per-device keys are wanted.
2. **Whether to revoke the dev key in release firmware** once pairing exists
   (recommended: release builds ship `revoked` bit 0 set; dev builds don't).
3. **Backoff parameters**: 3 free failures, 0.5 s doubling, 60 s cap,
   device-wide. Accept, or prefer per-session limits plus a lower global cap.
4. **(c) P-256 first-party images**: confirm they stay unbuilt until a
   first-party native library exists.
5. **Code placement:** DECIDED (2026-10-23): the FX arena, never general heap;
   no flash partition; littlefs stores only. See "Where native code lives".
6. **Trust model:** DECIDED (2026-10-28): user-key HMAC (dev key for now) +
   unsigned on-device lowering.

## Plan

1. **Stage 1 (this PR):** `firmware/fx_aot`:
   - static-depth verification and lowering of the integer/fixed and control
     subset to RV32IM, reusing `fx_jit::rv32` read-only (new encodings live in
     `fx_aot`);
   - its own RV32IM emulator with a helper-call trap;
   - differential tests against the real `fx_vm` over the compiler's corpus,
     random programs, and budget and edge cases.
2. **Stage 2 (this PR):**
   - the helper table: soft-float, maths, colour, vectors, indexed access,
     buffers/textures, graph;
   - the instruction-stream verifier;
   - an AOT group in the bench image (`firmware/fx_perf_bench`, static RAM
     region, unsigned);
   - measured cycles per LED against the VM on a real C6.
   - Small additive change: some private `fx_vm` maths helpers become `pub`,
     so helpers call the interpreter's exact functions.
3. **Signature infrastructure (this PR):** `firmware/fx_sig` (the `.fxn`
   container, 4-byte HMAC tag, key ring + policy, backoff), the `fx_sign` host
   tool, dev-key signing in the bench generator, and the bench's
   authenticate-then-load path with NVS keys and a persisted backoff.
4. **Stage 3:**
   - for (a), on-device lowering in `player_app`, carving the arena sub-region
     and programming PMP+PMA per "Netstack wiring" (the allocation math and the
     W^X mechanism already exist);
   - for (b), the same `authenticate` step in `player_app`'s effect load
     (prefer a valid `.fxn`, else lower, else VM) with the hardware SHA
     (mbedtls is already linked), the `splanc_fxsig` NVS namespace, and the
     fallback reason in the load reply;
   - pairing / per-user key provisioning per "Provisioning seam".
5. **Stage 4:** a Thumb-2 backend for future boards.

## Status, measured numbers, and what is not verified

**Stages 1–2 landed (this PR).** What exists and is verified:

- `firmware/fx_aot` lowers verified `.fxb` to position-independent RV32IM: static
  CFG depth analysis, slots 0–7 in `s2..s9` and deeper slots in a frame, inline
  integer/fixed/control codegen, dedicated helpers for scalar/lane float maths,
  comparisons, conversions and colour, plus the generic helper for remaining
  operations (reusing `fx_vm`'s own now-`pub` maths), a per-block budget decrement, and a VM fallback for any
  unsupported opcode. Buffers, textures, graph queries, flood, I2C, the JIT op and
  **user functions** are not yet lowered (they fall back to the VM); user-function
  cloning per entry depth is the main stage-2 follow-up.
- The instruction-stream **verifier** re-checks every emitted image.
- A **differential test** (`fx_aot_diff_test`) proves native output equals the VM
  **bit-for-bit** over the compiler corpus + embedded study/agent effects, 64 LED
  positions × 3 frames, including raw state checks. The current 36-effect
  corpus has 28 effects lowering and matching and 8 falling back (unchanged by
  the dedicated-helper follow-up). The bench's
  on-C6 `aot` pass cross-checks every LED against the VM on the real helix.
- The **arena W^X scheme is hardware-confirmed** (the PMA probe above).

### Dedicated helper follow-up (#351)

Compared with `agent/fx-aot` at `f6caeca9b618038204e5f2fa3f06825c1fc5e773`:

- Float Add/Sub/Mul/Div/Neg, unary and binary maths, Clamp/Smoothstep,
  comparisons/logic, hash, conversions, HSV and palette use per-operation
  helper entries. Scalar operands move directly from their callee-saved homes
  into `a0..a3`; scalar results return in `a0`. HSV/palette return red/green in
  `a0/a1`; blue alone uses one fixed output word because RV32's C ABI returns
  at most two words in registers.
- The fixed-stride table is embedded in `NativeCtx`, initialized outside the
  bench timer. On RV32 Add/Sub/Mul/I2F point directly at the compiler-builtins
  used by the VM (`__addsf3`, `__subsf3`, `__mulsf3`, `__floatsisf`). Div,
  comparisons and float-to-int retain small semantic wrappers for zero
  divisors, float booleans and Rust's saturating casts. No ROM addresses are
  baked into images. The context grows by 344 bytes on the host and 348 bytes on RV32
  (including alignment padding; 408 bytes total on RV32).
- **Scale and Mix deliberately retain the generic helper.** Dedicated versions
  changed NaN payload selection after optimization. Vector reductions and
  cross/normalize, fixed-point complex operations, context/uniform/indexed
  operations also retain it. Buffer/texture/graph/flood/user-function support
  remains follow-up work; I2C and JIT calls still fall back to the VM.
- Verifier additions (since tightened into the "Verifier rules" above): calls must follow an exact aligned table-entry word
  load; no branch/jump may enter a helper call after its load; branch/jump
  offsets must be word-aligned; `jalr` must have funct3/offset zero; context
  stores may address only the five output words, never the helper table.
  Negative tests cover table bounds/padding, load width, call offsets,
  bypassing loads and writes into the table. Arena/PMP/PMA policy is unchanged.
- The host emulator now clobbers caller-saved registers at calls and reports
  emitted instruction/helper-call counts. Counts exclude helper bodies,
  soft-float routines and hardware timing. More lane helpers can mean **more
  calls despite fewer emitted instructions**; this is not a C6 speed claim.
- The new raw-word host differential tests signed zeros, subnormals,
  infinities, quiet/signaling NaN payloads, conversion boundaries, lane widths
  1–4 and live stack prefixes at depths 0/7/8/13: **492,096 comparisons in opt**.
  Debug mode skips only inputs where the baseline VM itself panics (existing
  overflowing sqrtf/expf arithmetic); returning inputs still compare exactly.
- `tests/run_rv32.sh` runs the actual RV32 VM and helper machine code plus
  emitted images under QEMU user-mode, with Rust 1.85.0 and the
  `riscv32imac-unknown-none-elf` target. **521,920 raw comparisons pass**, also
  covering the retained Scale/Mix path. It needs an installed Rust target and
  `qemu-riscv32`; it downloads nothing and accesses no rig. This verifies the
  integer register ABI and target soft-float, not C6 timings or peripherals.

Both AOT Bazel tests, `native_vs_vm_test`, the host `fx_aot_nostd` build and
`bazel build -c opt //firmware/fx_perf_bench:fx_perf_bench_flashbundle` pass.
The RV32 no_std crate links and executes in the QEMU test.

**#351 on a real C6** (rig-2, helix, `fxpb aot` vs `fxpb vm`, ms/frame at 500
LEDs; the full table is in the #351 verification comment). Every lowered effect matched the VM
on every LED (`maxdiff=0`, `off2=0`) at 500 and 2048 LEDs:

| effect | VM ms | AOT ms | speedup (#351) | speedup before (#341) |
|---|---:|---:|---:|---:|
| solid | 7.3 | 3.5 | 2.09x | 1.80x |
| sweep | 16.7 | 9.7 | 1.72x | 1.33x |
| gradient | 23.2 | 13.2 | 1.76x | 1.30x |
| pulses | 26.7 | 17.1 | 1.56x | 1.26x |
| sparkle | 25.2 | 13.7 | 1.84x | 1.33x |
| cylinder | 32.0 | 18.9 | 1.69x | 1.32x |
| plasma | 48.3 | 23.1 | 2.09x | 1.35x |
| noise | 67.2 | 30.7 | 2.19x | 1.61x |
| particles | 84.3 | 37.6 | 2.24x | 1.64x |
| rain_naive | 111.8 | 39.6 | 2.82x | n/a (too big) |

flood, rain and texture still fall back to the VM.

**Verifier hardening (follow-up to #351).** The rules above replaced a
verifier that checked reserved registers only in the prologue, accepted any
`sp`/`s1`/`s11` offset, and required only one budget check somewhere. It
leaves the emitted code unchanged: the C6 bench firmware built from it is
byte-identical to #351's apart from the build timestamp and image hashes. The
diff tests, 78 embedded bench images and 521,920 QEMU RV32 comparisons all
pass. No new hardware run was needed.

**Rebased onto main (2026-10-28).** main (#350 VM perf stack, #328 memo
cache, #344 logf/expf, #357 debugger) is merged in. The fused opcodes and memo
brackets are expanded before lowering (`defuse`, see "What gets lowered"),
the prepare entry is lowered, and `frac > 30` stays on the VM. On the host
corpus **29 of 36 effects lower and match the VM bit for bit; 7 fall back**
(study rain/flood/texture, opt fire_helix/rainbow2, agent app perf opus
p02/p09). agent skill opus p11 now lowers. The bench's on-device JIT
stub was also updated to the 4-argument `JitFn` from #350; the bench image
hadn't been rebuilt on main since then and no longer compiled.
Merging main also made the bench's JIT (#381: TOR over PMP entries 3+4) and
AOT region (entry 4 NAPOT) clobber each other, giving an instruction access
fault. Both are now re-armed on every use.

**On a real C6 after the rebase** (rig-1 `c6-123170`, 2026-10-28, ms/frame at
500 LEDs on the helix). Every lowered study effect ran native from its
dev-signed `.fxn` and matched the VM on every LED (`maxdiff=0`, `off2=0`) at
500 and 2048 LEDs:

| effect | VM ms | AOT ms | speedup |
|---|---:|---:|---:|
| solid | 3.0 | 2.5 | 1.18x |
| sweep | 11.3 | 8.0 | 1.41x |
| gradient | 17.0 | 10.6 | 1.60x |
| pulses | 19.7 | 13.8 | 1.43x |
| sparkle | 19.8 | 12.2 | 1.62x |
| cylinder | 22.1 | 14.0 | 1.58x |
| plasma | 31.2 | 18.7 | 1.68x |
| noise | 52.0 | 26.1 | 1.99x |
| particles | 74.3 | 36.9 | 2.01x |
| rain_naive | 62.9 | 25.9 | 2.42x |

The *VM* got 1.3–2.4x faster on main (#350's fused ops and JIT register
caching). The AOT now expands those fused ops back into base ops, so its
margin over the VM shrank. Lowering the fused forms directly (one helper call
per `BinTop`/`MulAdd` instead of two) is the obvious next lever.

Same compiler, default uniforms, 64 LEDs × 3 frames, update plus shade,
original/current code-generation counts (not timings):

| Effect                  | Bytes before | Bytes after | Emitted instructions before |   After |
| ----------------------- | -----------: | ----------: | --------------------------: | ------: |
| band                    |        1,036 |         848 |                      39,480 |  30,456 |
| hue_gradient            |          856 |         716 |                      30,840 |  24,120 |
| breathing               |          848 |         716 |                      16,848 |  15,804 |
| plasma_c                |        1,648 |       1,172 |                      68,856 |  46,008 |
| const_math              |          584 |         444 |                      26,688 |  19,968 |
| fixed16_grad            |          640 |         600 |                      20,472 |  18,552 |
| loopy                   |          992 |         768 |                     132,216 |  87,864 |
| study_solid             |          992 |         804 |                      16,956 |  15,870 |
| study_sweep             |          968 |         784 |                      45,120 |  36,288 |
| study_gradient          |        1,460 |       1,092 |                      68,736 |  51,072 |
| study_pulses            |        1,388 |       1,060 |                      65,280 |  49,536 |
| study_sparkle           |        1,496 |       1,020 |                      52,677 |  32,475 |
| study_plasma            |        2,532 |       1,588 |                     120,192 |  74,880 |
| study_noise             |        4,328 |       3,624 |                     191,259 | 158,790 |
| study_particles         |        4,784 |       3,664 |                     257,322 | 210,645 |
| study_cylinder          |        1,480 |       1,060 |                      69,696 |  49,536 |
| study_rain_naive        |        9,108 |       5,720 |                     335,848 | 211,498 |
| opt_rainforest          |        5,644 |       4,220 |                     125,511 | 113,514 |
| opt_metaballs           |        7,760 |       5,472 |                     146,472 | 133,758 |
| agent_app_opus_p01      |        3,552 |       2,832 |                      64,236 |  58,971 |
| agent_app_opus_p05      |        4,520 |       2,960 |                     103,584 |  69,927 |
| agent_app_opus_p12      |        3,472 |       2,508 |                      36,531 |  29,655 |
| agent_app_sonnet_p03    |        5,536 |       4,484 |                     139,623 | 125,982 |
| agent_app_sonnet_p08    |        5,384 |       4,120 |                     436,896 | 396,755 |
| agent_app_lint_opus_p06 |        8,440 |       5,968 |                     131,172 | 124,110 |
| agent_skill_opus_p04    |        2,512 |       1,884 |                      60,033 |  42,363 |
| agent_skill_sonnet_p02  |        8,772 |       6,316 |                     807,552 | 516,288 |
| agent_skill_sonnet_p13  |        2,956 |       1,992 |                     116,364 |  77,862 |

Noise's emitted instruction count falls 17.0%; particles falls 18.1%.
`rain_naive` shrinks from 9,108 to 5,720 bytes and now fits the existing 8 KB
bench region without increasing its allocation. The eight corpus fallbacks
are study rain/flood/texture, opt fire_helix/rainbow2, agent app perf opus
p02/p09, and agent skill opus p11.

### Original stage 2 hardware baseline (unchanged)

**Measured on a real C6 (helix fixture, cycles/LED, min of 3 frames):**

Rig-2 C6 (`c6-*`, 2026-10-23), `firmware/fx_perf_bench` `fxpb aot` vs `fxpb vm`
lines. Cycles/LED and ms/frame include update() and the per-LED framing
(`fill_led`), same as the VM rows. **Every lowered effect matched the VM on
every LED (`maxdiff=0`, `off2=0`) at both 500 and 2048 LEDs.**

| effect | VM cyc/LED | AOT cyc/LED | speedup | VM ms @500 | AOT ms @500 | VM ms @2048 | AOT ms @2048 |
|---|---:|---:|---:|---:|---:|---:|---:|
| solid | 2,303 | 1,283 | 1.80x | 7.2 | 4.0 | 28.9 | 16.4 |
| sweep | 5,373 | 4,026 | 1.33x | 16.8 | 12.6 | 68.2 | 51.3 |
| gradient | 7,409 | 5,692 | 1.30x | 23.2 | 17.8 | 94.3 | 72.9 |
| pulses | 8,528 | 6,759 | 1.26x | 26.7 | 21.1 | 108.5 | 86.5 |
| sparkle | 8,042 | 6,037 | 1.33x | 25.1 | 18.9 | 102.4 | 77.1 |
| cylinder | 10,253 | 7,750 | 1.32x | 32.0 | 24.2 | 131.0 | 98.8 |
| plasma | 15,400 | 11,374 | 1.35x | 48.1 | 35.5 | 196.4 | 145.6 |
| noise | 21,558 | 13,425 | 1.61x | 67.4 | 42.0 | 275.3 | 171.9 |
| particles | 26,882 | 16,383 | 1.64x | 84.0 | 51.2 | 342.1 | 209.1 |

Not lowered (VM fallback): flood (graph/flood), rain and texture (buffers),
rain_naive (image > the bench's 8 KB region).

**Reading it.** 1.26–1.80x over the VM, below the study's 2–5x for hand-written
f32 twins. Every float op is one call to a single generic helper (window spill,
indirect call, operand decode, reload), so float-heavy shaders are still
helper-bound; the integer/control part is inline. The biggest remaining levers:
per-op specialised helpers (or inline soft-float calls straight to `__addsf3`
etc. with the slot registers as arguments, no window), inlining the cheap float
ops (neg/abs/compare/select), and lowering user functions and buffers so more
effects qualify.

**Not verified / out of scope here:**

- No on-device lowering yet (stage 3): the bench embeds **host**-lowered (and
  host-verified) images, now as dev-key-signed `.fxn`s that it authenticates
  before running them from a static RWX region. The netstack arena +
  PMP/PMA path is implemented as allocation math + a hardware-proven mechanism but
  not yet wired into `ffi.rs`.
- User functions, buffers/textures, graph/flood and I2C drivers stay on the VM.
- The bench region is RWX (no radios); W^X applies to the netstack arena path.
