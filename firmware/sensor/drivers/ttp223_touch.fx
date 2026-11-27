// Touch sensor module (TTP223) on GPIO 3: active-high, momentary.
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
// A 150 ms lockout merges a bouncy press. Timers accumulate `dt`.
export trigger touch_tap;

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
    if (gpio_mode(3, 2) == 1) {
      configured = 1.0;
    }
    since_fire = 10.0;
  }
  uptime = uptime + dt;
  since_fire = since_fire + dt;
  float touched = 0.0;
  if (gpio_read(3) == 1) {
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
    if (armed > 0.5 && since_fire >= 0.15 && stable > 0.5) {
      fire(touch_tap);
      since_fire = 0.0;
    }
  }
  if (stable < 0.5) {
    armed = 1.0;
  }
}
