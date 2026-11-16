/**
 * One monotonic progress bar for a whole final solve.
 *
 * The solver reports progress per optimizer PASS, not per solve: a solve runs
 * a cold initial pass, optionally a warm-start pass, up to three outlier-
 * rejection rounds and optionally a strip-prior re-solve (solver/src/
 * pipeline.rs `stage_plan`), and each pass's `progress` runs 0→1 on its own.
 * A supplemental scan then adds a second solve (the joint re-solve) on top.
 * Drawn raw, the bar went back to 0 at every pass.
 *
 * `SolveProgress` maps those per-pass fractions onto one 0→1 bar:
 *  - outer PHASES (separate solver calls, e.g. standalone + joint re-solve)
 *    each get a fixed weighted share of the bar;
 *  - within a phase, a snapshot's `plan` (every pass the solve may run, each
 *    weighted by its evaluation budget) and `stageIndex` place it. Passes
 *    often converge before their budget is spent, so each new pass maps the
 *    REST of the plan onto the rest of the bar from wherever the bar is (no
 *    jump forward over a pass's unspent budget, no stall);
 *  - a snapshot without a plan (a host solve, an older wasm build) has an
 *    unknown pass count: a fall in the raw fraction marks a new pass, and each
 *    pass covers half of what is left of the phase, so the bar never runs out;
 *  - the bar never moves backwards, whatever the input.
 */

/** One pass of a solve's plan (mirrors solver/src/types.rs PlannedStage). */
export interface PlannedStage {
  name: string;
  weight: number;
}

/** The fields of a solver progress snapshot this needs. */
export interface StageSnapshot {
  /** The current pass's own fraction, 0→1. */
  progress: number;
  stage?: string;
  stageIndex?: number;
  plan?: PlannedStage[];
}

/** An outer phase: one solver call. */
export interface SolvePhase {
  label: string;
  weight: number;
}

export interface ProgressView {
  /** Whole-solve fraction, 0→1, non-decreasing. */
  fraction: number;
  /** e.g. "Solving · pass 2 of 5 (outlier rejection 1)". */
  label: string;
}

/** Share of the REMAINING phase a pass of unknown count is given. */
export const UNKNOWN_PASS_SHARE = 0.5;
/** A raw fraction falling by more than this marks a new pass (no plan). */
const NEW_PASS_DROP = 0.05;

