# ESP32-based LED Mapping + Playback — Build Plan

> Status: **approved, not started.** Blocked on landing an in-flight protobuf port
> + solver bug-fixes from another checkout. Pick this up once those are merged.
> Source spec: `embedded/spec`.

## Reference repos (private)

Two private repos are referenced; clone with the personal GitHub SSH key
(`credentials/id_ed25519_personal_github`, never commit it):

- `git@github.com:fughilli/embedded.git` — the ESP32-C6 + RP2350 firmware monorepo
  (Bazel, no_std Rust + Arduino/FastLED). **Vendored** into this repo at
  `third_party/embedded` (Phase 0a).
- `git@github.com:fughilli/graph-extractor.git` — point-cloud → topology
  (skeletonization). The **pulse reference** lives on branch `viz-offline-render`
  at `viz/static/index.html` (agent-based sim). `main` is topology-only.

## Context

Today the LED-mapper is **Pi-centric**: a Raspberry Pi drives a strip through a
Gray-code blink, a phone decodes it, and the **Pi** runs 3D reconstruction to
recover `(led_id → xyz)`. The spec asks to make an **ESP32-C6** a first-class
player and push all heavy compute to the phone, while keeping the **Pi as a second
player target** for large fixtures (GPU-accelerated playback).

This is a re-architecture, not an add-on. The end-state has **one phone "brain"**
(capture → CV → counting → VIO reconstruction → optional skeletonization) and
**two player targets** behind **one stable protobuf protocol**: an ESP32-C6
(RMT LED output, WSS, no_std Rust playback, arena-allocated) and a Pi (serves the
full webapp, CPU→GPU playback, reuses existing SPI driver).

Confirmed decisions:
- **Wire format = protobuf.** micropb (no_std Rust) on firmware; regen TS + Python too.
- **Vendor** the `embedded` repo as a Bazel module (brings `rules_rust`).
- **Reconstruction → Rust→WASM** on the phone. **WebXR is deprecated**; capture is
  getUserMedia + DeviceMotion IMU, and **only the VIO joint solver** is kept.
- **Pi playback = CPU illuminate first, GPU (GLES) later.**
- **Firmware memory = arena allocator** (no general heap; statically bound what can
  be; total LED count flexible up to arena capacity; deterministic OOM).
- **ESP32 transport = WSS** (RFC6455 over `esp_https_server` + mbedtls, self-signed).

## Target architecture

- **Phone brain (`web/`):** getUserMedia + IMU capture → optical decode
  (`web/src/cv`, `web/src/code`) → color-block LED counting → **VIO solver
  (Rust→WASM)** → OutputMap → optional **skeletonization (WASM)** → upload
  map+topology to a player. No server solve.
- **Stable player protocol (protobuf/WSS):** clock-sync (SNTP), CodeParams
  start/stop, counting handshake, map+topology upload, playback control. Detection
  upload + reconstruction leave the wire entirely (phone-internal now).
- **ESP32-C6 player:** RMT WS2812 output; WSS server; micropb decode into arena;
  no_std Rust pulse/WLED engine; Gray-code mapping pattern gen; points phone at an
  externally-hosted webapp.
- **Pi player:** serves the whole webapp (reuse `pi/server`); same protobuf/WSS
  API; CPU illuminate first, GLES shader later; drives existing `pi/led_driver` SPI
  sink. `pi/reconstruction` becomes dead code (delete).

## Protocol design (protobuf)

Replace `shared/protocol/schemas/*.json` (5) + the bespoke `codegen.py` (913 lines)
with `.proto` as the single source of truth. **Keep `shared/protocol/fec.py`** —
it is optical-channel FEC, not transport.

- `mapping.proto` — clock-sync (SNTP 4-timestamp), `CodeParams`, start/stop,
  pattern-clock state, **counting handshake**.
- `map.proto` — `OutputMap`/`LedEntry` (`id,xyz,confidence,nViews,rmsReprojPx,
  parallaxDeg`), plus **topology** (`branch_points`, `segments`) and the per-LED
  **association** `(segment_id, foot_arclength, d_perp)`.
