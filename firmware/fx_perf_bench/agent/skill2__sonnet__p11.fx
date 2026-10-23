// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p11 status=ok calls=1
// request: police lights spinning red/blue
// Police lights: red and blue spinning beams 180° apart on a cylinder.
// Fixed-point angular maths keeps this well under the 33 ms frame budget.
uniform float speed    : 0.0 .. 8.0 = 4.0;        // rotations per second
uniform float width    : 0.02 .. 0.4 = 0.09;       // beam half-width in turns
uniform float strobe   : 0.0 .. 1.0 = 0.0;         // 0 = smooth spin, 1 = full strobe
uniform float str_rate : 2.0 .. 20.0 = 8.0;        // strobe Hz
uniform vec3  col_red  : color = 1.0, 0.04, 0.02;
uniform vec3  col_blue : color = 0.04, 0.12, 1.0;
uniform float bright   : 0.0 .. 1.0 = 1.0;

state fixed ph;       // rotation phase 0..1 turns
state fixed inv_w;    // reciprocal of beam half-width, precomputed each frame
state float strb;     // strobe multiplier 0..1

void update() {
  ph = fract(ph + fixed(dt * speed));
  // divide once per frame in float, convert to fixed — avoids per-LED division
  inv_w = fixed(1.0 / max(width, 0.02));
  // square-wave strobe: on for first half of each period, off for second
  float on = 1.0 - step(0.5, fract(time * str_rate));
  strb = mix(1.0, on, strobe);
}

vec3 shade(Led led) {
  // Angle around vertical axis in turns (0..1); compiler caches this per LED.
  fixed ang = atan2(fixed(led.pos.x), fixed(led.pos.z)) + fixed(0.5);

  // Angular distance to red beam (at ph) and blue beam (at ph + 0.5 turns).
  // fract(x + 0.5) - 0.5 wraps any angle difference into −0.5..0.5.
  fixed da = abs(fract(ang - ph + fixed(0.5)) - fixed(0.5));   // red
  fixed db = abs(fract(ang - ph)              - fixed(0.5));   // blue, 180° away

  // Linear falloff inside beam width, then squared for a sharper hot spot.
  fixed ra = clamp(fixed(1.0) - da * inv_w, fixed(0.0), fixed(1.0));
  fixed rb = clamp(fixed(1.0) - db * inv_w, fixed(0.0), fixed(1.0));
  ra = ra * ra;
  rb = rb * rb;

  return (col_red * float(ra) + col_blue * float(rb)) * bright * strb;
}
