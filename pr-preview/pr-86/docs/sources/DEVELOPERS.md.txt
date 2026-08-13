# Developing splanc

The contributor guide: how the repo is built, tested, and laid out, plus the
environment gotchas worth knowing. For what the project _is_ and how to use it,
see [`README.md`](./README.md); for the effects engine specifically, see
[`EFFECTS.md`](./EFFECTS.md).

## Design & architecture docs

All of the docs below are also published as a single browsable **Sphinx site**
(architecture overview with diagrams, generated figures/animations, and a
per-subsystem tour). Build and preview it with one target each:

```sh
bazel run //docs:build      # regenerate figures + HTML -> docs/site/html/
bazel run //docs:serve      # preview at http://localhost:8000
```

See [`docs/_sphinx/about-these-docs.md`](./docs/_sphinx/about-these-docs.md) for
how the site is assembled. The individual source docs below remain the source of
truth — editing them updates the site.

Start with the durable design and reference docs before changing subsystems:

- **[`led-mapper-design.md`](./led-mapper-design.md)** — the durable spec. Read §0
  (how to use it), §6 (modules), §7 (data contracts / wire protocol), §9 (phased
  build plan). Everything else hangs off this.
- **[`EFFECTS.md`](./EFFECTS.md)** — the effects engine: language, bytecode VM,
  opcodes, `.fxb` format, uniform/texture/MIDI plumbing, ESP32-C6 performance, and
  AI generation.
- **`docs/design/`** — subsystem design notes:
  - [`effects-runtime.md`](./docs/design/effects-runtime.md) — the on-device VM and
    render loop.
  - [`effects-compiler.md`](./docs/design/effects-compiler.md) — the source
    language and compiler.
  - [`perf-monitoring.md`](./docs/design/perf-monitoring.md) — the performance
    model, calibration, and how device profiles are fit.
  - [`fx-vm-performance.md`](./docs/fx-vm-performance.md) — **auto-generated**
    per-platform FX-VM performance (fitted opcode costs, estimator accuracy, raw
    measured cycles) from the HITL goldens; regenerate with
    `bazel run //web:gen_fx_vm_perf_doc` (CI freshness-gates it — never edit by hand).
  - [`mbedtls-dynamic-buffers.md`](./docs/design/mbedtls-dynamic-buffers.md) — the
    TLS-on-C6 memory work (dynamic record buffers, EC cert).
  - [`app-ux-overhaul.md`](./docs/design/app-ux-overhaul.md) — the PWA UX design.
- **`docs/`** — operational and exploratory notes:
  - [`decisions.md`](./docs/decisions.md) — build-system pins, protocol defaults,
    and other durable decisions with rationale.
  - [`runbook.md`](./docs/runbook.md) — bootstrap, lockfile updates, prerequisites.
  - [`vio-exploration.md`](./docs/vio-exploration.md) — the visual-inertial solver
    narrative + measured findings (§1–§12).
  - [`blob-detection-playbook.md`](./docs/blob-detection-playbook.md),
    [`esp32-led-mapping-plan.md`](./docs/esp32-led-mapping-plan.md) — capture-CV
    tuning and the ESP32 milestone plan.
- **[`WORKLOG.md`](./WORKLOG.md)** — project history / build log, newest first.
- **[`next_steps.md`](./next_steps.md)** — the near-term feature roadmap.

## Architecture overview

splanc has **two major components** — the **PWA** (`web/`) that captures maps and
authors effects, and the **firmware** (`firmware/`) that runs on the controller —
plus a shared wire protocol, a Rust solver, and the Raspberry Pi path.

### The PWA (`web/`, Vite + TypeScript)

A framework-free, multi-page PWA with a hand-rolled DOM and a hash router. Three
HTML entry points (`web/vite.config.ts`): `index.html` (the phone app),
`effects.html` (a standalone effects workspace), and `wall.html` (the virtual
LED-wall test fixture). The two Rust wasm bundles (the fx compiler and the fx VM)
are served alongside and loaded at runtime.

