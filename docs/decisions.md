# Decision log

Pinned versions and the rationale behind them. Update this file together with
the file that holds each pin (`MODULE.bazel`, `requirements.lock`,
`package.json`, `pi/provisioning/nix/flake.nix`).

## Build system — Bazel (bzlmod)

The project is managed with **Bazel using bzlmod** (`MODULE.bazel`, no
`WORKSPACE`). Rationale:

- **One polyglot graph.** The repo is Python (Pi: driver, server, reconstruction,
  simulator, protocol codegen) _and_ TypeScript (web app + generated protocol
  types). Bazel builds and tests both under one dependency graph, so the protocol
  package (M10) can be the single source of truth that both halves consume, with
  a freshness check that fails the build if the generated Pydantic/TS bindings
  drift from the schemas.
- **bzlmod over WORKSPACE** because it is the supported mechanism in Bazel 7+,
  gives transitive version resolution from the Bazel Central Registry, and keeps
  the module list short and declarative. `--enable_bzlmod` is set in `.bazelrc`.
- **Hermetic toolchains.** `rules_python` provides a pinned interpreter and a
  single root lockfile; `aspect_rules_js`/`aspect_rules_ts` drive a pinned
  TypeScript over the pnpm workspace. No reliance on system Python/Node for the
  build itself.

### JVM SVE workaround (`.bazelrc`, added 2026-06-19)

`.bazelrc` carries `startup --host_jvm_args=-XX:UseSVE=0`. Bazel 7.7.1 ships a
bundled JDK 21.0.5; on some `aarch64` hosts that JDK emits SVE (Scalable Vector
Extension) instructions in its VM-startup stub code, and the bundled JVM then
crashes with `SIGILL` (illegal opcode) in `StubRoutines::call_stub` before it
can run anything — every `bazelisk` command dies with "Server crashed during
startup". This first appeared when this dev container was rebuilt onto a host
whose CPU rejects those stubs. `-XX:UseSVE=0` disables SVE codegen in the JVM
and is harmless on hosts without SVE, so it is set unconditionally rather than
behind a config. If a future Bazel/JDK bump makes it unnecessary it can be
dropped, but it costs nothing to keep. (Symptom to recognise: a zombie `[java]
<defunct>` server process that `bazelisk` keeps trying and failing to kill — if
that lock wedges, point bazel at a fresh `--output_base`.)

### Pinned versions (pinned 2026-06-18, lockfiles regenerated 2026-06-19)

Update this table together with the file that holds each pin.

| Component          | Pin                     | Held in                                 | Rationale                                                                                                                             |
| ------------------ | ----------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Bazel              | `7.7.1`                 | `.bazelversion`                         | Current stable 7.x; bzlmod is mature here. Pinned via Bazelisk.                                                                       |
| Python             | `3.11`                  | `MODULE.bazel` (`PYTHON_VERSION`)       | Matches the Raspberry Pi OS (bookworm) system Python so Pi-side code runs on the same minor version it's built against.               |
| `rules_python`     | `2.0.3`                 | `MODULE.bazel`                          | Hermetic interpreter + `compile_pip_requirements`; single root `requirements.lock` from `requirements.in`.                            |
| `aspect_rules_js`  | `3.2.2`                 | `MODULE.bazel`                          | pnpm-native JS rules; consumes the checked-in `pnpm-lock.yaml`.                                                                       |
| `aspect_rules_ts`  | `3.8.11`                | `MODULE.bazel`                          | `ts_project` type-checking; TS version is taken from `package.json` so Bazel and `pnpm`/`tsc` agree.                                  |
| `aspect_bazel_lib` | `2.22.5`                | `MODULE.bazel`                          | Shared Starlark helpers required by the aspect rules.                                                                                 |
| `rules_pkg`        | `1.2.0`                 | `MODULE.bazel`                          | Packaging (artifacts to bake into the Pi image).                                                                                      |
| TypeScript         | `5.9.3`                 | `package.json` / `pnpm-lock.yaml`       | Single TS version for the whole pnpm workspace; rules_ts reads it from `package.json`.                                                |
| pnpm               | `11+`                   | dev prerequisite                        | Workspace covers `web/` and `shared/protocol/ts/`.                                                                                    |
| Python libs        | see `requirements.lock` | `requirements.in` → `requirements.lock` | pydantic, jsonschema, numpy, scipy, opencv, fastapi, uvicorn, websockets, pytest. Regenerate with `bazel run //:requirements.update`. |

