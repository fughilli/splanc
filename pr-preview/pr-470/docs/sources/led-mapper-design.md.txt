# LED Mapper — Design Doc (Android-first)

**Status:** Draft for implementation
**Audience:** Coding agents building the system, plus human reviewers
**Scope of this version:** Android (Chrome) capture path only. iOS is explicitly deferred but the capture interface is designed to accept an iOS implementation later without touching the rest of the system.

---

## 0. How to use this doc (read first if you are an agent)

1. The **single source of truth for all cross-module data formats is `/shared/protocol`** (§7). Generate the language bindings before writing any module that sends or receives data. Never hand-redefine a schema in a module.
2. **The simulator (`/shared/simulator`, M9) and the protocol package (M10) are built first.** They unblock parallel work: the reconstruction module can be built and validated against synthetic detection logs with no phone and no hardware, and the CV module can be built against synthetic frames.
3. Work proceeds in **phases** (§9). Each phase ends in a demoable, testable artifact with explicit acceptance criteria. Do not start a phase before its listed dependencies pass their acceptance criteria.
4. Modules are designed to be built independently. Each module spec (§6) lists its responsibilities, its inputs/outputs, and the interface it must satisfy. Respect the interface; the internals are yours.
5. When a decision is genuinely ambiguous, prefer the **simplest implementation that satisfies the interface and acceptance criteria**, and record the decision in `/docs/decisions.md`.

---

## 1. Goal and success criteria

Build a self-contained tool that recovers the 3D position of every LED in an installed addressable-LED fixture.

A Raspberry Pi drives the LEDs and hosts a web app. A user opens the web app on an Android phone, points the camera at the fixture, and walks an arc around it. The system fuses the phone's camera + 6-DoF pose with the known temporal blink pattern of the LEDs to triangulate each LED's position, and exports a per-index 3D map.

**Definition of done (MVP):**

- A user can map a fixture of up to **1024 LEDs** by walking around it for ≤ 2 minutes.
- On the **bench golden fixture** (§8.3), reconstructed positions have **RMS error ≤ 2% of the fixture's longest dimension** and **≥ 95% of LEDs identified**.
- Shape-consistency checks pass: LEDs placed collinear reconstruct collinear (deviation ≤ 2% of length); LEDs placed coplanar reconstruct coplanar (plane-fit residual ≤ 2% of span).
- The full pipeline runs offline on a field-deployed Pi with no internet (Pi acts as its own Wi-Fi AP).
- Output is a documented JSON + CSV map (§7.5).

**Non-goals for this version:** iOS support, simultaneous multi-phone capture, live re-mapping during light shows, dense fixtures where adjacent LEDs are optically unresolvable at the user's walking distance (call this out to the user; do not silently produce garbage).

---

## 2. Problem framing

This is structure-from-motion with the correspondence problem removed. In normal monocular SfM, the hard part is deciding that a bright blob in one frame is the same physical point as a blob in another frame. Here the LEDs solve that themselves: they blink a known temporal code, so each blob announces its own index.

The system therefore decomposes into three loosely-coupled problems:

1. **Identification** — temporal coding so each detected blob is labeled with its LED index.
2. **Pose** — the camera's 6-DoF pose per frame. On Android this comes from WebXR's underlying ARCore VIO (camera + IMU fused for us), already in metric scale.
3. **Reconstruction** — triangulate each labeled LED from many labeled, posed views, then globally refine with bundle adjustment.

The key architectural consequence: **the phone does all per-frame vision and emits a thin stream of detection records; the Pi only drives light and runs the final solve.** No video is streamed over Wi-Fi.

---

## 3. System architecture

