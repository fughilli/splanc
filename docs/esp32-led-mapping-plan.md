# ESP32-based LED Mapping + Playback — Build Plan

> Status: **approved, unblocked.** Originally blocked on an in-flight protobuf
> port + solver work; that stack has LANDED (branches `proto-comms` →
> `rust-wasm-solver` → `hue-only-signaling`, on which this branch now sits) and
> delivered more than the blockers: the wire is already binary protobuf, the
> VIO solver is already Rust with a wasm phone-side deployment + `submit_map`
> upload, and the blink code is now a hue-only carrier with an adaptive symbol
> alphabet. Phases below are re-scoped against that reality — several are
> **done** or shrank to deltas. Source spec: `embedded/spec`.

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

Today the LED-mapper is **Pi-centric**: a Pi drives a strip through the hue
code (constant-brightness color code — the intensity blink was removed because
its dark frames broke track association), a phone decodes it, and the final
solve runs wherever the init-time placement benchmark says (phone wasm vs Pi
native — `web/src/solver/placement.ts`). The spec asks to make an **ESP32-C6**
a first-class player and push all heavy compute to the phone, keeping the
**Pi as a second player target** for large fixtures (GPU-accelerated playback).

The end-state has **one phone "brain"** (capture → CV → counting → VIO
reconstruction → optional skeletonization) and **two player targets** behind
**one stable protobuf protocol**: an ESP32-C6 (RMT LED output, WSS, no_std
Rust playback, arena-allocated) and a Pi (serves the full webapp, CPU→GPU
playback, reuses existing SPI driver).

Confirmed decisions, annotated with what already landed:

- **Wire format = protobuf. ✅ LANDED** (`proto-comms`): the WebSocket carries
  binary `ledmapper.v1` frames (`shared/protocol/proto/ledmapper.proto`);
  TS = protobuf-es (checked-in `web/src/gen/`), Python = protobuf via a
  hermetic toolchains_protoc. **Delta for this plan:** the **micropb (no_std
  Rust) backend** for firmware, and reshaping the message set into the player
  protocol (below). Note the landed design keeps the JSON schemas as the §7
  source of truth with a JSON-parity proto + thin boundary converters
  (`pi/server/server/proto_wire.py`, `web/src/net/proto.ts`) — the original
  idea of deleting `codegen.py` outright is deferred; firmware only needs the
  proto file, which already exists.
- **Vendor** the `embedded` repo as a Bazel module. `rules_rust` **is already
  in MODULE.bazel** (0.71.3, with a wasm32 target + crate_universe) — vendoring
  now only needs to reconcile versions, not introduce the rules.
- **Reconstruction → Rust→WASM on the phone. ✅ LANDED** (`rust-wasm-solver`):
  the full VIO pipeline is ported (`solver/` crate — hand-rolled sparse
  LM/LSMR, zero external math deps; parity vs the Python reference pinned by
  `//pi/reconstruction:rust_parity_test` at <3 mm / <2 % scale), deployed as
  `//solver:solver_web` (wasm + worker, served at `/solver/`), with
  `stop_mapping{solveOnHost:false}` → local solve → `submit_map` upload
  already on the wire. **WebXR deprecation remains open** (M6): capture is
  already getUserMedia + IMU on the fallback path; the WebXR path still
  exists and should be deleted.
- **Pi playback = CPU illuminate first, GPU (GLES) later.**
- **Firmware memory = arena allocator** (no general heap; statically bound what
  can be; total LED count flexible up to arena capacity; deterministic OOM).
- **ESP32 transport = WSS** (RFC6455 over `esp_https_server` + mbedtls, self-signed).

## Target architecture

- **Phone brain (`web/`):** getUserMedia + IMU capture → optical decode
  (`web/src/cv`, `web/src/code`) → color-block LED counting → **VIO solver
  (Rust→WASM — exists)** → OutputMap → optional **skeletonization (WASM)** →
  upload map+topology to a player. Against an ESP32 there is NO host solve:
  the player never advertises `solverBenchMs`, and
  `chooseSolvePlacement(phone, null)` already answers "phone" — only the
  wasm-unavailable fallback needs an explicit "no solver on this player" error
  path.
- **Stable player protocol (protobuf/WSS):** clock-sync (SNTP — exists),
  CodeParams start/stop (exists), **counting handshake (new)**, map upload
  (`submit_map` — exists) **+ topology (new)**, **playback control (new)**.
  Detection/IMU upload and `get_solve_status`/`get_live_map` polling exist
  only on the Pi profile (they serve the host-solve + live-map paths); the
  ESP32 profile drops them.
- **ESP32-C6 player:** RMT WS2812 output; WSS server; micropb decode into
  arena; no_std Rust pulse/WLED engine; **hue-code pattern gen** (per-LED
  colors — the carrier has no on/off sets anymore, which the RMT path needs
  anyway); points phone at an externally-hosted webapp.
