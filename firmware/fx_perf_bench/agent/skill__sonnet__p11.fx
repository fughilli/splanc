// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p11 status=ok calls=1
// request: police lights spinning red/blue
// Police siren: spinning red + blue beams (180° apart) with alternating strobe flash
uniform float spin_speed : 0.5 .. 10.0 = 4.0;   // rotations per second
uniform float flash_rate : 1.0 .. 20.0 = 7.0;   // strobe flashes per second per colour
uniform float beam_width : 0.05 .. 0.45 = 0.18; // beam angular half-width (fraction of circle)
uniform float glow       : 0.0 .. 0.3  = 0.04;  // ambient fill while that colour is flashing
uniform vec3  red_col    : color = 1.0, 0.0, 0.02;
uniform vec3  blue_col   : color = 0.0, 0.08, 1.0;

state float spin;
state float red_on;
state float blue_on;

void update() {
  spin = fract(time * spin_speed);

  // Alternate: red on for first 45 % of flash cycle, blue on for next 45 %
  float t = fract(time * flash_rate);
  red_on  = 1.0 - step(0.45, t);
  blue_on = step(0.5, t) * (1.0 - step(0.95, t));
}

vec3 shade(Led led) {
  // Azimuth around Y axis, 0..1
  float az = fract(atan2(led.pos.z, led.pos.x) / 6.28318 + 0.5);

  // Angular distance from each beam centre:
  //   red beam  at spin,        blue beam at spin + 0.5 (opposite)
  float dr = abs(fract(az - spin + 0.5) - 0.5);
  float db = abs(fract(az - spin      ) - 0.5);

  // Bright at centre (dr=0 → 1), fades to 0 at beam_width, plus constant glow fill
  float r_bright = smoothstep(beam_width, 0.0, dr) + glow;
  float b_bright = smoothstep(beam_width, 0.0, db) + glow;

  // Soft top/bottom edge vignette so helix ends don't clip hard
  float edge = smoothstep(0.0, 0.08, led.uv.y) * smoothstep(1.0, 0.92, led.uv.y);

  return (red_col * r_bright * red_on + blue_col * b_bright * blue_on) * edge;
}
