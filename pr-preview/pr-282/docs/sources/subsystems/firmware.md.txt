# The firmware (`firmware/`)

A set of `no_std` Rust crates (portable session / effects / topology / network
logic) linked into one C++/Arduino app via a C ABI. **The target MCU is the
ESP32-C6** (an ESP32-C3 build links and boots too). It drives the LEDs, serves
the control channel over Wi-Fi and BLE, and runs effects on the device. The
shipped image is the **heapless-netstack** build: everything above the vendor's
PHY/lower-MAC blobs is ours. {doc}`../docs/manifesto` explains why.

## Crates

- **`player_app/`** — the on-device app (`main.cpp`, `netstack_transport.cpp`,
  `ffi.rs`):
  - Drives WS2812 LEDs with its own driver (`ws2812.h`): PARLIO + GDMA on the
    C6 and RMT on the C3, with no FastLED.
  - Runs the effects VM (plus the RV32 JIT).
  - Serves the control protocol over `wss://:443`. The TLS cert is an EC P-256
    cert issued on-device for the live IP and `<name>.local`. The same protocol
    is also served over BLE (the BLE player transport).
  - Handles Wi-Fi provisioning with Improv over BLE. BLE stays up beside wss
    (requirement PR-38).
  - Takes effects as `.fxb` over the control channel. Textures and uniforms
    stream in and are dequantized into the arena.
  - Builds `ffi.rs` for the host as well (`player_ffi_host`), so the FFI, the
    golden-frame and the agent-surface tests run under `bazel test` with no
    hardware.
- **`netstack/`** — the heapless Wi-Fi + BLE stack, with a fixed-capacity buffer
  for every layer (see `firmware/netstack/DESIGN.md`):
  - our own RX ring and STA MLME;
  - the WPA2 4-way handshake, with CCMP on the AES accelerator;
  - DHCP, ARP and TCP;
  - a bounded HTTP server;
  - the BLE HCI/L2CAP/ATT/GATT layers and the coexistence arbiter.
- **`blehost/`** — the heapless BLE host over the vendor controller (it replaced
  Bluedroid's ~43 KiB permanent heap draw).
- **`fx_vm/`, `fx_jit/`** — the effects bytecode VM (see {doc}`../EFFECTS`),
  built for the C6 and to wasm for the browser preview, and the load-time RV32
  JIT for hot integer blocks.
- **`osc/`** — native OSC input mapped onto an effect's uniforms.
- **`region/`, `sysmode/`, `sysheap/`** — the memory discipline:
  - `region` provides fixed pools, slabs and mode-union regions, with Kani
    proofs;
  - `sysmode` is the reachability-checked model of the device's memory modes,
    which the firmware tracks at run time;
  - `sysheap` holds the heap wrappers behind the post-boot heap census.
- **`pattern/`, `player/`, `store/`, `arena/`, `landing/`**:
  - `pattern`: the hue-code pattern generator, golden-tested against the phone
    decoder;
  - `player`: the transport-free session state machine;
  - `store`: decode-into-arena persistence;
  - `arena`: the bump allocator;
  - `landing`: the on-device Soft-AP landing page.
- **`pulse/`** — the old topology pulse/flood simulator. It is now used only by
  the web simulator (`pulse_web`). The firmware's native pulse/flood playback
  was removed, so every show is an FX effect. `set_playback` accepts only `"off"`
  and refuses a named effect with `unsupported_effect`.

## Memory: budgets that are checked, not hoped for

The C6 has 512 KiB of SRAM. The player keeps the shared IDF heap for what the
vendor blobs need, and moves everything else to fixed, audited storage. On the
`ram_audit` HITL worst case, the minimum free heap went from 1.6 KiB to about
87 KiB, with 24 KiB more set aside as a dedicated TLS region. The pieces, each
with its own design note:

- **Zero-copy protocol:** requests are decoded in place with
  [pbview](protocol.md) views, and fat reply arms (the board catalog) are
  spliced in already encoded. The firmware `ServerMessage` is 656 B (it was
  4,104 B).
- **Stacks sized from a static bound:** `//tools/stack_bound` walks the
  shipped ELF's call graph, using `firmware/player_app/stack_bound.json` for the
  edges the binary can't show. `//firmware/player_app:stack_bound_test` fails
  when `(bound + 256 B ISR) × 1.25` exceeds a task's stack. The current sizes
  are loopTask 14 KiB, render 5 KiB, and xmit / logdrain 2 KiB each.
- **Less vendor residue:** the boot scan's event loop is deleted, and there is
  no lwIP task and no NVS mirror. Dead or cold SDK code is moved from IRAM to
  flash by rewriting the SDK's `sections.ld` (`firmware/player_app/ld/`, rules
  in `esp32c6_iram_to_flash.txt`), which took `.iram0.text` from 114,910 to
  97,512 B.
