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

- **[`docs/manifesto.md`](./docs/manifesto.md)** — _why_ the system is built the
  way it is (a microcontroller instead of Art-Net, our own wireless stack, no
  heap, model checking, a thin device and a fat agent bridge). Read it before
  proposing to undo one of those decisions.
- **[`docs/whats-new.md`](./docs/whats-new.md)** — recent notable changes, with
  links to their PRs and design notes.

- **[`led-mapper-design.md`](./led-mapper-design.md)** — the durable spec. Read §0
  (how to use it), §6 (modules), §7 (data contracts / wire protocol), §9 (phased
  build plan). Everything else hangs off this.
- **[`EFFECTS.md`](./EFFECTS.md)** — the effects engine: language, bytecode VM,
  opcodes, `.fxb` format, uniform/texture/MIDI plumbing, ESP32-C6 performance, and
  AI generation.
- **[`docs/user-guide.md`](./docs/user-guide.md)** — the end-user guide to every
  user-facing feature. **Auto-generated** (with a static site at `docs/user-guide/`,
  published to `/user-guide/`) from the in-app tutorial catalog
  (`web/src/ui/guide/catalog.ts`); regenerate both with `bazel run //web:gen_user_guide`
  (CI freshness-gates it via `//web:user_guide_freshness` — never edit by hand). The
  same catalog drives the app's interactive tutorial (Settings ▸ Help & tutorial), so
  the docs and the in-app tour can't drift. Real app screenshots come from Playwright +
  headless Chromium (`bazel run //docs:capture_user_guide`, writing
  `docs/user-guide/img/`); `bazel run //docs:build_user_guide` is the one-target rebuild
  (regenerate text + manifest, then recapture). Both are `bazel run` tools — never part
  of `bazel test //...`, so CI needs no browser; the PNGs are checked-in, not gated.
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
  - [`ram-budget.md`](./docs/design/ram-budget.md) — where the C6's SRAM goes, the
    `.ram_chart` audit, and the reduction roadmap with measured results.
  - [`memory-regions.md`](./docs/design/memory-regions.md) — heap-free regions
    (`firmware/region`) and the reachability-checked memory-mode model
    (`firmware/sysmode`).
  - [`heap-census.md`](./docs/design/heap-census.md) — attributing every post-boot
    heap allocation, read over JTAG.
  - [`kani-bazel.md`](./docs/design/kani-bazel.md) — Kani proofs as hermetic Bazel
    tests (`rust_kani_test`) and the upstream proposal.
  - [`agent-multi-fixture.md`](./docs/design/agent-multi-fixture.md) — the
    multi-fixture agent hub: discovery, rooms, poses, shared time base, the
    splanc.io entry point.
  - [`app-ux-overhaul.md`](./docs/design/app-ux-overhaul.md) — the PWA UX design.
- **`docs/`** — operational and exploratory notes:
  - [`decisions.md`](./docs/decisions.md) — build-system pins, protocol defaults,
    and other durable decisions with rationale.
  - [`requirements-driven-development.md`](./docs/requirements-driven-development.md)
    — the requirements model (`requirements/requirements.yaml`) and how tests
    trace to it.
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

A set of `no_std` Rust crates (portable session/effects/topology/network logic)
linked into one C++/Arduino app via a C ABI. **The target MCU is the ESP32-C6**
(an ESP32-C3 build links and boots too). An RP2350 Rust triple is wired into the
toolchain, but there is no RP2350 board target or source path yet (see the caveat
below). The shipped image is the **heapless-netstack** build
(`esp32c6_netstack`): everything above the vendor's PHY/lower-MAC blobs is ours.

- **`player_app/`** — the on-device app (`main.cpp`, `netstack_transport.cpp`,
  `ffi.rs`):
  - Drives WS2812 LEDs with its own driver (`ws2812.h`): PARLIO + GDMA on the
    C6, RMT on the C3.
  - Runs the effects VM and its RV32 JIT.
  - Serves the control protocol over TLS `wss://:443`, using an EC P-256 cert
    issued on-device for the live IP and `<name>.local`, and over BLE.
  - Provisions Wi-Fi with Improv over BLE. BLE stays advertising beside wss
    (requirement PR-38).
  - Publishes `GET /.well-known/splanc.json` and answers mDNS `_splanc._tcp`,
    for the agent bridge.
  - Takes effects as `.fxb` over the control channel. Textures and uniforms
    stream in and are dequantized into the arena.
  - Builds `ffi.rs` for the host as well (`player_ffi_host`), so the FFI and
    golden-frame tests run under `bazel test` with no hardware.
- **`netstack/`, `blehost/`** — the heapless Wi-Fi (MLME, WPA2, DHCP, ARP, TCP,
  HTTP) and BLE (HCI to GATT) stacks, with no allocation after init
  ([`firmware/netstack/DESIGN.md`](./firmware/netstack/DESIGN.md)).
