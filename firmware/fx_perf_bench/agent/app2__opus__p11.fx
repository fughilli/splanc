// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p11 status=ok calls=1
// request: police lights spinning red/blue
// Police beacon: a red and a blue beam rotate around the cylinder on opposite sides.
// An optional strobe overlays the classic alternating double-blink.
uniform float speed      : 0.0 .. 4.0 = 1.5;     // rotations per second
uniform float width      : 0.05 .. 0.45 = 0.2;   // beam half-width in turns
uniform float strobe     : 0.0 .. 1.0 = 0.0;     // 0 = pure spin, 1 = full strobe
uniform float flash_rate : 0.2 .. 4.0 = 1.5;     // strobe cycles per second
uniform float brightness : 0.0 .. 1.0 = 1.0;
uniform vec3 red  : color = 1.0, 0.0, 0.0;
uniform vec3 blue : color = 0.0, 0.1, 1.0;

state fixed ph;
state fixed inv;
state fixed rr;
state fixed rg;
state fixed rb;
state fixed br;
state fixed bg;
state fixed bb;

void update() {
  ph = fract(ph + fixed(dt * speed));
  inv = fixed(1.0 / width);

  // Strobe pattern: red double-blinks in the first half of the cycle, blue in the second.
  float sp = fract(time * flash_rate);
  float blink = 0.0;
  if (fract(sp * 4.0) < 0.5) { blink = 1.0; }
  float rOn = 0.0;
  float bOn = 0.0;
  if (sp < 0.5) { rOn = blink; } else { bOn = blink; }
  float gr = mix(1.0, rOn, strobe) * brightness;
  float gb = mix(1.0, bOn, strobe) * brightness;

  rr = fixed(red.x * gr);
  rg = fixed(red.y * gr);
  rb = fixed(red.z * gr);
  br = fixed(blue.x * gb);
  bg = fixed(blue.y * gb);
  bb = fixed(blue.z * gb);
}

vec3 shade(Led led) {
  // Angle around the vertical axis in TURNS; it depends only on led.*, so it is cached per LED.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));
  // Angular distance from the red beam, 0..0.5 turns; the blue beam sits opposite (0.5 - d).
  fixed d = abs(fract(ang - ph + fixed(0.5)) - fixed(0.5));
  fixed a = clamp(fixed(1.0) - d * inv, fixed(0.0), fixed(1.0));
  fixed b = clamp(fixed(1.0) - (fixed(0.5) - d) * inv, fixed(0.0), fixed(1.0));
  a = a * a;
  b = b * b;
  return vec3(float(a * rr + b * br), float(a * rg + b * bg), float(a * rb + b * bb));
}