- **Pi player:** serves the whole webapp (reuse `pi/server`); same
  protobuf/WSS API; CPU illuminate first, GLES shader later; drives existing
  `pi/led_driver` SPI sink (already renders per-LED colors —
  `frame_bytes_colors`). `pi/reconstruction` is **NOT dead code**: it is the
  parity reference for the Rust solver (`rust_parity_test`), the automatic
  fallback when the native binary is absent, and the replay-tooling engine
  (`vio_replay.py`). Keep it.

## Protocol design (protobuf)

**Base exists**: `shared/protocol/proto/ledmapper.proto` (package
`ledmapper.v1`) already carries the full §7 set as a oneof envelope — Hello,
TimeSyncPing/Pong, StartMapping/Configure (CodeParams with the hue `symbols`
alphabet), StopMapping(+solveOnHost)/MappingStopped, Detections/ImuBatch,
ExposureReport, status/pattern/live-map/solve-status polls, SubmitMap,
ResultReady, Error. Cross-language byte-parity is pinned by
`web/tests/golden_proto_frames.json` (Python-generated, TS-verified).

Remaining protocol work:

- **Counting handshake** (Phase 5): command color-block/spatial-binary
  patterns + report detected counts per output channel.
- **Topology**: extend the map upload with `branch_points`, `segments`, and
  the per-LED association `(segment_id, foot_arclength, d_perp)` — either
  new fields on OutputMap or a sibling message.
- **Playback control**: effect selection + params (intensity,
  glow_radius/`soft`, agent count, palette — mirror the pulse reference's
  tunables).
- **Player profiles**: document which envelope arms each player implements
  (ESP32: no Detections/ImuBatch/solve polls); unknown-arm handling on
  firmware = bounded error, not panic.
- **micropb backend** wired as a Bazel genrule (like the existing
  toolchains_protoc genrule for Python), and a **cross-target conformance
  test**: extend the existing golden-frames fixture so the SAME bytes
  round-trip identically in TS/Python/Rust (micropb default/presence handling
  can differ from canonical protobuf).

**Keep `shared/protocol/fec.py`** — it is optical-channel FEC, not transport.

## Phases (dependency-ordered; each has a testable artifact)

**Phase 0 — Bazel foundations.** (a) Vendor embedded (`local_path_override` +
submodule at `third_party/embedded`); **accept:** `bazel build
@embedded//apps/blink:esp32c6` green from workspace root. Reconcile its
`rules_rust` with the workspace pin (0.71.3). (b) ~~Add rules_proto/protobuf +
rules_rust crate_universe~~ **done** (proto-comms/rust-wasm-solver) — remaining:
add the `riscv32imac-unknown-none-elf` triple to the existing rust toolchain
and `heapless`/`micropb` to the existing crate_universe; **accept:** resolve
`heapless` for the C6 triple. (c) Wire the micropb codegen backend (TS/Python
backends already exist). Use the **bazel-polyglot-nix** skill.

**Phase 1 — Protocol reshaping.** ~~Migrate the wire from JSON to binary
proto~~ **done** (proto-comms; the 4 seams listed in the original plan are
already binary). Remaining: author the counting/topology/playback additions,
define the player profiles, and land the Rust conformance leg. **Accept:**
cross-target conformance green; existing mapping flow unchanged (30-target
suite stays green).

**Phase 2 — RMT LED output.** Port FastLED output from bit-bang
(`apps/rainbow/rainbow.cpp:11`) to the C6 **RMT** peripheral. **Accept:** drive
WS2812B via RMT **while a WSS connection stays live** for 60s with no dropped
pings or frame glitches. **This is the existence proof for the ESP32 target —
run it as the first spike (R1).**

**Phase 3 — Arena allocator + micropb data model.** Bump-allocator arena;
statically bound frame buffers / decode scratch (`heapless`); arena-back the
variable-size map/topology (LED count flexible to capacity). Bind micropb
container traits to arena slices; **decode-into-arena** for chunked map
upload; deterministic `ArenaFull` → bounded protocol error. NVS persistence
via the same decoder. **Accept:** host `std` test decodes a chunked upload into
the arena, hits clean OOM at capacity+1, and round-trips through NVS. **Must
precede Phase 4/5** (they decode into it).

**Phase 4 — Pattern-gen + clock + WSS on ESP32.**

- 4a **Pattern generator**: port the HUE code plan —
  `pi/led_driver/led_driver/graycode.py` (`color_plan`/`symbol_at`/`codeword`
  - FEC, `symbols` = 2 and 4) → no_std Rust. Every frame is per-LED RGB
    (white/green sync + the Gray-ordered symbol palette); there are no on/off
    sets anymore, which is exactly the shape the RMT path wants. **Accept:**
    frame-for-frame match vs the Python goldens
    (`web/tests/golden_secded16.json` AND `golden_secded16_sym4.json`).
