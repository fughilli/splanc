// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p03 status=ok calls=1
// request: aurora curtains drifting slowly
uniform float speed : 0.0 .. 2.0 = 0.4;
uniform float folds : 1.0 .. 8.0 = 3.0;
uniform float sway : 0.0 .. 0.5 = 0.18;
uniform float sharpness : 0.0 .. 1.0 = 0.6;
uniform float shimmer : 0.0 .. 1.0 = 0.35;
uniform float brightness : 0.0 .. 1.5 = 1.0;
uniform vec3 lowColor : color = 0.1, 1.0, 0.35;
uniform vec3 highColor : color = 0.55, 0.1, 0.9;

state fixed ph1;
state fixed ph2;
state fixed ph3;
state fixed ph4;
state fixed kFolds;
state fixed kSway;
state fixed kSharp;
state fixed kShim;
state fixed lr;
state fixed lg;
state fixed lb;
state fixed dr;
state fixed dg;
state fixed db;
state bool started;
state bool ready;

buffer float ang : fixed16;

void update() {
  ready = started;
  started = true;
  float s = dt * speed;
  ph1 = fract(ph1 + fixed(s * 0.07));
  ph2 = fract(ph2 + fixed(s * 0.11));
  ph3 = fract(ph3 + fixed(s * 0.04));
  ph4 = fract(ph4 + fixed(s * 0.6));
  kFolds = fixed(floor(folds + 0.5));
  kSway = fixed(sway);
  kSharp = fixed(sharpness);
  kShim = fixed(shimmer * 0.5);
  lr = fixed(lowColor.x * brightness);
  lg = fixed(lowColor.y * brightness);
  lb = fixed(lowColor.z * brightness);
  dr = fixed((highColor.x - lowColor.x) * brightness);
  dg = fixed((highColor.y - lowColor.y) * brightness);
  db = fixed((highColor.z - lowColor.z) * brightness);
}

vec3 shade(Led led) {
  if (!ready) { ang[led.idx] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5; }
  fixed a = fixed(ang[led.idx]);
  fixed h = fixed(led.s);

  // slow folding warp of the curtain
  fixed warp = sin(a * fixed(2) + ph1) * kSway + sin(h * fixed(1.5) + a + ph2) * (kSway * fixed(0.6));
  fixed c = sin(a * kFolds + warp + ph3);
  fixed c2 = c * c;
  fixed curtain = mix(c2, c2 * c2, kSharp);

  // vertical rays shimmering
  fixed ray = fixed(1) - kShim + kShim * sin(a * fixed(29) + warp * fixed(4) + ph4);

  // bright lower edge, fading toward the top
  fixed vert = clamp(h * fixed(4), fixed(0), fixed(1)) * clamp((fixed(1.1) - h), fixed(0), fixed(1));

  fixed v = curtain * ray * vert;
  return vec3((lr + dr * h) * v, (lg + dg * h) * v, (lb + db * h) * v);
}
