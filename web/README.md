# web — the phone app (M5–M8) + the virtual LED wall

The Android-Chrome capture app from the design doc, plus a hardware-free test
fixture. Two Vite entry pages:

| Page         | What it is                                                                                                                                                                                                                                                                                                                                   |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`          | **Capture app** (M5 xr · M6 cv · M7 net · M8 ui): opens the rear camera (getUserMedia) + DeviceMotion IMU, detects/tracks/decodes the color-coded LEDs per frame, streams `DetectionRecord`s + `imu_batch`es over the §7 WebSocket (poses are solved jointly by the VIO solver), drives the session flow and shows the reconstructed result. |
| `/wall.html` | **Virtual LED wall**: renders a flat grid of virtual LEDs fullscreen on a laptop and blinks the exact M1 Gray-code frame plan, synced to the server's pattern clock. Point the phone at the screen to exercise the entire live pipeline with zero LED hardware.                                                                              |

## Layout

```text
src/code/   Gray-code frame plan + pattern-clock timing (§8.1/§8.2) — the TS
            mirror of pi/led_driver/graycode.py, golden-tested against it
src/geom/   pinhole camera math — mirror of reconstruction/camera.py (M3),
            golden-tested against it; used by tests + result preview
src/net/    M7: WebSocket client, SNTP clock sync (§7.3), detection batching
            with reconnect-safe buffering; proto.ts is the binary-protobuf
            wire boundary (frames <-> flat §7 objects; regen TS bindings in
            src/gen/ with shared/protocol/proto/gen_ts.sh)
src/xr/     M5: CaptureSource seam, MediaStreamCaptureSource (getUserMedia),
            DeviceMotion → camera-frame IMU (imu.ts), intrinsics helpers
src/cv/     M6: GPU threshold pass (detect.ts) → CPU connected components
            (ccl.ts) → coasting NN tracker (tracker.ts) → self-clocking
            per-bit-window decoder (decoder.ts); pipeline.ts is the pure-TS
            track→decode glue the tests drive without a browser
src/ui/     M8: session flow, in-capture HUD, blob feedback overlay,
            canvas 3D result preview
src/solver/ solver placement: SolverAgent drives the wasm VIO solver (built
            from solver/, served at /solver/ from server runfiles) in a Web
            Worker; placement.ts decides phone-vs-host from the init-time
            benchmarks (phone-first, 4x slowdown margin)
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
3. Phone prerequisites (fail-clear — the app shows hints too): any modern
   browser; grant the camera (and, on iOS, motion) permission. No Chrome
   flags, no ARCore.
4. Set the LED count (e.g. 64), tap **Start capture**, point the phone at
   the wall — colored outlines show detected blobs — and walk a slow arc
   while the HUD counts decoded ids. Tap **Stop & solve**: the final solve
   runs (phone wasm or host, whichever the init-time benchmark chose) and
   the page shows the reconstructed point cloud + JSON/CSV downloads.
5. Sanity-check the result with no measurements: the wall is planar and
   grid-regular, so the solved points should be coplanar with uniform spacing
   (the §1 shape-consistency criteria). **Ground truth ⤓** on the wall page
   exports the grid layout (in LED-pitch units) for comparison up to a
   similarity transform.

Useful query params — capture page: `?threshold=0.6` (FORCE a fixed detector
luminance threshold, disabling the blob-count servo; unset, the threshold
starts at 0.6 and adapts), `?downscale=2`, `?flipv=1` (camera-texture row
order; video uploads are top-down so the flip is OFF by default — see
`DetectorOptions.flipV`), `?leds=N`,
`?symbols=2|4` and `?bitms=N` (FORCE the symbol alphabet / signaling rate,
skipping auto-negotiation for that field), `?imumap=+a,+b,+g;+x,+y,+z`
(DeviceMotion axis-mapping override — fit a new device with
`bazelisk run //pi/reconstruction:vio_replay -- <trace> <decoded> --diagnose`),
`?fx=` (focal seed; otherwise a cached calibration, otherwise a 70°-FOV
guess — fx error shifts metric scale ~1:1, shape is unaffected). Wall page:
`?cols=N`, `?gap`, `?margin`, `?dot` (dot diameter as a fraction of pitch).

