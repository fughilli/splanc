# Diffuse-capture bench tooling (2026-11-18 rope session)

This is the tooling and small reference data behind PR #555 (adaptive diffuse
spot detector, negotiated exposure and bit rate) and the regression suite
`web/tests/diffuseRope.test.ts`. Use it to re-score detector changes on the
full captures, extend the regression set, or rerun the bench with a phone and a
lamp.

**Raw data** (2.1 GB of full-res PNG frames; the repo is public, so it isn't
here) lives on the Mac mini:

    /Volumes/MacMiniExt/Projects/splanc-data/diffuse-capture-2026-11-18/

That directory has every script below at its top level, next to `frames/`, so
everything runs in place there (`cd` into it). The scripts resolve their data
relative to their own location (`D = dirname(__file__)`), so to use the copies
here, put them beside a data directory with the same layout.

## Setup that was measured

| Part           | What                                                                                                                                                                                                |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixture        | DemoPixieLamp: a 250-LED WS2812 rope, wired GRB, inside a white braided diffuser coiled on a lamp form. About 190 LEDs are visible from the camera; the rest are hidden behind the form.            |
| Camera         | Pixel 10 Pro Fold rear camera, 720x1280 portrait, Chrome `getUserMedia`, on a stand. `data/camera.json` holds its capabilities. Manual exposure (ISO 30, white balance locked 5000 K) unless noted. |
| LED control    | `set_counting_pattern` through the app's own device client (found with `capture/findclient.mjs`). Note that the firmware keeps only the first 32 blocks.                                            |
| Exposure scale | `x` in [0,1] is `planExposure`'s geometric map between the camera minimum (0.057 ms) and 55 ms. For example, x = 0.35 is about 0.63 ms and x = 0.45 about 1.3 ms.                                   |

There were two sessions with different phone placements, each with its own LED
centres and reference scans:

- **s1**: frames `single_s1`, `single_hi_s1`, `stride`, `extra`, `extra2`;
  centres in `centers_s1_clean.json`.
- **s2**: frames `single_s2`, `single_hi_s2`, `ae`; centres in
  `centers_s2_clean.json`.

## Data (here: `data/`; frames: Mac mini)

| File                                             | What                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `centers_s1_clean.json`, `centers_s2_clean.json` | Exact per-LED spot centres (full-res px) for each session. Each is a merge of the dim (`centers_lo*`, white 0.6 at x = 0.35) and bright (`centers_hi*`, white 1.0 at x = 0.55) single-LED scans: the bright scan unless saturated, else the dim one. `src: "none"` marks LEDs that are hidden, too faint, or "ghosts" whose light only escapes at a shared indirect-glow point. Use these, not the raw scans. |
| `plan_*.json`                                    | Capture plans, inputs to `capture/runplan.mjs`. **`plan_stride.json` is invalid**: it sends more than 32 blocks, which the firmware silently truncates. `plan_stride2.json` (32-block windows) replaced it, and `frames/stride` is the stride2 capture.                                                                                                                                                       |
| `plans_done/<frames dir>.json`                   | What each capture actually did: per step, the exposure, exposure time and the exact lit blocks with their colours. The scorers read these as `frames/<dir>/plan_done.json`.                                                                                                                                                                                                                                   |
| `detectable_<frames dir>.json`                   | Per step, the lit LEDs and the subset that is **detectable**: the known-location response (frame minus dark, max channel, gaussian σ 3) is above 5× noise. Recall is scored against these. The `ae` set uses per-frame matched darks.                                                                                                                                                                         |

Frame sets on the Mac mini (`frames/`):

