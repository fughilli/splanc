/**
 * Device sheet: the lamp's schedule at a glance (firmware feature "schedule",
 * docs/design/schedule.md): how many rules, the next one, and the way into the
 * dedicated #/device/schedule flow (rules are never edited on the sheet).
 */

import { Button } from "../kit";
import type { ClockState } from "../../net/wallClock";
import { readSchedule, scheduleStatus, type ScheduleState } from "../../net/schedule";
import { installScheduleStyles } from "./schedule.css";

export interface ScheduleSectionClient {
  getSchedule(page?: number): Promise<ScheduleState>;
  getClock(): Promise<ClockState>;
  /** For effect rules' names (the lamp's effect store). */
  listStoredEffects?(): Promise<{ effects?: { effectId: string; name?: string }[] }>;
}

export function ScheduleSection(client: ScheduleSectionClient, opts: { onOpen: () => void }): HTMLElement {
  installScheduleStyles();
  const el = document.createElement("div");
  el.className = "sc-card";
  const text = document.createElement("div");
  text.className = "sc-card-text";
  const cap = document.createElement("span");
  cap.className = "sc-cap";
  cap.textContent = "Schedule";
  const title = document.createElement("span");
  title.className = "sc-title";
  title.textContent = "…";
  const detail = document.createElement("span");
  detail.className = "sc-detail";
  detail.textContent = "Reading the schedule…";
  text.append(cap, title, detail);
  const actions = document.createElement("div");
  actions.className = "pw-actions";
  actions.append(Button({ label: "Open schedule", variant: "quiet", onClick: opts.onOpen }));
  el.append(text, actions);

  void Promise.all([readSchedule(client), client.getClock().catch(() => null)])
    .then(async ([st, clk]) => {
      const names = new Map<string, string>();
      if (st.rules.some((r) => r.action?.kind === "effect") && client.listStoredEffects) {
        const l = await client.listStoredEffects().catch(() => ({ effects: [] }));
        for (const e of l.effects ?? []) if (e.name) names.set(e.effectId, e.name);
      }
      title.textContent = st.count === 0 ? "No rules" : st.count === 1 ? "1 rule" : `${st.count} rules`;
      detail.textContent =
        st.count === 0
          ? "Turn on at 07:00, fade down at sunset: the lamp runs them on its own."
          : scheduleStatus(st, clk?.tz ?? "", Date.now(), (id) => names.get(id));
    })
    .catch(() => {
      title.textContent = "Schedule";
      detail.textContent = "Couldn't read the schedule";
    });
  return el;
}
