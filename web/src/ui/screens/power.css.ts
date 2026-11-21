/**
 * Lamp power styles (device-sheet power toggle, the Transitions flow, the
 * Hardware Setup touch section), injected once. Design tokens from
 * kit/tokens.css; spacing follows the "no crammed buttons" rule (>= 8 px
 * between controls, 12-16 px between action rows, stacked on phones).
 */

let installed = false;

export function installPowerStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
/* -- device sheet: the power card ------------------------------------------ */
.pw-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  margin: var(--sp-3) 0;
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface-2);
}
.pw-card[data-phase="1"], .pw-card[data-phase="2"] { border-color: var(--accent); }
.pw-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); }
.pw-head-text { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; }
.pw-cap { font-size: var(--f-caption); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; }
.pw-state { font-size: var(--f-title); font-weight: 600; }
.pw-detail { font-size: var(--f-caption); color: var(--text-dim); }
.pw-card .k-switch { transform: scale(1.25); transform-origin: right center; flex: 0 0 auto; }
.pw-actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); }

/* -- Transitions flow ------------------------------------------------------ */
.screen--pw { display: flex; flex-direction: column; gap: var(--sp-4); max-width: 40rem; margin: 0 auto; }
.pw-steps { font-size: var(--f-caption); color: var(--text-dim); }
.pw-list { display: flex; flex-direction: column; gap: var(--sp-3); }
.pw-tile {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  width: 100%;
  text-align: left;
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}
.pw-tile[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-quiet); }
.pw-tile-text { display: flex; flex-direction: column; gap: var(--sp-1); min-width: 0; flex: 1 1 auto; }
.pw-tile-name { font-weight: 600; }
.pw-tile-hint { font-size: var(--f-caption); color: var(--text-dim); }
.pw-thumb {
  flex: 0 0 auto;
  width: 56px;
  height: 56px;
  border-radius: var(--r-ctrl);
  overflow: hidden;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pw-thumb video, .pw-thumb canvas { width: 100%; height: 100%; object-fit: cover; }
.pw-thumb--style { background: var(--surface-2); color: var(--text-dim); font-size: 1.25rem; }
.pw-summary {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--surface);
}
.pw-summary-title { font-weight: 600; }
.pw-summary-val { color: var(--text-dim); }
.pw-footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.pw-section-title { font-size: var(--f-caption); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin: var(--sp-2) 0 0; }
.pw-radio { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-2) 0; cursor: pointer; }
.pw-radio input { margin-top: 0.2rem; }
.pw-empty { color: var(--text-dim); font-size: var(--f-caption); padding: var(--sp-2) 0; }
@media (max-width: 520px) {
  .pw-footer { flex-direction: column-reverse; align-items: stretch; }
  .pw-footer .k-btn, .pw-actions .k-btn { width: 100%; justify-content: center; }
  .pw-actions { flex-direction: column; }
}

/* -- Sensors page + kit onboarding ------------------------------------------- */
.sn-flash {
  padding: var(--sp-4);
  border-radius: var(--r-card);
  text-align: center;
  font-weight: 600;
  background: var(--surface-2);
  color: var(--text-dim);
  transition: background var(--motion-micro) var(--ease), color var(--motion-micro) var(--ease);
}
.sn-flash[data-on="true"] { background: var(--accent); color: var(--bg); }
.sn-chat-log {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-height: 22rem;
  overflow-y: auto;
  padding: var(--sp-2) 0;
}
.sn-msg { padding: var(--sp-3); border-radius: var(--r-card); max-width: 90%; line-height: 1.4; }
.sn-msg p { margin: 0 0 var(--sp-2); }
.sn-msg p:last-child { margin: 0; }
.sn-msg--assistant { background: var(--surface-2); align-self: flex-start; }
.sn-msg--user { background: var(--accent-quiet); align-self: flex-end; }
.sn-proposal {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: var(--sp-3);
  border: 1px solid var(--accent);
  border-radius: var(--r-card);
}
.sn-chat-row { display: flex; gap: var(--sp-3); align-items: flex-end; }
.sn-chat-input {
  flex: 1 1 auto;
  min-width: 0;
  resize: vertical;
  font: inherit;
  color: var(--text);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  padding: var(--sp-2) var(--sp-3);
}
.sn-check ul { margin: var(--sp-2) 0 0; padding-left: 1.25rem; color: var(--text-dim); font-size: var(--f-caption); display: flex; flex-direction: column; gap: var(--sp-1); }
.sn-pads { width: 100%; border-collapse: collapse; margin-top: var(--sp-2); font-size: var(--f-caption); }
.sn-pads th, .sn-pads td { text-align: left; padding: var(--sp-1) var(--sp-2); border-bottom: 1px solid var(--border); }
.sn-pads th { color: var(--text-dim); font-weight: 600; }
.sn-pads tr[data-rec="true"] td { color: var(--text); font-weight: 600; }
.sn-pads td { color: var(--text-dim); }
.sn-fields { display: flex; flex-direction: column; gap: var(--sp-3); }
.sn-fields .hw-select { max-width: none; width: 100%; }

/* -- Hardware Setup: touch sensor ------------------------------------------- */
.hw-touch-live {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--f-caption);
  color: var(--text-dim);
  padding: var(--sp-2) 0;
}
.hw-touch-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border); flex: 0 0 auto; }
.hw-touch-live[data-pressed="true"] { color: var(--text); }
.hw-touch-live[data-pressed="true"] .hw-touch-dot { background: var(--ok); box-shadow: 0 0 0 4px var(--accent-quiet); }
`;
