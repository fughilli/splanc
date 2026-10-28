// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p08 status=ok calls=1
// request: lava lamp blobs
// Lava lamp: soft metaball blobs that rise, sink and drift around a helix-wrapped cylinder.
uniform float speed      : 0.0 .. 3.0  = 1.0;
uniform float blob_size  : 0.05 .. 0.35 = 0.17;
uniform float goo        : 0.1 .. 0.9  = 0.45;
uniform float lava_hue   : 0.0 .. 1.0  = 0.02;
uniform float wax_hue    : 0.0 .. 1.0  = 0.92;
uniform float saturation : 0.0 .. 1.0  = 0.95;
uniform float background : 0.0 .. 0.5  = 0.12;

state float t;
state fixed bx[4];    // blob angle (turns), pre-offset by -0.5 for the wrap
state fixed by[4];    // blob height (height units, 1.0 = lamp height)
state fixed bk[4];    // 1 / radius^2
state fixed thr;
state fixed hLava;
state fixed hBg;
state fixed sat;
state fixed bgv;

void update() {
  t = t + dt * speed;
  for (int i = 0; i < 4; i = i + 1) {
    float fi = float(i);
    // slow rise and fall, each blob on its own period
    by[i] = fixed(0.5 + 0.42 * sin(t * (0.21 + 0.06 * fi) + fi * 1.7));
    // gentle drift around the cylinder
    bx[i] = fixed(fract(fi * 0.25 + 0.06 * sin(t * 0.13 + fi * 2.1) + t * 0.015 * (fi - 1.5) - 0.5));
    // blobs swell and shrink a little
    float r = blob_size * (0.85 + 0.2 * sin(t * 0.47 + fi * 2.3));
    bk[i] = fixed(1.0 / (r * r));
  }
  thr   = fixed(goo);
  hLava = fixed(lava_hue);
  hBg   = fixed(wax_hue);
  sat   = fixed(saturation);
  bgv   = fixed(background);
}

vec3 shade(Led led) {
  // per-LED invariants: angle around the axis (turns) and normalized height
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  fixed yn  = fixed(led.pos.y) * fixed(3.3333) + fixed(0.5);

  fixed f = fixed(0.0);
  for (int i = 0; i < 4; i = i + 1) {
    // wrapped angular distance scaled to height units (circumference 0.503 m / height 0.30 m)
    fixed dx = (fract(ang - bx[i]) - fixed(0.5)) * fixed(1.676);
    fixed dy = fract(yn - by[i]) - fixed(0.5);
    f = f + max(fixed(1.0) - (dx * dx + dy * dy) * bk[i], fixed(0.0));
  }

  // metaball threshold with a soft edge
  fixed v = clamp((f - thr) * fixed(5.0), fixed(0.0), fixed(1.0));
  fixed glow = clamp(f * fixed(1.5), fixed(0.0), fixed(1.0));
  fixed hue = fract(mix(hBg, hLava, v));
  fixed val = mix(bgv, fixed(1.0), max(v, glow * fixed(0.35)));
  return hsv2rgb(hue, sat, val);
}
