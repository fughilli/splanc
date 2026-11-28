/**
 * Styles for "Set up a bridge" (#698). The page frame, fields and action rows are the
 * credits flow's (`.cf*`, creditsFlow.css.ts: one primary, >= 12 px between actions,
 * stacked full-width on phones); this adds the stage checklist and the fixture list.
 */

let installed = false;

export function installBridgeSetupStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.bs-stages {
  list-style: none; margin: 0; padding: 0;
  display: flex; flex-direction: column;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
}
.bs-stage {
  display: grid; grid-template-columns: 28px 1fr; gap: var(--sp-3); align-items: start;
  padding: var(--sp-3) var(--sp-4);
}
.bs-stage + .bs-stage { border-top: 1px solid var(--border); }
.bs-stage-icon {
  width: 24px; height: 24px; border-radius: 50%; margin-top: 1px;
  display: grid; place-items: center; box-sizing: border-box;
  border: 2px solid var(--border); color: transparent;
}
.bs-stage-icon svg { width: 14px; height: 14px; }
.bs-stage--active .bs-stage-icon {
  border-color: var(--border); border-top-color: var(--accent);
  animation: bs-spin 0.9s linear infinite;
}
.bs-stage--ok .bs-stage-icon { background: var(--ok); border-color: var(--ok); color: #fff; }
.bs-stage--later .bs-stage-icon { border-style: dashed; border-color: var(--text-dim); color: var(--text-dim); }
.bs-stage--failed .bs-stage-icon { background: var(--err); border-color: var(--err); color: #fff; }
.bs-stage-title { font-weight: 600; }
.bs-stage--todo .bs-stage-title { color: var(--text-dim); font-weight: 500; }
.bs-stage-detail { color: var(--text-dim); font-size: var(--f-caption); line-height: 1.45; margin-top: 2px; }
.bs-stage--failed .bs-stage-detail { color: var(--err); }
@keyframes bs-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .bs-stage--active .bs-stage-icon { animation-duration: 3s; } }

.bs-status { color: var(--text-dim); font-size: var(--f-caption); min-height: 1.2em; }

.bs-players {
  list-style: none; margin: 0; padding: 0;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
}
.bs-players li { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3) var(--sp-4); }
.bs-players li + li { border-top: 1px solid var(--border); }
.bs-players li svg { width: 18px; height: 18px; color: var(--accent); flex: none; }

.bs-hint {
  display: grid; grid-template-columns: 20px 1fr; gap: var(--sp-2); align-items: start;
  color: var(--text-dim); font-size: var(--f-caption); line-height: 1.45;
}
.bs-hint svg { width: 18px; height: 18px; color: var(--accent); margin-top: 1px; }
.bs-detail { font-family: var(--font-mono); font-size: var(--f-caption); color: var(--text-dim); word-break: break-word; }
`;
