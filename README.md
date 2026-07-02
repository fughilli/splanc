# LED Mapper

Recover the 3D position of every LED in an installed addressable-LED fixture
by walking around it with an Android phone. A Raspberry Pi drives the LEDs
through a known temporal blink code, the phone's WebXR session captures
synced pose + camera frames, and the Pi triangulates per-LED positions and
exports a `(led_id → xyz)` map.

The full design — goals, architecture, module breakdown, data contracts,
algorithms, and phased build plan — lives in
[`led-mapper-design.md`](./led-mapper-design.md). **Read it first.** This
README is a working state-of-the-build snapshot for the next agent picking
the project up; the design doc is the durable spec.

## State of progress (2026-06-22)

**M10, M3, M9, M2, M1 are landed and green. M4 is Nix-verified** (config
evaluates + image derivation builds; final image not realized in-sandbox and not
booted on hardware). `bazelisk build //...` and `bazelisk test //...` both pass
(**9 test targets**). The Nix blocker that stopped the previous session is
**cleared** — the container was rebuilt with the Nix overlay, so `nix` works and
the host is natively `aarch64-linux` (Pi images build without cross-emulation).

> **Environment note (2026-06-19):** the container rebuild also surfaced a JVM
> crash — Bazel 7.7.1's bundled JDK 21 emits SVE instructions that `SIGILL` on
> this host. Fixed with `startup --host_jvm_args=-XX:UseSVE=0` in `.bazelrc`
> (see `docs/decisions.md`). Plain `bazelisk` works again. If you ever see a
> wedged zombie `[java]` server, point bazel at a fresh `--output_base`.

### Handoff — Bazel caches persisted across restarts (2026-07-02)

**The post-restart first build is no longer a slow full rebuild.** The
container's root fs (`~/.cache`) is wiped on every `claude-container` restart,
which is why the first build used to take ~1.8 h re-downloading every external
repo over a flaky network. Fixed by persisting Bazel's *content-addressable*
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
`127.0.0.1:8080→8080` M2) passed to `docker run -p`. The in-container server
must bind `0.0.0.0` for the mapping to reach it — the studio defaults to that;
for M2 pass `--host 0.0.0.0`. (The studio's 3D viewport was also fixed to
center the origin/orbit pivot on retina displays and use CAD-style, no-inertia
controls.)

All work is on branch **`m1-driver-m2-server-m4-verify`**, committed through
`6805600` (working tree clean). The `/workspace` bind mount — including the
persisted caches — survives the restart.

### Done (this session)

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

### Done (earlier sessions)

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

- **M5 — `web/src/xr`.** WebXR `immersive-ar` + `camera-access`,
  `XRWebGLBinding.getCameraImage`, intrinsics derived from
  `XRView.projectionMatrix`. Implements the `CaptureSource` interface
  from design doc §6 / M5.
- **M6 — `web/src/cv`.** WebGL threshold + connected-components on the
  GPU; nearest-neighbor track across frames; per-bit-window decode of
  the Gray code → `DetectionRecord`s. Validates against an M9 **frame mode**
  (not yet built — only detection-log mode exists).
- **M7 — `web/src/net`.** WebSocket client, SNTP-style clock sync (§7.3),
  detection batching.
