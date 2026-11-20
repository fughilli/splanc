/**
 * Effects tab (the app's home) + tune sheet styles, injected once (design
 * tokens from kit/tokens.css). See docs/ux/oobe-review.md.
 */

let installed = false;

export function installEffectsHomeStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
/* -- fixture card: what the app is connected to, and the next step -- */
.fxhome-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  padding: var(--sp-4);
  margin-bottom: var(--sp-4);
}
.fxhome-card-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}
.fxhome-card-dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--text-dim);
}
.fxhome-card[data-kind="connected"] .fxhome-card-dot { background: var(--ok); }
.fxhome-card[data-kind="connecting"] .fxhome-card-dot { background: var(--warn); }
.fxhome-card[data-kind="unreachable"] .fxhome-card-dot { background: var(--err); }
.fxhome-card-title {
  margin: 0;
  font-size: var(--f-title);
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
}
.fxhome-card-body {
  margin: 0;
  color: var(--text-dim);
  line-height: 1.4;
}
@media (min-width: 720px) {
  .fxhome-card .k-btn { align-self: flex-start; min-width: 14rem; }
}

/* -- sections: Starters / Examples / Your effects -- */
.fxhome-section-head {
  grid-column: 1 / -1;
  margin: var(--sp-4) 0 var(--sp-1);
  padding: 0 var(--sp-1);
  font-size: var(--f-caption);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.maps-list > .fxhome-section-head:first-child { margin-top: 0; }

/* Effect rows: names wrap to two lines instead of clipping to "Agentic c…"
 * in a narrow desktop grid cell; a one-line description for built-ins. */
.screen--effects-lib .map-name {
  white-space: normal;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow-wrap: anywhere;
}
.fxhome-blurb {
  color: var(--text-dim);
  font-size: var(--f-caption);
  line-height: 1.35;
  margin-top: 2px;
}
.fxhome-playing {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  color: var(--ok);
  font-size: var(--f-caption);
  font-weight: 600;
  margin-top: 2px;
}
.fxhome-playing::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ok);
}
.map-row.fxhome-row--playing { border-color: var(--ok); }

/* -- tune sheet -- */
.fxtune { display: flex; flex-direction: column; gap: var(--sp-4); }
.fxtune-blurb { margin: 0; color: var(--text-dim); line-height: 1.4; }
.fxtune-status {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  line-height: 1.4;
}
.fxtune-dot {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  margin-top: 0.4em;
  border-radius: 50%;
  background: var(--text-dim);
}
.fxtune-status[data-kind="ok"] .fxtune-dot { background: var(--ok); }
.fxtune-status[data-kind="busy"] .fxtune-dot { background: var(--warn); }
.fxtune-status[data-kind="err"] .fxtune-dot { background: var(--err); }
.fxtune-status[data-kind="ok"] { font-weight: 600; }
.fxtune-action:empty { display: none; }
.fxtune-heading {
  margin: 0 0 var(--sp-2);
  font-size: var(--f-caption);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
.fxtune-adjust[hidden] { display: none; }
/* Room for a thumb between stacked sliders (no crammed controls). */
.fxtune-controls .upanel-grid { row-gap: var(--sp-4); }
.fxtune-controls .upanel-name { white-space: normal; }
.fxtune-footer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.fxtune-note {
  margin: 0;
  color: var(--text-dim);
  font-size: var(--f-caption);
  text-align: center;
}
`;
