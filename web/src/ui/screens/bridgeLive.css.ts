/**
 * "Live via bridge" styles, injected once (design tokens from kit/tokens.css),
 * like the other screens' *.css.ts.
 */

let installed = false;

export function installBridgeLiveStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.bridge-screen { display:flex; flex-direction:column; gap:var(--sp-3); padding:var(--sp-3); }
.bridge-head { display:flex; align-items:center; gap:var(--sp-2); }
.bridge-dim { color:var(--text-dim); font-size:13px; }
.bridge-sub { font-weight:600; margin-bottom:var(--sp-2); }
.bridge-lan { font-size:13px; display:flex; flex-wrap:wrap; align-items:center; gap:var(--sp-2); }
.bridge-lan:empty { display:none; }
.bridge-chips { display:flex; flex-wrap:wrap; gap:var(--sp-2); }
.bridge-chips .k-chip[data-online="0"] { opacity:.55; }
.bridge-chips .k-chip[data-parked="1"] { border-color:var(--err); }
.bridge-lock { margin-left:6px; font-size:11px; }
.bridge-cue { display:flex; gap:var(--sp-2); align-items:center; margin:var(--sp-2) 0; }
.bridge-select { flex:1; min-width:0; padding:8px; border-radius:var(--sp-1); border:1px solid var(--border);
  background:var(--surface); color:var(--text); font:inherit; }
.bridge-row { display:flex; align-items:center; gap:var(--sp-2); margin:var(--sp-2) 0; font-size:14px; }
.bridge-tools, .bridge-pads { display:flex; flex-wrap:wrap; gap:var(--sp-2); margin-top:var(--sp-2); }
.bridge-footer { display:flex; flex-direction:column; gap:var(--sp-2); margin-top:var(--sp-3); }
.bridge-adv summary { cursor:pointer; color:var(--text-dim); font-size:13px; margin:var(--sp-2) 0; }
`;
