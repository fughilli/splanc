/**
 * Settings ▸ Appearance (design doc §2 design system). A user-configurable
 * theme surface: light/dark, accent palette (presets + a custom picker), a
 * workspace font stack + a monospace stack for the code editor, a UI scale, and
 * the 3D-view render knobs MapView honors (LED size, background, glow, grid /
 * triad defaults).
 *
 * Every control writes straight through {@link updateAppearance}, which
 * persists to localStorage and re-applies the CSS variables on `:root` live —
 * so the whole app (and any open 3D viewport) re-themes as you drag. Defaults
 * reproduce today's look, so this screen is purely opt-in.
 */

import { Card, Slider, Button, icon, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import {
  getAppearance,
  updateAppearance,
  resetAppearance,
  ACCENT_HEX,
  type AppearanceSettings,
  type ThemeMode,
  type FontChoice,
  type MonoChoice,
} from "../../store/appearance";
import { installSettingsStyles } from "./settings.css";

const FONT_LABELS: Record<FontChoice, string> = {
  system: "System",
  humanist: "Humanist",
  grotesk: "Grotesk (Inter)",
  rounded: "Rounded",
  serif: "Serif",
};
const MONO_LABELS: Record<MonoChoice, string> = {
  system: "System mono",
  "ibm-plex": "IBM Plex Mono",
  fira: "Fira Code",
  courier: "Courier",
};

export function SettingsScreen(_router: Router): Screen {
  installSettingsStyles();
  const el = document.createElement("div");
  el.className = "screen screen--settings";

  const head = document.createElement("h1");
  head.className = "screen-headline";
  head.textContent = "Appearance";
  const sub = document.createElement("p");
  sub.className = "screen-sub";
  sub.textContent = "Theme, fonts and 3D-view rendering. Saved on this device.";
  el.append(head, sub);

  let s = getAppearance();
  const set = (patch: Partial<AppearanceSettings>): void => {
    s = updateAppearance(patch);
    // Re-render controls whose state depends on other controls (accent picker,
    // segmented toggles) so their selected state stays in sync.
    rerender();
  };

  const body = document.createElement("div");
  el.appendChild(body);

  function rerender(): void {
    body.replaceChildren(themeGroup(), typeGroup(), viewGroup(), resetRow());
  }

  // -- Theme (mode + accent) -----------------------------------------------
  function themeGroup(): HTMLElement {
    const g = group("Theme");

    g.append(
      row(
        "Mode",
        "Light or dark base palette.",
        segmented<ThemeMode>(
          [
            ["dark", "Dark"],
            ["light", "Light"],
          ],
          s.mode,
          (v) => set({ mode: v }),
        ),
      ),
    );

    // Accent swatches (presets) + a custom color chip.
    const swatches = document.createElement("div");
    swatches.className = "settings-swatches";
    (Object.keys(ACCENT_HEX) as (keyof typeof ACCENT_HEX)[]).forEach((preset) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "settings-swatch" + (s.accentPreset === preset ? " on" : "");
      b.style.background = ACCENT_HEX[preset];
      b.title = preset;
      b.setAttribute("aria-label", `Accent ${preset}`);
      b.addEventListener("click", () => set({ accentPreset: preset }));
      swatches.appendChild(b);
    });
    // Custom picker: a native color input the "custom" preset reads from.
    const customBtn = document.createElement("button");
    customBtn.type = "button";
    customBtn.className =
      "settings-swatch settings-swatch--custom" + (s.accentPreset === "custom" ? " on" : "");
    customBtn.title = "Custom accent";
    customBtn.setAttribute("aria-label", "Custom accent");
    if (s.accentPreset === "custom") customBtn.style.background = s.accent;
    customBtn.append(icon("edit"));
    const picker = document.createElement("input");
    picker.type = "color";
    picker.value = s.accent;
    picker.style.cssText =
      "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none";
    customBtn.addEventListener("click", () => picker.click());
    picker.addEventListener("input", () => set({ accentPreset: "custom", accent: picker.value }));
    swatches.append(customBtn, picker);

    g.append(row("Accent", "The app's primary color.", swatches));
    return g;
  }

  // -- Typography (font + mono + scale) ------------------------------------
  function typeGroup(): HTMLElement {
    const g = group("Typography");
    g.append(
      row(
        "Workspace font",
        "Used across the app UI.",
        select<FontChoice>(FONT_LABELS, s.font, (v) => set({ font: v })),
      ),
      row(
        "Code font",
        "Monospace, for the effect editor.",
        select<MonoChoice>(MONO_LABELS, s.mono, (v) => set({ mono: v })),
      ),
      // The code font isn't used anywhere else on this screen, so show a live
      // sample — otherwise the choice only becomes visible back in the editor.
      monoPreview(),
    );
    g.append(
      fullRow(
        Slider({
          label: "UI scale",
          min: 0.85,
          max: 1.4,
          step: 0.05,
          value: s.uiScale,
          format: (v) => `${Math.round(v * 100)}%`,
          // UI scale rescales the whole app's root font-size, so applying it on
          // every `input` reflows the entire UI mid-drag. Commit only on release
          // (`change`); the readout still previews the target value while dragging.
          onChange: (v) => set({ uiScale: v }),
        }).el,
      ),
    );
    return g;
  }

  // -- 3D view (renderer knobs MapView honors) -----------------------------
  function viewGroup(): HTMLElement {
    const g = group("3D view");
    g.append(
      fullRow(
        Slider({
          label: "LED point size",
          min: 0.5,
          max: 2.5,
          step: 0.1,
          value: s.ledSize,
          format: (v) => `${v.toFixed(1)}×`,
          onInput: (v) => set({ ledSize: v }),
        }).el,
      ),
      fullRow(
        Slider({
          label: "Glow",
          min: 0,
          max: 2,
          step: 0.1,
          value: s.glow,
          format: (v) => `${Math.round(v * 100)}%`,
          onInput: (v) => set({ glow: v }),
        }).el,
      ),
    );

    // Background: a swatch that shows "Default" (near-black) or a chosen color.
    const bg = document.createElement("input");
    bg.type = "color";
    bg.className = "settings-color";
    bg.value = s.viewBg === "" ? "#111111" : s.viewBg;
    bg.addEventListener("input", () => set({ viewBg: bg.value }));
    const bgReset = Button({
      label: "Default",
      variant: "quiet",
      onClick: () => set({ viewBg: "" }),
    });
    const bgCtl = document.createElement("div");
    bgCtl.className = "settings-row-ctl";
    bgCtl.append(bg, bgReset);
    g.append(row("Background", "3D viewport background color.", bgCtl));

    g.append(
      row(
        "Ground grid",
        "Show the reference grid by default.",
        segmented<"on" | "off">(
          [
            ["off", "Off"],
            ["on", "On"],
          ],
          s.showGrid ? "on" : "off",
          (v) => set({ showGrid: v === "on" }),
        ),
      ),
      row(
        "Axes triad",
        "Show the world XYZ triad by default.",
        segmented<"on" | "off">(
          [
            ["off", "Off"],
            ["on", "On"],
          ],
          s.showTriad ? "on" : "off",
          (v) => set({ showTriad: v === "on" }),
        ),
      ),
    );
    return g;
  }

  function resetRow(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "settings-reset";
    wrap.append(
      Button({
        label: "Reset to defaults",
        variant: "quiet",
        block: true,
        onClick: () => {
          s = resetAppearance();
          rerender();
          toast("Appearance reset");
        },
      }),
    );
    return wrap;
  }

  rerender();
  return { el };
}