> Previously this file was seeded by the M4 track with only the M4 section
> (below). The build-system pins above were folded in from `MODULE.bazel` /
> `requirements.lock` / `package.json` per the root README TODO.

## M9 — simulator noise model defaults (pinned 2026-06-19)

The simulator (`shared/simulator`) is deterministic given a seed. Its degradation
knobs default to the "nominal noise" point the design doc §9 (Phase 2) and §12
call for, so a default run exercises a realistic-but-solvable scenario:

| Knob               | Default | Notes                                                                                                    |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `pixel_noise_px`   | `0.5`   | Gaussian σ on the `(u, v)` centroid. §9 Phase 2 nominal.                                                 |
| `pose_noise_deg`   | `1.0`   | Gaussian σ (deg) on camera orientation; small VIO error. §9 Phase 2 nominal.                             |
| `pose_noise_pos_m` | `0.003` | Gaussian σ (m) on camera position.                                                                       |
| `dropout_prob`     | `0.0`   | Per-observation random drop. Raise to stress-test completeness.                                          |
| `walk`             | `arc`   | Arc around the fixture (§12); enforces parallax. Straight-on walks are rejected by the UI in production. |
| `arc_degrees`      | `120`   | Angular span of the arc; sets achievable parallax.                                                       |
| `views`            | `60`    | Camera stations along the walk (≈ design doc's ~70 observation sets).                                    |
| `seed`             | `0`     | Fixed seed ⇒ deterministic output (acceptance requirement).                                              |

**Acceptance (Phase 2):** a **zero-noise** detection log (all knobs 0) reconstructs
to **< 1 mm RMS** through M3. At nominal noise, RMS ≤ 1% of the fixture span with
≥ 99% of LEDs solved. Enforced by
`shared/simulator/tests/test_sim_recon_roundtrip.py`.

## M3 — reconstruction parameters (pinned 2026-06-19)

From design doc §8.3 / §12. These are the defaults in `pi/reconstruction`:

| Param                  | Default                                        | Notes                                                                                                                                          |
| ---------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Triangulation init     | linear (closest-point to observation rays)     | Needs ≥ 2 views with parallax.                                                                                                                 |
| BA loss                | Huber, `f_scale = 1.5` px                      | §12 "Huber delta ~1–2 px". `scipy.optimize.least_squares`, sparse Jacobian.                                                                    |
| Pose refinement        | off (poses fixed)                              | WebXR poses are metric; with fixed poses the BA separates per point (bipartite). Seam left to optimize poses jointly if VIO drift hurts (§13). |
| Outlier reject         | residual > `3 ×` robust σ (MAD), then re-solve | §12.                                                                                                                                           |
| Min parallax to accept | `5°`                                           | Below this an LED is kept but flagged low-confidence (§12).                                                                                    |
| Min views              | `2`                                            | Fewer ⇒ LED listed in `unmapped`.                                                                                                              |

## M1 — LED driver choices (pinned 2026-06-19)

SK9822/APA102 over hardware SPI (design doc §5). Decisions in `pi/led_driver`:

| Choice                 | Decision                                                                       | Rationale                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire format            | start `4×00`; per-LED `0xE0\|bright5, B, G, R`; end `ceil(n/16)` (min 4) `×00` | SK9822 latch semantics; zeros are the safer cross-compatible end frame (classic APA102 used `0xFF`). Long cascades get ~n/16 extra clock bytes.       |
| `spidev`               | imported lazily inside `SpidevSink`; **not** in `requirements.lock`            | Pi-only (provided by `pi/provisioning/nix/modules/spi.nix`), absent off-Pi. Lazy import keeps the package importable and the suite hermetic.          |
| SPI clock              | 8 MHz default                                                                  | Comfortable for SK9822; tune per strip length/wiring.                                                                                                 |
| On colour / brightness | white, brightness 31                                                           | LEDs should be the brightest objects in frame (§5 dim-room guidance); configurable.                                                                   |
| Pattern clock          | `time.monotonic()` ms, stamped at frame 0 of the cycle                         | Same monotonic base as M2 clock sync (§8.2); `start()` blocks until the worker stamps it so the epoch reflects the real cycle start.                  |
| M1↔M2 transport       | separate process + Unix-socket, newline-delimited JSON                         | §3 process split: server restarts don't drop the pattern; driver can run at RT priority. `CodeParams` authored by M2 (`codebook.py`), consumed by M1. |
| Testability            | injected `clock`/`sleep` + `RecordingSink`                                     | Drive the loop deterministically with no wall-clock waits or hardware. Real cadence (§9 Phase 1) still needs a logic analyzer on a bench.             |

## M2 — Pi server choices (pinned 2026-06-19)

FastAPI/uvicorn/websockets, per design doc §4. Decisions in `pi/server`:

| Choice                 | Decision                                                                     | Rationale                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server clock           | `time.monotonic()` ms                                                        | §7.3 offset/rtt math needs differences from a clock that can't step; one clock feeds both `t1`/`t2` and `patternClockEpoch`.                                                                            |
| Reconstruction trigger | M3 library called in a worker thread (`asyncio.to_thread`) on `stop_mapping` | Keeps the event loop responsive during multi-second BA. Design §3 frames it as a "subprocess/job"; the seam is one async callable in `reconstruct.py`, so swapping to a true subprocess later is local. |
| Session persistence    | buffer in memory, flush the `{ledCount, detections}` log on stop             | Simple; the log is exactly M3's input format. Trade-off: a crash mid-capture loses the session — on-disk journaling deferred.                                                                           |
| `patternClockEpoch`    | stubbed to server clock at `start_mapping`                                   | M1 driver isn't built; `get_clock().epoch` replaces it later. Seam: `SessionManager.start()`.                                                                                                           |
| `status` fields        | `identified` = LEDs ≥2 views; `lowParallax` = LEDs seen once                 | True parallax needs geometry; these are honest live proxies for walk guidance. Real parallax is in the `OutputMap`.                                                                                     |
| `welcome.codeParams`   | server default `--led-count` (1024) until `start_mapping`                    | ledCount is unknown at `hello`; `mapping_started` carries the actual code-book once the client sends it.                                                                                                |
| Testing                | transport-decoupled core + a real-server integration test                    | `httpx` is intentionally _not_ in the lockfile, so we avoid `fastapi.TestClient`; the integration test uses the `websockets` sync client + stdlib `urllib` against a live uvicorn.                      |

## M4 — Nix-driven provisioning (pinned 2026-06-19)

The original M4 scope (shell + `hostapd`/`dnsmasq`/`avahi`/systemd) was
redirected to a Bazel + Nix workflow (root README "Active directives"). See
`pi/provisioning/README.md` for the full design and the UNVERIFIED list.

| Component            | Pin                                                                     | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rules_nixpkgs_core` | `0.13.0`                                                                | Latest tweag/rules_nixpkgs release; first with Bazel 8 support. Imports nix-built build tools (e.g. the HTML minifier) as Bazel targets. Nix is a system requirement for the repo; fetches are lazy, so only targets that use a nix-backed package realize it.                                                                                                                                                                                                                                                       |
| `nixos-raspberrypi`  | tag `v1.20260517.0` (commit `06c6e3513e1ee64b651913193fc6ac38aa4963f5`) | `nvmd/nixos-raspberrypi` provides Pi 4/5 kernel, firmware, device tree, and SD-image builders. Pinned to a tagged release for reproducibility. **Note the `v` prefix** — the flake originally pinned `1.20260517.0` (no `v`), which GitHub does not resolve; corrected 2026-06-19 when generating `flake.lock`.                                                                                                                                                                                                      |
| `nixpkgs`            | branch `nixos-25.05` (locked to `ac62194` in `flake.lock`)              | Followed by `nixos-raspberrypi.inputs.nixpkgs` so there is a single coherent package set (avoids divergent kernel/userspace). **Trade-off:** because we pin our own `nixos-25.05` and make upstream `follows` it, the resolved nixpkgs differs from the one `nixos-raspberrypi.cachix.org` built its kernel/firmware against, so `image_sd` rebuilds the Pi kernel from source (~20–40 min on first build, then cached locally). To get kernel cache hits instead, drop the `follows` and accept upstream's nixpkgs. |
| Target board         | `raspberry-pi-5` (default)                                              | Design doc §5 targets Pi 4 or 5; default to 5, switch via `board` in `flake.nix`.                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**`flake.lock`:** generated 2026-06-19 (`nix flake update`) and committed; locks
`nixpkgs` → `ac62194`, `nixos-raspberrypi` → `06c6e35`. The full
`system.build.sdImage` derivation evaluates on an `aarch64-linux` host (the dev
container is aarch64, so no qemu/binfmt cross is needed).

**Nix-verified 2026-06-19** on the native aarch64 dev container: the flake and
the full `nixosConfigurations.ledmapper` evaluate; every flagged option
path/module name is correct for the pin (`system.build.sdImage` →
`nixos-image-rpi5-kernel.img.zst`, `raspberry-pi-5.{base,display-vc4}` +
`sd-image` modules, `python3Packages.spidev` present, deploy pubkey baked into
root `authorizedKeys`); the SD-image derivation realizes through substitution +
~90 derivations. The from-source Pi kernel compile is RAM/disk-heavy — it OOM'd
at full parallelism and hit ENOSPC on the final module link in a ~21 GiB-free
sandbox — so the final `*.img.zst` was **not realized here**; it needs a host
with ≥8 GiB RAM and ~25 GiB scratch (or a cache matching the pinned nixpkgs).
Real Pi first-boot and a live `deploy_live` switch remain untested (no hardware).
Three `bazel run`-path bugs were found and fixed in `pi/provisioning/`:
`spi.nix` used `lib.mkDefault` on the whole `hardware.raspberry-pi.config` subtree,
which dropped the `dtparam=spi=on` leaf (now set directly); and `image_sd.sh` +
`manage_keys.sh` resolved the `secrets/` dir from the Bazel runfiles tree instead
of `BUILD_WORKSPACE_DIRECTORY`, so generated keys never reached the flake closure
(now anchored on the workspace dir, matching `deploy_live.sh`).

**Deploy-key eval path:** the pubkey lives at `pi/provisioning/secrets/`, which
is _outside_ the flake root (`nix/`), so a relative path from the module cannot
reach it through the flake's store copy. `image_sd`/`deploy_live` therefore
export `LEDMAPPER_DEPLOY_PUBKEY_FILE` (absolute) and build with `--impure`;
`ssh-deploy.nix` reads that env path first. Pure builds would require moving the
flake root up to `provisioning/` (left as a future cleanup).

**SSH deploy key:** ed25519 pair owned by the deploy flow. Public half baked
into the image `authorized_keys`; private half used by `deploy_live`. Stored
gitignored under `pi/provisioning/secrets/` (or `LEDMAPPER_DEPLOY_KEY_DIR`).
Never committed; rotatable via `bazel run //pi/provisioning:keys -- rotate`.

## Web stack — M5/M6/M7/M8 + virtual LED wall (pinned 2026-07-02)

- **npm pins:** `vite 8.0.16`, `typescript 5.9.3` (already the workspace pins),
  `@types/webxr 0.5.24`, `@types/node 24.10.9`. **No runtime dependencies**
  (superseded 2026-07-09: the protobuf wire migration below adds
  `@bufbuild/protobuf`) —
  the app is hand-rolled DOM + WebGL2; three.js was dropped because we render
  no 3D AR content (the CV pass and feedback markers are raw GL, the result
  preview is a 2D-canvas scatter), and every KB matters on a phone loading
  from a Pi AP.
- **`pattern_state` protocol addition (§7).** New `get_pattern` (client) /
  `pattern_state` (server) messages: `{active, patternClockEpoch|null,
codeParams}`. Exists so _pattern followers_ — the virtual LED wall — can
  render the blink code against the same clock the phone decodes, without
  owning the capture session. The wall polls (~1 s); the self-clocking
  delimiter makes poll latency harmless.
- **The wall follows the server clock** (rather than driving its own pattern
  and reporting an epoch): the M2 server already stamps `patternClockEpoch`
  at `start_mapping` while M1 hardware is absent, so a follower needs zero new
  server state and the phone-side flow is byte-identical to the hardware path.
- **M6 detect = GPU threshold+downsample, CPU connected components.** A full
  GPU CCL is a multi-pass label-propagation algorithm; not worth it at MVP.
  One fragment pass max-channel-thresholds and 2×-box-downsamples the camera
  texture, a ~640×360 RGBA readback feeds a stack-based 4-connectivity CCL
  with intensity-weighted sub-pixel centroids (the box filter is linear, so
  half-res weighted centroids track full-res well under a pixel). Sync
  readPixels is the accepted MVP cost; PBO/fence is the known upgrade.
- **M6 decode is self-clocking in ms, not just frames.** Beyond §8.2's
  clock-offset mapping, the decoder estimates a continuous alignment shift by
  maximizing (global on-count in ALL*ON window) − (ALL_OFF window) over
  candidate shifts each cycle, taking the \_center of the top-score plateau*
  (sparse 30 fps sampling makes the score piecewise-constant; centering
  maximizes guard margin). This absorbs constant camera→rAF latency and
  residual sync error — verified by the 60 ms-latency synthetic test.
- **Cross-language goldens.** `web/tests/golden_gray16.json` is generated by
  the M1 driver's `graycode.py`; `golden_pinhole.json` by M3's `camera.py`.
  The TS mirrors (`src/code/gray.ts`, `src/geom/pinhole.ts`) are tested
  against them, pinning frame plan and projection conventions to the Pi side.
  If they drift, fix the TS — never the golden.
- **JS unit tests = tsc→CommonJS + node:test under Bazel.** No vitest/jest:
  tsc doesn't rewrite extensionless ESM specifiers (emitted ESM wouldn't
  resolve in Node), so tests compile to CJS (`tsconfig.test.json`, emitted to
  `dist-test/`) and run as plain `js_test`s. Protocol imports are type-only,
  so the emitted JS is dependency-free.
