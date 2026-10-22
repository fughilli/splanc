// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p15 status=ok calls=1
// request: water caustics shimmer
// Water caustics shimmer for a cylindrical helix lamp.
// Domain-warped interfering waves wrap seamlessly around the cylinder.
// Ridges form where the waves cancel. Per-LED math is all fixed-point;
// atan2 runs once per LED, ever.

uniform float speed : 0.0 .. 3.0 = 0.6;
uniform float scale : 0.5 .. 4.0 = 1.6;
uniform float warp : 0.0 .. 0.4 = 0.18;
uniform float brightness : 0.0 .. 1.0 = 0.9;
uniform vec3 deep : color = 0.0, 0.12, 0.3;
uniform vec3 light : color = 0.6, 0.95, 1.0;

state fixed ph1;
state fixed ph2;
state fixed ph3;
state fixed ph4;
state fixed sc;
state fixed wp;
state vec3 deepC;
state vec3 diffC;
state bool started;
state bool ready;

buffer float bu : fixed16;
buffer float bv : fixed16;

void update() {
  ready = started;
  started = true;
  float s = dt * speed;
  ph1 = fract(ph1 + fixed(s * 0.23));
  ph2 = fract(ph2 + fixed(s * 0.31));
  ph3 = fract(ph3 + fixed(s * 0.41));
  ph4 = fract(ph4 + fixed(s * 0.37));
  sc = fixed(scale);
  wp = fixed(warp);
  deepC = deep * brightness;
  diffC = (light - deep) * brightness;
}

vec3 shade(Led led) {
  int i = led.idx;
  if (!ready) {
    bu[i] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
    bv[i] = led.pos.y * 3.333;
  }
  fixed u = fixed(bu[i]);
  fixed v = fixed(bv[i]) * sc;

  // domain warp (integer multiples of u keep the wrap seamless)
  fixed wa = sin(v + u * fixed(2) + ph1) * wp;
  fixed wb = sin(v * fixed(1.3) - u * fixed(3) + ph2) * wp;

  // two interfering wave fields
  fixed l1 = sin(u * fixed(3) + v * fixed(1.7) + wa + ph3);
  fixed l2 = sin(v * fixed(2.3) - u * fixed(2) + wb + ph4);

  // bright thin ridges where the waves cancel
  fixed c = fixed(1) - abs(l1 + l2) * fixed(0.5);
  fixed c2 = c * c;
  fixed c4 = c2 * c2;
  fixed g = c4 * fixed(0.7) + c2 * fixed(0.3);

  return deepC + diffC * g;
}
