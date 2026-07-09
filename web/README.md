# web — the phone app (M5–M8) + the virtual LED wall

The Android-Chrome capture app from the design doc, plus a hardware-free test
fixture. Two Vite entry pages:

| Page | What it is |
|---|---|
| `/` | **Capture app** (M5 xr · M6 cv · M7 net · M8 ui): opens an `immersive-ar` WebXR session with `camera-access`, detects/tracks/decodes the blinking LEDs per frame, streams `DetectionRecord`s to the Pi over the §7 WebSocket, drives the session flow and shows the reconstructed result. |
| `/wall.html` | **Virtual LED wall**: renders a flat grid of virtual LEDs fullscreen on a laptop and blinks the exact M1 Gray-code frame plan, synced to the server's pattern clock. Point the phone at the screen to exercise the entire live pipeline with zero LED hardware. |

## Layout

```
src/code/   Gray-code frame plan + pattern-clock timing (§8.1/§8.2) — the TS
            mirror of pi/led_driver/graycode.py, golden-tested against it
src/geom/   pinhole camera math — mirror of reconstruction/camera.py (M3),
            golden-tested against it; used by tests + result preview
src/net/    M7: WebSocket client, SNTP clock sync (§7.3), detection batching
            with reconnect-safe buffering
src/xr/     M5: CaptureSource seam, WebXRCaptureSource (camera-access),
            projectionMatrixToIntrinsics, raw-camera-access type shims
src/cv/     M6: GPU threshold pass (detect.ts) → CPU connected components
            (ccl.ts) → coasting NN tracker (tracker.ts) → self-clocking
            per-bit-window decoder (decoder.ts); pipeline.ts is the pure-TS
            track→decode glue the tests drive without a browser
src/ui/     M8: session flow, in-AR HUD (dom-overlay), blob feedback markers,
            canvas 3D result preview
src/wall/   the virtual wall page
tests/      node:test suites (compiled to CJS, run hermetically under Bazel)
```

## Build / test

```sh
bazelisk test //web:unit_tests            # all node test suites
bazelisk test //web:web_ts_typecheck_test # tsc over the app sources
bazelisk build //web:dist                 # production bundle (vite)
```

The synthetic pipeline test (`tests/pipeline_synthetic.test.ts`) is the
browser-free Phase-3-style acceptance: a simulated planar wall + arc walk
drives the production tracker/decoder, asserting ≥98 % id coverage, zero
mis-ids, tolerance to 60 ms camera latency (via the decoder's sync-delimiter
alignment) and to dropped frames + pixel noise. Cross-language goldens pin the
Gray-code plan to the M1 driver and the projection math to the M3 solver.

Dev loop (hot reload, proxies `/ws` + `/maps` to a local M2):

```sh
bazelisk run //pi/server:serve -- --port 8080 --session-dir /tmp/lm/s --maps-dir /tmp/lm/m
pnpm --dir web dev        # http://localhost:5173
```

## Testing with a phone against the virtual wall (no LED hardware)

One command serves everything (M2 + built app, HTTPS with a persistent
self-signed cert under `.ledmapper/`):

```sh
bazelisk run //web:serve            # https on 0.0.0.0:8443
```

1. **Laptop**: open `https://localhost:8443/wall.html` (tap through the
   certificate warning once), click **Fullscreen**. The wall idles until a
   capture starts. Dim the room; crank screen brightness.
2. **Phone** (Android Chrome, same Wi-Fi): open
   `https://<laptop-LAN-IP>:8443`, tap through the cert warning. If running
   inside claude-container, port 8443 must be LAN-published — see
   `.claude-container-overlay` (needs a container restart after edits).
3. Phone prerequisites (§13 — fail-clear, the app shows these hints too):
   - `chrome://flags/#webxr-incubations` **enabled** (raw camera access),
   - Google Play Services for AR (ARCore) installed/current.
4. Set the LED count (e.g. 64), tap **Start AR capture**, point the phone at
   the wall — green markers show detected blobs — and walk a slow arc while
   the HUD counts decoded ids. Tap **Stop & solve**: the server runs M3 and
   the page shows the reconstructed point cloud + JSON/CSV downloads.
5. Sanity-check the result with no measurements: the wall is planar and
   grid-regular, so the solved points should be coplanar with uniform spacing
   (the §1 shape-consistency criteria). **Ground truth ⤓** on the wall page
   exports the grid layout (in LED-pitch units) for comparison up to a
   similarity transform.

