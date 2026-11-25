# Diffuse detector bench (D-177)

Runs the **production** diffuse detector (`web/src/cv/detect.ts`, `DetectorGL` in
adaptive mode, through `DetectPipeline` when the checkout has it) in a browser on
the 40 real frames of the regression set (`web/tests/testdata/diffuse_rope`).
It does two things:

- **Parity.** Every frame goes through the WebGL path and through the CPU
  reference (`cv/diffuseDetect.ts`). Both are scored against the suite's truth
  with the suite's own scorer (`web/tests/diffuseRopeScore.ts`), and their blobs
  are matched one to one. The node suite only runs the CPU reference, so this is
  where the GL path's accuracy is checked.
- **Timing.** Frames are fed at the camera rate (60 fps by default). Each frame's
  main-thread cost is recorded and split into GPU submit, readback (wait + copy)
  and CCL. The run also counts frames lost to a busy main thread ("missed
  slots") and frames the pipeline shed because the GPU was behind ("GPU-shed").

## Headless run (container, CI, laptop)

    node web/tests/tools/detect_bench/run.mjs                       # tiers 1x, 2.5x, 5x
    node web/tests/tools/detect_bench/run.mjs --compare /path/to/main/web --rounds 3
    node web/tests/tools/detect_bench/run.mjs --ds 3 --tiers 1      # low-end tier's resolution

The runner needs Node 22 or newer (it uses the built-in WebSocket) and
`web/node_modules` (only TypeScript, which transpiles the sources on request: no
bundler). It launches Chromium (the Playwright `chromium_headless_shell` in
`~/.cache/ms-playwright`, or `--chrome` / `$CHROME`) with SwiftShader WebGL, once
per CPU-throttle tier (`Emulation.setCPUThrottlingRate`). `--compare <web dir>`
benchmarks another checkout's `web/` (for example `git worktree add` of main) in
the same session, interleaved round by round, so host load hits every variant
alike. Other flags: `--frames N`, `--no-parity`, `--sync` (force the synchronous
`detect()`), `--passes` (per-pass GPU time, debug), `--pace <ms>`, `--out results.json`.

### Device tiers

CPU throttling stands in for slower phone CPUs. It slows the page's main thread
only, which is where detection's CPU work runs (GL command issue, readback copy,
CCL). Relative to a Pixel 10 Pro Fold (Tensor G5, flagship), using single-core
scores as the yardstick:

| Tier     | Example phones                                          | Single-core vs flagship | Throttle |
| -------- | ------------------------------------------------------- | ----------------------- | -------- |
| Flagship | Pixel 10 Pro Fold, Galaxy S25                           | 1x                      | 1x       |
| Mid      | Pixel 6a, Galaxy A54 (Exynos 1380), Snapdragon 7-series | ~2.5x slower            | 2.5x     |
| Low      | Galaxy A15 / A14 (Helio G99 / G85), Snapdragon 4-series | ~4-6x slower            | 5x       |

Throttle factors are applied to the bench host's CPU, so the absolute numbers
depend on that host. Compare variants within one run.

**What the headless run can't tell you: the GPU.** SwiftShader emulates the GPU
on the CPU, and its cost is dominated by per-pass overhead. Detecting at
downscale 4 costs about as much as at 2 there, where a phone GPU does about a
quarter of the work. Treat SwiftShader GPU times (the synchronous path's
"read" column, the pipelined path's shed count) as a correctness and plumbing
check, not a GPU measurement. GPU cost needs a phone.

## On-device run (Android + Chrome)

First, serve the bench from the machine that has the repo:

    node web/tests/tools/detect_bench/run.mjs --serve-only --port 8099

Then make it reachable from the phone over USB or wireless ADB, and open
`http://localhost:8099/?auto=1` on the phone:

    adb reverse tcp:8099 tcp:8099

The page runs the parity pass, then the timing pass, and prints both. Add
`&parity=0` to skip parity, which takes ~10 s of CPU on a phone, and `&sync=1`
to time the old synchronous path for comparison.

Or drive it from the host through DevTools, which also collects the JSON:

    adb forward tcp:9222 localabstract:chrome_devtools_remote
    node web/tests/tools/detect_bench/run.mjs --attach http://localhost:9222 --port 8099 --out phone.json

With `--attach`, the runner opens the page in the phone's Chrome and runs one
tier, with no throttling: the phone is the tier.

On a phone, the pipelined path's **GPU-shed** column is the GPU-throughput
measurement: frames the GPU couldn't finish in time at 60 fps. If it is above
`DETECT_SHED_MAX` (15%) at downscale 2, the capture's probe steps the detector
to downscale 3, then 4 (`planDetectDownscale`). Rerun with `?ds=3` (or
`--ds 3`) to see that tier.