- **Vite runs unsandboxed** (`--strategy=Vite=local` in `.bazelrc`): rolldown
  realpath()s entries through sandbox input symlinks while the vite root stays
  at the sandbox path, breaking emitted HTML asset names. Strategy-by-mnemonic
  (not target tags) so shared copy-to-bin actions don't conflict.
- **HTTPS for phone testing.** WebXR needs a secure context; the serve CLI
  grew `--ssl-dir` (self-signed cert generated once via `openssl`, persisted
  under `.ledmapper/ssl/` so the browser exception sticks). `//web:serve`
  defaults to HTTPS :8443; `--no-tls` gives plain HTTP :8080 for local dev.
  The client derives ws/wss from the page protocol.
- **Camera-texture row order is explicitly deferred** (`DetectorOptions.flipV`,
  `?flipv=1`): whether the raw-camera texture's v=0 row is image top or bottom
  is device territory; a wrong flip is loudly visible as huge M3 reprojection
  residuals. Default false; confirm once on the target device (§13).
- **flipV resolved on-device (2026-07-03): default TRUE.** Chrome/ARCore
  camera-access delivers the camera texture bottom-up. Symptom of a wrong
  setting: the 3D-composited solve overlay renders Y-mirrored against the
  passthrough (observed live, fixed same day). `?flipv=0` reverts.
