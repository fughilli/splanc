/**
 * Acid Mode styles (FUG-106), injected once (design tokens from kit/tokens.css).
 * A full-bleed, high-contrast, hands-free surface: a live LED-preview backdrop
 * with a big connectivity pill, one giant mic button, and the agent's readable
 * "stream of consciousness" feed floating above. Mirrors settings.css.ts's
 * self-contained, CJS-safe injection.
 */

let installed = false;

export function installAcidStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen--acid {
  position: fixed;
  inset: 0;
  padding: 0;
  overflow: hidden;
  background: #05050a;
  animation: none;
}

/* Live LED preview fills the screen — the "acid" backdrop + the agent's eyes. */
.acid-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
}
/* A wash so overlaid text stays readable over a busy visualization. */
.acid-scrim {
  position: absolute;
  inset: 0;
  background: radial-gradient(120% 90% at 50% 15%, rgba(5,5,10,0.15), rgba(5,5,10,0.72) 78%);
  pointer-events: none;
}

.acid-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: calc(env(safe-area-inset-top, 0px) + var(--sp-4)) var(--sp-4)
           calc(env(safe-area-inset-bottom, 0px) + var(--sp-6));
  pointer-events: none;
}
.acid-overlay > * { pointer-events: auto; }

/* Top row: connectivity pill (left) + a quiet exit (right). */
.acid-top {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
}
.acid-pill {
  transform: scale(1.15);
  transform-origin: left center;
}
.acid-exit {
  background: rgba(0,0,0,0.35);
  border: 1px solid var(--border);
  color: var(--text-dim);
  border-radius: 999px;
  padding: 6px 12px;
  font: inherit;
  font-size: var(--f-caption);
  cursor: pointer;
}
.acid-exit:hover { color: var(--text); }

