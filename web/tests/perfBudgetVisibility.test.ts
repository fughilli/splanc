/**
 * Performance visibility against the device budget (PR-18): what the USER sees
 * to judge whether an effect will run within budget on the board —
 *   - the perf panel (ui/screens/perfPanel.ts) driven by live PerfReports: the
 *     headroom gauge (ms + % of budget, green > 30% / amber 0–30% / red negative,
 *     docs/design/perf-monitoring.md §"Real-time UI"), the FUG-11 budget bar, the
 *     overrun / dropped-frame badges + one-shot overrun toast, and the FULL-mode
 *     detail readout — measured against the DEVICE's own frame budget;
 *   - the offline fallback when no device is connected;
 *   - the budget-bar widget itself (ui/screens/budgetBar.ts: fill, band colour,
 *     overrun / starved labels, a11y);
 *   - per-device estimates across a fleet (effects/multiDevice.ts) and the perf
 *     context the editor's assistant reports from (effects/perfContext.ts).
 * budget.test.ts pins the pure budget math; this suite pins the rendered result.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { installFakeDom, asFake, textOf, type FakeElement } from "./fakeDom";
import type { LedMapperClient } from "../src/net/client";
import type { PerfReportMessage } from "../src/net/proto";
import type { Router, Screen } from "../src/ui/app/router";
import { budgetConsumption, computeBudget } from "../src/effects/budget";
import {
  DEFAULT_BUDGET_MODEL,
  OPCODE_NAMES,
  estimateFrameTime,
  type BudgetModel,
} from "../src/effects/costModel";
import { describeFleet, estimateAcrossDevices, type DeviceTarget } from "../src/effects/multiDevice";
import { contextFromEstimate, contextFromReport, perfContextToPrompt } from "../src/effects/perfContext";
import { defaultCostTable } from "../src/store/costTableStore";

// The UI modules are imported lazily (after this) so they see the fake DOM.
installFakeDom();

const CPU_HZ = 160_000_000;
const CODE: Record<string, number> = Object.fromEntries(OPCODE_NAMES.map((n, i) => [n, i]));

/** A device PerfReport whose phase means are given in ms. */
function perfReport(o: {
  updateMs: number;
  shadeMs: number;
  showMs: number;
  fps?: number;
  leds?: number;
  instrShade?: number;
  overruns?: number;
  droppedFrames?: number;
  samplesDropped?: number;
}): PerfReportMessage {
  const cyc = (ms: number): number => Math.round((ms / 1000) * CPU_HZ);
  const update = cyc(o.updateMs);
  const shade = cyc(o.shadeMs);
  const show = cyc(o.showMs);
  const leds = o.leds ?? 256;
  return {
    type: "perf_report",
    effectId: "plasma",
    fxbHash: 0x1234,
    cpuHz: CPU_HZ,
    budgetCycles: Math.round(CPU_HZ / (o.fps ?? 30)),
    frameCyclesMin: update + shade,
    frameCyclesMean: update + shade,
    frameCyclesMax: update + shade,
    updateCyclesMean: update,
    shadeCyclesMean: shade,
    showCyclesMean: show,
    overruns: o.overruns ?? 0,
    droppedFrames: o.droppedFrames ?? 0,
    samplesDropped: o.samplesDropped ?? 0,
    heapFree: 102_400,
    heapMinFree: 81_920,
    heapLargestFree: 40_960,
    ticks: [
      {
        seq: 1,
        updateCycles: update,
        shadeCycles: shade,
        frameCycles: update + shade,
        showCycles: show,
        ledCount: leds,
        instrUpdate: 120,
        instrShade: o.instrShade ?? leds * 42,
        stackMax: 17,
      },
    ],
  };
}

/** A connected client that answers set_perf with `first` and lets the test push
 * further reports through the panel's onPerfReport subscription. */
