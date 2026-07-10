# LED Mapper

Recover the 3D position of every LED in an installed addressable-LED fixture
by walking around it with a phone. A Raspberry Pi drives the LEDs through a
known temporal blink code; the phone detects and decodes them per frame and
the Pi solves per-LED positions, exporting a `(led_id → xyz)` map. Two
capture paths exist: the original WebXR one (phone supplies camera poses;
server triangulates against them) and the WebXR-FREE one (`?noxr=1`, or
automatic fallback — any phone browser, no ARCore: getUserMedia camera +
DeviceMotion IMU, and the server solves camera poses JOINTLY with the LED
positions). The joint solver exists because ARCore's tracking is measurably
degenerate in this project's lighting — see `docs/vio-exploration.md`.

The full design — goals, architecture, module breakdown, data contracts,
algorithms, and phased build plan — lives in
[`led-mapper-design.md`](./led-mapper-design.md). **Read it first.** This
README is a working state-of-the-build snapshot for the next agent picking
the project up; the design doc is the durable spec.

## State of progress (2026-07-09)

**Everything below is merged to `main` (PR #1). M10, M3, M9, M2, M1, the web
stack M5–M8 (+ virtual LED wall), and the WebXR-free visual-inertial capture
path are landed and green. M4 is Nix-verified** (config evaluates + image
derivation builds; final image not realized in-sandbox and not booted on
hardware). `bazelisk build //...` and `bazelisk test //...` both pass
(**30 test targets**).

Cleanup branches in flight (stacked for sequential review):
`ci-presubmits` (GitHub Actions + pre-commit suite — see
`.github/workflows/test.yaml`, `.pre-commit-config.yaml`) →
`proto-comms` (host↔phone WebSocket now carries **binary protobuf**
frames — `shared/protocol/proto/ledmapper.proto`, boundary converters
`pi/server/server/proto_wire.py` / `web/src/net/proto.ts`, cross-language
golden-frame test) → `rust-wasm-solver` (**the VIO solver rewritten in
Rust**, `solver/`: native subprocess on the Pi + wasm in a phone Web
Worker, cross-language parity test vs the Python reference, and
**init-time solver placement** — both sides benchmark the same canned
solve and the phone keeps the final solve unless it is decisively slower;
see `solver/README.md`) → `hue-only-signaling` (**the intensity "gray"
carrier is REMOVED** — its dark frames made blobs disappear and broke
cross-frame track association; hue is the only carrier, with an
**SNR-adaptive symbol alphabet**: 2 colors (red/blue) when chroma is
marginal, 4 (blue/magenta/red/yellow, Gray-ordered bit pairs so
adjacent-hue misreads stay single-bit-correctable) when it's good —
a 64-LED cycle drops from 14 to 8 windows; negotiated at start from
scene stats and renegotiated mid-capture from the decoder's measured
symbol-margin EMA). The Nix blocker that stopped the previous session is **cleared** —
the container was rebuilt with the Nix overlay, so `nix` works and the host is
natively `aarch64-linux` (Pi images build without cross-emulation).

> **Environment note (2026-06-19):** the container rebuild also surfaced a JVM
> crash — Bazel 7.7.1's bundled JDK 21 emits SVE instructions that `SIGILL` on
> this host. Fixed with `startup --host_jvm_args=-XX:UseSVE=0` in `.bazelrc`
> (see `docs/decisions.md`). Plain `bazelisk` works again. If you ever see a
> wedged zombie `[java]` server, point bazel at a fresh `--output_base`.

### Handoff — Bazel caches persisted across restarts (2026-07-02)

**The post-restart first build is no longer a slow full rebuild.** The
container's root fs (`~/.cache`) is wiped on every `claude-container` restart,
which is why the first build used to take ~1.8 h re-downloading every external
repo over a flaky network. Fixed by persisting Bazel's _content-addressable_
caches on the `/workspace` bind mount (all `.gitignore`d dot-folders):

- **`.bazelrc`** → `--repository_cache=.bazel-repo-cache` (downloaded external
  archives) and `--disk_cache=.bazel-disk-cache` (action outputs).
- **`.bazeliskrc`** → `BAZELISK_HOME=.bazelisk` (the downloaded Bazel binary).

After a restart, Bazel rebuilds its output base locally from these caches with
**zero network downloads** (validated: a fresh output base built
`//tools/sim_studio:serve` in ~12 s). Just run the normal commands:

```sh
bazelisk build //...                    # rebuilds from the persisted caches, no network
bazelisk run //tools/sim_studio:serve   # binds 0.0.0.0:8090 by default
# → open http://localhost:8090 on the host
```

**Do not try to relocate the Bazel output base onto `/workspace`.** That mount
is a **case-insensitive macOS filesystem**; an output base's extracted
Python/pip tree has files differing only by case, which collide and corrupt
there (analysis fails in `rules_python`). Only content-addressable caches
(hash filenames) are safe on it — hence the repository/disk cache approach
above. The output base stays in `~/.cache` (ephemeral) and is cheap to rebuild.

**Host port forwarding.** `.claude-container-overlay` declares
`claude-container:port` mappings (`127.0.0.1:8090→8090` studio,
`127.0.0.1:8080→8080` M2, and **`8443→8443` LAN-exposed** for phone testing
against `//web:serve` — added 2026-07-02, needs a container **restart** to
take effect) passed to `docker run -p`. The in-container server must bind
`0.0.0.0` for the mapping to reach it — the studio defaults to that; for M2
pass `--host 0.0.0.0`; `//web:serve` does it by default. (The studio's 3D
viewport was also fixed to center the origin/orbit pivot on retina displays
and use CAD-style, no-inertia controls.)

All work is merged to **`main`** (working tree clean). The `/workspace`
bind mount — including the persisted caches — survives the restart.

### The WebXR-free path (`vio-joint-solve`, merged to main 2026-07-09)

Full narrative + estimator design + measured findings:
`docs/vio-exploration.md` (§1–§12). Post-phase-4 highlights beyond the
bullets below: **21× faster final solve** (bias-linearized preintegration
cache + vectorized residuals); **final-solve progress bar + live-converging
preview** (§7 `get_solve_status`, ws loop de-serialized) and a **camera-path
toggle** in the result viewport (`OutputMap.trajectory`); a **robustness
round** on real captures (mass-aware segment filtering, per-LED consensus +
re-triangulated MAD outlier rejection with warm-started re-solves — the
"LED stuck at 8.5 mm" fix — and the scale-observability fixes:
reprojection-only robustification, gravity-constrained inertial alignment,
metric re-anchoring, `refine_intrinsics` off by default); and the
**stub-explosion fix** (quality-gated best-state rollback + divergence
retry). Validated: three real sessions solve 1.57 / 2.06 / 3.11 px with
correct-scale geometry. Open items: absolute scale on low-excitation walks
(~±20 %), PnP live registration, per-device IMU-mapping calibration,
phase-5 side-by-side gate.

- **WebXR pose is degenerate in our lighting — measured.** The 2026-07-08
  trace: corr(pose speed, image motion) = −0.002, single-frame jumps to
  2.3 m, 13.2 m claimed path for a 0.5 m walk. Screen reflections +
  code-correlated lighting break ARCore's static-world assumption; every
  back-projected ray inherits the drift, so maps are bunk regardless of
  decode quality.
- **The fix under exploration: drop WebXR, solve poses jointly with LED
  positions** — LEDs are identified landmarks (the blink code IS data
  association), making this SfM with known correspondences; the phone IMU
  (DeviceMotion) supplies dead reckoning between frames, metric scale and
  gravity. Full analysis + staged plan: `docs/vio-exploration.md`. Offline
  prototype `pi/reconstruction/reconstruction/vio.py` (preintegration →
  known-rotation linear init → inertial alignment → full VI-BA): on
  synthetic web-pessimistic data with NO pose input, **map rms 0.24 mm,
  scale 0.5 %, gravity 0.04°**, vs **145 mm** for the production
  pose-trusting solver fed WebXR-like drifting poses (`vio_test`).
  `?record=1` now also streams DeviceMotion into the trace, so the next
  phone session produces real solver-ready data (phase 2→3 of the plan).
- **Phase-3 gate PASSED on real data (2026-07-08).** `//web:offline_decode`
  replays a trace through the canonical M6 decoder; `//pi/reconstruction:vio_replay`
  joins the IMU and solves. On the drift-afflicted 16-LED capture, the VIO
  joint solve (NO pose input) scores plane rms **0.2 mm** / pitch spread
  **0.3 %** / reproj **1.17 px** vs 3.2 mm / 2.5 % / 16 px for the
  pose-trusting solver on the same observations — and its accelerometer-only
  metric scale matches WebXR's within 2 %. Caveat that cost the first run:
  this device's `rotationRate` axis names defy the W3C spec —
  `vio_replay --diagnose` data-fits the mapping per device.
- **Phase 4 LANDED: the WebXR-free capture path.** `?noxr=1` (or automatic
  fallback on devices without camera-access AR — the app now runs in ANY
  phone browser, no Chrome flag, no ARCore): getUserMedia + rVFC capture
  (`MediaStreamCaptureSource`), pose-less DENSE records (per-frame labeled
  samples), DeviceMotion streamed via the new §7.1 `imu_batch` message
  (client applies its device axis mapping — `?imumap=` override), and the
  server dispatches pose-less+IMU sessions to `reconstruct_vio` for BOTH the
  final and the live solve (`OutputMap.frame: "gravity_leveled"`). K seed:
  `?fx=` → localStorage calibration (the XR path caches its true K) → FOV
  heuristic; measured: fx error moves METRIC SCALE ~1:1 and barely affects
  shape, so uncalibrated runs are shape-correct. Deferred: PnP live
  registration (2D overlay + live inset meanwhile), IMU auto-calibration,
  warm-started live VIO. Phase-5 gate next: side-by-side XR vs no-XR wall
  captures incl. the ARCore-breaking reflective setup. 26 test targets
  green. Docs: `docs/vio-exploration.md` §8.

### Done (2026-07-08)

- **SEC-DED FEC on the blink code (misidentification fix).** The raw
  `gray(id+1)` codebook has Hamming distance 1, so ONE decisively-misread
  bit window (margin 1.0 — invisible to voting/confidence gates) decoded to
  a valid WRONG id ≥50 % of the time. Codewords are now wrapped in an
  extended-Hamming **d=4** code used as SEC-DED: single bit-frame errors
  corrected, doubles detected and rejected (never miscorrected; d=4 is NOT
  2-bit correction — deliberate, see docs/decisions.md). Cost: 64 LEDs
  9→14-frame cycles, 1024 LEDs 13→18. Canonical `ledmapper_protocol/fec.py`

  - TS mirror `web/src/code/fec.ts`, pinned by a new Python-generated golden
    (`//pi/led_driver:gen_golden`); `CodeParams.fec` field ("none"|"secded",
    server default secded — legacy "none" still decodes); decoder stats gained
    `correctedCycles`/`rejectedFec`; exhaustive 1-/2-flip tests in both
    languages + adversarial corrupted-window pipeline tests. 24 test targets
    green. (Old captures/sessions replay fine — detections are post-decode.)

- **Varying-light robustness: client-negotiated capture config + exposure
  telemetry.** The dark-room gray-hue failure (all decodes died on the green
  chroma sync — census 52/27k, gScore 0.13 vs the 0.25 gate; diagnosed from a
  `?record=1` trace 2026-07-07) is now prevented by AUTO-NEGOTIATION: the
  phone probes the scene ~1.2 s before the pattern runs (unthresholded
  luma-stats readback `DetectorGL.measure`; frame cadence as the shutter
  proxy — WebXR exposes no real ISO/shutter) and sends its choices in
  `start_mapping` options (§7.1: optional `encoding`, `bitPeriodMs`): dark →
  `gray`, lit → `gray-hue`; bit period ≥3 camera frame intervals (15 fps in
  low light → 210 ms bits). **The server needs no CLI flags** — `--encoding`/
  `--bit-period-ms` are fallbacks only. Mid-capture, the phone streams
  `exposure_report` telemetry (persisted in the session log `exposure` key),
  servos the detector threshold on blob count (flood/starve), and
  RENEGOTIATES via the new `configure` message when conditions drift (fps
  sag or lights toggled, with hysteresis + 2-tick agreement): the server
  restamps the epoch, the wall follows via its 1 s `get_pattern` poll, the
  phone rebuilds its pipeline, collected detections stay valid. WebXR
  `light-estimation` (optional feature) feeds ambient intensity into the
  reports; schema reserves nullable `iso`/`exposureTimeMs` for clients that
  can read the real 3A. Negotiation rules in `web/src/cv/exposure.ts`
  (pure, unit-tested — `exposure_test`); server handler/session tests cover
  configure + exposure persistence; protocol §7.1 gained
  `configure`/`exposure_report` (schemas + both bindings). 23 test targets
  green. Defaults rationale in `docs/decisions.md`. **Untested on device:**
  the luma thresholds (0.08 dark boundary) and the probe duration are
  first-principles picks — validate against the lit-room wall + a dark room
  at the next phone session.

### Done (2026-07-03)

- **Continuous solving.** New §7 message pair `get_live_map`/`live_map`
  (schemas + both bindings regenerated). While a capture runs, the server's
  `LiveSolver` (`pi/server/server/reconstruct.py`) reconstructs interim maps
  from the in-memory detections — poll-driven, single-flight, off the event
  loop; interim maps are in-memory only. `stop_mapping` is unchanged and still
  produces the persisted, final-quality map (`result_ready`). Unit +
  integration tests cover the flow.
- **Decoded-id overlay in the camera view.** Tracks now carry their decoded
  `ledId`/`ledConfidence` (stamped by the M6 decoder); a 2D label canvas in
  the XR dom-overlay draws `#id` rings at each identified track's position
  (confidence-colored, dimmed while the LED is dark, persists through code-word
  off frames). Same aspect-fill mapping as the GL blob markers
  (`web/src/ui/labels.ts`, shared transform in `markers.ts`).
- **Live map preview in-capture.** The phone polls `get_live_map` every 2 s;
  the converging map renders in an inset (reusing `MapView`, now updatable)
  and the HUD shows `solved N/M`. Stop button renamed "Stop & finish".
- **Exact 3D-composited registration.** The camera viewport now shows ONLY
  solved LEDs, rendered through the frame's real WebXR view/projection
  matrices (`CaptureFrame` gained `viewMatrix`/`projMatrix`/`viewport`), so
  each confidence-colored ring + `#id` label overlaps the physical LED
  exactly — registration error is visible live. Raw 2D blob markers are
  `?blobs=1` debug only. `web/src/geom/mat4.ts` holds the MVP math;
  `mat4_test` pins it to the pinhole/M3 camera model pixel-for-pixel.
- **Solver diagnostics for the single-LED study** (open problem: live solve
  registration is correct but doesn't converge to the right result).
  `GET /debug/led/{id}` dumps, for the active (or last persisted) session:
  every observation of that LED with its back-projected ray, camera speed,
  and reprojection residuals vs the DLT point AND the latest live solve;
  ray-bundle stats (parallax, ray-miss distance); `residualTriVsSpeedCorr`
  (positive ⇒ image↔pose latency); and the continuous solver's per-LED
  history + jitter (LiveSolver now keeps a 300-deep solve history).
  `GET /debug/session` gives the whole-session overview. Wall page gained
  `?only=N` (only LED N blinks; layout unchanged) for the physical study.
  Report builder: `pi/server/server/debug.py`, unit-tested on synthetic
  known geometry incl. a corrupted-observation case.
- **Partial-visibility sweeps fixed: latency-corrected pose pairing.** M3
  handles cropped coverage fine (synthetic sweep repro: 128/128 at 1.1 mm);
  the sweep failure was camera→pose latency (~100 ms, measured): records
  paired exposure-time pixels with delivery-time poses → motion × latency
  bias (~60 px at sweep speed) → poisoned triangulation + MAD mass-pruning.
  Decoder now pairs the anchor with the track sample nearest
  `tCapture − alignShift` (the self-clocked latency estimate) and rejects
  frame-entry records with no sample near the exposure time
  (`rejectedPoseGap`). The synthetic sim now models device timing honestly
  (frame pose ≠ exposure pose); new serpentine-sweep + latency test.
- **Solver 3–4× faster: batched per-LED LM with analytic Jacobians.**
  Profiling the real 128-LED capture showed scipy's least_squares spending
  ~60 % of solve time numerically differentiating the Jacobian across ~190
  trust-region iterations. With poses fixed the problem is EXACTLY
  block-diagonal (each LED an independent 3-parameter problem — the
  "solver epochs" idea taken to its limit, with registration free because
  all LEDs share the fixed pose frame), so `bundle.py` now runs a
  vectorized Levenberg–Marquardt over all LEDs at once: analytic
  Jacobians, per-LED 3×3 normal equations via one batched solve, IRLS
  Huber, per-LED damping/step acceptance. Live-size solve 615→~200 ms,
  final 1.3 s→0.4 s; agrees with the scipy solution to 0.3 mm; all
  acceptance tests green. `reconstruct()` also gained `initial_points`
  warm-starting (the LiveSolver seeds each interim solve from the previous
  map). Next lever if 1024-LED sessions get slow: the per-observation
  Python loops in api.py's ray building.
- **VALIDATED AT SCALE: 128-LED wall solved to 1.5 mm rms in a lit room.**
  First gray-hue captures: the 4-LED study solved to a perfect uniform grid
  (77 mm pitch, sub-mm consistency), then a 128-LED wall (15×9 ragged,
  17.4 mm pitch): **128/128 solved, zero unmapped, Δtruth rms 1.48 mm / p50
  1.10 mm / max 4.2 mm, coplanar to 0.8 mm median** — from a 61 s handheld
  walk (5.4 k detections, 55° median parallax) in uncontrolled lighting.
  §9 Phase-3-level acceptance on real capture. Also fixed en route: one
  WebSocket connection running several captures reused its session id and
  OVERWROTE the earlier log — per-capture ids now (`sess-id`, `sess-id-2`, …).
- **`gray-hue` encoding LANDED (uncontrolled-lighting mode).** New §7.6
  `encoding: "gray-hue"`: same Gray frame plan at constant brightness,
  carried by COLOR — white + the three primaries (max pairwise camera-RGB
  separation; `HUE_FRAME_COLORS` in `code/gray.ts`): ALL_ON white = per-track
  color REFERENCE, ALL_OFF green = chroma sync, bit 1 red / bit 0 blue.
  Decoding is RELATIVE: each window's color is divided channel-wise by the
  track's own white window, cancelling white balance/color correction
  exactly; bits = sign of the r−b opponent axis, sync = green score ≥ 0.25 on
  the orthogonal axis. Static-hue clutter self-normalizes to neutral and
  fails sync (rejected for free). Alignment keys on the global GREEN census
  instead of the brightness dip. Enable server-side: `bazelisk run
//web:serve -- --encoding gray-hue` — the wall and the phone decoder both
  follow `codeParams.encoding`. Synthetic pipeline test: 64/64 ids under a
  strong color cast, zero mis-ids, clutter rejected. (M1 driver renders
  hue frames on RGB strips — TODO at bench time; wall-only today.)
- **Hue-modulation probe** (uncontrolled-lighting direction, user-requested):
  the detector's GPU pass now reads back masked RGB (weight in alpha) and CCL
  accumulates per-blob mean color (`CclBlob.r/g/b` → `Blob.r/g/b`, in the
  `?record=1` stream); the wall gained `?hue=1` — dots stay LIT at constant
  brightness and carry the frame plan in COLOR (ALL_ON white, ALL_OFF green,
  bit 1 red, bit 0 cyan). Probe procedure: wall `?hue=1` + phone `?record=1`
  in the lit room, then analyze the recording for chroma separability (dot
  saturation/hue vs the ~200 scene blobs; white-balance stability). The
  normal luminance decoder will NOT solve in hue mode — probe only; a hue
  decode path is a follow-up if the data supports it.
- **Frame-level recorder (`?record=1`) + the REAL root cause: operating
  point.** The capture page can stream the raw per-frame detector output to
  `POST /debug/frames` (JSONL in the session dir). First recording showed
  ~210 blobs/frame EVEN DURING ALL_OFF at intensity ~0.6–0.8: the room was
  bright, the detector threshold (0.6) was slicing ordinary scene luminance,
  and the wall dots (AE-dimmed to ~0.60–0.70, area ~12 px) were nowhere near
  the brightest things in frame — §5's core assumption violated. No
  code-level gate can rescue that; the fix is the prescribed operating
  point: DARK room + screen at max brightness (dots then saturate ≫ scene),
  where the accumulated defenses (id+1 codewords, confidence/support gates,
  dedup, aspect gate, consensus) handle the dark-room artifacts.
- **Truth-relay race fixed.** The wall republished its IDLE layout (server
  default 1024-LED grid) the moment a capture stopped, racing the result
  pane's `/truth` fetch (user saw a full grid instead of 4 points). The wall
  now publishes only while a capture is active, and the phone filters
  fetched truth to the session's ledCount.
- **ROOT CAUSE of the scatter found: screen banding.** The raw record stream
  showed same-cycle records sharing one image ROW (v within a few px, u
  across the full width) — bright horizontal bands from filming a display
  (panel refresh/PWM beating the rolling shutter). Bands are real light,
  code-correlated, quasi-static at 30 fps, and bright, so they beat margin,
  support, AND brightest-anchor dedup. Fixes: CCL blobs now carry bbox
  `w`/`h` and the detector rejects aspect > 3 (`maxAspect`); mitigation for
  the residual: more ambient light (longer exposure averages bands out).
- **Ground-truth relay.** The truth overlay showed a 2×2 grid while the wall
  auto-laid out a ragged 3×2 — the wall now POSTs its exact layout to the new
  `POST/GET /truth` endpoint on layout changes, and the phone's map views
  fetch it (falling back to `?truth=CxR`). Integration-tested.
- **Walked 4-LED study → decoder evidence gate.** The walked capture (0.52 m
  path, real parallax) plus a mode analysis showed the remaining scatter is
  NOT reflections (no discrete 3D modes) and NOT a convention bug (identity
  beat all 16 orientation/quat hypotheses): sparse noise chains stitched by
  the coasting tracker forge margin-1.0 codewords from ~1 sample per window
  (margin measures agreement, not evidence). Decoder now requires
  `minOnSamples` (default 3) real on-sightings behind the decoded word
  (`rejectedSupport` stat).
- **Ground-truth overlay in the map views.** `?truth=COLSxROWS` on the
  capture page declares the wall grid; MapView aligns it to the solve with a
  dependency-free similarity/Procrustes fit (`web/src/geom/fit.ts`, Horn
  quaternion method, unit-tested) and draws truth markers, per-point delta
  vectors with mm/cm magnitudes, dim markers for unsolved LEDs, and a
  `Δtruth rms/max` summary. Works on both the result browser and the live
  inset.
- **4-LED study (2026-07-05) → two more fixes.** Traces confirmed the flood
  fixes work (~2.6 records/cycle, all conf 1.0), but (a) the capture had only
  4 cm of camera path — untriangulatable, walk an arc! — and (b) id 0 was
  still a scatter magnet. So: **codewords now carry id + 1** (all-zero data
  word reserved-invalid; `bits = ceil(log2(n+1))`; driver + TS + codebook +
  goldens regenerated; deviation from §7.6 examples recorded in
  docs/decisions.md), decoder window voting is **centrality-weighted** (hard
  25 % guard starved windows via 33 ms-vs-100 ms phase aliasing → whole
  cycles rejected), and the **alignment estimator no longer cold-starts on
  <1.5 cycles of data** (its huge-plateau center could land bit-periods off,
  and the EMA took ~4 cycles to walk back — killing the first cycles' decodes).
- **Single-LED study DIAGNOSED + fixed (decode-collision flood).** Traces on
  a real 1-LED session (82 s, 3.5 k records) showed up to ~100 records/cycle
  all claiming LED 0, scattered over the whole image, half at confidence 0 —
  windowed triangulation collapsed exactly onto the camera position. Cause:
  anything blinking the LED's code decodes as that LED (reflections; and in a
  dark room, auto-exposure pumping at the pattern period makes static
  features blink in code-correlated ways). LED 0 is the worst case: its Gray
  word is all-dark outside the sync flash. Fixes, in depth:
  (1) decoder `minConfidence` (default 0.4) rejects margin-poor cycles;
  (2) per-cycle per-id dedup — brightest anchor wins (reflections are
  dimmer); (3) M3 consensus (RANSAC-style mode-seeking) pre-filter per LED,
  engaging only when the bundle is contaminated (p90 DLT residual > 40 px) —
  unit-tested to recover a 60 %-junk LED to < 1 mm; MAD rejection alone
  cannot (needs a good median). Old sessions were recorded pre-fix — study
  needs a fresh capture.
- **Camera-texture orientation resolved on-device.** The `?flipv=` unknown is
  settled: Chrome/ARCore camera-access delivers the texture bottom-up, so the
  detector's v-flip is now the DEFAULT (`?flipv=0` reverts). Symptom that led
  here: solve overlay Y-mirrored against the passthrough.
- **Live-solve cadence.** `get_live_map` is polled every 400 ms (status
  guidance stays at 2 s), and interim solves subsample to
  `LIVE_MAX_VIEWS_PER_LED = 16` observations per LED (even stride — keeps
  parallax span, bounds BA cost) so update latency stays roughly constant as
  the session grows. The final solve still uses everything.
- **2D-stage feedback.** The overlay outlines every detected blob per frame,
  colored by track association: green = matched a decoded track, amber =
  tracked awaiting decode, red = unmatched this frame (`Tracker.lastAssignment`
  → `CvPipeline.lastBlobStatus` → `labels.ts`).
- **Interactive result browser.** `MapView` now does CAD-style (no-inertia)
  multitouch navigation: one-finger/left-drag orbit, two-finger drag pan,
  pinch or scroll-wheel zoom (mouse pan via shift/middle/right drag);
  auto-orbit until first interaction. Camera survives `update()` swaps, so
  the live inset converges under a stable view.
- **Pose-aware temporal inertia in the tracker.** The live map feeds back
  into M6 (`pipeline.updateSolved`): a track whose LED is decoded AND solved
  coasts by reprojecting the solved 3D point through each frame's pose —
  correcting camera-motion parallax that constant-velocity coasting can't —
  so identified LEDs re-acquire the same track when they reappear
  (`tracker_test` has a strafing-camera control case). Beyond `maxCoastMs`,
  identity still self-recovers one cycle later via the Gray code, and the
  server merges observations by `ledId` regardless of track lineage.

### Done (earlier — 2026-07-02)

- **Web stack M5–M8 is built and green** (`web/`, Vite + TS, no runtime npm
  deps — true until the proto-comms branch added `@bufbuild/protobuf`):
  M5 `WebXRCaptureSource` (immersive-ar + camera-access + dom-overlay,
  intrinsics from the projection matrix, unit-tested), M6 detect/track/decode
  (GPU threshold pass → CPU connected components → coasting NN tracker →
  self-clocking Gray decoder with sync-delimiter ms-alignment), M7 WebSocket
  client (SNTP clock sync, reconnect-safe detection batching), M8 session UI
  (in-AR HUD, blob markers, canvas 3D result preview). 10 Bazel test targets:
  typecheck + node:test suites incl. a **synthetic Phase-3-style pipeline
  test** (planar wall + arc walk → ≥98 % ids, zero mis-ids, robust to 60 ms
  camera latency and dropped frames) and **cross-language goldens** pinning
  the TS Gray code to the M1 driver and the TS projection math to the M3
  camera model. See `web/README.md`.
- **Virtual LED wall** (`/wall.html`) — fullscreen flat grid of virtual LEDs
  on a laptop, blinking the exact M1 frame plan synced to the server's
  pattern clock, so the live solver can be tested with a phone and **zero LED
  hardware**. Runs off a new §7 protocol pair `get_pattern`/`pattern_state`
  (M10 schemas + both bindings regenerated; server handler + tests added).
  Planar + grid-regular → shape-consistency checks need no measuring; the
  page exports its ground-truth layout.
- **One-command serving:** `bazelisk run //web:serve` = M2 + built web app
  over **HTTPS** (self-signed cert persisted in `.ledmapper/`; WebXR needs a
  secure context). `--no-tls` for plain HTTP. The overlay now LAN-publishes
  port **8443** for the phone (needs a container restart to take effect).
  Phone-testing runbook: `web/README.md`.
- **Not yet done (needs the phone + you):** any on-device validation — Chrome
  `#webxr-incubations` flag, real camera-texture orientation (`?flipv=`),
  intrinsics accuracy, end-to-end wall capture. The whole software path below
  the phone is exercised by tests.

### Done (earlier sessions)

- **M2 — `pi/server` is green.** FastAPI/uvicorn server + the §7 WebSocket
  control plane. Serves the web app (or a Phase-0 hello page), `GET /healthz`,
  `WS /ws`, `GET /maps/{id}` + `.csv`. Manages one capture session at a time,
  persists it to the `{ledCount, detections}` log M3 consumes, and triggers
  reconstruction (M3 library, off the event loop) on `stop_mapping`. The core
  (codebook, session/map store, message handler) is transport-decoupled and unit
  tested; `//pi/server:server_integration_test` boots a **real uvicorn server**
  and drives the whole flow (hello → clock sync → start → detections → stop →
  reconstruct → serve) over a real WebSocket using M9 simulator data — the §6 M2
  acceptance. CLI: `bazelisk run //pi/server:serve -- --port 8080 ...`. See
  `pi/server/README.md`.
- **M1 — `pi/led_driver` is green.** SK9822/APA102 Gray-code cycle (§8.1) over
  hardware SPI with an on/off sync delimiter, plus the Unix-socket control plane
  M2 uses (`start`/`stop`/`get_clock`/`set_debug`). Framing + cycle logic are
  pure (tested with a recording sink); the loop takes injected `clock`/`sleep`
  so it's driven deterministically with no hardware. `spidev` is lazy-imported
  (Pi-only). CLI: `bazelisk run //pi/led_driver:drive -- --dry-run --start 16`.
  See `pi/led_driver/README.md`. **Real-strip cadence verification (§9 Phase 1)
  still needs a logic analyzer on a bench.**
- **Nix unblocked + M4 verified.** A dedicated subagent (per the "Active
  directives" dispatch instruction) verified M4 against the now-available Nix:
  config evaluates, image derivation builds (kernel compile is resource-bound),
  keys + deploy_live confirmed, and it fixed 3 `bazel run`-path bugs. Full
  status is in `pi/provisioning/README.md`.

### Done (earliest sessions)

- **M10 — `shared/protocol` is green.** `bazelisk test //shared/protocol:roundtrip_test`
  passes (24 tests). Fixes applied:
  - `ts_project` no longer passes the (nonexistent) `transpile` macro arg —
    it uses `no_emit = True` to match `noEmit: true` in the tsconfig, and
    `resolve_json_module = True` to match the base config. The target moved
    into the `shared/protocol/ts` subpackage (next to its sources) as
    `//shared/protocol/ts:protocol_ts`; type-check passes via Bazel **and**
    `tsc --noEmit`.
  - The codegen genrule no longer claims checked-in source files as `outs`
    (that's a source/output conflict) and no longer crosses the `ts`
    subpackage boundary. The checked-in generated files are the consumed
    artifacts; `//shared/protocol:codegen_freshness` runs `codegen.py --check`
    and fails the build if they drift from the schemas.
  - A root `//:tsconfig_base` `ts_config` wraps `tsconfig.base.json` so the
    subpackage can `extends` it (a raw cross-package file label failed).
  - `roundtrip_test` now runs through a pytest wrapper (`tests/pytest_main.py`);
    previously its `main` was the bare test module, which would have collected
    nothing and passed vacuously.
- **`docs/decisions.md` + `docs/runbook.md`.** Build-system pins + bzlmod
  rationale, M9 noise-model defaults, M3 parameters; full bootstrap/runbook.
- **M3 — `pi/reconstruction` is green.** Library + CLI. DLT triangulation →
  sparse bundle adjustment (`scipy.least_squares`, Huber, sparse Jacobian,
  poses fixed) → MAD-based outlier rejection + re-solve → per-LED quality
  (nViews, rmsReprojPx, parallaxDeg, confidence) → `OutputMap` (§7.5).
  CLI: `bazelisk run //pi/reconstruction:reconstruct -- <log.json> -o <map.json> [--csv ...]`.
  Tests (`reconstruct_test`): projection↔back-projection inverse, zero-noise
  recovery < 1 mm, low-view culling, gross-outlier rejection.
- **M9 — `shared/simulator` (detection-log mode) is green.** Fixtures
  (line/grid/cube/helix), arc walk, injectable degradations (pixel noise,
  pose position+orientation noise, dropout), deterministic by seed. Imports
  the M3 camera model so synthetic data is in-distribution.
  CLI: `bazelisk run //shared/simulator:simulate -- --fixture cube --leds 64 --noise none -o <log.json>`.
  **Phase-2 acceptance met** (`sim_recon_roundtrip_test`): zero-noise →
  < 1 mm RMS on all four fixtures; nominal noise → ≤ 1% span, ≥ 99% solved;
  deterministic with a fixed seed.
- **M4 — `pi/provisioning` authored** (parallel subagent track). Bazel +
  NixOS workflow: `image_sd`, `deploy_live`, `keys` targets, flake + modules,
  SSH deploy-key management. `MODULE.bazel` gained
  `bazel_dep(rules_nixpkgs_core, 0.13.0)` (registration-only — no nix eval at
  fetch time, so it does not break `bazel build //...`). _Now Nix-verified — see
  the M4 section below._
- **`.claude-container-overlay` added** to install Nix (flakes) into the
  container image on the next launch — see `.claude/skills/container-overlay`.

### M4 — Nix-verified 2026-06-19 (image not yet realized; not booted)

`nix` is installed and working; `flake.lock` is committed. The dedicated subagent
**verified M4** on the native aarch64 container:

- flake + full `nixosConfigurations.ledmapper` **evaluate**; every flagged option
  path/module name is correct for the pin; `spi=on` actually merges; spidev
  present; deploy pubkey baked into root `authorized_keys`;
- the SD-image derivation realizes through substitution + ~90 derivations, but
  the **from-source Pi kernel compile exhausted the sandbox's RAM/disk** (OOM at
  full parallelism, ENOSPC on the final module link) — so the final `*.img.zst`
  was **not realized here**. Needs ≥8 GiB RAM + ~25 GiB scratch (or a cache
  matching the pinned nixpkgs);
- `:keys` flow and `deploy_live` argument/error handling confirmed.

It also **fixed 3 `bazel run`-path bugs** (`spi.nix` `mkDefault` dropping
`dtparam=spi=on`; `image_sd.sh` + `manage_keys.sh` resolving `secrets/` from
runfiles instead of `BUILD_WORKSPACE_DIRECTORY`). **Still untested:** real Pi 5
first boot, a live deploy switch, the Pi 4 variant — all need hardware. See
`pi/provisioning/README.md` for the full status. (Nix usability note: the
Determinate install needs `/nix/var/nix/profiles/per-user` + `gcroots/per-user`
owned by the runtime user; the overlay now handles this — if a fresh container
still errors, `sudo chown $(whoami) /nix/var/nix/{profiles,gcroots}/per-user`.)

### Not started

- **M9 frame mode** (synthetic rendered frames for exercising the M6 GPU
  detect stage; the track/decode stages are already covered by the TS
  synthetic pipeline test, which fills the same role blob-level).
- **On-device validation of M5–M8** (Phase 0/4 acceptance needs the real
  phone): WebXR camera-access support check, camera-texture orientation,
  intrinsics accuracy, a full wall capture.

## Active directives (latest user instructions)

These are not yet captured in the design doc, but should drive the
next sessions:

1. **Manage the project with Bazel** — bzlmod, polyglot
   (Python + TypeScript). Already in flight; finish M10 first.
2. **Provisioning is Nix-driven, not shell-driven.** Replace M4's shell
   approach with `rules_nixpkgs` + `nvmd/nixos-raspberrypi`. Two Bazel
   targets are required:
   - **`bazel run //pi/provisioning:image_sd`** — build a NixOS SD-card
     image targeting the Pi (with our LED driver, server, and web app
     baked in) and write it to a chosen device.
   - **`bazel run //pi/provisioning:deploy_live`** — point at a running
     Pi by hostname/IP and perform an in-place
     `nixos-rebuild switch --target-host` upgrade with the latest built
     artifacts.
   - **SSH key management.** The deploy flow must own a key pair such
     that the imaged system trusts our deploy key for passwordless SSH
     on first boot — generate or load a key, bake the public half into
     the image's `authorized_keys`, and use the private half for the
     live-redeploy step. Document where the key lives and how to
     rotate it.
   - **Dispatch:** the user has asked that the **next agent** spawn a
     dedicated subagent to do this Nix imaging work in parallel with
     M9/M3 — it should run as its own Agent task, not be folded into
     the same agent that's unblocking M10 or building reconstruction.

## Build plan / TODO (priority order)

The design doc's Phase 0–5 gates are still the right structure. Below is
the concrete next-step queue.

- [x] **M10 unblock.** `bazelisk test //shared/protocol:roundtrip_test` green.
- [x] **M10 frontend check.** Generated TS type-checks via
      `//shared/protocol/ts:protocol_ts_typecheck_test` and `tsc --noEmit`.
- [x] **`docs/decisions.md`.** Pins (Bazel/Python/Node/pnpm/rules), bzlmod
      rationale, simulator noise-model defaults, M3 parameters.
- [x] **`docs/runbook.md`.** Bootstrap, lockfile updates, prerequisites,
      reconstruction/simulator usage, provisioning outline.
- [x] **M9 — simulator (detection-log mode).** Deterministic; zero-noise →
      < 1 mm RMS through M3. **Frame mode for M6 still TODO.**
- [x] **M3 — reconstruction.** DLT → sparse Huber BA → outlier reject →
      per-LED quality. Library + CLI. Phase-2 acceptance met against M9.
- [x] **M2 — `pi/server`.** FastAPI/uvicorn + §7 WebSocket control plane;
      session persistence (the `{ledCount, detections}` log M3 consumes),
      reconstruction trigger, map serving. Unit + real-server integration test
      green. The server side of §9 Phase 0.
- [~] **M4 — Nix provisioning.** **Nix-verified**: flake + NixOS config
  evaluate, option paths correct, SD-image derivation builds (kernel compile
  is resource-bound — final image not realized in-sandbox), keys +
  `deploy_live` arg handling confirmed; 3 `bazel run`-path bugs fixed.
  **Remaining:** realize the image on a bigger host + real Pi first-boot /
  live deploy (needs hardware). See `pi/provisioning/README.md`.
- [ ] **QEMU-emulated Pi for hardware-free E2E.** Stand up an emulated
      Raspberry Pi (à la
      <https://azeria-labs.com/emulate-raspberry-pi-with-qemu/>) so the
      deployment workflow (M4) and the embedded app (M1 driver + M2 server)
      can be exercised end-to-end in CI with no physical board. The linked
      guide uses 32-bit Raspbian on `qemu-system-arm -M versatilepb` with a
      `qemu-rpi-kernel`; adapt to our stack: our M4 image is a **64-bit NixOS
      aarch64** build, so use `qemu-system-aarch64` (`-M virt` or a `raspi*`
      machine), booting the SD image / extracted kernel+dtb, with
      `-netdev user,hostfwd=tcp::5022-:22` for SSH. Target shape: `bazel run
//pi/provisioning:emulate` boots the built image in QEMU; `deploy_live`
      pointed at `ssh://…:5022` proves the deploy-key trust and the
      `nixos-rebuild switch --target-host` round-trip against a live (virtual)
      system; M1 (SPI driver — stub/loopback the SPI device under emulation)
      and M2 (server + clock sync + a recorded detection session →
      reconstruct) run inside the guest as the embedded smoke test.
      No longer Nix-blocked (config evaluates), and **M1/M2 now exist** to run
      inside the guest — the gating dependency is now realizing the SD image on a
      host with enough RAM/disk (the in-sandbox kernel compile OOM'd). A generic
      QEMU boot harness can be scaffolded independently first. This becomes the
      cheap gate that precedes "End-to-end on bench" (Phase 4).
- [~] **Phase 0 app skeleton.** M2 server + the full web app (M5–M8) are
  **built**; `bazelisk run //web:serve` serves it over HTTPS with clock
  sync round-tripping. Remaining: confirm on a real phone (WebXR opens,
  offset stable) — §9 Phase 0 acceptance is a device test.
- [~] **M1 — LED driver.** SPI Gray-code cycle + M2 control socket **done**
  and unit-tested (recording sink, injected timing). Remaining: real-strip
  cadence verification on a bench (§9 Phase 1 acceptance needs a logic
  analyzer) and RT scheduling via the M4 systemd unit.
- [~] **M6 — CV pipeline.** Track/decode **done** and validated against a
  TS-synthetic blob stream (Phase-3-style: ≥98 % decode, latency + drop
  robustness). Remaining: GPU detect stage on-device; optionally M9 frame
  mode to exercise it synthetically. Acceptance: §9 Phase 3.
- [ ] **Hardware-free E2E with a phone: virtual LED wall.** Built — laptop
      fullscreen wall (`/wall.html`) + phone capture against it; see
      `web/README.md` for the runbook. This is now the cheapest full-pipeline
      gate (needs only a phone; precedes the bench).
- [ ] **End-to-end on bench.** Real phone + real strip + golden fixture.
      Acceptance: §9 Phase 4.
- [ ] **Robustness & UX.** Coverage guidance polish, exposure handling,
      stress matrix from §10.6. Acceptance: §9 Phase 5.

## How to bootstrap (current best knowledge)

Prereqs: `bazelisk`, `pnpm` (11+), `node` (20+). All present on the
current dev machine.

```sh
bazelisk build //...     # builds clean
bazelisk test  //...     # 26 test targets, all green

# Try the synthetic pipeline end-to-end (no phone, no hardware):
bazelisk run //shared/simulator:simulate -- --fixture cube --leds 64 --noise none -o /tmp/log.json
bazelisk run //pi/reconstruction:reconstruct -- /tmp/log.json -o /tmp/map.json --csv /tmp/map.csv

# Serve the real web app + control plane (phone testing, HTTPS):
bazelisk run //web:serve            # https://0.0.0.0:8443, wall at /wall.html
# (plain-HTTP dev variant: bazelisk run //web:serve -- --no-tls  → :8080)
```

Working today: M10 (protocol), M3 (reconstruction), M9 (simulator
detection-log mode), M2 (server), M1 (LED driver — software-tested, bench
cadence pending), M5–M8 (web app + virtual LED wall — fully unit/synthetic-
tested, on-device validation pending). M4 (provisioning) is Nix-verified
(config evaluates + image derivation builds; final image not realized
in-sandbox, not booted). See `docs/runbook.md` and `web/README.md`.

## Repo layout

See design doc §11. Current on-disk reality matches it. Populated so far:
`shared/protocol` (M10), `pi/reconstruction` (M3), `shared/simulator` (M9),
`pi/server` (M2), `pi/led_driver` (M1), `pi/provisioning` (M4, Nix-verified),
`web/` (M5–M8 + the virtual LED wall), `docs/`. Plus `tools/sim_studio` — an
interactive 3D solver-debugging studio (not a shipping module; see below).

## Pointers

- **Design doc:** `led-mapper-design.md` — read §0 (how to use this
  doc), §6 (modules), §7 (data contracts), §9 (phased build plan).
- **Wire-protocol schemas:** `shared/protocol/schemas/*.json` —
  authoritative for cross-module data formats.
- **Codegen:** `shared/protocol/codegen.py` — regenerates Python and
  TS bindings from the schemas (run with `python3` directly; the
  `//shared/protocol:codegen_freshness` target enforces they stay in sync).
- **Reconstruction (M3):** `pi/reconstruction/` — library + CLI; camera
  model in `reconstruction/camera.py` (shared with the simulator).
- **Simulator (M9):** `shared/simulator/` — synthetic detection logs.
- **Server (M2):** `pi/server/` — FastAPI/uvicorn + §7 WebSocket; see its README.
- **LED driver (M1):** `pi/led_driver/` — Gray-code SPI driver + M2 control
  socket; see its README.
- **Web app (M5–M8) + virtual LED wall:** `web/` — capture app + the
  hardware-free laptop test fixture; phone-testing runbook in `web/README.md`.
  `bazelisk run //web:serve`.
- **Sim Studio (dev tool):** `tools/sim_studio/` — interactive 3D studio to
  generate fixtures, fly a camera to synthesize captures, and watch the real M3
  solver converge vs ground truth. `bazelisk run //tools/sim_studio:serve`, then
  open `http://localhost:8090` on the host (port mapping is in the overlay).
- **Bazel build graph entry:** `MODULE.bazel`, root `BUILD.bazel`.
- **Ops:** `docs/runbook.md`, `docs/decisions.md`.
