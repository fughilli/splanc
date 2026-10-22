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
   `ram_audit` worst case), xmit 8 → 3 KiB. Our tasks (render/xmit/logdrain)
   use static stacks (`xTaskCreateStatic`), off the shared heap.

   Since then:
   - Removing native pulse/flood playback took `lm_playback_step`'s ~4 KiB
     frame out of render (its bound went 7.4 → 3.3 KiB), so render is 8 → 5 KiB.
   - Zero-copy TX (#267) dropped the per-layer frame buffers from every TLS
     write, so loopTask is 20 → 14 KiB.
   - The static bound is now a CI gate (`//tools/stack_bound`,
     `//firmware/player_app:stack_bound_test`, manifest in
     `firmware/player_app/stack_bound.json`). It fails when `(bound + 256 B
     ISR) × 1.25` exceeds a task's stack. Current figures: loopTask 9.7 of
     14 KiB, render 3.2 of 5, xmit 0.9 of 2, logdrain 0.7 of 2 (the last two
     trimmed from 3 KiB).

   The netstack transports dispatch every message IN PLACE (WS reassembly
   buffer / BLE frame), so `rx` only stages frames read back off flash and
   shrank 12 → 4.5 KiB on that build.

   Measured on the `ram_audit` HITL worst case (BLE provisioning → first wss
   handshake → 512-LED map + texture effect → loaded handshakes): minimum free
   heap 1.6 KiB → 54 KiB; free with the map loaded 23.6 → 67 KiB; largest
   block 13.8 → 45 KiB.

   **Running total** (same scenario, HITL rig-2). Each row is the before → after
   that its PR reported; other PRs landed between rows, so a row's "before"
   need not equal the previous row's "after":

   | Step | Change | Min free heap | Free with the 512-LED map loaded |
   | --- | --- | ---: | ---: |
   | v1.6.0 | baseline | 1.6 KiB | 23.6 KiB |
   | #262 | zero-copy envelopes, in-place dispatch, stacks from a static bound | 54 KiB | 67 KiB |
   | #266 | vendor scan residue freed (no lwIP task, event loop deleted after the scan, no NVS mirror); cold SDK code moved from IRAM to flash (`.iram0.text` 114,910 → 97,512 B) | 61.3 → 82.9 KB | 95.8 KB |
   | #267 | zero-copy TX; loopTask 20 → 14 KiB | — | 95.8 → 106.7 KB |
   | #272 | mbedTLS in its own 24 KiB region (2 × 6,912 B record slots + a 10 KB TLSF region) | ~90 → ~87 KB | ~116 → ~95 KB |
   | #291 | exact-size topology decode (count, then fill) into one shared vertex array; `ARENA_MEM` 8 → 12 KB, capacity 16·J + 24·S + 12·V bytes (a 27 / 51 / 206 scan takes 4,128 B, ~880 vertices of headroom at 27 J / 51 S; beyond it `map_too_large`) | +4 KB static, not re-measured on this scenario | — |
   | #285 | FX deck B + uniform keypoints: +6.5 KB static (`DECK_A` with its morph state, the video/deck-B aux union 8,192 → 11,436 B, `KP_IO`); the per-LED fx shade entry (`lm_fx_shade`, `Program::parse`, `Vm::run_shade_bounded`) pinned in IRAM (`.iram0.text` 97,512 → 99,704 B, +2,192) | not re-measured on this scenario (fx_keypoints HITL, final tip: min free 72.7 KB (72,672 B) with both decks + a wss session; the ~1.9 KB below the previous run is the IRAM pin) | — |

   | LED cap | **1024 LEDs per channel** (2048 total, was 512 total): render + PARLIO buffers 6.2 → 24.6 KB, per-LED map caches packed (`FX_LED_TOPO` 20 → 10 B/LED, `FX_LED_POS` 12 → 9 B/LED as [`F24`](#led-capacity-1024-per-channel), `FX_LED_ROOM` dropped for a per-LED pose transform) — static RAM +38.1 KB | 67.3 → 29.1 KB (ImprovBLE, both channels at 1024, 2048-LED map + topology + plasma effect; largest block 56.3 → 17.9 KB) | 75.4 → 37.2 KB |

   #272 deliberately *reserves* 24 KiB that a session used to take from the
   shared heap. In exchange, a handshake can no longer fail on a fragmented
   heap, and the shared heap stops churning on TLS records.
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
7. **Post-boot heap census** — every allocation after `setup()` attributed to
   its call site, read over JTAG (`--//firmware/player_app:heap_census_enabled`
   + `ram_audit`): [heap-census.md](heap-census.md). First run: mbedTLS's
   per-record 6.5 KB buffers are 93% of post-boot bytes; littlefs `fopen`'s 4 KB
   stdio buffer is the other large-block churn. *(log-only; migrations next)*

## LED capacity (1024 per channel)

`firmware/player_app/led_caps.bzl` sets `MAX_LEDS_PER_CHANNEL = 1024` on the C6
(the C3 keeps 256 per channel — the C6's caches overflow its DRAM by ~23 KB):
2048 LEDs across the two channels, one global index space (channel 0 first).
Every LED of capacity is paid in static RAM whether or not a strip uses it, so
the cap is a heap trade. Per LED of capacity, after this change:

| Buffer | B/LED | At 2048 | Notes |
| --- | ---: | ---: | --- |
| `leds` (render target) | 3 | 6,144 | the frame being shaded |
| `g_buf` (PARLIO/GDMA frame) | 9 | 18,440 | 24 bits x 3 samples; both channels at 1024 go out as one 2-lane parallel frame |
| `FX_LED_TOPO` | 10 | 20,480 | was 20: seg + branch bit (i16), d_perp (i16 mm), `s` and `dist` as F24 |
| `FX_LED_POS` | 9 | 18,432 | was 12: three F24 (16-bit mantissa, ~1.5e-5 relative, 0.08 mm at 5 m) |
| `FX_LED_MAPPED` | 1/8 | 256 | one bit per LED |
| `FX_LED_ROOM` | 0 | 0 | was 6: the pose is applied per LED in `shade()` (9 multiply-adds, only for room-reading effects on a posed fixture) |
| **total** | **~31** | **63,752** | was 50 B/LED (25.7 KB at 512) |

F24 is an f32 with its low mantissa byte rounded away: decoding is a shift
(no soft-float on the per-LED path) and it is exact for 0 and ±1. The stored
map dump (`get_stored_map`) returns positions at that precision; an
association's foot arclength is no longer resident and is re-derived as
`s × segment length`, and `d_perp` is echoed in whole millimetres.

Measured on HITL rig-2 (c6-fa0324, `//pi/hitl/harness:led_capacity --improv`,
both channels at the cap, a 2048-LED map + 12-segment topology + the plasma
effect, then three fresh wss handshakes):

| Firmware | Free | Min free | Largest block |
| --- | ---: | ---: | ---: |
| main (512 total, 256 + 256) | 75,408 | 67,340 | 56,308 |
| 1024 + 1024 | 37,208 | 29,144 | 17,908 |

The 38.2 KB drop is the static growth (`.dram0.heap_start` +38,120 B). The
headroom that is left still serves a fresh TLS session (mbedTLS has its own
region since #272) and the 6.5 KB WS upgrade; `loaded_tls_netstack` now loads
2048 LEDs by default. `//firmware/sysmode:reachability_test` models the map
store and the LED frame at the new sizes: the worst modeled state (BLE central
+ wss + video + map) keeps 18,276 B of headroom (was 56,540).

What it would take to get the heap back without lowering the cap: stream the
PARLIO frame through two small DMA buffers instead of encoding it whole
(−18 KB), at the price of a refill deadline — the prebuilt IDF's PARLIO ISR is
not cache-safe, so a flash write mid-frame would stall the refill and glitch
the wire (the Bug A failure class the whole-frame DMA fixed), unless flash
writes are gated to the inter-frame gap.

