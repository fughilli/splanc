# Native (AOT) effect execution on the ESP32-C6

Status: **design + stages 1–2 in progress** (this PR). Stage 3 (signing and an
on-device loader) waits on the trust decision below. Background numbers:
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
**instruction-stream verifier** (also in `fx_aot`, run on the device after
lowering or after signature checks) re-checks it independently:

- **Memory:**
  - Loads and stores use only `s0`, `s1`, `s11` or `sp` as the base, with an
    immediate offset inside that region's size.
  - A region pointer loaded from `NativeCtx` into the reserved `t6` may be used
    only by the very next instruction, with an offset inside that region. That
    instruction must not be a branch target.
  - There is no computed address in native code. Every dynamic index (arrays,
    buffers, textures) goes through a Rust helper that clamps it, exactly like
    the VM.
- **Control flow:**
  - Branch and `jal` targets must be inside the image and on an instruction
    boundary.
  - The only `jalr` forms allowed are `ret` and `jalr ra, 0(t0)` immediately
    after `lw t0, H(s0)` with `H` inside the helper table.
  - No `ecall`, `ebreak`, CSR, `fence.i`, or writes to `s0`/`s1`/`s11`/`sp`
    outside the fixed prologue and epilogue.
- **Time:** every basic block subtracts its VM op count from `s10` on entry
  and exits with `Outcome::Budget` when it goes negative. That is the VM's
  deterministic instruction budget, counted per block. Loop headers also poll
  the wall-time deadline flag. The existing watchdog stays the backstop.
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
| bench image: static 32 KB region | 32 KB | 0 | stages 1–2 measurement only (no radios); RWX is fine there |
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

Native code is machine code arriving over the network. Devices can't trust the
user's browser, and effects are written by users and agents at runtime. The
45-effect library is agent-written, not first-party. So "signed by our CI"
alone would leave most of the effects that matter on the VM.

### (a) Device-side lowering: no signature for user/agent effects

The device runs `fx_aot` on the `.fxb` it already accepts, then the verifier,
then installs the result. The only code involved is the lowering crate inside
the OTA-signed firmware, so nothing new needs to be trusted and no key exists
to steal.

- **Cost:**
  - flash for the lowering and verifier. Estimate ~25–40 KB; the app slot has
    ~197 KB headroom (2,359,296-byte slot, 2,157,392-byte image);
  - lowering time at load (estimate a few ms for a 4 KB `.fxb`, measured in
    stage 2);
  - transient heap while lowering (the code buffer plus a per-instruction
    depth table, ~2 bytes per bytecode byte).
- **Security property:** the lowering must be sound for *every* input. That's
  the same bar the VM already meets: it never reads or writes outside its slot
  arrays for any `.fxb`. The verifier and PMP back it up independently.
- **Limits:**
  - code quality is what this compiler produces, the same on host and device
    because it's the same crate;
  - code a host could build but the device can't (LLVM-optimised Rust/C
    effects, or a heavier register-allocating compiler) isn't covered;
  - pure offline installs work.

### (b) Dedicated native key id: prebuilt first-party code

A new key, **id 3 `native`** (plus id 4 `native_next` for rotation), signs
prebuilt native images in CI. These are images the device couldn't produce
itself: hand-tuned or LLVM-compiled first-party library effects, and static
installations.

- **Role separation:**
  - The native key is **never in the loader's ring**, so it can never sign a
    firmware image.
  - It is **never accepted as an epoch signer**, so a stolen native key can't
    revoke the release key.
  - It shares the keyring's id space, so the existing epoch mechanism revokes
    it: a `release` or `backup`-signed epoch with bit 3 set.
- **Why not the release key:** CI would then sign machine code built from
  library sources with the same key that authorises firmware. A compiler or
  workflow bug, or a malicious library PR, would yield a release-key
  signature. A separate role confines that.
- **Binding:** a `.fxn` image carries the SHA-256 of the `.fxb` it implements,
  plus the helper-ABI version, inside the signed bytes. The device runs it
  only next to that exact bytecode. The VM stays available, and the effect's
  uniforms and manifest still come from the `.fxb`.
- **Cost:**
  - one more CI secret (`FX_NATIVE_SIGNING_KEY`) and a keygen, done by the
    owner;
  - the app gains a native keyring header and a P-256 verify. mbedtls and the
    C6's ECDSA accelerator are already linked for TLS;
  - the app reads the loader's persisted `kepoch`/`krevoked` from NVS;
  - the signed images still go through the verifier.

### (c) Relay compile-and-sign

The relay (Cloudflare Worker) would compile user source with the pinned
compiler and sign the native output with an online key.