- **Codewords carry id + 1 (2026-07-05); the all-zero data word is
  reserved-invalid.** Deviation from the design doc §7.6/§8.1 examples:
  `bits = ceil(log2(ledCount + 1))`, so e.g. 1024 LEDs → 11 bits, not 10.
  Why: anything that blinks the code decodes as an LED, and id 0's raw Gray
  word is all-dark outside the sync flash — exactly what reflections and
  auto-exposure pumping look like in a dark room, making id 0 a decode
  magnet (observed live: a 1-LED session produced ~45 bogus id-0 records per
  cycle, collapsing the solve onto the camera position). With the offset, a
  "dark data frames" observation decodes to the reserved word and is
  rejected. Sits alongside the other decode-poisoning defenses added the
  same day: decoder `minConfidence` (0.4), per-cycle per-id brightest-anchor
  dedup, and M3's consensus (mode-seeking) pre-filter for majority-bad
  observation sets.
- **`gray-hue` encoding (2026-07-05): color-carried code for uncontrolled
  lighting.** Frame-level recordings showed intensity coding is unusable in a
  lit room (~200 scene blobs/frame above threshold; dots AE-dimmed to ~0.65).
  A probe confirmed chroma separates cleanly (green census = exactly the 4
  dots; bit margins 0.4–0.8). Design: FIXED wire colors, maximally separated
  — white + the three primaries (every pair 2.0 apart in RGB L1; sync axis
  g−(r+b)/2 orthogonal to bit axis r−b) — with RELATIVE decoding: each
  window normalized channel-wise by the track's own ALL_ON (white) window,
  which cancels diagonal color correction exactly and makes static-hue
  clutter fail the green sync (it normalizes to neutral). Always-lit dots
  also remove the coasting/AE-pumping failure modes. Enabled by server flag
  `--encoding gray-hue`; wall + phone follow `codeParams.encoding`.

