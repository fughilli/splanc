# Provenance

`tools/vive` was moved here from
[fughilli/indoor_localization](https://github.com/fughilli/indoor_localization) at
`05d9473` (branch `lighthouse-station-lifecycle`, indoor_localization#6). That is the
version that ran the flashlight, plane and scavenger-hunt demos on PixieLamp2 on
2026-11-22. From then on Splanc owns this copy.

| Here                               | There                                 |
| ---------------------------------- | ------------------------------------- |
| `pose_server/server.py`            | `swarm/tools/vive_web/server.py`      |
| `pose_server/index.html`           | `swarm/tools/vive_web/index.html`     |
| `pose_server/tests/test_server.py` | `swarm/tools/vive_web/server_test.py` |
| `demos/`                           | `lighthouse/demos/splanc/`            |

## What changed in the move

- **Bazel.** `//tools/vive/pose_server` runs lhd from Splanc's `@lighthouse` pin (passed
  with `--lhd`). `//tools/vive/demos:demo` and `:flashlight` run the demos. `bazel test
//tools/vive/...` runs every test, plus the flashlight effect on the real effect VM
  (`//agent:wasm`; before, that check skipped unless pointed at an agent package).
- **The pose server defaults to `--source lhd`.** libsurvive isn't part of Splanc;
  `--source libsurvive` still works with a local survive-cli. Without an lhd binary it
  now stops with a clear message instead of a `TypeError`.
- **`bazel run` writes to the checkout.** `demos/workspace.py` keeps mounts, sessions and
  the dry-run log in the source directory, and takes relative command-line paths from
  where `bazel run` was typed. Run with python3 from the checkout, nothing changes.
- **Paths and names.** Docs and messages name the new paths; "vive_web" is the "pose
  server".
- **Lint.** black, isort, flake8, prettier and markdownlint as Splanc runs them: unused
  imports and variables removed, an ambiguous name renamed, long lines wrapped.
- `tests/test_app_synthetic.py` passes its `sys.path` to the app subprocess (Bazel puts
  numpy and scipy only there).