- `playback.proto` — effect selection + params (intensity, glow_radius/`soft`,
  agent count, palette — mirror the tunables in the pulse reference).
- `observation.proto` — `DetectionRecord` + `ImuSample`; the **phone-internal**
  TS↔WASM-solver boundary (not on the wire).

Codegen: TS via `ts-proto`/`protobuf-es` (lands in `shared/protocol/ts/generated/`,
consumed as pnpm pkg `@ledmapper/protocol`); Python via `protobuf`/`betterproto`;
Rust via **micropb-gen** wired as a Bazel `run_binary`/genrule (not cargo build.rs).
The freshness genrule (`shared/protocol/BUILD.bazel:64-83`) becomes a
proto-vs-generated diff. **Add a cross-target conformance test**: the same bytes
must round-trip identically across TS/Python/Rust (micropb default/presence
handling can differ from canonical protobuf).

## Phases (dependency-ordered; each has a testable artifact)

**Phase 0 — Bazel foundations.** (a) Vendor embedded (`local_path_override` +
submodule at `third_party/embedded`); *accept:* `bazel build @embedded//apps/blink:esp32c6`
green from workspace root. (b) Add `rules_proto`/`protobuf` + `rules_rust`
`crate_universe`; *accept:* resolve `heapless` for `riscv32imac-unknown-none-elf`.
(c) Wire the 3 proto codegen backends (not yet swapped in). Use the
**bazel-polyglot-nix** skill (this repo already combines Nix + bzlmod).

**Phase 1 — Protocol swap.** Author `.proto`, migrate the 4 encode/decode seams
(`web/src/net/client.ts:288/297`, `pi/server/server/app.py:190`,
`handler.py:88`) from JSON to binary-proto WS frames; shrink to the player message
set; delete removed message types. *Accept:* proto round-trip + cross-target
conformance test green; existing mapping flow works over protobuf. Migrate **one**
message (clock-sync) end-to-end behind a flag first, then fan out.

**Phase 2 — RMT LED output.** Port FastLED output from bit-bang
(`apps/rainbow/rainbow.cpp:11`) to the C6 **RMT** peripheral. *Accept:* drive
WS2812B via RMT **while a WSS connection stays live** for 60s with no dropped pings
or frame glitches. **This is the existence proof for the ESP32 target — run it as
the first spike (R1).**

**Phase 3 — Arena allocator + micropb data model.** Bump-allocator arena;
statically bound frame buffers / decode scratch (`heapless`); arena-back the
variable-size map/topology (LED count flexible to capacity). Bind micropb container
traits to arena slices; **decode-into-arena** for chunked map upload; deterministic
`ArenaFull` → bounded protocol error. NVS persistence via the same decoder.
*Accept:* host `std` test decodes a chunked upload into the arena, hits clean OOM at
capacity+1, and round-trips through NVS. **Must precede Phase 4/5** (they decode into it).

**Phase 4 — Pattern-gen + clock + WSS on ESP32.**
- 4a **Pattern generator**: port `pi/led_driver/led_driver/graycode.py`
  (`frame_plan`/`codeword` + FEC) → no_std Rust; *accept:* frame-for-frame match vs
  `pi/led_driver/gen_golden.py` goldens (`web/tests/golden_secded16.json`).
- 4b **SNTP clock** on `esp_timer` (SDK bundles lwip SNTP); *accept:* offset
  convergence + a **documented drift bound / re-sync cadence**.
- 4c **WSS transport**: RFC6455 over `esp_https_server` + mbedtls. SDK has **no
  WebSocket lib** — use `httpd_ws_*` if the Arduino-merged tree exposes it, else
  vendor a minimal frame codec. *Accept:* browser opens a WSS session to the
  self-signed endpoint and exchanges one proto message each way.

**Phase 5 — LED counting.** Firmware displays commanded color-block/spatial-binary
patterns; phone CV detects blocks and binary-searches strip length; counting
handshake messages. *Accept:* arbitrary soldered length → correct count.

**Phase E (parallel track) — VIO solver Rust→WASM + WebXR removal.** Depends only
on Phase 1 proto shapes. See "VIO port" below. *Accept:* Rust solver matches Python
`vio.py` per-stage within tolerance on the E1 fixture + reproduces `vio_replay.py`
shape-consistency scores on a real capture; phone produces a map with no server.

