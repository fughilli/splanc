# Design: MbedTLS from source with dynamic buffers (`@embedded`)

Status: **proposed** (Cleanup 1 of `next_steps.md`). Implementation lands in the
`@embedded` framework (github.com/fughilli/embedded), consumed by `led_mapper`
via `archive_override`.

## Goal

Let the ESP32-C6 hold **many** concurrent TLS sessions instead of ~2, and cut
its idle-TLS RAM footprint, by building MbedTLS from source with ESP-IDF's
**dynamic buffer** feature enabled.

## Problem / motivation

The wss player (`//firmware/player_app`, port :443) works, but each mbedtls TLS
session statically allocates its record buffers at `mbedtls_ssl_setup()`:
`MBEDTLS_SSL_IN_CONTENT_LEN` (16 KB) + `OUT_CONTENT_LEN` (~4 KB) ≈ **~28 KB per
session**, held for the session's whole lifetime. On the heap-tight C6 (~95 KB
free after boot) that caps us at ~2–3 concurrent sessions; a browser's parallel
connections or a couple of stray tabs exhaust the heap and new sessions fail
with `-0x7F00` (`MBEDTLS_ERR_SSL_ALLOC_FAILED`). We currently paper over this
with `max_open_sockets=2`, a gentle client backoff, `Connection: close`, and
"keep it to one tab" — mitigations, not a fix.

Root cause: the record buffers are compile-time-sized and resident. We can't
shrink `IN_CONTENT_LEN` below 16 KB (browsers legitimately send 16 KB TLS
records, e.g. a 25 KB `submit_map`), and we can't reduce the buffer at runtime.

## Why dynamic buffers

`CONFIG_MBEDTLS_DYNAMIC_BUFFER` is an **ESP-IDF port feature** (not stock
mbedtls, `components/mbedtls/port/dynamic/`). It hooks the record I/O so the
large RX/TX content buffers are allocated **on demand** while a record is being
processed and **freed between records**. An *idle* session then holds only its
small state (~2 KB) instead of ~28 KB. During an actual 16 KB record it still
needs 16 KB transiently — but only one connection is mid-record at a time in
practice, so total resident RAM scales with *active* transfers, not *open*
sessions. Net: dozens of idle wss/https connections become affordable, which is
what lifts the ceiling (and unblocks later serving the app bundle over https).

## Current provisioning (what we're overriding)

- `@embedded/nix/esp32_arduino_libs.nix` fetches the **precompiled**
  `esp32-arduino-libs` zip (ESP-IDF `release_v5.5`, `73550728-v6`). It ships
  `libmbedtls.a` / `libmbedcrypto.a` / `libmbedx509.a` + headers, **no source**,
  built with `DYNAMIC_BUFFER` OFF (verified: 0 `esp_mbedtls_*` dynamic symbols
  in `libmbedtls.a`).
- `@embedded/nix/arduino_esp32.BUILD` exposes those as `filegroup :sdk_libs`
  (`glob(["sdk/esp32c6/lib/*.a", ...])`) and links them into `:core` inside a
  `-Wl,--start-group … --end-group`.
- mbedtls is **3.6.5** (`MBEDTLS_VERSION_STRING`).

## Approach (chosen: build mbedtls-only from source, override the prebuilt lib)

Rebuilding the entire SDK via `esp32-arduino-lib-builder` is out of scope
(compiles all of IDF). Instead, in `@embedded`:

1. **Fetch source** matching the SDK exactly, as new nix/Bazel inputs:
   - `espressif/mbedtls` at the tag/commit used by IDF `release_v5.5` (mbedtls
     3.6.5 + Espressif patches).
   - The ESP-IDF `components/mbedtls/port/` tree at `release_v5.5`: `esp_config.h`,
     the RISC-V **hardware crypto** drivers (AES/SHA/bignum via the C6 crypto
     peripherals + their `esp_*` glue), and crucially `port/dynamic/*` (the
     dynamic-buffer implementation).