/** Human name of a solver stage (pipeline.rs stage_plan names). */
export function stageLabel(name: string): string {
  if (name === "initial-cold") return "initial solve";
  if (name === "initial-warm") return "warm-start solve";
  if (name === "strip-prior") return "strip refinement";
  const m = /^outlier-round-(\d+)$/.exec(name);
  if (m) return `outlier rejection ${Number(m[1]) + 1}`;
  return name;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export class SolveProgress {
  private readonly phases: SolvePhase[];
  private readonly bounds: [number, number][];
  private phase = 0;
  private fraction = 0;
  private label: string;
  // Unknown-pass-count bookkeeping (no plan), per phase.
  private pass = 0;
  private passStart = 0;
  private lastRaw = 0;
  private lastStageIndex: number | undefined = undefined;
  private inner = 0;
  // Planned passes: where the current pass started (bar and plan index).
  private segStart = 0;
  private segIdx = -1;
  // restart(): the whole phase layout is mapped onto [base, base + span].
  private base = 0;
  private span = 1;

  constructor(phases: SolvePhase[] = [{ label: "Solving", weight: 1 }]) {
    this.phases = phases.length > 0 ? phases : [{ label: "Solving", weight: 1 }];
    const ws = this.phases.map((p) => (Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 0));
    const total = ws.reduce((a, b) => a + b, 0) || 1;
    let at = 0;
    this.bounds = ws.map((w) => {
      const b: [number, number] = [at, at + w / total];
      at += w / total;
      return b;
    });
    this.bounds[this.bounds.length - 1]![1] = 1;
    this.label = this.phaseLabel();
  }

  get phaseCount(): number {
    return this.phases.length;
  }

  /** Move to outer phase `index` (skipping any before it): the bar jumps to
   * that phase's start, never back. */
  beginPhase(index: number): ProgressView {
    const i = Math.min(Math.max(0, Math.floor(index)), this.phases.length - 1);
    if (i > this.phase) {
      this.phase = i;
      this.pass = 0;
      this.passStart = 0;
      this.lastRaw = 0;
      this.lastStageIndex = undefined;
      this.inner = 0;
      this.segStart = 0;
      this.segIdx = -1;
    }
    this.label = this.phaseLabel();
    return this.advance(0);
  }

  /** A different solve takes over mid-way (e.g. the host solve was lost and
   * the phone solves from scratch): the phases start again, mapped onto what
   * is left of the bar, so it carries on from where it is instead of
   * stalling or going back. */
  restart(): ProgressView {
    this.base = this.fraction;
    this.span = 1 - this.fraction;
    this.phase = 0;
    this.pass = 0;
    this.passStart = 0;
    this.lastRaw = 0;
    this.lastStageIndex = undefined;
    this.inner = 0;
    this.segStart = 0;
    this.segIdx = -1;
    this.label = this.phaseLabel();
    return this.view();
  }

  /** Feed one solver snapshot of the current phase. */
  update(snap: StageSnapshot): ProgressView {
    const raw = clamp01(snap.progress);
    const plan = snap.plan?.filter((s) => Number.isFinite(s.weight) && s.weight > 0) ?? [];
    let inner: number;
    if (plan.length > 0 && snap.stageIndex !== undefined && snap.plan !== undefined) {
      const idx = Math.min(Math.max(0, Math.floor(snap.stageIndex)), snap.plan.length - 1);
      const w = (k: number): number => {
        const v = snap.plan![k]!.weight;
        return Number.isFinite(v) && v > 0 ? v : 0;
      };
      if (idx > this.segIdx) {
        // A new pass: the rest of the plan (this pass on) spans the rest of
        // the bar from here.
        this.segStart = this.inner;
        this.segIdx = idx;
      }
      let rest = 0;
      for (let k = this.segIdx; k < snap.plan.length; k++) rest += w(k);
      // A report from an earlier pass than the current one adds nothing.
      inner = idx < this.segIdx || rest <= 0 ? this.inner : this.segStart + ((1 - this.segStart) * w(idx) * raw) / rest;
      const name = snap.stage ?? snap.plan[idx]!.name;
      this.label = `${this.phaseLabel()} · pass ${idx + 1} of ${snap.plan.length} (${stageLabel(name)})`;
    } else {
      // Unknown pass count: a new stage index, or the raw fraction falling,
      // starts a new pass at the current position; it gets a share of what is
      // left, so the phase approaches but never reaches its end.
      const newPass =
        (snap.stageIndex !== undefined && this.lastStageIndex !== undefined && snap.stageIndex !== this.lastStageIndex) ||
        raw < this.lastRaw - NEW_PASS_DROP;
      if (newPass) {
        this.pass += 1;
        this.passStart = this.inner;
      }
      this.lastStageIndex = snap.stageIndex;
      this.lastRaw = raw;
      inner = this.passStart + (1 - this.passStart) * UNKNOWN_PASS_SHARE * raw;
      const name = snap.stage !== undefined ? ` (${stageLabel(snap.stage)})` : "";
      this.label = `${this.phaseLabel()} · pass ${this.pass + 1}${name}`;
    }
    this.inner = Math.max(this.inner, clamp01(inner));
    return this.advance(this.inner);
  }

  /** The whole solve is done: the bar reads 1. */
  complete(): ProgressView {
    this.fraction = 1;
    this.label = "Solved";
    return this.view();
  }

  view(): ProgressView {
    return { fraction: this.fraction, label: this.label };
  }

  private advance(inner: number): ProgressView {
    const [a, b] = this.bounds[this.phase]!;
    // Below 1 until complete(): a pass's own fraction stops short of 1, and a
    // skipped adaptive pass is only known to be skipped once the solve ends.
    const f = Math.min(this.base + this.span * (a + (b - a) * clamp01(inner)), 0.999);
    this.fraction = Math.max(this.fraction, f);
    return this.view();
  }

  private phaseLabel(): string {
    const p = this.phases[this.phase]!;
    return this.phases.length > 1 ? `${p.label} (${this.phase + 1}/${this.phases.length})` : p.label;
  }
}