### The hue code + auto-negotiated capture configuration

The code carrier is **hue-only**: every LED is lit every frame at constant
brightness and the code rides in COLOR (ALL_ON white = per-track color
reference, ALL_OFF green = chroma sync, data frames from the symbol
palette — `src/code/gray.ts`, golden-pinned to the Python driver). Constant
lighting means blobs never disappear, so the tracker keeps cross-frame
association without coasting blind through dark bits (the failure that
killed the old intensity carrier). The decoder reads each window's color
RELATIVE to the track's own white window, which cancels white balance
exactly and makes static-hue clutter fail the green sync.

The client is the configuration authority — **no server flags needed** (the
`--symbols` / `--bit-period-ms` flags are only fallbacks for clients that
send bare options). On **Start**, the capture page probes the scene for
~1.2 s before the pattern runs (HUD: "Measuring light…"): an unthresholded
downsampled readback gives scene luminance stats, and the frame cadence is
the shutter-speed proxy (the web platform exposes no real ISO/shutter — low
light lengthens exposure and drops fps, which we CAN see). It then sends
`start_mapping` options (§7.1): a lit, low-clipping scene → **4 symbols**
(2 bits per frame — a 64-LED SEC-DED cycle is 8 windows instead of 14),
marginal chroma → the robust 2-symbol red/blue alphabet; `bitPeriodMs` =
≥3 camera frame intervals, so a 15 fps low-light camera gets a 210 ms code
instead of undecodable 100 ms windows.

During the capture the page streams `exposure_report` telemetry (~2 s cadence;
persisted in the session log's `exposure` array for offline diagnosis), servos
the detector threshold on the measured blob count (flood → raise, starve →
walk back), and **renegotiates mid-capture** via the `configure` message when
conditions drift: the signaling rate follows the measured fps, and the symbol
alphabet follows the decoder's MEASURED symbol margins (its chroma-SNR EMA —
chronically low margins downgrade 4 → 2; comfortable margins in a bright
scene upgrade). The server restamps the pattern epoch, the wall follows on
its next `get_pattern` poll, the phone rebuilds its decode pipeline, and
detections already collected stay valid. Two consecutive 2 s ticks must
agree before a renegotiation fires (hysteresis).

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

- **Camera-texture orientation** (`flipV`): `texImage2D(video)` uploads are
  top-down, so the flip is OFF by default (`?flipv=1` reverts should a
  device differ; symptom of a wrong setting: the blob overlay renders
  Y-mirrored against the preview).
- **Intrinsics**: there is no platform K source — the seed is `?fx=`, a
  cached calibration, or the 70°-FOV heuristic. A wrong fx shifts the map's
  METRIC SCALE ~1:1 (shape is unaffected); a calibration flow (PnP
  phase 4.5) is the planned fix.
- `tCaptureMs` is stamped at the frame callback, not sensor readout;
  constant latency is handled by decode alignment, jitter is not (keep
  bitPeriodMs ≥ 3 frame intervals).
- The GPU detect stage reads back a downsampled buffer synchronously
  (~640×360 RGBA @ 30 fps). Fine for MVP; a PBO/fence pipeline is the known
  optimization if frame time suffers.

### How capture works without a platform tracker

`docs/vio-exploration.md` phase 4 (the ONLY capture path since the M6 WebXR
removal): getUserMedia camera + DeviceMotion IMU; the solver estimates
camera poses jointly with the LED positions (visual-inertial bundle
adjustment), so no ARCore/Chrome flags are needed and the ARCore-degenerate
lighting conditions don't matter. Live feedback is the 2D blob/id overlay +
the converging map inset; exact 3D-composited registration returns with the
PnP follow-up.
