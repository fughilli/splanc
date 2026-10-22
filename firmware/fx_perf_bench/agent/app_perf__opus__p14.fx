// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p14 status=ok calls=1
// request: a scanner beam sweeping left to right
uniform float speed : 0.05 .. 3.0 = 0.5;
uniform float width : 0.01 .. 0.3 = 0.06;
uniform float trail : 0.0 .. 1.0 = 0.35;
uniform float trail_level : 0.0 .. 1.0 = 0.4;
uniform vec3 tint : color = 1.0, 0.05, 0.02;
uniform bool bounce = false;

state float ph;
state fixed pos;
state fixed dir;
state fixed invW;
state fixed invT;
state vec3 coreCol;
state vec3 trailCol;

void update() {
  ph = fract(ph + dt * speed * 0.5);
  float w = width + trail;
  float p = ph;
  float d = 1.0;
  if (bounce) {
    p = 1.0 - abs(2.0 * ph - 1.0);
    if (ph >= 0.5) { d = -1.0; }
  }
  // travel slightly past both edges so the beam fully exits
  pos = fixed(p * (1.0 + 2.0 * w) - w);
  dir = fixed(d);
  invW = fixed(1.0 / width);
  invT = fixed(1.0 / max(trail, 0.01));
  // hot core: tint pushed toward white
  coreCol = mix(tint, vec3(1.0, 1.0, 1.0), 0.35);
  trailCol = tint * (trail_level * step(0.001, trail));
}

vec3 shade(Led led) {
  fixed delta = (pos - fixed(led.uv.x)) * dir;
  fixed c = clamp(fixed(1.0) - abs(delta) * invW, fixed(0.0), fixed(1.0));
  c = c * c;
  fixed t = clamp(fixed(1.0) - delta * invT, fixed(0.0), fixed(1.0)) * step(fixed(0.0), delta);
  t = t * t;
  return coreCol * c + trailCol * t;
}
