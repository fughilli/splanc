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
  PlaybackParams,
  Topology,
} from "@ledmapper/protocol";
import {
  adjustThreshold,
  blobPopulation,
  EXPOSURE_SERVO_START,
  ExposureMonitor,
  planExposureServo,
  planLedBrightness,
  planReconfigure,
  planSymbolSwitch,
  recommendConfig,
} from "../cv/exposure";
import { CvPipeline } from "../cv/pipeline";
import { DetectorGL } from "../cv/detect";
import { certApprovalUrl, defaultWsUrl, LedMapperClient } from "../net/client";
import { encodeMappingBundle } from "../net/proto";
import {
  bleAvailable,
  provisionViaBle,
  requestImprovDevice,
  wsUrlFromRedirect,
} from "../net/improv";
import { rgbaToB64, toTraceBlob, TraceSink, type TraceFrame } from "../net/trace";
import { FrameSink, frameUrlFromTraceUrl } from "../net/frameCapture";
import { extractTopology } from "../topology/extract";
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
// `?exposure=servo` auto-servos the exposure to the detection sweet spot
// (long enough to integrate the LEDs' PWM banding, short enough to avoid
// bloom); `?exposure=<0..1>` pins a fixed value.
const servoExposure = qs.get("exposure") === "servo";
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
// Debug: `?frames=1` (with ?trace=) additionally uploads the FULL-RESOLUTION
// camera frame (the detector's byte-exact input, gzip-compressed) per frame,
// so the whole CV pipeline can be re-run/tuned offline. Heavy — diagnostic
// captures only. See net/frameCapture.ts.
const captureFrames = qs.get("frames") === "1" && traceUrl !== null;

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
// Kept past capture end so its RAM-buffered frames finish uploading in the
// background (full-res frames outrun the live bandwidth; see FrameSink).
let frameSinkRef: FrameSink | null = null;

// -- manual exposure/brightness override (in-capture) -------------------------
// The exposure + LED-brightness servos don't always land on a good operating
// point, so the capture HUD exposes a manual override: the toggle freezes both
// servos and the two sliders drive the camera exposure and LED brightness
// directly; toggling back resumes servo mode from wherever the sliders are.
// While in auto mode the sliders track the servo, so switching never jumps.
const capControls = $("cap-controls");
const ccToggle = $<HTMLButtonElement>("cc-toggle");
const ccSliders = $("cc-sliders");
const ccModeLabel = $("cc-mode-label");
const ccBright = $<HTMLInputElement>("cc-bright");
const ccBrightV = $("cc-bright-v");
const ccExp = $<HTMLInputElement>("cc-exp");
const ccExpV = $("cc-exp-v");
let manualMode = false;
// Set by the capture loop while running (null otherwise): applies a slider
// value into the live capture (brightness via a configure, exposure via the
// camera track).
let manualHooks: { applyBrightness: (b01: number) => void; applyExposure: (e01: number) => void } | null =
  null;

function setManualMode(on: boolean): void {
  manualMode = on;
  capControls.classList.toggle("manual", on);
  ccSliders.style.display = on ? "block" : "none";
  ccModeLabel.textContent = on ? "Manual" : "Auto (servo)";
  ccToggle.textContent = on ? "Back to servo" : "Manual override";
}

/** Keep the sliders showing the servo's current values (auto mode only), so
 * flipping to manual doesn't jump the levers. */
function syncManualSliders(brightness01: number, exposure01: number): void {
  if (manualMode) return;
  ccBright.value = String(Math.round(brightness01 * 100));
  ccBrightV.textContent = `${ccBright.value}%`;
  ccExp.value = exposure01.toFixed(2);
  ccExpV.textContent = exposure01.toFixed(2);
}