## Capture auto-negotiation + exposure telemetry (pinned 2026-07-08)

- **The client configures the code, not the server CLI.** `start_mapping`
  options grew optional `encoding` + `bitPeriodMs`; a new `configure` message
  renegotiates them mid-capture (server restamps `patternClockEpoch`,
  detections already collected are kept — they are (ledId, pixel, pose)
  records, independent of the signaling that produced them). Rationale: only
  the phone can see the light. The server's `--encoding`/`--bit-period-ms`
  flags remain solely as fallbacks for bare clients.
- **No real 3A/ISP readout exists on the web path.** WebXR raw camera access
  exposes a texture, no ISO/exposure metadata; there is no concurrent
  getUserMedia while ARCore holds the camera. The `exposure_report` message
  therefore carries software estimates — scene luma stats from an
  unthresholded 64-px-wide readback (`DetectorGL.measure`), median frame
  interval as the shutter proxy (low light → longer integration → lower fps),
  and WebXR `light-estimation` ambient intensity when granted — with
  `iso`/`exposureTimeMs` reserved as nullable fields for a future native
  client that can read the real state.
- **Negotiation rules** (`web/src/cv/exposure.ts`, unit-tested):
  - encoding: mean scene luma < 0.08 → `gray` (dark room: LEDs outshine all;
    camera clipping kills gray-hue's green sync — measured gScore ~0.13 vs
    the 0.25 gate, 2026-07-07 trace), else `gray-hue`. Mid-capture switch
    only outside a 0.06/0.12 hysteresis band.
  - bit period: ≥ 3 camera frame intervals, 10 ms grid, clamped [60, 400] ms.
    Mid-capture renegotiation below 2.5 frames/bit (decode starving) or when
    2× faster than needed (reclaim cycle time); two consecutive 2 s ticks
    must agree.
  - detector threshold: ±0.05/tick servo on median blob count (flood ceiling
    max(150, 3·ledCount), starve floor ledCount/2), bounded [0.6, 0.9];
    `?threshold=` forces and disables.
