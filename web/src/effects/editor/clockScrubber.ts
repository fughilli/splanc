/**
 * The editor's "Preview time" block (docs/design/wall-clock.md): shown only for
 * an effect that binds a wall-clock uniform (clock, clock_day, clock_date,
 * clock_valid). A full-width time-of-day slider pins the preview to a time;
 * "Use the phone's clock" (its own row, only while pinned) goes back to live.
 * The lamp always uses its own clock; this only moves the preview.
 */

import { formatMinute, PreviewTime } from "../../fx/clockUniforms";
import { Button } from "../../ui/kit";

let stylesInstalled = false;

function installStyles(): void {
  if (stylesInstalled || typeof document === "undefined") return;
  stylesInstalled = true;
  const style = document.createElement("style");
  style.textContent = `
.fxclock {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3);
  margin-bottom: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface-2);
}
.fxclock[hidden] { display: none; }
.fxclock-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-3); }
.fxclock-title { font-size: var(--f-caption); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.fxclock-readout { font-variant-numeric: tabular-nums; font-weight: 600; }
.fxclock-slider { width: 100%; margin: 0; }
.fxclock-note { margin: 0; font-size: var(--f-caption); color: var(--text-dim); }
`;
  document.head.appendChild(style);
}

export class ClockScrubber {
  readonly el: HTMLElement;
  readonly time = new PreviewTime();
  private readonly readout: HTMLElement;
  private readonly slider: HTMLInputElement;
  private readonly liveBtn: HTMLButtonElement;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {
    installStyles();
    this.el = document.createElement("section");
    this.el.className = "fxclock";
    this.el.hidden = true;

    const head = document.createElement("div");
    head.className = "fxclock-head";
    const title = document.createElement("span");
    title.className = "fxclock-title";
    title.textContent = "Preview time";
    this.readout = document.createElement("span");
    this.readout.className = "fxclock-readout";
    head.append(title, this.readout);

    this.slider = document.createElement("input");
    this.slider.type = "range";
    this.slider.min = "0";
    this.slider.max = "1439";
    this.slider.step = "1";
    this.slider.className = "fxclock-slider";
    this.slider.setAttribute("aria-label", "Preview time of day");
    this.slider.addEventListener("input", () => {
      this.time.pick(Number(this.slider.value), this.now());
      this.refresh();
    });

    this.liveBtn = Button({
      label: "Use the phone's clock",
      variant: "quiet",
      block: true,
      onClick: () => {
        this.time.follow();
        this.refresh();
      },
    });

    const note = document.createElement("p");
    note.className = "fxclock-note";
    note.textContent = "Moves the preview only. The lamp uses its own clock and time zone.";

    this.el.append(head, this.slider, this.liveBtn, note);
    this.refresh();
  }

  /** Show the block for an effect that binds a clock uniform. */
  setVisible(on: boolean): void {
    if (this.el.hidden === !on) return;
    this.el.hidden = !on;
    if (on && this.timer === null) {
      this.timer = setInterval(() => this.refresh(), 1000);
    } else if (!on && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.refresh();
  }

  /** The time the preview shows now. */
  current(): Date {
    return this.time.at(this.now());
  }

  private refresh(): void {
    const d = this.current();
    const min = d.getHours() * 60 + d.getMinutes();
    this.readout.textContent = `${formatMinute(min)} · ${this.time.following ? "phone clock" : "picked"}`;
    if (this.time.following) this.slider.value = String(min);
    this.liveBtn.hidden = this.time.following;
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
