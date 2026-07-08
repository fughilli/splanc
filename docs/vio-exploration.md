# Eliminating WebXR: joint pose + LED optimization with IMU dead reckoning

**Branch:** `vio-joint-solve` · **Status:** exploration (2026-07-08) ·
**Prototype:** `pi/reconstruction/reconstruction/vio.py` (+ `vio_test`)

## 1. Why: WebXR pose is degenerate in our operating conditions

The whole M3 pipeline treats the WebXR pose as ground truth: §7.4 records pair
each 2D LED observation with the frame's pose, and bundle adjustment holds
poses FIXED, optimizing only LED positions. That was the design's biggest
leverage (no SLAM of our own) and is now its biggest liability: ARCore's
tracker needs a feature-rich, photometrically stable scene, and our operating
point — dim room, a large emissive screen, specular reflections of the
pattern off the screen glass and nearby surfaces, code-correlated lighting —
is nearly adversarial. The reflections are as bright as the direct scene, and
they MOVE with the pattern, so the tracker's static-world assumption breaks.

Quantified on the 2026-07-08 `?record=1` trace (16-LED wall, 41 s, 1 230
frames, gray-hue @ 110 ms bits):

| metric | value | healthy |
|---|---|---|
| corr(pose speed, median image blob shift) | **−0.002** | ≳ 0.7 |
| largest single-frame position jump | **2.28 m** (51 m/s) | ≪ 5 cm |
| claimed path length vs net displacement | **13.2 m vs 0.51 m** | ratio ≈ walk shape |
| frames with >30 cm jumps | 5 | 0 |

The pose stream and the image stream are fully decoupled: the tracker is
hallucinating motion (drift + relocalization snaps). Every back-projected ray
inherits this, so triangulations are geometrically consistent nonsense —
tighter decoding (SEC-DED) cannot help and doesn't need to; the 2D
observations themselves are fine.

## 2. The reframe: LEDs are the map — solve for the trajectory too

We were using WebXR because generic SLAM needs generic features. But our
scene contains something better: **hundreds of point landmarks whose data
association is SOLVED BY CONSTRUCTION** — the blink code labels every
observation with its LED id (and, post-SEC-DED, mislabels are corrected or
rejected). This is the textbook structure-from-motion setting with known
correspondences, which is dramatically easier than SLAM:

- No feature extraction/matching/outlier machinery over the scene — the
  scene's photometric hostility (reflections, darkness) stops mattering.
  Reflections that decode ARE rejected upstream (dedup/consensus), and rays
  they contribute are outliers the robust loss handles.
- The observation graph is dense: every LED is seen from many poses, every
  pose sees many LEDs — exactly the well-conditioned BA regime.

What monocular observations alone cannot give: **metric scale** (the gauge
freedom is 7-DOF: similarity), **gravity direction**, and bridging over
stretches where too few LEDs are visible. That's precisely what the IMU
buys:

- **Accelerometer** measures specific force = a − g: gravity direction →
  levels the map; metric scale → real accelerations tie image motion to
  meters (standard VI observability: scale is observable given non-constant
  acceleration, which a handheld walk provides).
- **Gyroscope** gives high-rate relative rotation — the dead-reckoning
  backbone between camera frames and the rotation part of initialization.

So the target formulation is classic visual-inertial bundle adjustment where
the ONLY visual landmarks are the LEDs:

```
min over {T_i, v_i, b_a, b_g, X_j, g}   of
  Σ_obs ρ( π(T_i, X_j) − u_ij )                 reprojection (robust)
+ Σ_i  ‖ preint(imu_i→i+1; b_a, b_g) ⊖ (T_i, v_i, T_i+1, v_i+1, g) ‖_Σ    IMU factors
+ bias random-walk priors
```

with `T_i` keyframe poses, `v_i` velocities, `X_j` LED positions, `g` shared
gravity, `b_*` IMU biases, and `preint` Forster-style IMU preintegration
between consecutive keyframes.

## 3. Platform: what replaces each WebXR ingredient

| WebXR gave us | Replacement | Notes |
|---|---|---|
| camera texture | `getUserMedia` rear camera → same GL detect pass | works in ANY browser (no `#webxr-incubations` flag, no ARCore dependency — a portability WIN); still HTTPS |
| pose | **solved** (this work) | live preview needs the incremental solve (§6) |
| intrinsics (from projectionMatrix) | unknowns in the solve (shared fx=fy, cx,cy≈center prior) or one-time calibration from a solved session | wall sessions strongly constrain K; prototype supports fixed-K and K-refinement |
| timestamps | `requestVideoFrameCallback` gives per-frame capture timestamps | same clock domain as DeviceMotion events |
| (nothing) | `DeviceMotionEvent` accel+gyro @ ~60 Hz | Android Chrome: no permission prompt; iOS: needs a gesture-gated permission — fine, we're Android-first |

