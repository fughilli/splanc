// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p03 status=ok calls=1
// request: aurora curtains drifting slowly
uniform float speed      : 0.0 .. 2.0 = 0.35;
uniform float folds      : 2.0 .. 9.0 = 4.0;
uniform float sharpness  : 1.0 .. 3.0 = 2.0;
uniform float brightness : 0.0 .. 1.0 = 0.9;
uniform float hue_low    : 0.0 .. 1.0 = 0.36;
uniform float hue_high   : 0.0 .. 1.0 = 0.82;

state fixed ph1;
state fixed ph2;
state fixed ph3;
state fixed ph4;
state fixed k1;
state fixed k2;
state fixed k3;
state fixed sharpK;
state fixed bri;
state fixed hLo;
state fixed hSpan;

void update() {
  // slow phases in TURNS
  ph1 = fract(ph1 + fixed(dt * speed * 0.050));
  ph2 = fract(ph2 + fixed(dt * speed * 0.031));
  ph3 = fract(ph3 + fixed(dt * speed * 0.023));
  ph4 = fract(ph4 + fixed(dt * speed * 0.400));
  // integer fold counts so the curtain wraps seamlessly around the cylinder
  k1 = fixed(floor(folds));
  k2 = fixed(floor(folds * 0.5) + 1.0);
  k3 = fixed(floor(folds) + 1.0);
  sharpK = fixed(sharpness);
  bri = fixed(brightness);
  hLo = fixed(hue_low);
  hSpan = fixed(hue_high - hue_low);
}

vec3 shade(Led led) {
  // angle around the vertical axis in turns (cached per LED by the compiler)
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));
  // normalised height 0..1 over the 0.30 m lamp
  fixed h = clamp(fixed(led.pos.y) * fixed(3.333), fixed(0.0), fixed(1.0));

  // folded, drifting curtain: domain-warped angular wave
  fixed warp = sin(ang * k2 + ph2) * fixed(0.14) + sin(ang * k3 - ph3) * fixed(0.07);
  fixed c = sin(ang * k1 + ph1 + warp) * fixed(0.5) + fixed(0.5);
  fixed curtain = clamp((c - fixed(0.5)) * sharpK + fixed(0.5), fixed(0.0), fixed(1.0));
  curtain = curtain * curtain;

  // wavy lower hem of the curtain
  fixed edge = fixed(0.22) + sin(ang * k2 - ph1 + warp) * fixed(0.10);
  fixed above = h - edge;
  fixed hem = clamp(above * fixed(10.0), fixed(0.0), fixed(1.0));
  fixed fade = clamp(fixed(1.0) - above * fixed(1.3), fixed(0.0), fixed(1.0));

  // faint vertical rays shimmering upward
  fixed ray = sin(ang * k3 * fixed(3.0) + warp + ph4) * fixed(0.2) + fixed(0.8);

  fixed v = curtain * hem * fade * ray * bri;
  v = v * (fixed(2.0) - v);   // gentle lift of the glow

  // green at the hem, shifting toward violet/pink as it rises
  fixed hue = fract(hLo + hSpan * clamp(above * fixed(1.4), fixed(0.0), fixed(1.0)));
  return hsv2rgb(hue, fixed(0.85), v);
}
