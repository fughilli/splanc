// fx_agent_eval: variant=app2_est model=claude-opus-5-5 prompt=p12 status=ok calls=0 within_budget
// request: a breathing meditation glow
// Breathing meditation glow for a helical cylinder lamp.
// A slow breath cycle (inhale/exhale with adjustable ratio) swells a soft
// light up the lamp. Brightness and fill height follow the breath. Hue
// drifts gently with height. Per-LED maths is all fixed point.

uniform float breaths_per_min : 2.0 .. 12.0 = 5.0;
uniform float inhale_ratio    : 0.3 .. 0.7  = 0.42;
uniform float hue             : 0.0 .. 1.0  = 0.55;
uniform float hue_spread      : 0.0 .. 0.3  = 0.08;
uniform float saturation      : 0.0 .. 1.0  = 0.65;
uniform float brightness      : 0.1 .. 1.0  = 0.85;
uniform float rest_glow       : 0.0 .. 0.3  = 0.04;
uniform float rise            : 0.0 .. 1.0  = 0.8;
uniform float softness        : 0.05 .. 0.6 = 0.25;
uniform float shimmer         : 0.0 .. 0.15 = 0.04;

state float cyc;
state fixed lvl;
state fixed vmin;
state fixed vamp;
state fixed hue0;
state fixed hsp;
state fixed sat;
state fixed edge;
state fixed ph;
state fixed shim;

void update() {
  cyc = fract(cyc + dt * breaths_per_min / 60.0);

  // eased inhale then exhale (cosine ramps)
  float b = 0.0;
  if (cyc < inhale_ratio) {
    b = 0.5 - 0.5 * cos(3.14159265 * (cyc / inhale_ratio));
  } else {
    b = 0.5 + 0.5 * cos(3.14159265 * ((cyc - inhale_ratio) / (1.0 - inhale_ratio)));
  }
  float bp = b * b * (3.0 - 2.0 * b);   // extra-soft ends

  // fill level: rise=0 lights whole lamp, rise=1 the glow climbs with the breath
  float top = mix(1.0 + softness, bp * (1.0 + 2.0 * softness) - softness, rise);
  lvl  = fixed(top);
  edge = fixed(1.0 / softness);

  // perceptual brightness: square the breath for linear RGB
  vmin = fixed(rest_glow);
  vamp = fixed((brightness - rest_glow) * bp * bp);

  hue0 = fixed(hue);
  hsp  = fixed(hue_spread);
  sat  = fixed(saturation);
  ph   = fract(ph + fixed(dt * 0.07));
  shim = fixed(shimmer);
}

vec3 shade(Led led) {
  // normalised height 0..1 on the 0.30 m tall lamp
  fixed y = clamp(fixed(led.pos.y) * fixed(3.3333), fixed(0.0), fixed(1.0));

  // soft-edged fill below the breath level
  fixed fill = clamp((lvl - y) * edge + fixed(0.5), fixed(0.0), fixed(1.0));

  // slow gentle shimmer travelling up the helix
  fixed w = sin(y * fixed(1.5) - ph) * shim;

  fixed v = vmin + vamp * (fixed(0.25) + fixed(0.75) * fill) + w * vamp;
  v = clamp(v, fixed(0.0), fixed(1.0));

  fixed h = fract(hue0 + (y - fixed(0.5)) * hsp + w);
  return hsv2rgb(h, sat, v);
}