- **`fx_vm/`, `fx_jit/`** — the effects bytecode VM (see
  [`EFFECTS.md`](./EFFECTS.md)), for the C6 and as wasm for the browser
  preview, and the load-time RV32 JIT. **`osc/`** handles OSC input onto uniforms.
- **`region/`, `sysmode/`, `sysheap/`** — fixed pools, slabs and mode-union
  regions (with Kani proofs); the reachability-checked memory-mode model that the
  firmware tracks; and the heap wrappers behind the post-boot census. See
  [`docs/design/memory-regions.md`](./docs/design/memory-regions.md).
- **`pattern/`, `player/`, `store/`, `arena/`, `landing/`**:
  - `pattern`: the hue-code pattern generator, golden-tested against the phone
    decoder;
  - `player`: the transport-free session state machine;
  - `store`: decode-into-arena persistence;
  - `arena`: the bump allocator;
  - `landing`: the on-device Soft-AP landing page.
- **`pulse/`** — the topology pulse/flood simulator, now used only by the web
  simulator (`pulse_web`). The firmware no longer has native playback, so every
  show is an FX effect.

**Memory is a checked budget.** Every by-value protobuf envelope, task stack and
static is accounted for. The shared heap's worst case is measured on HITL
(`ram_audit`), and two CI gates keep it that way:

- `//firmware/sysmode` reachability: no reachable mode exceeds the budget;
- `//firmware/player_app:stack_bound_test`: each task's static worst-case stack
  bound fits its reservation.

See [`docs/design/ram-budget.md`](./docs/design/ram-budget.md).

The firmware build rules, platform constraints, and vendored Arduino/ESP libraries
(FastLED, BLE, Wi-Fi, webserver, mbedtls/TLS, partitions) come from a separate
Bazel module, **`@embedded`** (`fughilli/embedded`), pinned via `archive_override`
in `MODULE.bazel`. Because `@embedded` sources its toolchains and Arduino cores
from Nix, **Nix is a hard prerequisite** (below).

### Shared pieces

- **`shared/protocol/`** — the single source of truth for the wire protocol: JSON
  schemas + `proto/ledmapper.proto` → generated Python and TypeScript bindings,
  byte-pinned by a freshness check. Rust gets micropb structs plus zero-copy
  views from **`oss/pbview`** (a self-contained `no_std` protobuf view generator
  meant for separate publication); the firmware decodes every request in place.
- **`agent/`** — the AI-agent bridge: an MCP server + one-shot CLI over a hub
  that discovers and drives every player on the LAN (rooms, poses, shared time
  base). Released as `splanc-agent-<ver>.tgz` with each firmware release and
  served from splanc.io — see [`agent/README.md`](./agent/README.md).
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
bazel build -c opt //firmware/player_app:esp32c6_netstack //firmware/player_app:esp32c6_netstack_flashbundle
```

Other useful targets:

```sh
bazel run //firmware/fx_vm:fx_vm_test        # effects VM unit tests
bazel run //fx_compiler:fx_compile -- ...    # compile an .fx source to .fxb
bazel build //firmware/fx_vm:fx_vm_web       # the VM wasm bundle the editor loads
```

**CI (`.github/workflows/test.yaml`)** runs three jobs on every PR/push to `main`:

- `test` — the light path: `bazel test //...` (does not build the firmware image).
- `firmware` — builds the `esp32c6_netstack` (and `esp32c3_netstack`) flash
  bundles explicitly, so firmware compile/link breakage is still caught, and uploads the
  bundle artifact (also staged under `/firmware/` for in-browser USB flashing).
- `lint` — the pre-commit gate (`prek`/pre-commit, byte-identical to the local
  hooks).

Run `pre-commit run --all-files` locally before pushing — the hooks (black/isort/
flake8, buildifier, prettier, markdownlint, shellcheck, …) are pinned in
`.pre-commit-config.yaml`. The on-hardware **HITL** suite runs separately (below).

Editing `.pre-commit-config.yaml` has one extra step: the agent container bakes
prek's hook environments into its image (a cold build of those toolchains is
~40s, and `claude-container` runs `docker run --rm`, so without the bake every
session pays it again — see `.claude-container-overlay/Dockerfile`). The bake is
seeded from `.claude-container-overlay/pre-commit-config.yaml`, a byte-identical
copy that the `prek-overlay-config-copy` hook refreshes for you (or run
`tools/sync_prek_overlay_config.sh`). Commit the copy with the config change and
relaunch `claude-container` to pick up the rebuilt image; until then the
container just rebuilds the drifted hooks in the background at startup.

## Try the pipeline with no hardware

```sh
# Synthetic capture -> solve, end to end:
bazel run //shared/simulator:simulate -- --fixture cube --leds 64 --noise none -o /tmp/log.json
bazel run //pi/reconstruction:reconstruct -- /tmp/log.json -o /tmp/map.json

# Serve the real web app + control plane over HTTPS, plus a "virtual LED wall" you
# can point a phone at (/wall.html) to exercise the whole live pipeline:
bazel run //web:serve         # https://0.0.0.0:8443
```

