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

/** Summarize a window stream into the agent-facing text (pure; exported for tests). */
export function summarizeWindows(
  windows: PerfReportMessage[],
  opts: Pick<MeasureOptions, "table" | "calibrated" | "predict"> & { notes?: string[] },
): string {
  const usable = windows.filter((w) => w.frameCyclesMean > 0);
  if (usable.length === 0) {
    return [
      ...(opts.notes ?? []),
      "measure_on_device: the fixture reported no frames for this effect during the capture " +
        "(is it rendering? an effect that errors every frame reports nothing). Check the compile " +
        "result and try again.",
    ].join("\n");
  }
  const hz = usable[usable.length - 1]!.cpuHz || opts.table.cpuHz;
  // Per-frame totals (frame + show) from FULL-mode ticks when present; else the
  // window means stand in for frames.
  const frames: number[] = [];
  for (const w of usable) {
    if (w.ticks.length > 0) {
      for (const t of w.ticks) if (t.frameCycles > 0) frames.push(ms(t.frameCycles + t.showCycles, hz));
    } else {
      frames.push(ms(w.frameCyclesMean + w.showCyclesMean, hz));
    }
  }
  frames.sort((a, b) => a - b);
  const mean = frames.reduce((s, v) => s + v, 0) / frames.length;
  const winMeans = usable.map((w) => ms(w.frameCyclesMean + w.showCyclesMean, hz));
  const overruns = usable.reduce((s, w) => s + w.overruns, 0);
  const dropped = usable.reduce((s, w) => s + w.droppedFrames, 0);
  // The measured context renders from a merged report: window means averaged,
  // the newest window's ticks/heap.
  const avg = (f: (w: PerfReportMessage) => number): number =>
    usable.reduce((s, w) => s + f(w), 0) / usable.length;
  const last = usable[usable.length - 1]!;
  const merged: PerfReportMessage = {
    ...last,
    frameCyclesMean: avg((w) => w.frameCyclesMean),
    updateCyclesMean: avg((w) => w.updateCyclesMean),
    shadeCyclesMean: avg((w) => w.shadeCyclesMean),
    showCyclesMean: avg((w) => w.showCyclesMean),
    overruns,
    droppedFrames: dropped,
  };
  const ctx = contextFromReport(merged, opts.table, opts.calibrated);
  const leds = last.ticks.length > 0 ? last.ticks[last.ticks.length - 1]!.ledCount : 0;
  const lines = [...(opts.notes ?? [])];
  lines.push(
    `Measured ON THE FIXTURE (${usable.length} windows, ${frames.length} frames${
      leds > 0 ? `, ${leds} LEDs` : ""
    }): frame mean ${mean.toFixed(2)} ms, p95 ${percentile(frames, 0.95).toFixed(2)} ms, max ${frames[
      frames.length - 1
    ]!.toFixed(2)} ms; per-window means ${winMeans.map((v) => v.toFixed(2)).join(" / ")} ms.`,
  );
  lines.push(perfContextToPrompt(ctx));
  const pred = leds > 0 ? opts.predict?.(leds) ?? null : null;
  if (pred) {
    const inBand = mean >= pred.lowMs && mean <= pred.highMs;
    const delta = pred.totalMs > 0 ? ((mean - pred.totalMs) / pred.totalMs) * 100 : 0;
    lines.push(
      `Offline estimate for the same program at ${leds} LEDs: ${pred.totalMs.toFixed(2)} ms ` +
        `(band ${pred.lowMs.toFixed(2)}–${pred.highMs.toFixed(2)} ms); measured is ${
          delta >= 0 ? "+" : ""
        }${delta.toFixed(0)}% — ${inBand ? "inside" : "OUTSIDE"} the band.` +
        (inBand ? "" : " Trust the measurement; the estimate models the interpreter (the device may JIT)."),
    );
  }
  return lines.join("\n");
}

export interface MeasureResult {
  /** The agent-facing summary. */
  text: string;
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
      return { text: summarizeWindows(windows, { ...opts, notes }), deployed };
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