```
 Raspberry Pi                          Phone (Android Chrome web app)
 ┌──────────────────────┐              ┌────────────────────────────┐
 │ LED driver / pattern  │  coded light │ Camera + IMU (WebXR)        │
 │ clock  ───────────────┼────► LEDs ──►│  pose, frame, intrinsics    │
 │                      │   (fixture)  │            │                 │
 │ Web server (WS)  ◄────┼──────────────┼──► CV pipeline              │
 │  control + clock sync │   Wi-Fi      │  detect · track · decode    │
 └─────────┬────────────┘              └────────────┬───────────────┘
           │ buffered detection records  ◄──────────┘
           ▼
 ┌──────────────────────┐     per-LED xyz   ┌──────────────────┐
 │ Reconstruction        │ ────────────────► │ 3D map (JSON/CSV) │
 │  triangulate + BA     │                   └──────────────────┘
 └──────────────────────┘
```

**Process/runtime model:**

- The Pi runs two long-lived processes: the **pattern driver** (M1, real-time priority, owns the SPI bus and the pattern clock) and the **web server** (M2, FastAPI/uvicorn). They communicate over a local Unix domain socket / shared memory for low-latency control and to read the pattern-clock epoch. Reconstruction (M3) is invoked by the server as a subprocess/job after a capture ends.
- The phone runs the web app: a WebXR render loop (M5) drives the CV pipeline (M6) each frame; the net layer (M7) batches detection records and streams them over WebSocket; the UI (M8) gives the user live coverage guidance.

**Coordinate frame:** All poses and outputs are in the **WebXR session reference space** (`local` or `local-floor`): right-handed, +Y up, meters, origin fixed where the session started. The origin is arbitrary but consistent within a capture. Re-anchoring to a fixture-local frame is a post-processing convenience, not required for MVP.

---

## 4. Technology choices (opinionated; pin latest stable at repo init)

| Concern                   | Choice                                                                                                                          | Rationale                                                                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi OS                     | Raspberry Pi OS (64-bit), Pi 4 or Pi 5                                                                                          | Pi 5 GPIO block differs; we avoid bit-banged WS281x and use SPI, which is stable across both.                                                                                                                                                       |
| LED type (MVP)            | **SK9822 / APA102 (DotStar)** driven over hardware **SPI** (`spidev`)                                                           | Separate clock line → deterministic, jitter-tolerant timing. The temporal code's reliability depends on clean transitions; this is the lowest-risk path. WS2812B is supported as a later option but its single-wire timing is jittery on a busy Pi. |
| LED driver (upgrade path) | Offload pattern rendering to an **RP2040 (Pico)** over USB serial                                                               | Hard real-time pattern clock decoupled from OS scheduling. Designed as a drop-in behind the M1 interface; not required for MVP.                                                                                                                     |
| Pi server                 | **Python + FastAPI + uvicorn**, `websockets`                                                                                    | Same language as reconstruction → one toolchain on the Pi.                                                                                                                                                                                          |
| Reconstruction            | **Python + NumPy + SciPy + OpenCV** (`scipy.optimize.least_squares`, sparse Jacobian)                                           | Standard, debuggable, runs offline on the Pi. `pyceres`/`g2o` is an optional later swap behind the M3 interface.                                                                                                                                    |
| AP / provisioning         | `hostapd` + `dnsmasq` for AP mode, `avahi` (mDNS, `ledmapper.local`)                                                            | Zero-config field use.                                                                                                                                                                                                                              |
| Phone app language        | **TypeScript**, bundled with **Vite**                                                                                           | Type safety against the shared protocol; fast dev loop.                                                                                                                                                                                             |
| WebXR + render loop       | **Three.js** (WebXR manager)                                                                                                    | Mature WebXR session/pose handling; the camera-access texture integrates with its WebGL context.                                                                                                                                                    |
| Camera frames             | **WebXR Raw Camera Access** (`camera-access` feature)                                                                           | Synced pose + frame + intrinsics from one source. See §5.                                                                                                                                                                                           |
| On-device CV              | **WebGL** threshold + connected-components pass (GPU), JS for tracking/decoding; **OpenCV.js** only if needed for later iOS PnP | Thresholding bright blobs is cheap and GPU-friendly; avoids loading heavy WASM on the hot path.                                                                                                                                                     |
| Phone↔Pi transport       | **WebSocket**, JSON messages (§7)                                                                                               | Simple, low volume (detection records are tiny). A packed binary variant is a later optimization behind the same message names.                                                                                                                     |