.acid-title {
  margin: var(--sp-6) 0 var(--sp-1);
  font-size: var(--f-display);
  font-weight: 700;
  letter-spacing: -0.01em;
  text-align: center;
  background: linear-gradient(90deg, #ff5ecd, #7c6bff, #37e0ff);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.acid-sub {
  margin: 0;
  color: var(--text-dim);
  text-align: center;
  font-size: var(--f-caption);
}

/* The stream-of-consciousness feed — the readable window into the agent. */
.acid-feed {
  flex: 1;
  width: 100%;
  max-width: 560px;
  margin: var(--sp-4) 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  -webkit-overflow-scrolling: touch;
}
.acid-msg {
  border-radius: var(--r-card);
  padding: 10px 14px;
  line-height: 1.45;
  font-size: var(--f-body);
  max-width: 90%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.acid-msg--you {
  align-self: flex-end;
  background: var(--accent);
  color: #fff;
}
.acid-msg--agent {
  align-self: flex-start;
  background: rgba(20,20,30,0.72);
  border: 1px solid var(--border);
  color: var(--text);
}
/* Transient activity lines (thinking / tool narration) read as quiet asides. */
.acid-msg--think {
  align-self: flex-start;
  background: transparent;
  color: var(--text-dim);
  font-size: var(--f-caption);
  padding: 2px 14px;
}
.acid-msg--think.acid-live::after {
  content: "";
  animation: acid-dots 1.4s steps(4, end) infinite;
}
@keyframes acid-dots {
  0% { content: ""; }
  25% { content: "."; }
  50% { content: ".."; }
  75% { content: "..."; }
}

/* The giant push-to-talk mic. */
.acid-mic {
  position: relative;
  width: 108px;
  height: 108px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  color: #fff;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 50% 35%, #7c6bff, #4a2ea8);
  box-shadow: 0 10px 40px rgba(124,107,255,0.45);
  transition: transform var(--motion-micro) var(--ease);
  flex: none;
  /* iOS: a press-and-hold on the button otherwise selects the icon glyph / pops
   * the callout menu instead of registering as a button hold. */
  -webkit-user-select: none;
  user-select: none;
  -webkit-touch-callout: none;
  touch-action: manipulation;
}
.acid-mic:active { transform: scale(0.96); }
.acid-mic svg { width: 44px; height: 44px; }
.acid-mic:disabled { opacity: 0.55; cursor: default; }
.acid-mic--listening {
  background: radial-gradient(circle at 50% 35%, #ff5ecd, #b3277f);
  box-shadow: 0 0 0 0 rgba(255,94,205,0.55);
  animation: acid-pulse 1.4s var(--ease) infinite;
}
@keyframes acid-pulse {
  0% { box-shadow: 0 0 0 0 rgba(255,94,205,0.55); }
  70% { box-shadow: 0 0 0 26px rgba(255,94,205,0); }
  100% { box-shadow: 0 0 0 0 rgba(255,94,205,0); }
}
.acid-mic-hint {
  margin-top: var(--sp-2);
  color: var(--text-dim);
  font-size: var(--f-caption);
  text-align: center;
  min-height: 1.2em;
}

/* Text fallback when speech recognition is unavailable. */
.acid-fallback {
  width: 100%;
  max-width: 560px;
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
/* Thinking: the mic breathes slowly while the AI works. */
.acid-mic--thinking {
  background: radial-gradient(circle at 50% 35%, #37e0ff, #1d6f9e);
  animation: acid-breathe 1.6s var(--ease) infinite;
}
@keyframes acid-breathe {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(0.92); }
}
.screen--acid[data-state="done"] .acid-mic-hint { color: #7dffb0; }
.screen--acid[data-state="busy"] .acid-mic-hint { color: #ffb347; }

/* Kiosk idle countdown slot (play mode; component from the play screen). */
.acid-kiosk {
  flex: 1;
  text-align: center;
  color: var(--text-dim);
  font-size: var(--f-caption);
}

/* "AI is busy" fallback card. */
.acid-busy {
  width: 100%;
  max-width: 560px;
  margin-bottom: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-card);
  background: rgba(40,20,0,0.82);
  border: 1px solid #ff8c1a;
  color: #ffd9a8;
  text-align: center;
}
.acid-busy[hidden] { display: none; }
.acid-busy p { margin: 0 0 var(--sp-2); font-size: var(--f-body); }
.acid-busy-btn {
  border: none;
  border-radius: 999px;
  padding: 10px 20px;
  font: inherit;
  font-weight: 700;
  color: #1a0d00;
  background: #ff8c1a;
  cursor: pointer;
}

/* Free-AI disclosure: tiny, at the bottom. */
.acid-free-note {
  margin-top: var(--sp-2);
  max-width: 560px;
  color: var(--text-dim);
  font-size: var(--f-caption);
  text-align: center;
}
.acid-free-note[hidden] { display: none; }
.acid-free-note summary { cursor: pointer; }
.acid-free-note p { margin: var(--sp-1) 0 0; }

/* ---- Play mode (#/acid?play=1): a Halloween stoop, phone in one hand. ---- */
.acid--play .acid-title {
  margin-top: var(--sp-4);
  background: linear-gradient(90deg, #ff8c1a, #b04dff, #6dff6d);
  -webkit-background-clip: text;
  background-clip: text;
}
.acid--play .acid-sub { font-size: var(--f-body); color: var(--text); }
.acid-examples {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  max-width: 560px;
}
.acid-example {
  border: 1px solid rgba(255,140,26,0.6);
  background: rgba(30,12,0,0.7);
  color: #ffd9a8;
  border-radius: 999px;
  padding: 8px 14px;
  font: inherit;
  font-size: var(--f-caption);
  cursor: pointer;
}
.acid--play .acid-feed { max-height: 32vh; }
.acid--play .acid-mic {
  width: 148px;
  height: 148px;
  background: radial-gradient(circle at 50% 35%, #ff8c1a, #a33d00);
  box-shadow: 0 10px 48px rgba(255,140,26,0.5);
}
.acid--play .acid-mic svg { width: 60px; height: 60px; }
.acid--play .acid-mic--listening {
  background: radial-gradient(circle at 50% 35%, #b04dff, #5a1a99);
}
.acid--play .acid-mic--thinking {
  background: radial-gradient(circle at 50% 35%, #6dff6d, #1f7a1f);
}
.acid--play .acid-mic-hint { font-size: var(--f-body); color: var(--text); }

.acid-fallback input {
  flex: 1;
  background: rgba(20,20,30,0.72);
  border: 1px solid var(--border);
  border-radius: var(--r-ctrl);
  color: var(--text);
  padding: 10px 14px;
  font: inherit;
}
`;
