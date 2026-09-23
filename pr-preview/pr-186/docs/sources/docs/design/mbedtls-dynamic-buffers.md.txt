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

## ABI-compatibility — RESOLVED (2026-07-22): dynamic buffers are link-wrapped

The open question below is now answered by inspecting the IDF v5.5.4 port and
the shipped `esp_mbedtls_dynamic.h`: **`CONFIG_MBEDTLS_DYNAMIC_BUFFER` does NOT
change any mbedtls struct.** The feature is implemented entirely at link time —
the port compiles `components/mbedtls/port/dynamic/*.c` and links with
`-Wl,--wrap=mbedtls_ssl_setup` (plus `ssl_read`/`ssl_write`/`ssl_free`/
`ssl_session_reset`/`mbedtls_ssl_send_alert_message`/…). The `__wrap_*` shims
reallocate `ssl->in_buf` / `ssl->out_buf` between records using fields that
already exist on `mbedtls_ssl_context`. No field is added or resized.

Consequences:
- The precompiled `libesp-tls.a` / `libesp_https_server.a` stay ABI-compatible —
  their calls to `mbedtls_ssl_*` are simply redirected to the wrappers at the
  final link. **They do not need rebuilding.** (So we keep them precompiled,
  which also satisfies "no precompiled ESP libs where avoidable" for the crypto
  core we actually care about — mbedtls itself is what goes to source.)
- The struct-layout config-parity concern still applies to *our* mbedtls build:
  compile it with the SDK's exact `esp_config.h` + `mbedtls_config.h`, adding
  only `CONFIG_MBEDTLS_DYNAMIC_BUFFER=y` (a port knob, not a `mbedtls_config.h`
  struct macro), so our `mbedtls_ssl_context` matches what esp-tls was built
  against.

## Chosen approach (locked 2026-07-22)

Build **mbedtls from source** (`library/*.c` + IDF `port/*.c` incl. the HW-crypto
`*_alt` drivers + `port/dynamic/*.c`) as an `@embedded` `cc_library`
(`alwayslink`), linked ahead of / replacing the precompiled
`libmbedtls*.a`/`libmbedcrypto.a`/`libmbedx509.a`, with the `--wrap` link flags
and `DYNAMIC_BUFFER=y`. Keep `libesp-tls.a`/`libesp_https_server.a` precompiled
(ABI-safe per above). This honors "from-source mbedtls" while not rebuilding the
whole IDF.

## Turnkey build spec (pins + exact C6 sources, gathered 2026-07-22)

Everything below is extracted from the frozen SDK's `versions.txt` and esp-idf
v5.5.4's `components/mbedtls/CMakeLists.txt` — enough to write the `@embedded`
targets without further spelunking.

**Source pins (nix `fetchFromGitHub`):**
- `espressif/mbedtls` rev `ffb280bb63c78bfec1e1ab55040671768c85c923` (mbedtls
  3.6.5 + esp patches), `hash = "sha256-671VYuTxMOLF90UXnBofct5jBQZuBJUoBVueMP3vVUQ="`.
  Provides `library/*.c` (108), `include/`, `library/*.h` (internal), and
  `3rdparty/{everest,p256-m}` (ECC — compile these too).
- `espressif/esp-idf` rev `v5.5.4`, `hash =
  "sha256-6p+4DO2/KjOel+vLQbbJH7xFNIYAwymKbxepQx3towI="` — only for
  `components/mbedtls/port/**` (assemble a small tree in a `runCommand`; don't
  ship all of IDF). All *headers* the port needs already live in the prebuilt
  SDK's `include/` tree (reuse `@arduino_esp32//:sdk_hdrs`).