class PerfClient {
  readonly isConnected = true;
  readonly perfCalls: [string, number][] = [];
  private readonly subs = new Set<(r: PerfReportMessage) => void>();
  constructor(private readonly first: PerfReportMessage) {}
  onPerfReport(fn: (r: PerfReportMessage) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  async setPerf(mode: string, intervalMs: number): Promise<PerfReportMessage> {
    this.perfCalls.push([mode, intervalMs]);
    return this.first;
  }
  async getPerfReport(): Promise<PerfReportMessage> {
    return this.first;
  }
  push(r: PerfReportMessage): void {
    for (const fn of this.subs) fn(r);
  }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Mount the perf panel with `client` as the active connection. */
async function mountPanel(
  t: TestContext,
  client: PerfClient | null,
): Promise<{ screen: Screen; el: FakeElement }> {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] }); // poll timer + toasts
  const { appState } = await import("../src/ui/app/state");
  const { PerfPanelScreen } = await import("../src/ui/screens/perfPanel");
  appState.client = client as unknown as LedMapperClient | null;
  const screen = PerfPanelScreen({ navigate() {} } as unknown as Router);
  screen.onMount?.();
  await flush();
  t.after(() => {
    screen.onUnmount?.();
    appState.client = null;
  });
  return { screen, el: asFake(screen.el) };
}

function gaugeOf(el: FakeElement): { conf: string | undefined; num: string; sub: string } {
  const g = el.querySelector(".perf-gauge")!;
  return {
    conf: g.dataset["conf"],
    num: textOf(g.querySelector(".perf-gauge-num") ?? g),
    sub: textOf(g.querySelector(".perf-gauge-sub")),
  };
}

function readouts(el: FakeElement): Record<string, string> {
  return Object.fromEntries(
    el
      .querySelectorAll(".perf-detail .perf-readout")
      .map((r) => [
        textOf(r.querySelector(".perf-readout-label")),
        textOf(r.querySelector(".perf-readout-val")),
      ]),
  );
}

function toastsSaying(text: string): number {
  return asFake(document.body)
    .querySelectorAll(".k-toast")
    .filter((n) => textOf(n) === text).length;
}

/** The available FX budget the bar measures against: the frame period minus the
 * reserved system share (DEFAULT_BUDGET_MODEL) minus the LED transmit time. */
function availableFxMs(budgetMs: number, showMs: number): number {
  return budgetMs * DEFAULT_BUDGET_MODEL.cpuAvailableFraction - showMs;
}

test("a live effect within budget shows its headroom, budget share and per-LED cost [rr:PR-18]", async (t) => {
  const client = new PerfClient(
    perfReport({ updateMs: 1, shadeMs: 8, showMs: 3, leds: 256, instrShade: 256 * 42 }),
  );
  const { el } = await mountPanel(t, client);

  assert.deepEqual(client.perfCalls[0], ["FULL", 250], "opening the panel streams FULL-mode reports");
  assert.equal(textOf(el.querySelector(".perf-effect")), "Effect plasma");
  assert.equal(textOf(el.querySelector(".perf-badge")), "measured");

  // 12 ms of a 33.3 ms frame → +21.3 ms (64%) headroom → green.
  const g = gaugeOf(el);
  assert.equal(g.num, "+21.3 ms");
  assert.equal(g.sub, "headroom · 64% of budget");
  assert.equal(g.conf, "green");

  // The budget bar: update+shade against the FX budget left after transmit.
  const bar = el.querySelector(".perf-budget")!;
  const pct = Math.round((9 / availableFxMs(1000 / 30, 3)) * 100);
  assert.equal(bar.style.display, "");
  assert.equal(bar.dataset["color"], "green");
  assert.equal(bar.getAttribute("role"), "progressbar");
  assert.equal(bar.getAttribute("aria-valuenow"), String(pct));
  assert.equal(textOf(bar.querySelector(".perf-budget-pct")), `${pct}%`);

  const r = readouts(el);
  assert.equal(r["ops / LED"], "42.0");
  assert.equal(r["LEDs"], "256");
  assert.equal(r["heap free"], "100 KB");
  assert.equal(r["stack high-water"], "17 / 128");
  for (const b of el.querySelectorAll(".perf-badge-count")) {
    assert.ok(!b.classList.contains("perf-badge-count--warn"), `${textOf(b)} must not warn`);
  }
});

