// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p04 status=ok calls=2
// request: a slow rainbow rotating around the lamp (cylindrical)
uniform float speed : 0.0 .. 2.0 = 0.15;
uniform float bands : 1.0 .. 4.0 = 1.0;
uniform float twist : 0.0 .. 4.0 = 2.0;
uniform float sat : 0.0 .. 1.0 = 0.9;
uniform float bright : 0.0 .. 1.0 = 1.0;

state fixed ph;
state fixed k;
state fixed tw;
state fixed s;
state fixed v;

void update() {
  ph = fract(ph + fixed(dt * speed * 0.25));
  k = fixed(bands);
  tw = fixed(twist - 2.0);
  s = fixed(sat);
  v = fixed(bright);
}

vec3 shade(Led led) {
  // angle around the vertical axis in TURNS (-0.5..0.5); cached once per LED
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  fixed y = fixed(led.uv.y);
  fixed h = fract(ang * k + y * tw + ph);
  return hsv2rgb(h, s, v);
}
