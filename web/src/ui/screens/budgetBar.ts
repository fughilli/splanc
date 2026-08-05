/**
 * Budget progress bar (FUG-11: "display a 'progress bar' showing what fraction
 * of the available budget is consumed by the current program, color-coded by
 * fraction: <=70% green, >70% yellow, >90% red").
 *
 * A thin, reusable DOM widget over {@link budgetBarView}: it renders the fill
 * width, the FUG-11 color band, the percent + ms detail, and 70%/90% threshold
 * tick guides. Driven by a {@link BudgetStatus} (offline estimate or on-device
 * PerfReport — both flow through budget.ts), so the bar reads identically online
 * and offline. Styles ride the shared perf stylesheet (installPerfStyles).
 */

import { budgetBarView, type BudgetStatus } from "../../effects/budget";
import { installPerfStyles } from "./perfPanel.css";

export interface BudgetBar {
  el: HTMLElement;
  /** Re-render the bar for a new budget status. */
  update(status: BudgetStatus): void;
}

/** Build a budget progress bar. Call {@link BudgetBar.update} to (re)draw. */
export function BudgetBar(): BudgetBar {
  installPerfStyles();
  const el = document.createElement("div");
  el.className = "perf-budget";

  const head = document.createElement("div");
  head.className = "perf-budget-head";
  const title = document.createElement("span");
  title.className = "perf-budget-title";
  title.textContent = "Budget used";
  const pct = document.createElement("span");
  pct.className = "perf-budget-pct";
  head.append(title, pct);

  const track = document.createElement("div");
  track.className = "perf-budget-track";
  const fill = document.createElement("div");
  fill.className = "perf-budget-fill";
  track.append(fill);
  // 70% / 90% threshold guides.
  for (const t of [70, 90]) {
    const tick = document.createElement("div");
    tick.className = "perf-budget-tick";
    tick.style.left = `${t}%`;
    track.append(tick);
  }

  const detail = document.createElement("div");
  detail.className = "perf-budget-detail";

  el.append(head, track, detail);

  function update(status: BudgetStatus): void {
    const v = budgetBarView(status);
    el.dataset["color"] = v.color;
    fill.style.width = `${v.fillPct}%`;
    pct.textContent = v.overrun ? `${v.percentLabel} · overrun` : v.percentLabel;
    detail.textContent = v.detail;
    // aria for screen readers / tests.
    el.setAttribute("role", "progressbar");
    el.setAttribute("aria-valuenow", String(Math.round(v.fillPct)));
    el.setAttribute("aria-valuemin", "0");
    el.setAttribute("aria-valuemax", "100");
    el.setAttribute("aria-label", `FX budget used: ${v.percentLabel}${v.overrun ? " (overrun)" : ""}`);
  }

  return { el, update };
}
