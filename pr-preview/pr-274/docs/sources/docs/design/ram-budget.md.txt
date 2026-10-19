# RAM budget (ESP32-C6 player)

The C6 has 512 KiB of HP SRAM. Every static buffer (`.bss` + `.data`) is carved
out of it at link time; whatever is left is the heap, which the runtime then
draws down for the WiFi/BLE/lwIP pools, mbedTLS sessions, and the FreeRTOS task
stacks. A TLS (`wss`) handshake needs a ~17 KiB *contiguous* heap block for its
record buffer (~28 KiB for the whole session); when a long capture has grown the
heap's high-water mark, that alloc fails (`mbedtls_ssl_setup` → `-0x7F00`) and
the socket dies. FUG-71 is about finding and reclaiming the RAM that shouldn't be
spent, so the handshake always has room.

## Inspecting it: `.ram_chart`

Every `firmware_binary` gets a `.ram_chart` sibling (see
[`//tools:ram_chart.bzl`](../../tools/ram_chart.bzl), backed by
[`//tools:fw_memaudit.py`](../../tools/fw_memaudit.py)):

```
bazel run //firmware/player_app:esp32c6_netstack.ram_chart                 # chart
bazel run //firmware/player_app:esp32c6_netstack.ram_chart -- --json > before.json
bazel run //firmware/player_app:esp32c6_netstack.ram_chart -- --compare before.json
```

It attributes every SRAM symbol back to its component/source and prints a
per-section summary, a component→file→symbol tree, and the biggest symbols. It
only counts sections whose VMA lands in the HP-SRAM window (`0x4080_0000`..),
so flash-mapped rodata (incl. the ~2 MB `.flash_rodata_dummy` reservation) is
*not* mistaken for RAM. `--compare` diffs a `--json` snapshot so a reclaim shows
up as a concrete negative delta — the lever for iterating a cut.

The auditor shells to the host `nm`/`readelf` (they read the cross ELF fine), so
`.ram_chart` is a `bazel run` target, not a hermetic build action.

## Where the static RAM goes

The Rust FFI statics plus the C++ transport buffers (`rx`/`tx`/…) own a large
fraction of the static footprint — that's the reclaimable part. The biggest
single symbols are the FX arena/texture buffers (`FX_ARENA`, `FX_TEX_PREV`,
`FX_BYTES`), the map/topology decode arena (`ARENA_MEM`), the WS reassembly
buffer (`rx`), and the WiFi connection-manager state. Run `.ram_chart` against
the current `-c opt` image for the live numbers.

## What the chart can't see (runtime heap)

The static chart is a *ceiling* on free heap, not a measurement. The big runtime
draws, paired with the device's `esp_get_free_heap_size()`:

- **BLE** — brought up at boot for Improv onboarding. This player now runs the
  heapless BLE host (`//firmware/blehost:ble_ffi`) over the vendor controller
  only, which is dramatically lighter than the old Bluedroid stack (Bluedroid
  held ~43 KiB permanently, straight out of the pool the TLS handshake needs —
  historically the dominant cause of the exhaustion). The heapless host removes
  most of that draw structurally rather than tearing a stack down at runtime.
- **Heap-allocated task stacks** — the loop task and the `httpd_ssl` task were
  sized for the by-value micropb `ClientMessage`/`ServerMessage` frames in
  `Player::handle`. Shrinking those frames (below) makes the stacks a follow-up
  reclaim: `xTaskCreate` allocates them from the heap, so the headroom over the
  measured deepest handler chain is reclaimable. Watch the `[stack]` high-water
  log to size them.
- **mbedTLS sessions** — ~28 KiB each; concurrency capped at 2.
- **WiFi/lwIP pools.**

## Reduction roadmap

1. **Tooling**: `.ram_chart` + the audit above. *(done)*
2. **Lighten BLE**: the heapless BLE host replaces Bluedroid, removing the bulk
   of the permanent BLE heap draw. *(done — supersedes the earlier
   "release Bluedroid once provisioned" idea, which tore the stack down at
   runtime; the heapless host makes that unnecessary.)*
