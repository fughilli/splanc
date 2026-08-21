/**
 * Perf panel (docs/design/perf-monitoring.md §"Real-time UI"). A live view of
 * the running effect's frame budget, visible when a device is connected. On
 * mount it sends set_perf(FULL, 250ms) and subscribes to perf_report pushes; on
 * unmount it sends set_perf(OFF) so Tier-1 instrumentation isn't paid for when
 * nobody's looking (§"Real-time UI").
 *
 * Contents: a scrolling frame-time-vs-budget line graph (red above the 33 ms
 * line), a stacked per-phase breakdown (update/shade/show), a headroom gauge
 * (green/amber/red), overrun/dropped/samples-dropped badges, and a FULL-mode
 * detail readout (ops-per-LED, stack high-water, heap free/min).
 *
 * When NO device is connected it falls back to the offline cost-model estimate
 * for the selected map's LED count, badged "predicted" with the error band — the
 * same panel per the design ("the same chart component is reused by the offline
 * model with predicted styling").
 */

import { Button, Card, EmptyState, toast } from "../kit";
import { appState } from "../app/state";
import type { Router, Screen } from "../app/router";
import type { PerfMode, PerfReportMessage } from "../../net/proto";
import { mapStore } from "../../store/mapStore";
import { costTableStore } from "../../store/costTableStore";
import {
  estimateFrameTime,
  DEFAULT_BUDGET_MODEL,
  type BudgetModel,
  type Confidence,
  type CostTable,
  type FrameEstimate,
} from "../../effects/costModel";
import { budgetFromEstimate, budgetFromPhases } from "../../effects/budget";
import { BudgetBar } from "./budgetBar";
import { installPerfStyles } from "./perfPanel.css";

const RING = 96; // ~3s at 30fps

interface FramePoint {
  frameMs: number;
  updateMs: number;
  shadeMs: number;
  showMs: number;
}

