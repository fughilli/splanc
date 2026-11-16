# Memory regions and the mode model (ESP32-C6 player)

Goal:
- the shared IDF heap allocates nothing after boot;
- mutually exclusive features share memory through typed regions whose overlap is explicit;
- "no reachable state exhausts memory" is checked by a test, not hoped for.

This doc covers the mechanism ([`firmware/region`](../../firmware/region)), the model ([`firmware/sysmode`](../../firmware/sysmode)) and the integration plan. The RAM audit that motivates it is summarized in [ram-budget.md](ram-budget.md).

## Why the heap fails today

The IDF heap is first-fit TLSF over variable-size blocks, so its worst case depends on allocation *history*. The 2026-10-19 core dump at the minimum watermark showed the low point was a *state*, not one oversized feature: BLE provisioning was still resident while the first TLS handshake allocated. A state-space problem gets a state-space check.

## Mechanism: `firmware/region`

- **`Pool<T, N>`.** N fixed slots (N ≤ 64, one bitmap word).
  - O(1) alloc/free. Any free slot serves any request, so fragmentation is impossible and the worst case is exactly N live objects.
  - A `Slot` RAII handle frees on drop. A full pool returns `PoolFull(v)`, handing the value back; nothing panics.
  - `min_free()` records the low-water mark, the sizing evidence.
- **`Slab<S0,N0, S1,N1, S2,N2>`.** Three size classes of 16-B-aligned blocks, for C callers that `malloc` variable sizes (vendor blobs, mbedTLS).
  - A request takes the smallest fitting class and falls back to larger ones.
  - `free` routes by address range; `owns(p)` lets a malloc wrapper route frees.
  - The worst case is the declared counts (`Slab::BYTES`).
- **`ModeRegion<S>`.** One storage, typed by `S`, normally a `#[repr(C)] union` of the variants, so its size is `max(variants)`. The mutex *is* the budget: a state holding two variants at once can't be represented.
  - `enter(init)` takes `&mut self` and returns a `Guard`. Everything allocated from the variant borrows the guard, so switching while any of it is alive is a **borrow-check error**; a `compile_fail` doctest pins this.
  - The guard's drop runs the variant's leak check (`Variant::leaked`, e.g. "every pool full again") and records `ExitStatus::Leaked(n)`. A forgotten slot, or a blob that never freed, is caught at the transition instead of surfacing later as fragmentation.
- **Proofs.** Kani harnesses (`bazel test //firmware/region:region_kani`, hermetic; see [kani-bazel.md](kani-bazel.md)) prove for all ≤ 6-op sequences that:
  - slots never alias;
  - alloc succeeds iff a slot is free;
  - free + live = N;
  - the slab never under-sizes a block and routes frees back to the owning class.

## Model: `firmware/sysmode`

**State.** `SysMode` is the product of these axes:
- `Wifi` {Unprovisioned, Scanning, Joined};
- `Ble` {Advertising, Connected} — never off (PR-38);
- `wss: bool`;
- `Activity` {Idle, Mapping, Effect{video}, Upload} (the native pulse/flood playback was removed; every show is an FX-engine effect);
- `map: bool`.

**Decisions encoded:**
- **Upload is exclusive of an effect** (product decision, 2026-10-19), so `Upload` is an activity, not a flag beside `Effect`. `FxLoad` mid-upload is refused, and an upload clears the running effect.
- **BLE and wss coexist** (requirement PR-38, product decision 2026-10-19). BLE keeps advertising beside a wss session: the vestigial provisioning link is dropped when a wss client appears, but a central may reconnect and both are served at once. Radio mutual exclusion is NOT an available memory lever, so every budget includes both.

**Transition function.** `step(state, event)` is the single pure transition function. It is total: each (state, event) gives either a new state or a `Refuse`. The firmware should call it as the authority for mode switches, so the model can't drift from the code. TLA+ can't offer that.

**Costs.** `cost::*` is the per-component RAM table. Each entry cites its source:
- static sizes come from `nm -S` of the shipped ELF;
- heap sizes come from the live TLSF blocks attributed in the minimum-watermark core dump.

`BUDGET` is what those components occupy in today's layout at the measured minimum, plus the measured free heap there (54,204 B, after #262).

**Test.** `reachability_test` runs a breadth-first search from both boot states (unprovisioned, and restored with credentials + map + effect) over every event. It visits every reachable state and asserts:
- **Invariants:** wss ⇒ Joined; video ⇒ wss; never Upload ∧ Effect; no orphaned upload.
- **Coexistence (PR-38):** a BLE central and a wss session are live together in a reachable state; a central can connect during any session and a session can open with BLE up.
- **Recoverability:** every state can return to a quiescent one.
- **The HITL gate exercises the worst heap case:** under today's layout the worst reachable heap state equals the measured one.
- **Budget:** every state's live set fits `BUDGET`.
- **Pins:** the state count and worst live set are pinned, so a cost or transition change is a reviewed budget change.

