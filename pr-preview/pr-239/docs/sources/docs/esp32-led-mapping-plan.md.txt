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
  anyway); points phone at an externally-hosted webapp — publish it with
  `bazelisk run //web:deploy_cloudflare` (Cloudflare Pages: the vite bundle
  at `/` + the wasm solver at `/solver/`, same layout the Pi serves; the
  phone then selects its player via `?url=wss://<player>/ws`).
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

- ~~**Counting handshake**~~ **landed** (Phase 1): `set_counting_pattern`
  (ColorBlock list + channel; painting past the strip end IS the length
  probe) → `counting_state`, and `set_led_count` → `led_count_state`
  persisting the detected count per output channel. The Pi latches the
  pattern as protocol state; the display path lands with Phase 5.
- ~~**Topology**~~ **landed** (Phase 1): sibling message, not OutputMap
  fields — `Topology{map_id, branch_points, segments, associations}` with
  the per-LED `(segment_id, foot_arclength, d_perp)` association, uploaded
  via `submit_topology` → `result_ready` (mirrors submit_map; the Pi
  persists `<map_id>.topology.json` next to the map).
- ~~**Playback control**~~ **landed** (Phase 1): `set_playback{effect,
PlaybackParams, map_id}` / `get_playback` → `playback_state`.
  PlaybackParams mirrors the pulse tunables (intensity, glow_radius/`soft`,
  agent_count, speed, palette as 0xRRGGBB ints) as optional overlays. "off"
  is universal; unsupported effects reply `error{unsupported_effect}` (what
  the Pi does until Phase G).
- ~~**Player profiles**~~ **landed** (Phase 1): documented in the
  ledmapper.proto header (CORE vs PI-ONLY arm sets); unknown-arm handling on
  firmware = bounded `error{unsupported}` for request arms, silent drop
  allowed for fire-and-forget arms.
