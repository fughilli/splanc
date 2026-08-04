/**
 * Perf-panel styles injected once (design tokens from kit/tokens.css). Kept as a
 * TS-injected stylesheet so the perf screens are self-contained and CJS-safe
 * (the function only touches the DOM at call time). Shared by perfPanel.ts and
 * calibrate.ts.
 */

let installed = false;

export function installPerfStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen--perf .perf-header { display:flex; align-items:center; gap:var(--sp-2); }
.perf-effect { font-weight:600; }
.perf-badge {
  font-size:11px; text-transform:uppercase; letter-spacing:.04em;
  padding:2px 8px; border-radius:999px; border:1px solid var(--border);
  color:var(--text-dim);
}
.perf-badge[data-kind="measured"] { color:var(--ok); border-color:var(--ok); }
.perf-badge[data-kind="predicted"] { color:var(--warn); border-color:var(--warn); }
.perf-badge[data-conf="green"] { color:var(--ok); border-color:var(--ok); }
.perf-badge[data-conf="yellow"] { color:var(--warn); border-color:var(--warn); }
.perf-badge[data-conf="red"] { color:var(--err); border-color:var(--err); }
.perf-graph { width:100%; height:auto; display:block; border-radius:var(--sp-1); }
.perf-gauge { text-align:center; padding:var(--sp-2) 0; }
.perf-gauge[data-conf="green"] .perf-gauge-num { color:var(--ok); }
.perf-gauge[data-conf="yellow"] .perf-gauge-num { color:var(--warn); }
.perf-gauge[data-conf="red"] .perf-gauge-num { color:var(--err); }
.perf-gauge-num { font-size:var(--f-display, 2rem); font-weight:700; }
.perf-gauge-sub { color:var(--text-dim); font-size:13px; margin-top:var(--sp-1); }
.perf-badges { display:flex; flex-wrap:wrap; gap:var(--sp-2); align-items:center; }
.perf-badge-count {
  font-size:12px; padding:2px 8px; border-radius:999px;
  background:var(--surface-2); color:var(--text-dim);
}
.perf-badge-count--warn { background:var(--err); color:#fff; }
.perf-note { font-size:12px; color:var(--warn); }
.perf-detail { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:var(--sp-2); }
.perf-readout { display:flex; flex-direction:column; gap:2px; }
.perf-readout-label { font-size:11px; color:var(--text-dim); }
.perf-readout-val { font-size:15px; font-weight:600; font-variant-numeric:tabular-nums; }
.perf-actions { display:flex; gap:var(--sp-2); margin-top:var(--sp-2); }
.calib-progress { margin:var(--sp-3) 0; }
.calib-bar { height:8px; border-radius:999px; background:var(--surface-2); overflow:hidden; }
.calib-bar-fill { height:100%; background:var(--accent); transition:width .2s var(--ease,ease); }
.calib-log { font-family:ui-monospace,monospace; font-size:12px; color:var(--text-dim);
  max-height:180px; overflow:auto; margin-top:var(--sp-2); white-space:pre-wrap; }
.calib-accuracy { display:flex; gap:var(--sp-4); margin-top:var(--sp-3); }
.calib-accuracy .perf-readout-val { font-size:20px; }

/* FUG-11 budget progress bar: fraction of the AVAILABLE FX budget consumed,
   color-coded <=70% green, >70% yellow, >90% red. */
.perf-budget { display:flex; flex-direction:column; gap:var(--sp-1); }
.perf-budget-head { display:flex; justify-content:space-between; align-items:baseline; }
.perf-budget-title { font-size:12px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.04em; }
.perf-budget-pct { font-size:15px; font-weight:700; font-variant-numeric:tabular-nums; }
.perf-budget-track {
  position:relative; height:14px; border-radius:999px;
  background:var(--surface-2); overflow:hidden;
}
.perf-budget-fill {
  height:100%; width:0%; border-radius:999px;
  transition:width .2s ease, background-color .2s ease;
}
.perf-budget-tick { position:absolute; top:0; bottom:0; width:1px; background:var(--border); opacity:.7; }
.perf-budget-detail { font-size:12px; color:var(--text-dim); font-variant-numeric:tabular-nums; }
.perf-budget[data-color="green"] .perf-budget-fill { background:var(--ok); }
.perf-budget[data-color="yellow"] .perf-budget-fill { background:var(--warn); }
.perf-budget[data-color="red"] .perf-budget-fill { background:var(--err); }
.perf-budget[data-color="green"] .perf-budget-pct { color:var(--ok); }
.perf-budget[data-color="yellow"] .perf-budget-pct { color:var(--warn); }
.perf-budget[data-color="red"] .perf-budget-pct { color:var(--err); }

/* Profile manager rows (perfProfiles.ts). */
.perf-profiles { display:flex; flex-direction:column; gap:var(--sp-2); }
.perf-profile-head { display:flex; align-items:center; gap:var(--sp-2); margin-bottom:var(--sp-2); }
`;