The web app deploys to Cloudflare Pages (ledmapper.pages.dev, splanc.pages.dev)
via `//web:deploy_cloudflare`; splanc.pages.dev itself is retired as an app
origin (`web/_worker.js` 301s it to <https://splanc.io/app> and keeps only the
`/gh-asset` and demo-AI API routes). Every `app-v*` tag also publishes a GitHub Release
carrying the built tree as `splanc-webapp-<ver>.tar.gz` (+ `.sha256`); the
splanc.io site (Studio-Fug/splanc.io) stages the newest one at
<https://splanc.io/app>, so it follows app releases without a manual bump. The
same site serves the agent entry point (`/AGENTS.md`, `/llms.txt`,
`/agent/splanc-agent.tgz`) from the newest `firmware-v*` release's agent bundle.

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
and isolated USB tree. To debug BLE at the link layer, `hitl btmon start|stop|fetch`
(or the windowed `hitl btmon capture -- <cmd>`) grabs a bounded, host-side HCI
btsnoop of your reservation that opens in `btmon -r`/Wireshark — note the rig's one
BT controller is shared across DUTs, so the trace is annotated by the DUT BLE MAC,
not isolated (FUG-93). The design lives in `pi/hitl/DESIGN.md` and `pi/hitl/README.md`.

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
- **`loaded_tls_netstack`** — fresh TLS handshakes on a heap loaded with a 2048-LED
  map (1024 per channel) + texture effect (the FUG-71 failure mode).
- **`led_capacity`** — `--per-channel N` on both channels (`--expect-refusal`
  checks one past the board's per-channel cap is refused; growing past the boot's
  LED buffers must answer `reboot_required` and come back resized), a 2 × N map +
  topology round trip through `get_stored_map`, an animated effect's `fps_state`
  (wire ceiling, floor) and PerfReport heap, then fresh handshakes on that heap.
  `--improv` provisions over BLE. Run it at 256 and 1024 (the default and the max
  config). Pair it with `led_timing --leds 2048 --split 1024` for the per-channel
  wire timing on the analyzer.
- **`ram_audit`** — the same worst case under a non-halting JTAG heap watcher
  (`ram_watch.tcl`); dumps SRAM at the minimum watermark and reads the heap
  census / sysmode counters at the end. `--hang` adds `hang_watch.tcl`, which
  freezes the core on a stopped tick before the watchdog can erase the evidence.
  Dumps are armed only after provisioning (a ~46 s halt during the Wi-Fi join
  causes a watchdog reset that looks like a firmware hang).
- **`time_base_skew`** — two analyzer-tapped DUTs on one shared epoch; asserts
  inter-fixture skew < 20 ms.

Every HITL failure carries the DUT's serial log (the `hitl-serial-logs` artifact).
That capture pauses while a test reads the console itself, so each test also saves
its own console windows and other files to `$TEST_UNDECLARED_OUTPUTS_DIR`. CI
unpacks every test's `outputs.zip`, failed retry attempts included, into the
`hitl-test-outputs` artifact (`<package>/<target>/test.outputs/` and
`.../test_attempts/attempt_N.outputs/`).

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
- **Gate:** a program passes if its frame is within its margin of the golden —
  default **10%**, `sweep16` **15%** — **or** within an absolute floor of
  **8,000 cycles** (50 µs at 160 MHz), whichever is looser. Only frame cycles are
  gated; show cycles are noisier and excluded.
- **Why the floor:** every frame starts with a partly cold flash cache, and that
  fixed cost moves with code layout alone, by about 7-8 K cycles (never-called
  padding moved `sweep16` by 13-18%). That is a large percentage of the 16-LED
  `sweep16` (~34.5 K cycles) but under 1% of a real effect, so the floor only
  matters for goldens under ~80 K cycles. A `FLOOR` log line names each effect
  that passed by the floor alone; `OFF` lines are offenders. The values live in
  the golden's `fxBenchMargins` (`default`, `perLabel`, `floorCycles`), stamped
  from `fx_bench.py` on `--emit-golden`; `--margin` / `--floor-cycles` override
  them for a run.

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
| `agent/`            | AI-agent bridge: MCP server + CLI hub over every player on the LAN; the release bundle + splanc.io site files        |
| `oss/pbview/`       | zero-copy `no_std` protobuf views + generator (self-contained, for separate publication)                             |
| `requirements/`     | the requirements model (`requirements.yaml`) the tests trace to                                                      |
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
- **Decisions & runbook:** `docs/decisions.md`, `docs/runbook.md`; the reasoning
  behind the big ones: `docs/manifesto.md`.
- **Agent bridge:** `agent/README.md`, `docs/design/agent-multi-fixture.md`.
- **HITL:** `pi/hitl/README.md`, `pi/hitl/DESIGN.md`.
- **Project history:** `WORKLOG.md`; roadmap: `next_steps.md`.
