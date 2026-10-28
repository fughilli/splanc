// fx_agent_eval: variant=skill2_est model=claude-sonnet-4-6 prompt=p09 status=ok calls=1 revised
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm amber glow climbs from the bottom of the helix lamp.
// The band starts below the fixture and rises; below it glows ember-red,
// at it burns orange-gold, above it the night sky stays cool blue.
// sun_pos drives manual or sequenced control (ramp 0 → 1.5 for a full
// sunrise); speed auto-advances it so the effect plays standalone.
//
// Optimised: all per-LED scalar maths in fixed (Q16.16, ~110 cycles/op);
// only three vec3 mix calls remain as float, which the original already paid.

uniform float speed      : 0.0 .. 0.5 = 0.05;   // auto-rise; full height ~20 s at 0.05
uniform float sun_pos    : 0.0 .. 2.0 = 0.0;    // manual band position (0 = below lamp)
uniform float glow_width : 0.1 .. 0.8 = 0.38;   // vertical reach of the warm halo
uniform float brightness : 0.2 .. 1.0 = 1.0;
uniform vec3  sky_color  : color = 0.01, 0.01, 0.07;  // pre-dawn sky

state float t;
state fixed sun_fx;   // band centre in fixed, ready for shade()
state fixed inv_gw;   // 1/glow_width in fixed
state float br;       // hoisted brightness scalar

void update() {
  t      = min(t + dt * speed, 2.0);
  sun_fx = fixed(sun_pos + t);
  inv_gw = fixed(1.0 / max(glow_width, 0.01));
  br     = brightness;
}

vec3 shade(Led led) {
  // All scalar work in fixed — no per-LED float arithmetic.
  fixed h = fixed(led.uv.y);   // 0 = lowest LED, 1 = highest
  fixed d = h - sun_fx;        // positive above band, negative below

  // Glow intensity: quadratic peak at the band, zero outside glow_width.
  fixed g = clamp(fixed(1.0) - abs(d) * inv_gw, fixed(0.0), fixed(1.0));
  g = g * g;

  // Warmth: how much the LED below the band has been lit by the rising sun.
  fixed lit = clamp(fixed(1.0) - d * inv_gw, fixed(0.0), fixed(1.0));
  lit = lit * lit;

  // Band colour blend: orange at centre fading to pale gold above.
  fixed band_pale = clamp(d * inv_gw * fixed(2.0), fixed(0.0), fixed(1.0))
                    * fixed(0.7);

  // Colour palette (linear sRGB) — built once, mixed with scalar weights.
  vec3 night  = sky_color;
  vec3 ember  = vec3(0.48, 0.06, 0.0);
  vec3 orange = vec3(1.0,  0.38, 0.01);
  vec3 pale   = vec3(1.0,  0.88, 0.52);

  vec3 base = mix(night,  ember, float(lit));
  vec3 band = mix(orange, pale,  float(band_pale));

  return mix(base, band, float(g)) * br;
}
