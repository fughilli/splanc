// fx_agent_eval: variant=app2_est model=claude-opus-5-5 prompt=p08 status=ok calls=1 revised
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
state fixed bx[4];    // blob angle (turns)
state fixed by[4];    // blob height (normalized, same frame as yn)
state fixed kx[4];    // angular falloff gain   (k * 1.676^2 / (2 pi^2))
state fixed ky[4];    // vertical falloff gain  (k / (2 pi^2))
state fixed a0[4];    // 1 - kx - ky  (field constant)
state fixed nkx[4];   // -kx          (early-reject threshold)
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
    bx[i] = fixed(fract(fi * 0.25 + 0.06 * sin(t * 0.13 + fi * 2.1) + t * 0.015 * (fi - 1.5)));
    // blobs swell and shrink a little
    float r = blob_size * (0.85 + 0.2 * sin(t * 0.47 + fi * 2.3));
    float k = 1.0 / (r * r);
    // wrapped squared distance via cosine: 1 - cos(2*pi*d) ~= 2*pi^2*d^2
    float gy = k * 0.050661;            // 1 / (2 pi^2)
    float gx = k * 0.050661 * 2.809;    // 1.676^2 aspect (circumference / height)
    kx[i]  = fixed(gx);
    ky[i]  = fixed(gy);
    a0[i]  = fixed(1.0 - gx - gy);
    nkx[i] = fixed(-gx);
  }
  thr   = fixed(goo);
  hLava = fixed(lava_hue);
  hBg   = fixed(wax_hue);
  sat   = fixed(saturation);
  bgv   = fixed(background);
}

vec3 shade(Led led) {
  // per-LED invariants (cached by the compiler): angle around the axis (turns) and normalized height
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));
  fixed yn  = fixed(led.pos.y) * fixed(3.3333) + fixed(0.5);

  fixed f = fixed(0.0);
  fixed ty = fixed(0.0);

  // unrolled blobs; skip the angular part when the LED is out of the blob's height band
  ty = a0[0] + ky[0] * cos(yn - by[0]);
  if (ty > nkx[0]) { f = f + max(ty + kx[0] * cos(ang - bx[0]), fixed(0.0)); }

  ty = a0[1] + ky[1] * cos(yn - by[1]);
  if (ty > nkx[1]) { f = f + max(ty + kx[1] * cos(ang - bx[1]), fixed(0.0)); }

  ty = a0[2] + ky[2] * cos(yn - by[2]);
  if (ty > nkx[2]) { f = f + max(ty + kx[2] * cos(ang - bx[2]), fixed(0.0)); }

  ty = a0[3] + ky[3] * cos(yn - by[3]);
  if (ty > nkx[3]) { f = f + max(ty + kx[3] * cos(ang - bx[3]), fixed(0.0)); }

  // metaball threshold with a soft edge
  fixed v = clamp((f - thr) * fixed(5.0), fixed(0.0), fixed(1.0));
  fixed glow = clamp(f * fixed(1.5), fixed(0.0), fixed(1.0));
  fixed hue = fract(mix(hBg, hLava, v));
  fixed val = mix(bgv, fixed(1.0), max(v, glow * fixed(0.35)));
  return hsv2rgb(hue, sat, val);
}