**Versioning note for agents:** Do not invent exact version numbers. At repo initialization, pin the latest stable release of each dependency in `requirements.txt` / `package.json` and record the pinned versions in `/docs/decisions.md`.

---

## 5. Android capture path (WebXR), with the iOS seam

On Android Chrome, request an `immersive-ar` session with required feature `camera-access` (and `local-floor` reference space; fall back to `local`).

Per animation frame:

- **Pose:** from `XRView.transform` (camera pose in the reference space) for the single view.
- **Frame image:** create `const binding = new XRWebGLBinding(session, gl)` once; each frame call `binding.getCameraImage(view.camera)` to get a `WebGLTexture`. The image dimensions come from `view.camera.width / height`.
- **Intrinsics (K = fx, fy, cx, cy):** derive from `XRView.projectionMatrix` together with the camera image dimensions. Provide a single utility `projectionMatrixToIntrinsics(projMatrix, imgW, imgH)` in M5 and unit-test it against known values.

**Exposure / white balance:** lock them if the platform exposes controls, otherwise instruct the user (in the UI) to map in a dimmed room so the LEDs are the brightest objects in frame. Stable blob brightness matters more than absolute correctness.

**The iOS seam (do not implement now, but design to it):** M5 exposes a `CaptureSource` interface (§6, M5). The Android implementation is `WebXRCaptureSource`. A future iOS implementation (`MediaStreamCaptureSource`) will satisfy the same interface using `getUserMedia` for frames, the Generic Sensor API for IMU, and an ArUco board for per-frame pose + metric scale. **Nothing downstream of M5 knows or cares which source produced a frame** — the detection record (§7.4) already carries `pose` and `K`, so the source is fully abstracted.

---

## 6. Module breakdown

Each module is independently buildable. "Interface" is the contract other modules depend on.

### M10 — `shared/protocol` (build first)

**Responsibility:** Single source of truth for all wire formats: WebSocket messages (§7.1–7.3), the detection record (§7.4), the output map (§7.5), and the code-book parameters (§7.6).
**Deliverable:** JSON Schema files + generated **TypeScript types** (for the web app) + **Pydantic models** (for the Pi). A small codegen script regenerates both from the schemas.
**Acceptance:** A round-trip test serializes and deserializes one example of every message type in both languages without loss.

### M9 — `shared/simulator` (build first, alongside M10)

**Responsibility:** Generate synthetic ground truth to validate the math and the CV without hardware.
**Two output modes:**

1. **Detection-log mode:** given a fixture (list of true LED xyz) and a virtual camera path, emit a stream of detection records (§7.4) directly — feeds M3.
2. **Frame mode:** render synthetic camera frames (project the LEDs, apply the temporal code per frame, add blob blur) plus matching per-frame pose + K — feeds M5/M6.
   **Configurable degradations:** pose noise, pixel noise, blob blur radius, rolling-shutter row delay, dropped-frame probability, occlusion, reflection/phantom blobs.
   **Built-in fixtures:** straight line, planar grid, cube, helix, and a loader for a real fixture's measured coordinates.
   **Acceptance:** Re-running with a fixed seed is deterministic; a zero-noise detection log reconstructs to < 1 mm RMS through M3.

### M1 — `pi/led_driver`

