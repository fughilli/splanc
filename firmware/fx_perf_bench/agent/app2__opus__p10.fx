// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p10 status=ok calls=2
// request: matrix-style green rain falling down
// Matrix-style green rain falling down the cylinder.
// 16 angular columns, each with its own fall phase and speed.
uniform float speed   : 0.1 .. 3.0 = 1.0;
uniform float trail   : 0.05 .. 1.0 = 0.35;
uniform float hue     : 0.0 .. 1.0 = 0.33;
uniform float shimmer : 0.0 .. 1.0 = 0.45;
uniform float height  : 0.1 .. 1.0 = 0.30;
uniform float base    : 0.0 .. 1.0 = 0.5;

state fixed ph[16];
state fixed spd[16];
state bool inited;
state fixed invTrail;
state fixed invH;
state fixed y0;
state fixed hh;
state fixed shim;
state fixed gph;

void update() {
  if (!inited) {
    for (int i = 0; i < 16; i = i + 1) {
      ph[i]  = fixed(hash(float(i) * 1.7 + 0.3));
      spd[i] = fixed(0.35 + hash(float(i) * 5.3 + 2.0) * 0.65);
    }
    inited = true;
  }
  fixed step_ = fixed(dt * speed * 0.4);
  for (int i = 0; i < 16; i = i + 1) {
    ph[i] = fract(ph[i] + spd[i] * step_);
  }
  invTrail = fixed(1.0 / trail);
  invH = fixed(1.0 / height);
  y0 = fixed(base - 0.5);
  hh = fixed(hue);
  shim = fixed(shimmer);
  gph = fract(gph + fixed(dt * 3.1));
}

vec3 shade(Led led) {
  // angle around the vertical axis in turns, 0..1 (cached per LED)
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  int col = min(int(ang * fixed(16.0)), 15);
  fixed yn = (fixed(led.pos.y) - y0) * invH;

  // head falls from above the top (1.5) to below the bottom (-1.0)
  fixed head = fixed(1.5) - ph[col] * fixed(2.5);
  fixed d = yn - head;          // distance above the head = trail region
  fixed t = d * invTrail;
  if (d < fixed(0.0) || t > fixed(1.0)) {
    return vec3(0.0, 0.0, 0.0);
  }
  fixed v = fixed(1.0) - t;
  v = v * v;

  // glyph shimmer: per-cell flicker
  fixed cell = floor(yn * fixed(24.0));
  fixed fl = fixed(0.5) + fixed(0.5) * sin(cell * fixed(0.618) + fixed(col) * fixed(0.137) + gph);
  fixed g = fixed(1.0) - shim * fl;

  // white-hot head, saturated green tail
  fixed sat = clamp(d * fixed(20.0), fixed(0.15), fixed(0.95));
  return hsv2rgb(hh, sat, v * g);
}