- **Session logs** gained additive `codeParams` + `exposure` keys (M3's
  reader ignores unknown keys).

## SEC-DED FEC on the blink code (pinned 2026-07-08)

- **Why.** The raw codebook (`gray(id+1)` over `ceil(log2(n+1))` frames) has
  minimum Hamming distance 1: any single decisively-wrong bit window (all of
  a window's samples agreeing on the wrong value — chroma misread near the
  gray-hue thresholds, brief track contamination, a reflection landing on a
  neighboring track) decodes to a valid WRONG id whenever the flipped word
  lands in range, and the in-range fraction `(n+1)/2^bits` is ≥50 % by
  construction (≈100 % at counts like 63). Window voting and the confidence
  gate cannot see this failure — a decisive window has margin 1.0. Only the
  M3 geometric outlier rejection caught it downstream, and that fails for
  systematic wrong decodes (the decode-collision floods of 2026-07-05).
- **What.** Extended Hamming, distance 4, used as **SEC-DED**: the Gray data
  word (k bits) gains r Hamming parity bits (2^r ≥ k+r+1) at power-of-two
  positions plus one overall parity bit transmitted last. Single bit-frame
  errors are CORRECTED; double errors are DETECTED and the cycle rejected —
  never miscorrected (a d=4 guarantee; triples can alias, at which point the
  track is garbage and geometry remains the backstop). Note d=4 does NOT
  give 2-bit correction — that would need d=5/6 (BCH); SEC-DED was chosen
  deliberately: our double-window errors mean track contamination, where
  rejection is the correct response anyway.
- **Cost.** Transmitted bits k → k+r+1: 64 LEDs 7→12 bits (cycle 9→14
  frames, +56 %), 1024 LEDs 11→16 (13→18, +38 %). At 100 ms bits a 64-LED
  cycle is now 1.4 s. Accepted: identification latency, not accuracy, and
  the id repeats every cycle.
- **Where.** Canonical implementation `ledmapper_protocol/fec.py` (encode +
  syndrome decode), TS mirror `web/src/code/fec.ts`, pinned by the
  Python-generated `web/tests/golden_secded16.json`
  (`bazelisk run //pi/led_driver:gen_golden -- secded16` regenerates).
  `CodeParams` gained optional `fec: "none" | "secded"` (absent = "none",
  legacy); `bits`/`cycleFrames` now count TRANSMITTED frames. M2's codebook
  emits `fec="secded"` by default; the driver frame plan, wall, and phone
  decoder all follow `codeParams`. Decoder stats gained `correctedCycles` +
  `rejectedFec`. Exhaustive tests both languages (every 1-flip corrected,
  every 2-flip rejected, k ≤ 11) + synthetic pipeline corruption tests.