**Phase F — Skeletonization + association export.** Port `skelgraph`
(reduce/neighbors/cleanup/topology) to WASM (Rust, consistent with the solver —
confirm at impl; TS/Pyodide are fallbacks). **Net-new upstream work**: write the
per-LED `(segment_id, foot_arclength, d_perp)` **association exporter** (graph-extractor
marks it "still TODO"). *Accept:* WASM skelgraph matches Python on the test
datasets; association reproduces the naive illuminate.

**Phase G — Playback engines.** Shared Rust **pulse sim** crate from the reference
(`graph-extractor` `viz/static/index.html`: `pulseBuildModel`/`pulseStep`/
`pulseWorldPos`/`pulseIlluminate`). Two illuminate backends: ESP32 no_std
(arena-backed, O(N) via the association export), Pi CPU (then GLES). Plus WLED-like
generic effects + the effect-param model/config UI. *Accept:* identical pulse
frames across the Rust reference and both targets on a fixed seed; ESP32 sustains
target FPS within arena bounds.

## VIO port (Phase E) detail

`vio.py` is a **4-stage estimator**, not a solver: (1) gyro-integrated rotation
seeds, gravity-anchored; (2) known-rotation **linear** init via `scipy.sparse.linalg.lsqr`;
(3) linear visual-inertial alignment (scale/gravity/velocities from IMU
preintegration); (4) nonlinear VI bundle adjustment (`scipy.optimize.least_squares`
TRF + Huber + `jac_sparsity`).

- **Crates:** `faer` (sparse LSQR + sparse linear algebra, closest to scipy) +
  **hand-rolled Levenberg–Marquardt** (JᵀJ+λdiag solved sparsely via faer, Huber
  IRLS — need bit-level control to match scipy for validation) + `nalgebra` for
  dense SO(3)/SE(3) small-matrix ops. All pure-Rust → clean `wasm32`. No BLAS.
- **Boundary:** pass `DetectionRecord`/`ImuSample` batches into WASM as **proto
  bytes**, return `OutputMap` proto bytes (reuses the contract; mirrors
  `pi/reconstruction/reconstruction/vio_api.py::solve_from_wire`). Thin
  wasm-bindgen shim `solve(bytes)->bytes` + a JS progress callback (WASM is
  single-threaded — the `ProgressCb` thread concerns vanish).
- **Validation:** E1 first — formalize `test_vio.py::synth_imu`/`synth_frames` into
  a **shared fixture** (the M9 simulator currently emits no IMU / zero timestamps)
  and capture **per-stage** Python intermediates as golden; port **stage 2 (lsqr)
  first** and match before the nonlinear BA. Real-capture oracle: `vio_replay.py`
  (plane-fit RMS / NN-pitch shape scores). Same Rust crate serves WASM + a native
  CI oracle + (optionally) the Pi.

## Arena / micropb detail (Phase 3)

- **Static (`heapless`):** frame plan/lit-set buffers, proto decode scratch, WSS
  reassembly, SNTP state, NVS keys, `CodeParams`.
- **Arena (bump):** LED xyz map, topology (branch points + segments), per-LED
  association. LED count flexible up to arena capacity.
- **Binding:** implement micropb container traits over `&'arena mut [T]` cursors;
  streaming decode bump-appends chunked `LedEntry`s into a region sized from the
  upload header. `ArenaFull` → micropb decode error → bounded "map too large" reply
  + cursor reset (no alloc, no panic, no partial-write UB).
- **Persistence:** store the decoded map as an opaque proto blob in NVS keyed by
  map-id/hash; reload decodes via the **same** micropb path (one format); re-runs
  the OOM check.
- **Verify:** confirm micropb compiles no_std + `-Cpanic=abort` + no `alloc` feature
  for the C6 triple (R3 spike).

## Missing work folded in