The M5 `CaptureSource` seam was designed for exactly this swap: a
`MediaStreamCaptureSource` implements the same interface, minus trusted pose
(the frame's `pose` field becomes the solver's OUTPUT, not its input).

## 4. Estimator design (what the prototype implements)

**State.** Keyframe poses `(R_i, p_i)` + velocities `v_i` at camera frame
times (30 Hz — no keyframe selection needed at our durations), LED positions
`X_j`, accelerometer/gyro biases (constant per session in the prototype),
gravity vector `g` (unit-norm constrained via 2-DOF parameterization).

**IMU preintegration.** Standard discrete preintegration of gyro/accel
between consecutive keyframes (ΔR, Δv, Δp with right-Jacobian bias
linearization is deferred; the prototype re-preintegrates on bias updates —
simpler, fine offline).

**Initialization** (the part WebXR used to hand us for free):
1. **Attitude**: integrate gyro for relative rotations; anchor roll/pitch
   with the accelerometer average over low-motion windows (gravity).
2. **Two-view seed**: pick two frames with ≥8 shared decoded LEDs and wide
   baseline-by-time; essential matrix from the (id-matched!) 2D↔2D pairs
   (normalized 8-point + RANSAC), decompose → relative pose up to scale,
   triangulate the shared LEDs.
3. **PnP chain**: for each remaining frame, P3P/EPnP (DLT-based) against the
   current LED estimates; triangulate newly-seen LEDs as they decode.
4. **Scale/gravity alignment**: least-squares fit of the visual trajectory
   to the preintegrated IMU deltas → metric scale s, gravity g, initial
   velocities (Martinelli/VINS-Mono-style linear init).
5. **Full VI-BA** (§2's objective) from that seed.

**Solver.** `scipy.least_squares` (sparse Jacobian, Huber) for the
prototype; the batched-LM trick from `bundle.py` doesn't apply directly
(poses couple everything), but the problem is small (≈ 1.2 k poses × 9 +
N_led × 3 + 8 ≈ 12 k unknowns for a 40 s session) and offline latency is
not the constraint yet. Live/incremental solving is a later phase (sliding
window over the last ~2 s + marginalization, or just re-run every 2 s at
live-solve decimation sizes — measured before chosen).

**Gauge.** 4 remaining gauge freedoms after IMU (global position + yaw):
fixed by pinning pose 0's position and yaw. Output map is then metric and
gravity-leveled — strictly MORE useful than today's arbitrary WebXR session
frame (§7.5 `frame` gains a `gravity_leveled` variant when this ships).

## 5. Risks / open questions the prototype probes

- **Phone IMU quality + browser event rate.** 60 Hz DeviceMotion with ~ms
  jitter vs 200 Hz native: preintegration noise grows; the dense visual
  factors should dominate. Probed synthetically: noise/bias/rate set to
  pessimistic web-platform values (60 Hz, 0.05 m/s² & 0.002 rad/s noise,
  bias walk), plus timestamp jitter.
- **Rolling shutter**: already partially handled by the latency-corrected
  pose pairing at decode; under joint solving, per-observation time offsets
  can be modeled later if residuals demand it.
- **Camera intrinsics unknown**: probed by solving with a 5 %-wrong K and
  letting BA refine fx/cx/cy.
- **Long dark gaps** (all LEDs out of frame): IMU-only bridging drifts
  quadratically; acceptable over ≤2 s gaps, needs coverage guidance
  otherwise (HUD already nags).
- **Decode-latency alignment**: the self-clocked `alignShift` maps blob
  timestamps onto IMU time; same-clock domain (`performance.now`) makes
  this a constant-offset problem we already estimate.

## 6. Staged plan

> Status 2026-07-08: phases 1–3 are DONE and the phase-3 gate PASSED — see
> §7b. Next up: phase 4 (`MediaStreamCaptureSource` + first-class IMU
> protocol + server-side production solve + PnP-based live feedback).

1. **[this branch] Offline prototype + synthetic acceptance** — `vio.py`:
   preintegration, SfM init chain, VI-BA; synthetic generator with
   web-pessimistic IMU noise and WebXR-style corrupt poses as a control.
   Acceptance: ≤5 mm map RMS and ≤2 % scale error on a synthetic 64-LED
   wall walk, where the CURRENT pose-trusting solver fails on the same data.
2. **IMU-annotated real traces** — `?record=1` now also streams
   DeviceMotion samples (this branch, landed) so the next phone session
   captures solver-ready real data while still running WebXR side-by-side
   (WebXR pose recorded but only for comparison).
3. **Offline solve of a real trace** — decode the recorded blob stream
   offline (the TS decoder logic ported/reused server-side, or re-emitted
   records), run `vio.py`, compare against the wall ground truth. Go/no-go
   for on-device work.
4. **`MediaStreamCaptureSource`** — getUserMedia + rVFC capture path, XR
   code behind a fallback flag; live solve moves server-side incremental.
5. **Retire WebXR** once phase 3–4 hit wall-truth parity (~1.5 mm rms).

## 7. Prototype results (2026-07-08)

`pi/reconstruction/tests/test_vio.py` (`bazelisk test
//pi/reconstruction:vio_test`), synthetic 36-LED wall, 12 s walk with real
acceleration content, 8 Hz keyframes, 60 Hz IMU with web-pessimistic noise
(σ_gyro 0.002 rad/s, σ_accel 0.05 m/s², constant biases 0.002 rad/s /
0.04 m/s², 1.5 ms timestamp jitter), 0.3 px pixel noise, 5 % dropped
observations, **no pose input**:

| | map RMS vs truth | scale error | gravity dir | reproj RMS |
|---|---|---|---|---|
| **VIO joint solve** | **0.24 mm** | **0.54 %** | **0.04°** | 0.30 px |
| pose-trusting solver + WebXR-drift poses (control) | 145 mm | — | — | — |

The control feeds the SAME observations to the production solver paired with
poses corrupted to the real trace's statistics (8 mm/frame random walk +
relocalization jumps + rotation walk) — a 600× map-quality gap. Also probed
en route: the leading-span preintegration bug class (dropping the
t0→first-sample segment produced a systematic 13 % scale bias — fixed, and
the kind of thing the acceptance test exists to catch).

