// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p12 status=ok calls=1
// request: a breathing meditation glow
// Breathing meditation glow.
// A slow inhale/exhale cycle shifts brightness AND hue — cool blue on inhale,
// soft violet on exhale — while the light subtly "rises" up the cylinder as
// you breathe in and "falls" as you breathe out.

uniform float rate    : 0.05 .. 0.40 = 0.12;   // breath cycles / sec  (~8 s per breath)
uniform float hue_in  : 0.00 .. 1.00 = 0.60;   // inhale hue  (0.60 = sky blue)
uniform float hue_out : 0.00 .. 1.00 = 0.88;   // exhale hue  (0.88 = soft violet)
uniform float sat     : 0.00 .. 1.00 = 0.65;   // colour saturation
uniform float bright  : 0.20 .. 1.00 = 0.85;   // peak brightness

state fixed breath;      // breath phase in TURNS, advanced each frame
state fixed glow;        // 0.1..0.9  — breath envelope
state fixed hue;         // blended hue for this frame
state fixed sat_f;       // fixed copy of sat uniform
state fixed bright_f;    // fixed copy of bright uniform

void update() {
  // Advance phase once per frame — integer fixed-point fract, no float in shade()
  breath   = fract(breath + fixed(dt * rate));

  // sin() of a fixed arg uses the integer LUT (turns, not radians)
  fixed sb = sin(breath);                       // −1 .. 1
  glow     = fixed(0.5) + sb * fixed(0.4);     //  0.1 .. 0.9  (never fully dark or fully blown)

  // Lerp hue: warm violet at exhale (glow≈0.1), cool blue at inhale (glow≈0.9)
  fixed hi = fixed(hue_in);
  fixed ho = fixed(hue_out);
  hue      = fract(ho + (hi - ho) * glow);

  sat_f    = fixed(sat);
  bright_f = fixed(bright);
}

vec3 shade(Led led) {
  // Normalise LED height: led.pos.y is 0..0.30 m, multiply by 1/0.30 ≈ 3.333
  fixed yn   = fixed(led.pos.y) * fixed(3.333);            // 0..1 up the cylinder

  // Height wave: top brightens during inhale, bottom brightens during exhale —
  // the breath visually "rises" and "falls" through the lamp.
  fixed wave = (yn - fixed(0.5)) * (glow - fixed(0.5)) * fixed(0.25);

  fixed v    = clamp(glow * bright_f + wave, fixed(0.0), fixed(1.0));

  // All three args are fixed → integer hsv2rgb path (~370 cycles, no soft-float)
  return hsv2rgb(hue, sat_f, v);
}
