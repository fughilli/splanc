# Decision log

Pinned versions and the rationale behind them. Update this file together with
the file that holds each pin (`MODULE.bazel`, `requirements.lock`,
`package.json`, `pi/provisioning/nix/flake.nix`).

## Build system — Bazel (bzlmod)

The project is managed with **Bazel using bzlmod** (`MODULE.bazel`, no
`WORKSPACE`). Rationale:

- **One polyglot graph.** The repo is Python (Pi: driver, server, reconstruction,
  simulator, protocol codegen) *and* TypeScript (web app + generated protocol
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

| Component | Pin | Held in | Rationale |
| --------- | --- | ------- | --------- |
| Bazel | `7.7.1` | `.bazelversion` | Current stable 7.x; bzlmod is mature here. Pinned via Bazelisk. |
| Python | `3.11` | `MODULE.bazel` (`PYTHON_VERSION`) | Matches the Raspberry Pi OS (bookworm) system Python so Pi-side code runs on the same minor version it's built against. |
| `rules_python` | `2.0.3` | `MODULE.bazel` | Hermetic interpreter + `compile_pip_requirements`; single root `requirements.lock` from `requirements.in`. |
| `aspect_rules_js` | `3.2.2` | `MODULE.bazel` | pnpm-native JS rules; consumes the checked-in `pnpm-lock.yaml`. |
| `aspect_rules_ts` | `3.8.11` | `MODULE.bazel` | `ts_project` type-checking; TS version is taken from `package.json` so Bazel and `pnpm`/`tsc` agree. |
| `aspect_bazel_lib` | `2.22.5` | `MODULE.bazel` | Shared Starlark helpers required by the aspect rules. |
| `rules_pkg` | `1.2.0` | `MODULE.bazel` | Packaging (artifacts to bake into the Pi image). |
| TypeScript | `5.9.3` | `package.json` / `pnpm-lock.yaml` | Single TS version for the whole pnpm workspace; rules_ts reads it from `package.json`. |
| pnpm | `11+` | dev prerequisite | Workspace covers `web/` and `shared/protocol/ts/`. |
| Python libs | see `requirements.lock` | `requirements.in` → `requirements.lock` | pydantic, jsonschema, numpy, scipy, opencv, fastapi, uvicorn, websockets, pytest. Regenerate with `bazel run //:requirements.update`. |

> Previously this file was seeded by the M4 track with only the M4 section
> (below). The build-system pins above were folded in from `MODULE.bazel` /
> `requirements.lock` / `package.json` per the root README TODO.

## M9 — simulator noise model defaults (pinned 2026-06-19)

The simulator (`shared/simulator`) is deterministic given a seed. Its degradation
knobs default to the "nominal noise" point the design doc §9 (Phase 2) and §12
call for, so a default run exercises a realistic-but-solvable scenario:

| Knob | Default | Notes |
| ---- | ------- | ----- |
| `pixel_noise_px` | `0.5` | Gaussian σ on the `(u, v)` centroid. §9 Phase 2 nominal. |
| `pose_noise_deg` | `1.0` | Gaussian σ (deg) on camera orientation; small VIO error. §9 Phase 2 nominal. |
| `pose_noise_pos_m` | `0.003` | Gaussian σ (m) on camera position. |
| `dropout_prob` | `0.0` | Per-observation random drop. Raise to stress-test completeness. |
| `walk` | `arc` | Arc around the fixture (§12); enforces parallax. Straight-on walks are rejected by the UI in production. |
| `arc_degrees` | `120` | Angular span of the arc; sets achievable parallax. |
| `views` | `60` | Camera stations along the walk (≈ design doc's ~70 observation sets). |
| `seed` | `0` | Fixed seed ⇒ deterministic output (acceptance requirement). |

**Acceptance (Phase 2):** a **zero-noise** detection log (all knobs 0) reconstructs
to **< 1 mm RMS** through M3. At nominal noise, RMS ≤ 1% of the fixture span with
≥ 99% of LEDs solved. Enforced by
`shared/simulator/tests/test_sim_recon_roundtrip.py`.

## M3 — reconstruction parameters (pinned 2026-06-19)

From design doc §8.3 / §12. These are the defaults in `pi/reconstruction`:

| Param | Default | Notes |
| ----- | ------- | ----- |
| Triangulation init | linear (closest-point to observation rays) | Needs ≥ 2 views with parallax. |
| BA loss | Huber, `f_scale = 1.5` px | §12 "Huber delta ~1–2 px". `scipy.optimize.least_squares`, sparse Jacobian. |
| Pose refinement | off (poses fixed) | WebXR poses are metric; with fixed poses the BA separates per point (bipartite). Seam left to optimize poses jointly if VIO drift hurts (§13). |
| Outlier reject | residual > `3 ×` robust σ (MAD), then re-solve | §12. |
| Min parallax to accept | `5°` | Below this an LED is kept but flagged low-confidence (§12). |
| Min views | `2` | Fewer ⇒ LED listed in `unmapped`. |

## M1 — LED driver choices (pinned 2026-06-19)

SK9822/APA102 over hardware SPI (design doc §5). Decisions in `pi/led_driver`:

| Choice | Decision | Rationale |
| ------ | -------- | --------- |
| Wire format | start `4×00`; per-LED `0xE0\|bright5, B, G, R`; end `ceil(n/16)` (min 4) `×00` | SK9822 latch semantics; zeros are the safer cross-compatible end frame (classic APA102 used `0xFF`). Long cascades get ~n/16 extra clock bytes. |
| `spidev` | imported lazily inside `SpidevSink`; **not** in `requirements.lock` | Pi-only (provided by `pi/provisioning/nix/modules/spi.nix`), absent off-Pi. Lazy import keeps the package importable and the suite hermetic. |
| SPI clock | 8 MHz default | Comfortable for SK9822; tune per strip length/wiring. |
| On colour / brightness | white, brightness 31 | LEDs should be the brightest objects in frame (§5 dim-room guidance); configurable. |
| Pattern clock | `time.monotonic()` ms, stamped at frame 0 of the cycle | Same monotonic base as M2 clock sync (§8.2); `start()` blocks until the worker stamps it so the epoch reflects the real cycle start. |
| M1↔M2 transport | separate process + Unix-socket, newline-delimited JSON | §3 process split: server restarts don't drop the pattern; driver can run at RT priority. `CodeParams` authored by M2 (`codebook.py`), consumed by M1. |
| Testability | injected `clock`/`sleep` + `RecordingSink` | Drive the loop deterministically with no wall-clock waits or hardware. Real cadence (§9 Phase 1) still needs a logic analyzer on a bench. |

## M2 — Pi server choices (pinned 2026-06-19)

FastAPI/uvicorn/websockets, per design doc §4. Decisions in `pi/server`:

| Choice | Decision | Rationale |
| ------ | -------- | --------- |
| Server clock | `time.monotonic()` ms | §7.3 offset/rtt math needs differences from a clock that can't step; one clock feeds both `t1`/`t2` and `patternClockEpoch`. |
| Reconstruction trigger | M3 library called in a worker thread (`asyncio.to_thread`) on `stop_mapping` | Keeps the event loop responsive during multi-second BA. Design §3 frames it as a "subprocess/job"; the seam is one async callable in `reconstruct.py`, so swapping to a true subprocess later is local. |
| Session persistence | buffer in memory, flush the `{ledCount, detections}` log on stop | Simple; the log is exactly M3's input format. Trade-off: a crash mid-capture loses the session — on-disk journaling deferred. |
| `patternClockEpoch` | stubbed to server clock at `start_mapping` | M1 driver isn't built; `get_clock().epoch` replaces it later. Seam: `SessionManager.start()`. |
| `status` fields | `identified` = LEDs ≥2 views; `lowParallax` = LEDs seen once | True parallax needs geometry; these are honest live proxies for walk guidance. Real parallax is in the `OutputMap`. |
| `welcome.codeParams` | server default `--led-count` (1024) until `start_mapping` | ledCount is unknown at `hello`; `mapping_started` carries the actual code-book once the client sends it. |
| Testing | transport-decoupled core + a real-server integration test | `httpx` is intentionally *not* in the lockfile, so we avoid `fastapi.TestClient`; the integration test uses the `websockets` sync client + stdlib `urllib` against a live uvicorn. |

## M4 — Nix-driven provisioning (pinned 2026-06-19)

The original M4 scope (shell + `hostapd`/`dnsmasq`/`avahi`/systemd) was
redirected to a Bazel + Nix workflow (root README "Active directives"). See
`pi/provisioning/README.md` for the full design and the UNVERIFIED list.

| Component            | Pin                                                                     | Rationale |
| -------------------- | ----------------------------------------------------------------------- | --------- |
| `rules_nixpkgs_core` | `0.13.0`                                                                | Latest tweag/rules_nixpkgs release; first with Bazel 8 support. Registration-only in `MODULE.bazel` (no `nix_repo`) so it never forces a Nix eval at fetch time — keeps `bazel build //...` green on machines without Nix. |
| `nixos-raspberrypi`  | tag `v1.20260517.0` (commit `06c6e3513e1ee64b651913193fc6ac38aa4963f5`)  | `nvmd/nixos-raspberrypi` provides Pi 4/5 kernel, firmware, device tree, and SD-image builders. Pinned to a tagged release for reproducibility. **Note the `v` prefix** — the flake originally pinned `1.20260517.0` (no `v`), which GitHub does not resolve; corrected 2026-06-19 when generating `flake.lock`. |
| `nixpkgs`            | branch `nixos-25.05` (locked to `ac62194` in `flake.lock`)               | Followed by `nixos-raspberrypi.inputs.nixpkgs` so there is a single coherent package set (avoids divergent kernel/userspace). **Trade-off:** because we pin our own `nixos-25.05` and make upstream `follows` it, the resolved nixpkgs differs from the one `nixos-raspberrypi.cachix.org` built its kernel/firmware against, so `image_sd` rebuilds the Pi kernel from source (~20–40 min on first build, then cached locally). To get kernel cache hits instead, drop the `follows` and accept upstream's nixpkgs. |
| Target board         | `raspberry-pi-5` (default)                                               | Design doc §5 targets Pi 4 or 5; default to 5, switch via `board` in `flake.nix`. |

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
is *outside* the flake root (`nix/`), so a relative path from the module cannot
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
  `@types/webxr 0.5.24`, `@types/node 24.10.9`. **No runtime dependencies** —
  the app is hand-rolled DOM + WebGL2; three.js was dropped because we render
  no 3D AR content (the CV pass and feedback markers are raw GL, the result
  preview is a 2D-canvas scatter), and every KB matters on a phone loading
  from a Pi AP.
- **`pattern_state` protocol addition (§7).** New `get_pattern` (client) /
  `pattern_state` (server) messages: `{active, patternClockEpoch|null,
  codeParams}`. Exists so *pattern followers* — the virtual LED wall — can
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
  maximizing (global on-count in ALL_ON window) − (ALL_OFF window) over
  candidate shifts each cycle, taking the *center of the top-score plateau*
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