2. **`cc_library(name="mbedtls_src")`** in a new `@embedded` package
   (`libs/vendor/mbedtls/` or `nix/…`): compile the mbedtls `library/*.c` + the
   IDF port `.c` for the `riscv32` toolchain, include paths mirroring the SDK.
3. **Config**: reuse the SDK's exact `sdkconfig.h` + `esp_config.h` (extract from
   the fetched SDK so struct layouts match the precompiled `libesp-tls.a` /
   `libesp_https_server.a` that call into mbedtls) and add:
   - `CONFIG_MBEDTLS_DYNAMIC_BUFFER=y`
   - keep `IN_CONTENT_LEN=16384` (browser records) — dynamic buffer makes it
     cheap when idle, not smaller when active.
4. **Override the prebuilt lib**: drop `libmbedtls*.a` from the `:sdk_libs` glob
   and make `:core` depend on `:mbedtls_src`, linked so **our** symbols win
   (e.g. `mbedtls_src` before the `--start-group` prebuilt block, or
   `alwayslink`). `libesp-tls.a` / `libesp_https_server.a` (which reference the
   dynamic-buffer symbols only when the config macro is set — they're already
   compiled without them) still link; the dynamic path is engaged from *our*
   mbedtls `ssl_setup`, so esp-tls doesn't need recompiling. **(Validate this
   assumption early — see Risks.)**

## ABI-compatibility strategy (the main risk)

The precompiled `libesp-tls.a` / `libesp_https_server.a` were built against the
SDK's mbedtls **config**. mbedtls struct layouts depend on config `#ifdef`s, so
our from-source build **must use the identical `esp_config.h` + `sdkconfig`**,
changing *only* the dynamic-buffer knobs, or those callers get a struct-layout
mismatch (silent memory corruption). Plan: extract the exact config from the
fetched SDK, diff our effective config against it, add only the DYNAMIC_BUFFER
options, and assert no other `MBEDTLS_*` macro changed.

Open question to validate first: does `CONFIG_MBEDTLS_DYNAMIC_BUFFER` alter any
mbedtls struct that `libesp-tls.a` sees? If it adds fields to
`mbedtls_ssl_context`, esp-tls (compiled without the macro) would disagree on
the layout → we'd also need to rebuild esp-tls/esp_https_server from source.
Determine this before committing to the mbedtls-only override.

## Integration in `led_mapper`

No firmware code changes expected — `//firmware/player_app` keeps using
`esp_https_server`. Once `@embedded` builds mbedtls-with-dynamic-buffers:
- bump `max_open_sockets` back up (e.g. 7) and relax the client backoff;
- the cert-popup `client.close()` workaround can stay (harmless) or be removed.

## Verification

1. `bazel build -c opt //firmware/player_app:esp32c6` links (ours wins).
2. `player_probe wss://<dev>/ws` still green (protocol intact over TLS).
3. **8 parallel** `curl -k https://<dev>/` all succeed (was 1/8) — no `-0x7F00`.
4. Serial heap telemetry: idle-per-session cost ~2 KB, `min` heap stays healthy
   under concurrent load and a live `submit_map`.

## Cross-repo workflow

1. Implement in `@embedded` on a branch.
2. In `led_mapper` `MODULE.bazel`, temporarily `local_path_override` `@embedded`
   → the local clone to iterate + verify against the device.
3. When green, push `@embedded`, cut an archive, re-pin `archive_override`
   (url + `integrity`) in `led_mapper`.

## Risks

- **ABI/config mismatch** with precompiled esp-tls (see above) — the make-or-break
  item; validate before deep work. Fallback: also build esp-tls +
  esp_https_server from source (larger).
- **HW crypto port**: the C6 AES/SHA/bignum drivers pull peripheral + DMA headers;
  getting include paths / linkage right is fiddly. Fallback: software crypto
  (slower handshake, but the ~2 s RSA handshake is already the cost) to de-risk
  v1, then add HW crypto.
- **Toolchain flags**: must match the SDK's `c_flags` for the mbedtls TU so codegen/
  ABI agree.
