/**
 * M8 — capture app session flow (design doc §6 M8):
 *
 *   connect → clock sync → [user taps Start] → immersive-ar w/ camera-access
 *   → per-frame detect/track/decode → stream detections → live HUD guidance
 *   → [Stop] → server reconstructs → result preview + downloads.
 *
 * Everything heavy lives in M5/M6/M7; this file is orchestration + DOM.
 */

import type { DetectionRecord, OutputMap } from "@ledmapper/protocol";
import { CvPipeline } from "../cv/pipeline";
import { DetectorGL } from "../cv/detect";
import { defaultWsUrl, LedMapperClient } from "../net/client";
import { WebXRCaptureSource, XrUnsupportedError } from "../xr/webxrCapture";
import { MapView } from "./mapview";
import { MarkerRenderer } from "./markers";

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
  flipV: qs.get("flipv") === "1",
};

function numParam(name: string, dflt: number): number {
  const v = qs.get(name);
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

const client = new LedMapperClient(wsUrl);
let mapView: MapView | null = null;
let capture: WebXRCaptureSource | null = null;
let capturing = false;

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

async function startCapture(): Promise<void> {
  setError("");
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
    const markers = new MarkerRenderer(capture.gl);
    const pipeline = new CvPipeline(params, started.patternClockEpoch, (t) =>
      client.clock.toServerTime(t),
    );
    pipeline.onDetections((records: DetectionRecord[]) => {
      client.sendDetections(records);
    });

    capturing = true;
    document.body.classList.add("in-xr");
    let frameCount = 0;

    capture.onFrame((f) => {
      if (!capturing || !capture) return;
      const blobs = detector.detect(f.texture, f.imgW, f.imgH);
      pipeline.step(blobs, {
        tCaptureMs: f.tCaptureMs,
        pose: f.pose,
        K: f.K,
        imgW: f.imgW,
        imgH: f.imgH,
      });

      // Feedback markers into the XR layer.
      const gl = capture.gl;
      const fb = capture.layerFramebuffer;
      const { width, height } = capture.layerSize;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(0, 0, width, height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      markers.draw(blobs, f.imgW, f.imgH, width, height, [0.2, 1, 0.6, 0.85]);

      if (++frameCount % 15 === 0) {
        const s = pipeline.stats;
        hudStats.textContent =
          `decoded ${s.uniqueIds.size}/${params.ledCount} ids · ${s.tracks} tracks · ` +
          `${blobs.length} blobs · align ${s.alignShiftMs.toFixed(0)} ms · ` +
          `${client.pendingBatchCount} unsent`;
      }
    });

    capture.onEnd(() => {
      // Session ended outside our Stop button (system gesture) — still solve.
      if (capturing) void stopCapture(true);
    });

    // Server-side coverage poll for guidance.
    const poll = setInterval(() => {
      if (!capturing) {
        clearInterval(poll);
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

  setConn("solving…");
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
  mapView = new MapView($<HTMLCanvasElement>("mapcanvas"), map);
  mapView.start();
}
