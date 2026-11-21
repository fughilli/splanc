/**
 * Stored-effects styles (device settings list + the per-effect sheet), injected
 * once like colorCorrection.css.ts. Rows are full-width tap targets; the sheet's
 * primary and its destructive action are full-width and sit on their own rows
 * with the design system's spacing (never jammed together).
 */

let installed = false;

export function installStoredEffectsStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.stored-effects { display: flex; flex-direction: column; gap: var(--sp-2); }
.stored-effects-usage { margin: 0; }
.stored-effects-list { list-style: none; margin: 0; padding: 0; }
.stored-effects-row { border-bottom: 1px solid var(--border); }
.stored-effects-row:last-child { border-bottom: none; }
.stored-effects-open {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 48px;
  padding: var(--sp-3) 0;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.stored-effects-open svg { flex-shrink: 0; width: 18px; height: 18px; color: var(--text-dim); }
.stored-effects-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.stored-effects-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.stored-effects-detail { font-size: var(--f-caption); }
.stored-effects-badge {
  flex-shrink: 0;
  font-size: var(--f-caption);
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 2px var(--sp-2);
}
.stored-effect-sheet { display: flex; flex-direction: column; gap: var(--sp-3); }
.stored-effect-detail { margin: 0; }
.stored-effect-controls-cap { margin-top: var(--sp-2); }
/* The destructive action is secondary: its own row, well below the primary. */
.stored-effect-delete { margin-top: var(--sp-4); color: var(--err); }
`;
