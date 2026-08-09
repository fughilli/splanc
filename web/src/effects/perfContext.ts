/**
 * AI perf-context assembler (docs/design/perf-monitoring.md §"What the agent
 * ingests"). Normalizes measured (device PerfReport) OR predicted (offline cost
 * model) perf into ONE schema so the effects-editor AI agent optimizes the same
 * way with or without hardware. A `source: measured|predicted` tag and, offline,
 * the error band tell the model which it got.
 *
 * Pure + CJS-safe (no DOM / import.meta): the editor's AI generate/repair flow
 * imports this to optionally attach the context to a turn.
 */

import type {
  Confidence,
  CostTable,
  FrameEstimate,
  HotOpcode,
} from "./costModel";
import { costFor } from "./costModel";
import type { PerfReportMessage } from "../net/proto";

/** Language builtin → cost-table key (mirrors the compiler's opcode lowering).
 * Math fns sub-key their dispatch opcode (`UnMath:sin`); the rest are 1:1. */
const BUILTIN_COST_KEY: Record<string, string> = {
  mul: "Mul",
  add: "Add",
  sub: "Sub",
  div: "Div",
  sin: "UnMath:sin",
  cos: "UnMath:cos",
  tan: "UnMath:tan",
  abs: "UnMath:abs",
  floor: "UnMath:floor",
  ceil: "UnMath:ceil",
  fract: "UnMath:fract",
  sqrt: "UnMath:sqrt",
  exp: "UnMath:exp",
  log: "UnMath:log",
  sign: "UnMath:sign",
  min: "BinMath:min",
  max: "BinMath:max",
  pow: "BinMath:pow",
  mod: "BinMath:mod",
  step: "BinMath:step",
  atan2: "BinMath:atan2",
  clamp: "Clamp",
  mix: "Mix",
  smoothstep: "Smoothstep",
  dot: "Dot",
  cross: "Cross",
  length: "Length",
  distance: "Distance",
  normalize: "Normalize",
  hash: "Hash1",
  hsv2rgb: "Hsv2Rgb",
  palette0: "Palette",
};

/**
 * A compact per-builtin cost listing for the effect-AI, GENERATED FROM THE USER'S
 * DEVICE benchmark (or the shipped default model when the board isn't calibrated).
 * Costs are shown relative to a float multiply so the model can rank tradeoffs
 * regardless of clock — and `shade()` runs each builtin once PER LED, so the
 * ranking is what keeps an effect inside the frame budget. Dynamic per-device:
 * inject it as an UNcached block, never in the frozen system prefix.
 */
export function builtinCostsToPrompt(table: CostTable, calibrated: boolean): string {
  const fb = table.fallbackCost;
  const anchor = Math.max(1, costFor(table.costs, "Mul", fb));
  const fmt = (m: number): string => (m < 9.95 ? m.toFixed(1) : Math.round(m).toString());
  const list = Object.entries(BUILTIN_COST_KEY)
    .map(([name, key]) => [name, costFor(table.costs, key, fb) / anchor] as const)
    .sort((a, b) => a[1] - b[1])
    .map(([name, mult]) => `${name} ${fmt(mult)}x`)
    .join(", ");
  const mhz = (table.cpuHz / 1e6).toFixed(0);
  return [
    `BUILTIN COSTS on this device (${table.soc} @ ${mhz} MHz, ${
      calibrated ? "measured on your board" : "default model"
    }) — per call, relative to a float multiply. shade() runs each ONCE PER LED, so favor the cheap ones:`,
    `  ${list}`,
    "Hoist the pricey builtins (pow/atan2/log/exp/length/normalize/distance/smoothstep) out of shade() into update() or precompute into state; swap sin/cos/pow for fixed16/fixed8 (LUT trig, no soft-float) or step/mix/polynomials; avoid length/normalize where a squared distance works (hidden sqrt).",
  ].join("\n");
}

/** The normalized metrics block shared by measured + predicted sources. */
export interface PerfMetrics {
  /** total frame wall-time (update+shade+show), ms. */
  totalMs: number;
  budgetMs: number;
  budgetFraction: number;
  phase: { updateMs: number; shadeMs: number; showMs: number };
  /** lane-weighted opcodes executed per LED in shade. */
  opsPerLed: number;
  /** VM operand-stack high-water (f32 slots); null if unknown (predicted). */
  stackMax: number | null;
  heap: { freeBytes: number | null; minFreeBytes: number | null };
  overruns: number | null;
  droppedFrames: number | null;
  samplesDropped: number | null;
}

/** The full context handed to the agent. */
export interface PerfContext {
  source: "measured" | "predicted";
  effectId: string;
  /** truncated fxb hash pinning metrics to the compiled script. */
  fxbHash: number | null;
  metrics: PerfMetrics;
  /** null when measured; the model's ± band + confidence when predicted. */
  errorBand: { lowMs: number; highMs: number; fraction: number; confidence: Confidence } | null;
  /** opcodes sorted by cycle contribution: the most actionable input. */
  hotOpcodes: { op: string; cycles: number; fraction: number }[];
  /** the device economics the agent reasons with (relative op costs). */
  costTable: { soc: string; cpuHz: number; costs: Record<string, number>; calibrated: boolean };
}

function cyclesToMs(cycles: number, cpuHz: number): number {
  return cpuHz > 0 ? (cycles / cpuHz) * 1000 : 0;
}