**mbedtls core:** compile `mbedtls/library/*.c` + `3rdparty/everest/library/*.c`
+ `3rdparty/p256-m/**/p256-m.c`. Include dirs: `port/include`, `mbedtls/include`,
`mbedtls/library` (+ the SDK's `mbedtls/port/include` for `esp_config.h`).

**IDF port sources for the C6** (SHA/AES use **GDMA**; MPI/SHA/AES/ECC HW on;
HMAC + DIG_SIGN present; LWIP on):
- base: `port/mbedtls_debug.c`, `port/esp_platform_time.c`, `port/net_sockets.c`,
  `port/esp_hardware.c`, `port/esp_mem.c`, `port/esp_timing.c`,
  `port/esp_hmac_pbkdf2.c`
- SHA: `port/sha/esp_sha.c`, `port/sha/core/sha.c`, `port/sha/core/esp_sha_gdma_impl.c`,
  `port/sha/core/esp_sha1.c`, `.../esp_sha256.c`, `.../esp_sha512.c`
- AES: `port/aes/esp_aes_common.c`, `port/aes/esp_aes_xts.c`,
  `port/aes/esp_aes_gcm.c`, `port/aes/dma/esp_aes.c`,
  `port/aes/dma/esp_aes_gdma_impl.c`, `port/aes/dma/esp_aes_dma_core.c`
- shared DMA: `port/crypto_shared_gdma/esp_crypto_shared_gdma.c`
- MPI: `port/bignum/esp_bignum.c`, `port/bignum/bignum_alt.c`
- ECC: `port/ecc/esp_ecc.c`, `port/ecc/ecc_alt.c`
- DIG_SIGN (esp_ds): `port/esp_ds/esp_rsa_sign_alt.c`, `.../esp_rsa_dec_alt.c`,
  `.../esp_ds_common.c`
- extra port include dirs: `port/aes/include`, `port/aes/dma/include`,
  `port/sha/core/include`
- **dynamic buffers (the feature):** add `port/dynamic/esp_mbedtls_dynamic_impl.c`,
  `esp_ssl_cli.c`, `esp_ssl_srv.c`, `esp_ssl_tls.c`
- (ECDSA-HW `port/ecdsa/ecdsa_alt.c` + its own wrap set — optional; only if
  `MBEDTLS_HARDWARE_ECDSA_*`. Our RSA cert path doesn't need it; skip for v1.)

**Config:** compile every TU with `-DMBEDTLS_CONFIG_FILE='"mbedtls/esp_config.h"'`
(the SDK's) and a `sdkconfig.h` on the include path identical to the SDK's plus
`#define CONFIG_MBEDTLS_DYNAMIC_BUFFER 1`. Change **only** that knob — no
`mbedtls_config.h` struct macro moves (ABI parity with precompiled esp-tls).

**Link flags** (add to `:core`'s linkopts, `INTERFACE`-style, when DYNAMIC_BUFFER
is on) — the 11 wraps that engage the dynamic path:
```
-Wl,--wrap=mbedtls_ssl_write_client_hello
-Wl,--wrap=mbedtls_ssl_handshake_client_step
-Wl,--wrap=mbedtls_ssl_tls13_handshake_client_step
-Wl,--wrap=mbedtls_ssl_handshake_server_step
-Wl,--wrap=mbedtls_ssl_read
-Wl,--wrap=mbedtls_ssl_write
-Wl,--wrap=mbedtls_ssl_session_reset
-Wl,--wrap=mbedtls_ssl_free
-Wl,--wrap=mbedtls_ssl_setup
-Wl,--wrap=mbedtls_ssl_send_alert_message
-Wl,--wrap=mbedtls_ssl_close_notify
```
`__real_*` resolve from our from-source mbedtls; `__wrap_*` come from the
`port/dynamic/*.c` above.

**Wiring:** drop `libmbedtls*.a` / `libmbedtls_2.a` / `libmbedcrypto.a` /
`libmbedx509.a` from `:sdk_libs` (arduino_esp32.BUILD glob) and depend `:core`
on the new `mbedtls_src` (`alwayslink = True`, ahead of the `--start-group`), so
our symbols satisfy the precompiled `libesp-tls.a` / `libesp_https_server.a`.

**Build-through PASSED in-container (2026-07-22).** `bazel build -c opt
//firmware/player_app:esp32c6` links against the from-source mbedtls with **HW
crypto** (GDMA SHA/AES, HW MPI/ECC, esp_ds) — no software-crypto fallback
needed. Verified on the ELF via `nm`: all 8 `__wrap_mbedtls_ssl_*` shims + 24
`esp_mbedtls_*` dynamic-buffer symbols present, and the link params carry **zero**
`-lmbedtls/-lmbedcrypto/-lmbedx509` (prebuilt archives fully excluded; our
symbols satisfy the precompiled esp-tls/https_server). Five follow-on fixes were
needed on the `@embedded` branch beyond the initial scaffold: (1) `mbedtls_src.nix`
must `import <nixpkgs>` and return an attrset for `nix_pkg.file -A`; (2) port
include dirs must precede `mbedtls/include` (the port ships `#include_next`
wrapper headers); (3) everest — compile only the 3 CMake-listed files (the
`_joined.c` includes the rest) + its private include dirs; (4) strip the stale
`-lmbedtls*` tokens from the SDK's `ld_libs` response file; (5) add
`port/md/esp_md.c` (SDK sets `MBEDTLS_MD5_ALT` via `CONFIG_MBEDTLS_ROM_MD5`).

**What still needs hardware:** the feature is a *runtime RAM* behavior, so the
payoff is only observable on the device — see Verification (8 parallel https,
idle-per-session ~2 KB, healthy min-heap). In-container we've confirmed it
**builds + links**; the RAM win is the remaining on-device check.

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
