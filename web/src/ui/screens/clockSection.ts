/**
 * Device sheet: the lamp's wall clock (firmware feature "wall_clock",
 * docs/design/wall-clock.md). A small card: the lamp's local time in its own
 * zone (computed from the lamp's POSIX rule, so it is what the lamp itself
 * shows), where the time came from and how good it is, and one action, "Set
 * from this phone" (the app also pushes the time on every connect).
 */

import { Button, toast } from "../kit";
import {
  clockDetail,
  lampLocalTime,
  ntpDetail,
  lampUtcNow,
  lampZoneLabel,
  pushWallClock,
  type ClockState,
  type WallClockClient,
} from "../../net/wallClock";

export interface ClockSectionClient extends WallClockClient {
  getClock(): Promise<ClockState>;
}

let stylesInstalled = false;

function installClockStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = `
.clk-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  margin: var(--sp-3) 0;
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface-2);
}
.clk-card[data-valid="false"] { border-color: var(--warn, var(--accent)); }
.clk-text { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.clk-cap { font-size: var(--f-caption); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.clk-time { font-size: var(--f-title); font-weight: 600; font-variant-numeric: tabular-nums; }
.clk-zone, .clk-detail { font-size: var(--f-caption); color: var(--text-dim); overflow-wrap: anywhere; }
.clk-actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
`;
  document.head.appendChild(style);
}

export function ClockSection(client: ClockSectionClient): HTMLElement {
  installClockStyles();
  const el = document.createElement("div");
  el.className = "clk-card";
  const text = document.createElement("div");
  text.className = "clk-text";
  const cap = document.createElement("span");
  cap.className = "clk-cap";
  cap.textContent = "Clock";
  const time = document.createElement("span");
  time.className = "clk-time";
  const zone = document.createElement("span");
  zone.className = "clk-zone";
  const detail = document.createElement("span");
  detail.className = "clk-detail";
  // Network time (firmware feature "sntp"): where the lamp's own sync stands.
  const ntp = document.createElement("span");
  ntp.className = "clk-detail";
  text.append(cap, time, zone, detail, ntp);

  let cur: ClockState | null = null;
  let readAt = 0; // performance.now() of the reading
  let busy = false;

  const setBtn = Button({
    label: "Set from this phone",
    variant: "quiet",
    onClick: () => void setFromPhone(),
  });
  const actions = document.createElement("div");
  actions.className = "clk-actions";
  actions.append(setBtn);
  el.append(text, actions);

  const paint = (): void => {
    el.dataset["valid"] = String(cur?.valid ?? true);
    ntp.textContent = ntpDetail(cur);
    ntp.hidden = ntp.textContent === "";
    setBtn.disabled = busy;
    if (!cur || !cur.valid) {
      time.textContent = cur ? "Not set" : "…";
      zone.textContent = cur?.tz ? lampZoneLabel(cur, Date.now()) : "";
      detail.textContent = clockDetail(cur);
      return;
    }
    const since = performance.now() - readAt;
    const utc = lampUtcNow(cur, since);
    time.textContent = lampLocalTime(cur, utc);
    zone.textContent = lampZoneLabel(cur, utc);
    detail.textContent = clockDetail({ ...cur, ageS: cur.ageS + Math.floor(since / 1000) });
  };

  const adopt = (s: ClockState): void => {
    cur = s;
    readAt = performance.now();
    paint();
  };

  async function setFromPhone(): Promise<void> {
    if (busy) return;
    busy = true;
    paint();
    try {
      const st = await pushWallClock(client, { pushedBy: "manual" });
      if (st) adopt(st);
    } catch (e) {
      toast(`Couldn't set the clock: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      busy = false;
      paint();
    }
  }

  // Tick the minute display; stop once the sheet has gone.
  const timer = setInterval(() => {
    if (!el.isConnected && cur !== null) {
      clearInterval(timer);
      return;
    }
    paint();
  }, 1000);

  paint();
  void client
    .getClock()
    .then(adopt)
    .catch(() => {
      time.textContent = "Couldn't read the clock";
    });
  return el;
}
