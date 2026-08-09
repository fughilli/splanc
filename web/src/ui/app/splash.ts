/**
 * Startup splash (design doc §7.7) — a brief branded overlay shown on each
 * launch while the "Startup splash" appearance toggle is on (Appearance ▸
 * Startup). The app boots behind it, so it's a welcome, not a loading gate; it
 * fades itself out after a beat.
 */

import { getAppearance } from "../../store/appearance";
import { splancMarkSvg } from "./iconMark";

const HOLD_MS = 1400;
const FADE_MS = 420;

export function maybeShowSplash(): void {
  if (typeof document === "undefined") return;
  if (!getAppearance().splash) return;

  const overlay = document.createElement("div");
  overlay.className = "splash";
  overlay.setAttribute("role", "presentation");

  // Inline (not <img>) so the badge/glyph colours can swap by theme: dark →
  // black glyph on an accent badge; light → accent glyph on a black badge.
  const dark = getAppearance().mode === "dark";
  const square = dark ? "var(--accent)" : "#000";
  const glyph = dark ? "#000" : "var(--accent)";
  const tpl = document.createElement("template");
  tpl.innerHTML = splancMarkSvg(square, glyph).trim();
  const logo = tpl.content.firstElementChild!;

  const word = document.createElement("div");
  word.className = "splash-word";
  word.textContent = "Splanc";

  overlay.append(logo, word);
  document.body.appendChild(overlay);

  window.setTimeout(() => {
    overlay.classList.add("splash--out");
    window.setTimeout(() => overlay.remove(), FADE_MS);
  }, HOLD_MS);
}
