// fx_agent_eval: variant=skill2 model=claude-opus-5-5 prompt=p04 status=ok calls=1
// request: a slow rainbow rotating around the lamp (cylindrical)
// Slow rainbow rotating around the cylindrical lamp.
// Hue follows the LED's angle around the vertical (+Y) axis; the whole
// rainbow turns slowly. Fixed-point throughout: atan2 of fixed args returns
// turns and is cached per LED; the phase advances once per frame in update().
uniform float speed      : 0.0 .. 0.5 = 0.05;   // revolutions per second
uniform float bands      : 1.0 .. 4.0 = 1.0;    // rainbows around the lamp
uniform float twist      : 0.0 .. 2.0 = 1.0;    // 1 = straight; <1 / >1 twist the bands up the lamp
uniform float sat        : 0.0 .. 1.0 = 0.9;
uniform float brightness : 0.0 .. 1.0 = 1.0;
uniform bool  reverse    = false;
uniform float center_x   : 0.0 .. 0.4 = 0.2;    // axis X offset (0.2 = map origin)
uniform float center_z   : 0.0 .. 0.4 = 0.2;    // axis Z offset (0.2 = map origin)

state fixed ph;
state fixed k;
state fixed tw;
state fixed s;
state fixed v;
state fixed cx;
state fixed cz;

void update() {
  float d = dt * speed;
  if (reverse) {
    d = -d;
  }
  ph = fract(ph + fixed(d));
  k  = fixed(bands);
  tw = fixed(twist - 1.0);
  s  = fixed(sat);
  v  = fixed(brightness);
  cx = fixed(center_x - 0.2);
  cz = fixed(center_z - 0.2);
}

vec3 shade(Led led) {
  // Angle around the vertical axis in turns (-0.5..0.5), shifted to 0..1.
  fixed ang = atan2(fixed(led.pos.z) - cz, fixed(led.pos.x) - cx) + fixed(0.5);
  fixed h = fract(ang * k + fixed(led.uv.y) * tw + ph);
  return hsv2rgb(h, s, v);
}
