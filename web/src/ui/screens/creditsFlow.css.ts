/**
 * Styles for the Splanc AI credits flow + the credits account card
 * (design tokens from kit/tokens.css). Owner rule (2026-11-18): never cram
 * buttons — action rows keep >= 12 px gaps, stack full-width on phones, and
 * every screen has one primary action with subordinate secondaries.
 */

let installed = false;

export function installCreditsFlowStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.cf {
  max-width: 520px;
  margin: 0 auto;
  padding: var(--sp-2) 0 var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.cf p { margin: 0; }
.cf-progress { display: flex; flex-direction: column; gap: var(--sp-2); }
.cf-progress-text { font-size: var(--f-caption); color: var(--text-dim); }
.cf-progress-bar { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: var(--sp-1); }
.cf-progress-bar > i { height: 4px; border-radius: 2px; background: var(--border); }
.cf-progress-bar > i.on { background: var(--accent); }

.cf-hero {
  width: 56px; height: 56px; border-radius: 50%;
  display: grid; place-items: center;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  margin-top: var(--sp-2);
}
.cf-hero svg { width: 28px; height: 28px; }
.cf-hero--ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
.cf-hero--warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
.cf-hero--danger { background: color-mix(in srgb, var(--err) 16%, transparent); color: var(--err); }
.cf-title { font-size: var(--f-display); line-height: 1.2; margin: 0; outline: none; }
.cf-lead { color: var(--text-dim); line-height: 1.5; }
.cf-note { color: var(--text-dim); font-size: var(--f-caption); line-height: 1.45; }
.cf-err {
  color: var(--err); font-size: var(--f-caption); line-height: 1.4;
  border: 1px solid color-mix(in srgb, var(--err) 45%, transparent);
  background: color-mix(in srgb, var(--err) 8%, transparent);
  border-radius: var(--r-ctrl); padding: var(--sp-2) var(--sp-3);
}
.cf-strong { font-weight: 600; }

.cf-facts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.cf-facts li {
  display: grid; grid-template-columns: 36px 1fr; gap: var(--sp-3); align-items: start;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
  padding: var(--sp-3);
}
.cf-fact-icon {
  width: 36px; height: 36px; border-radius: var(--r-ctrl); display: grid; place-items: center;
  background: var(--surface-2); color: var(--accent);
}
.cf-fact-icon svg { width: 20px; height: 20px; }
.cf-fact-title { font-weight: 600; margin-bottom: 2px; }
.cf-fact-text { color: var(--text-dim); font-size: var(--f-caption); line-height: 1.45; }

.cf-consent {
  display: grid; grid-template-columns: 24px 1fr; gap: var(--sp-3); align-items: start;
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
  padding: var(--sp-4); cursor: pointer;
}
.cf-consent:has(input:checked) { border-color: var(--accent); }
.cf-consent input { width: 22px; height: 22px; margin: 0; accent-color: var(--accent); cursor: pointer; }
.cf-consent-label { font-weight: 600; display: block; }
.cf-consent-explain { color: var(--text-dim); font-size: var(--f-caption); line-height: 1.45; margin-top: var(--sp-1) !important; }

.cf-field { display: flex; flex-direction: column; gap: var(--sp-1); }
.cf-field > span { font-size: var(--f-caption); color: var(--text-dim); }
.cf-field input {
  width: 100%; box-sizing: border-box; padding: 0.75rem var(--sp-3);
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-ctrl); font: inherit;
}
.cf-field input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
.cf-field input.cf-code { font: 600 1.4rem/1.2 var(--font-mono); letter-spacing: 0.3em; }

