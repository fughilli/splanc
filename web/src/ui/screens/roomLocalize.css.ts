/**
 * Room localization styles, injected once (design tokens from kit/tokens.css).
 */

let installed = false;

export function installRoomLocalizeStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.room-screen { display:flex; flex-direction:column; gap:var(--sp-3); padding:var(--sp-3); }
.room-dim { color:var(--text-dim); font-size:13px; margin:0; }
.room-warn { color:var(--err); font-size:13px; margin:0; }
.room-sub { font-weight:600; }
.room-pick { display:flex; flex-direction:column; gap:var(--sp-2); }
.room-pick-row { display:flex; align-items:center; gap:var(--sp-2); font-size:15px; }
.room-pick-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.room-actions { display:flex; flex-wrap:wrap; gap:var(--sp-2); }
.room-member { display:flex; align-items:center; gap:var(--sp-2); padding:6px 0; }
.room-dot { width:12px; height:12px; border-radius:50%; flex:none; }
.room-view { width:100%; height:min(55vh, 420px); border:1px solid var(--border); border-radius:var(--sp-2);
  background:var(--surface); }
.room-inset { width:min(46vw, 260px); height:min(46vw, 260px); border-radius:var(--sp-2);
  background:rgba(0,0,0,.45); align-self:flex-end; }
.room-screen--capture { position:fixed; inset:0; padding:0; z-index:5; }
.room-video { position:fixed; inset:0; width:100%; height:100%; object-fit:cover; z-index:0; background:#000; }
.room-hud { position:relative; z-index:1; display:flex; flex-direction:column; gap:var(--sp-2); padding:var(--sp-3);
  min-height:100%; box-sizing:border-box; justify-content:space-between; color:#fff; }
.room-chips { display:flex; flex-wrap:wrap; gap:var(--sp-2); }
.room-chips .k-chip { background:rgba(0,0,0,.5); color:#fff; border-width:2px; }
.room-chips .k-chip[data-done="1"]::after { content:" ✓"; }
.room-guide { margin:0; text-shadow:0 1px 3px #000; font-size:15px; }
.room-results { display:flex; flex-direction:column; gap:var(--sp-1); }
.room-result { display:flex; align-items:center; gap:var(--sp-2); width:100%; text-align:left; padding:8px;
  border:1px solid var(--border); border-radius:var(--sp-1); background:var(--surface); color:var(--text); font:inherit; }
.room-result--sel { border-color:var(--accent); }
.room-pad { display:flex; flex-wrap:wrap; gap:var(--sp-1); align-items:center; }
.room-pad .k-btn { min-width:0; padding:6px 10px; }
.room-step { padding:6px; border-radius:var(--sp-1); border:1px solid var(--border); background:var(--surface);
  color:var(--text); font:inherit; }
`;
