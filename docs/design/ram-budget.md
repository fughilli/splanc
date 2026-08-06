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
3. **Zero-copy protobuf envelopes**: decode/encode `ClientMessage`/`ServerMessage`
   through the streaming arena walker (as the map/topology uploads already do)
   instead of materializing by-value micropb structs, shrinking `Player::handle`'s
   frame and letting the loop-task (24 KiB) + `httpd_ssl` (28 KiB) stacks drop —
   a further heap reclaim. *(follow-up)*
4. **Ruthless static cuts**: right-size `rx` (stream the upload instead of
   reassembling 32 KiB), `FX_ARENA`/`FX_TEX_PREV`. *(follow-up)*

