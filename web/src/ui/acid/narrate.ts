/**
 * Acid-mode "stream of consciousness" copy (FUG-106) — the plain-language
 * translations the hands-free agent narrates while it works. Kept pure + DOM-free
 * so the phrasing is unit-testable and the screen just renders the strings.
 *
 * The agent drives the SAME tool-use loop as the effect editor (set_script /
 * capture_preview / list_midi_controls / set_midi_mapping / estimate_performance),
 * but a zonked user shouldn't see raw tool names — so each maps to something a
 * human can follow at a glance.
 */

/** Friendly, present-tense narration for a tool the agent is about to run. */
export function narrateTool(name: string): string {
  switch (name) {
    case "set_script":
      return "✍️ Writing you an effect…";
    case "capture_preview":
      return "👀 Taking a look at how it's landing…";
    case "estimate_performance":
      return "⏱️ Making sure it'll run buttery-smooth…";
    case "list_midi_controls":
      return "🎛️ Seeing what knobs you've got…";
    case "set_midi_mapping":
      return "🎛️ Wiring your knobs to the effect…";
    default:
      return "🌀 Working on it…";
  }
}

/**
 * Humorous confirmation prompts for shake-to-enter. A shake is a low-intent
 * gesture, so we always confirm — and keep it light, matching the "too zonked
 * for the UI" vibe of the feature. Deterministic index so it's testable; the
 * screen picks one at random.
 */
export const SHAKE_CONFIRM_LINES: readonly string[] = [
  "Whoa. That was a lot of shaking. Drop into Acid Mode and just… talk to your lights?",
  "Detecting Big Shake Energy. Enter Acid Mode and let the robot drive?",
  "You rattled the phone like a maraca. Want to hand the wheel to the lighting agent?",
  "That's a full-body 'I can't UI right now'. Slide into Acid Mode?",
  "Shake received. Ready to melt into Acid Mode and just vibe?",
];

/** Pick a confirmation line by index (wraps). Pure, so tests stay deterministic. */
export function shakeConfirmLine(index: number): string {
  const n = SHAKE_CONFIRM_LINES.length;
  const i = ((Math.trunc(index) % n) + n) % n;
  return SHAKE_CONFIRM_LINES[i]!;
}
