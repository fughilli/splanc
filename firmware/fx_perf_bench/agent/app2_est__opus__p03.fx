// fx_agent_eval: variant=app2_est model=claude-opus-5-5 prompt=p03 status=ok calls=1 revised
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
state fixed hLo;
state fixed hS14;
state fixed hMin;
state fixed hMax;

// per-frame angular tables (128 bins around the lamp, bin i centred at i/128 - 0.5 turns)
texture fixed tGlow(128, 1);   // curtain * rays * brightness
texture fixed tEdge(128, 1);   // height of the wavy hem

void update() {
  // slow phases in TURNS
  ph1 = fract(ph1 + fixed(dt * speed * 0.050));
  ph2 = fract(ph2 + fixed(dt * speed * 0.031));
  ph3 = fract(ph3 + fixed(dt * speed * 0.023));
  ph4 = fract(ph4 + fixed(dt * speed * 0.400));
  // integer fold counts so the curtain wraps seamlessly around the cylinder
  fixed k1 = fixed(floor(folds));
  fixed k2 = fixed(floor(folds * 0.5) + 1.0);
  fixed k3 = fixed(floor(folds) + 1.0);
  fixed rayK = k3 * fixed(3.0);
  fixed halfSharp = fixed(sharpness * 0.5);
  fixed bri = fixed(brightness);

  hLo  = fixed(hue_low);
  hS14 = fixed((hue_high - hue_low) * 1.4);
  hMin = fixed(min(hue_low, hue_high));
  hMax = fixed(max(hue_low, hue_high));

  fixed a = fixed(-0.5);
  for (int i = 0; i < 128; i = i + 1) {
    fixed ak2 = a * k2;
    // folded, drifting curtain: domain-warped angular wave
    fixed warp = sin(ak2 + ph2) * fixed(0.14) + sin(a * k3 - ph3) * fixed(0.07);
    fixed cur = clamp(sin(a * k1 + ph1 + warp) * halfSharp + fixed(0.5), fixed(0.0), fixed(1.0));
    // faint vertical rays shimmering upward
    fixed ray = sin(a * rayK + warp + ph4) * fixed(0.2) + fixed(0.8);
    tGlow[i] = cur * cur * ray * bri;
    // wavy lower hem of the curtain
    tEdge[i] = fixed(0.22) + sin(ak2 - ph1 + warp) * fixed(0.10);
    a = a + fixed(0.0078125);
  }
}

vec3 shade(Led led) {
  // nearest angular bin (per-LED invariant, cached by the compiler)
  int bin = int(fract(atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.50390625)) * fixed(128.0));
  // normalised height 0..1 over the 0.30 m lamp
  fixed h = clamp(fixed(led.pos.y) * fixed(3.333), fixed(0.0), fixed(1.0));

  fixed above = h - tEdge[bin];
  fixed hem  = clamp(above * fixed(10.0), fixed(0.0), fixed(1.0));
  fixed fade = clamp(fixed(1.0) - above * fixed(1.3), fixed(0.0), fixed(1.0));

  fixed v = tGlow[bin] * hem * fade;
  v = v * (fixed(2.0) - v);   // gentle lift of the glow

  // green at the hem, shifting toward violet/pink as it rises
  fixed hue = clamp(hLo + above * hS14, hMin, hMax);
  return hsv2rgb(hue, fixed(0.85), v);
}
