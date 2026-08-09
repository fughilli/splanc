# Developing splanc

The contributor guide: how the repo is built, tested, and laid out, plus the
environment gotchas worth knowing. For what the project _is_ and how to use it,
see [`README.md`](./README.md); for the durable design, see
[`led-mapper-design.md`](./led-mapper-design.md).

## Prerequisites

- **Bazel** via `bazelisk` — the single build/test entry point for the whole
  polyglot repo (Python, TypeScript, Rust, C++ firmware).
- **Nix** on `PATH`, flakes enabled — a system requirement. `rules_nixpkgs`
  realizes build tools (the HTML minifier for firmware-baked pages, the
  ESP32/RP2350 cross toolchains and Arduino cores) and the provisioning targets
  shell out to the `nix` CLI. Fetches are lazy, so a narrow build that touches no
  nix-backed target still works without it — but `bazel test //...` needs it.
- **pnpm** (11+) and **node** (20+) for the web app's toolchain.

## Build & test

```sh
bazel build //...          # everything (host + web + rust/wasm; firmware is opt-in)
bazel test  //...          # the full test suite

# The ESP32-C6 firmware image is tags=manual (kept out of //... so the common
# build stays light — it compiles mbedtls + the Arduino core from source):
bazel build -c opt //firmware/player_app:esp32c6
```

CI (`.github/workflows/test.yaml`) runs three jobs on every PR: `bazel test
//...`, the firmware image build, and `pre-commit`. Run `pre-commit run
--all-files` locally before pushing — the hooks (black/isort/flake8, buildifier,
prettier, markdownlint, shellcheck, …) are pinned in `.pre-commit-config.yaml`.

## Try the pipeline with no hardware

```sh
# Synthetic capture -> solve, end to end:
bazel run //shared/simulator:simulate -- --fixture cube --leds 64 --noise none -o /tmp/log.json
bazel run //pi/reconstruction:reconstruct -- /tmp/log.json -o /tmp/map.json

# Serve the real web app + control plane over HTTPS, plus a "virtual LED wall" you
# can point a phone at (/wall.html) to exercise the whole live pipeline:
bazel run //web:serve         # https://0.0.0.0:8443
```

The web app deploys to Cloudflare Pages (ledmapper.pages.dev) via
`//web:deploy_cloudflare`.

When developing inside claude-container, in-container servers are published as
**named services** (`.claude-container-overlay/overlay.json`) instead of fixed
host ports, so any number of worktree containers can run concurrently: the sim
studio (`studio`, 8090) and the plain-HTTP dev server (`web`, 8080) are at
`http://<name>.<instance>.claude.localhost/`, and the TLS server above
(`web-tls`, 8443) is reached by asking the host for a raw port:
`claude-container --service-port <instance>/web-tls`. Run
`claude-container --services` on the host to list instances and URLs.

## Repo layout

| Path                | What                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `web/`              | phone capture app + effects editor + virtual LED wall (Vite/TS) — [README](./web/README.md)       |
| `firmware/`         | ESP32-C6 / RP2350 player firmware: LED driver, wss control server, effects execution              |
| `firmware/fx_vm/`   | effects bytecode VM (Rust, `no_std`) — runs on device and, as wasm, in the browser preview        |
| `fx_compiler/`      | the GLSL-ish effect language → `.fxb` bytecode compiler (Rust)                                    |
| `solver/`           | visual-inertial solver (Rust): native on the Pi, wasm in a phone Web Worker                       |
| `pi/`               | Raspberry Pi path: `led_driver`, `server`, `reconstruction`, `provisioning` (Nix/NixOS)           |
| `shared/protocol/`  | wire protocol: JSON schemas → generated Python + TS bindings (byte-pinned by a freshness check)   |
| `shared/simulator/` | synthetic detection-log generator for hardware-free testing                                       |
| `tools/`            | host-side dev/bench helpers (flash server, BLE onboarder, headless-browser driver, sim studio, …) |
| `docs/`             | design docs, decisions log, runbook, exploration notes                                            |

The firmware toolchains and Arduino cores come from a separate Bazel module,
`@embedded` (`fughilli/embedded`), pinned via `archive_override` in
`MODULE.bazel`.

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

## Key references

- **Design spec:** `led-mapper-design.md` — read §0 (how to use it), §6
  (modules), §7 (data contracts), §9 (phased build plan).
- **Wire protocol:** `shared/protocol/schemas/*.json` (authoritative); regenerate
  bindings with `python3 shared/protocol/codegen.py`
  (`//shared/protocol:codegen_freshness` fails the build if they drift).
- **Decisions & runbook:** `docs/decisions.md`, `docs/runbook.md`.
- **Effects / feature roadmap:** `next_steps.md`.
- **Project history:** `WORKLOG.md`.