**Responsibility:** Render the coded blink pattern to the LEDs over SPI at a precise cadence; own the pattern clock.
**Behavior:** Runs a continuous **Gray-code cycle** (§8.1). Each frame is held for `bit_period_ms`. Records a monotonic `pattern_clock_epoch` (the Pi-clock time of the start of a known cycle) and the cadence, readable by M2.
**Debug modes:** light a single LED by index; light all; run a slow human-visible cycle.
**Interface (local, to M2):** `start(code_params) -> pattern_clock_epoch`, `stop()`, `set_debug(mode, args)`, `get_clock() -> {epoch, bit_period_ms, cycle_len}`.
**Acceptance:** On a real strip, a logic analyzer (or a high-FPS camera) confirms the bit cadence is within ±10% of `bit_period_ms` and the sync delimiter is correctly emitted each cycle.

### M2 — `pi/server`

**Responsibility:** Serve the web app, run the WebSocket control plane, manage capture sessions, ingest detection records to a store, trigger reconstruction, serve results.
**Endpoints:** static file serving for the built web app; `GET /healthz`; `WS /ws` (all control + data, §7); `GET /maps/{id}` (JSON), `GET /maps/{id}.csv`.
**State:** one active capture session at a time (MVP). Persist detection records to a session log on disk (so a capture can be re-reconstructed offline and used as a test fixture).
**Interface:** the WebSocket message contract (§7). Plus an internal call to M3: `reconstruct(session_log_path) -> map`.
**Acceptance:** Phone connects from the Pi AP, clock sync round-trips, a recorded detection session persists to disk and is reconstructable via the M3 CLI.

### M3 — `pi/reconstruction`

**Responsibility:** Turn a set of detection records into a 3D map.
**Pipeline:** group records by `led_id` → per-LED **linear DLT triangulation** for an initial point → **global bundle adjustment** (§8.3) with Huber loss, refining points (and optionally poses) → outlier rejection → compute per-LED quality (view count, RMS reprojection px, parallax angle) → export map (§7.5).
**Interface:** library API `reconstruct(records, options) -> Map`, and a CLI `python -m reconstruction <session_log.json> -o <map.json>` so it runs standalone on simulator output or recorded sessions.
**Acceptance:** Meets the synthetic-accuracy thresholds (§9, Phase 2) and the bench thresholds (§9, Phase 4).

### M4 — `pi/provisioning`

**Responsibility:** Make a fresh Pi field-ready. Scripts + systemd units to: enable SPI, install the two services, configure AP mode (`hostapd`/`dnsmasq`) and mDNS (`avahi`), and bring everything up on boot.
**Acceptance:** A clean Pi image, after running `provision.sh`, boots into an AP named e.g. `ledmapper`, and `http://ledmapper.local` serves the app.

### M5 — `web/src/xr` (capture)

**Responsibility:** Own the WebXR session and render loop; expose each frame as `{ texture, pose, K, imgW, imgH, tCaptureMs }`.
**Interface:**

```ts
interface CaptureSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(cb: (f: CaptureFrame) => void): void; // called once per rAF/XR frame
}
interface CaptureFrame {
  texture: WebGLTexture; // raw camera image for this frame
  pose: { p: [number, number, number]; q: [number, number, number, number] }; // ref-space
  K: [number, number, number, number]; // fx, fy, cx, cy
  imgW: number;
  imgH: number;
  tCaptureMs: number; // phone monotonic clock at capture
}
```

Android implementation: `WebXRCaptureSource`. (iOS `MediaStreamCaptureSource` later.)
**Acceptance:** On a target Android device, logs a stream of frames with plausible pose deltas and a `projectionMatrixToIntrinsics` unit test passing against fixtures.

### M6 — `web/src/cv` (detect · track · decode)

**Responsibility:** Per frame: detect bright-blob centroids; track blobs across frames; decode each track's temporal code into an `led_id`; emit detection records.
**Sub-stages:**

