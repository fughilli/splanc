/**
 * Connect picker + saved-networks styles (D-72), injected once (design tokens
 * from kit/tokens.css; CJS-safe, mirroring settings.css.ts).
 *
 * Layout rules (owner, binding): one primary action per screen, secondary ones
 * subordinate and on their own rows, never jammed together (gap ≥ 8 px, 12–16 px
 * between action rows).
 */

let installed = false;

export function installConnectStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

const CSS = `
/* The two top-level actions: full width, each on its own row, 12 px apart. */
.connect-actions {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

.connect-label {
  font-size: var(--f-caption);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
  margin: var(--sp-3) 0 var(--sp-2);
}
.connect-picker > .connect-label:first-child,
.connect-picker > div:first-child:empty + .connect-label {
  margin-top: 0;
}

.connect-modes {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
/* A mode: the drawing on the left, title + one line on the right. */
.connect-mode {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-2);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-card, 12px);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.connect-mode:hover:not(:disabled),
.connect-mode:focus-visible {
  border-color: var(--accent);
}
.connect-mode-img {
  flex: 0 0 auto;
  width: 128px;
  aspect-ratio: 16 / 10;
  object-fit: cover;
  border-radius: 8px;
  background: #000;
}
.connect-mode-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.connect-mode-title {
  font-weight: 600;
}
.connect-mode-blurb {
  color: var(--text-dim);
  font-size: var(--f-caption);
  line-height: 1.35;
}
.connect-mode--off {
  cursor: not-allowed;
  opacity: 0.6;
}
@media (min-width: 600px) {
  .connect-mode-img { width: 176px; }
}

.connect-footer {
  margin-top: var(--sp-4);
}

/* Found-on-the-network rows reuse the device-row look; their Connect is a small
   labelled button. */
.k-btn.device-act {
  padding: 0.35rem 0.8rem;
  font-size: var(--f-caption);
  flex: none;
}
.connect-found .device-row:last-child {
  border-bottom: none;
}
.device-hint {
  color: var(--text-dim);
  font-size: var(--f-caption);
  line-height: 1.4;
  margin: var(--sp-2) 0 0;
}

/* "Flash a new device" where USB flashing can't work: the pictogram. */
.connect-flash-sheet {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.connect-flash-img {
  width: 100%;
  max-width: 560px;
  align-self: center;
  aspect-ratio: 8 / 5;
  object-fit: cover;
  border-radius: 12px;
  background: #000;
}
.connect-flash-lead {
  font-weight: 600;
  margin: 0;
}
.connect-flash-how {
  color: var(--text-dim);
  margin: 0;
  line-height: 1.45;
}

/* Settings ▸ Wi-Fi networks. */
.screen--wifi { padding-bottom: var(--sp-8); }
.wifi-net-list {
  display: flex;
  flex-direction: column;
}
.wifi-net {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  padding: var(--sp-3) var(--sp-1);
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.wifi-net:last-child { border-bottom: none; }
.wifi-net:hover { background: var(--surface-2); }
.wifi-net-info { flex: 1; min-width: 0; }
.wifi-net-ssid {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wifi-net-meta {
  color: var(--text-dim);
  font-size: var(--f-caption);
}
.wifi-net-meta--bad { color: var(--err); }
.wifi-net-badge {
  font-size: var(--f-caption);
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 0 0.5rem;
  flex: none;
}
.wifi-net-empty {
  color: var(--text-dim);
  text-align: center;
  padding: var(--sp-4) 0;
}
.wifi-net-add { margin-top: var(--sp-4); }
`;
