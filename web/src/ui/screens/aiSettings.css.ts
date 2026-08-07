/**
 * AI-settings styles (FUG-87), injected once. Reuses the Appearance screen's
 * `.settings-*` classes for layout (installSettingsStyles) and only adds the
 * few extras this screen needs: the model row, the download progress bar, and
 * the status line. Design tokens come from kit/tokens.css.
 */

let installed = false;

export function installAiSettingsStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.aiset-status {
  font-size: var(--f-caption);
  color: var(--text-dim);
  margin: 0 0 var(--sp-3);
}
.aiset-status.ok { color: var(--accent); }
.aiset-note {
  font-size: var(--f-caption);
  color: var(--text-dim);
  margin: var(--sp-2) 0 0;
  line-height: 1.4;
}
.aiset-field { display: block; margin: var(--sp-2) 0; }
.aiset-field > span {
  display: block;
  font-size: var(--f-caption);
  color: var(--text-dim);
  margin-bottom: 2px;
}
.aiset-field input, .aiset-field select {
  width: 100%;
  box-sizing: border-box;
  padding: var(--sp-2);
  background: var(--surface, #1a1a1a);
  color: inherit;
  border: 1px solid var(--border);
  border-radius: var(--radius, 8px);
  font: inherit;
}
.aiset-row { display: flex; gap: var(--sp-2); align-items: flex-end; }
.aiset-row > .aiset-field { flex: 1 1 auto; }
.aiset-row > button { flex: 0 0 auto; }
.aiset-progress {
  height: 6px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
  margin: var(--sp-2) 0 0;
}
.aiset-progress > i {
  display: block;
  height: 100%;
  width: 0%;
  background: var(--accent);
  transition: width 0.2s ease;
}
.aiset-progress-text { font-size: var(--f-caption); color: var(--text-dim); margin-top: 4px; }
`;