M1 ESP32 self-signed cert provisioning (build-time bake or first-boot mbedtls into
NVS; stable SAN = mDNS name). M2 **secure-context/mixed-content spike** (below).
M3 effect-param proto + config UI. M4 `esp_timer` drift budget + re-sync cadence.
M5 Pi player reuse boundary; delete `pi/reconstruction` + `pi/server/server/reconstruct.py`
dead paths. M6 WebXR cleanup: delete `web/src/xr/webxrCapture.ts` + `webxr-camera.d.ts`,
**keep** `mediaStreamCapture.ts`/`imu.ts`/`intrinsics.ts`, fix `pi/server/server/tls.py`
docstring (it justifies TLS by WebXR). M7 confirm the optical decode
(`web/src/code`, `web/src/cv`) fully runs on the phone (it feeds the solver).
M8 extend the M9 simulator to emit IMU + real timestamps. M9 build/vendor the
RFC6455 codec. M10 cross-target proto conformance test.

## Risks & first spikes (run before committing the dependent phase)

- **R1** RMT-while-WiFi coexistence on single-core C6 — *existence proof for the
  whole ESP32 target.* Spike a throwaway RMT+WSS-ping app first.
- **R2** Self-signed WSS from an **externally-hosted** origin has no background
  trust path (a `wss://esp32.local` self-signed cert can't be click-through-approved
  from `app.example.com`). Spike Chrome + iOS Safari trust flows before Phase 4c.
  Likely resolution: ESP32 serves a minimal **same-origin** landing page so the user
  approves the cert once, then loads/bounces to the external app. May reopen WS-vs-WSS.
- **R3** micropb + heapless + arena on `riscv32imac-none`, panic=abort, no alloc.
- **R4** VIO is a 4-stage estimator and its harness doesn't exist yet — build E1 first.
- **R5** Sparse-LM numerical parity Rust↔scipy — port stage 2 (lsqr) first.
- **R6** graph-extractor association exporter is unwritten — prototype vs one
  `viz/trace.py` fixture before the O(N) illuminate.
- **R7** Clock drift across esp_timer + Pi + phone — measure raw vs SNTP drift.
- **R8** Protocol cutover touches 4 seams / 3 languages — migrate one message first.

## Key files

- Protocol: `shared/protocol/{schemas/*.json,codegen.py,BUILD.bazel,fec.py,ts/,python/}`
- Wire seams: `web/src/net/client.ts`, `pi/server/server/{app.py,handler.py}`
- Solver: `pi/reconstruction/reconstruction/{vio.py,vio_api.py,vio_replay.py,camera.py,triangulate.py}`;
  harness `pi/reconstruction/tests/test_vio.py`; sim `shared/simulator/`
- Firmware (vendored): `third_party/embedded/{MODULE.bazel,rules/firmware.bzl,
  apps/rainbow/rainbow.cpp,rust/blink_timing/,libs/{board,pins}/,nix/arduino_esp32.BUILD}`
- Pattern gen: `pi/led_driver/led_driver/{graycode.py,driver.py,clock.py}`, `gen_golden.py`
- Pulse ref: graph-extractor `viz/static/index.html`, `skelgraph/`, `viz/trace.py` (branch `viz-offline-render`)
- Bazel: `MODULE.bazel`, `web/BUILD.bazel`, `requirements.in`, `pnpm-workspace.yaml`

## Verification

- **Per phase:** the acceptance artifact above (Bazel builds, golden matches,
  round-trip/conformance tests, the RMT+WSS 60s coexistence bench).
- **Firmware (no hardware):** `esptool image-info` on the `.bin`; `riscv…-nm`
  resolves the Rust pulse/pattern symbols; host `std` tests for arena + micropb.
- **Firmware (hardware):** `bazel run //…:flash_esp32c6`; WSS handshake from a
  phone; visual Gray-code cadence via high-FPS camera; pulse animation on a strip.
- **Solver:** Rust vs Python `vio.py` per-stage tolerance on the E1 fixture;
  `vio_replay.py` shape scores on a real capture; run the same crate as a native CI
  oracle (no browser).
- **End-to-end:** phone captures → solves in-browser → uploads to a bench ESP32 and
  the Pi → both play the pulse; `bazelisk build //...` and `bazelisk test //...` green.
- Existing suite (`26` targets) stays green through the protocol migration.