- **Cost:**
  - **The relay has no compiler today** (`agent/relay/src/library.ts`: "the
    relay has no compiler"). Shipping fx_compiler and the lowering as WASM to
    a free-tier Worker hits bundle-size and CPU-time limits.
  - **The key is online and signs anything submitted.** Anyone who can reach
    the endpoint (rate-limited, authenticated or not) gets machine code
    signed. The signature then proves only "our compiler made this from some
    source", which is exactly the property (a) gets with no key at all.
  - Every native deploy depends on the relay being available, and offline
    installs get nothing.
  - A Worker secret is a weaker place for a code-signing key than a CI secret.
- **Benefit over (a):** none for code from this compiler. It would help only if
  the relay ran a much heavier optimiser than the device can.

### Rejected: per-owner key provisioned at setup

The owner's app or agent would sign and the device would trust the owner's
key, enrolled over BLE. The key would live in a browser or on an agent host,
so any XSS, malicious MCP client or compromised agent host could sign
arbitrary machine code for all of that owner's devices. It also needs
multi-client enrolment and recovery UX. It adds risk without improving on (a).

### Recommendation

**(a) as the default for every user and agent effect, plus (b) for prebuilt
first-party images. Don't build (c).**

- (a) removes the trust problem rather than managing it: no key, no online
  signer, works offline. Its security bar (a sound lowering, re-checked by a
  verifier and PMP) is the same one the VM already has to meet.
- (b) covers the one thing (a) can't: code the device can't produce. It keeps
  native signing out of the firmware trust root, and it is revocable with the
  machinery that already exists.
- (c) costs an online signing oracle and a new relay dependency, and buys
  nothing (a) doesn't.

## Decisions needed from the owner before production

1. **Trust option(s):** (a) default + (b) as recommended, (a) only, or
   something else. Production native execution stays off until this is
   decided.
2. **If (b):** generate the `native` key (`ota_sign keygen`) and add the
   `FX_NATIVE_SIGNING_KEY` CI secret. Keep it separate from
   `OTA_SIGNING_KEY`. Agree that it is never valid for images or epochs.
3. **Code placement:** DECIDED (2026-10-23) — the FX arena, never general heap;
   no flash partition; littlefs stores only. See "Where native code lives".

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
3. **Stage 3 (after the decision):**
   - for (a), on-device lowering in `player_app`, carving the arena sub-region
     and programming PMP+PMA per "Netstack wiring" (the allocation math and the
     W^X mechanism already exist);
   - for (b), the `.fxn` container, a signer, the app-side keyring and verify,
     and the test-key variant (mirrors OTA's `_testkey`/`--trust=test`).
4. **Stage 4:** a Thumb-2 backend for future boards.

## Status, measured numbers, and what is not verified

**Stages 1–2 landed (this PR).** What exists and is verified:

- `firmware/fx_aot` lowers verified `.fxb` to position-independent RV32IM: static
  CFG depth analysis, slots 0–7 in `s2..s9` and deeper slots in a frame, inline
  integer/fixed/control codegen, one generic helper for the float / transcendental
  / colour / vector / convert / context / uniform / indexed ops (reusing `fx_vm`'s
  own now-`pub` maths), a per-block budget decrement, and a VM fallback for any
  unsupported opcode. Buffers, textures, graph queries, flood, I2C, the JIT op and
  **user functions** are not yet lowered (they fall back to the VM); user-function
  cloning per entry depth is the main stage-2 follow-up.
- The instruction-stream **verifier** re-checks every emitted image.
- A **differential test** (`fx_aot_diff_test`) proves native output equals the VM
  **bit-for-bit** over the compiler corpus + embedded study/agent effects, 64 LED
  positions × 3 frames. 24 effects lower and match; 5 fall back. The bench's
  on-C6 `aot` pass cross-checks every LED against the VM on the real helix.
- The **arena W^X scheme is hardware-confirmed** (the PMA probe above).

**Measured on a real C6 (helix fixture, cycles/LED, min of 3 frames):**

<!-- AOT_RESULTS -->
_On-C6 AOT cycle numbers are captured by `firmware/fx_perf_bench` (`fxpb aot …`
lines) and filled in here from a rig run; see the PR body for the latest table._

**Not verified / out of scope here:**

- No on-device lowering or signing yet (stage 3): the bench embeds **host**-lowered
  images and runs them unsigned from a static RWX region. The netstack arena +
  PMP/PMA path is implemented as allocation math + a hardware-proven mechanism but
  not yet wired into `ffi.rs`.
- User functions, buffers/textures, graph/flood and I2C drivers stay on the VM.
- The bench region is RWX (no radios); W^X applies to the netstack arena path.
