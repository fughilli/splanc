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
   `envelope_size_test` pins both. With the by-value frames now small, the
   heap-allocated task stacks (loopTask, `httpd_ssl`) can be tightened toward the
   objdump-measured deepest handler chain — a follow-up sized off the live
   `[stack]` high-water log. *(zero-copy done; stack retune follow-up)*
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