- 4b **SNTP clock** on `esp_timer` (SDK bundles lwip SNTP); **accept:** offset
  convergence + a **documented drift bound / re-sync cadence**.
- 4c **WSS transport**: RFC6455 over `esp_https_server` + mbedtls. SDK has
  **no WebSocket lib** — use `httpd_ws_*` if the Arduino-merged tree exposes
  it, else vendor a minimal frame codec. **Accept:** browser opens a WSS session
  to the self-signed endpoint and exchanges one proto message each way.

**Phase 5 — LED counting.** Firmware displays commanded color-block/spatial-
binary patterns; phone CV detects blocks and binary-searches strip length;
counting handshake messages. The hue palette's classification machinery
(white-normalized nearest-palette matching in `web/src/cv/decoder.ts`) is
directly reusable for block-color detection. **Accept:** arbitrary soldered
length → correct count.

**Phase E — ~~VIO solver Rust→WASM~~ ✅ LANDED + WebXR removal.** The solver
port is done and exceeds the original spec of this phase: `solver/` crate
(so3/preintegration/LSMR/LM/pipeline, no faer/nalgebra needed — hand-rolled
numerics kept the wasm small), `//pi/reconstruction:rust_parity_test` pins
solution-space parity vs `vio.py`, the wasm ships as `//solver:solver_web`
with a worker + `SolverAgent`, the placement benchmark runs at init on both
ends, and phone-solved maps upload via `submit_map`. A Rust synthetic fixture
also exists (`solver/src/synth.rs` — the canned benchmark scene). Remaining
in this phase:

- **WebXR removal** (M6): delete `web/src/xr/webxrCapture.ts` +
  `webxr-camera.d.ts`, keep `mediaStreamCapture.ts`/`imu.ts`/`intrinsics.ts`;
  fix `pi/server/server/tls.py` docstring (it justifies TLS by WebXR — the
  real reasons now are getUserMedia/DeviceMotion secure contexts + WSS).
- **ESP32 solve flow**: the phone must not offer/attempt host solve against a
  player with no solver (no `solverBenchMs` in welcome → placement already
  says "phone"; surface a clear error if wasm is unavailable there).
- **_(Optional, later)_** move the TS↔wasm boundary from JSON strings to proto
  bytes (`observation.proto` idea) — pure optimization; the JSON boundary is
  landed and tested.

**Phase F — Skeletonization + association export.** Port `skelgraph`
(reduce/neighbors/cleanup/topology) to WASM (Rust, consistent with the solver
— confirm at impl; TS/Pyodide are fallbacks). **Net-new upstream work**: write
the per-LED `(segment_id, foot_arclength, d_perp)` **association exporter**
(graph-extractor marks it "still TODO"). **Accept:** WASM skelgraph matches
Python on the test datasets; association reproduces the naive illuminate.

**Phase G — Playback engines.** Shared Rust **pulse sim** crate from the
reference (`graph-extractor` `viz/static/index.html`: `pulseBuildModel`/
`pulseStep`/`pulseWorldPos`/`pulseIlluminate`). Two illuminate backends: ESP32
no_std (arena-backed, O(N) via the association export), Pi CPU (then GLES).
Plus WLED-like generic effects + the effect-param model/config UI. **Accept:**
identical pulse frames across the Rust reference and both targets on a fixed
seed; ESP32 sustains target FPS within arena bounds.

## Arena / micropb detail (Phase 3)

- **Static (`heapless`):** color-plan buffers, proto decode scratch, WSS
  reassembly, SNTP state, NVS keys, `CodeParams`.
- **Arena (bump):** LED xyz map, topology (branch points + segments), per-LED
  association. LED count flexible up to arena capacity.
- **Binding:** implement micropb container traits over `&'arena mut [T]`
  cursors; streaming decode bump-appends chunked `LedEntry`s into a region
  sized from the upload header. `ArenaFull` → micropb decode error → bounded
  "map too large" reply + cursor reset (no alloc, no panic, no partial-write
  UB).
- **Persistence:** store the decoded map as an opaque proto blob in NVS keyed
  by map-id/hash; reload decodes via the **same** micropb path (one format);
  re-runs the OOM check.
- **Verify:** confirm micropb compiles no_std + `-Cpanic=abort` + no `alloc`
  feature for the C6 triple (R3 spike).

## Missing work folded in