- ~~**micropb backend + cross-target conformance**~~ **landed** (Phase 1):
  `//shared/protocol/rust` generates no_std Rust from the descriptor set at
  build time (micropb-gen 0.5.1 in an ISOLATED host crate universe — its
  std-micropb must not feature-unify onto the firmware's); heapless
  containers with the capacity table in gen_main.rs (Phase 3 re-binds the
  big collections to the arena). `conformance_test` requires every golden
  frame to decode AND re-encode byte-identically — which caught micropb-gen
  ignoring proto3 implicit packing (fixed by explicit `[packed = true]`
  on every repeated scalar; same wire as before).

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

**Phase 1 — Protocol reshaping. ✅ DONE.** ~~Migrate the wire from JSON to
binary proto~~ (proto-comms; the 4 seams listed in the original plan are
already binary); counting/topology/playback additions and player profiles
(see "Remaining protocol work" above — schemas, codegen, proto, both
boundary converters, Pi handler, goldens: 42 cross-language golden frames);
micropb Bazel backend and the Rust conformance leg
(`//shared/protocol/rust:conformance_test`, byte-identical re-encode of all
42 frames). **Accepted:** cross-target conformance green; existing mapping
flow unchanged (suite grew 30 → 34 targets, all green).

**Phase 1½ — Player core + pattern gen (host-side pulls from Phases 3/4a).**
Landed alongside Phase 1 so the firmware protocol/pattern logic is testable
before any hardware exists:

- `//firmware/pattern` (`ledmapper_pattern`): no_std, zero-dep port of the
  hue-code generator, SEC-DED FEC, and the code-book derivation
  (graycode.py, fec.py and codebook.py in one crate). Golden test pins it to
  `web/tests/golden_secded16{,_sym4}.json` — the same fixtures the phone
  decoder is verified against — plus exhaustive single-flip-corrects /
  double-flip-rejects FEC property checks. **Phase 4a's remaining scope is
  the RMT/driver integration, not the pattern math.**
- `//firmware/player` (`ledmapper_player`): no_std, transport-free session
  state machine implementing the CORE player profile (welcome WITHOUT
  solverBenchMs; stop_mapping without solveOnHost=false refused with
  error{unsupported} — no solver here; counting latch with driver-facing
  `counting_color`/`pattern_color` hooks; Pi-only arms bounded per the
  profile rules). Tests: a scripted full phone session (mapping_started
  CodeParams == golden header, emitted pattern == golden colorPlan), and
  every golden CLIENT frame — real phone wire bytes — driven through the
  handler with the reply arm checked against the profile contract and every
  reply required to encode.
- All three crates (`ledmapper_pb`, pattern, player) **build for
  `riscv32imac-unknown-none-elf`** (`--platforms=@embedded//platforms:esp32c6`),
  resolving the software half of **R3** (micropb + heapless, no_std, no
  alloc, on the C6 triple); the remaining R3 scope is panic=abort and
  on-device footprint.

**Phase 2 — RMT LED output.** ~~Port FastLED output from bit-bang to the C6
RMT peripheral~~ **de-scoped by decision (2026-07-12): FastLED is assumed
fine under CPU/WiFi load** (bench: wifi_ap color picker verified; the
player app + `//tools:player_probe` is the sustained-load test). The RMT
port returns only if the bench shows glitches. The R1 60-second
LEDs-while-connection-live acceptance moves onto the player app bench.

**Phase 2½ — Player firmware app (bring-up). ✅ BUILT + PROTOCOL
BENCH-PASSED on hardware** (2026-07-12: `//tools:player_probe` against the
flashed C6 over the soft-AP — every CORE-profile reply contract-clean,
including the arena map+topology uploads and the solverless stop
semantics; clock sync bridged the ~12 h monotonic-domain gap as designed).
`//firmware/player_app` (`bazelisk run -c opt
//firmware/player_app:flash_esp32c6`): WiFi soft-AP (`ledmapper`/
`ledmapper`), HTTP :80 (the R2 landing page, scheme/port-aware bounce), the
full CORE player protocol over plain WS :81, FastLED strip render of the
counting + hue mapping patterns, uploads through the arena. The protocol
brain is the host-tested Rust stack behind a C ABI (`player_ffi.h`; the
device flow is host-tested end-to-end through the same extern "C" surface),
and the RFC 6455 codec is host-tested byte-exactly against the RFC vectors.
Bench it with `//tools:player_probe` (contract-checks every reply;
validated live against the Pi player). **Onboarding pivot (2026-07-12
bench finding): the soft-AP + landing-bounce flow cannot onboard a phone —
a phone joined to the device's AP routes ALL traffic there, so the hosted
app never loads. Primary onboarding is now BLE provisioning (Improv
Wi-Fi BLE, the ESPHome standard): the HOSTED app (Web Bluetooth — Chrome
Android/desktop; iOS has none and keeps manual `?url=`) sends WiFi
credentials over GATT, the device stores them in NVS, joins the LAN in
AP+STA mode (soft-AP stays as the bench fallback), and returns its address
over BLE; the app reloads pointed at it. Both codec ends are pinned to the
SAME test vectors (web/tests/improv.test.ts ==
firmware/player_app/improv_codec_test.cc). Mixed content still gates the
hosted app's actual WS connection until Phase 4c TLS.** Bring-up scope + the Phase 4c
hardening list (TLS/wss, multi-client, STA) in
`firmware/player_app/README.md`. Ships with the `no_ota` partition table
(the image outgrows the default 1.25 MB slot; upstream provides
`partitions_no_ota`).

**Phase 3 — Arena allocator + micropb data model. ✅ DONE (host-side).**
`//firmware/arena` (`ledmapper_arena`): bump arena over a caller-owned
buffer, deterministic `ArenaFull`, checkpoint/rollback (borrow-checked:
`reset*` needs `&mut`, allocations borrow `&self`), plus `ArenaVec`
(grow-and-leak for headerless lists, `with_exact_capacity` for header-sized
ones). `//firmware/store` (`ledmapper_store`): **decode-into-arena** for the
two variable-size uploads — hand-walked field decoders over `micropb`'s
`PbDecoder` (a delta from the original "bind micropb container traits" idea:
generated containers are constructed by `Default`, which cannot reach an
arena without global state; walking exactly OutputMap/Topology is smaller
and keeps the generated bindings for control messages) — LED list pre-sized
from the upload's own `led_count` header, `ChunkedReader` decodes straight
from a WSS fragment list with no contiguous frame buffer, positions stored
as `f32`. `envelope_arm` peeks the oneof arm so the transport routes arms
13/16 around the generated envelope; the player replies `result_ready` /
`error{map_too_large}` (`map_stored`/`topology_stored`/`upload_too_large`).
Persistence: `BlobStore` trait (NVS = opaque upload blob keyed by map id);
reload runs the SAME decoder, re-running the OOM check. **Accepted:** host
std tests decode a chunked 1024-LED upload into one exactly-sized region,
hit clean OOM at capacity+1 with rollback, and round-trip through the blob
store (incl. the OOM re-check on a shrunken arena); golden topology frame
decodes value-exact; everything builds for the C6 triple. Remaining for
hardware: the esp-idf NVS `BlobStore` impl + panic=abort footprint (R3
tail).

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
  **De-risked upstream** (embedded @ 9f91e12, hardware-verified): WiFi
  soft-AP + HTTP webserver work on the C6 (`@embedded//apps/wifi_ap` —
  arduino-esp32 WiFi/WebServer wired into Bazel), and `c_resource_library`
  embeds served pages as C arrays — `//firmware/landing:landing_page`
  already packages the R2 landing page that way (`landing_html[]`, app
  origin baked to the deployed <https://ledmapper.pages.dev>). Remaining 4c
  scope: TLS (mbedtls/esp_https_server) + the RFC6455 codec + proto framing.

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

- ~~**WebXR removal** (M6)~~ **done**: `webxrCapture.ts`, the
  `webxr-camera.d.ts` shims and the XR-layer GL renderers (`points3d.ts`,
  MarkerRenderer) are deleted; `mediaStreamCapture.ts` (now THE capture
  path), `imu.ts` and `intrinsics.ts` (tested; PnP/calibration will want it)
  stay; `tls.py` now justifies TLS by getUserMedia/DeviceMotion secure
  contexts + WSS. The calibrated-K localStorage cache is still READ (legacy
  XR-era calibrations keep their scale) but nothing writes it until the
  phase-4.5 calibration flow.
- ~~**ESP32 solve flow**~~ **done**: on stop, a player that never advertised
  `solverBenchMs` + an unavailable wasm solver now produces a clear error
  (capture stopped with `solveOnHost=false`, nothing solved) instead of a
  doomed host-solve request.
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
build/vendor the RFC6455 codec. M10 ~~cross-target proto conformance test~~
done (extend `golden_proto_frames.json` to a Rust/micropb leg —
`//shared/protocol/rust:conformance_test`).

**M11 — legitimate player certificates via DNS-01 ACME (deferred by choice;
punts the whole R2 cert-exception dance for online installs).** The owner
has a domain and can create A records; when picked up:

1. **DNS**: put the domain's zone on the existing Cloudflare account; give
   each player a DHCP reservation and a public A record to its PRIVATE LAN
   IP (allowed and standard for this), e.g. `pi.leds.<domain>`,
   `esp32-<id>.leds.<domain>` — per-device names, not a wildcard, so one
   leaked device key can't impersonate the rest.
2. **Token**: a SECOND Cloudflare API token with Zone → DNS → Edit on that
   zone only (keep the Pages deploy token separate), dropped under
   `credentials/` like the others.
3. **Issue/renew tooling**: `lego` (or certbot) with the CF DNS provider —
   DNS-01 needs no inbound reachability, so it works for LAN-only devices.
   A `tools/` script + docs; certs renew every ≤90 days.
4. **Pi integration**: trivial — the server already takes cert/key files
   (`tls.py` / `--ssl-dir`); run the renewal on the Pi itself (systemd
   timer, fold into pi/provisioning) and point the server at lego's output.
5. **ESP32 integration**: the C6 cannot run ACME but can HOLD a cert+key —
   this upgrades M1 from "bake self-signed" to "push a real cert at
   provisioning, re-push on renewal" (provisioning tool or a
   `set_certificate` protocol arm in Phase 4c; key material only ever over
   an already-authenticated link).
6. **Fallback stays**: capture must work on offline/venue LANs with no
   public DNS, so self-signed + the landing-page trust flow
   (`firmware/landing/`) remain the fallback path; the app already handles
   both (`certApprovalUrl` hint fires only when needed).

## Risks & first spikes (run before committing the dependent phase)

- **R1** RMT-while-WiFi coexistence on single-core C6 — _existence proof for
  the whole ESP32 target._ Spike a throwaway RMT+WSS-ping app first.
  **Partially validated on hardware** (2026-07-12, `@embedded//apps/wifi_ap`
  flashed from this repo's vendored pin): soft-AP + webserver + onboard-LED
  color updates work together. Still owed before Phase 2 is committed: a
  SUSTAINED animation on a real strip under concurrent request load for
  ~60 s with no frame glitches (the color picker exercises sparse one-shot
  updates, not continuous signal generation).
- **R2** Self-signed WSS from an **externally-hosted** origin has no
  background trust path. **Spike apparatus built and core flow
  bench-validated** (2026-07-12: the app served from
  <https://ledmapper.pages.dev> connected to the container-hosted self-signed
  stand-in player and drove the virtual-wall flow — the stored cert
  exception does unlock cross-origin WSS). (`firmware/landing/`):
  the resolution is committed to the landing-page design — the ESP32 serves
  ONE same-origin page (`index.html`, `%%APP_ORIGIN%%` baked by firmware
  config) whose load forces the one-tap cert approval, probes its own
  `wss://…/ws` to prove the exception stuck, and bounces to the hosted app
  with `?url=` pre-filled; the app side surfaces the matching recovery hint
  (`certApprovalUrl` in `web/src/net/client.ts`) when a cross-origin `wss:`
  target won't connect. WS-vs-WSS is settled by platform rules: the app
  origin is `https:` (Pages + getUserMedia), and mixed-content blocks `ws://`
  from secure origins — WSS stays. **Remaining bench validation** (real
  Chrome-for-Android + iOS Safari; runbook in `firmware/landing/README.md`,
  Pi stands in as the self-signed player): exception scope + lifetime after
  the interstitial, and Chrome **Private Network Access** enforcement (a
  public→private-network WSS may come to require a PNA preflight —
  `Access-Control-Allow-Private-Network` — independent of cert trust).
- **R3** micropb + heapless + arena on `riscv32imac-none`, panic=abort, no
  alloc. **Half-resolved** (Phase 1½): micropb + heapless + the generated
  bindings + player core build no_std/no-alloc for the C6 triple; remaining
  is panic=abort linkage + on-device footprint (with the arena, Phase 3).
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