- **Detect:** WebGL threshold pass on the camera texture → connected components → sub-pixel centroids + brightness. (Keep this GPU-side; read back only centroids.)
- **Track:** nearest-neighbor / Hungarian assignment between consecutive frames, bridged with optical-flow prediction, to maintain stable track IDs through camera motion.
- **Decode:** for each track, sample its on/off state per bit window relative to the code-book (§7.6) and the synced clock (§8.2); on completing a cycle, assign `led_id` (Gray decode) with a confidence from bit margins.
  **Interface:** `onDetections(cb: (records: DetectionRecord[]) => void)`. Consumes `CaptureFrame`s and the `CodeParams` from M10.
  **Acceptance:** On simulator frame-mode output (Phase 3): decode accuracy ≥ 98% of visible LEDs at nominal noise, centroid pixel error ≤ 1.0 px RMS.

### M7 — `web/src/net`

**Responsibility:** WebSocket client; clock sync (SNTP-style, §8.2); batch and stream detection records; relay control + status.
**Interface:** `connect(url)`, `syncClock() -> {offsetMs, rttMs}`, `startMapping(opts)`, `stopMapping()`, `sendDetections(batch)`, event callbacks for `status` and `resultReady`.
**Acceptance:** Clock offset estimate stable to within a few ms over a 60s session on the Pi AP; detection batches delivered with no loss across a simulated reconnect.

### M8 — `web/src/ui`

**Responsibility:** Session flow + live guidance. Show detected/identified LED count, per-LED coverage, and **steer the user to walk an arc** (parallax) rather than straight at the fixture; flag LEDs still seen from too narrow a cone; start/stop; show result preview.
**Acceptance:** A first-time user can complete a bench capture following only on-screen guidance.

---

## 7. Data contracts (`shared/protocol`)

All times in milliseconds. Vectors are JSON arrays. Quaternions are `[x, y, z, w]`. This section is normative; M10 encodes it as schemas.

### 7.1 Client → server messages

```jsonc
{ "type": "hello", "client": "android-web", "appVersion": "..." }
{ "type": "time_sync_ping", "t0": 123456.7 }                  // phone clock
{ "type": "start_mapping", "options": { "ledCount": 1024 } }
{ "type": "stop_mapping" }
{ "type": "detections", "batch": [ /* DetectionRecord, §7.4 */ ] }
{ "type": "get_status" }
```

### 7.2 Server → client messages

```jsonc
{ "type": "welcome", "sessionId": "uuid", "codeParams": { /* §7.6 */ } }
{ "type": "time_sync_pong", "t0": 123456.7, "t1": 988.1, "t2": 988.3 } // t1,t2 = server clock at recv/send
{ "type": "mapping_started", "patternClockEpoch": 988.5, "codeParams": { /* §7.6 */ } }
{ "type": "status", "identified": 812, "total": 1024, "lowParallax": 37 }
{ "type": "result_ready", "mapId": "uuid" }
{ "type": "error", "code": "string", "message": "string" }
```

### 7.3 Clock sync

SNTP-style: client sends `time_sync_ping{t0}`, server replies `time_sync_pong{t0,t1,t2}`, client computes
`offset = ((t1 - t0) + (t2 - t3)) / 2`, `rtt = (t3 - t0) - (t2 - t1)`, where `t3` is the client receive time. Repeat a few times, keep the min-RTT sample. This aligns the phone's `tCaptureMs` to the Pi's `patternClockEpoch` well enough that the decoder can map a frame time to a bit index (§8.2). Self-clocking codes (sync delimiter) tolerate residual skew.

### 7.4 DetectionRecord (the core contract)

```jsonc
{
  "ledId": 412,
  "tCaptureMs": 123456.8, // phone clock
  "u": 980.5,
  "v": 540.2, // raw pixel centroid (origin top-left)
  "imgW": 1920,
  "imgH": 1080,
  "K": [1450.2, 1451.0, 959.5, 539.7], // fx, fy, cx, cy for this frame
  "pose": { "p": [0.21, 1.05, -0.83], "q": [0.0, 0.38, 0.0, 0.92] }, // ref-space camera pose
  "confidence": 0.87 // [0,1], from bit margins + blob quality
}
```

Batched as `detections.batch`. The source (WebXR vs future iOS) is invisible here by design.

### 7.5 Output map

