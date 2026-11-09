/**
 * On-fixture performance measurement for the effect AI (`measure_on_device`).
 *
 * `estimate_performance` is the cheap offline loop (the cost model, instant,
 * interpreter-only); this is the ground truth. It runs the CURRENT compiled
 * script on the connected fixture with FULL perf instrumentation, polls the
 * device's PerfReport stream over a short window, and summarizes it in the same
 * shape as the estimate (perfContextToPrompt) plus the stream statistics — so the
 * agent can iterate offline and confirm (or correct course) against the device.
 *
 * Pure of the DOM: the editor / Acid Mode adapt their client into `PerfDevice`,
 * and tests drive a fake. Device-touching work is serialized through
 * `withDeviceLock` (the editor's push path shares it), and every device call is
 * bounded by a timeout so a wedged link can't hang the chat turn.
 */

import type { PerfReportMessage, UniformValueFlat } from "../net/proto";
import type { CostTable } from "./costModel";
import { contextFromReport, perfContextToPrompt } from "./perfContext";

/** What measure_on_device needs from a connected player. */
export interface PerfDevice {
  isConnected: boolean;
  /** Welcome.features when the firmware advertises them (else undefined). */
  features?: string[] | undefined;
  /** The effect the device is running now ("" = none), if known. */
  runningEffectId(): Promise<string>;
  submitEffect(effectId: string, fxb: Uint8Array): Promise<unknown>;
  setUniforms(values: UniformValueFlat[]): void;
  setPerf(mode: "OFF" | "BASIC" | "FULL", intervalMs: number): Promise<PerfReportMessage>;
  getPerfReport(): Promise<PerfReportMessage>;
}

/** The slice of LedMapperClient the adapter uses (structural, so tests and the
 * BLE transport fit too). */
export interface PerfClientLike {
  isConnected: boolean;
  welcome: unknown;
  getEffectUniforms(): Promise<{ effectId: string }>;
  submitEffect(effectId: string, fxb: Uint8Array, activate?: boolean): Promise<unknown>;
  setUniforms(values: UniformValueFlat[]): boolean;
  setPerf(mode: "OFF" | "BASIC" | "FULL", intervalMs?: number): Promise<PerfReportMessage>;
  getPerfReport(): Promise<PerfReportMessage>;
}

/** Adapt the app's client into a PerfDevice (null when there is none). */
export function perfDeviceFromClient(c: PerfClientLike | null | undefined): PerfDevice | null {
  if (!c) return null;
  const features = (c.welcome as { features?: unknown } | null)?.features;
  return {
    isConnected: c.isConnected,
    features: Array.isArray(features) ? (features as string[]) : undefined,
    runningEffectId: async () => (await c.getEffectUniforms()).effectId,
    submitEffect: (id, fxb) => c.submitEffect(id, fxb, true),
    setUniforms: (v) => void c.setUniforms(v),
    setPerf: (mode, iv) => c.setPerf(mode, iv),
    getPerfReport: () => c.getPerfReport(),
  };
}

/** Resolve the model's {name, value} operating point against the manifest. */
export function resolveUniforms(
  args: { name: string; value: number[] }[] | undefined,
  manifest: { name: string; slot: number; width: number }[],
): { values: UniformValueFlat[]; unknown: string[] } {
  const values: UniformValueFlat[] = [];
  const unknown: string[] = [];
  for (const a of args ?? []) {
    const u = manifest.find((m) => m.name === a.name);
    if (!u) unknown.push(a.name);
    else values.push({ slot: u.slot, value: a.value.slice(0, Math.max(1, u.width)) });
  }
  return { values, unknown };
}

/** Whether a device can be measured: connected, and (when the firmware lists its
 * features) advertising "perf". Firmware predating Welcome.features all serve
 * set_perf / get_perf_report. */
export function canMeasure(dev: PerfDevice | null | undefined): dev is PerfDevice {
  if (!dev || !dev.isConnected) return false;
  return dev.features === undefined || dev.features.length === 0 || dev.features.includes("perf");
}

