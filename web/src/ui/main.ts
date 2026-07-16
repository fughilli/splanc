/**
 * M8 — capture app session flow (design doc §6 M8):
 *
 *   connect → clock sync → [user taps Start] → getUserMedia camera + IMU
 *   → per-frame detect/track/decode → stream detections → live HUD guidance
 *   → [Stop] → final solve (phone wasm or host) → result preview + downloads.
 *
 * Everything heavy lives in M5/M6/M7; this file is orchestration + DOM.
 */

import type {
  CodeParams,
  DetectionRecord,
  ImuSample,
  LedEntry,
  OutputMap,
} from "@ledmapper/protocol";
import {
  adjustThreshold,
  blobPopulation,
  ExposureMonitor,
  planLedBrightness,
  planReconfigure,
  planSymbolSwitch,
  recommendConfig,
} from "../cv/exposure";
import { CvPipeline } from "../cv/pipeline";
import { DetectorGL } from "../cv/detect";
import { certApprovalUrl, defaultWsUrl, LedMapperClient } from "../net/client";
import {
  bleAvailable,
  provisionViaBle,
  requestImprovDevice,
  wsUrlFromRedirect,
} from "../net/improv";
import { rgbaToB64, toTraceBlob, TraceSink, type TraceFrame } from "../net/trace";
import { CaptureUnsupportedError } from "../xr/capture";
import { DEFAULT_IMU_MAPPING, ImuRecorder, parseImuMapping } from "../xr/imu";
import { MediaStreamCaptureSource } from "../xr/mediaStreamCapture";
import { SolverAgent, type SolveSnapshot } from "../solver/agent";
import { chooseSolvePlacement } from "../solver/placement";
import { LabelOverlay } from "./labels";
import { MapView } from "./mapview";

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
  // texImage2D(video) delivers the TOP row at v=0 — no flip. ?flipv=1
  // reverts should another device differ.
  flipV: qs.get("flipv") !== null ? qs.get("flipv") !== "0" : false,
};
// Capture tuning (docs/vio-exploration.md phase 4): ?imumap= overrides the
// DeviceMotion axis mapping (see xr/imu.ts); ?fx= forces the focal-length
// seed.
const imuMapping = parseImuMapping(qs.get("imumap") ?? "") ?? DEFAULT_IMU_MAPPING;
const forcedFx = ((): number | null => {
  const v = parseFloat(qs.get("fx") ?? "");
  return Number.isFinite(v) && v > 0 ? v : null;
})();
/** Focal calibration cached by earlier sessions (fx error ⇒ metric-scale
 * error). Nothing WRITES it since the WebXR removal (M6) — XR sessions were
 * the calibrated-K source — but reading it keeps previously calibrated
 * devices scale-exact until a calibration flow returns (phase 4.5 PnP). */
const K_CACHE_KEY = "ledmapper.calibratedK";
/** Last WiFi credentials sent to a player (BLE provisioning), pre-filled on
 * the next setup so re-provisioning doesn't retype the network. */
const WIFI_CACHE_KEY = "ledmapper.wifi";

// Capture auto-negotiation overrides (cv/exposure.ts picks these from the
// measured scene by default): ?symbols=2|4, ?bitms=N.
const forcedSymbols = ((): 2 | 4 | null => {
  const v = qs.get("symbols");
  return v === "2" ? 2 : v === "4" ? 4 : null;
})();
const forcedBitMs = ((): number | null => {
  const v = parseFloat(qs.get("bitms") ?? "");
  return Number.isFinite(v) && v > 0 ? v : null;
})();
// ?brightness= forces a fixed LED output brightness (disables the wash-out
// servo); unset, capture starts at full and servos down against measured
// bloom (split/gray blob fractions, scene clipping).
const forcedBrightness = ((): number | null => {
  const v = parseFloat(qs.get("brightness") ?? "");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
})();
// `?exposure=<0..1>` locks the camera exposure (0 = minimum = darkest, least
// LED bloom). This is the real lever against bloom in the dark: auto-exposure
// clips the LEDs to white regardless of LED brightness, so we pin exposure
// down instead of dimming the strip. See xr/exposureControl.ts.
const forcedExposure = ((): number | null => {
  const v = parseFloat(qs.get("exposure") ?? "");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
})();
// Debug: stream the raw per-frame blob field to the server (JSONL under the
// session dir) so the CV stage's actual input can be inspected offline.
const recordBlobs = qs.get("record") === "1";
// Debug: `?trace=<url>` dumps rich per-frame CV traces (blob saturation +
// chroma-weighted color, periodic thumbnails) to a trace server
// (tools/trace_server.py) for offline blooming/misclassification analysis.
// From an https origin the URL must be https too (mixed content).
const traceUrl = qs.get("trace");

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
let capture: MediaStreamCaptureSource | null = null;
let capturing = false;
let imuRecorder: ImuRecorder | null = null;
let previewVideo: HTMLVideoElement | null = null;
let traceSink: TraceSink | null = null;