Useful query params — capture page: `?threshold=0.6` (FORCE a fixed detector
luminance threshold, disabling the blob-count servo; unset, the threshold
starts at 0.6 and adapts), `?downscale=2`, `?flipv=0` (camera-texture row
order; flipped by default after on-device validation 2026-07-03 — see
`DetectorOptions.flipV`), `?leds=N`, `?blobs=1` (extra GL blob markers),
`?encoding=gray|gray-hue` and `?bitms=N` (FORCE the code carrier / signaling
rate, skipping auto-negotiation for that field). Wall page: `?cols=N`, `?gap`,
`?margin`, `?dot` (dot diameter as a fraction of pitch).

### Auto-negotiated capture configuration (varying-light robustness)

The client is the configuration authority — **no server flags needed** (the
old `--encoding` / `--bit-period-ms` flags are now only fallbacks for clients
that send bare options). On **Start**, the capture page probes the scene for
~1.2 s before the pattern runs (HUD: "Measuring light…"): an unthresholded
downsampled readback gives scene luminance stats, and the frame cadence is
the shutter-speed proxy (WebXR exposes no real ISO/shutter — low light
lengthens exposure and drops fps, which we CAN see). It then sends
`start_mapping` options (§7.1): dark scene → `gray`, lit scene → `gray-hue`;
`bitPeriodMs` = ≥3 camera frame intervals, so a 15 fps low-light camera gets
a 210 ms code instead of undecodable 100 ms bits.

During the capture the page streams `exposure_report` telemetry (~2 s cadence;
persisted in the session log's `exposure` array for offline diagnosis), servos
the detector threshold on the measured blob count (flood → raise, starve →
walk back), and **renegotiates mid-capture** via the `configure` message when
conditions drift (fps sag, lights toggled): the server restamps the pattern
epoch, the wall follows on its next `get_pattern` poll, the phone rebuilds its
decode pipeline, and detections already collected stay valid. Two consecutive
2 s ticks must agree before a renegotiation fires (hysteresis).

### How the wall stays in sync

The wall never owns the pattern: it connects to the same `/ws` control plane,
runs the same SNTP clock sync, and polls the `get_pattern` → `pattern_state`
message (added to §7 for exactly this) for `{active, patternClockEpoch,
codeParams}`. When the phone's `start_mapping` stamps the epoch, the wall
adopts it and renders `frameIndexAt(now + offset, epoch)` — the same function
the phone's decoder uses to bucket bit windows. Residual latency (screen
present, camera pipeline) is absorbed by the decoder's self-clocking
alignment on the ALL_ON→ALL_OFF delimiter (§8.1).

## Device caveats (§13, revisit at Phase-4 bench time)

- **Camera-texture orientation** (`flipV`): validated on-device 2026-07-03 —
  Chrome/ARCore delivers the camera texture bottom-up, so the flip is now the
  default (symptom of a wrong setting: the solve overlay renders Y-mirrored
  against the passthrough). **Intrinsics from `projectionMatrix`** remain
  device territory; a wrong K shows up as inflated M3 reprojection residuals.
- `tCaptureMs` is stamped at the rAF callback, not sensor readout; constant
  latency is handled by decode alignment, jitter is not (keep bitPeriodMs
  ≥ 3 frame intervals).
- The GPU detect stage reads back a downsampled buffer synchronously
  (~640×360 RGBA @ 30 fps). Fine for MVP; a PBO/fence pipeline is the known
  optimization if frame time suffers.

### WebXR-free capture (`?noxr=1`, or automatic fallback)

`docs/vio-exploration.md` phase 4: the capture page runs without WebXR —
getUserMedia camera + DeviceMotion IMU; the SERVER solves camera poses
jointly with the LED positions (visual-inertial bundle adjustment), so no
ARCore/`#webxr-incubations` is needed and the ARCore-degenerate lighting
conditions stop mattering. Devices that can't do camera-access AR take this
path automatically. Extra params: `?imumap=+a,+b,+g;+x,+y,+z` (DeviceMotion
axis mapping override — fit a new device with
`bazelisk run //pi/reconstruction:vio_replay -- <trace> <decoded> --diagnose`),
`?fx=` (focal seed; otherwise a previous WebXR session's cached K, otherwise
a 70°-FOV guess — fx error shifts metric scale ~1:1, shape is unaffected).
Live feedback in this mode is the 2D blob/id overlay + the converging map
inset; exact 3D-composited registration returns with the PnP follow-up.