3. **Zero-copy protobuf envelopes**: the two fat arms that sized every by-value
   envelope on the handler stacks are now walked/encoded zero-copy (like the
   arena/effects arms), and the firmware profile stubs them:
   - `StoredMapChunk.data` (1 KiB) — encoded straight to the output in
     `handle_get_stored_map`; the firmware `ServerMessage` collapses to the
     `Welcome` arm.
   - `SetCountingPattern.blocks` (32 × f64-rgb) — walked in
     `handle_set_counting_pattern`; the firmware `ClientMessage` collapses to a
     control-frame arm.
   - `HardwareConfigState.board` (the ~4 KiB, 31-pin board-capabilities
     catalog) — the real sizer of EVERY by-value `ServerMessage` (4,104 B):
     each handler frame holding a reply paid it (`lm_player_handle` and
     `hardware_config_state` were ~10 KiB frames each). The player keeps the
     embedded descriptor ENCODED and `Player::encode_reply` splices it into the
     reply (encoding straight into the caller's `tx`, no staging copy); the
     firmware profile drops the field, so `ServerMessage` is 656 B.
   `envelope_size_test` pins all three. *(done)*

   Stack retune *(done)*, sized from a static worst-case bound over the ELF
   call graph (objdump prologues + direct calls + the mbedtls bio/RNG
   callbacks), not the measured high-water (which understates paths a run
   didn't take — render measures 0.8 KiB against a 7.4 KiB bound):
   loopTask 48 → 20 KiB (bound ~13.5 KiB, measured 12.9 KiB on the
   `ram_audit` worst case), xmit 8 → 3 KiB; render stays 8 KiB until
   `lm_playback_step`'s ~4 KiB frame shrinks. Our tasks (render/xmit/logdrain)
   use static stacks (`xTaskCreateStatic`), off the shared heap. Next fat
   frames on loopTask: the BLE host's `ns_ble_on_hci` / `ImprovService::new`
   (~4.5 KiB each).

   The netstack transports dispatch every message IN PLACE (WS reassembly
   buffer / BLE frame), so `rx` only stages frames read back off flash and
   shrank 12 → 4.5 KiB on that build.

   Measured on the `ram_audit` HITL worst case (BLE provisioning → first wss
   handshake → 512-LED map + texture effect → loaded handshakes): minimum free
   heap 1.6 KiB → 54 KiB; free with the map loaded 23.6 → 67 KiB; largest
   block 13.8 → 45 KiB.
4. **Lazily heap-allocate the FX buffers** (`FX_ARENA` + `FX_TEX_PREV` +
   `FX_BYTES`): these are `static mut` arrays reserved for the whole process, but
   no effect is loaded during a *capture* — exactly the TLS-heavy window — so
   they are pure dead weight there. Allocate on `lm_fx_load` / first
   `set_texture`, free on clear. Blocker: the FFI crate is `#![no_std]` with no
   allocator, so this needs a `#[global_allocator]` (an ESP-IDF `malloc`/`free`
   wrapper, cfg-gated so the host test keeps std's). `ffi_test` already exercises
   `lm_fx_load`/`update`/`shade`, so the lifecycle is host-verifiable.
   *(follow-up — highest-value remaining reclaim)*
5. **`rx` reassembly buffer** — *done upstream (FUG-74):* large map/topology
   uploads are sharded into `UploadChunk` windows streamed to flash and decoded
   straight off flash, so `rx` only holds a whole non-sharded message. *(done)*
6. **Heap-free regions + mode model** — fixed-slot pools / slabs / mode-union
   regions (`//firmware/region`) and the reachability-checked memory-mode state
   machine (`//firmware/sysmode`); design, results, and the integration plan in
   [memory-regions.md](memory-regions.md). Item 4 (lazy FX buffers) becomes the
   activity union there, with no allocator. *(crate + model landed; firmware
   integration follow-up)*
