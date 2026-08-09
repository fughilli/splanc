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

import { Card, Slider, Button, confirmDialog, icon, toast } from "../kit";
import type { Router, Screen } from "../app/router";
import {
  getAppearance,
  updateAppearance,
  resetAppearance,
  resolveAccent,
  renderSettings,
  ACCENT_HEX,
  type AppearanceSettings,
  type ThemeMode,
  type FontChoice,
  type MonoChoice,
} from "../../store/appearance";
import { installSettingsStyles } from "./settings.css";
import { MapView } from "../mapview";
import { generateFixture } from "../../effects/fixtures";
import { prefs, DEFAULT_MANUAL_EXPOSURE_CEILING_MS } from "../../store/prefs";

type SettingsTab = "appearance" | "behavior";

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

  // The app bar already reads "Settings", so the body leads straight with the
  // tabs — Appearance (theme / fonts / 3D / startup) and Behavior (capture and,
  // later, other behavioural knobs). Each panel ends with its own "Reset".
  let tab: SettingsTab = "appearance";

  let s = getAppearance();
  const set = (patch: Partial<AppearanceSettings>): void => {
    s = updateAppearance(patch);
    // Re-render controls whose state depends on other controls (accent picker,
    // segmented toggles) so their selected state stays in sync.
    rerender();
  };
  // Continuous controls (the sliders, the background picker) write through with
  // `setLive`: it persists + applies the change but does NOT rebuild the
  // settings DOM. A full rerender (replaceChildren) tears out the <input> the
  // user is mid-drag on, aborting the gesture after a single step — the bug this
  // issue fixes. These controls need no structural resync: the Slider updates
  // its own readout, applyAppearance() re-applies the CSS vars, and the live 3D
  // preview reads renderSettings() each frame, so the value + preview track the
  // drag continuously without a rerender.
  const setLive = (patch: Partial<AppearanceSettings>): void => {
    s = updateAppearance(patch);
  };

  const body = document.createElement("div");
  el.appendChild(body);

  // -- live 3D preview -----------------------------------------------------
  // A small looping viewport in the "3D view" group so LED point size + glow
  // (and background) show their effect as you drag the sliders. It reuses
  // MapView, which reads renderSettings() every frame, so the render knobs are
  // honored live with no extra wiring. A ring of LEDs runs a traveling
  // "ring-pulse" animation tinted with the current accent.
  //
  // The canvas + MapView are built ONCE here (not inside rerender): viewGroup()
  // re-parents this element on each rebuild, so the MapView instance and its
  // animation survive intact (recreating them would restart/leak the loop).
  const preview = buildPreview();

  function rerender(): void {
    const panels =
      tab === "appearance"
        ? [themeGroup(), typeGroup(), viewGroup(), startupGroup(), experimentalGroup(), appearanceResetRow()]
        : [captureGroup(), captureResetRow()];
    body.replaceChildren(tabBar(), ...panels);
  }

  // Switch tabs. The 3D preview only lives in the Appearance panel, so pause its
  // render loop while it's off-screen (Capture) and resume when it's back.
  function setTab(next: SettingsTab): void {
    if (next === tab) return;
    tab = next;
    rerender();
    if (next === "appearance") preview.start();
    else preview.stop();
  }

  function tabBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "settings-tabs";
    const mk = (id: SettingsTab, label: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "settings-tab" + (tab === id ? " on" : "");
      b.textContent = label;
      b.setAttribute("aria-selected", String(tab === id));
      b.addEventListener("click", () => setTab(id));
      return b;
    };
    bar.append(mk("appearance", "Appearance"), mk("behavior", "Behavior"));
    return bar;
  }

  // -- Startup (launch behavior) -------------------------------------------
  function startupGroup(): HTMLElement {
    const g = group("Startup");
    g.append(
      row(
        "Splash screen",
        "Show the Splanc splash each time the app launches.",
        segmented<"on" | "off">(
          [
            ["off", "Off"],
            ["on", "On"],
          ],
          s.splash ? "on" : "off",
          (v) => set({ splash: v === "on" }),
        ),
      ),
    );
    return g;
  }

  // -- Experimental (feature-flagged, off by default) ----------------------
  function experimentalGroup(): HTMLElement {
    const g = group("Experimental");
    g.append(
      row(
        "Render FX previews",
        "Animated effect previews in the library. Slow on mobile, YMMV.",
        segmented<"on" | "off">(
          [
            ["off", "Off"],
            ["on", "On"],
          ],
          s.renderFxPreviews ? "on" : "off",
          (v) => set({ renderFxPreviews: v === "on" }),
        ),
      ),
    );
    return g;
  }

  // -- Capture (camera / mapping knobs) ------------------------------------
  function captureGroup(): HTMLElement {
    const g = group("Capture");
    const hint = document.createElement("div");
    hint.className = "settings-row-hint settings-full";
    hint.textContent =
      "The manual exposure slider (Advanced ▸ Manual override, while mapping) " +
      "ranges from the camera minimum up to this ceiling. Raise it to light the " +
      "frame under artificial light; the automatic exposure stays capped for " +
      "decode sharpness.";
    g.append(
      fullRow(
        Slider({
          label: "Manual exposure ceiling",
          min: 20,
          max: 1000,
          step: 10,
          value: prefs.getManualExposureCeilingMs(),
          format: (v) => `${Math.round(v)} ms`,
          // Not applied to anything on this screen, so commit on release.
          onChange: (v) => prefs.setManualExposureCeilingMs(v),
        }).el,
      ),
      hint,
    );
    return g;
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
          // setLive (no rerender) so the whole screen recolors together via the
          // theme transition, instead of the cards snapping while the chrome fades.
          (v) => setLive({ mode: v }),
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
    g.append(preview.el);
    g.append(
      fullRow(
        Slider({
          label: "LED point size",
          min: 0.5,
          max: 2.5,
          step: 0.1,
          value: s.ledSize,
          format: (v) => `${v.toFixed(1)}×`,
          onInput: (v) => setLive({ ledSize: v }),
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
          onInput: (v) => setLive({ glow: v }),
        }).el,
      ),
    );

    // Background: a swatch that shows "Default" (near-black) or a chosen color.
    const bg = document.createElement("input");
    bg.type = "color";
    bg.className = "settings-color";
    bg.value = s.viewBg === "" ? "#111111" : s.viewBg;
    bg.addEventListener("input", () => setLive({ viewBg: bg.value }));
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

  function appearanceResetRow(): HTMLElement {
    return resetRow("Reset all appearance settings (theme, fonts, 3D view, startup) to their defaults?", () => {
      s = resetAppearance();
      rerender();
      toast("Appearance reset");
    });
  }

  function captureResetRow(): HTMLElement {
    return resetRow("Reset capture settings to their defaults?", () => {
      prefs.setManualExposureCeilingMs(DEFAULT_MANUAL_EXPOSURE_CEILING_MS);
      rerender();
      toast("Capture settings reset");
    });
  }

  /** A block "Reset to defaults" button that confirms before running `apply`. */
  function resetRow(confirmMsg: string, apply: () => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "settings-reset";
    wrap.append(
      Button({
        label: "Reset to defaults",
        variant: "quiet",
        block: true,
        onClick: () => {
          void confirmDialog({
            title: "Reset to defaults",
            message: confirmMsg,
            confirmLabel: "Reset",
          }).then((ok) => {
            if (ok) apply();
          });
        },
      }),
    );
    return wrap;
  }

  rerender();
  return {
    el,
    onMount: () => preview.start(),
    onUnmount: () => preview.stop(),
  };
}