/** Build the perf context from a live device PerfReport (source=measured). */
export function contextFromReport(
  report: PerfReportMessage,
  table: CostTable,
  calibrated: boolean,
): PerfContext {
  const cpuHz = report.cpuHz || table.cpuHz;
  const budgetMs = cyclesToMs(report.budgetCycles, cpuHz) || table.budgetMs;
  const frameMs = cyclesToMs(report.frameCyclesMean, cpuHz);
  const showMs = cyclesToMs(report.showCyclesMean, cpuHz);
  const updateMs = cyclesToMs(report.updateCyclesMean, cpuHz);
  const shadeMs = cyclesToMs(report.shadeCyclesMean, cpuHz);
  const totalMs = frameMs + showMs;
  // ops-per-LED from the newest FULL-mode tick, if present.
  const last = report.ticks.length > 0 ? report.ticks[report.ticks.length - 1]! : null;
  const opsPerLed =
    last && last.ledCount > 0 ? last.instrShade / last.ledCount : 0;
  const stackMax = last && last.stackMax > 0 ? last.stackMax : null;
  return {
    source: "measured",
    effectId: report.effectId,
    fxbHash: report.fxbHash,
    metrics: {
      totalMs,
      budgetMs,
      budgetFraction: budgetMs > 0 ? totalMs / budgetMs : 0,
      phase: { updateMs, shadeMs, showMs },
      opsPerLed,
      stackMax,
      heap: { freeBytes: report.heapFree, minFreeBytes: report.heapMinFree },
      overruns: report.overruns,
      droppedFrames: report.droppedFrames,
      samplesDropped: report.samplesDropped,
    },
    errorBand: null,
    hotOpcodes: [], // firmware doesn't stream a per-opcode histogram; predicted fills this
    costTable: relCostTable(table, calibrated),
  };
}

/** Build the perf context from an offline cost-model estimate (predicted). */
export function contextFromEstimate(
  est: FrameEstimate,
  effectId: string,
  fxbHash: number | null,
  table: CostTable,
  calibrated: boolean,
): PerfContext {
  return {
    source: "predicted",
    effectId,
    fxbHash,
    metrics: {
      totalMs: est.totalMs,
      budgetMs: est.budgetMs,
      budgetFraction: est.budgetFraction,
      phase: {
        updateMs: est.phaseSplit.updateMs,
        shadeMs: est.phaseSplit.shadeMs,
        showMs: est.phaseSplit.showMs,
      },
      opsPerLed: est.opsPerLed,
      stackMax: null,
      heap: { freeBytes: null, minFreeBytes: null },
      overruns: null,
      droppedFrames: null,
      samplesDropped: null,
    },
    errorBand: {
      lowMs: est.errorBand.lowMs,
      highMs: est.errorBand.highMs,
      fraction: est.errorBand.fraction,
      confidence: est.confidence,
    },
    hotOpcodes: est.hotOpcodes.map((h: HotOpcode) => ({
      op: h.op,
      cycles: Math.round(h.cycles),
      fraction: h.fraction,
    })),
    costTable: relCostTable(table, calibrated),
  };
}

function relCostTable(
  table: CostTable,
  calibrated: boolean,
): PerfContext["costTable"] {
  return { soc: table.soc, cpuHz: table.cpuHz, costs: { ...table.costs }, calibrated };
}

/**
 * Render the perf context as a compact prose+JSON block for the AI turn. Kept
 * terse (the agent gets the histogram + budget, not raw ticks) so it slots into
 * a generate/repair prompt without bloating the cached prefix.
 */
export function perfContextToPrompt(ctx: PerfContext): string {
  const m = ctx.metrics;
  const pct = (v: number): string => `${Math.round(v * 100)}%`;
  const lines: string[] = [];
  lines.push(
    `Performance context (source: ${ctx.source}${
      ctx.source === "predicted" && ctx.errorBand
        ? `, confidence ${ctx.errorBand.confidence}`
        : ""
    }):`,
  );
  lines.push(
    `- Frame time: ${m.totalMs.toFixed(2)} ms of ${m.budgetMs.toFixed(1)} ms budget (${pct(
      m.budgetFraction,
    )} consumed).`,
  );
  if (ctx.errorBand) {
    lines.push(
      `- Error band: ${ctx.errorBand.lowMs.toFixed(2)}–${ctx.errorBand.highMs.toFixed(
        2,
      )} ms (±${pct(ctx.errorBand.fraction)}).`,
    );
  }
  lines.push(
    `- Phase split: update ${m.phase.updateMs.toFixed(2)} ms, shade ${m.phase.shadeMs.toFixed(
      2,
    )} ms, show ${m.phase.showMs.toFixed(2)} ms.`,
  );
  lines.push(`- Ops per LED (shade): ${m.opsPerLed.toFixed(1)}.`);
  if (m.stackMax !== null) lines.push(`- Stack high-water: ${m.stackMax} slots.`);
  if (m.overruns !== null || m.droppedFrames !== null) {
    lines.push(
      `- Overruns: ${m.overruns ?? 0}, dropped frames: ${m.droppedFrames ?? 0}.`,
    );
  }
  if (ctx.hotOpcodes.length > 0) {
    const top = ctx.hotOpcodes
      .slice(0, 6)
      .map((h) => `${h.op} (${pct(h.fraction)})`)
      .join(", ");
    lines.push(`- Hottest opcodes by cycle cost: ${top}.`);
  }
  lines.push(
    `- Device: ${ctx.costTable.soc} @ ${(ctx.costTable.cpuHz / 1e6).toFixed(
      0,
    )} MHz, cost table ${ctx.costTable.calibrated ? "calibrated" : "default (uncalibrated)"}.`,
  );
  lines.push(
    "Optimize for fewer per-LED float ops: hoist loop-invariant work into update(), " +
      "prefer step/mix/polynomial over sin/pow/exp, avoid length/normalize (hidden sqrt).",
  );
  return lines.join("\n");
}
