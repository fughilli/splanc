/**
 * Appearance / theme settings (user-configurable, persisted across reloads).
 *
 * The app is themed entirely through CSS custom properties (kit/tokens.css,
 * app/app.css). This store owns a small, serializable `AppearanceSettings`
 * object and turns it into overrides on `document.documentElement` (`:root`):
 *   - a light/dark base and a preset (or custom) accent palette;
 *   - a workspace font stack, a monospace stack for the code editor, and a
 *     `--ui-scale` that rescales the root font-size;
 *   - 3D renderer knobs (LED point size, background, glow, grid/triad defaults)
 *     that MapView reads live (see {@link renderSettings}).
 *
 * The pure pieces — DEFAULTS, (de)serialization, and {@link resolveThemeVars} /
 * {@link resolveRenderSettings} — are DOM-free so they can be unit-tested under
 * plain Node (see tests/appearance.test.ts). Only {@link applyAppearance} and
 * the load/subscribe glue touch `document` / `localStorage`, guarded so the
 * module also imports cleanly in a non-DOM context.
 *
 * Defaults reproduce today's look exactly (dark, indigo accent, system font,
 * scale 1, MapView's original render constants) so existing users see no change
 * until they opt in.
 */

const STORAGE_KEY = "ledmapper.appearance";

// -- theme model -------------------------------------------------------------

export type ThemeMode = "dark" | "light";

/** Accent presets — the id keys a small curated palette; "custom" reads the
 * user-picked `accent` hex instead. */
export type AccentPreset = "indigo" | "violet" | "teal" | "amber" | "rose" | "custom";

/** Named workspace font stacks (labels shown in the picker). */
export type FontChoice = "system" | "humanist" | "grotesk" | "rounded" | "serif";
/** Monospace stacks for the code editor. */
export type MonoChoice = "system" | "ibm-plex" | "fira" | "courier";

export interface AppearanceSettings {
  mode: ThemeMode;
  accentPreset: AccentPreset;
  /** Custom accent hex (used when accentPreset === "custom"). */
  accent: string;
  font: FontChoice;
  mono: MonoChoice;
  /** Root font-size multiplier, 0.85–1.4. */
  uiScale: number;

  // -- 3D renderer knobs (honored by MapView) --
  /** LED point radius multiplier, 0.5–2.5 (1 = today's sizes). */
  ledSize: number;
  /** 3D viewport background. "" keeps MapView's original near-black. */
  viewBg: string;
  /** Additive glow strength for lit LEDs, 0–2 (1 = today's halo). */
  glow: number;
  /** Grid on the ground plane visible by default. */
  showGrid: boolean;
  /** World coordinate triad visible by default. */
  showTriad: boolean;
}

export const DEFAULTS: Readonly<AppearanceSettings> = {
  mode: "dark",
  accentPreset: "indigo",
  accent: "#5b7cfa",
  font: "system",
  mono: "system",
  uiScale: 1,
  ledSize: 1,
  viewBg: "",
  glow: 1,
  showGrid: false,
  showTriad: false,
};

// -- palettes ----------------------------------------------------------------

/** Accent hexes per preset (the "custom" entry is overridden by `accent`). */
export const ACCENT_HEX: Record<Exclude<AccentPreset, "custom">, string> = {
  indigo: "#5b7cfa",
  violet: "#a06bfa",
  teal: "#2bc7c7",
  amber: "#e3a13b",
  rose: "#f2557d",
};

/** Base (non-accent) colors for each theme mode. Dark reproduces tokens.css. */
interface BaseColors {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  text: string;
  textDim: string;
  colorScheme: "dark" | "light";
}

const BASE: Record<ThemeMode, BaseColors> = {
  dark: {
    bg: "#0e0e12",
    surface: "#17171c",
    surface2: "#1f1f26",
    border: "#2a2a33",
    text: "#e8e8ea",
    textDim: "#9a9aa2",
    colorScheme: "dark",
  },
  light: {
    bg: "#f6f6f9",
    surface: "#ffffff",
    surface2: "#ececf1",
    border: "#d7d7de",
    text: "#1a1a1f",
    textDim: "#63636d",
    colorScheme: "light",
  },
};

