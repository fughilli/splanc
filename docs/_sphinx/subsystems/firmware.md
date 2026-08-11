# The firmware (`firmware/`)

A set of `no_std` Rust crates (portable session / effects / topology logic)
linked into one C++/Arduino app via a C ABI. **The target MCU is the
ESP32-C6.** It drives the LEDs, serves the control channel, and runs effects on
the device.

## Crates

- **`player_app/`** — the on-device app (`main.cpp` + `ffi.rs`). Drives WS2812B
  LEDs via FastLED over the C6 RMT peripheral; runs the effects VM; serves a
  control server on **both** a plain `ws://:81` (bring-up) and a TLS `wss://:443`
  (mbedtls + an EC P-256 dev cert generated at build time and re-issued on-device
  with the live IP as a SAN, so the hosted HTTPS app can connect without
  mixed-content). Wi-Fi provisioning is Improv over BLE; the board boots AP+STA
  then demotes to STA to reclaim heap for the TLS handshake. Effects arrive as
  `.fxb` over the control channel; textures / uniforms are streamed in and
  dequantized into the arena. Board-agnostic host builds of `ffi.rs`
  (`player_ffi_host`) let the FFI and golden-frame tests run under `bazel test`
  with no hardware.
- **`fx_vm/`** — the effects bytecode VM (see {doc}`../EFFECTS`); builds for the
  C6 and to wasm for the browser preview.
- **`pulse/`, `pattern/`, `player/`, `store/`, `arena/`, `landing/`** — the
  topology-aware pulse / flood effects (also wasm), the hue-code pattern
  generator (golden-tested against the phone decoder), the transport-free session
  state machine, decode-into-arena persistence, the bump allocator, and the
  on-device Soft-AP landing page.

## The `@embedded` module & Nix

The firmware build rules, platform constraints, and vendored Arduino/ESP
libraries (FastLED, BLE, Wi-Fi, webserver, mbedtls/TLS, partitions) come from a
separate Bazel module, **`@embedded`** (`fughilli/embedded`), pinned via
`archive_override` in `MODULE.bazel`. Because `@embedded` sources its toolchains
and Arduino cores from Nix, **Nix is a hard prerequisite**.

## Build, test & flash

```sh
# Build the ESP32-C6 image (carries tags=["manual"], excluded from //...):
bazel build -c opt //firmware/player_app:esp32c6

# The flashable bundle:
bazel build -c opt //firmware/player_app:esp32c6_flashbundle

# Host-side VM + golden-frame tests (no hardware):
bazel test //firmware/fx_vm:fx_vm_test
```

Flashing runs from a host with the board attached — see {doc}`../DEVELOPERS`
(HITL) and the on-device details in {doc}`../design/mbedtls-dynamic-buffers`.