test("an overrunning effect turns the gauge and bar red, flags the drops and toasts once [rr:PR-18]", async (t) => {
  const over = perfReport({
    updateMs: 2,
    shadeMs: 30,
    showMs: 4,
    overruns: 3,
    droppedFrames: 2,
    samplesDropped: 5,
  });
  const client = new PerfClient(over);
  const before = toastsSaying("Effect overruns the 30 fps budget");
  const { el } = await mountPanel(t, client);

  // 36 ms in a 33.3 ms frame: negative headroom.
  const g = gaugeOf(el);
  assert.equal(g.num, "-2.7 ms");
  assert.equal(g.sub, "headroom · -8% of budget");
  assert.equal(g.conf, "red");

  const bar = el.querySelector(".perf-budget")!;
  assert.equal(bar.dataset["color"], "red");
  assert.equal(el.querySelector(".perf-budget-fill")!.style.width, "100%");
  assert.match(textOf(bar.querySelector(".perf-budget-pct")), /^\d+% · overrun$/);
  assert.match(bar.getAttribute("aria-label") ?? "", /\(overrun\)$/);

  const badges = el.querySelectorAll(".perf-badge-count");
  assert.deepEqual(badges.map(textOf), ["3 overruns", "2 dropped frames"]);
  assert.ok(badges.every((b) => b.classList.contains("perf-badge-count--warn")));
  assert.equal(textOf(el.querySelector(".perf-note")), "metrics thinned under load");

  // The toast fires on the first negative headroom only, not on every report.
  assert.equal(toastsSaying("Effect overruns the 30 fps budget"), before + 1);
  client.push(over);
  client.push(over);
  assert.equal(toastsSaying("Effect overruns the 30 fps budget"), before + 1);
});

test("headroom is measured against the device's own frame budget, not a fixed 33 ms [rr:PR-18]", async (t) => {
  // A 60 fps board (16.7 ms frames): 18 ms overruns even though it would leave
  // ~46% headroom at 30 fps.
  const client = new PerfClient(perfReport({ updateMs: 1, shadeMs: 14, showMs: 3, fps: 60 }));
  const { el } = await mountPanel(t, client);
  assert.equal(gaugeOf(el).num, "-1.3 ms");
  assert.equal(gaugeOf(el).conf, "red");
  const bar = el.querySelector(".perf-budget")!;
  assert.equal(bar.dataset["color"], "red");
  assert.equal(bar.getAttribute("aria-valuenow"), "100");

  // A lighter frame on the same board: 14 ms → +2.7 ms (16%) → amber.
  client.push(perfReport({ updateMs: 1, shadeMs: 10, showMs: 3, fps: 60 }));
  assert.equal(gaugeOf(el).num, "+2.7 ms");
  assert.equal(gaugeOf(el).sub, "headroom · 16% of budget");
  assert.equal(gaugeOf(el).conf, "yellow");
  const pct = Math.round((11 / availableFxMs(1000 / 60, 3)) * 100);
  assert.equal(bar.getAttribute("aria-valuenow"), String(Math.min(100, pct)));
});