- **M8 — `web/src/ui`.** Session flow, live coverage guidance, low-
  parallax warnings.

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
      https://azeria-labs.com/emulate-raspberry-pi-with-qemu/) so the
      deployment workflow (M4) and the embedded app (M1 driver + M2 server)
      can be exercised end-to-end in CI with no physical board. The linked
      guide uses 32-bit Raspbian on `qemu-system-arm -M versatilepb` with a
      `qemu-rpi-kernel`; adapt to our stack: our M4 image is a **64-bit NixOS
      aarch64** build, so use `qemu-system-aarch64` (`-M virt` or a `raspi*`
      machine), booting the SD image / extracted kernel+dtb, with
      `-netdev user,hostfwd=tcp::5022-:22` for SSH. Target shape:
      - `bazel run //pi/provisioning:emulate` — boot the built image in QEMU;
      - point `deploy_live` at `ssh://…:5022` to prove the deploy key trust
        and `nixos-rebuild switch --target-host` round-trip against a live
        (virtual) system;
      - run M1 (SPI driver — stub/loopback the SPI device under emulation)
        and M2 (server + clock sync + a recorded detection session →
        reconstruct) inside the guest as the embedded smoke test.
      No longer Nix-blocked (config evaluates), and **M1/M2 now exist** to run
      inside the guest — the gating dependency is now realizing the SD image on a
      host with enough RAM/disk (the in-sandbox kernel compile OOM'd). A generic
      QEMU boot harness can be scaffolded independently first. This becomes the
      cheap gate that precedes "End-to-end on bench" (Phase 4).
- [~] **Phase 0 app skeleton.** M2 server **done** (serves a hello web app +
      clock-sync over WebSocket). Remaining: M5/M7 stubs that open WebXR and
      round-trip the clock sync from the phone. Acceptance: design doc §9 Phase 0.
- [~] **M1 — LED driver.** SPI Gray-code cycle + M2 control socket **done**
      and unit-tested (recording sink, injected timing). Remaining: real-strip
      cadence verification on a bench (§9 Phase 1 acceptance needs a logic
      analyzer) and RT scheduling via the M4 systemd unit.
- [ ] **M6 — CV pipeline.** Validates against M9 frame mode.
      Acceptance: §9 Phase 3.
- [ ] **End-to-end on bench.** Real phone + real strip + golden fixture.
      Acceptance: §9 Phase 4.
- [ ] **Robustness & UX.** Coverage guidance polish, exposure handling,
      stress matrix from §10.6. Acceptance: §9 Phase 5.

## How to bootstrap (current best knowledge)

Prereqs: `bazelisk`, `pnpm` (11+), `node` (20+). All present on the
current dev machine.

```sh
bazelisk build //...     # builds clean
bazelisk test  //...     # 9 test targets, all green

# Try the synthetic pipeline end-to-end (no phone, no hardware):
bazelisk run //shared/simulator:simulate -- --fixture cube --leds 64 --noise none -o /tmp/log.json
bazelisk run //pi/reconstruction:reconstruct -- /tmp/log.json -o /tmp/map.json --csv /tmp/map.csv

# Or drive the same data through the live server (M2):
bazelisk run //pi/server:serve -- --host 127.0.0.1 --port 8080 \
    --session-dir /tmp/lm/sessions --maps-dir /tmp/lm/maps
```

Working today: M10 (protocol), M3 (reconstruction), M9 (simulator
detection-log mode), M2 (server), M1 (LED driver — software-tested, bench
cadence pending). M4 (provisioning) is Nix-verified (config evaluates + image
derivation builds; final image not realized in-sandbox, not booted). The web
modules (M5–M8) are not started. See `docs/runbook.md` for details.

## Repo layout

See design doc §11. Current on-disk reality matches it. Populated so far:
`shared/protocol` (M10), `pi/reconstruction` (M3), `shared/simulator` (M9),
`pi/server` (M2), `pi/led_driver` (M1), `pi/provisioning` (M4, Nix-verified),
`docs/`. Plus `tools/sim_studio` — an interactive 3D solver-debugging studio
(not a shipping module; see below).

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
- **Sim Studio (dev tool):** `tools/sim_studio/` — interactive 3D studio to
  generate fixtures, fly a camera to synthesize captures, and watch the real M3
  solver converge vs ground truth. `bazelisk run //tools/sim_studio:serve`, then
  open `http://localhost:8090` on the host (port mapping is in the overlay).
- **Bazel build graph entry:** `MODULE.bazel`, root `BUILD.bazel`.
- **Ops:** `docs/runbook.md`, `docs/decisions.md`.