M1 ESP32 self-signed cert provisioning (build-time bake or first-boot mbedtls
into NVS; stable SAN = mDNS name). M2 **secure-context/mixed-content spike**
(below). M3 effect-param proto + config UI. M4 `esp_timer` drift budget +
re-sync cadence. M5 Pi player reuse boundary — but **keep**
`pi/reconstruction` and the server solve path: they are the Rust solver's
parity reference, fallback, and the placement benchmark's host side on the Pi
profile. M6 WebXR cleanup (see Phase E). M7 ~~confirm the optical decode runs
on the phone~~ confirmed — it always has (`web/src/cv`, `web/src/code`), and
the hue-only carrier removed its dependence on blob on/off tracking. M8
extend the M9 simulator to emit IMU + real timestamps (note
`solver/src/synth.rs` + `test_rust_parity.py::synth_session` already provide
synthetic IMU fixtures — the M9 gap is only for simulator-driven flows). M9
build/vendor the RFC6455 codec. M10 cross-target proto conformance test
(extend `golden_proto_frames.json` to a Rust/micropb leg).

## Risks & first spikes (run before committing the dependent phase)

- **R1** RMT-while-WiFi coexistence on single-core C6 — _existence proof for
  the whole ESP32 target._ Spike a throwaway RMT+WSS-ping app first.
- **R2** Self-signed WSS from an **externally-hosted** origin has no
  background trust path (a `wss://esp32.local` self-signed cert can't be
  click-through-approved from `app.example.com`). Spike Chrome + iOS Safari
  trust flows before Phase 4c. Likely resolution: ESP32 serves a minimal
  **same-origin** landing page so the user approves the cert once, then
  loads/bounces to the external app. May reopen WS-vs-WSS.
- **R3** micropb + heapless + arena on `riscv32imac-none`, panic=abort, no
  alloc.
- ~~**R4** VIO estimator harness doesn't exist~~ — resolved: the Rust port
  landed with a parity harness.
- ~~**R5** Sparse-LM numerical parity Rust↔scipy~~ — resolved: parity is
  asserted in solution space (<3 mm cross-solver agreement), which proved
  sufficient; no bit-level scipy matching was needed.
- **R6** graph-extractor association exporter is unwritten — prototype vs one
  `viz/trace.py` fixture before the O(N) illuminate.
- **R7** Clock drift across esp_timer + Pi + phone — measure raw vs SNTP drift.
- ~~**R8** Protocol cutover touches 4 seams / 3 languages~~ — resolved: the
  TS/Python cutover landed (proto-comms); the remaining leg is firmware-only
  and additive.

## Key files

- Protocol: `shared/protocol/proto/ledmapper.proto` (the wire),
  `shared/protocol/{schemas/*.json,codegen.py}` (§7 source of truth + internal
  bindings), boundary converters `pi/server/server/proto_wire.py` +
  `web/src/net/proto.ts`, golden `web/tests/golden_proto_frames.json`,
  `shared/protocol/fec.py`
- Solver (landed): `solver/src/{vio.rs,pipeline.rs,lm.rs,sparse.rs,imu.rs,
synth.rs}`, `solver/worker.js`, `web/src/solver/{agent.ts,placement.ts}`,
  parity `pi/reconstruction/tests/test_rust_parity.py`
- Pattern gen (hue): `pi/led_driver/led_driver/{graycode.py,driver.py,spi.py,
clock.py}`, `gen_golden.py`, TS mirror `web/src/code/gray.ts`, goldens
  `web/tests/golden_secded16{,_sym4}.json`
- Wire seams: `web/src/net/client.ts`, `pi/server/server/{app.py,handler.py}`
- Firmware (vendored): `third_party/embedded/{MODULE.bazel,rules/firmware.bzl,
apps/rainbow/rainbow.cpp,rust/blink_timing/,libs/{board,pins}/,nix/arduino_esp32.BUILD}`
- Pulse ref: graph-extractor `viz/static/index.html`, `skelgraph/`,
  `viz/trace.py` (branch `viz-offline-render`)
- Bazel: `MODULE.bazel` (rules_rust + crate_universe + toolchains_protoc
  already present), `web/BUILD.bazel`, `requirements.in`, `pnpm-workspace.yaml`

## Verification

- **Per phase:** the acceptance artifact above (Bazel builds, golden matches,
  round-trip/conformance tests, the RMT+WSS 60s coexistence bench).
- **Firmware (no hardware):** `esptool image-info` on the `.bin`;
  `riscv…-nm` resolves the Rust pulse/pattern symbols; host `std` tests for
  arena + micropb.
- **Firmware (hardware):** `bazel run //…:flash_esp32c6`; WSS handshake from a
  phone; visual hue-code cadence via high-FPS camera (colors, not blinks);
  pulse animation on a strip.
- **Solver:** already verified — `rust_parity_test` + the 17-test Rust suite;
  keep them green.
- **End-to-end:** phone captures → solves in-browser → uploads to a bench
  ESP32 and the Pi → both play the pulse; `bazelisk build //...` and
  `bazelisk test //...` green.
- Existing suite (**30** targets) stays green through the remaining protocol
  additions.