## Protobuf wire migration (proto-comms branch, 2026-07-09)

- **The WebSocket now carries binary `ledmapper.v1` protobuf frames** both
  directions (`shared/protocol/proto/ledmapper.proto` — envelopes with one
  oneof arm per §7 message type). Text frames are rejected with a
  `bad_message` error frame.
- **The migration boundary is deliberately thin**: the proto was designed
  for JSON parity (flat repeated doubles for vectors, strings for
  enum-likes, `optional` = null, oneof arm name = the old "type" value), so
  each end converts envelope <-> flat §7 object at the socket
  (`pi/server/server/proto_wire.py`, `web/src/net/proto.ts`) and ALL
  internal code — pydantic models, handlers, TS types, tests — is
  unchanged. Collapsing the internal JSON-schema layer onto the proto is a
  possible follow-up, not part of this migration.
- **Null/absence semantics**: JSON null == proto unset; decoded dicts OMIT
  unset optionals (pydantic models default them to None); nullable repeated
  fields decode as [] (all consumers treat null/[] alike). One shape seam:
  trajectories ([[x,y,z], ...] <-> repeated Vec3) converted at the boundary
  — proto3 JSON cannot express nested arrays.
- **Toolchain**: hermetic prebuilt protoc (toolchains_protoc v29.3) via a
  platform-select()ed alias (//tools/toolchains:protoc) — no from-source
  protobuf compile, no proto toolchain resolution machinery. Python
  bindings generated AT BUILD TIME (nothing checked in; pip `protobuf`
  runtime); TypeScript bindings CHECKED IN (web/src/gen/, protobuf-es —
  regenerate with shared/protocol/proto/gen_ts.sh) because vite/tsc want
  them on disk. First runtime npm dependency of the web app
  (@bufbuild/protobuf).
- **Cross-language pinning**: //pi/server:gen_proto_golden emits
  web/tests/golden_proto_frames.json (binary frames + decoded flats for
  every §7 example); the TS proto test must decode byte-identical frames to
  the same objects. Plus full py roundtrip tests (test_proto_wire.py) and
  the real-server integration test on the binary wire.

## Rust solver + wasm + solver placement (rust-wasm-solver branch, 2026-07-09)

- **The VIO solver is rewritten in Rust** (`solver/` — one crate, zero
  external math deps) and deployed twice: a host binary the Pi server runs
  as a subprocess (stdin problem JSON → stdout §7.5 OutputMap, stderr
  solve_status-shaped progress lines) and a wasm32/wasm-bindgen module the
  phone runs in a Web Worker. The Python solver remains as the reference
  implementation (parity-pinned), the automatic fallback when the binary is
  absent, and the engine for replay/calibration tooling.
- **Optimizer stand-in**: scipy's TRF(jac_sparsity, x_scale="jac",
  tr_solver="lsmr") became hand-rolled Levenberg–Marquardt over damped LSMR
  with Curtis–Powell–Reid column-grouped finite differences and Nielsen's
  gain-ratio damping. Parity is asserted in SOLUTION space
  (//pi/reconstruction:rust_parity_test: both solvers on one synthetic
  session agree < 3 mm / < 2 % scale after similarity alignment), not
  bitwise — the two optimizers walk different damping schedules.
- **Solver placement (init-time benchmark)**: host and phone run the SAME
  canned synthetic solve through the SAME Rust code (deterministic seeded
  problem, `solver/src/synth.rs`), so the two wall-clock scores are directly
  comparable. Host score rides in `welcome.solverBenchMs`; the phone times
  its wasm module at page load (in the worker — the solve is synchronous)
  and decides in `web/src/solver/placement.ts`. PHONE-FIRST with a 4×
  slowdown margin: the phone holds the data locally and offloading ties up
  the Pi; only decisively slow phones offload. Protocol additions:
  `stop_mapping.solveOnHost` (false → server stops+persists only, replies
  the new `mapping_stopped`), new `submit_map` client message (server
  persists the phone-solved map and replies result_ready — the download
  flow is placement-independent). The XR pose-trusting path always solves
  on the host (~1 s there; the phone keeps no local copy for it).
