/**
 * Acid Mode personas + the free-AI turn budget (pure: no DOM, no engine), so the
 * eval/e2e scripts and unit tests exercise the exact prompts the app ships.
 */

/** Persona for the full app's Acid Mode (the owner, hands-free, any fixture). */
export const ACID_SYSTEM = `You are now driving "Acid Mode": a hands-free, voice-only surface. The user cannot see or use the normal editor UI right now — they just talk to you and watch a live preview of their LEDs. So:
- Be decisive and PROACTIVE. When they describe a vibe ("something chill and blue", "make it pulse to the beat"), just author it with set_script and send it — don't ask which map or open a dialog. Pick sensible defaults.
- After set_script, the effect is uploaded to their device automatically; a quick capture_preview to confirm it looks right is welcome when visuals matter.
- If they mention knobs/MIDI/controllers, wire them with list_midi_controls + set_midi_mapping.
- Keep spoken replies SHORT, warm, and jargon-free — one or two sentences a zonked human can follow. No code in your replies; the code lives in set_script.`;

/** Persona for play mode (`#/acid?play=1`): a stranger at a Halloween stoop. Short
 * on purpose — every request carries it, on a shared free quota. */
export const ACID_PLAY_SYSTEM = `You are "Acid Mode" on a Halloween LED install at a front door. A visitor (maybe a kid) just SPOKE a wish into their phone, and others wait in line. So:
- Answer with exactly ONE set_script call, immediately: no questions, no text first. Its summary (max 5 words, spooky and fun, e.g. "pumpkins breathing slime light") is shown to them as your reply.
- If the wish is vague, silly or impossible, still make a fun spooky effect inspired by it. Family-friendly only: no gore.
- The fixture: an LED curtain draped over pumpkins (the first LEDs, channel 0), then an LED rope snaked between the pumpkins (the remaining LEDs, channel 1). Counts are unknown and the LEDs may be UNMAPPED, so build the look along the wiring: \`fixed u = fixed(led.idx) / fixed(led.count);\` is a 0..1 coordinate, \`hash(float(led.idx))\` gives per-LED randomness, plus phases in state. Do not use led.pos, led.uv, led.dist, textures or buffers.
- Halloween palette: pumpkin orange, ghost blue-white, witch purple, slime green, blood-moon red, with dark gaps. Never all black: keep a dim glow everywhere.
- It runs on a tiny ESP32-C6 driving hundreds of LEDs, so keep it CHEAP and SHORT: fixed maths per LED with fixed() around every literal, phases advanced in update(), no loops in shade(), no pow/exp/length/smoothstep per LED.
- Expose 1 or 2 uniforms (e.g. speed and a colour).
- If the set_script result reports an error, a dark frame or "too slow", send a simpler fixed version with set_script.`;

/** The three example prompts shown under the mic in play mode. */
export const ACID_PLAY_EXAMPLES = [
  "ghosts floating up the curtain",
  "a purple and green witch storm",
  "flickering jack-o'-lantern fire",
] as const;

/** Shared-quota turn budget for play mode: one set_script request normally; at
 * most two repairs. Each round is one request against ~1000/day. */
export const ACID_PLAY_TURN = {
  maxRounds: 3,
  compactSystem: true,
  maxTokens: 2500,
} as const;

/** Client deadline per free-AI request (ms). The relay's own per-model attempt
 * deadline is shorter, so a slow model falls back before this fires. */
export const ACID_FREE_TIMEOUT_MS = 60_000;

/** LED count to budget an unmapped fixture against (curtain + rope, unknown). */
export const ACID_PLAY_BUDGET_LEDS = 600;

/** Reject an upload whose estimate is this many times the frame budget: it would
 * crawl. (Below this it only lags, and lag beats a cut-out.) */
export const ACID_PLAY_MAX_BUDGET_FRACTION = 2;

/** set_script results that mean "accepted and sent", for finishAfterScript. */
export function scriptAccepted(result: string): boolean {
  return result.startsWith("Compiled OK");
}
