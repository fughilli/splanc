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
import { CvPipeline } from "../../cv/pipeline";
import { DetectorGL } from "../../cv/detect";
import { CaptureUnsupportedError } from "../../xr/capture";
import { DEFAULT_IMU_MAPPING, ImuRecorder, parseImuMapping } from "../../xr/imu";
import { MediaStreamCaptureSource } from "../../xr/mediaStreamCapture";
import { SolverAgent, type SolveSnapshot } from "../../solver/agent";
import { chooseSolvePlacement } from "../../solver/placement";
import { LabelOverlay } from "../labels";
import { MapView } from "../mapview";
import { prefs } from "../../store/prefs";
import { mapStore } from "../../store/mapStore";
import { appState } from "../app/state";
import { Button, IconButton, Slider, toast } from "../kit";
import type { Router, Screen } from "../app/router";

const qs = new URLSearchParams(location.search);
function numParam(name: string, dflt: number): number {
  const v = qs.get(name);
  const n = v === null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

// URL-param power-user overrides (unchanged from main.ts; no longer primary UI).
const forcedThreshold = qs.get("threshold") !== null;
const detectorOpts = {
  threshold: numParam("threshold", 0.6),
  downscale: numParam("downscale", 2),
  flipV: qs.get("flipv") !== null ? qs.get("flipv") !== "0" : false,
};
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
const forcedExposure = ((): number | null => {
  const v = parseFloat(qs.get("exposure") ?? "");
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : null;
})();

export function CaptureScreen(router: Router): Screen {
  const el = document.createElement("div");
  el.className = "screen screen--capture";

  // -- full-screen layout (design doc §4.2). The camera <video> is prepended to
  // <body> by the capture source (fixed, inset:0) as in main.ts; the HUD, live
  // inset, advanced controls and stop button live in this overlay.
  const overlay = document.createElement("div");
  overlay.className = "capture-overlay";

  const labelsCanvas = document.createElement("canvas");
  labelsCanvas.className = "capture-labels";

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

  overlay.append(labelsCanvas, topBar, liveCanvas, advWrap, hudStats, guideEl, progWrap, stopBtn);
  el.append(overlay);

  // -- manual exposure/brightness override (in-capture). Same semantics as
  // main.ts: the toggle freezes both servos and the sliders drive exposure/
  // brightness directly; while auto, the sliders track the servo.
  let manualMode = false;
  let manualHooks: {
    applyBrightness: (b01: number) => void;
    applyExposure: (e01: number) => void;
  } | null = null;
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
  advBody.append(modeBtn, brightSlider.el, expSlider.el, hudStats);
  brightSlider.input.addEventListener("change", () => {
    if (manualMode) manualHooks?.applyBrightness(parseInt(brightSlider.input.value, 10) / 100);
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
    brightSlider.el.style.display = on ? "" : "none";
    expSlider.el.style.display = on ? "" : "none";
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
  const solverAgent = new SolverAgent();
  const solverReady: Promise<boolean> = solverAgent.init().then((ok) => {
    if (ok) console.info(`wasm solver ready: benchmark ${solverAgent.benchMs?.toFixed(0)} ms`);
    return ok;
  });
  let capture: MediaStreamCaptureSource | null = null;
  let capturing = false;
  let imuRecorder: ImuRecorder | null = null;
  let previewVideo: HTMLVideoElement | null = null;
  let liveView: MapView | null = null;
  let liveLeds: readonly LedEntry[] = [];
  let liveSolvedText = "";
  let localDetections: DetectionRecord[] = [];
  let localImu: ImuSample[] = [];
  let lastLedCount = 64;
  let startedAt = 0;
  let timerTick: number | null = null;

  function client() {
    return appState.client;
  }

  function resetLiveFeedback(): void {
    liveView?.stop();
    liveView = null;
    liveLeds = [];
    liveSolvedText = "";
    liveCanvas.style.display = "none";
    labels.clear();
  }

  async function startCapture(): Promise<void> {
    const c = client();
    if (c === null || !c.isConnected) {
      toast("Connect a device to capture", { error: true });
      router.navigate("/maps");
      return;
    }
    const ledCount = Math.max(
      1,
      parseInt(qs.get("leds") ?? "", 10) || c.welcome?.codeParams.ledCount || 64,
    );
    countEl.textContent = `Map — ${ledCount} LEDs`;
    try {
      lastLedCount = ledCount;
      localDetections = [];
      localImu = [];
      const cached = prefs.getCalibratedK();
      const initialExposure = servoExposure ? EXPOSURE_SERVO_START : forcedExposure;
      let servoedExposure = initialExposure ?? EXPOSURE_SERVO_START;
      const ms = new MediaStreamCaptureSource({
        kSeed: cached,
        fxOverride: forcedFx ?? undefined,
      });
      capture = ms;
      await capture.start();
      ms.video.style.cssText =
        "position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;background:#000";
      document.body.prepend(ms.video);
      previewVideo = ms.video;
      imuRecorder = new ImuRecorder(imuMapping);
      imuRecorder.start();

      const detector = new DetectorGL(capture.gl, detectorOpts);

      // Pre-capture probe: measure the scene before the pattern runs, then
      // negotiate the capture configuration.
      const monitor = new ExposureMonitor();
      let lastAmbient: number | null = null;
      guideEl.textContent = "Measuring light…";
      await new Promise<void>((resolve) => {
        const deadline = setTimeout(resolve, 2500);
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
        ...(forcedBrightness !== null ? { brightness: forcedBrightness } : {}),
      };

      await c.syncClock(4);
      const started = await c.startMapping(ledCount, config);
      let params: CodeParams = started.codeParams;
      let epoch: number = started.patternClockEpoch;
      if (initialExposure !== null) {
        void ms.setExposure(initialExposure, params.bitPeriodMs / 2);
      }
      const makePipeline = (p: CodeParams, e: number): CvPipeline => {
        const pl = new CvPipeline(p, e, (t) => c.clock.toServerTime(t), { denseRecords: true });
        pl.onDetections((records: DetectionRecord[]) => {
          c.sendDetections(records);
          localDetections.push(...records);
        });
        return pl;
      };
      let pipeline = makePipeline(params, epoch);
      guideEl.textContent = `code: ${params.symbols} symbols @ ${params.bitPeriodMs} ms/frame`;

      capturing = true;
      startedAt = performance.now();
      startTimer();
      let frameCount = 0;

      capture.onFrame((f) => {
        if (!capturing || !capture) return;
        const blobs = detector.detect(f.texture, f.imgW, f.imgH, {});
        const measured = frameCount % 6 === 0 ? detector.measure(f.texture, f.imgW, f.imgH) : undefined;
        monitor.push({
          tMs: f.tCaptureMs,
          blobCount: blobs.length,
          scene: measured,
          blobs: blobPopulation(blobs),
        });
        lastAmbient = f.ambientIntensity ?? lastAmbient;

        pipeline.step(blobs, {
          tCaptureMs: f.tCaptureMs,
          pose: f.pose,
          K: f.K,
          imgW: f.imgW,
          imgH: f.imgH,
        });

        labels.draw(pipeline.lastBlobStatus, f.imgW, f.imgH);

        if (++frameCount % 15 === 0) {
          const s = pipeline.stats;
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
          hudStats.textContent =
            `decoded ${s.uniqueIds.size}/${params.ledCount} ids · ${s.tracks} tracks · ` +
            `${blobs.length} blobs · align ${s.alignShiftMs.toFixed(0)} ms · ` +
            `${c.pendingBatchCount} unsent${liveSolvedText}\n` +
            servoLine;
          // Live count chip reads observations · solved, so the user sees more
          // recording only helps (design doc §4.2).
          countEl.textContent = `${localDetections.length} obs${liveSolvedText}`;
        }
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
      const livePoll = setInterval(() => {
        if (!capturing) {
          clearInterval(livePoll);
          return;
        }
        c.getLiveMap()
          .then((lm) => {
            if (!capturing || lm.map === null) return;
            liveLeds = lm.map.leds;
            pipeline.updateSolved(liveLeds);
            liveSolvedText = ` · solved ${lm.map.leds.length}/${lm.map.ledCount}`;
            liveCanvas.style.display = "block";
            if (liveView === null) {
              const v = new MapView(liveCanvas, lm.map);
              liveView = v;
              v.start();
            } else {
              liveView.update(lm.map);
            }
          })
          .catch(() => undefined);
      }, 400);

      // Inertial batches for the joint solver.
      if (imuRecorder !== null) {
        const rec = imuRecorder;
        const imuTick = setInterval(() => {
          if (!capturing) {
            clearInterval(imuTick);
            return;
          }
          const samples = rec.flush();
          localImu.push(...samples);
          c.sendImuBatch(samples);
        }, 1000);
      }

      // Exposure telemetry + real-time adaptation (unchanged servo logic).
      let pendingBitPeriod: number | null = null;
      let pendingSymbols: 2 | 4 | null = null;
      let pendingBrightness: number | null = null;
      let renegotiating = false;
      const applyReconfigure = (opts: { bitPeriodMs?: number; symbols?: 2 | 4; brightness?: number }): void => {
        renegotiating = true;
        c.configure(opts)
          .then((ps) => {
            if (!capturing || !ps.active || ps.patternClockEpoch === null) return;
            params = ps.codeParams;
            epoch = ps.patternClockEpoch;
            pipeline = makePipeline(params, epoch);
            pipeline.updateSolved(liveLeds);
            guideEl.textContent =
              `code renegotiated: ${params.symbols} symbols @ ${params.bitPeriodMs} ms/frame` +
              ` · LED ${Math.round((params.brightness ?? 1) * 100)}%`;
          })
          .catch(() => undefined)
          .finally(() => {
            renegotiating = false;
          });
      };

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
        c.sendExposureReport(report);
        if (!forcedThreshold) {
          detector.threshold = adjustThreshold(detector.threshold, report.blobCount, ledCount);
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
            void ms.setExposure(nextExp, params.bitPeriodMs / 2);
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
      }, 2000);
    } catch (e) {
      manualHooks = null;
      capturing = false;
      stopTimer();
      imuRecorder?.stop();
      imuRecorder = null;
      previewVideo?.remove();
      previewVideo = null;
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
    if (capturing) {
      capturing = false;
      stopTimer();
      imuRecorder?.stop();
      previewVideo?.remove();
      previewVideo = null;
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
    stopBtn.disabled = true;
    stopTimer();
    imuRecorder?.stop();
    imuRecorder = null;
    previewVideo?.remove();
    previewVideo = null;
    if (!sessionAlreadyEnded) await capture?.stop().catch(() => undefined);
    capture = null;
    resetLiveFeedback();

    await solverReady.catch(() => false);
    if (c.hostSolverBenchMs === null && !solverAgent.available) {
      guideEl.textContent = "loading the solver…";
      await solverAgent.init().catch(() => false);
    }
    const placement = chooseSolvePlacement(solverAgent.benchMs, c.hostSolverBenchMs);
    const solveOnPhone = placement === "phone" && solverAgent.available && localDetections.length > 0;
    if (!solveOnPhone && c.hostSolverBenchMs === null) {
      toast(
        solverAgent.available
          ? "Nothing to solve — no LEDs were decoded."
          : "The in-browser solver could not load. Try capturing again.",
        { error: true },
      );
      await c.stopMappingNoSolve().catch(() => undefined);
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
    try {
      let map: OutputMap;
      if (solveOnPhone) {
        await c.stopMappingNoSolve();
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
        await c.submitMap(map);
      } else {
        const result = await c.stopMapping();
        const resp = await fetch(`/maps/${result.mapId}`);
        if (!resp.ok) throw new Error(`fetching map failed: HTTP ${resp.status}`);
        map = (await resp.json()) as OutputMap;
      }
      preview.view?.stop();
      // New tail: save the solved result as a NEW library map (design doc §4.2)
      // and navigate to Map Detail — the workspace is the result.
      const id = await mapStore.create({ map, source: "capture" });
      appState.setSelectedMap(id);
      toast(`Saved ${map.leds.length} LEDs`);
      router.navigate(`/map/${id}`);
    } catch (e) {
      toast(`Reconstruction failed: ${e instanceof Error ? e.message : e}`, { error: true });
      router.navigate("/maps");
    } finally {
      if (solvePoll !== null) clearInterval(solvePoll);
      progWrap.style.display = "none";
      stopBtn.disabled = false;
    }
  }

  return {
    el,
    onMount: () => void startCapture(),
    onUnmount: () => {
      capturing = false;
      stopTimer();
      imuRecorder?.stop();
      previewVideo?.remove();
      previewVideo = null;
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