// -- solver placement (Rust/wasm branch) --------------------------------------
// Load the wasm solver in a worker and time the canned benchmark once at
// startup; stopCapture() compares against the host's welcome.solverBenchMs
// (chooseSolvePlacement) to decide where the final solve runs. The phone
// retains its own detections/IMU during no-XR captures so a phone-side solve
// needs nothing from the server.
const solverAgent = new SolverAgent();
const solverReady: Promise<boolean> = solverAgent.init().then((ok) => {
  if (ok) console.info(`wasm solver ready: benchmark ${solverAgent.benchMs?.toFixed(0)} ms`);
  else console.info("wasm solver unavailable; final solves stay on the host");
  return ok;
});
let localDetections: DetectionRecord[] = [];
let localImu: ImuSample[] = [];
let lastLedCount = 64;

// Live (in-capture) solver feedback: 2D blob/id overlay over the camera
// preview + a small converging-map inset.
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
    // Cross-origin wss target (hosted-app flow): the likely cause is the
    // player's self-signed cert, which a WebSocket can never prompt for —
    // point at the player's landing page (R2 trust flow).
    const certHelp = certApprovalUrl(wsUrl);
    if (certHelp !== null) {
      setError(`Can't reach the player at ${wsUrl}.`, [
        `If this player uses a self-signed certificate, open ${certHelp} first ` +
          "and accept the certificate warning, then come back and reload.",
      ]);
    }
    // client auto-reconnects; enable start once connected.
    const enable = setInterval(() => {
      if (client.isConnected) {
        startBtn.disabled = false;
        setError("");
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

// Player onboarding over BLE (Improv Wi-Fi — see net/improv.ts): the hosted
// app provisions an ESP32 player onto THIS network, gets its address back,
// and reloads itself pointed at it. Chrome-only (no Web Bluetooth on iOS).
const bleBtn = $<HTMLButtonElement>("blesetup");
if (bleAvailable()) {
  bleBtn.style.display = "";
  bleBtn.addEventListener("click", () => {
    void (async () => {
      bleBtn.disabled = true;
      setError("");
      try {
        // Chooser FIRST: requestDevice needs the click's (unconsumed) user
        // gesture — even a prompt() beforehand eats it.
        const device = await requestImprovDevice();
        // Pre-fill from the last successful provisioning so re-runs (a
        // second player, a re-provision) don't retype the network.
        const cached = ((): { ssid: string; password: string } => {
          try {
            return JSON.parse(localStorage.getItem(WIFI_CACHE_KEY) ?? "{}");
          } catch {
            return { ssid: "", password: "" };
          }
        })();
        const ssid = prompt("WiFi network name (SSID) for the player:", cached.ssid ?? "");
        if (!ssid) {
          bleBtn.disabled = false;
          return;
        }
        const password =
          prompt(`WiFi password for "${ssid}" (empty for open):`, cached.password ?? "") ?? "";
        const urls = await provisionViaBle(device, ssid, password, setConn);
        // Cache only after the device reports it JOINED (below succeeds).
        try {
          localStorage.setItem(WIFI_CACHE_KEY, JSON.stringify({ ssid, password }));
        } catch {
          // storage blocked — non-fatal, just no pre-fill next time
        }
        const target = urls.map((u) => wsUrlFromRedirect(u)).find((u) => u !== null);
        if (!target) throw new Error(`player joined, but sent no usable address (${urls})`);
        setConn(`player provisioned at ${target} — reconnecting…`);
        const qs2 = new URLSearchParams(location.search);
        qs2.set("url", target);
        location.search = qs2.toString(); // reload, rebound to the player
      } catch (e) {
        setError(`Player setup failed: ${e instanceof Error ? e.message : e}`);
        bleBtn.disabled = false;
      }
    })();
  });
}
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
    // Order matters: the camera needs a user gesture, so open it first;
    // start_mapping only once the camera is actually up. Poses are solved
    // jointly from the decoded observations + the inertial stream
    // (docs/vio-exploration.md phase 4).
    lastLedCount = ledCount;
    localDetections = [];
    localImu = [];
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
      ...(forcedExposure !== null ? { exposure: forcedExposure } : {}),
    });
    capture = ms;
    await capture.start();
    if (ms.exposureApplied !== null) setConn(`exposure: ${ms.exposureApplied}`);
    // Fullscreen live preview behind the HUD.
    ms.video.style.cssText =
      "position:fixed;inset:0;width:100vw;height:100vh;object-fit:cover;z-index:0;background:#000";
    document.body.prepend(ms.video);
    previewVideo = ms.video;
    // Inertial stream: what lets the joint solver recover the trajectory.
    imuRecorder = new ImuRecorder(imuMapping);
    imuRecorder.start();

    const detector = new DetectorGL(capture.gl, detectorOpts);

    // -- Pre-capture probe: measure the scene BEFORE the pattern runs, then
    // negotiate the capture configuration (§7.1 start_mapping options). The
    // client owns this choice — it is the only party that can see the light.
    const monitor = new ExposureMonitor();
    let lastAmbient: number | null = null;
    document.body.classList.add("in-capture");
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
      ? recommendConfig({
          frameIntervalMs: probed.frameIntervalMs,
          meanLuma: probed.scene.meanLuma,
          clipFrac: probed.scene.clipFrac,
        })
      : null;
    const config = {
      ...(forcedSymbols !== null
        ? { symbols: forcedSymbols }
        : recommended !== null
          ? { symbols: recommended.symbols }
          : {}),
      ...(forcedBitMs !== null
        ? { bitPeriodMs: forcedBitMs }
        : recommended !== null
          ? { bitPeriodMs: recommended.bitPeriodMs }
          : {}),
      // Omitted = full brightness; the wash-out servo dims mid-capture.
      ...(forcedBrightness !== null ? { brightness: forcedBrightness } : {}),
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
      // Dense per-frame records (pose: null) — the joint pose+LED solver
      // wants every sighting, not per-cycle anchors.
      const pl = new CvPipeline(p, e, (t) => client.clock.toServerTime(t), {
        denseRecords: true,
      });
      pl.onDetections((records: DetectionRecord[]) => {
        client.sendDetections(records);
        // Local retention so a phone-side final solve needs nothing back
        // from the server.
        localDetections.push(...records);
      });
      return pl;
    };
    let pipeline = makePipeline(params, epoch);
    hudGuide.textContent = `code: ${params.symbols} symbols @ ${params.bitPeriodMs} ms/frame`;

    // Trace sink (?trace=): rich CV dump for offline blooming analysis.
    const trace = traceUrl !== null ? new TraceSink(traceUrl) : null;
    traceSink = trace;
    if (trace) {
      trace.begin({
        sessionId: `${Date.now()}`,
        startedAt: new Date().toISOString(),
        ledCount,
        wsUrl,
        userAgent: navigator.userAgent,
        codeParams: params,
      });
      setConn(`tracing to ${traceUrl}`);
    }

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

    capture.onFrame((f) => {
      if (!capturing || !capture) return;
      const blobs = detector.detect(f.texture, f.imgW, f.imgH, trace ? { stats: true } : {});
      // Exposure monitoring: blob count every frame, the (cheap but not free)
      // unthresholded scene readback on a subsample — AE moves at ~1 Hz.
      const measured = frameCount % 6 === 0 ? detector.measure(f.texture, f.imgW, f.imgH) : undefined;
      monitor.push({
        tMs: f.tCaptureMs,
        blobCount: blobs.length,
        scene: measured,
        // Wash-out signals for the LED brightness servo (split/gray/intensity).
        blobs: blobPopulation(blobs),
      });
      lastAmbient = f.ambientIntensity ?? lastAmbient;

      if (trace) {
        const tf: TraceFrame = {
          t: f.tCaptureMs,
          tServer: client.clock.toServerTime(f.tCaptureMs),
          frameIndex: Math.floor(
            (client.clock.toServerTime(f.tCaptureMs) - epoch) / params.bitPeriodMs,
          ) % params.cycleFrames,
          brightness: params.brightness ?? 1,
          blobs: blobs.map(toTraceBlob),
          scene: measured,
        };
        // A color thumbnail on the frames the measure pass just ran (every
        // 6th) — lets the trace show bloom shape/color, not just numbers.
        if (measured) {
          const m = detector.lastMeasureFrame();
          if (m.rgba.length > 0) {
            tf.thumb = { w: m.w, h: m.h, rgbaB64: rgbaToB64(m.rgba) };
          }
        }
        if (trace.push(tf)) void trace.flush();
      }
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

      // The 2D blob/id overlay gives full detection+decode feedback over the
      // video preview, and the live map inset shows the joint solve
      // converging. (Client-side PnP against the solved map — 3D-registered
      // overlays without a platform tracker — is the phase-4.5 follow-up in
      // docs/vio-exploration.md.)
      labels.draw(pipeline.lastBlobStatus, f.imgW, f.imgH);

      if (++frameCount % 15 === 0) {
        const s = pipeline.stats;
        // Second HUD line: the configured LED brightness plus the servo's
        // inputs, so its behavior is legible on-device. `sat` (median blob
        // saturated-pixel fraction) and `split`/`gray` are the "too bright"
        // gates; `medI` the "too dim" one; `blobs` vs the LED count the
        // starve/flood signal. (Window medians, same data the servo reads.)
        const pop = monitor.blobPopulation();
        const scn = monitor.scene();
        const br = Math.round((params.brightness ?? 1) * 100);
        const pct = (x: number): string => `${Math.round(x * 100)}%`;
        const servoLine = pop
          ? `LED ${br}% · sat ${pop.satFrac.toFixed(2)} split ${pct(pop.splitFrac)} ` +
            `gray ${pct(pop.grayFrac)} · medI ${pop.medianIntensity.toFixed(2)}` +
            (scn ? ` clip ${pct(scn.clipFrac)}` : "")
          : `LED ${br}%`;
        hudStats.textContent =
          `decoded ${s.uniqueIds.size}/${params.ledCount} ids · ${s.tracks} tracks · ` +
          `${blobs.length} blobs · align ${s.alignShiftMs.toFixed(0)} ms · ` +
          `${client.pendingBatchCount} unsent${liveSolvedText}\n` +
          servoLine;
      }
    });

    capture.onEnd(() => {
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
        const samples = rec.flush();
        localImu.push(...samples);
        client.sendImuBatch(samples);
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
    let pendingSymbols: 2 | 4 | null = null;
    let pendingBrightness: number | null = null;
    let renegotiating = false;
    const applyReconfigure = (opts: { bitPeriodMs?: number; symbols?: 2 | 4; brightness?: number }): void => {
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
          hudGuide.textContent =
            `code renegotiated: ${params.symbols} symbols @ ${params.bitPeriodMs} ms/frame` +
            ` · LED ${Math.round((params.brightness ?? 1) * 100)}%`;
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
      // shutter) or recovered. Symbol-alphabet switch: the decoder's
      // MEASURED symbol margins (its chroma SNR) say the current alphabet is
      // struggling (4 → 2) or comfortably separable (2 → 4).
      const wantBit = forcedBitMs === null ? planReconfigure(params.bitPeriodMs, report.frameIntervalMs) : null;
      const wantSym =
        forcedSymbols === null
          ? planSymbolSwitch(
              params.symbols as 2 | 4,
              { meanLuma: report.meanLuma, clipFrac: report.clipFrac },
              pipeline.stats.marginEma,
            )
          : null;
      // LED brightness servo: detection probability over brightness is an
      // inverted U (dim → blobs starve; bright → bloom merges halos and
      // washes hue), so servo on the MEASURED wash-out signals.
      const pop = monitor.blobPopulation();
      const wantBright =
        forcedBrightness === null && pop !== null
          ? planLedBrightness(params.brightness ?? 1, {
              blobCount: report.blobCount,
              ledCount,
              splitFrac: pop.splitFrac,
              grayFrac: pop.grayFrac,
              medianIntensity: pop.medianIntensity,
              clipFrac: report.clipFrac,
            })
          : null;
      // Two-consecutive-ticks confirmation on ANY knob; a confirmed change
      // carries the others' current wants so one configure (one pattern
      // re-anchor) covers them all.
      const confirmed =
        (wantBit !== null && wantBit === pendingBitPeriod) ||
        (wantSym !== null && wantSym === pendingSymbols) ||
        (wantBright !== null && wantBright === pendingBrightness);
      if (confirmed) {
        pendingBitPeriod = null;
        pendingSymbols = null;
        pendingBrightness = null;
        applyReconfigure({
          ...(wantBit !== null ? { bitPeriodMs: wantBit } : {}),
          ...(wantSym !== null ? { symbols: wantSym } : {}),
          ...(wantBright !== null ? { brightness: wantBright } : {}),
        });
      } else {
        pendingBitPeriod = wantBit;
        pendingSymbols = wantSym;
        pendingBrightness = wantBright;
      }
    }, 2000);
  } catch (e) {
    capturing = false;
    document.body.classList.remove("in-capture");
    imuRecorder?.stop();
    imuRecorder = null;
    previewVideo?.remove();
    previewVideo = null;
    if (traceSink) {
      await traceSink.flush().catch(() => undefined);
      traceSink = null;
    }
    await capture?.stop().catch(() => undefined);
    capture = null;
    startBtn.disabled = false;
    if (e instanceof CaptureUnsupportedError) {
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
  document.body.classList.remove("in-capture");
  imuRecorder?.stop();
  imuRecorder = null;
  previewVideo?.remove();
  previewVideo = null;
  if (traceSink) {
    await traceSink.flush().catch(() => undefined);
    traceSink = null;
  }
  if (!sessionAlreadyEnded) await capture?.stop().catch(() => undefined);
  capture = null;
  resetLiveFeedback();

  // Solver placement (init-time benchmarks, chooseSolvePlacement): the
  // joint solve runs on the phone's wasm solver unless the host is
  // decisively faster.
  await solverReady.catch(() => false);
  // Against a solverless player (ESP32: no welcome.solverBenchMs), the phone
  // wasm solver is the ONLY option. If its startup load failed (cold CDN,
  // slow venue network), retry it HERE instead of dead-ending the user on a
  // "reload the page" — the capture's detections are still in hand.
  if (client.hostSolverBenchMs === null && !solverAgent.available) {
    setConn("loading the solver…");
    await solverAgent.init().catch(() => false);
  }
  const placement = chooseSolvePlacement(solverAgent.benchMs, client.hostSolverBenchMs);
  const solveOnPhone =
    placement === "phone" && solverAgent.available && localDetections.length > 0;
  if (!solveOnPhone && client.hostSolverBenchMs === null) {
    // The player never advertised a solver bench score — it HAS no solver
    // (ESP32 profile) — and the wasm solver still won't load. Stop + persist
    // on the player; the capture stays recoverable (localDetections kept),
    // and the app is left fully usable so a later attempt can re-solve.
    setError(
      solverAgent.available
        ? "Nothing to solve — no LEDs were decoded in this capture."
        : "The in-browser solver could not load (needed because this player has no solver). Check the connection and press Start to capture again.",
    );
    setConn("capture stopped (unsolved)");
    await client.stopMappingNoSolve().catch(() => undefined);
    setupSection.style.display = "";
    resultSection.style.display = "none";
    startBtn.disabled = false;
    stopBtn.disabled = true;
    return;
  }

  setConn(solveOnPhone ? "final solve (on phone)…" : "final solve…");
  // While the final solve runs: a progress bar plus the CONVERGING interim
  // map rendered live in the result viewport (the joint solve takes seconds
  // — watching it settle beats staring at a spinner). Phone solves push
  // snapshots from the worker; host solves poll get_solve_status.
  const progWrap = $("solveprog");
  const progFill = $("solveprog-fill");
  const progText = $("solveprog-text");
  progWrap.style.display = "";
  progFill.style.width = "0%";
  progText.textContent = "solving…";
  let previewView: MapView | null = null;
  const renderSolveSnapshot = (st: {
    progress: number | null;
    rmsPx: number | null;
    leds: { id: number; xyz: [number, number, number] }[] | null;
    trajectory: [number, number, number][] | null;
  }): void => {
    if (st.progress !== null) {
      progFill.style.width = `${Math.round(st.progress * 100)}%`;
      progText.textContent =
        `solving… ${Math.round(st.progress * 100)} %` +
        (st.rmsPx !== null ? ` · reproj ${st.rmsPx.toFixed(1)} px` : "");
    }
    if (st.leds !== null && st.leds.length >= 3) {
      const interim = interimMap(st.leds, st.trajectory);
      setupSection.style.display = "";
      resultSection.style.display = "";
      if (previewView === null) {
        mapView?.stop();
        previewView = new MapView($<HTMLCanvasElement>("mapcanvas"), interim);
        previewView.showTrajectory = trajectoryOn;
        mapView = previewView;
        previewView.start();
      } else {
        previewView.update(interim);
      }
      previewView.setTrajectory(st.trajectory);
      syncTrajButton(previewView);
    }
  };
  const solvePoll = solveOnPhone
    ? null
    : setInterval(() => {
        client
          .getSolveStatus()
          .then(renderSolveSnapshot)
          .catch(() => undefined);
      }, 400);
  try {
    let mapId: string;
    let map: OutputMap;
    if (solveOnPhone) {
      // Phone placement: stop (server persists the log, no host solve),
      // solve locally in the wasm worker, upload the result. The map shown
      // is the locally solved one — no /maps fetch needed.
      await client.stopMappingNoSolve();
      map = await solverAgent.solve(
        {
          detections: localDetections,
          imu: localImu,
          ledCount: lastLedCount,
          mapId: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
        },
        (snap: SolveSnapshot) => renderSolveSnapshot(snap),
      );
      const ack = await client.submitMap(map);
      mapId = ack.mapId;
    } else {
      const result = await client.stopMapping();
      mapId = result.mapId;
      const resp = await fetch(`/maps/${mapId}`);
      if (!resp.ok) throw new Error(`fetching map failed: HTTP ${resp.status}`);
      map = (await resp.json()) as OutputMap;
    }
    showResult(mapId, map);
    setConn(`map ${mapId} ready${solveOnPhone ? " (solved on phone)" : ""}`);
  } catch (e) {
    setError(`Reconstruction failed: ${e instanceof Error ? e.message : e}`);
    setConn(client.isConnected ? "connected" : "disconnected");
  } finally {
    if (solvePoll !== null) clearInterval(solvePoll);
    progWrap.style.display = "none";
    stopBtn.disabled = false;
    startBtn.disabled = false;
  }
}

/** OutputMap-shaped wrapper around a solve_status interim snapshot, just
 * enough for MapView (quality fields are placeholders until the final map). */
function interimMap(
  leds: { id: number; xyz: [number, number, number] }[],
  trajectory: [number, number, number][] | null,
): OutputMap {
  return {
    mapId: "solving",
    createdAt: "",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: leds.length,
    leds: leds.map((l) => ({
      id: l.id,
      xyz: l.xyz,
      confidence: 1,
      nViews: 0,
      rmsReprojPx: 0,
      parallaxDeg: 0,
    })),
    unmapped: [],
    ...(trajectory !== null ? { trajectory } : {}),
    stats: { rmsReprojPxGlobal: 0, medianParallaxDeg: 0 },
  };
}

// Camera-path toggle: persists across interim/final view swaps.
let trajectoryOn = false;
const trajBtn = $<HTMLButtonElement>("trajtoggle");
trajBtn.addEventListener("click", () => {
  trajectoryOn = !trajectoryOn;
  if (mapView !== null) mapView.showTrajectory = trajectoryOn;
  trajBtn.textContent = trajectoryOn ? "Hide camera path" : "Show camera path";
});

function syncTrajButton(view: MapView): void {
  trajBtn.style.display = view.hasTrajectory ? "" : "none";
  trajBtn.textContent = trajectoryOn ? "Hide camera path" : "Show camera path";
}

function showResult(mapId: string, map: OutputMap): void {
  setupSection.style.display = "";
  resultSection.style.display = "";
  $<HTMLAnchorElement>("dl-json").href = `/maps/${mapId}`;
  $<HTMLAnchorElement>("dl-csv").href = `/maps/${mapId}.csv`;
  mapView?.stop();
  const view = new MapView($<HTMLCanvasElement>("mapcanvas"), map);
  mapView = view;
  view.setTrajectory(map.trajectory ?? null);
  view.showTrajectory = trajectoryOn;
  syncTrajButton(view);
  void fetchTruth(map.ledCount).then((t) => view.setTruth(t));
  view.start();
}