`web/src/` by subsystem:

- **App shell (`ui/app/`)** — `shell.ts` (app bar + `Maps / Effects / Device`
  tabs), `router.ts` (hash routes, mounts/unmounts heavy GL views), `state.ts`
  (global `appState`: the connected client + connection/cert status), plus PWA
  install/service-worker glue.
- **UI kit & screens (`ui/kit/`, `ui/screens/`)** — design tokens and shared
  components, and one module per surface: map browser/detail, capture/calibrate,
  the effects editor + browser + preview tiles, device onboarding
  (add-device/onboarding/QR), the firmware flash sheet, the MIDI setup screen, and
  settings/perf panels. `ui/mapview.ts` is the shared WebGL LED renderer.
- **Capture / CV pipeline** — `xr/` (getUserMedia rear-camera capture + DeviceMotion
  IMU), `cv/` (`detect` → `ccl` → `tracker` → `decoder` → `pipeline`: WebGL
  threshold, connected components, blob tracking, per-track color decode), `code/`
  (the Gray-code cyclic hue code + SEC-DED FEC + pattern-clock timing), `geom/`
  (pinhole projection, Procrustes fit), `topology/` (`extract.ts`: skeletonize the
  solved cloud into segments/branches), and `solver/` (phone-side placement/solve).