// One device-touching operation at a time (a push, a measurement): the player
// has one wss session and interleaving an upload with a perf drain would mix
// the two effects' windows.
let deviceChain: Promise<unknown> = Promise.resolve();
export function withDeviceLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = deviceChain.then(fn, fn);
  deviceChain = run.catch(() => undefined);
  return run;
}

export class DeviceTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new DeviceTimeout(`${what} timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const MEASURE_DEFAULT_SECONDS = 3;
export const MEASURE_MAX_SECONDS = 10;
/** Poll period: each get_perf_report drains one window of frames. */
const POLL_MS = 500;

export interface MeasureOptions {
  effectId: string;
  /** The compiled .fxb to run (the editor's latest compile). */
  bytecode: Uint8Array;
  /** Skip the upload: the device is already running exactly this program. */
  alreadyRunning?: boolean | undefined;
  seconds?: number | undefined;
  /** Uniforms to hold during the capture (an operating point). */
  uniforms?: UniformValueFlat[] | undefined;
  /** The cost table for the measured-context render (cpuHz/budget fallbacks). */
  table: CostTable;
  calibrated: boolean;
  /** Offline prediction at the device's LED count, for the comparison line. */
  predict?: (ledCount: number) => { totalMs: number; lowMs: number; highMs: number } | null;
  /** Per-call device timeout (ms). */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const ms = (cycles: number, hz: number): number => (hz > 0 ? (cycles / hz) * 1000 : 0);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[i]!;
}

/**
 * The three sample populations one capture yields (#453), kept apart so no
 * statistic is presented as covering more than it does:
 *  - windows: each poll's firmware rolling summary over the frames buffered in
 *    its perf ring at that moment (≤16; the count is not reported, and frames
 *    left in the ring after a poll appear again in the next window);
 *  - ticks: the raw per-frame samples a poll returns — at most the reply's
 *    field capacity (a few) per poll, oldest-first, so a SUBSET of frames;
 *  - counters: overruns / dropped rendering frames since the previous poll,
 *    counted on the device over EVERY frame, plus samplesDropped — perf-ring
 *    overflow, i.e. frames missing from the ticks and windows.
 */
export interface CapturePopulations {
  windows: number;
  /** Mean of the window means (unweighted: window sizes are not reported). */
  windowMeanMs: number;
  windowMeansMs: number[];
  /** Largest per-window frame max (+ that window's mean show time). */
  windowMaxMs: number;
  /** Returned per-frame tick samples (frame + show), unsorted. */
  tickMs: number[];
  overruns: number;
  droppedFrames: number;
  samplesDropped: number;
}

/** Split a window stream into its populations (pure). */
export function capturePopulations(windows: PerfReportMessage[], hz: number): CapturePopulations {
  const usable = windows.filter((w) => w.frameCyclesMean > 0);
  const winMeans = usable.map((w) => ms(w.frameCyclesMean + w.showCyclesMean, hz));
  const tickMs: number[] = [];
  for (const w of usable) {
    for (const t of w.ticks) if (t.frameCycles > 0) tickMs.push(ms(t.frameCycles + t.showCycles, hz));
  }
  const sum = (f: (w: PerfReportMessage) => number): number => usable.reduce((s, w) => s + (f(w) || 0), 0);
  return {
    windows: usable.length,
    windowMeanMs: winMeans.length > 0 ? winMeans.reduce((a, b) => a + b, 0) / winMeans.length : 0,
    windowMeansMs: winMeans,
    windowMaxMs: usable.reduce(
      (m, w) => Math.max(m, ms(Math.max(w.frameCyclesMax, w.frameCyclesMean) + w.showCyclesMean, hz)),
      0,
    ),
    tickMs,
    overruns: sum((w) => w.overruns),
    droppedFrames: sum((w) => w.droppedFrames),
    // Each report resets the counter, so the sum is the capture's total.
    samplesDropped: sum((w) => w.samplesDropped),
  };
}

/** Summarize a window stream into the agent-facing text (pure; exported for tests). */
export function summarizeWindows(
  windows: PerfReportMessage[],
  opts: Pick<MeasureOptions, "table" | "calibrated" | "predict"> & { notes?: string[] },
): string {
  return summarizeCapture(windows, opts).text;
}

/** summarizeWindows plus the measured budget fraction (undefined: no frames). */
export function summarizeCapture(
  windows: PerfReportMessage[],
  opts: Pick<MeasureOptions, "table" | "calibrated" | "predict"> & { notes?: string[] },
): { text: string; budgetFraction?: number } {
  const usable = windows.filter((w) => w.frameCyclesMean > 0);
  if (usable.length === 0) {
    return { text: [
      ...(opts.notes ?? []),
      "measure_on_device: the fixture reported no frames for this effect during the capture " +
        "(is it rendering? an effect that errors every frame reports nothing). Check the compile " +
        "result and try again.",
    ].join("\n") };
  }
  const hz = usable[usable.length - 1]!.cpuHz || opts.table.cpuHz;
  const pop = capturePopulations(usable, hz);
  // The measured context renders from a merged report: window means averaged
  // (the SAME population as the headline and the estimate comparison), the
  // counters summed over the capture, the newest window's ticks/heap.
  const avg = (f: (w: PerfReportMessage) => number): number =>
    usable.reduce((s, w) => s + f(w), 0) / usable.length;
  const last = usable[usable.length - 1]!;
  const merged: PerfReportMessage = {
    ...last,
    frameCyclesMean: avg((w) => w.frameCyclesMean),
    updateCyclesMean: avg((w) => w.updateCyclesMean),
    shadeCyclesMean: avg((w) => w.shadeCyclesMean),
    showCyclesMean: avg((w) => w.showCyclesMean),
    overruns: pop.overruns,
    droppedFrames: pop.droppedFrames,
    samplesDropped: pop.samplesDropped,
  };
  const ctx = contextFromReport(merged, opts.table, opts.calibrated);
  ctx.population =
    `unweighted mean of ${pop.windows} rolling-window means (each window = the frames buffered on the ` +
    "device at that poll; sizes not reported, windows may overlap)";
  const lastTick = [...usable].reverse().find((w) => w.ticks.length > 0)?.ticks;
  const leds = lastTick && lastTick.length > 0 ? lastTick[lastTick.length - 1]!.ledCount : 0;
  const lines = [...(opts.notes ?? [])];
  lines.push(`Measured ON THE FIXTURE (${pop.windows} polls${leds > 0 ? `, ${leds} LEDs` : ""}):`);
  lines.push(
    `- Rolling windows (${pop.windows}): mean ${pop.windowMeanMs.toFixed(2)} ms (unweighted mean of the window ` +
      `means; window sizes are not reported); per-window means ${pop.windowMeansMs
        .map((v) => v.toFixed(2))
        .join(" / ")} ms; largest window max ${pop.windowMaxMs.toFixed(2)} ms.`,
  );
  if (pop.tickMs.length > 0) {
    const sorted = [...pop.tickMs].sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    lines.push(
      `- Returned per-frame tick samples (${sorted.length}, a SUBSET: each poll returns only a few of the frames ` +
        `rendered): mean ${mean.toFixed(2)} ms, p95 ${percentile(sorted, 0.95).toFixed(2)} ms, max ${sorted[
          sorted.length - 1
        ]!.toFixed(2)} ms. Sample statistics only — not a full-capture p95/max; a stutter between samples ` +
        "shows up in the window max and the overrun count, not here.",
    );
  } else {
    lines.push(
      "- No per-frame tick samples were returned (window summaries only): there are no per-frame " +
        "percentiles for this capture; the window means above stand in.",
    );
  }
  lines.push(
    `- Device counters over every frame of the capture: overruns ${pop.overruns}, dropped rendering frames ${pop.droppedFrames}.`,
  );
  lines.push(
    pop.samplesDropped > 0
      ? `- Measurement samples dropped (perf-ring overflow, NOT dropped rendering frames): ${pop.samplesDropped} — ` +
          "those frames are missing from the tick samples and windows, so the statistics above may hide stutters."
      : "- Measurement samples dropped (perf-ring overflow): 0.",
  );
  lines.push(perfContextToPrompt(ctx));
  const pred = leds > 0 ? opts.predict?.(leds) ?? null : null;
  if (pred) {
    // Compared against the rolling-window mean: the same population as the
    // perf-context frame time, so the two numbers the agent sees agree.
    const measured = pop.windowMeanMs;
    const inBand = measured >= pred.lowMs && measured <= pred.highMs;
    const delta = pred.totalMs > 0 ? ((measured - pred.totalMs) / pred.totalMs) * 100 : 0;
    lines.push(
      `Offline estimate for the same program at ${leds} LEDs: ${pred.totalMs.toFixed(2)} ms ` +
        `(band ${pred.lowMs.toFixed(2)}–${pred.highMs.toFixed(2)} ms); the measured rolling-window mean ` +
        `(${measured.toFixed(2)} ms) is ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}% — ${
          inBand ? "inside" : "OUTSIDE"
        } the band.` +
        (inBand ? "" : " Trust the measurement; the estimate models the interpreter (the device may JIT)."),
    );
  }
  return { text: lines.join("\n"), budgetFraction: ctx.metrics.budgetFraction };
}

export interface MeasureResult {
  /** The agent-facing summary. */
  text: string;
  /** Measured frame-time / frame-budget (rolling-window mean), when frames came back. */
  budgetFraction?: number;
  /** The fixture is now running `bytecode` (uploaded, or already was). */
  deployed: boolean;
}

/**
 * Run the program on the fixture and measure it. Never throws for device
 * trouble (it reports it in `text`), so a wedged fixture ends the tool call,
 * not the chat turn.
 */
export async function measureOnDevice(
  dev: PerfDevice | null | undefined,
  opts: MeasureOptions,
): Promise<MeasureResult> {
  if (!canMeasure(dev)) {
    return {
      text: "measure_on_device: no fixture with perf support is connected — use estimate_performance (offline) instead.",
      deployed: false,
    };
  }
  const sleep = opts.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t)));
  const timeoutMs = opts.timeoutMs ?? 8000;
  const seconds = Math.min(MEASURE_MAX_SECONDS, Math.max(1, opts.seconds ?? MEASURE_DEFAULT_SECONDS));
  return withDeviceLock(async () => {
    const notes: string[] = [];
    let perfOn = false;
    let deployed = opts.alreadyRunning === true;
    try {
      if (!opts.alreadyRunning) {
        const before = await withTimeout(dev.runningEffectId(), timeoutMs, "reading the running effect").catch(
          () => "",
        );
        await withTimeout(dev.submitEffect(opts.effectId, opts.bytecode), timeoutMs * 2, "uploading the effect");
        deployed = true;
        notes.push(
          before && before !== opts.effectId
            ? `Note: the fixture was running "${before}"; it now runs this workspace's effect (tell the user).`
            : "Uploaded the current script to the fixture.",
        );
      }
      if (opts.uniforms && opts.uniforms.length > 0) dev.setUniforms(opts.uniforms);
      // FULL, poll-only. The reply is the window so far (mixed with whatever ran
      // before the upload): discard it, then let one window settle (JIT/warm-up).
      await withTimeout(dev.setPerf("FULL", 0), timeoutMs, "enabling perf");
      perfOn = true;
      await sleep(POLL_MS);
      await withTimeout(dev.getPerfReport(), timeoutMs, "draining perf");
      const windows: PerfReportMessage[] = [];
      const n = Math.max(2, Math.round((seconds * 1000) / POLL_MS));
      for (let i = 0; i < n; i++) {
        await sleep(POLL_MS);
        const r = await withTimeout(dev.getPerfReport(), timeoutMs, "reading perf");
        if (!r.effectId || r.effectId === opts.effectId) windows.push(r);
      }
      const summary = summarizeCapture(windows, { ...opts, notes });
      return {
        text: summary.text,
        deployed,
        ...(summary.budgetFraction !== undefined ? { budgetFraction: summary.budgetFraction } : {}),
      };
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return {
        text: [...notes, `measure_on_device failed: ${why}. The offline estimate still applies; retry later.`].join(
          "\n",
        ),
        deployed,
      };
    } finally {
      // Instrumentation off again (FULL costs cycles on every frame).
      if (perfOn) await withTimeout(dev.setPerf("OFF", 0), timeoutMs, "disabling perf").catch(() => undefined);
    }
  });
}