```jsonc
{
  "mapId": "uuid",
  "createdAt": "ISO-8601",
  "units": "meters",
  "frame": "webxr_session_ref",
  "ledCount": 1024,
  "leds": [
    {
      "id": 0,
      "xyz": [0.1, 1.2, -0.55],
      "confidence": 0.93,
      "nViews": 34,
      "rmsReprojPx": 0.6,
      "parallaxDeg": 22.4
    }
    // ... one per identified LED; missing ids listed in `unmapped`
  ],
  "unmapped": [128, 129, 700],
  "stats": { "rmsReprojPxGlobal": 0.7, "medianParallaxDeg": 19.0 }
}
```

Also exported as CSV (`id,x,y,z,confidence,n_views`). Provide adapters (post-MVP) for WLED 2D/3D JSON, xLights, and FastLED coordinate arrays — keep them in `pi/reconstruction/export/` so they don't pollute the core.

### 7.6 CodeParams (code-book)

```jsonc
{
  "ledCount": 1024,
  "bits": 10, // ceil(log2(ledCount))
  "encoding": "gray",
  "bitPeriodMs": 100, // hold time per bit frame
  "syncPattern": "on_off", // delimiter: one all-on frame then one all-off frame
  "cycleFrames": 12 // syncFrames(2) + bits(10)
}
```

---

## 8. Key algorithms

### 8.1 Temporal identification (Gray-code cycle)

Run a continuously repeating cycle:

```
[ ALL_ON ][ ALL_OFF ]   ( sync delimiter )
[ bit 0  ][ bit 1 ] ... [ bit B-1 ]      ( LED i is on iff bit b of gray(i) is set )
```

- `B = ceil(log2(ledCount))`.
- Gray coding so a single misread bit mislabels to an **adjacent** index, not a random one.
- The sync delimiter makes the code **self-clocking**: the decoder can re-align after dropped frames or clock skew by finding the all-on→all-off transition.
- **Timing budget:** keep `bitPeriodMs` ≥ ~3 camera frame intervals (≈ 100 ms at 30 fps) so the whole frame — despite rolling shutter — sees one consistent bit state. Trade-off: longer bit periods ⇒ user must walk slower. At `bitPeriodMs=100, B=10`, a cycle is ~1.2 s; over a 90 s walk the user yields ~70 labeled observation sets per visible LED.

**Decode note (important):** because the camera moves _during_ a cycle, the per-bit observations must be associated to the same physical blob before decoding. That is the job of the **track** stage (M6): maintain a stable track through the cycle, sample its on/off state per bit window, then Gray-decode. Slower walking and a clean sync delimiter make this robust.

### 8.2 Mapping a frame to a bit index

Given a frame captured at phone time `tCaptureMs`, convert to Pi time using the clock offset (§7.3): `tPi = tCaptureMs + offset`. Then `phase = (tPi - patternClockEpoch) mod (cycleFrames * bitPeriodMs)`, and `bitIndex = floor(phase / bitPeriodMs)`. The sync delimiter is used to correct integer drift each cycle rather than trusting the offset blindly.

### 8.3 Reconstruction

Per LED, collect all `(pose, K, u, v)` observations.

1. **Initialize** each 3D point by linear DLT triangulation from its observation rays (camera center + back-projected pixel direction). Need ≥ 2 observations with adequate parallax; defer LEDs that don't yet have it.
2. **Bundle adjustment:** minimize total reprojection error
   `min Σ_i Σ_j ρ( || π(K_j, R_j, t_j, X_i) − x_ij || )`
   over LED points `X_i` (and optionally camera poses `R_j, t_j` if WebXR drift is significant), where `π` is the pinhole projection, `x_ij` the observed pixel, and `ρ` the **Huber** robust loss. Use `scipy.optimize.least_squares` with a **sparse Jacobian** (the problem is bipartite: each residual touches one point and one pose).
