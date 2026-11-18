# Blob-detection optimization playbook

Written 2026-07-17, after the first clean 64/64 solve (session
`1784272462556`). This is a "revisit later" plan: what we know, the hard
constraints, the tool to build, and the ranked avenues — each with the metric
to watch so a change can be judged, not guessed.

## Baseline (where we are)

Locking the camera exposure to the Nyquist-capped sweet spot
(`?exposure=servo`, capped at `bitPeriodMs/2`, see `cv/exposure.ts`
`planExposureServo` + `xr/exposureControl.ts`) transformed detection:

| metric (per frame, 64-LED strip) | before (bloom/banding) | now (exposure servo)                   |
| -------------------------------- | ---------------------- | -------------------------------------- |
| blobs / frame (median)           | ~120                   | **66** (≈ 64)                          |
| chroma spread (cr..cb)           | ~0.44                  | **0.70** (vividly decodable)           |
| blob satFrac (clipping)          | p90 0.66               | **0.15**                               |
| solve                            | "No LEDs solved"       | **64/64, matches the physical layout** |

Detection is now _good_. Two residual problems remain, both visible in the
success trace:

1. **~2 extra blobs** (66 vs 64) — residual bloom-halo fragments / speckle.
2. **Neighbor confusion** — the one LED that solved into a gap. In
   `1784272462556`: **24.7 % of blobs have a neighbour within 15 px**, nearest-
   neighbour distance p10 = 8 px / median = 22 px, while a blob's effective
   radius is only ~4.5 px (p90 8.4 px). So the closest pairs overlap, and the
   tracker's association gate (`cv/tracker.ts` `gatePx = 60`) is **~3× the
   inter-LED spacing** — a track can grab a neighbour's blob, so one LED never
   accumulates its own decode (the gap) and its neighbour's position is pulled.

## Hard constraints (do not regress)

- **Frame rate is sacred.** This is the sharpest lesson from the two latest
  traces. Both had the SAME detection quality (66 blobs, chroma 0.70), but:

  - `1784272462556` (no frame capture): **30 fps** (33 ms/frame) → 64/64.
  - `1784272339037` (frame capture on): **8.7 fps** (114 ms/frame, p90 208 ms)
    → unreliable, no clean solve.

  Decoding needs several camera samples per pattern frame. At `bitPeriodMs`
  90–110 and `cycleFrames` 8 a full cycle is ~0.7–0.9 s; 30 fps gives ~3
  samples/frame, 8.7 fps gives <1 → the self-clocking decoder can't read the
  sequence. **Any detector change that costs fps is a net loss.** The current
  `?frames=1` path pays this because `DetectorGL.grabFrame` (full-res
  `readPixels`) + gzip run on the capture thread — see "capture without the fps
  hit" below.

- **Exposure ≤ `bitPeriodMs/2`** (Nyquist — a longer exposure integrates across
  a hue transition and blurs the code). Enforced in `planExposure`.
- **Don't over-dim / over-shorten** — banding (WS2812 PWM × rolling shutter)
  returns and re-fragments every LED.

## The tool to build first: offline replay harness

We can now capture the detector's byte-exact input (`?frames=1` →
`frames/<seq>.rgba.gz`) alongside the LIVE blobs (`frames.jsonl`) and IMU. Build
a harness (`//web:offline_pipeline`, next to `//web:offline_decode`) that
re-runs the whole CV stack on captured frames:

```text
raw frame → detectCpu (mirror of the detect.ts threshold/downsample shader)
          → connectedComponents (ccl.ts, unchanged)
          → Tracker → Decoder (pipeline.ts, unchanged)
```

Why: every avenue below can then be A/B'd offline against real frames, with **no
re-capture and no fps penalty**. Two freebies fall out:

- **Fidelity check:** the offline detector on a captured frame must reproduce
  the live blobs at the same params. If it doesn't, the CPU mirror is wrong.
- **Ground-truth-ish:** a clean 64/64 capture's decoded map is a reference to
  score detector changes against (position RMS, decode yield).

Per-param-set metrics to emit: blobs/frame vs ledCount, nearest-neighbour merge
rate, decode yield (unique IDs / ledCount), and position RMS vs the reference
solve.

## Avenues, ranked

### 1. Neighbour separation — the gap you saw (highest value)

Symptom: LEDs 8–15 px apart merge into one blob or the tracker mis-associates.

- **a. Detection resolution.** `DetectorGL.downscale` is 2 (detect at 640×360).
  Try 1.5 or 1 so close LEDs separate before CCL. Cost is CPU/readback at
  detection-res (not full-res) — measure the fps hit; it must stay 30 fps.
  Metric: does p10 NN distance grow past a blob diameter (splits the merges)?
- **b. Split merged neighbours.** `splitOversized` (ccl.ts) only fires above
  `maxArea` — in the trace `splitFrac = 0`, so merged-neighbour blobs (small,
  under maxArea) are NOT being split. Add a **local-maxima / watershed** split:
  a blob with two intensity peaks a blob-diameter apart is two LEDs. Metric:
  merged-pair rate; blobs/frame → 64 without dropping decode yield.
- **c. Tracker gate + appearance.** `gatePx = 60` ≫ the 22 px spacing. Either
  tighten it toward the inter-LED distance (watch for lost tracks under fast
  motion — the gate is around the _predicted_ position, so it interacts with
  the coasting model), or better, **add hue to the association cost** so a
  track prefers the blob matching its colour and won't steal a differently-hued
  neighbour even inside the gate. Metric: track-swap rate; count of LEDs that
  never decode (the gaps).
- **d. Decoder confidence near neighbours.** When two tracks are within a
  blob-diameter, require a higher decode margin before committing an ID, so a
  neighbour's code isn't assigned during an ambiguous frame.

### 2. Residual over-detection (66 → 64)

The extra ~2 blobs are bloom-halo fragments / gray speckle (they carry little
chroma; real LEDs sit at chroma ~0.70). Levers, cheapest first: nudge
`minArea` up; **chroma-gate** (drop near-gray blobs — an LED carries hue, a
bloom fragment/noise doesn't); or a morphological open. Metric: blobs/frame →
64 while decode yield stays 64/64 (don't cull real LEDs).

### 3. Servo & robustness margins

- The exposure servo converges but oscillates ±1 step around the sweet spot.
  Add a deadband or EMA on the signals to cut applyConstraints churn.
- symbols=4 worked with chroma margin 0.70 — comfortable headroom; leave it,
  but the offline harness can confirm the per-symbol margins.

## Capture WITHOUT the fps hit (unblocks continuous tuning)

Today you must choose: a good solve (frames off) OR offline data (frames on,
but 8.7 fps ruins that run's decode). Close the gap so every capture is a
tuning dataset:

- Move `grabFrame` off the hot path with an **async PBO readback**
  (`PIXEL_PACK_BUFFER` + fence) instead of the synchronous `readPixels`.
- Move gzip into a **Web Worker** (transfer the RGBA `ArrayBuffer`, zero-copy),
  so the capture thread only does the readback kick-off.
- Target: `?frames=1` holds ~30 fps. Then a single `?exposure=servo&frames=1`
  run yields both a clean solve and the frames to tune against.

## Suggested order of work

1. Fix frame capture fps (async readback + worker gzip) — so tuning data and a
   good solve come from one capture.
2. Build the offline replay harness + metrics.
3. Attack avenue 1 (neighbour separation) — it's the observed failure.
4. Then avenue 2 (trim 66→64) and 3 (servo polish).
5. Promote a change only if, on the captured frames, it keeps 64/64 and, live,
   holds 30 fps.
