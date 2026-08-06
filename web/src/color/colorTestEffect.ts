/**
 * The "color test" effect (FUG-75): a two-tone linear gradient across a
 * configurable span of the strip, everything outside the span off. It exists to
 * eyeball color reproduction and voltage droop — set the two endpoint colors,
 * the span length (e.g. 10 vs 100 LEDs), and where on the strip it starts.
 *
 * The source is shared between the built-in effect seeding (so it shows up in
 * the Effects browser too) and the Color-correction screen's "Load color test"
 * button, so there's a single source of truth. Uniforms:
 *   colorA / colorB — gradient endpoints (color pickers)
 *   start           — index of the first lit LED
 *   span            — gradient length in LEDs (the rest stay off)
 */

export const COLOR_TEST_ID = "builtin-color-test";
export const COLOR_TEST_NAME = "Color test (gradient)";

export const COLOR_TEST_SOURCE = `// Two-tone linear gradient across a configurable span of the strip, everything
// outside the span off. Dial the span length (e.g. 10 vs 100 LEDs) and where it
// starts to eyeball color reproduction and voltage droop.
uniform vec3 colorA : color = 1.0, 0.0, 0.0;   // gradient start color
uniform vec3 colorB : color = 0.0, 0.0, 1.0;   // gradient end color
uniform float start : 0.0 .. 255.0 = 0.0;      // index of the first lit LED
uniform float span : 1.0 .. 256.0 = 10.0;      // gradient length in LEDs (rest off)

vec3 shade(Led led) {
  float t = clamp((led.idx - start) / max(span - 1.0, 1.0), 0.0, 1.0);
  float lit = step(start, led.idx) * step(led.idx, start + span - 1.0);
  return mix(colorA, colorB, t) * lit;
}
`;
