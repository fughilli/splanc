/**
 * Calibration flow UI (docs/design/perf-monitoring.md §"Calibration UX"). A
 * one-tap "Calibrate this device": explain → confirm → run ~30 s of tiny
 * benchmark effects on the connected device → least-squares fit → before/after
 * accuracy readout → persist the table → restore the user's effect.
 *
 * If no device is connected it explains that and offers the default table.
 */

import { Button, Card, EmptyState, toast } from "../kit";
import { appState } from "../app/state";
import type { Router, Screen } from "../app/router";
import { clientDevice, runCalibration } from "../../effects/calibration";
import { compileScript } from "../../fx/preview";
import { HELDOUT } from "../../effects/calibrationBenchmarks";
import { estimateFrameTime, parseFxb, walkEntry } from "../../effects/costModel";
import {
  costTableStore,
  defaultCostTable,
  toCostTable,
  type StoredCostTable,
} from "../../store/costTableStore";
import { installPerfStyles } from "./perfPanel.css";

export function CalibrateScreen(router: Router): Screen {
  installPerfStyles();
  const el = document.createElement("div");
  el.className = "screen screen--perf";

  const client = appState.client;
  const connected = client !== null && client.isConnected;

  const headline = document.createElement("h1");
  headline.className = "screen-headline";
  headline.textContent = "Calibrate device";
  const sub = document.createElement("p");
  sub.className = "screen-sub";
  sub.textContent = connected
    ? "Runs a sweep of tiny test effects to learn how fast this board is — one per opcode, so every builtin is measured. Your current effect resumes afterward."
    : "No device connected. The offline model will use its shipped defaults until you calibrate on hardware.";

  el.append(headline, sub);

  if (!connected || client === null) {
    el.append(
      EmptyState({
        icon: "device",
        title: "Connect a device to calibrate",
        action: Button({ label: "Back to perf", icon: "back", onClick: () => router.navigate("/perf") }),
      }),
    );
    return { el };
  }

  const progressWrap = document.createElement("div");
  progressWrap.className = "calib-progress";
  const bar = document.createElement("div");
  bar.className = "calib-bar";
  const fill = document.createElement("div");
  fill.className = "calib-bar-fill";
  fill.style.width = "0%";
  bar.append(fill);
  const log = document.createElement("div");
  log.className = "calib-log";
  progressWrap.append(bar, log);

  const accuracy = document.createElement("div");
  accuracy.className = "calib-accuracy";

  // Tier toggle: default (unchecked) runs the FULL sweep → 100% opcode
  // coverage; "Quick" runs only the cost-dominant core ops for a faster pass.
  const tierLabel = document.createElement("label");
  tierLabel.className = "calib-tier";
  const tierToggle = document.createElement("input");
  tierToggle.type = "checkbox";
  tierLabel.append(tierToggle, document.createTextNode(" Quick pass (cost-dominant ops only; full sweep covers every opcode)"));

  let running = false;

  function appendLog(line: string): void {
    log.textContent += (log.textContent ? "\n" : "") + line;
    log.scrollTop = log.scrollHeight;
  }

  async function heldoutError(table: StoredCostTable | null, ledCount: number): Promise<number | null> {
    // Predict the held-out benchmark and compare to a fresh measurement.
    const compiled = await compileScript(HELDOUT.source);
    if (!compiled.ok || client === null) return null;
    const ct = table ? toCostTable(table) : defaultCostTable();
    const est = estimateFrameTime({ bytecode: compiled.bytecode, ledCount, table: ct });
    // measure
    await client.submitEffect("__calib_heldout", compiled.bytecode, true);
    await client.setPerf("FULL", 0);
    await new Promise((r) => setTimeout(r, 800));
    const r = await client.getPerfReport();
    await client.setPerf("OFF", 0);
    const cpuHz = r.cpuHz || ct.cpuHz;
    const measuredMs = ((r.frameCyclesMean + r.showCyclesMean) / cpuHz) * 1000;
    if (measuredMs <= 0) return null;
    return Math.abs(est.totalMs - measuredMs) / measuredMs;
  }

  async function calibrate(): Promise<void> {
    if (running || client === null) return;
    running = true;
    startBtn.disabled = true;
    accuracy.innerHTML = "";
    log.textContent = "";
    // preserve the running effect id to restore later (best-effort).
    let priorEffect = "";
    try {
      const u = await client.getEffectUniforms();
      priorEffect = u.effectId;
    } catch {
      /* no active effect */
    }

    const label = appState.welcome()?.sessionId ?? "device";
    const build = "unknown";
    // before-accuracy (default table)
    appendLog("Measuring held-out benchmark with the default model…");
    const beforeErr = await heldoutError(null, HELDOUT.ledCount).catch(() => null);

    let result;
    try {
      result = await runCalibration(clientDevice(client), {
        deviceLabel: String(label),
        firmwareBuild: build,
        tier: tierToggle.checked ? "core" : "full",
        onProgress: (p) => {
          fill.style.width = `${Math.round((p.step / p.total) * 100)}%`;
          appendLog(p.detail ? `${p.label} — ${p.detail}` : p.label);
        },
      });
    } catch (e) {
      toast("Calibration failed", { error: true });
      appendLog(`error: ${(e as Error).message}`);
      running = false;
      startBtn.disabled = false;
      return;
    }

    await costTableStore.save(result.table);
    fill.style.width = "100%";
    appendLog(`Fit residual: ±${(result.table.residualError * 100).toFixed(1)}%`);

    // after-accuracy (calibrated table)
    appendLog("Re-measuring held-out benchmark with the calibrated model…");
    const afterErr = await heldoutError(result.table, HELDOUT.ledCount).catch(() => null);

    accuracy.append(
      accCol("before", beforeErr),
      accCol("after", afterErr),
      accCol("fit residual", result.table.residualError),
    );

    // restore the user's effect
    if (priorEffect) {
      await client.setEffect(priorEffect).catch(() => undefined);
      appendLog(`Restored effect ${priorEffect}.`);
    }
    toast(`Calibrated ${result.table.soc} @ ${(result.cpuHz / 1e6).toFixed(0)} MHz`);
    running = false;
    startBtn.disabled = false;
  }

  function accCol(label: string, err: number | null): HTMLElement {
    const d = document.createElement("div");
    d.className = "perf-readout";
    const l = document.createElement("span");
    l.className = "perf-readout-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "perf-readout-val";
    v.textContent = err === null ? "—" : `±${(err * 100).toFixed(1)}%`;
    d.append(l, v);
    return d;
  }

  const startBtn = Button({
    label: "Start calibration",
    icon: "device",
    variant: "primary",
    onClick: () => void calibrate(),
  });

  el.append(Card(progressWrap), Card(accuracy), tierLabel, startBtn);

  void parseFxb;
  void walkEntry;
  return { el };
}
