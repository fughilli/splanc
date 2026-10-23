// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p04 status=ok calls=1
// request: a slow rainbow rotating around the lamp (cylindrical)
// Rotating rainbow around a cylindrical lamp.
// Hue is driven by the angle around the Y axis (atan2 of fixed args → integer
// LUT, ~350 cycles) so the rainbow wraps cleanly around the helix. A small
// height component tilts the band into a diagonal stripe. All per-LED maths
// in fixed point; hsv2rgb on fixed args uses the integer path (~370 cycles).
// Estimated cost: ~1,400 cycles/LED → ~4.5 ms at 500 LEDs, well under 33 ms.

uniform float speed  : 0.0 .. 4.0 = 0.5;    // rotation speed (turns/s × 0.1)
uniform float tilt   : 0.0 .. 1.0 = 0.25;   // height contribution to hue (0 = flat ring, 1 = full diagonal stripe)
uniform float sat    : 0.0 .. 1.0 = 0.90;   // saturation
uniform float val    : 0.0 .. 1.0 = 1.00;   // brightness

state fixed ph;   // global hue offset in turns
state fixed t;    // tilt scale (fixed)
state fixed s;    // saturation (fixed)
state fixed v;    // value/brightness (fixed)

void update() {
  // Advance the phase: at speed=1 the rainbow completes one revolution in ~10 s.
  ph = fract(ph + fixed(dt * speed * 0.1));
  t  = fixed(tilt);
  s  = fixed(sat);
  v  = fixed(val);
}

vec3 shade(Led led) {
  // Angle around the vertical axis in turns (0..1).
  // atan2 of two fixed arguments uses the integer LUT (turns, not radians).
  // The compiler caches this per-LED-invariant expression automatically.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  // Mix in a fraction of height (led.uv.y 0..1) so the rainbow spirals
  // gently up the helix rather than stacking identical rings.
  fixed h = fract(ang + ph + fixed(led.uv.y) * t);

  return hsv2rgb(h, s, v);
}
