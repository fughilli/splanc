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
bazel run //firmware/player_app:esp32c6.ram_chart                 # chart
bazel run //firmware/player_app:esp32c6.ram_chart -- --json > before.json
bazel run //firmware/player_app:esp32c6.ram_chart -- --compare before.json
```

It attributes every SRAM symbol back to its component/source and prints a
per-section summary, a component→file→symbol tree, and the biggest symbols. It
only counts sections whose VMA lands in the HP-SRAM window (`0x4080_0000`..),
so flash-mapped rodata (incl. the ~2 MB `.flash_rodata_dummy` reservation) is
*not* mistaken for RAM. `--compare` diffs a `--json` snapshot so a reclaim shows
up as a concrete negative delta — the lever for iterating a cut.

The auditor shells to the host `nm`/`readelf` (they read the cross ELF fine), so
`.ram_chart` is a `bazel run` target, not a hermetic build action.

## Where the static RAM goes (baseline, `-c opt`)

`154.7 KiB` static SRAM (`.dram0.bss` 126 KiB + `.dram0.data` 28.7 KiB). Biggest
symbols:

| bytes | symbol | notes |
|------:|--------|-------|
| 32 KiB | `rx` | WS reassembly buffer, sized for a full 256-LED `submit_map` (~96 B/LED over the wire). |
| 24 KiB | `FX_ARENA` | fx VM hidden-buffer/texture arena. |
| 16 KiB | `ARENA_MEM` | map+topology decode arena. |
|  8 KiB | `FX_TEX_PREV` | previous video-texture frame (delta decode). |
|  5 KiB | `g_cnxMgr` | WiFi connection manager (esp_wifi). |
|  4 KiB | `FX_BYTES` | active `.fxb` bytecode. |
|  3.9 KiB | `FX_VM` | fx VM state. |
|  3 KiB | `FX_LED_TOPO` | per-LED derived topology cache. |
| 2 KiB ea | `tx`, `pending_fx_sel`, `g_gen_cert`, `PLAYER` | reply/staging/cert buffers + player state. |

The app itself (Rust FFI statics ~64 KiB + the C++ `rx`/`tx`/… buffers ~40 KiB)
owns ~2/3 of the static footprint — that's the reclaimable part.

## What the chart can't see (runtime heap)

The static chart is a *ceiling* on free heap, not a measurement. The big runtime
draws, paired with the device's `esp_get_free_heap_size()`:

- **BLE (Bluedroid)** — brought up at boot for Improv onboarding and (before
  FUG-71) *never torn down*; the controller + host stack held ~43 KiB
  permanently, even long after provisioning, straight out of the pool the TLS
  handshake needs. **This was the dominant cause of the exhaustion.** Measured on
  the C6: BLE init drew 43 KiB (heap 125.7K→82.3K); `BLEDevice::deinit(true)`
  hands ~33 KiB back. See the fix below.
- **Heap-allocated task stacks** — the loop task is 24 KiB (sized for the
  by-value micropb `ClientMessage`/`ServerMessage` frame in `Player::handle`),
  the `httpd_ssl` task 28 KiB, render 8 KiB. `xTaskCreate` allocates these from
  the heap.
- **mbedTLS sessions** — ~28 KiB each; concurrency capped at 2.
- **WiFi/lwIP pools.**

## Reduction roadmap

1. **Tooling**: `.ram_chart` + the audit above. *(done)*
2. **Release BLE once provisioned** — the big one. `improv_ble_end()` tears down
   Bluedroid and returns ~33 KiB to the heap the moment the device is
   provisioned + STA-only, where BLE is pure overhead. A re-onboarding watchdog
   re-arms it (soft-AP + BLE) if the LAN is lost for good, so the device stays
   re-provisionable without a power cycle. *Measured on the rig: post-provision
   free heap ~48 KiB → ~82 KiB.* *(done)*
3. **Zero-copy protobuf envelopes**: the two fat arms that sized every by-value
   envelope on the handler stacks are now walked/encoded zero-copy (like the
   arena/effects arms), and the firmware profile stubs them:
   - `StoredMapChunk.data` (1 KiB) — encoded straight to the output in
     `handle_get_stored_map`; **`ServerMessage` 1048 → 496 B**.
   - `SetCountingPattern.blocks` (32 × f64-rgb) — walked in
     `handle_set_counting_pattern`; **`ClientMessage` 1560 → 472 B**.
   `envelope_size_test` pins both. This let the **heap-allocated task stacks
   drop: loopTask 24 → 18 KiB, `httpd_ssl` 28 → 20 KiB** (~14 KiB of heap back),
   sized ~1.5× over the objdump-measured deepest handler chain (~11–12 KiB) and
   watched live by the `[stack]` high-water log. *(done)*
4. **Lazily heap-allocate the FX buffers** (`FX_ARENA` 24 K + `FX_TEX_PREV` 8 K +
   `FX_BYTES` 4 K ≈ **36 KiB**): these are `static mut` arrays reserved for the
   whole process, but no effect is loaded during a *capture* — exactly the
   TLS-heavy window — so they are pure dead weight there. Allocate on
   `lm_fx_load` / first `set_texture`, free on clear. Blocker: the FFI crate is
   `#![no_std]` with no allocator, so this needs a `#[global_allocator]` (an
   ESP-IDF `malloc`/`free` wrapper, cfg-gated so the host test keeps std's).
   `ffi_test` already exercises `lm_fx_load`/`update`/`shade`, so the lifecycle
   is host-verifiable. *(follow-up — highest-value remaining reclaim)*
5. **Right-size `rx` (32 KiB)**: sized for a full 256-LED `submit_map`, but the
   phone uploads the fat `OutputMap` (trajectory + per-LED confidence/n_views/
   rms/parallax) that the device *skips* — it only reads `id`+`xyz` (~26 B/LED,
   ~7 KiB for 256). Have the phone send a lean `submit_map` (strip the ignored
   fields in `client.submitMap`), then drop `rx`. Faster uploads too — directly
   the long-capture path. Caveat: reduce `rx` and the leaner wire together, and
   mind version skew (a stale cached app sending a fat map to a small `rx` would
   hit the 1009 "too big" close). *(follow-up)*

