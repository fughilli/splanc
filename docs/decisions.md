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

## M4 — Nix-driven provisioning (pinned 2026-06-19)

The original M4 scope (shell + `hostapd`/`dnsmasq`/`avahi`/systemd) was
redirected to a Bazel + Nix workflow (root README "Active directives"). See
`pi/provisioning/README.md` for the full design and the UNVERIFIED list.

| Component            | Pin                                                                     | Rationale |
| -------------------- | ----------------------------------------------------------------------- | --------- |
| `rules_nixpkgs_core` | `0.13.0`                                                                | Latest tweag/rules_nixpkgs release; first with Bazel 8 support. Registration-only in `MODULE.bazel` (no `nix_repo`) so it never forces a Nix eval at fetch time — keeps `bazel build //...` green on machines without Nix. |
| `nixos-raspberrypi`  | tag `1.20260517.0` (commit `06c6e3513e1ee64b651913193fc6ac38aa4963f5`)  | `nvmd/nixos-raspberrypi` provides Pi 4/5 kernel, firmware, device tree, and SD-image builders. Pinned to a tagged release for reproducibility. |
| `nixpkgs`            | branch `nixos-25.05`                                                     | Followed by `nixos-raspberrypi.inputs.nixpkgs` so there is a single coherent package set (avoids divergent kernel/userspace). Lock-level pin comes from `flake.lock`. |
| Target board         | `raspberry-pi-5` (default)                                               | Design doc §5 targets Pi 4 or 5; default to 5, switch via `board` in `flake.nix`. |

**Open item:** `pi/provisioning/nix/flake.lock` is not yet generated (no Nix in
the authoring environment). Generate it with `nix flake update` on a Nix host
and commit it to lock input hashes.

**SSH deploy key:** ed25519 pair owned by the deploy flow. Public half baked
into the image `authorized_keys`; private half used by `deploy_live`. Stored
gitignored under `pi/provisioning/secrets/` (or `LEDMAPPER_DEPLOY_KEY_DIR`).
Never committed; rotatable via `bazel run //pi/provisioning:keys -- rotate`.
