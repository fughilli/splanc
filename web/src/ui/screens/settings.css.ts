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
`;
