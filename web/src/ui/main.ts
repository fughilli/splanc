/**
 * M8 — capture app session flow (design doc §6 M8):
 *
 *   connect → clock sync → [user taps Start] → immersive-ar w/ camera-access
 *   → per-frame detect/track/decode → stream detections → live HUD guidance
 *   → [Stop] → server reconstructs → result preview + downloads.
 *
 * Everything heavy lives in M5/M6/M7; this file is orchestration + DOM.
 */

import type { CodeParams, DetectionRecord, Encoding, LedEntry, OutputMap } from "@ledmapper/protocol";
import {
  adjustThreshold,
  ExposureMonitor,
  planEncodingSwitch,
  planReconfigure,
  recommendConfig,
} from "../cv/exposure";
import { CvPipeline } from "../cv/pipeline";
import { DetectorGL } from "../cv/detect";
import { mul4 } from "../geom/mat4";
import { defaultWsUrl, LedMapperClient } from "../net/client";
import { DEFAULT_IMU_MAPPING, ImuRecorder, parseImuMapping } from "../xr/imu";
import { MediaStreamCaptureSource } from "../xr/mediaStreamCapture";
import { WebXRCaptureSource, XrUnsupportedError } from "../xr/webxrCapture";
import { LabelOverlay } from "./labels";
import { MapView } from "./mapview";
import { MarkerRenderer } from "./markers";
import { SolvedMarkerRenderer } from "./points3d";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const ledCountInput = $<HTMLInputElement>("ledcount");
const connEl = $("conn");
const errEl = $("err");
const hudStats = $("hud-stats");
const hudGuide = $("hud-guide");
const resultSection = $("result");
const setupSection = $("setup");

const qs = new URLSearchParams(location.search);
const wsUrl = qs.get("url") ?? defaultWsUrl();
// ?threshold= forces a fixed detector threshold (disables the blob-count
// servo); unset, the base is 0.6 and adapts to the measured conditions.
const forcedThreshold = qs.get("threshold") !== null;
const detectorOpts = {
  threshold: numParam("threshold", 0.6),
  downscale: numParam("downscale", 2),
  // Camera texture arrives bottom-up on-device (see DetectorOptions.flipV);
  // ?flipv=0 reverts should another device differ.
  flipV: qs.get("flipv") !== "0",
};
// WebXR-free capture mode (docs/vio-exploration.md phase 4): ?noxr=1 forces
// the getUserMedia + IMU path; it is also the automatic fallback when the
// device can't do WebXR camera-access. ?imumap= overrides the DeviceMotion
// axis mapping (see xr/imu.ts); ?fx= forces the focal-length seed.
const forceNoXr = qs.get("noxr") === "1";
const imuMapping = parseImuMapping(qs.get("imumap") ?? "") ?? DEFAULT_IMU_MAPPING;
const forcedFx = ((): number | null => {
  const v = parseFloat(qs.get("fx") ?? "");
  return Number.isFinite(v) && v > 0 ? v : null;
})();
/** K observed by a previous WebXR session on this device — the best focal
 * calibration available to the no-XR path (fx error ⇒ metric-scale error). */
const K_CACHE_KEY = "ledmapper.calibratedK";

// Capture auto-negotiation overrides (cv/exposure.ts picks these from the
// measured scene by default): ?encoding=gray|gray-hue, ?bitms=N.
const forcedEncoding = ((): Encoding | null => {
  const v = qs.get("encoding");
  return v === "gray" || v === "gray-hue" ? v : null;
})();
const forcedBitMs = ((): number | null => {
  const v = parseFloat(qs.get("bitms") ?? "");
  return Number.isFinite(v) && v > 0 ? v : null;
})();
// Debug: also draw raw detector blobs (2D, aspect-fill approximation). The
// default view shows only SOLVED LEDs, 3D-composited to overlap the real ones.
const showBlobs = qs.get("blobs") === "1";
// Debug: stream the raw per-frame blob field to the server (JSONL under the
// session dir) so the CV stage's actual input can be inspected offline.
const recordBlobs = qs.get("record") === "1";

