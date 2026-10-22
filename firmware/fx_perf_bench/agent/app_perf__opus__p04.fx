// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p04 status=ok calls=2
// request: a slow rainbow rotating around the lamp (cylindrical)
uniform float speed : 0.0 .. 1.0 = 0.08;
uniform bool reverse = false;
uniform float twist : 0.0 .. 2.0 = 0.0;
uniform float bands : 1.0 .. 4.0 = 1.0;
uniform float saturation : 0.0 .. 1.0 = 1.0;
uniform float brightness : 0.0 .. 1.0 = 0.8;

state fixed ph;
state fixed kBands;
state fixed kTwist;
state fixed off;
state fixed amp;
state bool started;
state bool ready;

buffer float ang : fixed16;

void update() {
  ready = started;
  started = true;
  float dir = 1.0;
  if (reverse) { dir = -1.0; }
  ph = fract(ph + fixed(dt * speed * dir));
  kBands = fixed(floor(bands + 0.5));
  kTwist = fixed(twist / 0.30);
  off = fixed(brightness * (1.0 - 0.5 * saturation));
  amp = fixed(0.5 * saturation * brightness);
}

vec3 shade(Led led) {
  if (!ready) {
    ang[led.idx] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
  }
  fixed h = fixed(ang[led.idx]) * kBands + fixed(led.pos.y) * kTwist + ph;
  fixed r = off + amp * cos(h);
  fixed g = off + amp * cos(h - fixed(0.33333));
  fixed b = off + amp * cos(h - fixed(0.66667));
  return vec3(r, g, b);
}
