/**
 * Camera mapping screen (design doc §4.2 / §7.4) — the capture loop from
 * main.ts, extracted close to verbatim and re-parented into the new full-screen
 * layout. Behavior is UNCHANGED: probe → negotiate → per-frame detect/decode →
 * stream detections → live map/status polls → manual override → stop → final
 * solve (phone wasm vs host, chooseSolvePlacement). The ONLY new tail is saving
 * the solved result to MapStore.create and navigating to Map Detail (no
 * separate Result screen — the workspace is the result).
 *
 * Record-as-long-as-you-want is preserved: capture runs until Stop; no cap on
 * duration/observations, no app-side pruning — the only filtering is the
 * solver's own outlier rejection. Every DetectionRecord is streamed to the
 * device and retained locally (localDetections/localImu) exactly as today.
 */

import type { CodeParams, DetectionRecord, ImuSample, LedEntry, OutputMap } from "@ledmapper/protocol";
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
} from "../../cv/exposure";
import { CapturePerf, formatPerfLine, formatPhaseLine } from "../../cv/capturePerf";
import { CvPipeline } from "../../cv/pipeline";
import { DetectorGL } from "../../cv/detect";
import {
  type DriverCaptureResult,
  type DriverDecodeStats,
  driverActive,
  registerDriverCapture,
  driverFixtureScene,
  setDriverCaptureError,
} from "../../driver/guard";
import { phaseCount as stridePhaseCount } from "../../code/stride";
import {
  fillChannelGaps,
  planChannelCapture,
  shouldAdvanceStage,
  stageCoverage,
  stageLabel,
  type ChannelCapturePlan,
} from "../../capture/channelCapture";
import { CaptureUnsupportedError } from "../../xr/capture";
import { DEFAULT_IMU_MAPPING, ImuRecorder, parseImuMapping } from "../../xr/imu";
import { MediaStreamCaptureSource } from "../../xr/mediaStreamCapture";
import { SyntheticCaptureSource } from "../../xr/syntheticCaptureSource";
import {
  NativeCaptureSource,
  nativeCaptureAvailable,
  nativeLog,
  saveSessionLog,
} from "../../xr/nativeCaptureSource";
import { SolverAgent, type SolveSnapshot, type SolveStats } from "../../solver/agent";
import { chooseSolvePlacement } from "../../solver/placement";
import { LabelOverlay } from "../labels";
import { ProjectionOverlay, type Registration } from "../projectionOverlay";
import { overlayLegend } from "../overlayStyle";
import { LIVE_SOLVE_OPTIONS, LiveSolveScheduler } from "../../solver/liveSolve";
import type { SolveDiag, SolveProblem } from "../../solver/agent";
import {
  buildBundle,
  deviceInfo,
  InterimLog,
  shouldLogRun,
  type BundleFrame,
  type CaptureBundle,
  type CaptureParamsSnapshot,
} from "../../solver/captureBundle";
import { assessMap, decideFinal, observableLeds, type FinalDecision } from "../../solver/degeneracy";
import { debugModeEnabled } from "../../store/debugMode";
import { bundleIncludeFrames, bundleKeepSuccessful, captureBundleStore } from "../../store/captureBundleStore";
import { appBuildInfo } from "../../buildInfo";
import { MapView } from "../mapview";
import { prefs } from "../../store/prefs";
import { deviceStore, DEFAULT_CAPTURE_STRIDE } from "../../store/deviceStore";
import { mapStore, type CaptureObservations } from "../../store/mapStore";
import { recenterToCentroid } from "../../geom/mapTransform";
import { concatObservations, fuseMaps } from "../../geom/fuseMaps";
import { liveUnion } from "../../geom/liveUnion";
import { appState } from "../app/state";
import { ImuCalFlow, POSES_REQUIRED, describeSolve, type FlowStatus } from "../../capture/imuCalSession";
import type { ExtrinsicSolve } from "../../geom/imuExtrinsic";
import { deviceKeyOf, imuCalPending, writeAndVerify, type PendingImuCal } from "../../capture/imuCalWriteback";
import {
  applyProfile,
  buildProfile,
  captureSettingsNote,
  postMappingPose,
  profileForMap,
  type CaptureKnobs,
  type ProfiledRun,
} from "../../capture/captureProfile";
import { Button, IconButton, Slider, toast } from "../kit";
import type { Router, Screen } from "../app/router";