ccToggle.addEventListener("click", () => setManualMode(!manualMode));
ccBright.addEventListener("input", () => {
  ccBrightV.textContent = `${ccBright.value}%`;
});
// Brightness is a code param — a configure re-anchors the pattern clock — so
// apply on release, not on every drag pixel.
ccBright.addEventListener("change", () => {
  if (manualMode) manualHooks?.applyBrightness(parseInt(ccBright.value, 10) / 100);
});
// Exposure is a local camera setting (no pattern restamp) → apply live, but
// throttle the applyConstraints calls during a drag; the release always lands
// the final value.
let lastExpApply = 0;
function applyManualExposure(final: boolean): void {
  if (!manualMode) return;
  const now = performance.now();
  if (!final && now - lastExpApply < 120) return;
  lastExpApply = now;
  manualHooks?.applyExposure(parseFloat(ccExp.value));
}
ccExp.addEventListener("input", () => {
  ccExpV.textContent = parseFloat(ccExp.value).toFixed(2);
  applyManualExposure(false);
});
ccExp.addEventListener("change", () => applyManualExposure(true));

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
  onConnecting: (attempt, url) =>
    setConn(attempt <= 1 ? `connecting to ${url}…` : `connecting to ${url} (attempt ${attempt})…`),
  onConnected: () => setConn(`connected to ${wsUrl} — syncing clock…`),
  onDisconnected: () => setConn("disconnected — reconnecting…"),
  onServerError: (code, msg) => setError(`server error ${code}: ${msg}`),
};