The test already caught one model bug: closing wss with a BLE central still connected left video "streaming".

**Results (2026-10-19):**

| Reachable states | Worst live set | Worst state |
|---:|---:|---|
| 57 | 151,213 B | Joined + BLE connected + wss + effect with video + map |

Each later layout change re-pinned the test in its own PR: +3,072 B for the
room-frame cache (#280), +4,096 B for the 12 KB topology arena (#291), then 73
states and 164,975 B with deck B and keypoints (#285, which adds the `fx_aux`
deck-B / video union and the keypoint buffers to the cost table). Since #291 the
budget subtracts `STATICS_ADDED_SINCE_MEASURED`: statics added after the
measured image were counted as free heap there, so they shrink the headroom
instead of inflating the budget. Since #285 that constant is derived
(`ALL_MODE_STATICS - MEASURED_STATICS`), so a new static cannot be left out.

Today's layout holds about 152 KB for these components, because every static is resident regardless of state. A mode-union layout needs only the worst live set, which under PR-38 has nearly everything live at once, so the union saves little by itself (~1 KB):
- **The next lever is the scan residue:** 20 KB of vendor scan, lwIP and event-loop heap that never frees. *(Since freed by #266: no `esp_netif_init`, the event loop deleted after the scan, no NVS mirror.)*

## Integration plan

Ordered by bytes recovered per effort:
1. **Drive the firmware's mode switches through `sysmode::step`.** *(log-only: done)*
   - `sysmode::observe::Tracker` tracks the device by OBSERVATION: each loop, `mode_observe()` (main.cpp) hands `lm_mode_observe` the transport's facts (credentials, lease, BLE central, wss, upload window); the player adds its own (capture / counting probe, effect loaded, set_texture frames within 2 s over wss, map stored). The tracker derives the model events axis by axis and applies each through `step`.
   - A refusal is logged once per (state, event, reason) and forced so tracking continues; counters live in the `LM_MODE` static (`ram_watch.tcl` reads it over JTAG at the end of a `ram_audit` run) and on the serial status line (`mode=state/accepted/refused/unmodeled`).
   - `observe_test` is the model-vs-firmware agreement test (the HITL scenarios' observation sequences track with zero refusals). Wiring it up corrected two model errors: wired `PROV` provisioning needs no central (`Event::WiredCredentials`), and a restored boot starts unprovisioned (stored WiFi credentials, persisted since the upgrade-keeps-wifi fix, are committed on the first loop and observed as `WiredCredentials`).
   - Next: enforce — gate the switches that the firmware initiates (effect load during an upload, video without wss) on `step` instead of only observing them.
2. **Freeze trap.** Revive `firmware/sysheap`'s `--wrap` of malloc/heap_caps.
   - After `setup()`, record the caller PC and size of any IDF-heap allocation in a census ring, read over JTAG by `ram_watch.tcl`, so the DUT isn't disturbed.
   - Log-only first, to name the ~5 KB nobody owns; then abort in HITL builds.
3. **Activity union.** Put `ModeRegion<ActivityStore>` over the effect statics (FX_ARENA, FX_VM, FX_BYTES, JIT, LUT, OSC) and use the upload/mapping scratch. Video's FX_TEX_PREV is a sub-variant of Effect.
4. **BLE controller slab:** wrap `bt_osi_mem_*` into a bounded `Slab` so the controller's own allocations are isolated from the shared heap (the controller stays up: PR-38).
5. **TLS slab.** Add `MBEDTLS_PLATFORM_MEMORY` + `mbedtls_platform_set_calloc_free` into a `Slab`. This removes the contiguous 6.5 KB record-buffer requirement from the shared heap. *(Done in #272: `firmware/player_app/tls_region.cpp`, with 2 × 6,912 B record slots plus a 10 KB private TLSF region and a counted shared-heap fallback.)*
6. **Scan residue.** Scan with the netstack's own MLME, or `esp_wifi_deinit` after the scan, and drop `esp_netif`/lwIP/event-loop tasks. Then set `scan_residue` live only in `Wifi::Scanning`. *(The lwIP, event-loop and NVS parts are done in #266. The vendor scan itself and the model's `scan_residue` cost remain.)*
7. **CI gates:**
   - this test;
   - a static stack bound over the ELF (`objdump` prologues + call graph + a checked-in manifest of indirect edges) *(done in #270: `//firmware/player_app:stack_bound_test`)*;
   - the `ram_audit` HITL watermark run, asserting zero post-freeze allocations and per-region minimum-free margins.

Keep the cost table honest: when a component moves into a region, replace its measured constant with `size_of` of the region variant, so the model and the layout are the same number.