export function PerfPanelScreen(router: Router): Screen {
  installPerfStyles();
  const el = document.createElement("div");
  el.className = "screen screen--perf";

  const header = document.createElement("div");
  header.className = "perf-header";
  const effectLabel = document.createElement("div");
  effectLabel.className = "perf-effect";
  const sourceBadge = document.createElement("span");
  sourceBadge.className = "perf-badge";
  header.append(effectLabel, sourceBadge);

  const canvas = document.createElement("canvas");
  canvas.className = "perf-graph";
  canvas.width = 640;
  canvas.height = 220;

  const gauge = document.createElement("div");
  gauge.className = "perf-gauge";

  // FUG-11 available-budget progress bar (fraction of the FX budget consumed).
  const budgetBar = BudgetBar();
  let budgetModel: BudgetModel = DEFAULT_BUDGET_MODEL;

  const badges = document.createElement("div");
  badges.className = "perf-badges";

  const detail = document.createElement("div");
  detail.className = "perf-detail";

  const actions = document.createElement("div");
  actions.className = "perf-actions";

  let budgetMs = 1000 / 30;
  let cpuHz = 160_000_000;
  const points: FramePoint[] = [];
  let lastReport: PerfReportMessage | null = null;

  let unsub: (() => void) | null = null;
  let pollTimer: number | null = null;
  let overrunToasted = false;

  const client = appState.client;
  const connected = client !== null && client.isConnected;

  function pushReport(r: PerfReportMessage): void {
    lastReport = r;
    if (r.cpuHz > 0) cpuHz = r.cpuHz;
    if (r.budgetCycles > 0) budgetMs = (r.budgetCycles / cpuHz) * 1000;
    for (const t of r.ticks) {
      points.push({
        frameMs: cyc(t.frameCycles + t.showCycles),
        updateMs: cyc(t.updateCycles),
        shadeMs: cyc(t.shadeCycles),
        showMs: cyc(t.showCycles),
      });
    }
    while (points.length > RING) points.shift();
    if (points.length === 0 && r.frameCyclesMean > 0) {
      points.push({
        frameMs: cyc(r.frameCyclesMean + r.showCyclesMean),
        updateMs: cyc(r.updateCyclesMean),
        shadeMs: cyc(r.shadeCyclesMean),
        showMs: cyc(r.showCyclesMean),
      });
    }
    effectLabel.textContent = r.effectId ? `Effect ${r.effectId}` : "No effect running";
    setBadge("measured");
    renderMeasured(r);
    draw();
  }

  function cyc(c: number): number {
    return (c / cpuHz) * 1000;
  }

  function setBadge(kind: "measured" | "predicted", conf?: Confidence): void {
    sourceBadge.textContent = kind;
    sourceBadge.dataset["kind"] = kind;
    if (conf) sourceBadge.dataset["conf"] = conf;
  }

  function renderMeasured(r: PerfReportMessage): void {
    const frameMeanMs = cyc(r.frameCyclesMean + r.showCyclesMean);
    const headroomMs = budgetMs - frameMeanMs;
    const headroomFrac = budgetMs > 0 ? headroomMs / budgetMs : 0;
    renderGauge(headroomMs, headroomFrac);

    // FUG-11 budget bar: FX compute (update+shade) vs the AVAILABLE budget. Use
    // the device's real frame period so the available budget matches the board.
    budgetBar.el.style.display = "";
    const model: BudgetModel = { ...budgetModel, fps: budgetMs > 0 ? 1000 / budgetMs : budgetModel.fps };
    budgetBar.update(
      budgetFromPhases(
        {
          updateMs: cyc(r.updateCyclesMean),
          shadeMs: cyc(r.shadeCyclesMean),
          showMs: cyc(r.showCyclesMean),
        },
        model,
      ),
    );

    // badges
    badges.innerHTML = "";
    badges.append(
      warnBadge("overruns", r.overruns, r.overruns > 0),
      warnBadge("dropped frames", r.droppedFrames, r.droppedFrames > 0),
    );
    if (r.samplesDropped > 0) {
      const s = document.createElement("span");
      s.className = "perf-note";
      s.textContent = "metrics thinned under load";
      badges.append(s);
    }
    if (headroomMs < 0 && !overrunToasted) {
      overrunToasted = true;
      toast("Effect overruns the 30 fps budget", { error: true });
    }

    // FULL-mode detail readout
    const last = r.ticks.length > 0 ? r.ticks[r.ticks.length - 1]! : null;
    const opsPerLed = last && last.ledCount > 0 ? last.instrShade / last.ledCount : 0;
    detail.innerHTML = "";
    detail.append(
      readout("ops / LED", opsPerLed > 0 ? opsPerLed.toFixed(1) : "—"),
      readout("instr update", last ? String(last.instrUpdate) : "—"),
      readout("stack high-water", last && last.stackMax > 0 ? `${last.stackMax} / 128` : "—"),
      readout("heap free", r.heapFree > 0 ? `${(r.heapFree / 1024).toFixed(0)} KB` : "—"),
      readout("heap min-free", r.heapMinFree > 0 ? `${(r.heapMinFree / 1024).toFixed(0)} KB` : "—"),
      readout(
        "heap max-block",
        r.heapLargestFree > 0 ? `${(r.heapLargestFree / 1024).toFixed(0)} KB` : "—",
      ),
      readout("LEDs", last ? String(last.ledCount) : "—"),
    );
  }

  function renderGauge(headroomMs: number, frac: number): void {
    const conf: Confidence = frac > 0.3 ? "green" : frac >= 0 ? "yellow" : "red";
    gauge.dataset["conf"] = conf;
    gauge.innerHTML = "";
    const big = document.createElement("div");
    big.className = "perf-gauge-num";
    big.textContent = `${headroomMs >= 0 ? "+" : ""}${headroomMs.toFixed(1)} ms`;
    const sub = document.createElement("div");
    sub.className = "perf-gauge-sub";
    sub.textContent = `headroom · ${Math.round(frac * 100)}% of budget`;
    gauge.append(big, sub);
  }

  function renderPredicted(est: FrameEstimate): void {
    setBadge("predicted", est.confidence);
    budgetMs = est.budgetMs;
    // synthesize a flat series so the graph + budget line render.
    points.length = 0;
    for (let i = 0; i < RING; i++) {
      points.push({
        frameMs: est.totalMs,
        updateMs: est.phaseSplit.updateMs,
        shadeMs: est.phaseSplit.shadeMs,
        showMs: est.phaseSplit.showMs,
      });
    }
    const headroomMs = est.budgetMs - est.totalMs;
    const frac = est.budgetMs > 0 ? headroomMs / est.budgetMs : 0;
    budgetBar.el.style.display = "";
    budgetBar.update(budgetFromEstimate(est, budgetModel));
    gauge.dataset["conf"] = est.confidence;
    gauge.innerHTML = "";
    const big = document.createElement("div");
    big.className = "perf-gauge-num";
    big.textContent = `${est.totalMs.toFixed(1)} ms`;
    const sub = document.createElement("div");
    sub.className = "perf-gauge-sub";
    sub.textContent = `predicted · ${est.errorBand.lowMs.toFixed(1)}–${est.errorBand.highMs.toFixed(
      1,
    )} ms (±${Math.round(est.errorBand.fraction * 100)}%) · ${Math.round(frac * 100)}% headroom`;
    gauge.append(big, sub);

    badges.innerHTML = "";
    if (est.branched) {
      const s = document.createElement("span");
      s.className = "perf-note";
      s.textContent = "branch-dependent — showing worst/best band";
      badges.append(s);
    }
    detail.innerHTML = "";
    detail.append(readout("ops / LED", est.opsPerLed.toFixed(1)));
    for (const h of est.hotOpcodes.slice(0, 5)) {
      detail.append(readout(h.op, `${Math.round(h.fraction * 100)}%`));
    }
    draw();
  }

  function draw(): void {
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const pad = 8;
    const plotH = H - pad * 2;
    const maxMs = Math.max(budgetMs * 1.4, ...points.map((p) => p.frameMs), 1);
    const yFor = (ms: number): number => H - pad - (ms / maxMs) * plotH;

    // budget line
    const yb = yFor(budgetMs);
    ctx.strokeStyle = "#e3b341";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad, yb);
    ctx.lineTo(W - pad, yb);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9a9aa2";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`${budgetMs.toFixed(0)} ms budget`, pad + 4, yb - 4);

    if (points.length === 0) return;
    const dx = (W - pad * 2) / Math.max(1, RING - 1);
    const xFor = (i: number): number => pad + i * dx;

    // stacked phase areas: show (bottom) -> shade -> update
    const stackKeys: [keyof FramePoint, string][] = [
      ["showMs", "rgba(91,124,250,0.35)"],
      ["shadeMs", "rgba(55,200,113,0.35)"],
      ["updateMs", "rgba(227,179,65,0.35)"],
    ];
    let baseline = points.map(() => H - pad);
    for (const [key, color] of stackKeys) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(xFor(0), baseline[0]!);
      const tops: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const top = baseline[i]! - (points[i]![key] / maxMs) * plotH;
        tops.push(top);
        ctx.lineTo(xFor(i), top);
      }
      for (let i = points.length - 1; i >= 0; i--) ctx.lineTo(xFor(i), baseline[i]!);
      ctx.closePath();
      ctx.fill();
      baseline = tops;
    }

    // frame-time line (red segments above budget)
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!;
      const b = points[i]!;
      ctx.strokeStyle = b.frameMs > budgetMs ? "#f2555a" : "#e8e8ea";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(xFor(i - 1), yFor(a.frameMs));
      ctx.lineTo(xFor(i), yFor(b.frameMs));
      ctx.stroke();
    }
  }

  function warnBadge(label: string, count: number, warn: boolean): HTMLElement {
    const s = document.createElement("span");
    s.className = "perf-badge-count";
    if (warn) s.classList.add("perf-badge-count--warn");
    s.textContent = `${count} ${label}`;
    return s;
  }

  function readout(label: string, value: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "perf-readout";
    const l = document.createElement("span");
    l.className = "perf-readout-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "perf-readout-val";
    v.textContent = value;
    d.append(l, v);
    return d;
  }

  async function startMeasured(): Promise<void> {
    if (client === null) return;
    // Source the budget model from the resolved profile (semihost/device/default)
    // so the available-budget bar reflects the board's economics, not just the
    // shipped default. The device frame period still overrides fps per report.
    const { table } = await costTableStore.resolveTable().catch(() => ({ table: null }));
    if (table?.budget) budgetModel = table.budget;
    unsub = client.onPerfReport((r) => pushReport(r));
    try {
      const mode: PerfMode = "FULL";
      const first = await client.setPerf(mode, 250);
      pushReport(first);
      // Fallback poll in case the device is poll-only (interval ignored).
      pollTimer = window.setInterval(() => {
        void client.getPerfReport().then(pushReport).catch(() => undefined);
      }, 1000);
    } catch {
      effectLabel.textContent = "Perf stream unavailable";
    }
  }

  async function startPredicted(): Promise<void> {
    setBadge("predicted");
    effectLabel.textContent = "Offline estimate";
    const mapId = appState.selectedMapId;
    let ledCount = 128;
    if (mapId) {
      const rec = await mapStore.get(mapId).catch(() => null);
      if (rec) ledCount = rec.map.leds.length;
    }
    // We need bytecode to estimate; without a live compiled effect here we show
    // guidance. The editor wires the estimate directly (see perfContext); this
    // screen surfaces the last-known table + a prompt to open the editor.
    const { table, stored } = await costTableStore.resolveTable();
    if (table.budget) budgetModel = table.budget;
    renderNoBytecode(table, stored !== null, ledCount);
  }

  function renderNoBytecode(table: CostTable, calibrated: boolean, ledCount: number): void {
    void estimateFrameTime; // used when an effect is available
    budgetBar.el.style.display = "none"; // no live effect → no budget bar
    gauge.innerHTML = "";
    gauge.dataset["conf"] = "yellow";
    const msg = document.createElement("div");
    msg.className = "perf-gauge-sub";
    msg.textContent = `No device connected. Offline model ${
      calibrated ? "calibrated" : "using defaults"
    } for ${table.soc} @ ${(table.cpuHz / 1e6).toFixed(0)} MHz. Open the shader editor to see a live estimate for ${ledCount} LEDs.`;
    gauge.append(msg);
    detail.innerHTML = "";
  }

  el.append(
    Card(header),
    Card(canvas),
    Card(gauge),
    Card(budgetBar.el),
    Card(badges),
    Card(detail),
    actions,
  );

  actions.append(
    Button({
      label: "Calibrate this device",
      icon: "device",
      variant: connected ? "primary" : "quiet",
      disabled: !connected,
      onClick: () => router.navigate("/perf/calibrate"),
    }),
    Button({
      label: "Manage profiles",
      icon: "settings",
      variant: "quiet",
      onClick: () => router.navigate("/perf/profiles"),
    }),
    Button({
      label: "Effect library",
      icon: "sparkles",
      variant: "quiet",
      // Shader authoring now lives in the in-shell Effects library.
      onClick: () => router.navigate("/effects"),
    }),
  );

  if (!connected) {
    el.insertBefore(
      EmptyState({
        icon: "device",
        title: "No device connected — showing the offline model",
      }),
      el.firstChild,
    );
  }

  return {
    el,
    onMount: () => {
      // Resolve the device's budget model (drives the FUG-11 budget bar); fall
      // back to the default until a calibration/semihost profile is stored.
      void costTableStore
        .resolveTable()
        .then(({ table }) => {
          budgetModel = table.budget ?? DEFAULT_BUDGET_MODEL;
        })
        .catch(() => undefined);
      if (connected) void startMeasured();
      else void startPredicted();
    },
    onUnmount: () => {
      unsub?.();
      unsub = null;
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // Stop paying for Tier-1 instrumentation when the panel closes.
      if (client !== null) void client.setPerf("OFF", 0).catch(() => undefined);
      void lastReport;
    },
  };
}