async function boot(): Promise<void> {
  startBtn.disabled = true;
  try {
    const welcome = await client.connect();
    ledCountInput.value = String(
      parseInt(qs.get("leds") ?? "", 10) || welcome.codeParams.ledCount,
    );
    setConn(`connected to ${wsUrl} — syncing clock…`);
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

// Topology-aware effects: pulses that traverse the graph (spawn at a terminus,
// pick a direction at each junction, may split, despawn at a terminus) and a
// flood that propagates outward from a terminus and decays to black. Shown once
// a topology has been uploaded; each button toggles its effect, and only one
// effect runs at a time.
const playEffectBtn = $<HTMLButtonElement>("playeffect");
const playFloodBtn = $<HTMLButtonElement>("playflood");
const effectControls = $("effect-controls");
const fxSpeed = $<HTMLInputElement>("fx-speed");
const fxGlow = $<HTMLInputElement>("fx-glow");
const fxLead = $<HTMLInputElement>("fx-lead");
const fxSplit = $<HTMLInputElement>("fx-split");
const fxDecay = $<HTMLInputElement>("fx-decay");
type Effect = "pulse" | "flood";
let activeEffect: Effect | null = null;

const effectButtons: Record<Effect, { btn: HTMLButtonElement; label: string }> = {
  pulse: { btn: playEffectBtn, label: "pulse" },
  flood: { btn: playFloodBtn, label: "flood" },
};

// Read the tuning sliders into wire params. leadIn/decay of 0 mean "auto"
// (the player derives them from the glow radius) — omit them so the overlay
// stays unset rather than pinning the value to 0.
function effectParams(effect: Effect): PlaybackParams {
  const speed = parseFloat(fxSpeed.value);
  const glow = parseFloat(fxGlow.value);
  const lead = parseFloat(fxLead.value);
  const split = parseFloat(fxSplit.value);
  const decay = parseFloat(fxDecay.value);
  fxSpeed.nextElementSibling!.textContent = speed.toFixed(2);
  fxGlow.nextElementSibling!.textContent = glow.toFixed(2);
  fxLead.nextElementSibling!.textContent = lead > 0 ? lead.toFixed(2) : "auto";
  fxSplit.nextElementSibling!.textContent = split.toFixed(2);
  fxDecay.nextElementSibling!.textContent = decay > 0 ? decay.toFixed(2) : "auto";
  const p: PlaybackParams = {
    agentCount: effect === "pulse" ? 2 : 1,
    speed,
    glowRadius: glow,
  };
  if (effect === "pulse") {
    p.splitProb = split;
    if (lead > 0) p.leadIn = lead;
  } else if (decay > 0) {
    p.decay = decay;
  }
  return p;
}

function refreshEffectButtons(): void {
  for (const [name, { btn, label }] of Object.entries(effectButtons)) {
    btn.textContent = activeEffect === name ? `Stop ${label}` : `Play ${label}`;
  }
}

async function toggleEffect(effect: Effect): Promise<void> {
  playEffectBtn.disabled = true;
  playFloodBtn.disabled = true;
  const next = activeEffect === effect ? null : effect;
  try {
    await client.setPlayback(next ?? "off", next ? effectParams(next) : undefined);
    activeEffect = next;
    refreshEffectButtons();
  } catch (e) {
    setError(`playback failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    playEffectBtn.disabled = false;
    playFloodBtn.disabled = false;
  }
}

playEffectBtn.addEventListener("click", () => void toggleEffect("pulse"));
playFloodBtn.addEventListener("click", () => void toggleEffect("flood"));

// Live-retune: while an effect runs, moving a slider re-sends its params.
for (const el of [fxSpeed, fxGlow, fxLead, fxSplit, fxDecay]) {
  el.addEventListener("input", () => {
    if (activeEffect === null) {
      effectParams("pulse"); // refresh the readouts even when idle
      return;
    }
    void client
      .setPlayback(activeEffect, effectParams(activeEffect))
      .catch((e) => setError(`retune failed: ${e instanceof Error ? e.message : e}`));
  });
}

// -- Topology preview + tuning (Phase F): re-extract on any control change and
// overlay the skeleton on the map view; upload is a manual, explicit step so
// the extraction can be dialed in first.
const topoControls = $("topo-controls");
const topoSummary = $("topo-summary");
const radiusInput = $<HTMLInputElement>("topo-radius");
const pruneInput = $<HTMLInputElement>("topo-prune");
const loopInput = $<HTMLInputElement>("topo-loop");
const simplifyInput = $<HTMLInputElement>("topo-simplify");
const maxPolyInput = $<HTMLInputElement>("topo-maxpoly");
const topoUploadBtn = $<HTMLButtonElement>("topo-upload");
let resultMap: OutputMap | null = null;
let resultMapId: string | null = null;
let currentTopology: Topology | null = null;

// The skelgraph extraction is O(n²) and runs off the main task cooperatively
// (extractTopology yields + reports progress + honours an AbortSignal). Each
// call supersedes the in-flight one; a slow solve reveals a progress + Abort
// row after a short delay (a fast solve shows nothing).
const topoProgress = $("topo-progress");
const topoProgressText = $("topo-progress-text");
let topoAbort: AbortController | null = null;
let topoDelay: number | null = null;

function previewTopology(): void {
  const map = resultMap;
  const view = mapView;
  if (map === null || view === null) return;
  const radius = parseFloat(radiusInput.value);
  const prune = parseFloat(pruneInput.value);
  const loop = parseFloat(loopInput.value);
  const simplify = parseFloat(simplifyInput.value);
  const maxPoly = parseInt(maxPolyInput.value, 10);
  $("topo-radius-v").textContent = radius.toFixed(1);
  $("topo-prune-v").textContent = prune.toFixed(1);
  $("topo-loop-v").textContent = loop.toFixed(1);
  $("topo-simplify-v").textContent = simplify.toFixed(1);
  $("topo-maxpoly-v").textContent = String(maxPoly);

  // Supersede any in-flight extraction, and (re)arm the delayed progress row.
  topoAbort?.abort();
  const ac = new AbortController();
  topoAbort = ac;
  if (topoDelay !== null) clearTimeout(topoDelay);
  topoDelay = window.setTimeout(() => {
    if (topoAbort === ac) topoProgress.style.display = "";
  }, 300);

  void (async () => {
    try {
      const topo = await extractTopology(
        map,
        { radiusFactor: radius, pruneFactor: prune, loopFactor: loop, simplifyFrac: simplify, maxPolyline: maxPoly },
        { signal: ac.signal, onProgress: (frac) => (topoProgressText.textContent = `Extracting… ${Math.round(frac * 100)}%`) },
      );
      if (ac.signal.aborted) return;
      if (resultMapId !== null) topo.mapId = resultMapId;
      currentTopology = topo;
      view.setTopology(topo);
      const verts = topo.segments.reduce((n, s) => n + s.polyline.length, 0);
      const lenM = topo.segments.reduce((a, s) => a + s.length, 0);
      topoSummary.textContent =
        `${topo.branchPoints.length} junc · ${topo.segments.length} seg · ${verts} verts · ` +
        `${lenM.toFixed(2)} m · ${topo.associations.length}/${map.leds.length} LEDs`;
      topoUploadBtn.textContent = "Upload topology";
      topoUploadBtn.disabled = topo.segments.length === 0;
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) {
        setError(`topology extraction failed: ${e instanceof Error ? e.message : e}`);
      }
    } finally {
      if (topoAbort === ac) {
        topoAbort = null;
        if (topoDelay !== null) clearTimeout(topoDelay);
        topoDelay = null;
        topoProgress.style.display = "none";
      }
    }
  })();
}
for (const el of [radiusInput, pruneInput, loopInput, simplifyInput, maxPolyInput]) {
  el.addEventListener("input", previewTopology);
}
$<HTMLButtonElement>("topo-abort").addEventListener("click", () => {
  topoAbort?.abort();
  topoSummary.textContent = "extraction aborted — adjust a slider to retry";
});
topoUploadBtn.addEventListener("click", () => {
  void (async () => {
    if (currentTopology === null || currentTopology.segments.length === 0) return;
    topoUploadBtn.disabled = true;
    try {
      await client.submitTopology(currentTopology);
      topoUploadBtn.textContent = "Uploaded ✓";
      // Effects can now run against the uploaded topology.
      playEffectBtn.style.display = "";
      playFloodBtn.style.display = "";
      effectControls.style.display = "";
    } catch (e) {
      setError(`topology upload failed: ${e instanceof Error ? e.message : e}`);
      topoUploadBtn.disabled = false;
    }
  })();
});

// Export the solved fixture (map + current topology) as a .binpb MappingBundle
// for the host effects-simulator workspace. Uses the live-extracted topology so
// whatever the preview shows is what gets bundled; the workspace can re-extract
// too, but bundling it keeps the file self-contained.
function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

$<HTMLButtonElement>("export-binpb").addEventListener("click", () => {
  if (resultMap === null) return;
  const topology = currentTopology ?? {
    mapId: resultMapId ?? resultMap.mapId,
    branchPoints: [],
    segments: [],
    associations: [],
  };
  downloadBytes(
    encodeMappingBundle({ map: resultMap, topology }),
    `${resultMapId ?? resultMap.mapId ?? "mapping"}.binpb`,
  );
});

// Pull the map+topology stored on the connected player (an ESP32 player that
// supports get_stored_map) back to the phone and save it as a .binpb, so a
// previously-mapped fixture can be recovered without re-mapping.
$<HTMLButtonElement>("pull-map").addEventListener("click", () => {
  void (async () => {
    const btn = $<HTMLButtonElement>("pull-map");
    const orig = btn.textContent;
    btn.disabled = true;
    try {
      const bundle = await client.pullStoredMap((done, total) => {
        btn.textContent = `Pulling ${Math.round((100 * done) / Math.max(1, total))}%`;
      });
      downloadBytes(encodeMappingBundle(bundle), `${bundle.map.mapId || "player-map"}.binpb`);
      btn.textContent = `Pulled ${bundle.map.leds.length} LEDs ✓`;
    } catch (e) {
      setError(`pull failed: ${e instanceof Error ? e.message : e}`);
      btn.textContent = orig;
    } finally {
      btn.disabled = false;
    }
  })();
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
    // Exposure servo starts mid-range; a fixed ?exposure= pins its value. It's
    // applied AFTER the code is negotiated (below), so the first application
    // already respects the bitPeriodMs/2 Nyquist cap.
    const initialExposure = servoExposure ? EXPOSURE_SERVO_START : forcedExposure;
    let servoedExposure = initialExposure ?? EXPOSURE_SERVO_START;
    const ms = new MediaStreamCaptureSource({
      kSeed: cached,
      fxOverride: forcedFx ?? undefined,
    });
    capture = ms;
    await capture.start();
    if (ms.exposureApplied !== null) setConn(`exposure: ${ms.exposureApplied}`);
    // Fullscreen live preview behind the HUD. Size it to the SAME box as the
    // #overlay/#labels canvas (position:fixed; inset:0 → the visual viewport),
    // NOT 100vw/100vh: on mobile 100vh is the LARGER viewport behind the
    // retractable toolbar, so the video box would be taller than the overlay
    // box and object-fit:cover would center the image differently in each —
    // the detection overlay ends up shifted up relative to the video. Matching
    // boxes makes the two aspect-fill crops identical (markers.ts/imageToView).
    ms.video.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;background:#000";
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
    // Lock the camera exposure now that the bit period is known — capped to
    // bitPeriodMs/2 so it can't integrate across a hue transition (Nyquist).
    if (initialExposure !== null) {
      void ms.setExposure(initialExposure, params.bitPeriodMs / 2);
    }
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
    const traceSessionId = `${Date.now()}`;
    const trace = traceUrl !== null ? new TraceSink(traceUrl) : null;
    traceSink = trace;
    if (trace) {
      trace.begin({
        sessionId: traceSessionId,
        startedAt: new Date().toISOString(),
        ledCount,
        wsUrl,
        userAgent: navigator.userAgent,
        codeParams: params,
      });
      setConn(`tracing to ${traceUrl}${captureFrames ? " · full-frame capture ON" : ""}`);
    }
    // Full-frame capture sink (?frames=1): the detector's byte-exact input,
    // gzipped, to the SAME trace-server session — for offline pipeline replay.
    const frameSink =
      captureFrames && traceUrl !== null
        ? new FrameSink(frameUrlFromTraceUrl(traceUrl), traceSessionId)
        : null;
    frameSinkRef = frameSink;
    let frameSeq = 0;

    capturing = true;
    let frameCount = 0;

    // Frame-timing forwarding (?trace=): periodically drain the player's
    // rendered-frame timing log and hand it to the trace sink, so uneven
    // per-frame emit times (pattern-generator stutter) are visible offline.
    // Fire-and-forget — never blocks capture; at most one poll in flight; on a
    // peer that lacks the arm (e.g. an old firmware, or the Pi) it errors once
    // and then stays quiet.
    let frameTimingInFlight = false;
    let frameTimingUnsupported = false;
    const pollFrameTiming = (): void => {
      if (!trace || frameTimingInFlight || frameTimingUnsupported) return;
      const sink = trace;
      frameTimingInFlight = true;
      client
        .getFrameTiming()
        .then((ft) => {
          if (ft.ticks.length > 0 || ft.dropped > 0) {
            sink.pushTiming({
              tPhone: performance.now(),
              patternClockEpochMs: ft.patternClockEpochMs,
              bitPeriodUs: ft.bitPeriodUs,
              cycleFrames: ft.cycleFrames,
              dropped: ft.dropped,
              ticks: ft.ticks.map((t) => ({ seq: t.seq, tMonoUs: t.tMonoUs })),
            });
          }
        })
        .catch(() => {
          frameTimingUnsupported = true; // peer has no get_frame_timing arm
        })
        .finally(() => {
          frameTimingInFlight = false;
        });
    };

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
        // ?frames=1: also upload the detector's byte-exact full-res input,
        // keyed by seq, so the whole pipeline can be replayed/tuned offline.
        if (frameSink) {
          const seq = frameSeq++;
          tf.seq = seq;
          const grab = detector.grabFrame(f.texture, f.imgW, f.imgH);
          tf.imgW = grab.w;
          tf.imgH = grab.h;
          frameSink.capture(seq, grab.w, grab.h, grab.rgba);
        }
        if (trace.push(tf)) {
          pollFrameTiming(); // rides the next flush once the player replies
          void trace.flush();
        }
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
        // Frame-capture feedback (?frames=1): so it's obvious on-device whether
        // full-frame upload is actually on (a common footgun — the URL param is
        // easy to miss) and keeping up (drops = the encoder/net fell behind).
        const framesLine = frameSink
          ? ` · frames ${frameSink.sentCount}↑` +
            (frameSink.queuedCount ? ` ${frameSink.queuedCount} q ${frameSink.ramMB}MB` : "") +
            (frameSink.droppedCount ? ` ${frameSink.droppedCount} drop` : "")
          : "";
        const expLine = servoExposure ? ` · exp ${servoedExposure.toFixed(2)}` : "";
        const servoLine =
          (pop
            ? `LED ${br}% · sat ${pop.satFrac.toFixed(2)} split ${pct(pop.splitFrac)} ` +
              `gray ${pct(pop.grayFrac)} · medI ${pop.medianIntensity.toFixed(2)}` +
              (scn ? ` clip ${pct(scn.clipFrac)}` : "")
            : `LED ${br}%`) + expLine + framesLine;
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
        // Full-frame capture (?frames=1) forwards IMU to the trace too, so the
        // offline harness has the inertial stream for the joint solve.
        if (captureFrames) trace?.pushImu(samples);
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

    // Wire the in-capture manual override to this capture's levers. Start in
    // auto (servo) mode with the sliders reflecting the initial values.
    setManualMode(false);
    syncManualSliders(params.brightness ?? 1, servoedExposure);
    manualHooks = {
      applyBrightness: (b01) => applyReconfigure({ brightness: b01 }),
      applyExposure: (e01) => {
        servoedExposure = e01;
        void ms.setExposure(e01, params.bitPeriodMs / 2);
      },
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
      const pop = monitor.blobPopulation();
      // Camera-exposure servo (?exposure=servo): retune the locked exposure
      // toward the sweet spot between PWM banding (too short) and bloom (too
      // long). Applied directly — it's a local camera setting, no pattern-clock
      // restamp — so no two-tick confirmation. It's the primary brightness
      // lever here, so the LED-brightness servo is frozen while it runs.
      // Manual override freezes BOTH servos (the user drives the sliders).
      if (servoExposure && !manualMode && pop !== null) {
        const nextExp = planExposureServo(servoedExposure, {
          blobCount: report.blobCount,
          ledCount,
          satFrac: pop.satFrac,
          grayFrac: pop.grayFrac,
          medianIntensity: pop.medianIntensity,
        });
        if (nextExp !== null) {
          servoedExposure = nextExp;
          void ms.setExposure(nextExp, params.bitPeriodMs / 2);
        }
      }
      // LED brightness servo: detection probability over brightness is an
      // inverted U (dim → blobs starve; bright → bloom merges halos and
      // washes hue), so servo on the MEASURED wash-out signals.
      const wantBright =
        !servoExposure && forcedBrightness === null && !manualMode && pop !== null
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
      // Let the sliders track the servo so a switch to manual doesn't jump.
      syncManualSliders(params.brightness ?? 1, servoedExposure);
    }, 2000);
  } catch (e) {
    manualHooks = null;
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
    drainFramesInBackground();
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

/** Let the frame sink keep compressing + uploading its RAM-buffered frames in
 * the background after capture ends, so the whole session lands even though
 * full-res frames outran the live upload bandwidth. Non-blocking; the trace
 * server logs each frame as it arrives. */
function drainFramesInBackground(): void {
  const fs = frameSinkRef;
  frameSinkRef = null;
  if (!fs || fs.queuedCount === 0) return;
  console.info(`[frames] uploading ${fs.queuedCount} buffered frames in the background…`);
  setConn(`uploading ${fs.queuedCount} frames in the background — keep this tab open`);
  void fs.finish((remaining) => {
    if (remaining > 0) console.info(`[frames] ${remaining} frames left to upload`);
    else console.info("[frames] all frames uploaded");
  });
}

async function stopCapture(sessionAlreadyEnded = false): Promise<void> {
  if (!capturing) return;
  capturing = false;
  manualHooks = null;
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
  drainFramesInBackground();
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
    // Phase F: extract + PREVIEW the fixture graph topology on the map view.
    // The user tunes the extraction params (live overlay) and uploads it to the
    // player explicitly (topo-upload), which then enables the pulse effect.
    resultMap = map;
    resultMapId = mapId;
    playEffectBtn.style.display = "none";
    playFloodBtn.style.display = "none";
    effectControls.style.display = "none";
    activeEffect = null;
    refreshEffectButtons();
    topoControls.style.display = map.leds.length >= 2 ? "" : "none";
    previewTopology();
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
