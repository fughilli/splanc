/**
 * Schedule styles (the device-sheet card and the #/device/schedule flow), on
 * top of the power flow's pw-* layout (power.css.ts). Spacing follows the "no
 * crammed buttons" rule: >= 8 px between controls, full-width buttons stacked
 * on phones.
 */

let installed = false;

export function installScheduleStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.sc-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  margin: var(--sp-3) 0;
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface-2);
}
.sc-card-text { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.sc-cap { font-size: var(--f-caption); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.sc-title { font-size: var(--f-title); font-weight: 600; }
.sc-detail { font-size: var(--f-caption); color: var(--text-dim); overflow-wrap: anywhere; }

.sc-status {
  font-size: var(--f-caption);
  color: var(--text-dim);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-card);
  background: var(--surface-2);
}
.sc-status[data-warn="true"] { color: var(--text); border: 1px solid var(--warn, var(--accent)); }
.sc-rule {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface);
}
.sc-rule[data-enabled="false"] .pw-tile-name, .sc-rule[data-enabled="false"] .pw-tile-hint { opacity: 0.55; }
.sc-rule-open {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  text-align: left;
  background: none;
  border: 0;
  padding: var(--sp-1) 0;
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.sc-rule .k-switch { flex: 0 0 auto; }
.sc-time-input {
  font: inherit;
  font-size: 2.25rem;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface);
  color: var(--text);
  color-scheme: inherit;
  width: 100%;
  box-sizing: border-box;
}
.sc-days {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: var(--sp-2);
}
.sc-day {
  min-height: 44px;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}
.sc-day[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-quiet); }
.sc-review-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); }
.sc-review-row .pw-tile-text { flex: 1 1 auto; }
.sc-review-row .k-btn { flex: 0 0 auto; }
.sc-danger { padding-top: var(--sp-4); }
.sc-loc {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border: 1px solid var(--accent);
  border-radius: var(--r-card);
  background: var(--accent-quiet);
}
.sc-loc ul { margin: 0; padding-left: 1.25rem; display: flex; flex-direction: column; gap: var(--sp-1); }
@media (max-width: 520px) {
  .sc-review-row { flex-direction: column; align-items: stretch; }
  .sc-review-row .k-btn, .sc-danger .k-btn, .sc-card .k-btn { width: 100%; justify-content: center; }
}
`;