// -- font stacks -------------------------------------------------------------

// The three sans faces below are self-hosted (see ui/kit/fonts.css) because the
// desktop-only families they used to lead with — Segoe UI, Inter, Avenir Next —
// aren't installed on Android, so every sans option there collapsed to Roboto
// (FUG-29). "system" and "serif" stay as pure system stacks: both already
// render distinctly on Android (Roboto and Noto Serif). The trailing system
// fonts are kept as fallbacks in case a bundled woff2 fails to load.
export const FONT_STACKS: Record<FontChoice, string> = {
  system: "system-ui, sans-serif",
  humanist: "'Open Sans', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  grotesk: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  rounded: "'Nunito', 'Avenir Next', 'Segoe UI', system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
};

// Same fix as FONT_STACKS: the named mono faces (IBM Plex Mono, Fira Code,
// Courier New) aren't on Android, so every non-"system" mono choice collapsed
// to the platform monospace. The first three are self-hosted (see fonts.css;
// "Courier Prime" is a metric-compatible Courier substitute); "system" stays a
// system stack. Trailing system fonts remain as fallbacks.
export const MONO_STACKS: Record<MonoChoice, string> = {
  system: "ui-monospace, monospace",
  "ibm-plex": "'IBM Plex Mono', ui-monospace, monospace",
  fira: "'Fira Code', ui-monospace, monospace",
  courier: "'Courier Prime', 'Courier New', Courier, monospace",
};

// -- (de)serialization -------------------------------------------------------

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Coerce arbitrary parsed JSON into a valid settings object (fills defaults for
 * anything missing/invalid). Pure — safe to unit-test. */
export function normalizeSettings(raw: unknown): AppearanceSettings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const accent = typeof o["accent"] === "string" && HEX_RE.test(o["accent"]) ? o["accent"] : DEFAULTS.accent;
  return {
    mode: oneOf<ThemeMode>(o["mode"], ["dark", "light"], DEFAULTS.mode),
    accentPreset: oneOf<AccentPreset>(
      o["accentPreset"],
      ["indigo", "violet", "teal", "amber", "rose", "custom"],
      DEFAULTS.accentPreset,
    ),
    accent,
    font: oneOf<FontChoice>(o["font"], ["system", "humanist", "grotesk", "rounded", "serif"], DEFAULTS.font),
    mono: oneOf<MonoChoice>(o["mono"], ["system", "ibm-plex", "fira", "courier"], DEFAULTS.mono),
    uiScale: clampNum(o["uiScale"], 0.85, 1.4, DEFAULTS.uiScale),
    ledSize: clampNum(o["ledSize"], 0.5, 2.5, DEFAULTS.ledSize),
    viewBg: typeof o["viewBg"] === "string" && (o["viewBg"] === "" || HEX_RE.test(o["viewBg"])) ? o["viewBg"] : DEFAULTS.viewBg,
    glow: clampNum(o["glow"], 0, 2, DEFAULTS.glow),
    showGrid: o["showGrid"] === true,
    showTriad: o["showTriad"] === true,
  };
}

/** The accent hex a settings object resolves to (preset or custom). */
export function resolveAccent(s: AppearanceSettings): string {
  return s.accentPreset === "custom" ? s.accent : ACCENT_HEX[s.accentPreset];
}

/** Mix two #rrggbb colors: `t` in 0..1 toward `b`. */
function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i]! - v) * t));
  return "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Resolve settings into the exact set of CSS custom properties to set on
 * `:root` (plus `color-scheme`). Pure — this is the tested contract. Only
 * emits the tokens the app actually consumes; spacing/radius/motion tokens are
 * left untouched so component metrics are unchanged.
 */