// -- 3D preview --------------------------------------------------------------

interface PreviewHandle {
  el: HTMLElement;
  start: () => void;
  stop: () => void;
}

/**
 * A self-contained looping 3D preview for the Appearance screen: a ring of LEDs
 * running a traveling "ring-pulse" so the size/glow/background knobs are visible
 * while you drag their sliders. It hosts a {@link MapView} (which reads the live
 * renderSettings() each frame, so the knobs apply with no extra plumbing) and
 * pushes fresh per-LED colours on its own rAF. `start`/`stop` are driven by the
 * screen's mount/unmount so the loop and canvas listeners don't leak.
 */
function buildPreview(): PreviewHandle {
  const wrap = document.createElement("div");
  wrap.className = "settings-preview";
  const canvas = document.createElement("canvas");
  canvas.className = "settings-preview-canvas";
  const cap = document.createElement("div");
  cap.className = "settings-preview-cap";
  cap.textContent = "Live preview — drag the sliders to see LED size & glow.";
  wrap.append(canvas, cap);

  const N = 72;
  const map = generateFixture("ring", { count: N, seed: 1, jitterFrac: 0 });
  // The fixture rings in the XY plane; MapView auto-orbits about +Y, which would
  // swing that ring edge-on. Lay it flat in the XZ (ground) plane so the orbit
  // always reads as a rotating disc.
  for (const led of map.leds) {
    const [x, y] = led.xyz;
    led.xyz = [x, 0, y];
  }
  const view = new MapView(canvas, map);
  view.showStats = false; // solver stats are meaningless for a synthetic preview
  const colors = new Uint8Array(N * 3);
  view.setLedColors(colors); // MapView reads this buffer each frame; we mutate in place

  let raf = 0;
  let t = 0;
  const paint = (): void => {
    // MapView only *seeds* grid/triad visibility from the Appearance defaults at
    // construction (per-view state owns it afterward), so drive them from the
    // live settings each frame here — that's what makes the two toggles show up
    // in this preview. ledSize/glow/background are already read live by MapView.
    const rs = renderSettings();
    view.showGrid = rs.showGrid;
    view.showTriad = rs.showTriad;
    // Accent-tinted comet chasing around the ring, over a dim base glow so the
    // whole fixture stays visible. `t` advances ~1/frame; head sweeps 0..1.
    const [ar, ag, ab] = hexToRgb(resolveAccent(getAppearance()));
    const head = (t * 0.004) % 1;
    const sigma = 0.09;
    for (let i = 0; i < N; i++) {
      const phase = i / N;
      let d = Math.abs(phase - head);
      d = Math.min(d, 1 - d); // wrap-around distance on the ring
      const pulse = Math.exp(-(d * d) / (2 * sigma * sigma));
      const level = 0.12 + 0.88 * pulse; // dim baseline → bright comet head
      colors[i * 3] = Math.round(ar * level);
      colors[i * 3 + 1] = Math.round(ag * level);
      colors[i * 3 + 2] = Math.round(ab * level);
    }
  };

  const loop = (): void => {
    raf = requestAnimationFrame(loop);
    t += 1;
    paint();
  };

  return {
    el: wrap,
    start: () => {
      paint();
      view.start();
      if (raf === 0) loop();
    },
    stop: () => {
      view.stop();
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}

/** Parse a #rrggbb string to an [r,g,b] triple (0–255); white on any miss. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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
    b.addEventListener("click", () => {
      // Reflect the choice immediately so callers that skip a full rerender (e.g.
      // the theme toggle, which animates instead) still show the selection.
      for (const sib of seg.children) sib.classList.remove("on");
      b.classList.add("on");
      onPick(v);
    });
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