Solver wall time: ~15 s for the 12 s session (97 keyframes, unoptimized
scipy prototype, finite-difference Jacobian with sparsity groups). Plenty of
headroom for the final solve; live/incremental needs the §6 phase-4 work.

## 7b. FIRST REAL-DATA SOLVE (2026-07-08) — phase-3 gate PASSED

Tooling (both landed): `bazelisk run //web:offline_decode -- frames.jsonl
decoded.json` replays a `?record=1` trace through the CANONICAL M6
tracker/decoder (no reimplementation — 188 records, 16/16 ids, 7 971 dense
labeled samples over 537 frames on the 18 s capture), then
`bazelisk run //pi/reconstruction:vio_replay -- frames.jsonl decoded.json`
joins the trace's DeviceMotion stream and runs `solve_vio`.

On the 2026-07-08 16-LED capture — the one with the measured 4.65°/6.2 cm
WebXR frame drift and the IMU-disproven 3.7 cm relocalization snap — scored
on §1 shape consistency (planar grid wall, no absolute truth needed):

| | reproj rms | plane rms | pitch spread | pitch p50 |
|---|---|---|---|---|
| **VIO joint solve (no pose input)** | **1.17 px** | **0.2 mm** | **0.3 %** | 39.5 mm |
| pose-trusting solver, WebXR poses | 16.0 px | 3.2 mm | 2.5 % | 40.3 mm |

Gravity solved to 9.81 m/s², gyro bias ~1e-4 rad/s, accel bias 0.075 m/s²,
trajectory length 1.18 m/18 s (physically plausible; WebXR claimed 13 m on
the earlier capture). The two solutions agree on pitch within 2 % — i.e. the
accelerometer-derived metric scale independently matches WebXR's.

**Field lesson: don't trust DeviceMotion axis names.** The first solve
collapsed because this device/Chrome delivers `rotationRate` with
alpha/beta/gamma being the camera-frame x/y/z rates directly, NOT the W3C
reading (alpha=z, beta=x, gamma=y). `vio_replay --diagnose` now fits the
gyro+accel axis mapping from the trace itself against the WebXR attitudes
(48 signed permutations; winner 0.0097 rad / 0.5 s window, 4× ahead) — run
it once per new device until the mapping is negotiated/calibrated properly
in phase 4.