test("with no device the panel says it is showing the offline model and its basis [rr:PR-18]", async (t) => {
  const { el } = await mountPanel(t, null);
  assert.equal(
    textOf(el.querySelector(".k-empty")),
    "No device connected — showing the offline model",
  );
  assert.equal(textOf(el.querySelector(".perf-badge")), "predicted");
  assert.equal(textOf(el.querySelector(".perf-effect")), "Offline estimate");
  assert.equal(
    textOf(el.querySelector(".perf-gauge .perf-gauge-sub")),
    "No device connected. Offline model using defaults for esp32c6 @ 160 MHz. " +
      "Open the shader editor to see a live estimate for 128 LEDs.",
  );
  // No live effect → no budget bar; calibration needs a board.
  assert.equal(el.querySelector(".perf-budget")!.style.display, "none");
  const calibrate = el.querySelectorAll("button").find((b) => textOf(b) === "Calibrate this device")!;
  assert.ok(calibrate.hasAttribute("disabled"));
});

test("the budget bar widget renders each budget band, overrun and starvation [rr:PR-18]", async () => {
  const { BudgetBar } = await import("../src/ui/screens/budgetBar");
  const model: BudgetModel = { fps: 30, cpuAvailableFraction: 0.85, transmitReservesCpu: false };
  const avail = computeBudget(model, 4).availableFxMs;
  const bar = BudgetBar();
  const el = asFake(bar.el);
  type View = { color: string | undefined; fill: string; pct: string; detail: string; aria: string | null };
  const view = (): View => ({
    color: el.dataset["color"],
    fill: el.querySelector(".perf-budget-fill")!.style.getPropertyValue("width"),
    pct: textOf(el.querySelector(".perf-budget-pct")),
    detail: textOf(el.querySelector(".perf-budget-detail")),
    aria: el.getAttribute("aria-label"),
  });

  // 70/90% threshold guides sit on the track.
  assert.deepEqual(
    el.querySelectorAll(".perf-budget-tick").map((t) => t.style.left),
    ["70%", "90%"],
  );

  bar.update(budgetConsumption(model, avail * 0.5, 4));
  assert.deepEqual(view(), {
    color: "green",
    fill: "50%",
    pct: "50%",
    detail: `${(avail * 0.5).toFixed(1)} / ${avail.toFixed(1)} ms of FX budget`,
    aria: "FX budget used: 50%",
  });
  bar.update(budgetConsumption(model, avail * 0.8, 4));
  assert.equal(view().color, "yellow");
  assert.equal(el.getAttribute("aria-valuenow"), "80");
  bar.update(budgetConsumption(model, avail * 0.95, 4));
  assert.equal(view().color, "red");

  bar.update(budgetConsumption(model, avail * 1.5, 4));
  assert.deepEqual(
    { color: view().color, fill: view().fill, pct: view().pct, aria: view().aria },
    { color: "red", fill: "100%", pct: "150% · overrun", aria: "FX budget used: 150% (overrun)" },
  );

  // Transmit + system already fill the frame: any FX work is an overrun.
  bar.update(budgetConsumption(model, 2, 1000));
  assert.deepEqual(
    { pct: view().pct, detail: view().detail, color: view().color },
    {
      pct: ">budget · overrun",
      detail: "no FX budget — transmit + system fill the 33.3 ms frame",
      color: "red",
    },
  );
});

/** shade() = led.pos then `n` pow() calls — a deliberately expensive effect. */
function powChain(n: number): Uint8Array {
  const code: number[] = [CODE["LoadCtx"]!, 3];
  for (let i = 0; i < n; i++) code.push(CODE["BinMath"]!, 2 /* pow */, 1);
  code.push(CODE["Ret"]!, 3);
  const h = [0x46, 0x58, 0x42, 0x31, 1, 0, 0, 0];
  const p16 = (v: number): void => void h.push(v & 0xff, (v >> 8) & 0xff);
  p16(0);
  p16(0);
  p16(code.length);
  p16(0xffff);
  p16(0);
  return new Uint8Array([...h, ...code]);
}