- **Effects (`effects/`, `fx/`)** — the editor (compiler worker, uniform/MIDI/video
  panels), `effects/ai/` (AI generation), and `fx/preview.ts` (`FxPreview` — runs
  the exact device VM in-browser over a map's LED positions). See
  [`EFFECTS.md`](./EFFECTS.md).
- **Networking (`net/`) & protocol (`gen/`)** — `client.ts` (the wss control
  client), `proto.ts` (the sole protobuf boundary, mirroring the Python
  `proto_wire.py`), `improv.ts` (BLE Wi-Fi onboarding), `textureCodec.ts` (video
  streaming), plus clock sync and device probing.
- **`midi/`, `flash/`, `store/`, `color/`** — Web MIDI mapping, in-browser ESP32
  flashing (esptool-js over Web Serial / WebUSB), localStorage persistence, and
  color-correction.

### The firmware (`firmware/`)

A set of `no_std` Rust crates (portable session/effects/topology logic) linked
into one C++/Arduino app via a C ABI. **The target MCU is the ESP32-C6.** (An
RP2350 Rust triple is wired into the toolchain, but there is no RP2350 board target
or source path yet — see the caveat below.)

- **`player_app/`** — the on-device app (`main.cpp` + `ffi.rs`). Drives WS2812B
  LEDs via FastLED over the C6 RMT peripheral; runs the effects VM; serves a
  control server on **both** a plain `ws://:81` (bring-up) and a TLS `wss://:443`
  (mbedtls + an EC P-256 dev cert generated at build time, re-issued on-device with
  the live IP as a SAN so the hosted https app can connect without mixed-content).
  Wi-Fi provisioning is Improv over BLE; the board boots AP+STA then demotes to STA
  to reclaim heap for the TLS handshake. Effects arrive as `.fxb` over the control
  channel; textures/uniforms are streamed in and dequantized into the arena.
  Board-agnostic host builds of `ffi.rs` (`player_ffi_host`) let the FFI and
  golden-frame tests run under `bazel test` with no hardware.
- **`fx_vm/`** — the effects bytecode VM (see [`EFFECTS.md`](./EFFECTS.md)); builds
  for the C6 and to wasm for the browser preview.
- **`pulse/`, `pattern/`, `player/`, `store/`, `arena/`, `landing/`** — the
  topology-aware pulse/flood effects (also wasm), the hue-code pattern generator
  (golden-tested against the phone decoder), the transport-free session state
  machine, decode-into-arena persistence, the bump allocator, and the on-device
  Soft-AP landing page.

The firmware build rules, platform constraints, and vendored Arduino/ESP libraries
(FastLED, BLE, Wi-Fi, webserver, mbedtls/TLS, partitions) come from a separate
Bazel module, **`@embedded`** (`fughilli/embedded`), pinned via `archive_override`
in `MODULE.bazel`. Because `@embedded` sources its toolchains and Arduino cores
from Nix, **Nix is a hard prerequisite** (below).

### Shared pieces

- **`shared/protocol/`** — the single source of truth for the wire protocol: JSON
  schemas + `proto/ledmapper.proto` → generated Python and TypeScript bindings,
  byte-pinned by a freshness check.
- **`solver/`** — the visual-inertial solver in Rust: native on the Pi, wasm in a
  phone Web Worker.
- **`pi/`** — the Raspberry Pi path (`led_driver`, `server`, `reconstruction`,
  `provisioning`) and the **HITL** test rigs (`pi/hitl/`, below).
- **`tools/`** — host-side dev/bench helpers (flash server, BLE onboarder,
  headless-browser driver, the TouchDesigner plugin, the sim studio).

## Prerequisites

- **Bazel** via `bazelisk` — the single build/test entry point for the whole
  polyglot repo (Python, TypeScript, Rust, C++ firmware, Go for the HITL daemon).
- **Nix** on `PATH`, flakes enabled — a system requirement. `rules_nixpkgs`
  realizes build tools (the HTML minifier for firmware-baked pages, the ESP32
  toolchains and Arduino cores via `@embedded`) and the provisioning targets shell
  out to the `nix` CLI. Fetches are lazy, so a narrow build that touches no
  nix-backed target still works without it — but `bazel test //...` and any
  firmware build need it.
- **pnpm** (11+) and **node** (20+) for the web app's toolchain.

## Build & test

```sh
bazel build //...          # host + web + rust/wasm (the firmware IMAGE is opt-in — see below)
bazel test  //...          # the full host test suite (incl. firmware Rust crate + golden tests)
```

`bazel build //...` and `bazel test //...` cover everything except the ESP32-C6
firmware **image**, which is deliberately kept out of the `//...` wildcard so the
common build stays light — it compiles mbedtls and the Arduino core from source.
The image builds cleanly in-container now; you just have to name it:

```sh
# ESP32-C6 firmware image + flash bundle (the image target carries tags=["manual"],
# so it is excluded from `//...` and built explicitly):
bazel build -c opt //firmware/player_app:esp32c6 //firmware/player_app:esp32c6_flashbundle
```

Other useful targets:

```sh
bazel run //firmware/fx_vm:fx_vm_test        # effects VM unit tests
bazel run //fx_compiler:fx_compile -- ...    # compile an .fx source to .fxb
bazel build //firmware/fx_vm:fx_vm_web       # the VM wasm bundle the editor loads
```

**CI (`.github/workflows/test.yaml`)** runs three jobs on every PR/push to `main`:

- `test` — the light path: `bazel test //...` (does not build the firmware image).
- `firmware` — builds `//firmware/player_app:esp32c6` and the flash bundle
  explicitly, so firmware compile/link breakage is still caught, and uploads the
  bundle artifact (also staged under `/firmware/` for in-browser USB flashing).
- `lint` — the pre-commit gate (`prek`/pre-commit, byte-identical to the local
  hooks).

Run `pre-commit run --all-files` locally before pushing — the hooks (black/isort/
flake8, buildifier, prettier, markdownlint, shellcheck, …) are pinned in
`.pre-commit-config.yaml`. The on-hardware **HITL** suite runs separately (below).

## Try the pipeline with no hardware

```sh
# Synthetic capture -> solve, end to end:
bazel run //shared/simulator:simulate -- --fixture cube --leds 64 --noise none -o /tmp/log.json
bazel run //pi/reconstruction:reconstruct -- /tmp/log.json -o /tmp/map.json

# Serve the real web app + control plane over HTTPS, plus a "virtual LED wall" you
# can point a phone at (/wall.html) to exercise the whole live pipeline:
bazel run //web:serve         # https://0.0.0.0:8443
```

The web app deploys to Cloudflare Pages (ledmapper.pages.dev) via
`//web:deploy_cloudflare`.

When developing inside claude-container, in-container servers are published as
**named services** (`.claude-container-overlay/overlay.json`) instead of fixed
host ports, so any number of worktree containers can run concurrently: the sim
studio (`studio`, 8090) and the plain-HTTP dev server (`web`, 8080) are at
`http://<name>.<instance>.claude.localhost/`, and the TLS server above
(`web-tls`, 8443) is reached by asking the host for a raw port:
`claude-container --service-port <instance>/web-tls`. Run
`claude-container --services` on the host to list instances and URLs.

## Hardware-in-the-loop (HITL) testing

The on-hardware test suite lives in `pi/hitl/` (FUG-33). A **rig** is a Raspberry
Pi with one or more ESP32-C6 dev boards attached over USB; a pool of rigs is
reached over **Tailscale**. CI (or a developer) reserves a rig from a FIFO queue,
gets an isolated Podman container with the board attached, then flashes,
provisions over Improv-BLE, and drives the device over its player WebSocket.

### Architecture

| Component       | Where              | What                                                                                                    |
| --------------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| `hitl-managerd` | Pi (systemd)       | reservation queue + Podman container lifecycle; JSON API over the tailnet (`pi/hitl/cmd/hitl-managerd`) |
| `hitl` CLI      | agent              | `reserve` / `status` / `release` / `ssh` / `flash` / … (`pi/hitl/cmd/hitl`)                             |
| test container  | Pi (podman)        | `sshd` + the ESP toolbox with the DUT attached                                                          |
| harness         | `pi/hitl/harness/` | Python on-hardware drivers (the actual tests)                                                           |

Rigs advertise themselves into the pool by carrying a tailnet tag
(`tag:splanc-hitl`); the CLI discovers online tagged nodes, probes each `/status`,
and picks the shortest queue. Precedence: `--server`/`$HITL_SERVER` >
`$HITL_SERVERS` (explicit list) > tag discovery. Multi-DUT rigs auto-discover
boards from `/dev/serial/by-id/*`, giving each its own container, sticky sshd port,
and isolated USB tree. The design lives in `pi/hitl/DESIGN.md` and `pi/hitl/README.md`.

### The suite

All harness targets are `py_test` tagged `["hitl","manual"]` (excluded from
`//...`; the pure verdict/codec logic behind them runs in the normal lane as
`//pi/hitl/tests`). Each reserves a rig, flashes with `--erase-fs`, provisions the
DUT onto the rig's AP, then exercises its slice over wss:

- **`e2e`** — flash + Improv provisioning + time-sync + rename (asserts the serial
  boot/BLE markers, a sane time-sync RTT, and a name round-trip).
- **`map_upload`** — wss sharding: chunks a large map + topology into
  `upload_chunk` windows and verifies the round trip (guards the big-TLS-record OOM).
- **`mapping_trigger`** — asserts `start_mapping` preempts the active effect with
  the gray-code pattern.
- **`fx_bench`** — the FX performance benchmark (below).
- **`rename_wss`** — the cert-restart regression: renaming re-issues the cert and
  restarts the TLS server; this hammers reconnects and reports time-to-recovery.
- **`video_stream`** — streams a scrolling pattern and asserts a sustained ≥10 FPS.

### FX performance benchmark & regression gate

`fx_bench` (`pi/hitl/harness/fx_bench.py`) profiles the effects VM on a real
ESP32-C6 using the SoC cycle counters (not FPS). It runs a suite of calibration
micro-programs (`pi/hitl/harness/benchmarks/*.fx`, auto-generated from
`web/src/effects/calibrationBenchmarks.ts` so the browser cost model and the
on-hardware run measure identical programs), collecting the `PerfReport`
`frame_cycles_mean` (FX-VM execution cost) and `show_cycles_mean` (transmit path)
for each.

It then compares measured **frame cycles** to a committed golden and fails on
drift:

- **Golden:** `web/tests/testdata/device-bench-esp32c6.json`
  (`cpuHz: 160_000_000`, 65 fit + 7 held-out programs). Regenerate with
  `fx_bench --emit-golden <path>`.
- **Gate:** a program is an offender if `abs(measured/golden − 1)` exceeds its
  margin — default **10%**, `sweep16` **15%**. Only frame cycles are gated; show
  cycles are noisier and excluded.

The measured bundle also feeds the browser device-profile fit
(`web/src/effects/deviceProfile.ts`), whose held-out software estimate is gated at
13% (`web/tests/deviceProfileHardware.test.ts`). See
[`EFFECTS.md → Performance`](./EFFECTS.md#performance-on-the-esp32-c6) for the
representative numbers and [`docs/design/perf-monitoring.md`](./docs/design/perf-monitoring.md)
for methodology.

The same bundle also generates [`docs/fx-vm-performance.md`](./docs/fx-vm-performance.md)
(fitted opcode costs + estimator accuracy per platform). Regenerating a golden — or any
change that moves the fitted numbers — requires re-pinning that doc with
`bazel run //web:gen_fx_vm_perf_doc`, or `bazel test //...` fails on the freshness gate
(`//web:fx_vm_perf_doc_freshness`, mirroring `//shared/protocol:codegen_freshness`).

### CI wiring

`.github/workflows/hitl.yaml` runs on same-repo PRs and `workflow_dispatch`
(fork PRs are skipped — no secret access). The job opts into the **`HITL`** GitHub
Actions environment, joins the tailnet with an ephemeral key, then:

```sh
targets=$(bazel query 'attr(tags, "\bhitl\b", tests(//...))')
bazel test $targets -c opt --test_output=streamed --test_env=HITL_SERVERS ...
```

Config lives in Settings → Environments → HITL:

- `secrets.TS_AUTHKEY` — Tailscale auth key (ephemeral + tagged recommended).
- `vars.HITL_SERVERS` — pool of rig base URLs/hostnames, e.g. `"hitl-rig-1, hitl-rig-2"`.
- `secrets.HITL_WIFI_SSID` / `HITL_WIFI_PASS` — optional provisioning-network
  override (unset by default; the DUT uses the rig's own AP).

`--test_output=streamed` serializes tests because the shared rig takes one
reservation at a time.

### Standing up your own rig (private use)

A rig is an `sbc-deploy` consumer (`pi/hitl/flake.nix`), so it builds a full Pi SD
image and deploy targets — there's no separate "register" step; a rig joins the
pool by carrying the tailnet tag.

1. **Hardware:** a Raspberry Pi (Ethernet uplink so `wlan0` can be a dedicated
   2.4 GHz provisioning AP; the Pi's Bluetooth is the Improv BLE central) and one
   or more ESP32-C6 dev boards over USB.
2. **Deploy the rig:**

   ```sh
   bazel run //pi/hitl:hitl.keys        -- init                 # deploy key
   bazel run //pi/hitl:hitl.image_sd    -- --device /dev/diskN  # flash a card, OR
   bazel run //pi/hitl:hitl.deploy_live -- hitl-rig             # push to a running rig
   ```

   The NixOS system installs Podman + Tailscale (`--ssh`), USBIP, the always-on
   provisioning AP, the container image, and the `hitl-manager` daemon. (Full
   system deploys must run from a real Linux/macOS host — the aarch64 container
   can't complete the RPi closure. On macOS start `@sbc_deploy//:linux_builder`
   first.)

3. **Seed the Tailscale auth key** out of band (never in git; `pi/hitl/secrets/`
   is gitignored, and a reflash wipes `/var/lib`):

   ```sh
   bazel run //pi/hitl:seed_tailscale_authkey
   ```

4. **Tailnet ACL:** grant the node your rig tag and add an `ssh` grant
   `autogroup:member → tag` with `action:"accept"` (not `"check"` — headless can't
   browser-auth). To avoid the shared `tag:splanc-hitl`, use your own tag and set
   `$HITL_TAG` on clients.
5. **Point CI or local runs at it:** for CI, create a `HITL` environment with your
   `TS_AUTHKEY` and `HITL_SERVERS` — no code change needed. Locally, from a
   tailnet-joined machine, `export HITL_SERVERS="http://<rig>:8087"` (or rely on
   tag discovery) and run any harness directly, e.g.
   `bazel run //pi/hitl/harness:fx_bench`.

## Environment notes (container / CI gotchas)

- **Bazel caches persist across container restarts** via `.bazelrc`
  (`--repository_cache` / `--disk_cache` on the `/workspace` mount), so the
  post-restart first build isn't a full re-download.
- **Don't put the Bazel output base on `/workspace`** — it's a case-insensitive
  macOS mount, and rules_python's extracted tree has case-colliding files that
  corrupt there. Only content-addressable caches (hashed filenames) are safe on
  it; the output base stays in `~/.cache` (ephemeral, cheap to rebuild).
- **`-XX:UseSVE=0` in `.bazelrc`** works around a JVM `SIGILL` on some aarch64
  hosts (Bazel's bundled JDK emits SVE instructions). It's guarded with
  `-XX:+IgnoreUnrecognizedVMOptions` so x86_64 JVMs ignore it. A wedged `[java]`
  server usually clears by pointing bazel at a fresh `--output_base`.

## Repo layout

| Path                | What                                                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `web/`              | phone capture app + effects editor + virtual LED wall (Vite/TS) — [README](./web/README.md)                          |
| `firmware/`         | ESP32-C6 player firmware: LED driver, wss control server, effects execution                                          |
| `firmware/fx_vm/`   | effects bytecode VM (Rust, `no_std`) — runs on device and, as wasm, in the browser preview                           |
| `fx_compiler/`      | the GLSL-ish effect language → `.fxb` bytecode compiler (Rust)                                                       |
| `solver/`           | visual-inertial solver (Rust): native on the Pi, wasm in a phone Web Worker                                          |
| `pi/`               | Raspberry Pi path: `led_driver`, `server`, `reconstruction`, `provisioning` (Nix/NixOS)                              |
| `pi/hitl/`          | hardware-in-the-loop test rigs: Go daemon + CLI + Python harness                                                     |
| `shared/protocol/`  | wire protocol: JSON schemas → generated Python + TS bindings (byte-pinned by a freshness check)                      |
| `shared/simulator/` | synthetic detection-log generator for hardware-free testing                                                          |
| `tools/`            | host-side dev/bench helpers (flash server, BLE onboarder, headless-browser driver, sim studio, TouchDesigner plugin) |
| `docs/`             | design docs, decisions log, runbook, exploration notes                                                               |

## Key references

- **Design spec:** `led-mapper-design.md` — read §0, §6, §7, §9.
- **Effects engine:** [`EFFECTS.md`](./EFFECTS.md).
- **Wire protocol:** `shared/protocol/schemas/*.json` (authoritative); regenerate
  bindings with `python3 shared/protocol/codegen.py`
  (`//shared/protocol:codegen_freshness` fails the build if they drift).
- **Decisions & runbook:** `docs/decisions.md`, `docs/runbook.md`.
- **HITL:** `pi/hitl/README.md`, `pi/hitl/DESIGN.md`.
- **Project history:** `WORKLOG.md`; roadmap: `next_steps.md`.