export function resolveThemeVars(s: AppearanceSettings): Record<string, string> {
  const base = BASE[s.mode];
  const accent = resolveAccent(s);
  // accent-quiet is a dim wash of the accent over the surface (matches the
  // original indigo #2b3566 ≈ accent mixed ~55% into a dark surface).
  const accentQuiet =
    s.mode === "dark" ? mixHex(base.surface2, accent, 0.42) : mixHex(base.surface2, accent, 0.28);
  return {
    "color-scheme": base.colorScheme,
    "--bg": base.bg,
    "--surface": base.surface,
    "--surface-2": base.surface2,
    "--border": base.border,
    "--text": base.text,
    "--text-dim": base.textDim,
    "--accent": accent,
    "--accent-quiet": accentQuiet,
    "--font-ui": FONT_STACKS[s.font],
    "--font-mono": MONO_STACKS[s.mono],
  };
}

// -- render settings (read live by MapView) ----------------------------------

export interface RenderSettings {
  ledSize: number;
  /** Resolved viewport background (never empty — falls back to MapView's dark). */
  viewBg: string;
  glow: number;
  showGrid: boolean;
  showTriad: boolean;
}

/** MapView's original background (kept as the default so nothing changes). */
export const DEFAULT_VIEW_BG = "#111";

export function resolveRenderSettings(s: AppearanceSettings): RenderSettings {
  return {
    ledSize: s.ledSize,
    viewBg: s.viewBg === "" ? DEFAULT_VIEW_BG : s.viewBg,
    glow: s.glow,
    showGrid: s.showGrid,
    showTriad: s.showTriad,
  };
}

// -- live store (DOM + persistence) ------------------------------------------

let current: AppearanceSettings = { ...DEFAULTS };
let currentRender: RenderSettings = resolveRenderSettings(DEFAULTS);
const listeners = new Set<(s: AppearanceSettings) => void>();

function readStored(): AppearanceSettings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    return normalizeSettings(raw ? JSON.parse(raw) : {});
  } catch {
    return { ...DEFAULTS };
  }
}

function writeStored(s: AppearanceSettings): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage blocked (private mode / quota) — non-fatal */
  }
}

/** Push the resolved theme vars onto :root and set the app font. No-op without
 * a DOM (so this module is safe to import under Node). */
export function applyAppearance(s: AppearanceSettings = current): void {
  currentRender = resolveRenderSettings(s);
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const vars = resolveThemeVars(s);
  for (const [k, v] of Object.entries(vars)) {
    if (k === "color-scheme") root.style.setProperty("color-scheme", v);
    else root.style.setProperty(k, v);
  }
  // UI scale rescales the root font-size; every rem-based token (--f-*, spacing
  // that uses rem, control padding) tracks it. tokens.css already draws the body
  // font from --font-ui / --font-mono, so those swap live via the vars above.
  root.style.fontSize = `${(s.uiScale * 100).toFixed(2)}%`;
}

/** Load persisted settings (or defaults) and apply them. Call once at startup,
 * as early as possible, to avoid a flash of the default theme. */
export function initAppearance(): AppearanceSettings {
  current = readStored();
  applyAppearance(current);
  return current;
}

/** The current settings (a copy — mutate via {@link updateAppearance}). */
export function getAppearance(): AppearanceSettings {
  return { ...current };
}

/** Merge a partial update, persist, apply, and notify subscribers. */
export function updateAppearance(patch: Partial<AppearanceSettings>): AppearanceSettings {
  current = normalizeSettings({ ...current, ...patch });
  writeStored(current);
  applyAppearance(current);
  for (const cb of listeners) cb(current);
  return current;
}

/** Reset every appearance setting back to the shipped defaults. */
export function resetAppearance(): AppearanceSettings {
  return updateAppearance({ ...DEFAULTS });
}

export function subscribeAppearance(cb: (s: AppearanceSettings) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Live render settings for the 3D view. MapView calls this each frame so a
 * change from the Settings screen re-themes every open viewport immediately. */
export function renderSettings(): RenderSettings {
  return currentRender;
}