// -- small local builders ----------------------------------------------------


function group(legend: string): HTMLElement {
  const card = Card();
  card.classList.add("settings-group");
  const l = document.createElement("div");
  l.className = "settings-legend";
  l.textContent = legend;
  card.appendChild(l);
  return card;
}

function row(name: string, hint: string, control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "settings-row";
  const label = document.createElement("div");
  label.className = "settings-row-label";
  const n = document.createElement("div");
  n.className = "settings-row-name";
  n.textContent = name;
  const h = document.createElement("div");
  h.className = "settings-row-hint";
  h.textContent = hint;
  label.append(n, h);
  const ctl = document.createElement("div");
  ctl.className = "settings-row-ctl";
  ctl.appendChild(control);
  r.append(label, ctl);
  return r;
}

/** A full-width sample of the current code font. Draws from `var(--font-mono)`
 * (set live on :root by updateAppearance), so it swaps the moment the picker
 * changes. The snippet packs the glyphs that separate monospace faces apart —
 * 0/O, 1/l/I, and the `=>`/`==`/`!=` sequences Fira Code renders as ligatures. */
function monoPreview(): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "settings-mono-preview";
  pre.setAttribute("aria-hidden", "true");
  pre.textContent = "// preview 0O o1lI\nfn hue(i) => (i * 137) != 0;";
  return pre;
}

/** A full-width row that hosts a slider (which supplies its own label). */
function fullRow(control: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "settings-row settings-full";
  r.appendChild(control);
  return r;
}

function segmented<T extends string>(
  options: [T, string][],
  value: T,
  onPick: (v: T) => void,
): HTMLElement {
  const seg = document.createElement("div");
  seg.className = "settings-seg";
  for (const [v, label] of options) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    if (v === value) b.classList.add("on");
    b.addEventListener("click", () => onPick(v));
    seg.appendChild(b);
  }
  return seg;
}

function select<T extends string>(
  labels: Record<T, string>,
  value: T,
  onPick: (v: T) => void,
): HTMLElement {
  const sel = document.createElement("select");
  sel.className = "settings-select";
  for (const key of Object.keys(labels) as T[]) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = labels[key];
    if (key === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onPick(sel.value as T));
  return sel;
}
