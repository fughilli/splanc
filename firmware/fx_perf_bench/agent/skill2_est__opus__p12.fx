// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p12 status=ok calls=0 within_budget
// request: a breathing meditation glow
// Breathing meditation glow: a soft warm light that slowly fills the lamp
// from the bottom on the in-breath, rests at the top during the hold, then
// sinks and dims on the out-breath. Use it as a breathing guide: the default
// is one breath every 8 s, with short pauses after each in- and out-breath.
// Fixed point per LED: one subtract, a few multiplies, a clamp and an integer
// hsv2rgb.

uniform float period   : 3.0 .. 16.0 = 8.0;   // seconds per full breath
uniform float hold     : 0.0 .. 0.4 = 0.2;    // share of the breath spent pausing
uniform float depth    : 0.0 .. 1.0 = 0.75;   // how much it dims on the out-breath
uniform float rise     : 0.0 .. 1.0 = 0.8;    // 0 = whole lamp pulses, 1 = light fills upward
uniform float softness : 0.0 .. 1.0 = 0.5;    // blur of the rising edge
uniform float hue      : 0.0 .. 1.0 = 0.07;   // warm amber by default
uniform float hue_drift: 0.0 .. 0.3 = 0.05;   // hue change from bottom to top
uniform float sat      : 0.0 .. 1.0 = 0.75;
uniform float glow     : 0.1 .. 1.0 = 0.85;   // peak brightness

state float ph;        // breath phase 0..1
state fixed y0;        // lowest LED height
state fixed invh;      // 1 / lamp height
state fixed lvl;       // current fill level (0..1 of height, extended past the ends)
state fixed edge;      // edge sharpness
state fixed vbase;     // brightness floor (rest of lamp)
state fixed vamp;      // brightness added where filled
state fixed hu;
state fixed hs;
state fixed sa;

void update() {
  ph = fract(ph + dt / max(period, 0.5));

  // Breath curve: inhale, hold, exhale, hold. Smoothstep-shaped ramps.
  float hh = hold * 0.5;
  float ramp = max((1.0 - 2.0 * hh) * 0.5, 0.01);
  float b = 0.0;
  if (ph < ramp) {
    float x = ph / ramp;
    b = x * x * (3.0 - 2.0 * x);
  } else {
    if (ph < ramp + hh) {
      b = 1.0;
    } else {
      if (ph < 2.0 * ramp + hh) {
        float x2 = (ph - ramp - hh) / ramp;
        b = 1.0 - x2 * x2 * (3.0 - 2.0 * x2);
      } else {
        b = 0.0;
      }
    }
  }

  // Lamp height from the room-frame box.
  float ymin = room.min.y;
  float ymax = room.max.y;
  y0 = fixed(ymin);
  invh = fixed(1.0 / max(ymax - ymin, 0.01));

  // Edge width 0.08..0.6 of the height; level travels from below the bottom
  // to above the top so the ends get fully dark / fully lit.
  float w = 0.08 + 0.52 * softness;
  edge = fixed(1.0 / w);
  lvl = fixed(-w * 0.5 + b * (1.0 + w));

  // Brightness: a floor that itself breathes, plus the rising fill.
  float floorv = glow * (1.0 - depth) + glow * depth * b * (1.0 - rise);
  vbase = fixed(floorv);
  vamp = fixed(max(glow - floorv, 0.0) * rise);

  hu = fixed(hue);
  hs = fixed(hue_drift);
  sa = fixed(sat);
}

vec3 shade(Led led) {
  fixed h = (fixed(led.room.y) - y0) * invh;
  fixed f = clamp((lvl - h) * edge + fixed(0.5), fixed(0.0), fixed(1.0));
  fixed v = vbase + f * vamp;
  return hsv2rgb(fract(hu + h * hs), sa, v);
}
