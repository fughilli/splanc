// fx_agent_eval: variant=app model=claude-opus-5-5 prompt=p03 status=ok calls=1
// request: aurora curtains drifting slowly
// Aurora curtains: soft green/violet curtains drifting slowly around the cylinder.
uniform float speed : 0.0 .. 1.0 = 0.15;
uniform float folds : 1.0 .. 6.0 = 3.0;
uniform float streaks : 0.0 .. 1.0 = 0.4;
uniform float brightness : 0.0 .. 1.0 = 0.8;
uniform float lampHeight : 0.1 .. 1.0 = 0.30;
uniform vec3 lowColor : color = 0.1, 1.0, 0.35;
uniform vec3 highColor : color = 0.55, 0.15, 1.0;

// cached per-LED geometry: x = angle in turns (0..1), y = normalized height (0..1)
buffer vec2 geo : fixed16;

state fixed p1;
state fixed p2;
state fixed p3;
state fixed p4;
state fixed fo;
state fixed streakAmt;
state fixed streakBase;

void update() {
  float t = time * speed;
  p1 = fixed(fract(t * 0.13));
  p2 = fixed(fract(t * 0.29 + 0.37));
  p3 = fixed(fract(t * 0.71 + 0.11));
  p4 = fixed(fract(t * 0.07 + 0.63));
  fo = fixed(floor(folds + 0.5));
  streakAmt = fixed(streaks);
  streakBase = fixed(1.0 - streaks);
}

vec3 shade(Led led) {
  int i = led.idx;
  if (frame < 3) {
    float ang = atan2(led.pos.z, led.pos.x) * 0.15915494 + 0.5;
    float hy = clamp(led.pos.y / lampHeight, 0.0, 1.0);
    geo[i] = vec2(ang, hy);
  }
  vec2 g = geo[i];
  fixed a = fixed(g.x);
  fixed h = fixed(g.y);

  // folded curtain intensity around the circumference (sin in turns)
  fixed warp = sin(a * fixed(2.0) + p2) * fixed(0.15);
  fixed w = sin(a * fo + p1 + warp);
  fixed c = clamp(w * fixed(0.5) + fixed(0.5), fixed(0.0), fixed(1.0));
  c = c * c;

  // fine vertical rays
  fixed s = sin(a * fixed(17.0) + p3 + warp * fixed(2.0)) * fixed(0.5) + fixed(0.5);
  c = c * (streakBase + streakAmt * s);

  // wavy lower hem, glow fading upward
  fixed edge = fixed(0.15) + fixed(0.08) * sin(a * fixed(3.0) + p4);
  fixed d = h - edge;
  fixed rise = clamp(d * fixed(12.0), fixed(0.0), fixed(1.0));
  fixed fall = clamp(fixed(1.0) - d * fixed(1.3), fixed(0.0), fixed(1.0));
  fixed v = rise * fall * fall * c;

  fixed tcol = clamp(d * fixed(1.6), fixed(0.0), fixed(1.0));
  vec3 col = mix(lowColor, highColor, float(tcol));
  return col * (float(v) * brightness);
}
