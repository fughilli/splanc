/**
 * Color-correction screen styles, injected once (design tokens from
 * kit/tokens.css). TS-injected like settings.css.ts / perfPanel.css.ts so the
 * screen is self-contained and CJS-safe (the CSS only touches the DOM at call
 * time).
 */

let installed = false;

export function installColorCorrectionStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen--cc .cc-group { margin-bottom: var(--sp-4); }
.cc-group + .cc-group { margin-top: var(--sp-4); }
.cc-legend {
  font-size: var(--f-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin: 0 0 var(--sp-2);
}
.cc-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
}
.cc-row.cc-full { display: block; }
.cc-row-name { font-weight: 600; }
.cc-row-hint { color: var(--text-dim); font-size: var(--f-caption); }
.cc-row-ctl { flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-2); }
.cc-hint { color: var(--text-dim); font-size: var(--f-caption); margin: var(--sp-1) 0 var(--sp-2); }

.cc-select {
  background: var(--surface-2, rgba(255,255,255,0.06));
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-2, 8px);
  padding: var(--sp-1) var(--sp-2);
  font: inherit;
}

.cc-plot {
  display: block;
  width: 100%;
  max-width: 360px;
  margin: 0 auto var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-2, 8px);
  touch-action: none; /* let the pointer drag the curve, not scroll */
  cursor: crosshair;
}

.cc-push { display: flex; flex-direction: column; gap: var(--sp-2); }

/* Save (floppy) button: flips green on a successful commit, until the next edit. */
.cc-save.cc-save--ok {
  background: #1f7a3d;
  border-color: #2e9d52;
  color: #fff;
  --icon-cut: #1f7a3d;
}

.cc-sim-row { margin: var(--sp-1) 0; }
.cc-sim-cap { color: var(--text-dim); font-size: var(--f-caption); margin-bottom: 2px; }
.cc-sim-bar {
  display: block;
  width: 100%;
  height: 26px;
  border-radius: var(--r-1, 4px);
  border: 1px solid var(--border);
  image-rendering: pixelated;
}
`;
