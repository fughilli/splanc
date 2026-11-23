/**
 * The capacitive-touch module (TTP223 and alike) as a driver-VM driver
 * (docs/design/lamp-power.md, owner decision D-185): the module's OUT pin on a
 * GPIO input, read by poll(), debounced, and published as a pool TRIGGER that
 * power binds to (SetPowerConfig.toggle_trigger).
 *
 * The template is the single source of the driver; the app (Sensors page, kit
 * onboarding) and tests fill it in with touchDriverSource().
 */

export const TOUCH_MODE_MOMENTARY = 0;
export const TOUCH_MODE_TOGGLE = 1;
/** The trigger name the lamp's power binds to by default. */
export const DEFAULT_TOUCH_TRIGGER = "touch_tap";
/** poll() interval for the touch driver (SubmitDriver.poll_interval_ms). */
export const TOUCH_POLL_MS = 10;

export interface TouchDriverConfig {
  /** GPIO the board's I/O pin is wired to. */
  gpio: number;
  /** I/O reads low while touched (TTP223 pad A bridged). */
  activeLow: boolean;
  /** TOUCH_MODE_MOMENTARY (each press fires) or TOUCH_MODE_TOGGLE (every OUT change fires). */
  mode: number;
  /** The exported trigger's name (an identifier). */
  exportName?: string;
}

/** A valid fx identifier for the trigger (falls back to the default). */
export function triggerName(name: string | undefined): string {
  const n = (name ?? "").trim();
  return /^[A-Za-z_][A-Za-z0-9_]{0,23}$/.test(n) ? n : DEFAULT_TOUCH_TRIGGER;
}

/** Validate a config; returns an error string or null. */
export function touchConfigError(c: TouchDriverConfig): string | null {
  if (!Number.isInteger(c.gpio) || c.gpio < 0 || c.gpio > 30) return "pick a GPIO (0-30)";
  if (c.mode !== TOUCH_MODE_MOMENTARY && c.mode !== TOUCH_MODE_TOGGLE) return "unknown mode";
  return null;
}

/**
 * The driver source for a config: the canonical driver
 * //firmware/sensor:drivers/ttp223_touch.fx with the pin, polarity, mode and
 * trigger filled in (the defaults reproduce that file exactly; touchDriver_test
 * checks). Timers accumulate `dt` (`time` wraps every 1024 s). The first second
 * is ignored (the TTP223 recalibrates for ~0.5 s after power-up). Active-high
 * pulls the pin down (gpio_mode 2), active-low pulls it up (1). Momentary fires
 * on each debounced press once it has been seen released; toggle / self-lock
 * fires on every debounced change of OUT and is armed right after calibration.
 */
export function touchDriverSource(c: TouchDriverConfig): string {
  const err = touchConfigError(c);
  if (err) throw new Error(`touch driver: ${err}`);
  const name = triggerName(c.exportName);
  const pull = c.activeLow ? 1 : 2;
  const active = c.activeLow ? 0 : 1;
  const toggle = c.mode === TOUCH_MODE_TOGGLE;
  const arm = toggle ? "  armed = 1.0;" : "  if (stable < 0.5) {\n    armed = 1.0;\n  }";
  return `// Touch sensor module (TTP223) on GPIO ${c.gpio}: ${c.activeLow ? "active-low" : "active-high"}, ${toggle ? "toggle" : "momentary"}.
// The canonical driver (docs/design/lamp-power.md). The app and the agent fill
// in the same template (web/src/power/touchDriver.ts touchDriverSource()); with
// the defaults (GPIO 3, active-high, momentary, "touch_tap") it must produce
// exactly this file (//web:power_test checks).
//
// poll() every ~10 ms: configures the pin once (input, pull toward idle so an
// unwired module never reads as a touch), ignores the first 1 s (the TTP223
// recalibrates for ~0.5 s after power-up), debounces (25 ms), ignores a "touched" level until
// it has been seen released (wrong polarity never fires), and fires the trigger
// on each press (momentary) or on every change of OUT (toggle / self-lock).
// A 150 ms lockout merges a bouncy press. Timers accumulate \`dt\`.
export trigger ${name};

state float configured;
state float uptime;      // s since the driver started
state float stable;      // debounced level: 1 = touched
state float raw;         // last raw level
state float held;        // s the raw level has been unchanged
state float armed;       // 1 once seen released
state float since_fire;  // s since the last fire

void poll() {
  if (configured < 0.5) {
    // Input, pull-down (idle low). Retried each poll until the host applies it.
    if (gpio_mode(${c.gpio}, ${pull}) == 1) {
      configured = 1.0;
    }
    since_fire = 10.0;
  }
  uptime = uptime + dt;
  since_fire = since_fire + dt;
  float touched = 0.0;
  if (gpio_read(${c.gpio}) == ${active}) {
    touched = 1.0;
  }
  if (touched != raw) {
    raw = touched;
    held = 0.0;
  } else {
    held = held + dt;
  }
  if (uptime < 1.0) {
    // Calibrating: follow the level, never fire.
    stable = raw;
    armed = 0.0;
    return;
  }
  if (raw != stable && held >= 0.025) {
    stable = raw;
    if (armed > 0.5 && since_fire >= 0.15${toggle ? "" : " && stable > 0.5"}) {
      fire(${name});
      since_fire = 0.0;
    }
  }
${arm}
}
`;
}

/** Compile hook (injected so the app's worker compiler, a test stub or the
 * agent's host compiler can be used). */
export type DriverCompile = (source: string) => Promise<{ ok: boolean; bytecode: Uint8Array; error?: string }>;

/** What a touch setup needs from the connected lamp. */
export interface TouchSetupClient {
  submitDriver(fxb: Uint8Array, pollIntervalMs?: number): Promise<{ running: boolean }>;
  setPowerConfig(cfg: { toggleTrigger?: string }): Promise<{ toggleTrigger: string }>;
}

/** Compile + submit the touch driver, then bind its trigger to power. */
export async function setUpTouch(
  client: TouchSetupClient,
  compile: DriverCompile,
  cfg: TouchDriverConfig,
): Promise<{ trigger: string }> {
  const src = touchDriverSource(cfg);
  const r = await compile(src);
  if (!r.ok) throw new Error(r.error ? `driver doesn't compile: ${r.error}` : "driver doesn't compile");
  const st = await client.submitDriver(r.bytecode, TOUCH_POLL_MS);
  if (!st.running) throw new Error("the lamp didn't start the driver");
  const trigger = triggerName(cfg.exportName);
  await client.setPowerConfig({ toggleTrigger: trigger });
  return { trigger };
}

/** The trigger export's count in a driver_state (a trigger exports its fire count). */
export function triggerExportCount(exports: Array<{ name: string; value: number[] }>, name: string): number | null {
  const e = exports.find((x) => x.name === name);
  return e && e.value.length > 0 ? (e.value[0] ?? null) : null;
}