## 8. Phase 4 — the WebXR-free capture path (landed 2026-07-08)

Everything needed to run a capture with NO WebXR is now in the tree:

- **Protocol**: `imu_batch` client message (camera-frame rad/s + m/s²
  samples; the CLIENT applies its device axis mapping — `web/src/xr/imu.ts`,
  `?imumap=` override until a calibration flow exists);
  `DetectionRecord.pose` is nullable; `OutputMap.frame` gained
  `gravity_leveled` (the VIO gauge: metric, level by construction).
- **Client**: `MediaStreamCaptureSource` (getUserMedia rear camera +
  requestVideoFrameCallback + GL texture upload; `pose: null` frames;
  detector runs flipV=false — video uploads are top-down, XR textures are
  bottom-up). `?noxr=1` forces the path; devices without camera-access AR
  fall back to it AUTOMATICALLY — the app now runs on any phone browser, no
  Chrome flag, no ARCore. The pipeline emits DENSE records (one per
  identified blob every 3rd frame, brightest-per-id dedup) instead of
  per-cycle anchors — the joint solver wants every sighting. DeviceMotion
  streams as ~1 s `imu_batch`es. Live feedback degrades to the 2D blob/id
  overlay + the live-map inset (exact 3D registration needs client-side PnP
  against the solved map — the phase-4.5 follow-up).
- **Server**: sessions store the IMU stream (log key `imu`); the final AND
  live reconstructions dispatch on record shape — pose-less + IMU →
  `reconstruction.vio_api.reconstruct_vio` (gravity-leveled OutputMap, live
  solves bounded to 60 keyframes / 40 evals), posed → the classic solver
  (which now rejects pose-less records loudly).
- **Intrinsics**: no projectionMatrix on this path. K seed priority:
  `?fx=` → cached calibration (the XR path now caches its reported K in
  localStorage — devices that ever ran WebXR are calibrated) → 70°-FOV
  heuristic. **Measured observability finding** (vio_test): in wall-facing
  walks fx trades ~1:1 against METRIC SCALE and barely affects shape — an
  8 % fx error ⇒ 1.7 mm shape rms but ~9 % scale error. So an uncalibrated
  first run yields a correct-shaped, slightly mis-scaled map;
  `refine_intrinsics` exists as polish, and real metric accuracy comes from
  the calibration cache (or a known-pitch wall). Capture guidance should
  still include closer/farther motion.

**Deferred (phase 4.5+):** client-side PnP live registration; per-device
IMU-mapping auto-calibration (today: default mapping + `?imumap=`,
diagnosed via `vio_replay --diagnose`); warm-started incremental live VIO;
camera↔IMU extrinsic + rolling-shutter modeling if bench residuals demand.

**Next experiment (phase 5 gate):** side-by-side wall captures — XR path vs
`?noxr=1` — in the lit room, the dark room, and the reflective setup that
breaks ARCore; compare Δtruth. The no-XR path must match the 1.5 mm
best-case and win where WebXR degrades.

## 9. Final-solve performance fix (2026-07-08, post first no-XR capture)

The first real no-XR capture (32 LEDs, 38 s, 5 532 dense records, 3 026 IMU
samples) took ~4 minutes at stop_mapping. Profiled on the actual session log
(`vio_replay --session-log --profile`): **80 % of the time was preintegration
being recomputed 538 802 times** — once per interval per residual evaluation,
though it only depends on the 6 bias parameters — and most of the rest was
the pure-Python reprojection loop over 5.5 k observations.

Fixes (numerics unchanged — pinned by the untouched vio_test asserts):
- vectorized reprojection residuals + batched Rodrigues (`so3_exp_batch` /
  `so3_log_batch`);
- IMU samples pre-bucketed per interval once (bisect, not linear scans);
- **bias-linearized preintegration cache** (Forster-style, numerically
  derived): integrate once per reference bias + a 6-column numeric bias
  Jacobian; finite-difference bias perturbations are answered by the
  first-order correction, so Jacobian passes never re-integrate;
- IMU residual block fully batched.

Same session: **205.8 s → 9.9 s (21×)**, byte-identical map (reproj rms
14.38 px both). vio_test suite: 766 s → 16.6 s. Live interim solves benefit
identically. Note: the 14 px rms on this capture is converged (400 evals:
14.28 px) — it is outlier mass in the dense record stream riding the robust
loss, not misconvergence; a MAD-prune + re-solve pass (as in the classic
solver) is the follow-up if map quality demands it.
