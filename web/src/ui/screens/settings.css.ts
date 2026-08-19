/**
 * Appearance-settings styles, injected once (design tokens from kit/tokens.css).
 * Kept as a TS-injected stylesheet so the screen is self-contained and the CSS
 * only touches the DOM at call time (CJS-safe, mirroring perfPanel.css.ts).
 */

let installed = false;

export function installSettingsStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen--settings .settings-group { margin-bottom: var(--sp-4); }
.settings-group + .settings-group { margin-top: var(--sp-4); }

.settings-tabs {
  display: flex;
  gap: var(--sp-2);
  border-bottom: 1px solid var(--border);
  margin-bottom: var(--sp-4);
}
.settings-tab {
  background: none;
  border: 0;
  border-bottom: 2px solid transparent;
  color: var(--text-dim);
  font: inherit;
  font-weight: 600;
  padding: var(--sp-2) var(--sp-3);
  margin-bottom: -1px;
  cursor: pointer;
}
.settings-tab.on { color: var(--text); border-bottom-color: var(--accent); }
.settings-legend {
  font-size: var(--f-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin: 0 0 var(--sp-2);
}
.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
}
.settings-row + .settings-row { border-top: 1px solid var(--border); }
.settings-row-label { min-width: 0; }
.settings-row-name { font-weight: 600; }
.settings-row-hint { color: var(--text-dim); font-size: var(--f-caption); }
.settings-row-ctl { flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-2); }

.settings-seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  overflow: hidden;
}
.settings-seg button {
  background: var(--surface-2);
  color: var(--text-dim);
  border: 0;
  border-left: 1px solid var(--border);
  font: inherit;
  padding: 0.4rem 0.8rem;
  cursor: pointer;
}
.settings-seg button:first-child { border-left: 0; }
.settings-seg button.on { background: var(--accent); color: #fff; }

.settings-swatches { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.settings-swatch {
  width: 1.9rem;
  height: 1.9rem;
  border-radius: 50%;
  border: 2px solid var(--border);
  cursor: pointer;
  padding: 0;
}
.settings-swatch.on { border-color: var(--text); box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent); }
.settings-swatch--custom {
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: var(--text-dim);
}
.settings-swatch--custom svg { width: 16px; height: 16px; }

.settings-select {
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  padding: 0.4rem 0.5rem;
  font: inherit;
}
.settings-color {
  width: 2.4rem;
  height: 1.9rem;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  background: none;
  cursor: pointer;
}
.settings-full .k-slider { margin-bottom: 0; flex: 1; }
.settings-reset { margin-top: var(--sp-4); }

.settings-mono-preview {
  margin: 0 0 var(--sp-2);
  padding: var(--sp-2) var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  color: var(--text-dim);
  font: var(--f-caption) / 1.6 var(--font-mono);
  white-space: pre-wrap;
  overflow-x: auto;
}

.settings-preview { margin-bottom: var(--sp-3); }
.settings-preview-canvas {
  display: block;
  width: 100%;
  height: 168px;
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  background: var(--surface-2);
  touch-action: none;
}
.settings-preview-cap {
  margin-top: var(--sp-1);
  color: var(--text-dim);
  font-size: var(--f-caption);
  text-align: center;
}

/* Debug-server connect block: a big camera button over a status label; the
   button glows green once connected. */
.dbg-connect {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) 0 var(--sp-2);
}
.k-iconbtn.dbg-connect-btn {
  width: 3.4rem;
  height: 3.4rem;
  border: 1px solid var(--border);
  border-radius: 50%;
  background: var(--surface-2);
}
.k-iconbtn.dbg-connect-btn svg {
  width: 1.6rem;
  height: 1.6rem;
}
.k-iconbtn.dbg-connect-btn.on {
  color: #16a34a;
  border-color: #16a34a;
  background: rgba(22, 163, 74, 0.16);
}
.dbg-connect-status {
  font-size: var(--f-caption);
  color: var(--text-dim);
}
.dbg-connect-status.on {
  color: #16a34a;
  font-weight: 600;
}

/* An icon-only variant of the viewfinder pill (the chainlink "connect by URL"). */
.qrscan-btn--icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0.5rem 0.7rem;
}
.qrscan-btn--icon svg {
  width: 1.25rem;
  height: 1.25rem;
  display: block;
}

/* Manual-URL drawer: a bottom sheet inside the connect overlay, hidden until the
   chainlink is tapped (class toggle, so it beats the [hidden] vs display race). */
.dbgconn-drawer {
  display: none;
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + var(--sp-4));
  background: rgba(16, 16, 20, 0.96);
  border-top-left-radius: var(--r-card);
  border-top-right-radius: var(--r-card);
  backdrop-filter: blur(8px);
}
.dbgconn-drawer.open {
  display: flex;
}
.dbgconn-input {
  width: 100%;
  padding: 0.7rem 0.95rem;
  border-radius: var(--r-ctrl);
  border: 1px solid rgba(255, 255, 255, 0.3);
  background: rgba(20, 20, 26, 0.85);
  color: #fff;
  font: inherit;
}
.dbgconn-row {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
}
`;