// Ground truth for the map views: `?truth=COLSxROWS` declares the wall's grid
// (row-major, matching /wall.html's layout — the wall status bar shows its
// cols×rows). Truth is pitch-normalized; the view aligns it to the solve with
// a similarity fit and draws per-point delta vectors + magnitudes.
function gridTruth(spec: string | null, ledCount: number): { id: number; xyz: [number, number, number] }[] | null {
  const m = spec === null ? null : /^(\d+)x(\d+)$/i.exec(spec);
  if (m === null) return null;
  const cols = parseInt(m[1]!, 10);
  const rows = parseInt(m[2]!, 10);
  if (cols < 1 || rows < 1) return null;
  const pts = [];
  for (let id = 0; id < Math.min(ledCount, cols * rows); id++) {
    pts.push({ id, xyz: [id % cols, Math.floor(id / cols), 0] as [number, number, number] });
  }
  return pts;
}
const truthSpec = qs.get("truth");

/** Wall-published exact layout (GET /truth), falling back to ?truth=CxR. */
async function fetchTruth(ledCount: number): Promise<{ id: number; xyz: [number, number, number] }[] | null> {
  try {
    const resp = await fetch("/truth");
    if (resp.ok) {
      const gt = (await resp.json()) as { leds?: { id: number; xyz: [number, number, number] }[] };
      // Guard against stale/oversized truth (e.g. a wall that re-published
      // its idle default layout): only ids this capture actually mapped.
      const leds = (gt.leds ?? []).filter((l) => l.id < ledCount);
      if (leds.length >= 3) return leds;
    }
  } catch {
    // fall through to the manual spec
  }
  return gridTruth(truthSpec, ledCount);
}