| Set                                                      | Content                                                                                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sweep`                                                  | 240 frames of the **real mapping code** (v1, stride 3) at 4 LED brightness levels × 6 exposures. There's no per-frame ground truth, since the lit set comes from the code.                                             |
| `single_s1`, `single_hi_s1`, `single_s2`, `single_hi_s2` | One-LED-at-a-time reference scans, 2 frames per LED plus darks, per session. The dim scan is white 0.6 at x = 0.35; the bright one (`_hi`) is white 1.0 at x = 0.55.                                                   |
| `stride`                                                 | Every 3rd LED in 32-LED windows, random R/G/B, at 4 brightness levels × 6 exposures, with darks per exposure.                                                                                                          |
| `extra`                                                  | All six code colours (R, B, M, Y, W, G), stride 3 at 2 brightness levels × 4 exposures, plus stride 2.                                                                                                                 |
| `extra2`                                                 | The palette at the brightness/exposure extremes.                                                                                                                                                                       |
| `ae`                                                     | Stride 3, R/G/B and palette patterns under the camera's **auto exposure** (the failure regime: about 17 ms, merged spots), each with a matched dark taken at the exposure and ISO that AE chose (`dark_<step>_0.png`). |
| `check*`, `probe`, `branch`                              | Drift checks and probes.                                                                                                                                                                                               |

The data dir also has `bundles/` (the v1/v2 capture bundles from main this
morning: 6/250 vs 122/250 LEDs placed) and `console*.log` (phone console
captures of every on-device run, including the `[adaptive-prof]` timing
breakdown in `console_branch8.log` and `console_branch9.log`).

## Capture workflow (`capture/`)

1. **Wireless ADB + DevTools.** Run `adb tcpip 5555` (on USB), then
   `adb connect <phone>:5555` and
   `adb forward tcp:9222 localabstract:chrome_devtools_remote`. Find the Splanc
   tab id with `curl localhost:9222/json/list`.
2. **Device client:** `node findclient.mjs <tab>` pins the app's connected
   client as `window.__dc` (it's found through CDP `queryObjects`).
3. **Camera:** `node cdp_eval.mjs <tab> "$(cat cam.js)"` opens a stream
   (`window.__camv`) and defines `__setExp(x)` (manual exposure, ISO minimum).
   Lock white balance before any scan:
   `__camv.srcObject.getVideoTracks()[0].applyConstraints({advanced:[{whiteBalanceMode:"manual",colorTemperature:5000}]})`.
   `cam_ae.js` is the same stream left on auto exposure.
4. **Run a plan:** `node runplan.mjs <tab> data/plan_X.json frames/<dir>`
   sets the exposure, sets the counting pattern (GRB) and grabs full-res PNGs.
   `runplan_ae.mjs` is the auto-exposure variant, which adds matched darks.
   Run a drift check (`plan_check.json`) before and after; compare it with
   `analysis/centers.py`'s output.
5. **Other tools:**
   - `grab.mjs`, `setknobs.mjs`: grab frames and drive the capture screen's
     manual sliders during a real capture.
   - `cdp_tail.mjs`: logs the page console.
   - `hardreload.mjs`: a cache-bypassing reload; Chrome caches `index.html`.
   - `pull_bundle.mjs`: downloads capture bundles from IndexedDB.
   - `fps_exposure_probe.js`: shows that manual exposure drops Chrome to
     30 fps.

## Analysis workflow (`analysis/`)

- `centers.py <frames subdir> <out.json>`: spot centres from a single-LED scan
  (for example `centers.py single_s1 centers_lo.json`).
  Merging the two scans and removing ghosts is inline in the PR #555 history:
  - bright scan unless saturated, else the dim scan;
  - drop any centre shared by 3 or more non-adjacent LEDs within 6 px.
- `to_raw.py <png dir> <raw dir>`: PNG to raw RGB for the node harnesses.
- `detect_eval.cjs <raw dir> <configs.json> <out.json>`: the **prototype**
  harness. It is a tap-faithful CPU emulation of the legacy GL shader
  (`variant: "prod"`) plus the DoG/adaptive prototypes, fed into the production
  `reducedToBlobs`. It needs `dist/`, which you build with
  `tsc web/src/cv/detect.ts … --outDir dist --module commonjs`.
- `ref_eval.cjs`, `color_eval.cjs`, `color_var.cjs`, `proto2.cjs`:
  - `ref_eval.cjs` runs the production reference (`web/src/cv/diffuseDetect.ts`,
    compiled to `dist2/`) with parameter overrides;
  - `color_eval.cjs` gives legacy vs adaptive blobs with colour;
  - `color_var.cjs` compares output-colour sources;
  - `proto2.cjs` holds the luma + chroma two-branch prototype, rejected because
    it didn't help at short exposure.
- `score.py <eval.json>`: recall, false positives, splits and centre error per
  (brightness, exposure). Set `SCORE_FRAMES=<frames dir>` and
  `SCORE_CENTERS=<centers json>`. `summ.py` prints one line per config,
  `colorscore.py` gives recall per code colour, `hue_score.py` gives hue error
  and 4-symbol classification.
- `overlay.py <eval> <config> <step> <out.png>`: truth vs blobs. Yellow is a
  detectable lit LED, grey an undetectable one, green a matched blob, red a
  false blob.
- `truth.py`: the first, pre-counting-pattern attempt at truth from the coded
  sweep. It's unreliable and kept only for reference.

## Regression suite

`tests/tools/build_diffuse_dataset.py` turns a session (frames +
`plan_done.json` + detectable + centres) into the committed
`tests/testdata/diffuse_rope` format: reduced 8-bit RGB, zlib, plus
`truth.json`. The committed set is 40 s1 frames. The AE slice (follow-up H on
PR #556) can be built from `frames/ae` with `centers_s2_clean.json` the same
way.

## Gotchas learned on the bench

- **Chrome on Pixel:** any manual `exposureTime` drops the camera to 30 fps,
  and re-requesting 60 doesn't reliably restore it. Auto exposure with
  `exposureCompensation` keeps 60 fps.
- **Settings readback is stale.** `track.getSettings().exposureTime` can
  report stale values. Check the frame brightness instead.
- **`set_counting_pattern` keeps 32 blocks**, silently.
- **White balance:** lock it before a scan. Continuous white balance changed
  spot peaks by about 3× between the two s1 scans.
- **New origin:** a new dev-server origin means a new camera permission
  prompt, and the lamp has only a few TLS slots, so close other app tabs'
  sockets.
- **grep in agent shells:** the shell's `grep` wrapper can skip minified JS.
  Use `/usr/bin/grep -a` to search built bundles.
