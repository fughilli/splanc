// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p09 status=ok calls=1
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm amber glow climbs from the bottom of the helix lamp.
// The band starts below the fixture and rises; below it glows ember-red,
// at it burns orange-gold, above it the night sky stays cool blue.
// sun_pos drives manual or sequenced control (ramp 0 → 1.5 for a full
// sunrise); speed auto-advances it so the effect plays standalone.

uniform float speed      : 0.0 .. 0.5 = 0.05;   // auto-rise; full height ~20 s at 0.05
uniform float sun_pos    : 0.0 .. 2.0 = 0.0;    // manual band position (0 = below lamp)
uniform float glow_width : 0.1 .. 0.8 = 0.38;   // vertical reach of the warm halo
uniform float brightness : 0.2 .. 1.0 = 1.0;
uniform vec3  sky_color  : color = 0.01, 0.01, 0.07;  // pre-dawn sky

state float sun;
state float inv_gw;
state float t;

void update() {
  t      = min(t + dt * speed, 2.0);
  sun    = sun_pos + t;
  inv_gw = 1.0 / max(glow_width, 0.01);
}

vec3 shade(Led led) {
  float h = led.uv.y;       // 0 = lowest LED, 1 = highest
  float d = h - sun;        // positive above band, negative below

  // Glow intensity: peaks at the band, quadratic falloff both ways
  float g = clamp(1.0 - abs(d) * inv_gw, 0.0, 1.0);
  g = g * g;

  // How much the column below this LED has been warmed by the rising sun
  float lit = clamp(1.0 - d * inv_gw, 0.0, 1.0);
  lit = lit * lit;

  // Colour palette (linear sRGB)
  vec3 night  = sky_color;                    // dark pre-dawn blue
  vec3 ember  = vec3(0.48, 0.06, 0.0);        // deep red-ember below band
  vec3 orange = vec3(1.0,  0.38, 0.01);       // hot orange at the band
  vec3 pale   = vec3(1.0,  0.88, 0.52);       // warm gold just above

  // Base: sky warms ember-red below the advancing band
  vec3 base = mix(night, ember, lit);

  // Bright band: orange at centre, paling to gold above
  float above_frac = clamp(d * inv_gw * 2.0, 0.0, 1.0);
  vec3  band = mix(orange, pale, above_frac * 0.7);

  return mix(base, band, g) * brightness;
}