function numParam(name: string, dflt: number): number {
  const v = qs.get(name);
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

const client = new LedMapperClient(wsUrl);
let mapView: MapView | null = null;
let capture: WebXRCaptureSource | MediaStreamCaptureSource | null = null;
let capturing = false;
let imuRecorder: ImuRecorder | null = null;
let previewVideo: HTMLVideoElement | null = null;

// Live (in-capture) solver feedback: solved LEDs 3D-composited over the
// camera view (markers + id labels) + a small converging-map inset.
const labels = new LabelOverlay($<HTMLCanvasElement>("labels"));
const liveCanvas = $<HTMLCanvasElement>("livemap");
let liveView: MapView | null = null;
let liveLeds: readonly LedEntry[] = [];
let liveSolvedText = "";

function setError(message: string, hints: string[] = []): void {
  errEl.innerHTML = "";
  if (!message) return;
  errEl.append(message);
  if (hints.length > 0) {
    const ul = document.createElement("ul");
    for (const h of hints) {
      const li = document.createElement("li");
      li.textContent = h;
      ul.append(li);
    }
    errEl.append(ul);
  }
}

function setConn(text: string): void {
  connEl.textContent = text;
}

// -- boot: connect + sync ----------------------------------------------------

client.events = {
  onConnected: () => setConn(`connected to ${wsUrl}`),
  onDisconnected: () => setConn("disconnected — retrying…"),
  onServerError: (code, msg) => setError(`server error ${code}: ${msg}`),
};

async function boot(): Promise<void> {
  startBtn.disabled = true;
  try {
    const welcome = await client.connect();
    ledCountInput.value = String(
      parseInt(qs.get("leds") ?? "", 10) || welcome.codeParams.ledCount,
    );
    const sync = await client.syncClock();
    setConn(
      `connected · clock offset ${sync.offsetMs.toFixed(1)} ms (rtt ${sync.rttMs.toFixed(1)} ms)`,
    );
    startBtn.disabled = false;
  } catch {
    setConn("connection failed — retrying…");
    // client auto-reconnects; enable start once connected.
    const enable = setInterval(() => {
      if (client.isConnected) {
        startBtn.disabled = false;
        clearInterval(enable);
        void client.syncClock().catch(() => undefined);
      }
    }, 500);
  }
}
void boot();

// -- capture -----------------------------------------------------------------

startBtn.addEventListener("click", () => void startCapture());
stopBtn.addEventListener("click", () => void stopCapture());
$<HTMLButtonElement>("again").addEventListener("click", () => {
  resultSection.style.display = "none";
  setupSection.style.display = "";
  mapView?.stop();
});

function resetLiveFeedback(): void {
  liveView?.stop();
  liveView = null;
  liveLeds = [];
  liveSolvedText = "";
  liveCanvas.style.display = "none";
  labels.clear();
}

async function startCapture(): Promise<void> {
  setError("");
  resetLiveFeedback();
  const ledCount = Math.max(1, parseInt(ledCountInput.value, 10) || 64);
  startBtn.disabled = true;
  try {
    // Order matters: the camera/XR session needs a user gesture, so create it
    // first; start_mapping only once the camera is actually up. WebXR is
    // attempted unless ?noxr=1; devices without camera-access AR fall back to
    // the getUserMedia + IMU path automatically (the server then solves poses
    // jointly — docs/vio-exploration.md phase 4).
    let usingXr = !forceNoXr;
    if (usingXr) {
      try {
        capture = new WebXRCaptureSource($("overlay"));
        await capture.start();
      } catch (e) {
        if (!(e instanceof XrUnsupportedError)) throw e;
        usingXr = false;
        setConn("WebXR unavailable — using camera + IMU capture (poses solved server-side)");
      }
    }
    if (!usingXr) {
      const cached = ((): { k: [number, number, number, number]; imgW: number; imgH: number } | undefined => {
        try {
          const raw = localStorage.getItem(K_CACHE_KEY);
          return raw ? JSON.parse(raw) : undefined;
        } catch {
          return undefined;
        }
      })();
      const ms = new MediaStreamCaptureSource({
        kSeed: cached,
        fxOverride: forcedFx ?? undefined,
      });
      capture = ms;
      await capture.start();
      // Fullscreen live preview behind the (dom-overlay styled) HUD.
      ms.video.style.cssText =
        "position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:0;background:#000";
      document.body.prepend(ms.video);
      previewVideo = ms.video;
      // Inertial stream: the whole reason this path can skip WebXR.
      imuRecorder = new ImuRecorder(imuMapping);
      imuRecorder.start();
    }

    // Camera texture row order differs between the two paths (XR delivers
    // bottom-up, video uploads top-down); an explicit ?flipv= always wins.
    const flipV = qs.get("flipv") !== null ? qs.get("flipv") !== "0" : usingXr;
    const detector = new DetectorGL(capture!.gl, { ...detectorOpts, flipV });
    const markers = showBlobs && usingXr ? new MarkerRenderer(capture!.gl) : null;
    const solvedMarkers = usingXr ? new SolvedMarkerRenderer(capture!.gl) : null;

    // -- Pre-capture probe: measure the scene BEFORE the pattern runs, then
    // negotiate the capture configuration (§7.1 start_mapping options). The
    // client owns this choice — it is the only party that can see the light.
    const monitor = new ExposureMonitor();
    let lastAmbient: number | null = null;
    document.body.classList.add("in-xr");
    hudGuide.textContent = "Measuring light…";
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, 2500); // frames stopped? negotiate on defaults
      let t0 = -1;
      capture!.onFrame((f) => {
        if (t0 < 0) t0 = f.tCaptureMs;
        const blobs = detector.detect(f.texture, f.imgW, f.imgH);
        monitor.push({
          tMs: f.tCaptureMs,
          blobCount: blobs.length,
          scene: detector.measure(f.texture, f.imgW, f.imgH),
        });
        lastAmbient = f.ambientIntensity ?? lastAmbient;
        if (f.tCaptureMs - t0 >= 1200) {
          clearTimeout(deadline);
          resolve();
        }
      });
    });
    const probed = monitor.snapshot();
    const recommended = probed
      ? recommendConfig({ frameIntervalMs: probed.frameIntervalMs, meanLuma: probed.scene.meanLuma })
      : null;
    const config = {
      ...(forcedEncoding !== null
        ? { encoding: forcedEncoding }
        : recommended !== null
          ? { encoding: recommended.encoding }
          : {}),
      ...(forcedBitMs !== null
        ? { bitPeriodMs: forcedBitMs }
        : recommended !== null
          ? { bitPeriodMs: recommended.bitPeriodMs }
          : {}),
    };

    // Re-sync the clock right before the epoch matters.
    await client.syncClock(4);
    const started = await client.startMapping(ledCount, config);

    // The pattern params/epoch (and the pipeline decoding against them) are
    // MUTABLE for the rest of the capture: a mid-capture configure rebinds
    // all three. Detections already sent stay valid — they are (ledId, pixel,
    // pose) records, independent of the signaling that produced them.
    let params: CodeParams = started.codeParams;
    let epoch: number = started.patternClockEpoch;
    const makePipeline = (p: CodeParams, e: number): CvPipeline => {
      // No-XR path: dense per-frame records (pose: null) — the server's
      // joint solver wants every sighting, not per-cycle anchors.
      const pl = new CvPipeline(p, e, (t) => client.clock.toServerTime(t), {
        denseRecords: !usingXr,
      });
      pl.onDetections((records: DetectionRecord[]) => {
        client.sendDetections(records);
      });
      return pl;
    };
    let pipeline = makePipeline(params, epoch);
    hudGuide.textContent = `code: ${params.encoding} @ ${params.bitPeriodMs} ms/bit`;

    capturing = true;
    let frameCount = 0;

    // ?record=1 frame recorder: batches of raw detector output (+ IMU).
    let frameBuf: unknown[] = [];
    let imuBuf: unknown[] = [];
    const postFrames = (body: object): void => {
      void fetch("/debug/frames", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => undefined);
    };
    if (recordBlobs) {
      postFrames({
        reset: true,
        epoch,
        codeParams: params,
        // IMU stream metadata (VIO exploration, docs/vio-exploration.md):
        // raw DeviceMotion values, no client-side conversion. rotationRate
        // alpha/beta/gamma are deg/s about the device z/x/y axes;
        // accelerationIncludingGravity is the specific force in m/s² in the
        // device frame (x right, y toward the top edge, z out of the screen).
        // t is performance.now() at event delivery; tEvent the event stamp.
        imuFormat: { rotationRate: "deg/s (alpha=z,beta=x,gamma=y)", accel: "m/s^2 specific force, device frame" },
      });
      // Record DeviceMotion for the offline joint pose+LED solver. Attach
      // inside the Start gesture (iOS gates motion access on one); Android
      // Chrome delivers ~60 Hz with no prompt.
      const onMotion = (e: DeviceMotionEvent): void => {
        if (!capturing) {
          window.removeEventListener("devicemotion", onMotion);
          return;
        }
        const rr = e.rotationRate;
        const ag = e.accelerationIncludingGravity;
        if (!rr || !ag) return;
        imuBuf.push({
          t: performance.now(),
          tEvent: e.timeStamp,
          rotationRate: { alpha: rr.alpha, beta: rr.beta, gamma: rr.gamma },
          accel: { x: ag.x, y: ag.y, z: ag.z },
        });
      };
      const dme = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
      if (typeof dme.requestPermission === "function") {
        dme
          .requestPermission()
          .then((st) => {
            if (st === "granted") window.addEventListener("devicemotion", onMotion);
          })
          .catch(() => undefined);
      } else {
        window.addEventListener("devicemotion", onMotion);
      }
    }

    // XR sessions report true intrinsics — cache them as this device's focal
    // calibration for future no-XR captures (fx error ⇒ metric-scale error).
    let cachedK = false;

    capture!.onFrame((f) => {
      if (!capturing || !capture) return;
      if (usingXr && !cachedK) {
        cachedK = true;
        try {
          localStorage.setItem(K_CACHE_KEY, JSON.stringify({ k: f.K, imgW: f.imgW, imgH: f.imgH }));
        } catch {
          // storage full/blocked: the calibration cache is best-effort
        }
      }
      const blobs = detector.detect(f.texture, f.imgW, f.imgH);
      // Exposure monitoring: blob count every frame, the (cheap but not free)
      // unthresholded scene readback on a subsample — AE moves at ~1 Hz.
      monitor.push({
        tMs: f.tCaptureMs,
        blobCount: blobs.length,
        scene: frameCount % 6 === 0 ? detector.measure(f.texture, f.imgW, f.imgH) : undefined,
      });
      lastAmbient = f.ambientIntensity ?? lastAmbient;
      if (recordBlobs) {
        frameBuf.push({
          t: f.tCaptureMs,
          tServer: client.clock.toServerTime(f.tCaptureMs),
          pose: f.pose,
          K: f.K,
          imgW: f.imgW,
          imgH: f.imgH,
          blobs,
        });
        if (frameBuf.length >= 30) {
          const batch = frameBuf;
          const imuBatch = imuBuf;
          frameBuf = [];
          imuBuf = [];
          postFrames({ frames: batch, imu: imuBatch });
        }
      }
      pipeline.step(blobs, {
        tCaptureMs: f.tCaptureMs,
        pose: f.pose,
        K: f.K,
        imgW: f.imgW,
        imgH: f.imgH,
      });

      if (usingXr && solvedMarkers !== null) {
        // Feedback into the XR layer: solved LEDs, 3D-composited through the
        // frame's real view/projection so markers overlap the physical LEDs.
        const gl = capture.gl;
        const fb = capture.layerFramebuffer;
        const vp = f.viewport;
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.viewport(vp.x, vp.y, vp.width, vp.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const mvp = mul4(f.projMatrix, f.viewMatrix);
        solvedMarkers.draw(mvp);
        markers?.draw(blobs, f.imgW, f.imgH, vp.width, vp.height, [0.2, 1, 0.6, 0.85]);
        labels.draw(liveLeds, mvp, pipeline.lastBlobStatus, f.imgW, f.imgH);
      } else {
        // No pose, no 3D compositing: the 2D blob/id overlay still gives full
        // detection+decode feedback over the video preview, and the live map
        // inset shows the server's joint solve converging. (Client-side PnP
        // against the solved map — restoring exact registration — is the
        // phase-4.5 follow-up in docs/vio-exploration.md.)
        labels.draw([], null, pipeline.lastBlobStatus, f.imgW, f.imgH);
      }

      if (++frameCount % 15 === 0) {
        const s = pipeline.stats;
        hudStats.textContent =
          `decoded ${s.uniqueIds.size}/${params.ledCount} ids · ${s.tracks} tracks · ` +
          `${blobs.length} blobs · align ${s.alignShiftMs.toFixed(0)} ms · ` +
          `${client.pendingBatchCount} unsent${liveSolvedText}`;
      }
    });

    capture!.onEnd(() => {
      // Session ended outside our Stop button (system gesture) — still solve.
      if (capturing) void stopCapture(true);
    });

    // Server-side coverage poll for guidance (slow — it's advisory text).
    const statusPoll = setInterval(() => {
      if (!capturing) {
        clearInterval(statusPoll);
        return;
      }
      client
        .getStatus()
        .then((st) => {
          if (st.total > 0) {
            hudGuide.textContent =
              st.lowParallax > st.total / 4
                ? `Keep circling — ${st.lowParallax} LEDs seen from only one spot.`
                : `${st.identified}/${st.total} LEDs triangulable. Cover the rest of the arc.`;
          }
        })
        .catch(() => undefined);
    }, 2000);

    // Fast live-map poll — this drives the continuous solver (the server
    // kicks a fresh solve whenever a poll finds new detections and none is
    // in flight, so this cadence bounds the added display latency).
    const livePoll = setInterval(() => {
      if (!capturing) {
        clearInterval(livePoll);
        return;
      }
      client
        .getLiveMap()
        .then((lm) => {
          if (!capturing || lm.map === null) return;
          liveLeds = lm.map.leds;
          solvedMarkers?.setLeds(liveLeds);
          // Pose-corrected temporal inertia: identified tracks now coast by
          // reprojecting their solved 3D position through the frame pose.
          pipeline.updateSolved(liveLeds);
          liveSolvedText = ` · solved ${lm.map.leds.length}/${lm.map.ledCount}`;
          liveCanvas.style.display = "block";
          if (liveView === null) {
            const view = new MapView(liveCanvas, lm.map);
            liveView = view;
            void fetchTruth(lm.map.ledCount).then((t) => view.setTruth(t));
            view.start();
          } else {
            liveView.update(lm.map);
          }
        })
        .catch(() => undefined);
    }, 400);

    // No-XR path: stream the inertial batches the joint solver dead-reckons
    // with (~1 s cadence; ~60 samples per batch).
    if (imuRecorder !== null) {
      const rec = imuRecorder;
      const imuTick = setInterval(() => {
        if (!capturing) {
          clearInterval(imuTick);
          return;
        }
        client.sendImuBatch(rec.flush());
      }, 1000);
    }

    // -- Exposure telemetry + real-time adaptation (varying-light robustness).
    // Every tick: report the measured exposure state to the server (session
    // diagnostics), servo the detector threshold on the blob count, and check
    // whether the measured conditions have drifted far enough to renegotiate
    // the pattern (§7.1 configure). Renegotiation requires the SAME plan on
    // two consecutive ticks — one bad window (stall, occlusion) must not
    // restamp the pattern clock for everyone.
    let pendingBitPeriod: number | null = null;
    let pendingEncoding: Encoding | null = null;
    let renegotiating = false;
    const applyReconfigure = (opts: { bitPeriodMs?: number; encoding?: Encoding }): void => {
      renegotiating = true;
      client
        .configure(opts)
        .then((ps) => {
          if (!capturing || !ps.active || ps.patternClockEpoch === null) return;
          params = ps.codeParams;
          epoch = ps.patternClockEpoch;
          pipeline = makePipeline(params, epoch);
          pipeline.updateSolved(liveLeds);
          if (recordBlobs) postFrames({ reset: true, epoch, codeParams: params });
          hudGuide.textContent = `code renegotiated: ${params.encoding} @ ${params.bitPeriodMs} ms/bit`;
        })
        .catch(() => undefined)
        .finally(() => {
          renegotiating = false;
        });
    };
    const exposureTick = setInterval(() => {
      if (!capturing) {
        clearInterval(exposureTick);
        return;
      }
      const report = monitor.report(performance.now(), detector.threshold, lastAmbient);
      if (report === null) return;
      client.sendExposureReport(report);

      if (!forcedThreshold) {
        detector.threshold = adjustThreshold(detector.threshold, report.blobCount, ledCount);
      }
      if (renegotiating) return;

      // Signaling-rate renegotiation: fps sank (light dropped → longer
      // shutter) or recovered. Encoding switch: the room's light level
      // crossed the hysteresis band (lights toggled mid-walk).
      const wantBit = forcedBitMs === null ? planReconfigure(params.bitPeriodMs, report.frameIntervalMs) : null;
      const wantEnc = forcedEncoding === null ? planEncodingSwitch(params.encoding, report.meanLuma) : null;
      if (wantBit !== null && wantBit === pendingBitPeriod) {
        pendingBitPeriod = null;
        applyReconfigure({ bitPeriodMs: wantBit, ...(wantEnc !== null ? { encoding: wantEnc } : {}) });
      } else if (wantEnc !== null && wantEnc === pendingEncoding) {
        pendingEncoding = null;
        applyReconfigure({ encoding: wantEnc, ...(wantBit !== null ? { bitPeriodMs: wantBit } : {}) });
      } else {
        pendingBitPeriod = wantBit;
        pendingEncoding = wantEnc;
      }
    }, 2000);
  } catch (e) {
    capturing = false;
    document.body.classList.remove("in-xr");
    imuRecorder?.stop();
    imuRecorder = null;
    previewVideo?.remove();
    previewVideo = null;
    await capture?.stop().catch(() => undefined);
    capture = null;
    startBtn.disabled = false;
    if (e instanceof XrUnsupportedError) {
      setError(e.message, e.hints);
    } else {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
}

async function stopCapture(sessionAlreadyEnded = false): Promise<void> {
  if (!capturing) return;
  capturing = false;
  stopBtn.disabled = true;
  document.body.classList.remove("in-xr");
  imuRecorder?.stop();
  imuRecorder = null;
  previewVideo?.remove();
  previewVideo = null;
  if (!sessionAlreadyEnded) await capture?.stop().catch(() => undefined);
  capture = null;
  resetLiveFeedback();

  setConn("final solve…");
  try {
    const result = await client.stopMapping();
    const resp = await fetch(`/maps/${result.mapId}`);
    if (!resp.ok) throw new Error(`fetching map failed: HTTP ${resp.status}`);
    const map = (await resp.json()) as OutputMap;
    showResult(result.mapId, map);
    setConn(`map ${result.mapId} ready`);
  } catch (e) {
    setError(`Reconstruction failed: ${e instanceof Error ? e.message : e}`);
    setConn(client.isConnected ? "connected" : "disconnected");
  } finally {
    stopBtn.disabled = false;
    startBtn.disabled = false;
  }
}

function showResult(mapId: string, map: OutputMap): void {
  setupSection.style.display = "";
  resultSection.style.display = "";
  $<HTMLAnchorElement>("dl-json").href = `/maps/${mapId}`;
  $<HTMLAnchorElement>("dl-csv").href = `/maps/${mapId}.csv`;
  mapView?.stop();
  const view = new MapView($<HTMLCanvasElement>("mapcanvas"), map);
  mapView = view;
  void fetchTruth(map.ledCount).then((t) => view.setTruth(t));
  view.start();
}