- **mbedTLS in its own region:** `tls_region.cpp` has 2 × 6,912 B
  record-buffer slots and a 10 KB private TLSF region. It falls back to the
  shared heap if they run out, and counts each fallback (`fb=` on the status
  line).
- **littlefs files open unbuffered**, so there is no 4 KB stdio buffer per
  `fopen`.
- **Diagnostics:** the `.ram_chart` static audit; a post-boot heap census
  (`--//firmware/player_app:heap_census_enabled`, read over JTAG); and the
  `LM_MODE` sysmode counters.

Design notes: {doc}`../docs/design/ram-budget`,
{doc}`../docs/design/memory-regions`, {doc}`../docs/design/heap-census`,
{doc}`../docs/design/kani-bazel`.

## Discovery and the agent surface

For the agent bridge ({doc}`agent`), the player advertises itself and
describes what it serves:

- **mDNS:** it answers `_splanc._tcp` with SRV/TXT/A records (crate
  `firmware/mdns`). TXT carries `id`, `name`, `fw` and the manifest path.
- **The manifest:** `GET /.well-known/splanc.json` on the HTTPS server returns
  the device identity, the firmware version, the protocol features, the
  `fxb_format`, the TLS cert's SHA-256 pin and the release's agent bundle.
  Release builds name that bundle via `--//firmware/player_app:agent_bundle_url`
  / `:agent_bundle_sha256`.
- **The welcome message:** `Welcome.features` / `fxb_format` let clients
  feature-detect instead of parsing versions.
- **The room frame:** it stores a fixture pose (`set_fixture_pose`, persisted)
  and a shared time base (`set_time_base`), and keeps a 6 B/LED room-frame
  cache for effects that read `led.room`.

## The `@embedded` module & Nix

The firmware build rules, platform constraints and vendored Arduino/ESP
libraries come from a separate Bazel module, **`@embedded`**
(`fughilli/embedded`). It is pinned via `archive_override` in `MODULE.bazel`,
with additive patches under `patches/` (for example the `sections.ld`
override and the riscv `objdump` the stack gate uses). Because `@embedded`
sources its toolchains and Arduino cores from Nix, **Nix is a hard
prerequisite**.

## Build, test & flash

```sh
# Build the ESP32-C6 image + flash bundle (tags=["manual"], excluded from //...):
bazel build -c opt //firmware/player_app:esp32c6_netstack \
  //firmware/player_app:esp32c6_netstack_flashbundle

# Static RAM attribution, and the stack gate:
bazel run //firmware/player_app:esp32c6_netstack.ram_chart
bazel test //firmware/player_app:stack_bound_test

# Host-side VM + golden-frame tests, the mode model (no hardware):
bazel test //firmware/fx_vm:fx_vm_test //firmware/sysmode/...
```

Flashing runs from a host with the board attached, or from the app over USB
(Web Serial on desktop, WebUSB on Android). See {doc}`../DEVELOPERS` (HITL)
and the TLS details in {doc}`../docs/design/mbedtls-dynamic-buffers`.
