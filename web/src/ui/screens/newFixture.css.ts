/**
 * New-fixture setup flow styles (D-259), injected once. One step per screen,
 * one primary action each; action rows stack full-width on phones with >= 12 px
 * between them (owner rule: never cram buttons).
 */

let installed = false;

export function installNewFixtureStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.nf {
  max-width: 520px;
  margin: 0 auto;
  /* Side padding of its own: .nf replaces .screen's padding (phone gutter). */
  padding: var(--sp-2) var(--sp-4) var(--sp-8);
  box-sizing: border-box;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.nf p { margin: 0; }
.nf-progress { display: flex; flex-direction: column; gap: var(--sp-2); }
.nf-progress-text { font-size: var(--f-caption); color: var(--text-dim); }
.nf-progress-bar { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: var(--sp-1); }
.nf-progress-bar > i { height: 4px; border-radius: 2px; background: var(--border); }
.nf-progress-bar > i.on { background: var(--accent); }
.nf-title { font-size: var(--f-display); line-height: 1.2; margin: 0; }
.nf-lead { color: var(--text-dim); line-height: 1.5; }
.nf-note { color: var(--text-dim); font-size: var(--f-caption); line-height: 1.45; }
.nf-err {
  color: var(--err); font-size: var(--f-caption); line-height: 1.4;
  border: 1px solid color-mix(in srgb, var(--err) 45%, transparent);
  background: color-mix(in srgb, var(--err) 8%, transparent);
  border-radius: var(--r-ctrl); padding: var(--sp-2) var(--sp-3);
}
.nf-err:empty { display: none; }
.nf-field { display: flex; flex-direction: column; gap: var(--sp-2); }
.nf-field label { font-size: var(--f-caption); color: var(--text-dim); }
.nf-field input {
  font: inherit; color: var(--text); background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--r-ctrl);
  padding: var(--sp-3); min-height: 48px; box-sizing: border-box; width: 100%;
}

/* LED count: one card per output. */
.nf-ports { display: flex; flex-direction: column; gap: var(--sp-3); }
.nf-port {
  display: flex; flex-direction: column; gap: var(--sp-3);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
  padding: var(--sp-4);
}
.nf-port--live { border-color: var(--accent); }
.nf-port-head { display: flex; flex-direction: column; gap: 2px; }
.nf-port-name { font-weight: 600; }
.nf-port-hint { color: var(--text-dim); font-size: var(--f-caption); }
.nf-stepper { display: flex; align-items: center; gap: var(--sp-3); }
.nf-stepper input {
  flex: 1; min-width: 0; text-align: center; font: inherit; font-size: var(--f-title);
  color: var(--text); background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--r-ctrl); padding: var(--sp-2); min-height: 48px; box-sizing: border-box;
}
.nf-stepper .k-btn { min-width: 56px; min-height: 48px; justify-content: center; }

/* Colour order: six full-width rows of three dots. */
.nf-orders { display: flex; flex-direction: column; gap: var(--sp-3); }
.nf-order {
  display: flex; align-items: center; gap: var(--sp-3);
  width: 100%; min-height: 56px; box-sizing: border-box;
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-card);
  font: inherit; cursor: pointer; text-align: left;
}
.nf-order:active { background: var(--surface-2); }
.nf-dots { display: inline-flex; gap: var(--sp-2); }
.nf-dot { width: 22px; height: 22px; border-radius: 50%; border: 1px solid rgba(0, 0, 0, 0.25); }
.nf-order-name { color: var(--text-dim); font-size: var(--f-caption); margin-left: auto; }

.nf-actions { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-2); }
.nf-actions > .k-btn { width: 100%; min-height: 48px; }
@media (min-width: 720px) {
  .nf-actions { flex-direction: row-reverse; flex-wrap: wrap; justify-content: flex-start; }
  .nf-actions > .k-btn { width: auto; min-width: 160px; }
}
`;
