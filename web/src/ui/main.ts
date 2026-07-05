/**
 * M8 — capture app session flow (design doc §6 M8):
 *
 *   connect → clock sync → [user taps Start] → immersive-ar w/ camera-access
 *   → per-frame detect/track/decode → stream detections → live HUD guidance
 *   → [Stop] → server reconstructs → result preview + downloads.
 *
 * Everything heavy lives in M5/M6/M7; this file is orchestration + DOM.
 */

import type { DetectionRecord, LedEntry, OutputMap } from "@ledmapper/protocol";
import { CvPipeline } from "../cv/pipeline";
import { DetectorGL } from "../cv/detect";
import { mul4 } from "../geom/mat4";
import { defaultWsUrl, LedMapperClient } from "../net/client";
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
const detectorOpts = {
  threshold: numParam("threshold", 0.6),
  downscale: numParam("downscale", 2),
  // Camera texture arrives bottom-up on-device (see DetectorOptions.flipV);
  // ?flipv=0 reverts should another device differ.
  flipV: qs.get("flipv") !== "0",
};
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
let capture: WebXRCaptureSource | null = null;
let capturing = false;

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
    // Order matters: the XR session needs a user gesture, so create it first;
    // start_mapping only once the camera is actually up.
    capture = new WebXRCaptureSource($("overlay"));
    await capture.start();

    // Re-sync the clock right before the epoch matters.
    await client.syncClock(4);
    const started = await client.startMapping(ledCount);
    const params = started.codeParams;

    const detector = new DetectorGL(capture.gl, detectorOpts);
    const markers = showBlobs ? new MarkerRenderer(capture.gl) : null;
    const solvedMarkers = new SolvedMarkerRenderer(capture.gl);
    const pipeline = new CvPipeline(params, started.patternClockEpoch, (t) =>
      client.clock.toServerTime(t),
    );
    pipeline.onDetections((records: DetectionRecord[]) => {
      client.sendDetections(records);
    });

    capturing = true;
    document.body.classList.add("in-xr");
    let frameCount = 0;

    // ?record=1 frame recorder: batches of raw detector output.
    let frameBuf: unknown[] = [];
    const postFrames = (body: object): void => {
      void fetch("/debug/frames", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).catch(() => undefined);
    };
    if (recordBlobs) {
      postFrames({ reset: true, epoch: started.patternClockEpoch, codeParams: params });
    }

    capture.onFrame((f) => {
      if (!capturing || !capture) return;
      const blobs = detector.detect(f.texture, f.imgW, f.imgH);
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
          frameBuf = [];
          postFrames({ frames: batch });
        }
      }
      pipeline.step(blobs, {
        tCaptureMs: f.tCaptureMs,
        pose: f.pose,
        K: f.K,
        imgW: f.imgW,
        imgH: f.imgH,
      });

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

      // 2D canvas: blob outlines (detection-stage feedback, colored by track
      // association) + id labels next to the composited markers.
      labels.draw(liveLeds, mvp, pipeline.lastBlobStatus, f.imgW, f.imgH);

      if (++frameCount % 15 === 0) {
        const s = pipeline.stats;
        hudStats.textContent =
          `decoded ${s.uniqueIds.size}/${params.ledCount} ids · ${s.tracks} tracks · ` +
          `${blobs.length} blobs · align ${s.alignShiftMs.toFixed(0)} ms · ` +
          `${client.pendingBatchCount} unsent${liveSolvedText}`;
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
          solvedMarkers.setLeds(liveLeds);
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
  } catch (e) {
    capturing = false;
    document.body.classList.remove("in-xr");
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
