/**
 * Halloween play mode + kiosk countdown styles, injected once. Mobile-first:
 * one column, thumb-sized tap targets (>= 64px), high contrast for a dark stoop.
 * Text is sized in rem so it follows the app's UI scale (PR-1).
 */

let installed = false;

export function installPlayStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
.screen--play {
  --boo-orange: #ff7a1a;
  --boo-purple: #8b3dff;
  --boo-green: #5dff8a;
  --boo-bg: #0b0710;
  --boo-card: #1a1222;
  --boo-text: #fff4e8;
  --boo-dim: #c9b8d6;
  min-height: 100dvh;
  box-sizing: border-box;
  padding: max(12px, env(safe-area-inset-top)) 16px max(20px, env(safe-area-inset-bottom));
  background:
    radial-gradient(120% 60% at 50% -10%, rgba(139, 61, 255, 0.35), transparent 70%),
    var(--boo-bg);
  color: var(--boo-text);
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 560px;
  margin: 0 auto;
  animation: none;
}
.play-top {
  display: flex;
  align-items: center;
  gap: 10px;
}
.play-title {
  font-size: 1.375rem;
  font-weight: 800;
  margin: 0;
  flex: 1;
  letter-spacing: 0.01em;
}
.play-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 999px;
  background: var(--boo-card);
  border: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 0.9375rem;
  font-weight: 600;
  white-space: nowrap;
  max-width: 60vw;
  overflow: hidden;
  text-overflow: ellipsis;
}
.play-pill-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #777;
  flex: none;
}
.play-pill[data-state="connected"] .play-pill-dot { background: var(--boo-green); box-shadow: 0 0 8px var(--boo-green); }
.play-pill[data-state="connecting"] .play-pill-dot { background: var(--boo-orange); animation: play-blink 1s infinite; }
.play-pill[data-state="error"] .play-pill-dot { background: #ff4d4d; }
@keyframes play-blink { 50% { opacity: 0.3; } }

.play-big {
  appearance: none;
  border: 0;
  border-radius: 20px;
  min-height: 72px;
  padding: 16px 20px;
  font: inherit;
  font-size: 1.375rem;
  font-weight: 800;
  color: #1a0b00;
  background: linear-gradient(180deg, #ffa04d, var(--boo-orange));
  box-shadow: 0 6px 24px rgba(255, 122, 26, 0.35);
  cursor: pointer;
  width: 100%;
  touch-action: manipulation;
}
.play-big:active { transform: translateY(1px) scale(0.99); }
.play-big:disabled { opacity: 0.6; }
.play-big--acid {
  color: #fff;
  background: linear-gradient(135deg, #ff3dd2, var(--boo-purple) 55%, #2fd1ff);
  box-shadow: 0 6px 24px rgba(139, 61, 255, 0.45);
}
.play-connect-card {
  background: var(--boo-card);
  border-radius: 20px;
  padding: 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  text-align: center;
}
.play-connect-card p { margin: 0; color: var(--boo-dim); font-size: 1rem; line-height: 1.4; }

.play-countdown {
  border-radius: 16px;
  padding: 12px 16px;
  background: rgba(255, 122, 26, 0.12);
  border: 1px solid rgba(255, 122, 26, 0.45);
  font-size: 1.0625rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  gap: 10px;
}
.play-countdown-time { font-variant-numeric: tabular-nums; color: var(--boo-orange); }
.play-countdown[data-low="1"] { background: rgba(255, 77, 77, 0.16); border-color: #ff4d4d; }

.play-revert {
  border-radius: 16px;
  padding: 14px 16px;
  background: rgba(93, 255, 138, 0.12);
  border: 1px solid rgba(93, 255, 138, 0.5);
  font-size: 1.0625rem;
  font-weight: 600;
  display: flex;
  gap: 10px;
  align-items: center;
}
.play-revert button {
  margin-left: auto;
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 1.375rem;
  min-width: 44px;
  min-height: 44px;
  cursor: pointer;
}

.play-hint {
  border-radius: 14px;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.06);
  color: var(--boo-dim);
  font-size: 0.875rem;
  line-height: 1.4;
}

.play-preview {
  position: relative;
  height: 180px;
  border-radius: 20px;
  overflow: hidden;
  background: #000;
}
.play-preview canvas { width: 100%; height: 100%; display: block; }

.play-tiles {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.play-tile {
  appearance: none;
  border: 2px solid transparent;
  border-radius: 20px;
  background: var(--boo-card);
  color: var(--boo-text);
  min-height: 112px;
  padding: 14px 10px;
  font: inherit;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  cursor: pointer;
  touch-action: manipulation;
}
.play-tile-emoji { font-size: 2.5rem; line-height: 1; }
.play-tile-name { font-size: 1.0625rem; font-weight: 700; text-align: center; }
.play-tile[aria-pressed="true"] {
  border-color: var(--boo-orange);
  box-shadow: 0 0 0 4px rgba(255, 122, 26, 0.25), 0 0 24px rgba(255, 122, 26, 0.35);
}
.play-tile:disabled { opacity: 0.5; }
.play-tile[data-busy="1"] .play-tile-emoji { animation: play-blink 0.8s infinite; }

.play-sliders { display: flex; flex-direction: column; gap: 14px; }
.play-slider {
  background: var(--boo-card);
  border-radius: 18px;
  padding: 12px 16px 16px;
}
.play-slider label {
  display: flex;
  justify-content: space-between;
  font-size: 1rem;
  font-weight: 700;
  margin-bottom: 8px;
  text-transform: capitalize;
}
.play-slider input[type="range"] {
  width: 100%;
  height: 44px;
  accent-color: var(--boo-orange);
  touch-action: pan-y;
}

.play-exit {
  text-align: center;
  font-size: 0.875rem;
  color: var(--boo-dim);
  text-decoration: underline;
  background: none;
  border: 0;
  padding: 12px;
  cursor: pointer;
  font: inherit;
}

/* Floating kiosk countdown chip (effects workspace / Acid Mode / anywhere but #/play). */
.kiosk-chip {
  position: fixed;
  left: 50%;
  bottom: max(12px, env(safe-area-inset-bottom));
  transform: translateX(-50%);
  z-index: 900;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(20, 10, 26, 0.92);
  border: 1px solid rgba(255, 122, 26, 0.6);
  color: #fff4e8;
  font-size: 0.875rem;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
.kiosk-chip[hidden] { display: none; }

/* The pumpkin entry button (onboarding + device sheet). */
.pumpkin-btn {
  appearance: none;
  border: 0;
  border-radius: 18px;
  min-height: 64px;
  width: 100%;
  padding: 12px 16px;
  font: inherit;
  font-size: 1.1875rem;
  font-weight: 800;
  color: #1a0b00;
  background: linear-gradient(180deg, #ffa04d, #ff7a1a);
  box-shadow: 0 4px 18px rgba(255, 122, 26, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  cursor: pointer;
  touch-action: manipulation;
  margin-bottom: var(--sp-3, 12px);
}
.pumpkin-btn-emoji { font-size: 1.875rem; line-height: 1; }

/* Kiosk owner section (device detail). */
.kiosk-section { display: flex; flex-direction: column; gap: 10px; }
.kiosk-section h3 { margin: 0; font-size: 1rem; }
.kiosk-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.kiosk-row label { flex: 1; min-width: 10rem; }
.kiosk-row input[type="number"] { width: 6rem; }
.kiosk-secret { font-family: var(--font-mono, monospace); font-size: 0.8125rem; word-break: break-all; color: var(--text-dim); }
.kiosk-status-line { font-size: 0.875rem; color: var(--text-dim); }
`;
