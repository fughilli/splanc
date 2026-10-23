// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p11 status=ok calls=1
// request: police lights spinning red/blue
// Police lights: a red and a blue beacon beam sweep around the cylinder's
// axis, like a rotating light bar. In "strobe" mode the two sides
// double-flash alternately instead (red on one half, blue on the other).
uniform int   mode    : {"spin", "strobe"} = 0;
uniform float speed   : 0.1 .. 4.0 = 1.2;     // turns per second (spin) / cycles per second (strobe)
uniform float width   : 0.05 .. 0.5 = 0.18;   // beam width, fraction of a turn
uniform float glow    : 0.0 .. 0.3 = 0.04;    // dim ambient tint between beams
uniform vec3  red     : color = 1.0, 0.0, 0.0;
uniform vec3  blue    : color = 0.0, 0.1, 1.0;
uniform float tilt    : 0.0 .. 2.0 = 0.0;     // twists beams up the helix (turns over height)

state float phase;
state float red_on;
state float blue_on;
state float cx;
state float cz;
state float inv_w;

void update() {
  phase = fract(phase + dt * speed);
  cx = (room.min.x + room.max.x) * 0.5;
  cz = (room.min.z + room.max.z) * 0.5;
  inv_w = 1.0 / width;

  // Strobe: first half of the cycle red double-flashes, second half blue.
  float t = phase;
  float fr = fract(t * 4.0);
  red_on = 0.0;
  blue_on = 0.0;
  if (t < 0.5) {
    if (fr < 0.5) { red_on = 1.0; }
  } else {
    if (fr < 0.5) { blue_on = 1.0; }
  }
}

vec3 shade(Led led) {
  float dx = led.pos.x - cx;
  float dz = led.pos.z - cz;
  float a = atan2(dz, dx) * 0.15915494 + 0.5;   // 0..1 around the axis
  a = a + led.uv.y * tilt;

  if (mode == 1) {
    float side = fract(a);
    vec3 col = red * glow;
    if (side < 0.5) {
      col = col + red * red_on;
    } else {
      col = blue * glow + blue * blue_on;
    }
    return col;
  }

  float u = fract(a - phase);
  // Red beam centred at 0.25, blue beam at 0.75 (opposite sides).
  float dr = abs(u - 0.25);
  float db = abs(u - 0.75);
  float lr = clamp(1.0 - dr * inv_w, 0.0, 1.0);
  float lb = clamp(1.0 - db * inv_w, 0.0, 1.0);
  lr = lr * lr;
  lb = lb * lb;

  // Ambient: whichever half we're in carries a faint tint of its colour.
  vec3 amb = blue * glow;
  if (u < 0.5) { amb = red * glow; }

  return clamp(amb + red * lr + blue * lb, 0.0, 1.0);
}
