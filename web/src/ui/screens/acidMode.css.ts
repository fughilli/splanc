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