3. **Outlier rejection:** drop observations with residual above a robust threshold (reflections, decode errors), then re-solve.
4. **Quality per LED:** `nViews`, `rmsReprojPx`, `parallaxDeg` (max angle between any two observation rays). Low parallax ⇒ low confidence; surface it.

**Scale:** WebXR poses are already metric, so no external scale reference is needed on Android. (The iOS path will fix scale with the ArUco board.)

---

## 9. Build plan (phased; each phase has a testable artifact)

> Dependencies are listed per phase. A phase's modules can be worked in parallel by separate agents once dependencies pass.

**Phase 0 — Skeleton & contracts.** Deps: none.
Build M10 (protocol + codegen) and M4 (provisioning enough to serve a page). Stub M2 to serve a "hello" web app; M5/M7 enough to open WebXR and round-trip a WebSocket + clock sync.
_Acceptance:_ Phone loads the app from the Pi AP; WebSocket connects; clock offset is estimated and stable.

**Phase 1 — LED driver.** Deps: Phase 0.
Build M1: real Gray-code cycle on a real strip; debug single-LED mode.
_Acceptance:_ Logic-analyzer/high-FPS-camera confirms cadence within ±10% and correct sync delimiter each cycle.

**Phase 2 — Reconstruction on synthetic logs (no hardware, no phone).** Deps: M10.
Build M9 (detection-log mode) + M3.
_Acceptance:_ Zero-noise log → < 1 mm RMS. At nominal noise (define in `decisions.md`, e.g. 0.5 px pixel noise, 1° pose noise, arc walk), RMS ≤ 1% of fixture span and ≥ 99% of LEDs solved.

**Phase 3 — CV pipeline on synthetic frames.** Deps: M9 (frame mode), M10.
Build M6 (and the parts of M5 that decode a provided texture).
_Acceptance:_ On synthetic frames at nominal noise, decode accuracy ≥ 98% of visible LEDs, centroid pixel error ≤ 1.0 px RMS, robust to injected dropped frames and rolling-shutter delay.

**Phase 4 — End-to-end on bench.** Deps: Phases 1–3, M2, M5, M7, M8.
Real Android phone + real LEDs + the bench golden fixture (§8.3 / §10.3).
_Acceptance:_ Bench RMS ≤ 2% of longest dimension; ≥ 95% identified; collinearity/coplanarity checks pass.

**Phase 5 — Robustness & UX.** Deps: Phase 4.
Coverage guidance (M8), exposure handling, outlier-rejection tuning, export adapters, and the stress matrix (§10.6).
_Acceptance:_ Stress matrix passes with documented bounds; a naive user completes a capture unaided.

---

## 10. Testing & validation

Layered, cheapest-and-most-diagnostic first. The simulator (M9) is the backbone; build it first and keep it green.

**10.1 Synthetic ground truth (primary).** M9 renders known fixtures + virtual walks with injectable degradations, fed through the exact production pipeline. Produces error-vs-noise curves and is the regression suite. Used in Phases 2 and 3.

**10.2 Unit tests on the seams.** Decoder: known bit sequences with injected flips → verify Gray tolerance and sync recovery. Triangulator: synthetic rays with a known intersection + noise → residuals and convergence. `projectionMatrixToIntrinsics` against known matrices. All deterministic, run in CI.

**10.3 Bench validation against measured truth.** One small "golden fixture": LEDs at caliper-measured positions on a board (and a second cube/line/panel jig). Report RMS error in mm and as % of fixture size. Plus **shape-consistency checks that need no absolute reference** (collinear stays collinear; coplanar stays coplanar; a measured inter-LED distance validates scale).

**10.4 Internal cross-checks on every real run.** Surface BA per-LED reprojection residuals. **Hold-out validation:** triangulate from a subset of frames, predict each LED's pixel in held-out frames, measure reprojection error on unseen views. Report index completeness and per-LED confidence so untrustworthy LEDs are flagged, not silently shipped.

