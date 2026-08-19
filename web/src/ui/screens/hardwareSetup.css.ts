/**
 * Hardware Setup screen styles, injected once (design tokens from
 * kit/tokens.css). TS-injected like colorCorrection.css.ts so the screen is
 * self-contained and CJS-safe (the CSS only touches the DOM at call time).
 */

let installed = false;

export function installHardwareSetupStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen--hw .hw-group { margin-bottom: var(--sp-4); }
.hw-group + .hw-group { margin-top: var(--sp-4); }
.hw-legend {
  font-size: var(--f-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin: 0 0 var(--sp-2);
}
.hw-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-2) 0;
}
.hw-row-name { font-weight: 600; }
.hw-row-hint { color: var(--text-dim); font-size: var(--f-caption); }
.hw-row-ctl { flex: 0 0 auto; display: flex; align-items: center; gap: var(--sp-2); }
.hw-hint { color: var(--text-dim); font-size: var(--f-caption); margin: var(--sp-1) 0 var(--sp-2); }
.hw-select {
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-2);
  padding: var(--sp-2) var(--sp-3);
  font: inherit;
  min-width: 8.5rem;
}
.hw-order-current {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  letter-spacing: 0.08em;
}

/* The 6-permutation picker: each swatch shows the three color dots in that
 * wire order; the user taps the one matching what the physical strip shows. */
.hw-perm-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.hw-perm {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-2);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.hw-perm:hover { border-color: var(--accent); }
.hw-perm.hw-perm--on { border-color: var(--accent); background: var(--surface-3, var(--surface-2)); }
.hw-perm-dots { display: inline-flex; gap: 6px; }
.hw-dot {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  box-shadow: 0 0 6px rgba(0, 0, 0, 0.4) inset;
}
.hw-perm-label {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
  color: var(--text-dim);
  font-size: var(--f-caption);
}
.hw-test-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-2); flex-wrap: wrap; }
`;