- **Wasm deployment via runfiles**: //solver:solver_web =
  wasm-bindgen pkg + a PLAIN JS `worker.js` (deliberately not vite-bundled:
  the whole solver deployment is one runfiles directory the server mounts
  at /solver/, and the app references it by URL — no bundler coupling, no
  import.meta in the CJS test build). rules_rust 0.71.3 +
  rules_rust_wasm_bindgen (wasm-bindgen crate pinned `=0.2.121` to the
  bundled CLI version — the bindgen ABI schema must match).
- **Deployments pinned to `-c opt` by transition**
  (`tools/transitions/opt.bzl`): an unoptimized solve is ~10× slower and
  nobody runs the dev loop with `-c opt`, so the deployed artifacts —
  `//solver:solver_cli_opt` (the binary in the server's runfiles) and the
  wasm inside `//solver:solver_web` — transition themselves to opt
  regardless of the invocation's compilation mode (measured: benchmark
  183 ms vs ~2 s fastbuild; wasm 360 KB vs 1.1 MB). Both sides transition
  identically, so the placement decision always compares opt against opt.
  Unit tests keep the invocation's mode for fast iteration;
  `native_solver.py` falls back from the `_opt` runfiles path to the raw
  one for tests that data-dep `:solver_cli` directly.

## Hue-only signaling + SNR-adaptive symbol alphabet (hue-only-signaling branch, 2026-07-10)

- **The intensity ("gray") carrier is REMOVED; hue is the only carrier.**
  On-device experience showed the intensity code's dark frames make blobs
  DISAPPEAR — the tracker had to coast blind through every 0-bit and the
  ALL_OFF frame, and cross-frame track association failed exactly where the
  code needed it. Under the hue carrier every LED is lit every frame at
  constant brightness (the code is in COLOR), so tracks never lose their
  blobs. The §7.6 `encoding` enum collapses to `"hue"`; the old dark-room
  fallback to `gray` is gone (dark rooms now get the robust 2-symbol
  alphabet instead — chroma still washes out in a truly black room, which
  is a lighting problem, not a carrier choice).
- **`CodeParams.symbols` (2 | 4): the SNR-adaptive data alphabet.**
  `bits` still counts CODE bits (Gray data + SEC-DED parity); frames carry
  `log2(symbols)` bits each, so `cycleFrames = 2 + ceil(bits /
log2(symbols))` — a 64-LED SEC-DED cycle is 14 windows at 2 symbols,
  8 at 4 (~43% faster identification when conditions allow).
- **Palette** (white=ALL_ON reference, green=ALL_OFF sync, both unchanged):
  2 symbols → red(1)/blue(0), the maximally separated pair. 4 symbols →
  the hue-adjacent path blue(240°) → magenta(300°) → red(0°) → yellow(60°)
  carrying binary-reflected-Gray bit pairs 00→01→11→10, so the DOMINANT
  misread (confusing neighboring hues) flips exactly one bit — which
  SEC-DED corrects; the FEC's single-window guarantee survives the wider
  alphabet for the realistic error mode. Cyan is unused (it scores on the
  green sync axis and would confuse the alignment census). Pinned by
  cross-language goldens (golden_secded16.json / golden_secded16_sym4.json)
  and an end-to-end adjacent-misread pipeline test.
- **Decode**: per-window mean color is normalized by the track's own white
  window (cancels white balance; static-hue clutter reads neutral and
  fails the green sync — both mechanisms carried over), then classified to
  the NEAREST palette target (L1); the margin is the best-vs-runner-up gap
  normalized so a perfect read scores 1.0 in either alphabet.
- **Alphabet negotiation**: at start the phone picks from scene stats
  (mean luma ≥ 0.12 and clip fraction ≤ 0.05 → 4, else 2 — clipping
  saturates channels and collapses hue). Mid-capture it reads the
  decoder's `marginEma` (EMA of per-cycle worst-window margins over
  sync-valid cycles — the MEASURED chroma SNR): < 0.35 downgrades 4→2,
  ≥ 0.7 in a still-good scene upgrades 2→4; the wide dead zone plus the
  existing 2-tick agreement rule prevents flapping. `?symbols=2|4` forces.
- **The M1 driver now renders per-LED colors** (`frame_bytes_colors`,
  APA102 B,G,R order; `graycode.color_plan` replaces the binary
  `frame_plan`) — the hue carrier is no longer wall-only.
