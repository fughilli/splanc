# Mapping solve paths: why a good preview could end in a degenerate map

Status: implemented (branch `agent/mapping-debug-bundles`).

The report: "I had a few failed captures where the successful capture was
clearly visible in the mid-capture solver preview, but went degenerate when
doing the final solve." No capture data from those runs survived, because
the app didn't log failed runs. This note compares the two solve paths,
names the root cause found on synthetic captures, and describes the fix and
the debug-mode capture bundles that make the next failure replayable.

## The two paths

Both paths run the same wasm build of `solver/` (`reconstruct_vio` in
`solver/src/pipeline.rs`) on the phone. On a Pi host the live map comes from
the host's own solver instead.

| | Interim (live preview) | Final (on Stop) |
|---|---|---|
| Caller | `LiveSolveScheduler` (`web/src/solver/liveSolve.ts`) every few seconds | `stopCapture` in `web/src/ui/screens/capture.ts` |
| Input | Every record so far (a growing prefix of the capture), held in the worker | Every record of the capture |
| Keyframes | `maxKeyframes: 120` (an even subsample of distinct frame times) | 250 |
| Optimizer budget | `maxNfev: 20` | 60, then up to three re-solves |
| Outlier rejection | Off | Up to 3 rounds (consensus + MAD), rolling back to the best-scoring round |
| Strip prior | Off | If enabled in settings |
| Initialization | Cold start: gyro-integrated rotations, linear ray init, then linear inertial alignment for scale + gravity | Cold start, the same way. Before this change it never used the interim states. |
| Inertial re-anchor | Once, after its BA | After every stage (initial, each outlier round, strip prior) |
| Precision | f64 everywhere | f64 everywhere |
| Gap handling | None. No data is discarded by time (#152/#250); gaps only loosen the IMU factor. | The same |

What doesn't differ: numeric precision (all f64), gap handling, and the
observations themselves (the final has a superset). For supplemental scans,
fusion and registration (`geom/fuseMaps`) run after the final solve and don't
affect it.

## Root cause: the cold start's scale sign

`solve_vio`'s cold start (`solver/src/vio.rs`) builds the camera path and LED
positions up to scale from the rays, then solves a linear least-squares
system (`inertial_alignment`) for the metric scale `s`, gravity and
velocities, and multiplies the visual init by `s`.

On a gentle capture (the phone barely moves) or a decode-swapped one (a few
percent of detections carry the wrong LED id, which the linear ray init
isn't robust to), that scale estimate is noise-dominated. It can come out at
or below zero. Applied as-is:

1. A negative `s` mirrors the whole init through the gauge camera, so every
   LED lands behind every camera.
2. The BA's behind-camera residual is a constant 50 px with zero gradient,
   so the optimizer can't climb out.
3. `reconstruct_vio` keeps only LEDs with views in front of the camera, so
   the map comes back empty (all residuals 50 px). A tiny positive `s`
   (cameras a few cm from the fixture) does the same.

The sign is a property of the exact record set. Each interim solve runs on a
different prefix and draws a different `s`. In a sweep of a gentle capture's
prefixes the cold-start scale went
`0.31, −0.10, 0.56, −0.33, 0.56, −0.79, −1.06` and the final drew `−0.88`.
The preview showed whichever solves came out positive (an empty interim just
leaves the previous overlay up). The final solve re-initializes from scratch
on all the data, so it threw away everything the preview had shown and drew
its own sign. That explains "preview right, final degenerate": the final
isn't worse than the interims in general, it just doesn't share their luck.

Reproductions (synthetic captures from `solver/src/scenario.rs`; seeds found
by sweeping):

- A gentle orbit (0.5 rad over 40 s, 2 cm bob), seeds 1, 8 and 9: the final
  cold-start scale is −1.18, −0.29 and −0.03, and the final map is empty.
  For seeds 8 and 9 the interim solve on the first half of the capture
  rendered the fixture correctly.
- A well-excited orbit with 3 % decode swaps, seed 3: scale −0.012, the
  final map is empty.

These are the regression tests in `solver/src/regression_tests.rs`.

### Other differences examined

- **Re-anchor applied after every stage.** It multiplies the geometry by
  `s_post` after the initial solve and again after each warm-started outlier
  round. On well-excited synthetic orbits those factors were consistently
  below 1 (0.93, then 0.86, then 0.96) while the BA pushed back between
  them, so the final size settles around 0.9 of true. An experiment
  re-anchoring only on the initial and last stage moved the median size from
  0.90 to 0.93, which is within noise. That's a modest size bias, not a
  degeneracy, so it's left as is and noted here.
- **The outlier loop's score** (`solved_led_count`, then −rms) can't see
  scale: reprojection is scale-invariant. It can't catch a collapse, which
  is one reason the assessment below exists.
- **Keyframe decimation** (120 vs 250), **the optimizer budget** and **the
  strip prior** changed sizes by a few percent in the sweeps, never the
  verdict.
- **Diffuse stride captures** (only one stride class lit per phase, 1–2 s of
  decode dead time per switch) solve fine as long as the bridge phases
  co-light anchors (`web/src/code/stride.ts`). Without bridges the classes
  are only IMU-linked and shapes go wrong in *both* paths.

## The fix

1. **Cold-start scale guard** (`vio::plausible_init_scale`, ported to the
   Python reference `pi/reconstruction/reconstruction/vio.py`). If the
   alignment's scale puts the cameras outside 5 cm to 30 m of the fixture
   (this includes `s ≤ 0` and NaN), the solver seeds an arm's-length prior
   instead (0.75 m), with finite-difference velocities. The BA and the
   inertial re-anchor then settle the metric scale, and the existing
   scale-uncertainty warning still fires when the IMU can't. The stage trace
   records `initScale` and `initScaleFallback`. `options.initScaleGuard:
   false` turns the guard off, for replaying a run the old way.
2. **The final solve warm-starts from the best interim.** The app keeps
   every interim solve's state (`diag.state`, the un-leveled VIO state) and
   passes the best one as `options.warmStart`. `reconstruct_vio` then runs
   the initial solve both cold and warm and continues from the better one:
   not degenerate first, then more solved LEDs, then lower residual
   (`diag::better`). The trace records both and which one won (`diag.start`).
   LEDs the interim never saw are triangulated under the warm-seeded poses.
   Seeding them at the origin would leave them stuck behind the gauge
   camera.
3. **The final is validated against the preview, with a fallback**
   (`web/src/solver/degeneracy.ts` `decideFinal`). If the final solve throws,
   comes out degenerate, keeps fewer than 60 % of the preview's measured
   LEDs, or collapses to a line or plane the preview didn't have, the run
   keeps the best preview map. The map then carries a warning that names
   the reasons, and the run outcome is `fallback-degenerate` or
   `fallback-failed`. A size or shape disagreement alone (more than 2× in
   spread, or an aligned shape error above 25 % of the spread) keeps the
   final but flags the run, because either side could be the wrong one.

### Degeneracy, precisely

`solver/src/diag.rs` (Rust, the solver's own verdict) and
`web/src/solver/degeneracy.ts` (the same verdict from an OutputMap alone):

| Reason | Condition |
|---|---|
| `non-finite` | A NaN or ∞ in any LED position, the residual or the trajectory |
| `too-few-leds` | Fewer than 4 measured LEDs (nViews > 0), or fewer than 25 % of the LEDs the capture saw in ≥ 2 distinct frames |
| `huge-residual` | Global reprojection rms > 20 px. The behind-camera penalty is 50 px, so this means most rays miss. |
| `scale-collapse` | Median camera-to-fixture distance < 0.15 m, or LED rms spread < 2 mm |
| `scale-blowup` | Median camera-to-fixture distance > 30 m |
| `scale-uncertain` (warning only) | Scale relative standard error > 0.5 |

Rank collapse is only judged relative to the preview: a straight strip is
legitimately rank 1. `collapsed-to-line` means the preview's 2nd/1st
principal ratio was ≥ 0.05 and the final's is < 0.005. `collapsed-to-plane`
applies the same test to the 3rd principal axis.

## Results on the synthetic sweep

Seven scenario families (well-excited orbit, gentle orbit, dwell-and-hop
diffuse, stride 3 with bridges and dead time, 3 % decode swaps, a planar
wall, a long gentle orbit), 4 seeds each. Each run did six interim solves
on growing prefixes with the live options, then the final solve. "Good"
means ≥ 80 % of the LEDs, size within 30 % of true and shape error under
10 mm, measured against ground truth.

| | Before | After |
|---|---|---|
| Final solve good | 23/28 | 26/28 |
| Final map empty or degenerate | 3/28: gentle seeds 1 and 2, swaps seed 3, all with 0 LEDs | 0/28 |
| Interim good at some point but final bad | 3/28 | 2/28 |
| Interim solves good (of 6 per run, summed) | 72/168 | 104/168 |

The two runs that are still "bad" after the fix are dwell-and-hop seeds 1
and 2. They place all 60 LEDs with under 1.1 mm shape error, but at 0.66 of
true size. That's the known dwell-heavy scale regime (Bug B, #259), not a
degeneracy, and it was the same before. The warm start won in 17 of the 28
runs. The interim column improved too, because the guard also protects the
interim cold starts: before the fix, decode-swap captures never rendered
in the preview at all.

## Capture bundles (debug mode)

With **Settings ▸ Behavior ▸ Developer ▸ Enable Debug Settings** on, every
run whose outcome isn't `ok` writes a bundle to IndexedDB
(`ledmapper-capturebundles`; the newest 20, up to 150 MB). "Keep successful
runs too" logs `ok` runs as well. **Settings ▸ Debugging ▸ Mapping capture
bundles** lists them with Export (one `.splanc-capture.json`) and Share (Web
Share). The format is described in `web/src/solver/captureBundle.ts`:

- The final solve's exact input
- The best interim plus the last three interims. Each one is a prefix
  (`recordCount`, `imuCount`) plus its options, so it replays exactly.
- The raw final output with the solver's stage trace and assessment
- The decision and its reasons
- Capture parameters, the fixture's firmware version, the solver version and
  the SHA-256 of the exact wasm build, and app and device info
- Downsampled camera frames, opt-in

Replay:

- `bazel run //solver:replay_bundle -- <file>` runs the wasm build, so the
  replay is bit-for-bit. It flags a bundle recorded by a different build.
  `--cold` drops the warm start, `--check` exits non-zero unless every solve
  reproduced, and `--record <problem.json> <out>` turns a bare problem (an
  iOS `session-*.json` log, `solver_cli --synth` output) into a bundle the
  way the app would.
- `solver_cli --replay <file>` runs natively and prints each stage's trace
  (frames, observations, solved LEDs, rms, re-anchor factor, cold-start
  scale, fallback, degeneracy). Native libm can differ from wasm in the last
  bit, so an unconverged solve can drift by about 0.1 mm here.
- `solver_cli --synth '<spec>'` prints a synthetic capture with its ground
  truth (`solver/src/scenario.rs`: fixture, motion, stride/dead time, decode
  swaps, noise).

Bit-for-bit means identical JSON in, identical doubles out. The solver has no
randomness or threads. serde_json's float parsing is deterministic but
best-effort, so the native replay slices each input out of the bundle's raw
text rather than re-serializing parsed values. The wasm replay serializes
with `JSON.stringify` exactly as the worker did.

## Still unverified

- **The user's captures.** No bundles from the failed runs exist; the app
  kept nothing from a failed run, only iOS `session-*.json` logs of final
  problems, and none came with the report. The root cause above comes from
  synthetic captures. The next failure with debug mode on is the check.
- **Hardware.** None of this has run on a phone yet: the wasm build, the
  worker's wasm fingerprint (it needs `crypto.subtle`, so a secure context),
  IndexedDB sizes, and the Share flow on iOS.
- **The size bias.** The re-anchor applied after every stage leaves sizes
  about 10 % small on synthetic orbits. That's separate from the
  degeneracy, so it's left for a follow-up.