test("a fleet estimate names every device's budget share and flags the one that overruns [rr:PR-18]", () => {
  const fxb = powChain(60);
  const targets: DeviceTarget[] = [
    {
      key: "front",
      label: "Front arch",
      table: defaultCostTable("esp32s3", 240_000_000),
      ledCount: 16,
      calibrated: true,
    },
    { key: "stage", label: "Stage", table: defaultCostTable("esp32c3", 80_000_000), ledCount: 512 },
  ];
  const fleet = estimateAcrossDevices(fxb, targets);
  assert.equal(fleet.allFit, false);
  assert.equal(fleet.binding?.target.key, "stage");
  const [front, stage] = fleet.devices;
  assert.equal(front!.budget.color, "green");
  assert.ok(stage!.budget.fraction > 1, "the 512-LED 80 MHz board overruns");
  // Each device is estimated on its OWN clock and LED count.
  const alone = estimateFrameTime({ bytecode: fxb, ledCount: 512, table: targets[1]!.table });
  assert.equal(stage!.estimate.totalMs, alone.totalMs);

  const text = describeFleet(fleet);
  assert.match(text, /^Estimating across 2 device targets — SOME OVERRUN:/);
  const frontPct = Math.round(front!.budget.fraction * 100);
  assert.match(
    text,
    new RegExp(
      `- Front arch \\(esp32s3 @ 240 MHz, 16 LEDs, calibrated\\): [0-9.]+ ms, ` +
        `${frontPct}% of FX budget \\[green\\]\\n`,
    ),
  );
  assert.match(
    text,
    /- Stage \(esp32c3 @ 80 MHz, 512 LEDs, uncalibrated \(default model — wide error\)\): [0-9.]+ ms, \d+% of FX budget \[red\] ← binding/,
  );
  assert.match(text, /Hottest opcodes on the binding device \(Stage\): BinMath:pow \(\d+%\)/);
  assert.match(text, /Optimize for the binding device first/);

  // Shrink the expensive target until everything fits: the report says so.
  const ok = describeFleet(estimateAcrossDevices(fxb, [targets[0]!, { ...targets[1]!, ledCount: 8 }]));
  assert.match(ok, /— all fit:/);
  assert.doesNotMatch(ok, /SOME OVERRUN|Optimize for the binding device first/);
});

test("the perf context states budget consumption for measured and predicted frames alike [rr:PR-18]", () => {
  const table = defaultCostTable();
  const measured = contextFromReport(
    perfReport({ updateMs: 2, shadeMs: 30, showMs: 4, overruns: 3, droppedFrames: 2 }),
    table,
    true,
  );
  assert.equal(measured.source, "measured");
  assert.ok(Math.abs(measured.metrics.totalMs - 36) < 1e-3, "frame + transmit");
  assert.ok(Math.abs(measured.metrics.budgetMs - 1000 / 30) < 1e-3, "the device's budget");
  assert.ok(measured.metrics.budgetFraction > 1);
  assert.equal(measured.metrics.opsPerLed, 42);
  const mText = perfContextToPrompt(measured);
  assert.match(mText, /Performance context \(source: measured\):/);
  assert.match(mText, /- Frame time: 36\.00 ms of 33\.3 ms budget \(108% consumed\)\./);
  assert.match(mText, /- Overruns: 3, dropped frames: 2\./);
  assert.match(mText, /cost table calibrated\./);

  const est = estimateFrameTime({ bytecode: powChain(60), ledCount: 256, table });
  const predicted = contextFromEstimate(est, "pow-heavy", null, table, false);
  const pText = perfContextToPrompt(predicted);
  assert.match(pText, new RegExp(`source: predicted, confidence ${est.confidence}`));
  assert.match(pText, new RegExp(`consumed\\)\\.`));
  assert.match(
    pText,
    new RegExp(
      `- Error band: ${est.errorBand.lowMs.toFixed(2)}–${est.errorBand.highMs.toFixed(2)} ms`,
    ),
  );
  assert.match(pText, /- Hottest opcodes by cycle cost: BinMath:pow \(\d+%\)/);
  assert.match(pText, /cost table default \(uncalibrated\)\./);
});
