/**
 * Styles for the mesh UI: the device sheet's Mesh section and the "Create a mesh" flow
 * (design tokens from kit/tokens.css). Owner rule (2026-11-18): never cram buttons —
 * action stacks keep 12 px gaps and go full-width on phones; one primary action per step.
 */

let installed = false;

export function installMeshStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const st = document.createElement("style");
  st.textContent = CSS;
  document.head.append(st);
}

const CSS = `
.mesh-section { display: flex; flex-direction: column; gap: 12px; }
.mesh-status-line { font-size: 0.875rem; color: var(--text-dim); line-height: 1.45; }
.mesh-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.mesh-row-text { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 0; }
.mesh-row-title { font-size: 0.9375rem; }
.mesh-row-hint { font-size: 0.8125rem; color: var(--text-dim); line-height: 1.4; }
.mesh-sub { font-size: var(--f-caption); color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 4px; }

.mesh-members { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.mesh-member {
  width: 100%; text-align: left; font: inherit; color: var(--text); cursor: pointer;
  display: grid; grid-template-columns: 12px 1fr auto; gap: 12px; align-items: center;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-ctrl);
  padding: 10px 12px; min-height: 48px;
}
.mesh-member:hover { border-color: var(--text-dim); }
.mesh-member-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--warn); }
.mesh-member-dot--ok { background: var(--ok); }
.mesh-member-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mesh-member-detail { font-size: var(--f-caption); color: var(--text-dim); }
/* The kit chevron already points right ("opens a sheet"); no rotation. */
.mesh-member-chev { color: var(--text-dim); display: inline-flex; }
.mesh-member-chev svg { width: 16px; height: 16px; }

.mesh-member-dot--bad { background: var(--err); }
.mesh-last { display: flex; flex-direction: column; gap: 8px; }
.mesh-last-line { font-weight: 600; }
.mesh-last-line--warn { color: var(--warn); }
.mesh-last-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.mesh-last-row { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: 12px; align-items: center; font-size: 0.875rem; }
.mesh-last-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mesh-last-row--bad .mesh-member-detail { color: var(--err); }

.mesh-pending {
  display: flex; flex-direction: column; gap: 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 7%, var(--surface));
  border-radius: var(--r-card); padding: 12px;
}
.mesh-pending-title { font-weight: 600; }
.mesh-pending-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }

.mesh-actions { display: flex; flex-direction: column; gap: 12px; margin-top: 4px; }
.mesh-actions > .k-btn { width: 100%; min-height: 44px; }

.mesh-kv { display: flex; justify-content: space-between; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--border); font-size: 0.9375rem; }
.mesh-kv > span:first-child { color: var(--text-dim); }
.mesh-sheet { display: flex; flex-direction: column; gap: 16px; padding-bottom: 8px; }

/* -- The flow (#/mesh/new, #/mesh/add/:id) ------------------------------------- */
.mf-pick { display: flex; flex-direction: column; gap: 12px; }
.mf-pick-row {
  display: grid; grid-template-columns: 24px 1fr; gap: 12px; align-items: center;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
  padding: 12px 16px; cursor: pointer; min-height: 56px;
}
.mf-pick-row:has(input:checked) { border-color: var(--accent); }
.mf-pick-row input { width: 22px; height: 22px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.mf-pick-name { font-weight: 600; display: block; }
.mf-pick-where { color: var(--text-dim); font-size: var(--f-caption); }
.mf-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.mf-step {
  display: grid; grid-template-columns: 28px 1fr; gap: 12px; align-items: center;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
  padding: 12px 16px; min-height: 56px;
}
.mf-step-icon { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--text-dim); }
.mf-step-icon svg { width: 16px; height: 16px; }
.mf-step--ok .mf-step-icon { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.mf-step--err { border-color: color-mix(in srgb, var(--err) 45%, var(--border)); }
.mf-step--err .mf-step-icon { background: color-mix(in srgb, var(--err) 16%, transparent); color: var(--err); }
.mf-step--busy .mf-step-icon { border: 3px solid var(--border); border-top-color: var(--accent); background: none; animation: cf-spin 0.9s linear infinite; }
@keyframes cf-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .mf-step--busy .mf-step-icon { animation-duration: 3s; } }
.mf-step-name { font-weight: 600; }
.mf-step-text { color: var(--text-dim); font-size: var(--f-caption); line-height: 1.4; }
.mf-step--err .mf-step-text { color: var(--err); }
`;
