// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p09 status=ok calls=2
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm glow climbs the lamp from the bottom, deep red at first,
// warming to gold as it rises. Per-LED maths is fixed point.

uniform float duration   : 5.0 .. 120.0 = 30.0;   // seconds for a full sunrise
uniform bool  loop_rise  = true;                  // restart when finished
uniform float softness   : 0.02 .. 0.6 = 0.25;    // width of the glowing edge
uniform float brightness : 0.1 .. 1.0 = 1.0;
uniform float warmth     : 0.0 .. 0.12 = 0.04;    // starting hue (0 = red)
uniform float gold       : 0.0 .. 0.15 = 0.09;    // extra hue gained as the sun rises
uniform float saturation : 0.3 .. 1.0 = 0.95;
uniform float shimmer    : 0.0 .. 0.3 = 0.08;     // gentle flicker around the cylinder
uniform float base_y     : 0.0 .. 0.6 = 0.3;      // y of the lamp's bottom (m) + 0.3 (0.3 = y 0)
uniform float height     : 0.1 .. 0.6 = 0.30;     // lamp height (m)

state float prog;
state fixed lvl;
state fixed kEdge;
state fixed hBase;
state fixed hSpan;
state fixed sat;
state fixed bri;
state fixed shim;
state fixed ph;
state fixed y0;
state fixed invH;

void update() {
  prog = prog + dt / duration;
  if (prog > 1.0) {
    if (loop_rise) { prog = 0.0; } else { prog = 1.0; }
  }
  // ease-out so the light climbs quickly at first, then lingers
  float p = 1.0 - (1.0 - prog) * (1.0 - prog);

  // horizon level runs from just below the bottom to past the top
  lvl   = fixed(p * (1.0 + softness) - softness * 0.5);
  kEdge = fixed(1.0 / softness);
  hBase = fixed(warmth + gold * p * 0.6);
  hSpan = fixed(gold * 0.4);
  sat   = fixed(saturation - 0.15 * p);
  bri   = fixed(brightness * (0.35 + 0.65 * p));
  shim  = fixed(shimmer);
  ph    = fract(ph + fixed(dt * 0.15));
  y0    = fixed(base_y - 0.3);
  invH  = fixed(1.0 / height);
}

vec3 shade(Led led) {
  // normalized height 0 (bottom) .. 1 (top)
  fixed h = clamp((fixed(led.pos.y) - y0) * invH, fixed(0.0), fixed(1.0));
  // angle around the axis, cached per LED (turns)
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));

  // glow: full below the horizon, fading over `softness` above it
  fixed g = clamp((lvl - h) * kEdge + fixed(1.0), fixed(0.0), fixed(1.0));
  fixed v = g * g;

  // slow shimmer, strongest near the glowing edge
  fixed edge = g * (fixed(1.0) - g) * fixed(4.0);
  fixed w = sin(ang * fixed(3.0) + ph + h * fixed(2.0)) * shim;
  v = clamp(v + w * edge, fixed(0.0), fixed(1.0)) * bri;

  // hue: redder at the bottom, more golden near the climbing edge
  fixed hue = hBase + h * hSpan;
  fixed s = clamp(sat + (fixed(1.0) - g) * fixed(0.05), fixed(0.0), fixed(1.0));

  return hsv2rgb(hue, s, v);
}