const qs = new URLSearchParams(location.search);
function numParam(name: string, dflt: number): number {
  const v = qs.get(name);
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

// Diffuse-capture mode (design: diffuse_capture): the fixture is behind a
// diffuser, so blink LEDs on a spatial STRIDE (only a sparse, non-overlapping
// subset per epoch; the phone rotates the phase to cover all LEDs) AND run the
// detector's local-contrast prefilter with a LOW threshold (local adaptive
// detection) to recover the diffuser-dimmed, low-derivative spots.
//
// The mode and its knobs are now PERSISTED settings, not just URL params: the
// diffuse toggle + capture-engine params live in Behavior Settings (app-global)
// and the stride lives on the device (per-fixture), so re-mapping never requires
// re-typing them. The URL power-user params remain as per-run overrides on top.
interface CaptureEngineConfig {
  diffuse: boolean;
  /** Threshold was pinned on the URL -> keep the servo from moving it. */
  forcedThreshold: boolean;
  strideSpacing: number;
  anchorDensity: number;
  detectorOpts: {
    threshold: number;
    downscale: number;
    flipV: boolean;
    localContrast?: { gain: number };
  };
}

/** Resolve the effective capture-engine config for a run: persisted settings
 * (per-device stride from the active device; the rest from Behavior Settings)
 * with the URL params overriding on top. Recomputed per capture so a settings
 * change takes effect on the next map without a reload. */
function resolveCaptureConfig(forceDiffuse?: boolean): CaptureEngineConfig {
  const bp = prefs.getDiffuseParams();
  // Diffuse mode: ?diffuse=1 forces it on; otherwise the persisted toggle. A
  // per-channel capture stage (capture/channelCapture.ts) decides it outright.
  const diffuse = forceDiffuse ?? (qs.get("diffuse") === "1" || prefs.getDiffuseEnabled());
  const forcedThreshold = qs.get("threshold") !== null;
  // Stride is per-device (Hardware Setup); URL ?stride= overrides, else default.
  const activeId = deviceStore.activeId();
  const deviceStride = activeId ? deviceStore.getCaptureStride(activeId) : undefined;
  const strideSpacing = Math.max(
    1,
    Math.floor(numParam("stride", deviceStride ?? DEFAULT_CAPTURE_STRIDE)),
  );
  const anchorDensity = Math.max(3, Math.floor(numParam("anchor", bp.anchorDensity)));
  const detectorOpts = {
    // Non-diffuse capture keeps its 0.6 default + servo; the persisted diffuse
    // threshold only steers diffuse mode.
    threshold: numParam("threshold", diffuse ? bp.threshold : 0.6),
    downscale: numParam("downscale", bp.downscale),
    flipV: qs.get("flipv") !== null ? qs.get("flipv") !== "0" : bp.flipV,
    ...(diffuse ? { localContrast: { gain: numParam("lcgain", bp.lcGain) } } : {}),
  };
  return { diffuse, forcedThreshold, strideSpacing, anchorDensity, detectorOpts };
}
/**
 * The per-channel capture plan for the active device (a dense curtain on one
 * channel + a strided rope on another, capture/channelCapture.ts), or null to
 * capture exactly as today: no per-channel profile set on Hardware Setup, or
 * the device's channel layout can't be read.
 */
async function resolveChannelPlan(c: {
  getHardwareConfig(): Promise<{ channels: { channel: number; ledCount: number }[] }>;
}): Promise<ChannelCapturePlan | null> {
  const id = deviceStore.activeId();
  const profiles = id ? deviceStore.getChannelCaptures(id) : undefined;
  if (!profiles) return null;
  try {
    const st = await c.getHardwareConfig();
    const counts: number[] = [];
    for (const ch of st.channels) {
      if (ch.channel >= 0 && ch.channel < 64) counts[ch.channel] = Math.max(0, ch.ledCount || 0);
    }
    for (let i = 0; i < counts.length; i++) counts[i] ??= 0;
    return planChannelCapture(counts, profiles);
  } catch (e) {
    nativeLog(`[capture] channel layout unavailable (${e instanceof Error ? e.message : String(e)})`);
    toast("Couldn't read the channel layout — capturing every LED as one strip", { error: true });
    return null;
  }
}

const imuMapping = parseImuMapping(qs.get("imumap") ?? "") ?? DEFAULT_IMU_MAPPING;
const forcedFx = ((): number | null => {
  const v = parseFloat(qs.get("fx") ?? "");
  return Number.isFinite(v) && v > 0 ? v : null;
})();
const forcedSymbols = ((): 2 | 4 | null => {
  const v = qs.get("symbols");
  return v === "2" ? 2 : v === "4" ? 4 : null;
})();
const forcedBitMs = ((): number | null => {
  const v = parseFloat(qs.get("bitms") ?? "");
  return Number.isFinite(v) && v > 0 ? v : null;
})();
const forcedBrightness = ((): number | null => {
  const v = parseFloat(qs.get("brightness") ?? "");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
})();
const servoExposure = qs.get("exposure") === "servo";
// Interim phone solves during capture feed the live overlay on devices without
// a host solver (FUG-112); `?livesolve=0` turns them off.
const liveSolveEnabled = qs.get("livesolve") !== "0";
/** Options for the FINAL phone-side solves (standalone + supplemental joint).
 * The strip prior (Settings ▸ Capture) is off for the interim live solves:
 * they drive the overlay, and their LED sets are too partial to estimate a
 * pitch from. `?stripprior=0|1` overrides the setting for one session. */
function finalSolveOptions(perChannel = false): NonNullable<SolveProblem["options"]> {
  const forced = qs.get("stripprior");
  // A per-channel capture mixes fixtures with different LED pitches (curtain vs
  // rope) in one index space; the strip prior estimates ONE pitch and chains
  // across the channel boundary, so it is off there unless forced (the gaps
  // are filled per channel after the solve instead).
  const on = forced === null ? prefs.getStripPrior() && !perChannel : forced === "1";
  return on ? { stripPrior: true } : {};
}
const forcedExposure = ((): number | null => {
  const v = parseFloat(qs.get("exposure") ?? "");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
})();


/** A throwaway WebGL2 context for DetectorGL on the native iOS path, where frames
 * arrive already reduced and its GPU pass never runs. Cheaper than reshaping the
 * detector around a context-free mode that only one platform needs. */
function offscreenGl(): WebGL2RenderingContext {
  const c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  const gl = c.getContext("webgl2");
  if (!gl) throw new CaptureUnsupportedError("WebGL2 is unavailable.", []);
  return gl;
}

/** Undo the transparency the native preview layer needs (see the capture start
 * path). A no-op on the getUserMedia path, which never set it. */
function restorePageBackground(): void {
  document.documentElement.style.background = "";
  document.body.style.background = "";
}

export function CaptureScreen(router: Router, routeQuery?: URLSearchParams): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--capture";

  // Effective capture-engine config for this run: persisted settings (per-device
  // stride + app-global diffuse params) with URL params overriding. The inline
  // diffuse toggle below re-reads this if the user flips it before starting.
  let { diffuse, forcedThreshold, strideSpacing, anchorDensity, detectorOpts } =
    resolveCaptureConfig();

  // The New-map dialog passes the chosen strip length in the hash query
  // (#/capture?leds=N); it wins over the location.search power-user override,
  // the device welcome default, and the fallback (FUG-62).
  const routeLeds = ((): number | null => {
    const v = parseInt(routeQuery?.get("leds") ?? "", 10);
    return Number.isFinite(v) && v >= 1 ? v : null;
  })();

  // Supplemental capture (FUG-112): when set, this session is fused into the
  // named library map instead of creating a new one. The prior map + its
  // observations are loaded at mount.
  const supplementId = routeQuery?.get("supplement") ?? null;
  // "Calibrate IMU" (sensor-core.md §7.3): re-localise against this map with the
  // code playing and take three still poses hands-free — no map solve; the IMU
  // extrinsic is solved, written to the device and recorded on the map.
  const calibrateId = supplementId === null ? (routeQuery?.get("calibrate") ?? null) : null;
  let calFlow: ImuCalFlow | null = null;
  let priorMap: OutputMap | null = null;
  // The stored map's capture profile, when this run re-captures a mapped
  // fixture (supplement / IMU re-localisation): reused instead of re-asking or
  // re-probing (sensor-core.md §7.5).
  let profileRun: ProfiledRun | null = null;
  // What this run used, recorded on the device after a successful first map.
  let profileDraft: {
    knobs: CaptureKnobs;
    symbols?: number;
    bitPeriodMs: number;
    brightness?: number;
    exposure?: number;
  } | null = null;
  // The stride is pinned (a stored profile or the calibrate screen's control
  // chose it): a diffuse toggle must keep it rather than re-reading the device
  // default (that silently dropped a profile's stride).
  let strideLocked = false;
  // Set while mapping: fold the live knobs into profileDraft.
  let noteDraft: () => void = () => undefined;
  let priorObs: CaptureObservations | null = null;

  // -- full-screen layout (design doc §4.2). The camera <video> is prepended to
  // <body> by the capture source (fixed, inset:0) as in main.ts; the HUD, live
  // inset, advanced controls and stop button live in this overlay.
  const overlay = document.createElement("div");
  overlay.className = "capture-overlay";

  const labelsCanvas = document.createElement("canvas");
  labelsCanvas.className = "capture-labels";

  // The registered 3D layer: solved LED positions projected into the viewport
  // (FUG-112). Sits over the video alongside the 2D-track labels.
  const projCanvas = document.createElement("canvas");
  projCanvas.className = "capture-proj";

  const topBar = document.createElement("div");
  topBar.className = "capture-topbar";
  const backBtn = IconButton("back", { title: "Cancel", onClick: () => void cancel() });
  const countEl = document.createElement("span");
  countEl.className = "capture-count metric";
  const timerEl = document.createElement("span");
  timerEl.className = "capture-timer metric";
  topBar.append(backBtn, countEl, timerEl);

  const liveCanvas = document.createElement("canvas");
  liveCanvas.className = "capture-live";
  liveCanvas.width = 480;
  liveCanvas.height = 360;
  liveCanvas.style.display = "none";
  liveCanvas.addEventListener("click", () => el.classList.toggle("capture--livebig"));

  const guideEl = document.createElement("div");
  guideEl.className = "capture-guide metric";
  guideEl.textContent = "Walk a slow arc around the fixture — sideways steps, not toward it.";

  // -- layer toggles + pose-reacquisition chip (FUG-112). The two viewport
  // layers (2D tracks, registered 3D solve) can each be isolated during the
  // scan; the chip reports whether client-side PnP has locked onto the map.
  let showTracks = true;
  let showSolved = true;
  // 1-σ rings on the solved layer (ProjectionOverlay.showRings) — opt-in.
  let showRings = false;
  const layerBar = document.createElement("div");
  layerBar.className = "capture-layers";
  const layerToggle = (label: string, on: boolean, onChange: (v: boolean) => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "capture-layerbtn";
    b.textContent = label;
    const set = (v: boolean): void => {
      b.classList.toggle("capture-layerbtn--on", v);
      b.setAttribute("aria-pressed", String(v));
    };
    set(on);
    b.addEventListener("click", () => {
      const v = !b.classList.contains("capture-layerbtn--on");
      set(v);
      onChange(v);
    });
    return b;
  };
  const regChip = document.createElement("span");
  regChip.className = "capture-regchip";
  regChip.style.display = "none";
  layerBar.append(
    layerToggle("Tracks", showTracks, (v) => {
      showTracks = v;
      labelsCanvas.style.display = v ? "" : "none";
      if (!v) labels.clear();
    }),
    layerToggle("Solved", showSolved, (v) => {
      showSolved = v;
      projCanvas.style.display = v ? "" : "none";
      if (!v) projOverlay.clear();
      syncLegend();
    }),
    layerToggle("Error rings", showRings, (v) => {
      showRings = v;
      projOverlay.showRings = v;
      syncLegend();
    }),
    regChip,
  );
  // Legend for the solved layer's encoding (provenance = hue+shape, variance =
  // fill+ring). A first-time capture only has "this scan" LEDs.
  const legendEl = overlayLegend(supplementId !== null ? ["base", "scan", "updated"] : ["scan"]);
  legendEl.style.display = "none";
  function syncLegend(): void {
    legendEl.style.display = showSolved && projOverlay.solvedCount > 0 ? "" : "none";
    const ringNote = legendEl.querySelector<HTMLElement>(".capture-legend-note");
    if (ringNote) ringNote.style.display = showRings ? "" : "none";
  }

  // -- supplemental review panel (FUG-112): after the fused solve, the user
  // sees the result in the live inset and Accepts or Rejects it.
  const reviewPanel = document.createElement("div");
  reviewPanel.className = "capture-review";
  reviewPanel.style.display = "none";
  const reviewText = document.createElement("div");
  reviewText.className = "capture-review-text metric";
  const reviewBtns = document.createElement("div");
  reviewBtns.className = "capture-review-btns";
  reviewPanel.append(reviewText, reviewBtns);

  // Advanced disclosure: manual exposure / brightness override (was cap-controls)
  // and the dense HUD line, collapsed by default (design doc §2.7).
  const advWrap = document.createElement("div");
  advWrap.className = "capture-advanced";
  const advToggle = document.createElement("button");
  advToggle.type = "button";
  advToggle.className = "capture-adv-toggle";
  advToggle.textContent = "▸ Advanced";
  const advBody = document.createElement("div");
  advBody.className = "capture-adv-body";
  advBody.style.display = "none";
  advToggle.addEventListener("click", () => {
    const open = advBody.style.display === "none";
    advBody.style.display = open ? "" : "none";
    advToggle.textContent = open ? "▾ Advanced" : "▸ Advanced";
  });
  const hudStats = document.createElement("div");
  hudStats.className = "capture-hud metric";
  advWrap.append(advToggle, advBody);

  const stopBtn = Button({ label: "Stop & finish", icon: "camera", onClick: () => void stopCapture() });
  stopBtn.classList.add("capture-stop");
  // Per-channel capture: skip ahead from the regular stage (e.g. the curtain)
  // to the strided one (the rope) without waiting for the auto hand-over.
  let nextStageHook: (() => void) | null = null;
  // This run's per-channel plan (null = a plain capture); the solved map is
  // gap-filled per channel with it before it is pushed / saved.
  let runChannelPlan: ChannelCapturePlan | null = null;
  const nextStageBtn = Button({ label: "Next channel ▶", variant: "quiet", onClick: () => nextStageHook?.() });
  nextStageBtn.classList.add("capture-next-stage");
  nextStageBtn.style.display = "none";

  // Solve progress (shown on Stop; interim map renders in the live inset).
  const progWrap = document.createElement("div");
  progWrap.className = "capture-solveprog";
  progWrap.style.display = "none";
  const progFill = document.createElement("div");
  progFill.className = "capture-solveprog-fill";
  const progText = document.createElement("div");
  progText.className = "capture-solveprog-text metric";
  const progBar = document.createElement("div");
  progBar.className = "capture-solveprog-bar";
  progBar.append(progFill);
  progWrap.append(progBar, progText);

  // Calibrate-IMU panel (only in ?calibrate= mode).
  const calPanel = document.createElement("div");
  calPanel.className = "capture-review";
  calPanel.style.display = "none";
  // Hands-free: a pose is taken when the map registers and everything holds
  // still; there is no capture or accept button (sensor-core.md §7.3).
  const calSteps = document.createElement("div");
  calSteps.className = "capture-cal-steps";
  const calDots: HTMLElement[] = [];
  for (let i = 0; i < POSES_REQUIRED; i++) {
    const d = document.createElement("span");
    d.className = "capture-cal-dot";
    d.textContent = String(i + 1);
    calDots.push(d);
    calSteps.append(d);
  }
  const calPrompt = document.createElement("div");
  calPrompt.className = "capture-cal-prompt";
  const calText = document.createElement("div");
  calText.className = "capture-review-text metric";
  calText.dataset["testid"] = "imucal-status";
  const calBtns = document.createElement("div");
  calBtns.className = "capture-review-btns";
  const calRetakeBtn = Button({ label: "Retake", icon: "reset", variant: "quiet", onClick: () => calRetake() });
  const calDoneBtn = Button({ label: "Done", icon: "check", onClick: () => void stopCapture() });
  calBtns.append(calRetakeBtn, calDoneBtn);
  calBtns.style.display = "none";
  calPanel.append(calSteps, calPrompt, calText, calBtns);

  overlay.append(
    calPanel,
    labelsCanvas,
    projCanvas,
    topBar,
    layerBar,
    legendEl,
    liveCanvas,
    advWrap,
    hudStats,
    guideEl,
    reviewPanel,
    progWrap,
    stopBtn,
    nextStageBtn,
  );
  el.append(overlay);

  // -- manual exposure/brightness override (in-capture). Same semantics as
  // main.ts: the toggle freezes both servos and the sliders drive exposure/
  // brightness directly; while auto, the sliders track the servo.
  let manualMode = false;
  let manualHooks: {
    applyBrightness: (b01: number) => void;
    applyExposure: (e01: number) => void;
  } | null = null;
  // Set while capturing: switch the RUNNING capture between strided (diffuse)
  // and dense capture (the inline toggle below).
  let diffuseHook: ((on: boolean) => void) | null = null;
  const brightSlider = Slider({
    label: "LED brightness",
    min: 5,
    max: 100,
    step: 1,
    value: 100,
    format: (v) => `${Math.round(v)}%`,
    onInput: () => undefined,
  });
  const expSlider = Slider({
    label: "Camera exposure",
    min: 0,
    max: 1,
    step: 0.02,
    value: 0.25,
    format: (v) => v.toFixed(2),
    onInput: () => applyManualExposure(false),
  });
  const modeBtn = Button({
    label: "Manual override",
    variant: "quiet",
    onClick: () => setManualMode(!manualMode),
  });

  // Inline diffuse/strided-capture toggle (design: diffuse_capture). Flipping it
  // persists to Behavior Settings so re-mapping a diffused fixture never needs
  // the ?diffuse=1 URL param again; the stride comes from the device's Hardware
  // Setup, the other engine params from Behavior Settings. A ?diffuse=1 URL param
  // still force-enables it at the start of a run. Saved immediately; a flip
  // before the map starts applies to this run, and a flip mid-capture switches
  // the running capture live (device stride + phase rotation + detector).
  let mappingStarted = false;
  const diffuseLabel = (): string => `Diffuse capture: ${prefs.getDiffuseEnabled() ? "On" : "Off"}`;
  const diffuseBtn = Button({
    label: diffuseLabel(),
    variant: "quiet",
    onClick: () => {
      const on = !prefs.getDiffuseEnabled();
      prefs.setDiffuseEnabled(on);
      const span = diffuseBtn.querySelector("span");
      if (span) span.textContent = diffuseLabel();
      if (diffuseHook !== null) {
        // Mid-capture: the running capture owns its config — switch it live
        // rather than re-resolving the variables out from under it (which
        // used to stop the phase rotation while the device stayed strided).
        diffuseHook(on);
        toast(`Switching to ${on ? "strided (diffuse)" : "dense"} capture…`);
        return;
      }
      // Before the map starts: re-resolve so the flip applies to this run —
      // keeping a pinned stride (stored profile / the calibrate control).
      const keep = { strideSpacing, anchorDensity };
      ({ diffuse, forcedThreshold, strideSpacing, anchorDensity, detectorOpts } =
        resolveCaptureConfig());
      if (strideLocked) ({ strideSpacing, anchorDensity } = keep);
      updateCalSettingsNote();
      toast(`Diffuse capture ${on ? "on" : "off"}`);
    },
  });

  // LED stride for strided (diffuse) capture: the calibrate screen exposes it
  // (a map without saved capture settings must be correctable here).
  let strideHook: ((spacing: number) => void) | null = null;
  const strideSlider = Slider({
    label: "LED stride (diffuse)",
    min: 1,
    max: 16,
    step: 1,
    value: strideSpacing,
    format: (v) => `${Math.round(v)}`,
    onInput: () => undefined,
  });
  strideSlider.input.addEventListener("change", () => {
    const v = Math.max(1, Math.round(parseFloat(strideSlider.input.value)));
    strideLocked = true;
    if (strideHook !== null && diffuse) {
      strideHook(v);
    } else {
      strideSpacing = v;
    }
    updateCalSettingsNote();
  });

  advBody.append(diffuseBtn, modeBtn, brightSlider.el, expSlider.el, hudStats);
  // Calibrate IMU: the capture controls live IN the calibration panel, always
  // visible (manual exposure / LED brightness matter in varying light while the
  // auto servo is unreliable), with a note on where the settings came from.
  const calSettings = document.createElement("div");
  calSettings.className = "capture-cal-settings";
  const calSettingsNote = document.createElement("div");
  calSettingsNote.className = "capture-review-text metric";
  if (calibrateId !== null) {
    // Visible from the start: the settings matter BEFORE the code starts (the
    // light probe and the first poses run with them).
    calPanel.style.display = "";
    calPanel.classList.add("capture-cal");
    advWrap.style.display = "none"; // its controls moved into the panel
    calPrompt.textContent = "Starting the mapping code…";
    calSettings.append(calSettingsNote, diffuseBtn, strideSlider.el, modeBtn, brightSlider.el, expSlider.el);
    calPanel.insertBefore(calSettings, calBtns);
  }
  function updateCalSettingsNote(): void {
    if (calibrateId === null) return;
    calSettingsNote.textContent = captureSettingsNote(profileRun, {
      diffuse,
      strideSpacing,
      anchorDensity,
      threshold: detectorOpts.threshold,
      downscale: detectorOpts.downscale,
    });
    strideSlider.input.value = String(strideSpacing);
    strideSlider.setValueText(String(strideSpacing));
    strideSlider.el.style.display = diffuse ? "" : "none";
  }
  brightSlider.input.addEventListener("change", () => {
    if (!manualMode && calibrateId !== null) setManualMode(true);
    if (manualMode) manualHooks?.applyBrightness(parseInt(brightSlider.input.value, 10) / 100);
  });
  expSlider.input.addEventListener("input", () => {
    if (!manualMode && calibrateId !== null) {
      setManualMode(true);
      applyManualExposure(true);
    }
  });
  let lastExpApply = 0;
  function applyManualExposure(final: boolean): void {
    if (!manualMode) return;
    const now = performance.now();
    if (!final && now - lastExpApply < 120) return;
    lastExpApply = now;
    manualHooks?.applyExposure(parseFloat(expSlider.input.value));
  }
  expSlider.input.addEventListener("change", () => applyManualExposure(true));
  function setManualMode(on: boolean): void {
    manualMode = on;
    // On the calibrate screen the sliders stay visible (they track the servo
    // while it runs; touching one takes manual control).
    const show = on || calibrateId !== null;
    brightSlider.el.style.display = show ? "" : "none";
    expSlider.el.style.display = show ? "" : "none";
    modeBtn.querySelector("span")!.textContent = on ? "Back to servo" : "Manual override";
  }
  function syncManualSliders(brightness01: number, exposure01: number): void {
    if (manualMode) return;
    brightSlider.input.value = String(Math.round(brightness01 * 100));
    brightSlider.setValueText(`${Math.round(brightness01 * 100)}%`);
    expSlider.input.value = exposure01.toFixed(2);
    expSlider.setValueText(exposure01.toFixed(2));
  }
  setManualMode(false);

  // -- session state ---------------------------------------------------------
  const labels = new LabelOverlay(labelsCanvas);
  const projOverlay = new ProjectionOverlay(projCanvas);
  projOverlay.showRings = showRings;
  const solverAgent = new SolverAgent();
  const solverReady: Promise<boolean> = solverAgent.init().then((ok) => {
    if (ok) console.info(`wasm solver ready: benchmark ${solverAgent.benchMs?.toFixed(0)} ms`);
    return ok;
  });
  let capture: MediaStreamCaptureSource | NativeCaptureSource | SyntheticCaptureSource | null = null;
  // Set only on the iOS native path; used to push detect params down and to undo
  // the page transparency the native preview layer needs.
  let nativeSource: NativeCaptureSource | null = null;
  // Set only under the HITL app-driver (?driver=): a hardware-free synthetic scene.
  let syntheticSource: SyntheticCaptureSource | null = null;
  let capturing = false;
  let imuRecorder: ImuRecorder | null = null;
  let previewVideo: HTMLVideoElement | null = null;
  let liveView: MapView | null = null;
  let liveLeds: readonly LedEntry[] = [];
  let liveSolvedText = "";
  // The overlay's current display map: the base map ∪ this session's live
  // solve (geom/liveUnion), in the base frame (supplement) or a stabilized live
  // frame (first capture). Also what the live inset shows.
  let displayMap: OutputMap | null = null;
  // Camera focal length (px) from the latest frame — for the σ model.
  let focalPx: number | undefined;
  // Interim phone solves (no host solver), see solver/liveSolve.
  let liveSolver: LiveSolveScheduler | null = null;
  // Every interim (live-preview) solve of this run, phone or host: the best
  // one warm-starts the final solve and is the fallback if the final comes
  // back degenerate; the bundle keeps it + the last few (solver/captureBundle).
  let interimLog = new InterimLog();
  // This run's capture parameters, read at the end (the closure sees the live
  // servo / reconfigure state). Null before capture starts.
  let runParams: (() => CaptureParamsSnapshot) | null = null;
  // The final solve's exact input and raw outcome, and the decision on which
  // map the run keeps — the capture bundle's core (debug mode).
  let runProblem: SolveProblem | null = null;
  let runFinal: CaptureBundle["final"] = { map: null, diag: null, error: null, assessment: null, timing: null };
  let runDecision: FinalDecision | null = null;
  let runSupplement: CaptureBundle["supplement"] = null;
  // Opt-in downsampled camera frames for the bundle (getUserMedia path only).
  let bundleFrames: BundleFrame[] = [];
  // Hot-loop + live-solver perf counters for the current capture (cv/capturePerf).
  let perf: CapturePerf | null = null;
  let localDetections: DetectionRecord[] = [];
  let localImu: ImuSample[] = [];
  let lastLedCount = 64;
  let startedAt = 0;
  let timerTick: number | null = null;
  // Under the HITL app-driver only: the pending finish() the harness is awaiting,
  // resolved with the solved-map summary once stopCapture() finishes the solve.
  let driverSolveResolve: ((r: DriverCaptureResult) => void) | null = null;
  let driverSolveReject: ((e: unknown) => void) | null = null;
  // Live decode health for the harness (the same numbers the HUD shows).
  let driverDecodeStats: DriverDecodeStats = { ids: 0, total: 0, tracks: 0, observations: 0 };

  function client() {
    return appState.client;
  }

  function resetLiveFeedback(): void {
    liveView?.stop();
    liveView = null;
    liveLeds = [];
    liveSolvedText = "";
    displayMap = null;
    void liveSolver?.stop();
    liveSolver = null;
    liveCanvas.style.display = "none";
    labels.clear();
    projOverlay.clear();
    projOverlay.setSolved([]);
    regChip.style.display = "none";
    syncLegend();
  }

  /**
   * Feed the overlay (and the live inset) with the union of the base map and
   * this session's latest live solve (FUG-112). `live` is null to show the base
   * map alone (start of a supplemental scan). Runs on every live update, from
   * the host's continuous solver or the phone's interim solves alike.
   */
  function applyLiveSolve(live: OutputMap | null): void {
    const u = liveUnion(priorMap, live, displayMap, focalPx);
    if (u.frameReset) projOverlay.reset();
    projOverlay.setSolved(u.leds, u.spacingM);
    displayMap = u.map;
    syncLegend();
    if (live !== null) {
      liveSolvedText =
        priorMap !== null
          ? ` · scan solved ${live.leds.length}`
          : ` · solved ${live.leds.length}/${live.ledCount}`;
      // Supplement: say whether the new scan has registered into the map yet,
      // and what it is adding.
      if (priorMap !== null && u.note) guideEl.textContent = u.note;
    }
    if (u.map !== null && u.map.leds.length > 0) {
      liveCanvas.style.display = "block";
      if (liveView === null) {
        liveView = new MapView(liveCanvas, u.map);
        liveView.start();
      } else {
        liveView.update(u.map);
      }
    }
  }

  /** Reflect the pose-reacquisition state in the HUD chip (FUG-112). */
  function updateRegChip(reg: Registration): void {
    regChip.style.display = "";
    regChip.textContent = reg.label;
    regChip.classList.remove("capture-regchip--locked", "capture-regchip--weak", "capture-regchip--lost");
    regChip.classList.add(`capture-regchip--${reg.tone}`);
  }

  // -- Calibrate IMU (sensor-core.md §7.3) ------------------------------------------
  // Hands-free. The frame loop feeds calFlow every PnP lock (pushFrame), the
  // IMU tick feeds the phone's gravity, and one get_sensors reader feeds the
  // fixture's settled up — all on the phone's performance.now() clock. A step
  // timer evaluates the gates; the step that passes them takes the pose, and the
  // third pose solves, stores, writes and read-back-verifies the calibration.
  let calActive = false;
  /** Bumped per start: a reader from an earlier start (before a Retake) exits. */
  let calGen = 0;
  let calStepTimer: ReturnType<typeof setInterval> | null = null;
  let calReader: Promise<void> | null = null;
  let calFinishing = false;
  let calAutoExit: ReturnType<typeof setTimeout> | null = null;
  const calSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  function stopCalibrationUi(): void {
    calActive = false;
    if (calStepTimer !== null) clearInterval(calStepTimer);
    calStepTimer = null;
    if (calAutoExit !== null) clearTimeout(calAutoExit);
    calAutoExit = null;
  }

  function startCalibrationUi(c: NonNullable<ReturnType<typeof client>>): void {
    stopCalibrationUi();
    calPanel.style.display = "";
    calBtns.style.display = "none";
    calFinishing = false;
    calActive = true;
    const gen = ++calGen;
    const live = () => calActive && gen === calGen;
    // One get_sensors in flight at a time (never a timer that can overlap),
    // each reply stamped with its arrival on the phone clock.
    const reader = (async () => {
      while (live() && calFlow !== null && !calFlow.done) {
        try {
          const s = await c.getSensors();
          if (!live() || calFlow === null) break;
          calFlow.pushSensor(s, performance.now());
        } catch {
          // A timeout / a dropped link: keep trying while the screen is up.
          await calSleep(c.isConnected ? 100 : 500);
        }
        await calSleep(120);
      }
    })();
    calReader = reader;
    calStepTimer = setInterval(() => {
      if (calFlow === null || calFinishing) return;
      renderCal(calFlow.step(performance.now()));
    }, 100);
  }

  function renderCal(st: FlowStatus): void {
    calDots.forEach((d, i) => {
      d.classList.toggle("capture-cal-dot--done", i < st.taken);
      d.classList.toggle("capture-cal-dot--next", i === st.taken && st.phase === "collecting");
    });
    if (st.captured) {
      try {
        navigator.vibrate?.(60);
      } catch {
        /* no haptics */
      }
      const p = st.captured;
      const line =
        `[imucal] pose ${st.taken}: imuUp=${p.imuUp.map((v) => v.toFixed(3)).join(",")} ` +
        `fixtureUp=${p.fixtureUp.map((v) => v.toFixed(3)).join(",")} sigma=${(p.sigmaDeg ?? 0).toFixed(2)}deg`;
      console.info(line);
      nativeLog(line);
      if (st.phase === "collecting") toast(`Pose ${st.taken} of ${POSES_REQUIRED} captured`);
    }
    if (st.phase === "solved" && st.solve !== null) {
      void finishCalibration(st.solve);
      return;
    }
    calPrompt.textContent = st.prompt;
    calText.textContent = st.wait ? st.wait.text : "Hold still…";
    calText.dataset["tone"] = st.wait?.reason === "inconsistent" ? "warn" : "";
  }

  /** After the third pose: store on the map, keep it pending for this device,
   * write it and confirm by read-back (no accept step). */
  async function finishCalibration(sol: ExtrinsicSolve): Promise<void> {
    const flow = calFlow;
    if (calFinishing || flow === null) return;
    calFinishing = true;
    stopCalibrationUi();
    await calReader?.catch(() => undefined);
    const c = client();
    const atMs = Date.now();
    calPrompt.textContent = "Writing the calibration to the fixture…";
    calText.textContent = describeSolve(sol);
    calText.dataset["tone"] = "";
    console.info(`[imucal] solved: q=${sol.q.map((v) => v.toFixed(4)).join(",")} ${describeSolve(sol)}`);
    if (calibrateId !== null) {
      await mapStore
        .setImuCalibration(calibrateId, {
          q: sol.q,
          poses: [...flow.poses],
          yawResolved: sol.yawResolved,
          residualDeg: sol.residualDeg,
          atMs,
        })
        .catch(() => undefined);
    }
    const pending: PendingImuCal = {
      deviceKey: deviceKeyOf(c?.welcome?.mac),
      mapId: priorMap?.mapId ?? "",
      q: sol.q,
      residualDeg: sol.residualDeg,
      poses: flow.poses.length,
      yawResolved: sol.yawResolved,
      atMs,
    };
    // Pending BEFORE the write: a drop mid-write is pushed on the next connection.
    imuCalPending.put(pending);
    const out = c !== null ? await writeAndVerify(c, pending) : ({ kind: "failed", detail: "not connected" } as const);
    if (out.kind === "confirmed") imuCalPending.clear(pending.deviceKey, atMs);
    console.info(`[imucal] write-back: ${out.kind}${"detail" in out ? ` (${out.detail})` : ""}`);
    // What worked here becomes the map's capture profile (device + library), so
    // the next calibration / supplement starts from it.
    noteDraft();
    if (c !== null && profileDraft !== null && priorMap !== null && calibrateId !== null) {
      const p = buildProfile(priorMap.mapId, profileDraft.knobs, profileDraft, Date.now());
      await mapStore.setCaptureProfile(calibrateId, p).catch(() => {});
      await c.setCaptureProfile(p).catch(() => {});
    }
    calDots.forEach((d) => d.classList.add("capture-cal-dot--done"));
    calBtns.style.display = "";
    const good = sol.quality === "good";
    if (out.kind === "confirmed") {
      calPrompt.textContent = good ? "Motion sensor calibrated ✓" : "Calibrated, but the fit is weak — consider a retake.";
      calText.textContent = `${describeSolve(sol)} · stored on the fixture`;
      calText.dataset["tone"] = good ? "ok" : "warn";
      toast("Motion sensor calibrated to this map");
      if (good) calAutoExit = setTimeout(() => void stopCapture(), 2500);
    } else if (out.kind === "failed") {
      calPrompt.textContent = "Saved on this phone — it will be written to the fixture when it reconnects.";
      calText.textContent = `${describeSolve(sol)} · not yet on the fixture (${out.detail})`;
      calText.dataset["tone"] = "warn";
    } else {
      calPrompt.textContent = "The fixture didn't confirm the calibration; it will be retried on the next connection.";
      calText.textContent = `${describeSolve(sol)} · ${out.detail}`;
      calText.dataset["tone"] = "warn";
    }
  }

  function calRetake(): void {
    const c = client();
    if (calFlow === null || c === null) return;
    calFlow.restart();
    startCalibrationUi(c);
  }

  /** After a first map is stored on the device: record its capture profile
   * there (and in the library), and take pose 1 of the IMU calibration for free
   * — the map is gravity-levelled and the fixture hasn't moved — so a fixture
   * with an IMU is tilt-calibrated to its new map (sensor-core.md §7). Older
   * firmware answers "unsupported"; both steps are best-effort. */
  async function afterMapStored(c: NonNullable<ReturnType<typeof client>>, id: string, mapId: string): Promise<void> {
    try {
      noteDraft();
      if (profileDraft !== null) {
        const p = buildProfile(mapId, profileDraft.knobs, profileDraft, Date.now());
        await mapStore.setCaptureProfile(id, p).catch(() => {});
        await c.setCaptureProfile(p);
      }
    } catch {
      /* firmware without capture profiles */
    }
    try {
      const s = await c.getSensors();
      const pose = postMappingPose(s, Date.now());
      if (pose === null) return;
      await c.setSensorMount(pose.q, { residualDeg: pose.residualDeg, poses: 1, yawResolved: false, atMs: pose.atMs });
      await mapStore.setImuCalibration(id, pose);
      toast("Motion sensor levelled to the new map — Calibrate IMU on the map to fix its heading too.");
    } catch {
      /* no sensor core on this firmware */
    }
  }

  /** Apply the device's stored capture profile for `mapId` (if any) to this
   * run's knobs; without one keep the normal-capture defaults (per-device
   * stride, global diffuse), never a silent dense fallback. */
  async function loadStoredProfile(c: NonNullable<ReturnType<typeof client>>, mapId: string): Promise<void> {
    const defaults: CaptureKnobs = {
      diffuse,
      strideSpacing,
      anchorDensity,
      threshold: detectorOpts.threshold,
      downscale: detectorOpts.downscale,
      ...(detectorOpts.localContrast ? { lcGain: detectorOpts.localContrast.gain } : {}),
    };
    let stored = null;
    try {
      stored = profileForMap(await c.getCaptureProfile(), mapId);
    } catch {
      stored = null; // firmware without capture profiles
    }
    profileRun = applyProfile(defaults, stored);
    if (profileRun.applied === null) return;
    const k = profileRun.knobs;
    diffuse = k.diffuse;
    strideSpacing = k.strideSpacing;
    anchorDensity = k.anchorDensity;
    strideLocked = true;
    detectorOpts = {
      ...detectorOpts,
      threshold: k.threshold,
      downscale: k.downscale,
      ...(k.diffuse && k.lcGain !== undefined ? { localContrast: { gain: k.lcGain } } : {}),
    };
    if (profileRun.brightness !== undefined) {
      brightSlider.input.value = String(Math.round(profileRun.brightness * 100));
      brightSlider.setValueText(`${Math.round(profileRun.brightness * 100)}%`);
    }
    if (profileRun.exposure !== undefined) {
      // A recorded exposure means a manual setting worked: start there, manual.
      expSlider.input.value = profileRun.exposure.toFixed(2);
      expSlider.setValueText(profileRun.exposure.toFixed(2));
      setManualMode(true);
    }
    const span = diffuseBtn.querySelector("span");
    if (span) span.textContent = `Diffuse capture: ${diffuse ? "On" : "Off"}`;
  }

  async function startCapture(): Promise<void> {
    if (driverActive()) setDriverCaptureError(null);
    const c = client();
    if (c === null || !c.isConnected) {
      if (driverActive()) setDriverCaptureError("device disconnected before capture");
      toast("Connect a device to capture", { error: true });
      router.navigate("/maps");
      return;
    }
    // Supplemental capture: load the prior map + its observations up front, so
    // the projection overlay can register against it from the first frame and
    // the strip length is inherited (FUG-112).
    if (calibrateId !== null) {
      const rec = await mapStore.get(calibrateId);
      if (!rec) {
        toast("That map isn't in the library.", { error: true });
        router.navigate("/maps");
        return;
      }
      priorMap = rec.map;
      projOverlay.supplement = true;
      applyLiveSolve(null); // the stored map alone: registration target
      guideEl.textContent = "Calibrate IMU — point the camera at the fixture.";
      // Always three fresh poses: earlier ones (the mapping's pose 1, a previous
      // run's) are NOT carried in — the diversity gate measured every new pose
      // against all of them, so the resting pose was "too close" to pose 1 and
      // each re-run had fewer reachable orientations left. A previous R_fi only
      // breaks ties in a degenerate solve.
      const prevQ = rec.imuCalibration?.q;
      calFlow = new ImuCalFlow(prevQ && prevQ.length === 4 ? (prevQ as [number, number, number, number]) : undefined);
      calPrompt.textContent = "Starting the mapping code…";
      await loadStoredProfile(c, rec.map.mapId);
      updateCalSettingsNote();
    }
    if (supplementId !== null) {
      const rec = await mapStore.get(supplementId);
      const obs = await mapStore.getObservations(supplementId);
      if (!rec || rec.map.leds.length === 0) {
        toast("This map has no LEDs to supplement.", { error: true });
        router.navigate(`/map/${supplementId}`);
        return;
      }
      priorMap = rec.map;
      // A map without its raw observations (pulled off a device, imported, or
      // captured before FUG-112) is still supplemented: the new scan registers
      // to its stored positions and fuses with them (no joint re-solve).
      priorObs = obs ?? null;
      if (!obs) toast("No raw capture data for this map: the new scan will be registered and fused with its stored positions");
      // Reuse the capture settings that produced this map, if the device still
      // holds them for it. Older firmware / a pre-profile map: the same
      // per-device stride + global diffuse a normal capture uses, said out loud.
      await loadStoredProfile(c, rec.map.mapId);
      toast(
        profileRun?.applied
          ? "Reusing this map's capture settings"
          : captureSettingsNote(profileRun, {
              diffuse,
              strideSpacing,
              anchorDensity,
              threshold: detectorOpts.threshold,
              downscale: detectorOpts.downscale,
            }),
      );
      projOverlay.supplement = true;
      applyLiveSolve(null); // base map alone until the live solve registers
      guideEl.textContent = "Supplemental scan — cover the gaps and low-confidence LEDs.";
    }
    // Per-channel capture (fresh maps only; supplements / IMU re-localisation
    // keep the per-device settings): the plan fixes the LED count to the whole
    // fixture's hardware layout.
    const channelPlan = supplementId === null && calibrateId === null ? await resolveChannelPlan(c) : null;
    runChannelPlan = channelPlan;
    if (channelPlan !== null) {
      const st0 = channelPlan.stages[0]!;
      const strided = channelPlan.stages.find((x) => x.kind === "strided");
      ({ diffuse, forcedThreshold, anchorDensity, detectorOpts } = resolveCaptureConfig(st0.kind === "strided"));
      strideSpacing = strided ? strided.strideSpacing : strideSpacing;
      strideLocked = true;
      nativeLog(
        `[capture] per-channel plan: ${channelPlan.spans.map((x) => `CH${x.channel}=${x.count}`).join(" ")} · ` +
          channelPlan.stages.map((_, i) => stageLabel(channelPlan, i)).join(" → "),
      );
    }
    const ledCount = channelPlan !== null ? channelPlan.total : Math.max(
      1,
      priorObs?.ledCount ||
        routeLeds ||
        parseInt(qs.get("leds") ?? "", 10) ||
        c.welcome?.codeParams.ledCount ||
        64,
    );
    countEl.textContent = supplementId !== null ? `Supplement — ${ledCount} LEDs` : `Map — ${ledCount} LEDs`;
    try {
      lastLedCount = ledCount;
      localDetections = [];
      localImu = [];
      const cached = prefs.getCalibratedK();
      const initialExposure =
        profileRun?.exposure ?? (servoExposure ? EXPOSURE_SERVO_START : forcedExposure);
      let servoedExposure = initialExposure ?? EXPOSURE_SERVO_START;
      // iOS takes the camera natively: WebKit's getUserMedia offers no exposure
      // control at all and its camera is unreachable from this process, so the
      // app owns an AVCaptureSession instead (design doc §4.6/§4.7). Everything
      // downstream of `onFrame` is identical — the native source pre-runs the
      // detector's threshold pass and ships the sparse result.
      let exposureTarget: { setExposure(t: number, capMs?: number): unknown };
      let detectGl: WebGL2RenderingContext;
      if (driverActive()) {
        // HITL app-driver: a hardware-free synthetic scene. Like the native path it
        // ships pre-reduced frames, so the detector skips its GPU pass — give it a
        // throwaway context and a no-op exposure target.
        // The Calibrate-IMU journey renders ITS fixture (tilted on cue) from
        // a near-still hand-held viewpoint instead of the mapping orbit.
        const scene = calibrateId !== null ? driverFixtureScene() : null;
        const sc = new SyntheticCaptureSource(
          scene ? { leds: scene.leds, fixtureRotAt: (t) => scene.fixtureRotAt(t), still: true } : { ledCount },
        );
        capture = sc;
        syntheticSource = sc;
        await sc.start();
        exposureTarget = sc;
        detectGl = offscreenGl();
      } else if (nativeCaptureAvailable()) {
        const nc = new NativeCaptureSource({ kSeed: cached, fxOverride: forcedFx ?? undefined });
        capture = nc;
        nativeSource = nc;
        await nc.start();
        // The preview is a native layer BEHIND the WebView, not a <video>, so the
        // page has to be see-through for the duration (html as well as body — the
        // root element paints the page canvas).
        document.documentElement.style.background = "transparent";
        document.body.style.background = "transparent";
        exposureTarget = nc;
        // The detector never runs its GPU pass on this path (frames arrive
        // pre-reduced), but DetectorGL builds its program up front — so give it a
        // throwaway context rather than reshaping the class around a path that
        // only iOS takes.
        detectGl = offscreenGl();
      } else {
        const ms = new MediaStreamCaptureSource({
          kSeed: cached,
          fxOverride: forcedFx ?? undefined,
        });
        capture = ms;
        await ms.start();
        ms.video.style.cssText =
          "position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;background:#000";
        document.body.prepend(ms.video);
        previewVideo = ms.video;
        exposureTarget = ms;
        detectGl = ms.gl;
      }
      // IMU: on iOS it comes from CoreMotion via the capture plugin, whose axes
      // are documented and already in the camera frame — ImuRecorder's
      // DeviceMotion mapping was fitted on an Android handset and has never been
      // right here (mis-oriented maps; docs/design/ios-support.md §4.7). Both
      // expose flush(), so the batch tick below is identical either way.
      // Under the HITL driver the synthetic source emits IMU consistent with its
      // own pose track (no DeviceMotion in a headless browser); otherwise record
      // real device motion.
      if (nativeSource === null && syntheticSource === null) {
        imuRecorder = new ImuRecorder(imuMapping);
        imuRecorder.start();
      }
      const imuFlusher: { flush(): ImuSample[] } | null =
        syntheticSource ?? nativeSource ?? imuRecorder;

      const detector = new DetectorGL(detectGl, detectorOpts);
      // The native reduction must threshold with the SAME value the servo below
      // steers, or the servo is reacting to counts it isn't controlling.
      nativeSource?.setDetectParams({ threshold: detector.threshold, downscale: detector.downscale });

      // Pre-capture probe: measure the scene before the pattern runs, then
      // negotiate the capture configuration.
      const monitor = new ExposureMonitor();
      let lastAmbient: number | null = null;
      const skipProbe = profileRun?.skipProbe === true;
      if (!skipProbe) guideEl.textContent = "Measuring light…";
      if (!skipProbe) await new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 2500);
        let t0 = -1;
        capture!.onFrame((f) => {
          if (t0 < 0) t0 = f.tCaptureMs;
          const blobs = detector.detectFrame(f);
          monitor.push({
            tMs: f.tCaptureMs,
            blobCount: blobs.length,
            scene: detector.measureFrame(f),
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
          : profileRun?.symbols !== undefined
            ? { symbols: profileRun.symbols }
            : recommended !== null
              ? { symbols: recommended.symbols }
              : {}),
        ...(forcedBitMs !== null
          ? { bitPeriodMs: forcedBitMs }
          : profileRun?.bitPeriodMs !== undefined
            ? { bitPeriodMs: profileRun.bitPeriodMs }
            : recommended !== null
              ? { bitPeriodMs: recommended.bitPeriodMs }
              : {}),
        ...(forcedBrightness !== null
          ? { brightness: forcedBrightness }
          : profileRun?.brightness !== undefined
            ? { brightness: profileRun.brightness }
            : {}),
        // Diffuse mode: start on phase 0 of the stride schedule; the tick below
        // rotates the phase. Firmware masks all but the phase's sparse subset.
        ...(diffuse ? { strideSpacing, anchorDensity, stridePhase: 0 } : {}),
        // Per-channel capture: the code book covers the WHOLE fixture from the
        // start, so ids + code timing never change between stages.
        ...(channelPlan !== null ? { codeSpace: channelPlan.total } : {}),
      };

      await c.syncClock(4);
      // Per-channel capture whose first stage codes only a prefix (the curtain):
      // the device transmits just [0, ledCount) while capturing, so a channel
      // past it would freeze on whatever the effect last showed. Start dark over
      // every LED for a few frames (latching black on every channel), then
      // narrow to the first stage at the real brightness.
      const stage0 = channelPlan?.stages[0];
      const blankFirst = channelPlan !== null && stage0 !== undefined && stage0.ledCount < channelPlan.total;
      const started = await c.startMapping(ledCount, blankFirst ? { ...config, brightness: 0 } : config);
      mappingStarted = true;
      if (calibrateId !== null) startCalibrationUi(c);
      let params: CodeParams = started.codeParams;
      let epoch: number = started.patternClockEpoch;
      if (blankFirst && stage0 !== undefined) {
        await new Promise((r) => setTimeout(r, Math.max(300, 3 * params.bitPeriodMs)));
        const ps = await c.configure({ ledCount: stage0.ledCount, brightness: config.brightness ?? 1 });
        if (!ps.active || ps.patternClockEpoch === null) throw new Error("the device dropped the capture pattern");
        params = ps.codeParams;
        epoch = ps.patternClockEpoch;
      }
      profileDraft = {
        knobs: {
          diffuse,
          strideSpacing,
          anchorDensity,
          threshold: detector.threshold,
          downscale: detector.downscale,
          ...(detectorOpts.localContrast ? { lcGain: detectorOpts.localContrast.gain } : {}),
        },
        ...(config.symbols !== undefined ? { symbols: config.symbols } : {}),
        bitPeriodMs: params.bitPeriodMs,
        ...(params.brightness !== undefined ? { brightness: params.brightness } : {}),
        ...(profileRun?.exposure !== undefined ? { exposure: profileRun.exposure } : {}),
      };
      if (initialExposure !== null) {
        void exposureTarget.setExposure(initialExposure, params.bitPeriodMs / 2);
      }
      // Every LED id decoded so far this run (drives the per-channel stage switch).
      const decodedIds = new Set<number>();
      const makePipeline = (p: CodeParams, e: number): CvPipeline => {
        const pl = new CvPipeline(p, e, (t) => c.clock.toServerTime(t), { denseRecords: true });
        pl.onDetections((records: DetectionRecord[]) => {
          for (const r of records) decodedIds.add(r.ledId);
          // Embedded players discard capture telemetry and have no host solver.
          // Keep their observations local rather than filling the TLS receive
          // buffers with data that only the phone's solver can use.
          if (c.hostSolverBenchMs !== null) c.sendDetections(records);
          localDetections.push(...records);
        });
        return pl;
      };
      let pipeline = makePipeline(params, epoch);
      // Hand the synthetic scene the negotiated code-book so it renders the exact
      // hue-code + frame timing the decoder expects (matches the device side).
      syntheticSource?.setCode(params, epoch, (t) => c.clock.toServerTime(t));
      // Diffuse phase rotation state (a no-op when !diffuse: phaseTotal === 1).
      let phaseTotal = diffuse ? stridePhaseCount({ spacing: strideSpacing, anchorDensity }) : 1;
      let phaseIdx = 0;
      let lastPhaseAt = performance.now();
      guideEl.textContent = diffuse
        ? `diffuse: phase 1/${phaseTotal} (stride ${strideSpacing}) · ${params.symbols} symbols`
        : `code: ${params.symbols} symbols @ ${params.bitPeriodMs} ms/frame`;
      // Per-channel stage state (capture/channelCapture.ts).
      let stageIdx = 0;
      let stageStartedAt = performance.now();
      if (channelPlan !== null) {
        guideEl.textContent = `${stageLabel(channelPlan, 0)} · ${guideEl.textContent}`;
        nextStageBtn.style.display = channelPlan.stages.length > 1 ? "" : "none";
      }

      capturing = true;
      startedAt = performance.now();
      interimLog = new InterimLog();
      runProblem = null;
      runFinal = { map: null, diag: null, error: null, assessment: null, timing: null };
      runDecision = null;
      runSupplement = null;
      bundleFrames = [];
      const sampleFrames = debugModeEnabled() && bundleIncludeFrames();
      let lastFrameSampleMs = -Infinity;
      const captureSource: CaptureParamsSnapshot["captureSource"] =
        syntheticSource !== null ? "synthetic" : nativeSource !== null ? "native" : previewVideo !== null ? "mediastream" : "unknown";
      runParams = (): CaptureParamsSnapshot => {
        const w = c.welcome;
        const activeId = deviceStore.activeId();
        return {
          ledCount: lastLedCount,
          supplementOf: supplementId,
          diffuse,
          strideSpacing,
          anchorDensity,
          detector: {
            threshold: detector.threshold,
            downscale: detector.downscale,
            flipV: detectorOpts.flipV,
            localContrastGain: detectorOpts.localContrast?.gain ?? null,
          },
          forced: { exposure: forcedExposure, brightness: forcedBrightness, symbols: forcedSymbols, bitMs: forcedBitMs },
          codeParams: params,
          lastExposure: servoExposure || initialExposure !== null ? servoedExposure : null,
          lastBrightness: params.brightness ?? null,
          stripPrior: finalSolveOptions(runChannelPlan !== null).stripPrior === true,
          liveSolve: liveSolveEnabled,
          placement: c.hostSolverBenchMs === null ? "phone" : "host",
          captureSource,
          durationMs: performance.now() - startedAt,
          frameCount,
          truncatedFrames,
          fixture: {
            deviceId: activeId,
            name: w?.deviceName || (activeId ? deviceStore.get(activeId)?.label ?? null : null),
            mac: w?.mac || null,
            fwVersion: w?.fwVersion || null,
            fwGitCommit: w?.fwGitCommit || null,
            fwGitDirty: w ? w.fwGitDirty : null,
          },
        };
      };
      const loopPerf = new CapturePerf();
      perf = loopPerf;
      // Reachable from a remote devtools console mid-capture.
      (globalThis as { __capturePerf?: () => unknown }).__capturePerf = () => loopPerf.snapshot();
      startTimer();
      let frameCount = 0;
      // Frames the capture source had to clip (see the onFrame handler). Counted
      // so a run that quietly threw away half its frames says so.
      let truncatedFrames = 0;

      capture.onFrame((f) => {
        if (!capturing || !capture) return;
        const tStart = performance.now();
        const blobs = detector.detectFrame(f, {});
        const tDetected = performance.now();
        // A truncated frame is one the capture source had to clip: too much of it
        // was above threshold to encode (a bright scene before exposure settles).
        // Its detections are incomplete AND spatially biased — the encoder fills
        // in scan order, so what survives is the top of the frame — so they must
        // not reach the decoder or the tracker, which would associate garbage.
        // The blob count still goes to the monitor: that's the signal the
        // threshold servo needs to climb out of the bright state.
        const clipped = f.reduced?.truncated === true;
        const measured = frameCount % 6 === 0 ? detector.measureFrame(f) : undefined;
        monitor.push({
          tMs: f.tCaptureMs,
          blobCount: blobs.length,
          scene: measured,
          blobs: blobPopulation(blobs),
        });
        lastAmbient = f.ambientIntensity ?? lastAmbient;

        if (clipped) {
          truncatedFrames++;
          const t = performance.now();
          loopPerf.frame({
            tCaptureMs: f.tCaptureMs,
            seq: f.seq,
            prepMs: f.prepMs,
            latencyMs: tStart - f.tCaptureMs,
            detectMs: tDetected - tStart,
            decodeMs: 0,
            overlayMs: 0,
            totalMs: t - tStart,
          });
          return;
        }
        pipeline.step(blobs, {
          tCaptureMs: f.tCaptureMs,
          pose: f.pose,
          K: f.K,
          imgW: f.imgW,
          imgH: f.imgH,
        });

        const tDecoded = performance.now();
        if (showTracks) labels.draw(pipeline.lastBlobStatus, f.imgW, f.imgH);
        focalPx = f.K[0];
        // Registered 3D layer: recover the pose from the decoded-LED
        // correspondences and project the solved set — base map ∪ live solve —
        // into the viewport. Also drives the reacquisition chip. Only
        // meaningful once there is a solved set to register against.
        if (projOverlay.solvedCount > 0) {
          const reg = projOverlay.draw(pipeline.lastBlobStatus, f.K, f.imgW, f.imgH, showSolved);
          updateRegChip(reg);
          // Calibrate IMU: the registration (the same lock as the chip) is the
          // capture trigger — every frame, stamped with its capture time.
          const locked = projOverlay.lockedPose;
          calFlow?.pushFrame(f.tCaptureMs, locked ? [...locked.q] : null);
        }
        const tOverlaid = performance.now();

        if (++frameCount % 15 === 0) {
          const s = pipeline.stats;
          const ps = loopPerf.snapshot();
          const pop = monitor.blobPopulation();
          const scn = monitor.scene();
          const br = Math.round((params.brightness ?? 1) * 100);
          const pct = (x: number): string => `${Math.round(x * 100)}%`;
          const expLine = servoExposure ? ` · exp ${servoedExposure.toFixed(2)}` : "";
          const servoLine =
            (pop
              ? `LED ${br}% · sat ${pop.satFrac.toFixed(2)} split ${pct(pop.splitFrac)} ` +
                `gray ${pct(pop.grayFrac)} · medI ${pop.medianIntensity.toFixed(2)}` +
                (scn ? ` clip ${pct(scn.clipFrac)}` : "")
              : `LED ${br}%`) + expLine;
          driverDecodeStats = {
            ids: s.uniqueIds.size,
            total: params.ledCount,
            tracks: s.tracks,
            observations: localDetections.length,
            perf: ps,
          };
          hudStats.textContent =
            `decoded ${s.uniqueIds.size}/${params.ledCount} ids · ${s.tracks} tracks · ` +
            `${blobs.length} blobs · align ${s.alignShiftMs.toFixed(0)} ms · ` +
            `${c.pendingBatchCount} unsent${liveSolvedText}\n` +
            servoLine +
            `\n${formatPerfLine(ps)}`;
          // Live count chip reads observations · solved, so the user sees more
          // recording only helps (design doc §4.2).
          countEl.textContent = `${localDetections.length} obs${liveSolvedText}`;
          // Mirror the HUD to the console every ~2s: on iOS this is the only way
          // to see decode health from a device run (tools/iosctl log), and the
          // numbers that matter — ids, tracks, blobs, align — are already here.
          if (frameCount % 60 === 0) {
            const diag =
              `[capture] ids=${s.uniqueIds.size}/${params.ledCount} tracks=${s.tracks} ` +
                `blobs=${blobs.length} align=${s.alignShiftMs.toFixed(0)}ms ` +
                `obs=${localDetections.length} clipped=${truncatedFrames} ` +
                `bit=${params.bitPeriodMs}ms sym=${params.symbols}` +
                (pop ? ` sat=${pop.satFrac.toFixed(2)} medI=${pop.medianIntensity.toFixed(2)}` : "");
            console.info(diag);
            nativeLog(diag);
            const perfDiag =
              `[perf] ${formatPerfLine(ps)}` +
              (liveSolver !== null
                ? ` gov duty ${Math.round(liveSolver.dutyCycle * 100)}% impacted ${liveSolver.impacted}` +
                  (liveSolver.suspended ? " SUSPENDED" : "")
                : "") +
              `\n[perf] ${formatPhaseLine(ps)}`;
            console.info(perfDiag);
            nativeLog(perfDiag);
          }
        }
        // Debug-mode capture bundle: an opt-in downsampled frame every 2 s.
        if (sampleFrames && previewVideo !== null && bundleFrames.length < 120 && f.tCaptureMs - lastFrameSampleMs >= 2000) {
          lastFrameSampleMs = f.tCaptureMs;
          const jpeg = snapshotVideo(previewVideo);
          if (jpeg !== null) bundleFrames.push({ tMs: f.tCaptureMs, jpeg });
        }
        // Everything above is this frame's main-thread cost, HUD included.
        const tEnd = performance.now();
        loopPerf.frame({
          tCaptureMs: f.tCaptureMs,
          seq: f.seq,
          prepMs: f.prepMs,
          latencyMs: tStart - f.tCaptureMs,
          detectMs: tDetected - tStart,
          decodeMs: tDecoded - tDetected,
          overlayMs: tOverlaid - tDecoded,
          totalMs: tEnd - tStart,
        });
      });

      capture.onEnd(() => {
        if (capturing) void stopCapture(true);
      });

      // Server coverage poll (advisory guidance, one line).
      const statusPoll = setInterval(() => {
        if (!capturing) {
          clearInterval(statusPoll);
          return;
        }
        if (c.hostSolverBenchMs === null) return;
        c.getStatus()
          .then((st) => {
            if (st.total > 0) {
              guideEl.textContent =
                st.lowParallax > st.total / 4
                  ? `Keep circling — ${st.lowParallax} LEDs seen from only one spot.`
                  : `${st.identified}/${st.total} LEDs triangulable. Cover the rest of the arc.`;
            }
          })
          .catch(() => undefined);
      }, 2000);

      // Fast live-map poll — the same solver that runs the final solve, so the
      // user sees what they'll get (owner §9 Q2).
      let lastHostLive: OutputMap | null = null;
      const livePoll = setInterval(() => {
        if (!capturing) {
          clearInterval(livePoll);
          return;
        }
        if (c.hostSolverBenchMs === null) return;
        c.getLiveMap()
          .then((lm) => {
            if (!capturing || lm.map === null) return;
            if (lm.map !== lastHostLive) {
              lastHostLive = lm.map;
              interimLog.add({
                source: "host",
                tMs: performance.now() - startedAt,
                recordCount: localDetections.length,
                imuCount: localImu.length,
                ledCount: lastLedCount,
                mapId: lm.map.mapId,
                createdAt: lm.map.createdAt,
                options: null,
                map: lm.map,
                diag: null,
                error: null,
                assessment: null,
              });
            }
            liveLeds = lm.map.leds;
            pipeline.updateSolved(liveLeds);
            applyLiveSolve(lm.map);
          })
          .catch(() => undefined);
      }, 400);

      // No host solver (embedded players): run interim solves on the phone so
      // the overlay still renders concurrently with scanning (FUG-112). They
      // share the worker with the final solve (SolverAgent queues), and Stop
      // waits out an in-flight one.
      if (c.hostSolverBenchMs === null && liveSolveEnabled) {
        void solverReady.then((ok) => {
          if (!ok || !capturing) return;
          // The worker keeps this capture's records between live solves; each
          // solve ships only what arrived since the last one, so the clone on
          // this (camera) thread stays small however long the capture runs.
          let sentDetections = 0;
          let sentImu = 0;
          // Per-solve accounting, completed in `settled` (after onResult).
          let pending: { records: number; uploaded: number; stats: SolveStats | null; applyMs: number } | null =
            null;
          const sched = new LiveSolveScheduler(
            (recordCount) => {
              const detections = localDetections.slice(sentDetections);
              const imu = localImu.slice(sentImu);
              const reset = sentDetections === 0 && sentImu === 0;
              sentDetections += detections.length;
              sentImu += imu.length;
              pending = { records: recordCount, uploaded: detections.length, stats: null, applyMs: 0 };
              const p = pending;
              loopPerf.solveBegin();
              // What the worker's live session holds for this solve: exactly the
              // first sentDetections / sentImu records (a bundle replays it so).
              const interim = {
                source: "phone" as const,
                tMs: performance.now() - startedAt,
                recordCount: sentDetections,
                imuCount: sentImu,
                ledCount: lastLedCount,
                mapId: "live",
                createdAt: new Date().toISOString(),
                options: { ...LIVE_SOLVE_OPTIONS },
              };
              return solverAgent
                .solveLive({
                  reset,
                  detections,
                  imu,
                  ledCount: interim.ledCount,
                  mapId: interim.mapId,
                  createdAt: interim.createdAt,
                  options: interim.options,
                })
                .then(
                  (r) => {
                    p.stats = r.stats;
                    interimLog.add({ ...interim, map: r.map, diag: r.diag, error: null, assessment: r.diag?.assessment ?? null });
                    return r.map;
                  },
                  (e: unknown) => {
                    const msg = e instanceof Error ? e.message : String(e);
                    interimLog.add({ ...interim, map: null, diag: null, error: msg, assessment: null });
                    throw e;
                  },
                );
            },
            (map) => {
              if (!capturing) return;
              const t0 = performance.now();
              liveLeds = map.leds;
              pipeline.updateSolved(liveLeds);
              applyLiveSolve(map);
              if (pending !== null) pending.applyMs = performance.now() - t0;
            },
            {
              settled: (ok) => {
                const p = pending;
                pending = null;
                if (p === null) return null;
                const st = p.stats;
                return loopPerf.solveEnd({
                  records: p.records,
                  uploadedRecords: p.uploaded,
                  queueMs: st?.queueMs ?? 0,
                  postMs: st?.postMs ?? 0,
                  roundTripMs: st?.roundTripMs ?? 0,
                  workerSerializeMs: st?.worker?.serializeMs ?? null,
                  workerSolveMs: st?.worker?.solveMs ?? null,
                  workerParseMs: st?.worker?.parseMs ?? null,
                  applyMs: p.applyMs,
                  ok,
                });
              },
            },
          );
          liveSolver = sched;
          const liveSolveTick = setInterval(() => {
            if (!capturing || liveSolver !== sched) {
              clearInterval(liveSolveTick);
              return;
            }
            sched.tick(localDetections.length);
          }, 1000);
        });
      }

      // Inertial batches for the joint solver.
      if (imuFlusher !== null) {
        const rec = imuFlusher;
        const imuTick = setInterval(() => {
          if (!capturing) {
            clearInterval(imuTick);
            return;
          }
          const samples = rec.flush();
          localImu.push(...samples);
          calFlow?.pushPhone(samples);
          if (c.hostSolverBenchMs !== null) c.sendImuBatch(samples);
          // Calibrate IMU pairs phone gravity with each frame's lock: flush often
          // so a pose isn't held back a whole second waiting for its samples.
        }, calibrateId !== null ? 200 : 1000);
      }

      // Exposure telemetry + real-time adaptation (unchanged servo logic).
      let pendingBitPeriod: number | null = null;
      let pendingSymbols: 2 | 4 | null = null;
      let pendingBrightness: number | null = null;
      let renegotiating = false;
      const applyReconfigure = (
        opts: {
          ledCount?: number;
          bitPeriodMs?: number;
          symbols?: 2 | 4;
          brightness?: number;
          strideSpacing?: number;
          anchorDensity?: number;
          stridePhase?: number;
        },
        onApplied?: () => void,
      ): void => {
        renegotiating = true;
        c.configure(opts)
          .then((ps) => {
            if (!capturing || !ps.active || ps.patternClockEpoch === null) return;
            onApplied?.();
            params = ps.codeParams;
            epoch = ps.patternClockEpoch;
            pipeline = makePipeline(params, epoch);
            pipeline.updateSolved(liveLeds);
            guideEl.textContent = diffuse
              ? `diffuse: phase ${phaseIdx + 1}/${phaseTotal} (stride ${strideSpacing}) · ${params.symbols} symbols`
              : `code renegotiated: ${params.symbols} symbols @ ${params.bitPeriodMs} ms/frame` +
                ` · LED ${Math.round((params.brightness ?? 1) * 100)}%`;
          })
          .catch(() => undefined)
          .finally(() => {
            renegotiating = false;
          });
      };

      // What the run is using NOW goes into the profile a success records (the
      // start-of-run snapshot missed live diffuse / stride / exposure changes).
      noteDraft = (): void => {
        if (profileDraft === null) return;
        profileDraft.knobs = {
          ...profileDraft.knobs,
          diffuse,
          strideSpacing,
          anchorDensity,
          threshold: detector.threshold,
        };
        profileDraft.bitPeriodMs = params.bitPeriodMs;
        if (params.brightness !== undefined) profileDraft.brightness = params.brightness;
        // Only a hand-set exposure is worth replaying (it starts the next run
        // in manual); a servo-chosen one would just pin the servo off.
        if (manualMode) profileDraft.exposure = servoedExposure;
        else delete profileDraft.exposure;
      };
      syncManualSliders(params.brightness ?? 1, servoedExposure);
      manualHooks = {
        applyBrightness: (b01) => applyReconfigure({ brightness: b01 }),
        applyExposure: (e01) => {
          servoedExposure = e01;
          // Manual override widens the range to the user-configured ceiling
          // (settings) instead of the Nyquist cap, so the frame can be brought
          // up under artificial light. It can exceed bitPeriodMs/2 and blur the
          // code across a hue transition — that's the deliberate manual trade
          // (FUG-62). The auto servo below keeps the Nyquist cap.
          void exposureTarget.setExposure(e01, prefs.getManualExposureCeilingMs());
          noteDraft();
        },
      };
      // The calibrate screen's stride control, live: re-stride the running code.
      strideHook = (spacing) => {
        if (renegotiating) return;
        applyReconfigure({ strideSpacing: spacing, anchorDensity, stridePhase: 0 }, () => {
          strideSpacing = spacing;
          phaseTotal = stridePhaseCount({ spacing, anchorDensity });
          phaseIdx = 0;
          lastPhaseAt = performance.now();
          noteDraft();
          updateCalSettingsNote();
        });
      };

      // Live strided ⇄ dense switch (the inline diffuse toggle while capturing).
      // `wantDiffuse` is what the user asked for; `diffuse` flips only once the
      // device has confirmed the new stride, so the pattern, the phase rotation
      // and the detector change together. A switch that can't go out right now
      // (another reconfigure in flight) is retried on the next tick.
      let wantDiffuse = diffuse;
      const applyDiffuseSwitch = (): void => {
        if (wantDiffuse === diffuse || renegotiating) return;
        const target = wantDiffuse;
        const bp = prefs.getDiffuseParams();
        if (target && !strideLocked) {
          const cfg = resolveCaptureConfig();
          strideSpacing = cfg.strideSpacing;
          anchorDensity = cfg.anchorDensity;
        }
        const threshold = numParam("threshold", target ? bp.threshold : 0.6);
        const gain = target ? numParam("lcgain", bp.lcGain) : 0;
        applyReconfigure(
          target ? { strideSpacing, anchorDensity, stridePhase: 0 } : { strideSpacing: 0 },
          () => {
            diffuse = target;
            phaseTotal = target ? stridePhaseCount({ spacing: strideSpacing, anchorDensity }) : 1;
            phaseIdx = 0;
            lastPhaseAt = performance.now();
            if (!forcedThreshold) detector.threshold = threshold;
            detector.setLocalContrast(gain);
            nativeSource?.setDetectParams({ threshold: detector.threshold });
            nativeLog(`[capture] switched to ${target ? `strided (stride ${strideSpacing})` : "dense"} capture`);
            noteDraft();
            updateCalSettingsNote();
          },
        );
      };
      diffuseHook = (on) => {
        wantDiffuse = on;
        applyDiffuseSwitch();
      };

      // Per-channel capture: hand over to the next stage (regular curtain ->
      // strided rope). Same configure/epoch-rebuild path as the diffuse switch;
      // the code book is unchanged (codeSpace pinned), so decoded ids fuse.
      let wantNextStage = false;
      const maybeAdvanceStage = (): void => {
        if (channelPlan === null || renegotiating) return;
        if (stageIdx >= channelPlan.stages.length - 1) return;
        const cur = channelPlan.stages[stageIdx]!;
        const coverage = stageCoverage(cur, channelPlan.spans, decodedIds);
        const due =
          wantNextStage ||
          shouldAdvanceStage({ elapsedMs: performance.now() - stageStartedAt, coverage, isLast: false });
        if (!due) return;
        const next = channelPlan.stages[stageIdx + 1]!;
        const target = next.strideSpacing > 1;
        const bp = prefs.getDiffuseParams();
        const threshold = numParam("threshold", target ? bp.threshold : 0.6);
        const gain = target ? numParam("lcgain", bp.lcGain) : 0;
        applyReconfigure(
          {
            ledCount: next.ledCount,
            ...(target ? { strideSpacing: next.strideSpacing, anchorDensity, stridePhase: 0 } : { strideSpacing: 0 }),
          },
          () => {
            stageIdx++;
            stageStartedAt = performance.now();
            wantNextStage = false;
            diffuse = target;
            wantDiffuse = target;
            if (target) strideSpacing = next.strideSpacing;
            phaseTotal = target ? stridePhaseCount({ spacing: strideSpacing, anchorDensity }) : 1;
            phaseIdx = 0;
            lastPhaseAt = performance.now();
            if (!forcedThreshold) detector.threshold = threshold;
            detector.setLocalContrast(gain);
            nativeSource?.setDetectParams({ threshold: detector.threshold });
            nextStageBtn.style.display = stageIdx < channelPlan.stages.length - 1 ? "" : "none";
            const line = `${stageLabel(channelPlan, stageIdx)} (prev ${Math.round(coverage * 100)}% decoded)`;
            nativeLog(`[capture] ${line}`);
            toast(`Now ${line.replace(/^stage \d+\/\d+: /, "")} — keep sweeping`);
            noteDraft();
          },
        );
      };
      nextStageHook = () => {
        wantNextStage = true;
        maybeAdvanceStage();
      };

      const exposureTick = setInterval(() => {
        if (!capturing) {
          clearInterval(exposureTick);
          return;
        }
        const report = monitor.report(performance.now(), detector.threshold, lastAmbient);
        if (report === null) return;
        // Embedded players drop exposure telemetry (no host-side servo), so like
        // detections/IMU it only adds load to their receive path — keep it for
        // host-capable devices.
        if (c.hostSolverBenchMs !== null) c.sendExposureReport(report);
        // In diffuse mode the top-hat prefilter makes detection LOCAL, so the
        // threshold reads residual contrast at a fixed low value — the absolute-
        // brightness servo would fight it. Leave it pinned there.
        if (!forcedThreshold && !diffuse) {
          detector.threshold = adjustThreshold(detector.threshold, report.blobCount, ledCount);
          nativeSource?.setDetectParams({ threshold: detector.threshold });
        }
        if (renegotiating) return;
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
            void exposureTarget.setExposure(nextExp, params.bitPeriodMs / 2);
          }
        }
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
        syncManualSliders(params.brightness ?? 1, servoedExposure);
        noteDraft();

        // Diffuse capture: rotate the stride phase so every LED eventually lands
        // in a lit (sparse, non-overlapping) subset. Fixed dwell of a few code
        // cycles per phase; skip if a servo reconfig just fired (they share the
        // configure/epoch-rebuild path via applyReconfigure + `renegotiating`).
        applyDiffuseSwitch();
        maybeAdvanceStage();
        if (diffuse && wantDiffuse && !renegotiating) {
          const dwellMs = Math.max(3000, 4 * params.cycleFrames * params.bitPeriodMs);
          if (performance.now() - lastPhaseAt > dwellMs) {
            phaseIdx = (phaseIdx + 1) % phaseTotal;
            lastPhaseAt = performance.now();
            applyReconfigure({ stridePhase: phaseIdx });
            guideEl.textContent =
              (channelPlan !== null ? `${stageLabel(channelPlan, stageIdx)} · ` : "") +
              `diffuse: phase ${phaseIdx + 1}/${phaseTotal} (stride ${strideSpacing})`;
          }
        }
      }, 2000);
    } catch (e) {
      if (driverActive()) {
        setDriverCaptureError(e instanceof Error ? e.message : String(e));
        console.error("capture startup failed", e);
      }
      manualHooks = null;
      diffuseHook = null;
      strideHook = null;
      capturing = false;
      stopTimer();
      imuRecorder?.stop();
      imuRecorder = null;
      previewVideo?.remove();
      previewVideo = null;
      restorePageBackground();
      await capture?.stop().catch(() => undefined);
      capture = null;
      if (e instanceof CaptureUnsupportedError) toast(e.message, { error: true });
      else toast(e instanceof Error ? e.message : String(e), { error: true });
      router.navigate("/maps");
    }
  }

  function startTimer(): void {
    stopTimer();
    timerTick = window.setInterval(() => {
      const s = Math.floor((performance.now() - startedAt) / 1000);
      timerEl.textContent = `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
    }, 1000);
  }
  function stopTimer(): void {
    if (timerTick !== null) {
      clearInterval(timerTick);
      timerTick = null;
    }
  }

  async function cancel(): Promise<void> {
    stopCalibrationUi();
    if (capturing) {
      capturing = false;
      diffuseHook = null;
      strideHook = null;
      stopTimer();
      imuRecorder?.stop();
      previewVideo?.remove();
      previewVideo = null;
      restorePageBackground();
      await capture?.stop().catch(() => undefined);
      capture = null;
      await client()?.stopMappingNoSolve().catch(() => undefined);
    }
    resetLiveFeedback();
    router.navigate("/maps");
  }

  async function stopCapture(sessionAlreadyEnded = false): Promise<void> {
    if (!capturing) return;
    const c = client();
    if (c === null) return;
    capturing = false;
    manualHooks = null;
    diffuseHook = null;
    strideHook = null;
    nextStageHook = null;
    nextStageBtn.style.display = "none";
    stopBtn.disabled = true;
    stopTimer();
    imuRecorder?.stop();
    imuRecorder = null;
    previewVideo?.remove();
    previewVideo = null;
    restorePageBackground();
    if (!sessionAlreadyEnded) await capture?.stop().catch(() => undefined);
    capture = null;
    // Let an in-flight interim solve finish so the final solve has the worker.
    await liveSolver?.stop();
    if (perf !== null) {
      // Whole-capture CPU-sharing summary: the hot loop with the live solver
      // idle vs running, and what the live solves cost.
      const ps = perf.snapshot();
      const summary =
        `[perf] capture summary: ${formatPerfLine(ps)}` +
        (liveSolver !== null
          ? ` gov duty ${Math.round(liveSolver.dutyCycle * 100)}% impacted ${liveSolver.impacted}` +
            (liveSolver.suspended ? " SUSPENDED" : "")
          : "") +
        `\n[perf] ${formatPhaseLine(ps)}`;
      console.info(summary);
      nativeLog(summary);
      perf = null;
    }
    resetLiveFeedback();

    // Calibrate IMU: nothing to solve or save to the map; end the code playback
    // and go back to the map.
    if (calibrateId !== null) {
      stopCalibrationUi();
      calPanel.style.display = "none";
      await c.stopMappingNoSolve().catch(() => undefined);
      stopBtn.disabled = false;
      router.navigate(`/map/${calibrateId}`);
      return;
    }

    await solverReady.catch(() => false);
    if (c.hostSolverBenchMs === null && !solverAgent.available) {
      guideEl.textContent = "loading the solver…";
      await solverAgent.init().catch(() => false);
    }
    const placement = chooseSolvePlacement(solverAgent.benchMs, c.hostSolverBenchMs);
    const solveOnPhone = placement === "phone" && solverAgent.available && localDetections.length > 0;
    // The solve is where an iOS run can still fail after a perfect capture, and
    // Release builds swallow console output — so record the whole decision.
    nativeLog(
      `[solve] placement=${placement} onPhone=${solveOnPhone} ` +
        `wasmAvailable=${solverAgent.available} wasmBench=${solverAgent.benchMs} ` +
        `hostBench=${c.hostSolverBenchMs} detections=${localDetections.length} imu=${localImu.length}`,
    );
    if (!solveOnPhone && c.hostSolverBenchMs === null) {
      toast(
        solverAgent.available
          ? "Nothing to solve — no LEDs were decoded."
          : "The in-browser solver could not load. Try capturing again.",
        { error: true },
      );
      await c.stopMappingNoSolve().catch(() => undefined);
      driverSolveReject?.(
        new Error(
          solverAgent.available
            ? "nothing to solve — no LEDs decoded from the synthetic scene"
            : "the in-browser solver failed to load",
        ),
      );
      driverSolveResolve = null;
      driverSolveReject = null;
      router.navigate("/maps");
      return;
    }

    // Solve progress: bar + the converging interim map in the live inset.
    progWrap.style.display = "";
    progFill.style.width = "0%";
    progText.textContent = "solving…";
    liveCanvas.style.display = "block";
    const preview: { view: MapView | null } = { view: null };
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
        if (preview.view === null) {
          preview.view = new MapView(liveCanvas, interim);
          preview.view.start();
        } else {
          preview.view.update(interim);
        }
        preview.view.setTrajectory(st.trajectory);
      }
    };
    const solvePoll = solveOnPhone
      ? null
      : setInterval(() => {
          c.getSolveStatus().then(renderSolveSnapshot).catch(() => undefined);
        }, 400);
    // A phone solve needs only the locally-retained detections; the device
    // plays no part once capture ends (FUG-69). Factored out so the host-solve
    // path can fall back to it when the device has dropped mid-capture.
    const solveOnPhoneNow = async (): Promise<OutputMap> => {
      // Warm start: the best live-preview solve's state, so the final solve
      // also starts from what the user was shown and keeps the better start
      // (solver/src/pipeline.rs). Only a phone interim carries a state.
      const best = interimLog.best();
      const warmStart = best?.source === "phone" ? best.diag?.state : undefined;
      const problem: SolveProblem = {
        detections: localDetections,
        imu: localImu,
        ledCount: lastLedCount,
        mapId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        options: { ...finalSolveOptions(runChannelPlan !== null), ...(warmStart ? { warmStart } : {}) },
      };
      runProblem = problem;
      // Persist the exact solver input on iOS so a failed solve can be replayed
      // natively (//solver:solver_cli) instead of re-captured per hypothesis.
      const logged = nativeSource === null ? problem : { ...problem, imuRaw: nativeSource.rawImuLog() };
      void saveSessionLog(`session-${Date.now()}.json`, JSON.stringify(logged)).then((path) => {
        if (path !== null) nativeLog(`[solve] session log saved: ${path}`);
      });
      if (driverActive()) {
        const s0 = localImu[0];
        console.info(
          `[solve] problem detections=${localDetections.length} imu=${localImu.length} ` +
            `ledCount=${lastLedCount} imu0=${
              s0
                ? `t${s0.t.toFixed(0)} g[${s0.gyro.map((x) => x.toFixed(2))}] a[${s0.accel.map((x) => x.toFixed(2))}]`
                : "none"
            }`,
        );
      }
      let lastProg = -1;
      let solvedRes: Awaited<ReturnType<typeof solverAgent.solveWithStats>>;
      try {
        solvedRes = await solverAgent.solveWithStats(problem, (snap: SolveSnapshot) => {
          renderSolveSnapshot(snap);
          if (driverActive() && snap.progress - lastProg >= 0.2) {
            lastProg = snap.progress;
            console.info(
              `[solve] progress=${(snap.progress * 100).toFixed(0)}% rms=${snap.rmsPx?.toFixed(1)} leds=${snap.leds?.length ?? 0}`,
            );
          }
        });
      } catch (e) {
        // A throwing final solve still has the preview to fall back to.
        return keepMap(null, null, e instanceof Error ? e.message : String(e), null);
      }
      const { map: solved, diag, stats } = solvedRes;
      const solveLine =
        `[solve] final ${problem.detections.length} records: ${stats.roundTripMs.toFixed(0)} ms ` +
        `(queue ${stats.queueMs.toFixed(0)} post ${stats.postMs.toFixed(1)}` +
        (stats.worker
          ? ` serialize ${stats.worker.serializeMs.toFixed(0)} wasm ${stats.worker.solveMs.toFixed(0)} ` +
            `parse ${stats.worker.parseMs.toFixed(0)}`
          : "") +
        `)`;
      console.info(solveLine);
      nativeLog(solveLine);
      return keepMap(solved, diag, null, {
        roundTripMs: stats.roundTripMs,
        solveMs: stats.worker?.solveMs ?? null,
      });
    };
    try {
      let map: OutputMap;
      // Whether the solved map made it back onto the device. Reconstruction no
      // longer hinges on it: a dropped device socket (e.g. TLS heap exhaustion
      // on a long capture, FUG-69) must not lose a capture we already hold.
      let pushedToDevice = false;
      if (solveOnPhone && supplementId !== null && priorMap !== null) {
        // Supplemental scan solved on the phone. A short scan aimed at a few
        // weak LEDs may be too thin to solve ON ITS OWN, yet still add the rays
        // those LEDs need to the joint re-solve — so a failed standalone solve
        // is not fatal here; reviewSupplement decides what is usable. Like the
        // plain phone solve below, the stop is sent but its reply is not
        // awaited (a stalled player would otherwise hold up the solve).
        void c.stopMappingNoSolve().catch((e: unknown) => {
          nativeLog(`[solve] device did not acknowledge stop: ${e instanceof Error ? e.message : String(e)}`);
        });
        const supp = await solveOnPhoneNow().catch((e: unknown) => {
          nativeLog(`[solve] supplemental standalone solve failed: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
        preview.view?.stop();
        if (solvePoll !== null) clearInterval(solvePoll);
        await reviewSupplement(supp);
        return;
      }
      if (solveOnPhone) {
        // Best-effort device bookkeeping only — tell it to stop and hand it the
        // result if the socket is still up, but never fail OR DELAY the solve on
        // it. The stop goes out first (the transport is ordered, so the device
        // sees it before the map upload), but its reply is NOT awaited: a player
        // whose link has stalled never answers, and the solve used to sit behind
        // that round trip until the socket finally died. The client bounds the
        // wait itself and re-delivers an unacknowledged stop on reconnect, so
        // the pattern still stops on the device.
        void c.stopMappingNoSolve().catch((e: unknown) => {
          nativeLog(`[solve] device did not acknowledge stop: ${e instanceof Error ? e.message : String(e)}`);
        });
        nativeLog("[solve] phone solve starting");
        map = await solveOnPhoneNow();
        nativeLog(`[solve] phone solve done: ${map.leds.length} leds`);
        // A supplemental scan's raw solve is not the map — the fused result is,
        // and it isn't pushed until the user accepts — so skip the device push.
        pushedToDevice =
          supplementId !== null ? false : await c.submitMap(map).then(() => true).catch(() => false);
      } else {
        try {
          const result = await c.stopMapping();
          const resp = await fetch(`/maps/${result.mapId}`);
          if (!resp.ok) throw new Error(`fetching map failed: HTTP ${resp.status}`);
          map = keepMap((await resp.json()) as OutputMap, null, null, null);
          nativeLog(`[solve] host solve done: ${map.leds.length} leds`);
          pushedToDevice = true;
        } catch (hostErr) {
          // Host solve unreachable — typically the device dropped mid-capture
          // (FUG-69). We kept every detection locally, so fall back to the
          // in-browser solver rather than throw the whole capture away.
          if (localDetections.length === 0) throw hostErr;
          if (solvePoll !== null) clearInterval(solvePoll);
          if (!solverAgent.available) {
            guideEl.textContent = "device lost — solving on your phone…";
            await solverAgent.init().catch(() => false);
          }
          if (!solverAgent.available) throw hostErr;
          console.warn(
            `host solve failed (${hostErr instanceof Error ? hostErr.message : hostErr}); ` +
              "falling back to the phone solver",
          );
          nativeLog(
            `[solve] host solve FAILED (${hostErr instanceof Error ? hostErr.message : String(hostErr)})` +
              " — falling back to the phone solver",
          );
          map = await solveOnPhoneNow();
          nativeLog(`[solve] fallback phone solve done: ${map.leds.length} leds`);
          // A supplemental scan's raw solve is not the map — the fused result is,
          // and it isn't pushed until the user accepts — so skip the device push.
          pushedToDevice =
            supplementId !== null ? false : await c.submitMap(map).then(() => true).catch(() => false);
        }
      }
      preview.view?.stop();
      if (solvePoll !== null) clearInterval(solvePoll);
      if (supplementId !== null && priorMap !== null) {
        // Supplemental: register + fuse into the prior map, then let the user
        // accept or reject the fused result before it is committed (FUG-112).
        await reviewSupplement(map);
      } else {
        // First-time capture: save the solved result as a NEW library map
        // (design doc §4.2) — keeping the raw observations so it can later be
        // supplemented — and navigate to Map Detail.
        const observations: CaptureObservations = {
          detections: localDetections,
          imu: localImu,
          ledCount: lastLedCount,
        };
        const id = await mapStore.create({ map, source: "capture", observations });
        appState.setSelectedMap(id);
        if (pushedToDevice) void afterMapStored(c, id, map.mapId);
        toast(
          pushedToDevice
            ? `Saved ${map.leds.length} LEDs`
            : `Saved ${map.leds.length} LEDs — device offline, not pushed`,
        );
        // Solver quality warnings (e.g. a metric scale the capture motion
        // couldn't pin down): long-lived, so they're actually read.
        for (const w of map.stats?.warnings ?? []) toast(w, { error: true, ms: 10000 });
        driverSolveResolve?.({ mapId: id, ledCount: lastLedCount, solved: map.leds.length });
        driverSolveResolve = null;
        driverSolveReject = null;
        router.navigate(`/map/${id}`);
      }
    } catch (e) {
      nativeLog(`[solve] FAILED: ${e instanceof Error ? e.message : String(e)}`);
      if (runDecision === null) {
        runDecision = {
          use: "none",
          outcome: "failed",
          reasons: [`error: ${e instanceof Error ? e.message : String(e)}`],
          comparison: null,
        };
      }
      toast(`Reconstruction failed: ${e instanceof Error ? e.message : e}`, { error: true });
      driverSolveReject?.(e);
      driverSolveResolve = null;
      driverSolveReject = null;
      router.navigate(supplementId !== null ? `/map/${supplementId}` : "/maps");
    } finally {
      if (solvePoll !== null) clearInterval(solvePoll);
      progWrap.style.display = "none";
      stopBtn.disabled = false;
      void saveRunBundle();
    }
  }

  /**
   * Decide which map this run keeps (solver/degeneracy decideFinal): the final
   * solve's, unless it failed / came out degenerate / clearly regressed where
   * the best live-preview solve did not — then the preview's, with a warning
   * on the map. Records the raw final + the decision for the capture bundle.
   * Returns the kept map, recentered on its LED centroid (the solve frame is
   * camera-anchored; the device and the library should agree on the fixture
   * origin). Throws when there is no usable map at all.
   */
  function keepMap(
    final: OutputMap | null,
    diag: SolveDiag | null,
    error: string | null,
    timing: { roundTripMs: number; solveMs: number | null } | null,
  ): OutputMap {
    const assessment = final === null ? null : (diag?.assessment ?? assessMap(final, observableLeds(localDetections)));
    runFinal = { map: final, diag, error, assessment, timing };
    const best = interimLog.best();
    const preview =
      best !== null && best.map !== null && best.assessment !== null
        ? { map: best.map, assessment: best.assessment }
        : null;
    const decision = decideFinal({ map: final, assessment, error }, preview);
    runDecision = decision;
    const line =
      `[solve] decision ${decision.outcome} (kept ${decision.use})` +
      (decision.reasons.length > 0 ? `: ${decision.reasons.join(", ")}` : "") +
      (diag ? ` start=${diag.start}` : "");
    console.info(line);
    nativeLog(line);
    if (decision.use === "none" || (decision.use === "preview" && preview === null)) {
      throw new Error(error ?? `degenerate solve (${decision.reasons.join(", ")})`);
    }
    if (decision.use === "preview" && preview !== null) {
      const why = decision.reasons.join(", ");
      const warning =
        `The final solve ${final === null ? "failed" : "came out degenerate"} (${why}), so this map ` +
        `is the live preview's solve instead. It may be less refined; re-capture for a better one.`;
      toast("Final solve was degenerate — kept the live preview's map", { error: true, ms: 8000 });
      const kept: OutputMap = {
        ...preview.map,
        mapId: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        stats: { ...preview.map.stats, warnings: [...(preview.map.stats.warnings ?? []), warning] },
      };
      return channelFill(recenterToCentroid(kept).map);
    }
    return channelFill(recenterToCentroid(final!).map);
  }

  /** Per-channel capture: place the LEDs the solve didn't (the rope's in-between
   * LEDs) by index within their OWN channel, so neither the app nor the
   * firmware's whole-strip fill ever interpolates across the channel boundary. */
  function channelFill(map: OutputMap): OutputMap {
    if (runChannelPlan === null) return map;
    const filled = fillChannelGaps(map, runChannelPlan.spans);
    nativeLog(
      `[solve] per-channel fill: ${map.leds.length} -> ${filled.leds.length} LEDs, ` +
        `${filled.unmapped.length} still unmapped`,
    );
    return filled;
  }

  /** Debug mode: persist this run's reproduction bundle when it failed, came
   * out degenerate, fell back to the preview or disagreed with it — or always,
   * with "Keep successful runs too". Best-effort; never throws. */
  async function saveRunBundle(): Promise<void> {
    const decision = runDecision;
    if (!debugModeEnabled() || decision === null || runParams === null) return;
    if (!shouldLogRun(decision.outcome, bundleKeepSuccessful())) return;
    try {
      const bundle = buildBundle({
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        decision,
        app: { version: appBuildInfo.version ?? null, gitCommit: appBuildInfo.gitCommit, gitDirty: appBuildInfo.gitDirty },
        solver: { version: solverAgent.version, wasmSha256: solverAgent.wasmSha256 },
        device: deviceInfo(),
        capture: runParams(),
        problem: runProblem ?? {
          detections: localDetections,
          imu: localImu,
          ledCount: lastLedCount,
          mapId: "unsolved",
          createdAt: new Date().toISOString(),
        },
        interims: interimLog,
        final: runFinal,
        supplement: runSupplement,
        frames: bundleFrames,
      });
      const meta = await captureBundleStore.save(bundle);
      if (meta !== null) {
        const line = `[solve] capture bundle saved (${meta.outcome}, ${(meta.bytes / 1024 / 1024).toFixed(1)} MB)`;
        console.info(line);
        nativeLog(line);
        if (decision.outcome !== "ok") toast(`Debug: capture bundle saved (${decision.outcome}) — Settings ▸ Debugging`);
      }
    } catch (e) {
      console.warn("capture bundle failed", e);
    }
  }

  /**
   * Fuse the supplemental scan `newMap` into the prior map, show the fused
   * result in the live inset, and let the user accept or reject it (FUG-112).
   * On accept the prior library map is replaced in place and its observations
   * are extended so it can be supplemented again; on reject nothing changes.
   */
  async function reviewSupplement(newMap: OutputMap | null): Promise<void> {
    const prior = priorMap;
    const obs = priorObs;
    if (prior === null || supplementId === null) {
      router.navigate("/maps");
      return;
    }
    // The base capture's observations + this session's on one timeline: the
    // joint re-solve input now, and what the map persists on Accept (so it can
    // be supplemented again). Null for a map without observations: no joint
    // re-solve, the scan is registered + fused with the stored positions
    // (fuseMaps treats a stats-less prior's LEDs as measured, conservative σ).
    const mergedObs: CaptureObservations | null =
      obs === null ? null : concatObservations(obs, { detections: localDetections, imu: localImu });
    // Joint re-solve (FUG-112 D): accumulate the supplemental measurements with
    // the base ones and solve them together, so low-confidence base LEDs get a
    // new solution from all their rays. Needs the in-browser solver; fuseMaps
    // validates the result (a solver that keeps only one arc of an interrupted
    // timeline drops a session) and falls back to estimate-level fusion.
    let joint: OutputMap | null = null;
    if (mergedObs !== null && solverAgent.available && localDetections.length > 0) {
      progWrap.style.display = "";
      progFill.style.width = "0%";
      progText.textContent = "re-solving with the original capture…";
      joint = await solverAgent
        .solve(
          {
            detections: mergedObs.detections,
            imu: mergedObs.imu,
            ledCount: mergedObs.ledCount,
            mapId: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            options: finalSolveOptions(),
          },
          (snap) => {
            progFill.style.width = `${Math.round(snap.progress * 100)}%`;
            progText.textContent = `re-solving with the original capture… ${Math.round(snap.progress * 100)} %`;
          },
        )
        .then((m) => recenterToCentroid(m).map)
        .catch((e: unknown) => {
          nativeLog(`[solve] joint re-solve failed: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        });
    }
    // LEDs this session decoded at least a few times — what the joint solve
    // must show new views on (validateJoint).
    const decodes = new Map<number, number>();
    for (const d of localDetections) decodes.set(d.ledId, (decodes.get(d.ledId) ?? 0) + 1);
    const observedIds = new Set([...decodes].filter(([, n]) => n >= 3).map(([id]) => id));
    const fusion = fuseMaps(prior, newMap, { joint, observedIds });
    runSupplement = {
      method: fusion.report.method,
      registered: fusion.report.registered,
      summary: fusion.report.summary,
      jointError:
        mergedObs === null
          ? "no prior observations (registered fusion only)"
          : joint === null
            ? "joint re-solve unavailable or failed"
            : (fusion.report.jointRejected ?? null),
    };
    nativeLog(
      `[solve] supplement fusion: method=${fusion.report.method} registered=${fusion.report.registered} ` +
        `jointRejected=${fusion.report.jointRejected ?? "-"} — ${fusion.report.summary}`,
    );
    progWrap.style.display = "none";
    guideEl.style.display = "none";
    layerBar.style.display = "none";

    // Show the outcome big: the fused map when it registered, else the prior
    // (unchanged) so the user can see what they still have.
    el.classList.add("capture--livebig");
    liveCanvas.style.display = "block";
    const reviewView = new MapView(liveCanvas, fusion.report.registered ? fusion.map : prior);
    reviewView.start();

    const choice = await new Promise<"accept" | "reject">((resolve) => {
      const how =
        fusion.report.method === "joint"
          ? " Low-confidence LEDs were re-solved jointly from both captures."
          : mergedObs === null
            ? " The map has no raw capture data, so the scan was fused with its stored positions."
            : joint !== null || fusion.report.jointRejected !== null
            ? ` Joint re-solve not used (${fusion.report.jointRejected ?? "unavailable"}) — low-confidence LEDs fused from the separate solves.`
            : "";
      reviewText.textContent = fusion.report.registered
        ? fusion.report.summary + how
        : `Couldn't register this scan into the map — ${fusion.report.summary} ` +
          `The fixture's orientation may have changed since the original capture. Try again from a different arc.`;
      reviewBtns.replaceChildren();
      if (fusion.report.registered) {
        reviewBtns.append(
          Button({ label: "Reject", variant: "quiet", onClick: () => resolve("reject") }),
          Button({ label: "Accept & merge", variant: "primary", onClick: () => resolve("accept") }),
        );
      } else {
        reviewBtns.append(
          Button({ label: "Discard", variant: "quiet", onClick: () => resolve("reject") }),
        );
      }
      reviewPanel.style.display = "";
    });

    reviewPanel.style.display = "none";
    reviewView.stop();
    el.classList.remove("capture--livebig");

    if (choice === "accept" && fusion.report.registered) {
      // Persist the fused map in place (still in the base frame — anchored LEDs
      // didn't move) and the time-shifted union of observations, so the next
      // supplement's joint re-solve sees both sessions on one valid timeline.
      await mapStore.setMap(supplementId, fusion.map, undefined, mergedObs ?? undefined);
      appState.setSelectedMap(supplementId);
      // Best-effort: the device should play the map the library now holds.
      const pushed = await client()
        ?.submitMap(fusion.map)
        .then(() => true)
        .catch(() => false);
      // Uploading the fused map makes the device drop the old map's capture
      // profile: record what this scan used (it worked) for the new map.
      if (pushed) {
        noteDraft();
        if (profileDraft !== null) {
          const p = buildProfile(fusion.map.mapId, profileDraft.knobs, profileDraft, Date.now());
          await mapStore.setCaptureProfile(supplementId, p).catch(() => {});
          await client()?.setCaptureProfile(p).catch(() => {});
        }
      }
      toast(
        `Merged — +${fusion.report.added} LEDs, ${fusion.report.resolved} re-solved` +
          (pushed ? "" : " — device offline, not pushed"),
      );
    } else {
      toast("Supplemental scan discarded — map unchanged");
    }
    router.navigate(`/map/${supplementId}`);
  }

  return {
    el,
    onMount: () => {
      // Under the HITL driver, expose a controller so the harness can end the
      // capture and await the solved map (see driver/harness.ts finishCapture).
      if (driverActive()) {
        registerDriverCapture({
          stats: () => driverDecodeStats,
          cancel,
          finish: () =>
            new Promise<DriverCaptureResult>((resolve, reject) => {
              driverSolveResolve = resolve;
              driverSolveReject = reject;
              void stopCapture();
            }),
        });
      }
      void startCapture();
    },
    onUnmount: () => {
      if (driverActive()) registerDriverCapture(null);
      driverSolveReject?.(new Error("capture screen unmounted before solve"));
      driverSolveResolve = null;
      driverSolveReject = null;
      capturing = false;
      // The calibration reader/step timer used to outlive the screen (polling
      // get_sensors at 5 Hz forever, starving every later sensor request).
      stopCalibrationUi();
      stopTimer();
      imuRecorder?.stop();
      previewVideo?.remove();
      previewVideo = null;
      restorePageBackground();
      void capture?.stop().catch(() => undefined);
      capture = null;
      resetLiveFeedback();
      document.body.classList.remove("in-capture");
    },
  };
}

/** OutputMap-shaped wrapper around a solve_status interim snapshot (verbatim
 * from main.ts) — just enough for MapView while the final map settles. */
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

/** A downsampled JPEG of the camera preview (debug capture bundles), or null
 * when the frame can't be read (not ready, tainted). ~160 px wide. */
function snapshotVideo(video: HTMLVideoElement): string | null {
  try {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) return null;
    const scale = 160 / w;
    const c = document.createElement("canvas");
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    const ctx = c.getContext("2d");
    if (ctx === null) return null;
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.6);
  } catch {
    return null;
  }
}