**10.5 Reference comparison.** For a static capture, reconstruct the same LEDs with COLMAP (LEDs as features) and compare; for a planar fixture, compare against a known-good 2D mapper. Spot-check anchor LEDs by hand.

**10.6 Stress & repeatability matrix (Phase 5).** Map the same fixture repeatedly → per-LED variance (precision, distinct from accuracy). Then vary, each with a pass criterion: bright vs dark room; reflective/mirrored surfaces (verify phantom rejection); partial occlusion; fast vs slow walking; dropped Wi-Fi/reconnect; long-capture thermal throttling.

---

## 11. Repository layout

```
/pi
  /led_driver        # M1
  /server            # M2  (serves built web app from /web/dist)
  /reconstruction    # M3  (library + CLI + export/ adapters)
  /provisioning      # M4  (scripts, systemd units, hostapd/dnsmasq/avahi config)
/web
  /src/xr            # M5  (CaptureSource, WebXRCaptureSource, intrinsics util)
  /src/cv            # M6  (detect/track/decode)
  /src/net           # M7  (WebSocket, clock sync, batching)
  /src/ui            # M8  (session flow, coverage guidance)
/shared
  /protocol          # M10 (JSON Schema + codegen → TS types + Pydantic models)
  /simulator         # M9  (detection-log mode + frame mode, fixtures, degradations)
/tests               # cross-module + integration tests, recorded sessions
/docs
  decisions.md       # decision log: pinned versions, chosen noise params, thresholds
  runbook.md         # how to flash a Pi, run a capture, re-reconstruct a session
```

---

## 12. Configuration defaults (tune in `decisions.md`)

| Param                  | Default                | Notes                                                     |
| ---------------------- | ---------------------- | --------------------------------------------------------- |
| `ledCount`             | 1024                   | MVP ceiling.                                              |
| `bitPeriodMs`          | 100                    | ≥ ~3 frame intervals at 30 fps; raise if decode is noisy. |
| `encoding`             | gray                   |                                                           |
| `syncPattern`          | on_off                 | self-clocking delimiter.                                  |
| Walk pattern           | arc around fixture     | UI enforces parallax; straight-on walks are rejected.     |
| Capture length         | ≤ 120 s                |                                                           |
| Huber delta            | ~1–2 px                | reprojection robust threshold.                            |
| Outlier reject         | residual > 3× robust σ | re-solve after dropping.                                  |
| Min parallax to accept | ~5°                    | below this, LED is flagged low-confidence.                |

---

## 13. Risks & open questions

- **WebXR camera-access support varies by device/Android/Chrome version.** Verify on the actual target devices early (Phase 0). If a target device lacks `camera-access`, it is unsupported for MVP — fail clearly, don't degrade silently.
- **Intrinsics from the projection matrix** may be approximate on some devices. Validate against a one-time checkerboard calibration on at least one target device; if error is material, add an optional calibration step.
- **Blob merging at distance:** adjacent LEDs blur into one blob, capping density. Detect this (multiple expected ids resolving to one track) and tell the user to get closer or map in sections.
- **Pose drift over a long walk:** if WebXR VIO drifts, enable pose refinement in BA (§8.3 step 2) and/or shorten captures. Consider an ArUco anchor even on Android as a drift check.
- **LED timing on a busy Pi:** mitigated by SPI + a real-time-priority driver process; if jitter still hurts decode, move to the RP2040 offload behind the M1 interface.
- **Power:** the fixture's LED power supply and level/logic wiring are out of software scope but must be specified in `runbook.md` before bench testing.

---

## 14. Deferred (designed-for, not built)

- **iOS capture** via `MediaStreamCaptureSource` (getUserMedia + Generic Sensor API IMU + ArUco board for pose & scale), satisfying the M5 `CaptureSource` interface. No downstream changes required.
- RP2040 LED-driver offload (M1 interface already accommodates it).
- WLED / xLights / FastLED export adapters (stubs live in `pi/reconstruction/export/`).
- Multi-phone simultaneous capture; live re-mapping.