.cf-packs { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: var(--sp-3); }
.cf-pack {
  position: relative; text-align: left; font: inherit; color: var(--text); cursor: pointer;
  display: flex; flex-direction: column; gap: var(--sp-1);
  background: var(--surface); border: 2px solid var(--border); border-radius: var(--r-card);
  padding: var(--sp-4);
}
.cf-pack:hover { border-color: var(--text-dim); }
.cf-pack.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--surface)); }
.cf-pack-price { font-size: var(--f-display); font-weight: 700; line-height: 1.1; }
.cf-pack-credits { font-weight: 600; }
.cf-pack-what { color: var(--text-dim); font-size: var(--f-caption); }
.cf-pack-mark {
  position: absolute; top: var(--sp-3); right: var(--sp-3);
  width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
  border: 2px solid var(--border); color: transparent;
}
.cf-pack.on .cf-pack-mark { background: var(--accent); border-color: var(--accent); color: #fff; }
.cf-pack-mark svg { width: 14px; height: 14px; }
/* A two-way choice (the iOS refund-request consent): the pack cards' look,
   one per row so neither option is favoured, nothing preselected. */
.cf-choices { grid-template-columns: 1fr; }
.cf-choice { padding-right: calc(var(--sp-4) + 32px); }
.cf-choice-title { font-weight: 600; }

.cf-summary, .cf-panel {
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-card);
  padding: var(--sp-3) var(--sp-4); display: flex; flex-direction: column; gap: var(--sp-2);
}
.cf-summary:empty { display: none; }
.cf-panel--danger { border-color: color-mix(in srgb, var(--err) 50%, var(--border)); }
.cf-kv { display: flex; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.cf-kv > span { color: var(--text-dim); }

.cf-balance { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
.cf-balance-num { font-size: 2.6rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.cf-balance-unit { color: var(--text-dim); font-size: var(--f-title); }

.cf-spinner {
  width: 36px; height: 36px; border-radius: 50%;
  border: 3px solid var(--border); border-top-color: var(--accent);
  animation: cf-spin 0.9s linear infinite;
}
@keyframes cf-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cf-spinner { animation-duration: 3s; } }

/* Actions: one primary, then subordinate secondaries. Phones stack them
   full-width with 12 px between; wider screens sit them in a row (primary
   last, on the right) with 12 px gaps, wrapping rather than squeezing. */
.cf-actions { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-2); }
.cf-actions:empty { display: none; }
.cf-actions > .k-btn { width: 100%; min-height: 48px; }
@media (min-width: 640px) {
  .cf-actions { flex-direction: row-reverse; flex-wrap: wrap; justify-content: flex-start; }
  .cf-actions > .k-btn { width: auto; min-width: 140px; }
}

/* -- Settings ▸ AI: the credits account card ------------------------------- */
.cacct { display: flex; flex-direction: column; gap: var(--sp-4); }
.cacct-balance { display: flex; align-items: baseline; gap: var(--sp-2); flex-wrap: wrap; }
.cacct-balance-num { font-size: 2rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
.cacct-balance-unit { color: var(--text-dim); }
.cacct-low {
  font-size: var(--f-caption); font-weight: 600; color: var(--warn);
  border: 1px solid currentColor; border-radius: 999px; padding: 0 var(--sp-2);
}
.cacct-callout {
  border-radius: var(--r-ctrl); padding: var(--sp-3);
  background: var(--surface-2); color: var(--text); font-size: var(--f-caption); line-height: 1.45;
}
.cacct-callout--warn { background: color-mix(in srgb, var(--warn) 12%, var(--surface)); border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent); }
.cacct-actions { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
@media (max-width: 639px) {
  .cacct-actions { flex-direction: column; }
  .cacct-actions > .k-btn { width: 100%; }
}
.cacct-section { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-4); border-top: 1px solid var(--border); }
.cacct-section-title { font-weight: 600; }
.cacct-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; }
.cacct-row > .cacct-row-text { min-width: 0; flex: 1 1 200px; }
.cacct-dim { color: var(--text-dim); font-size: var(--f-caption); line-height: 1.45; margin: 0; }
.cacct-activity { list-style: none; margin: 0; padding: 0; }
.cacct-activity li {
  display: flex; justify-content: space-between; gap: var(--sp-3);
  padding: var(--sp-2) 0; border-top: 1px solid var(--border); font-size: var(--f-caption);
}
.cacct-activity li:first-child { border-top: 0; }
.cacct-activity .plus { color: var(--ok); font-weight: 600; }
.cacct-activity .when { color: var(--text-dim); }
.cacct-danger { border-top-color: color-mix(in srgb, var(--err) 35%, var(--border)); }
.cacct-danger .cacct-section-title { color: var(--err); }
`;
