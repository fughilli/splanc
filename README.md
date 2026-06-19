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

## State of progress (2026-06-19)

**M10, M3, M9 are landed and green. M4 is authored but Nix-unverified.**
`bazelisk build //...` and `bazelisk test //...` both pass (5 test targets).
The next hard blocker is that **Nix is not installed in this container**, which
is needed to verify/build M4. See "Hard blocker: Nix" below.

### Done (this session)

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
  fetch time, so it does not break `bazel build //...`). **Unverified** — see
  `pi/provisioning/README.md`'s UNVERIFIED list and the blocker below.
- **`.claude-container-overlay` added** to install Nix (flakes) into the
  container image on the next launch — see `.claude/skills/container-overlay`.

### Hard blocker: Nix (restart the container to clear it)

The remaining M4 work needs `nix`, which is absent from the running container
(`which nix` fails; the runtime user is non-root and cannot install it live).
A `.claude-container-overlay` has been written that bakes Nix into the image.
**Action: restart `claude-container`** so the launcher rebuilds with the overlay,
then a future session can do the Nix-gated steps:

- generate `pi/provisioning/nix/flake.lock` (`nix flake update`);
- confirm the `.nix` modules evaluate (option paths flagged in
  `pi/provisioning/README.md` may need small fixes against the pinned
  `nixos-raspberrypi` rev);
- `bazel run //pi/provisioning:image_sd` / `:deploy_live` end-to-end.

### Not started

- **M2 — `pi/server`.** FastAPI + uvicorn + websockets. Endpoints:
  static web app, `/healthz`, `WS /ws`, `/maps/{id}`. Persists detection
  records to a session log (the `{"ledCount", "detections": [...]}` format
  M3's CLI already consumes). Invokes M3 as a subprocess.
- **M1 — `pi/led_driver`.** SK9822/APA102 over hardware SPI. Continuous
  Gray-code cycle with on/off sync delimiter. Local-socket interface for
  M2.
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
- [~] **M4 — Nix provisioning.** Authored (targets, flake, modules, keys);
      `MODULE.bazel` wired. **Blocked on Nix** for flake.lock + eval +
      end-to-end build — restart the container (overlay installs Nix) first.
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
      Mostly **Nix-blocked** (the image is Nix-built) and depends on M1/M2;
      a generic QEMU boot harness can be scaffolded independently first. This
      becomes the cheap gate that precedes "End-to-end on bench" (Phase 4).
- [ ] **Phase 0 app skeleton.** M2 server stub serving a hello web app,
      M5/M7 stubs that open WebXR and round-trip a clock-sync over
      WebSocket. Acceptance: design doc §9 Phase 0.
- [ ] **M1 — LED driver.** SPI Gray-code cycle. Acceptance: §9 Phase 1.
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
bazelisk test  //...     # 5 test targets, all green

# Try the synthetic pipeline end-to-end (no phone, no hardware):
bazelisk run //shared/simulator:simulate -- --fixture cube --leds 64 --noise none -o /tmp/log.json
bazelisk run //pi/reconstruction:reconstruct -- /tmp/log.json -o /tmp/map.json --csv /tmp/map.csv
```

Working today: M10 (protocol), M3 (reconstruction), M9 (simulator
detection-log mode). M4 (provisioning) is authored but Nix-blocked; M1/M2 and
the web modules (M5–M8) are not started. See `docs/runbook.md` for details.

## Repo layout

See design doc §11. Current on-disk reality matches it. Populated so far:
`shared/protocol` (M10), `pi/reconstruction` (M3), `shared/simulator` (M9),
`pi/provisioning` (M4, Nix-unverified), `docs/`.

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
- **Bazel build graph entry:** `MODULE.bazel`, root `BUILD.bazel`.
- **Ops:** `docs/runbook.md`, `docs/decisions.md`.
