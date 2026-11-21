// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p02 status=ok calls=2
// request: campfire embers with occasional sparks
// Campfire embers with occasional rising sparks
uniform float intensity : 0.2 .. 2.0 = 1.0;
uniform float flicker : 0.1 .. 4.0 = 1.2;
uniform float bedHeight : 0.05 .. 1.0 = 0.4;
uniform float sparkRate : 0.0 .. 5.0 = 1.2;
uniform float sparkSpeed : 0.1 .. 2.0 = 0.6;
uniform float sparkSize : 0.01 .. 0.1 = 0.04;
uniform float trailLen : 0.0 .. 0.95 = 0.8;
uniform vec3 emberColor : color = 1.0, 0.22, 0.02;
uniform vec3 hotColor : color = 0.6, 0.35, 0.05;
uniform vec3 sparkColor : color = 1.0, 0.7, 0.3;
uniform float yOffset : 0.0 .. 0.6 = 0.3;
uniform float yRange : 0.1 .. 1.0 = 0.30;

state fixed ph1;
state fixed ph2;
state fixed bedInv;
state fixed dec;
state fixed r2;
state vec3 eCol;
state vec3 hCol;
state vec3 sCol;
state float sh[4];
state float sa[4];
state float sv[4];
state float sl[4];
state fixed fh[4];
state fixed fa[4];
state fixed fb[4];
state bool started;
state bool ready;

buffer float hgt : fixed16;
buffer float ang : fixed16;
buffer float rnd : fixed16;
buffer float trl : fixed16;

void update() {
  ready = started;
  started = true;

  ph1 = fract(ph1 + fixed(dt * flicker * 0.7));
  ph2 = fract(ph2 + fixed(dt * flicker * 0.43));
  bedInv = fixed(1.0 / bedHeight);
  dec = fixed(trailLen);
  float rr = sparkSize * sparkSize;
  r2 = fixed(rr);

  float g = intensity * (0.85 + 0.15 * sin(time * flicker * 2.3) * sin(time * 1.7 + 0.4));
  eCol = emberColor * g;
  hCol = hotColor * g;
  sCol = sparkColor * intensity;

  for (int k = 0; k < 4; k = k + 1) {
    if (sl[k] <= 0.0) {
      if (hash(time * 17.3 + float(k) * 5.1) < sparkRate * dt * 0.25) {
        sh[k] = bedHeight * 0.6 * hash(time * 3.1 + float(k));
        sa[k] = hash(time * 7.7 + float(k) * 2.3);
        sv[k] = sparkSpeed * (0.6 + 0.8 * hash(time * 11.9 + float(k)));
        sl[k] = 1.0;
      }
    } else {
      sh[k] = sh[k] + sv[k] * dt;
      sa[k] = fract(sa[k] + (hash(time * 5.3 + float(k) * 9.1) - 0.5) * dt * 0.6);
      sl[k] = sl[k] - dt * (0.6 + 0.4 * sv[k]);
      if (sh[k] > 1.1) { sl[k] = 0.0; }
    }
    if (sl[k] > 0.0) {
      fh[k] = fixed(sh[k]);
      fa[k] = fixed(sa[k]);
      float tw = 0.7 + 0.3 * hash(time * 29.0 + float(k));
      fb[k] = fixed(sl[k] * tw / rr);
    } else {
      fh[k] = fixed(-4.0);
      fa[k] = fixed(0.0);
      fb[k] = fixed(0.0);
    }
  }
}

vec3 shade(Led led) {
  int i = led.idx;
  if (!ready) {
    hgt[i] = clamp((led.pos.y + yOffset - 0.3) / yRange, 0.0, 1.0);
    ang[i] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
    rnd[i] = hash(float(i) * 1.37);
    trl[i] = 0.0;
  }
  fixed h = fixed(hgt[i]);
  fixed a = fixed(ang[i]);
  fixed r = fixed(rnd[i]);

  // ember bed: per-LED flicker + slow rolling glow around the cylinder
  fixed fl = sin(r * fixed(7.0) + ph1) * fixed(0.3)
           + sin(a * fixed(3.0) + h * fixed(2.0) - ph2) * fixed(0.25)
           + step(fixed(0.85), r) * fixed(0.35);
  fixed base = clamp(fixed(1.0) - h * bedInv, fixed(0.0), fixed(1.0));
  fixed heat = clamp(base * (fixed(0.55) + fl), fixed(0.0), fixed(1.0));

  // sparks
  fixed sp = fixed(0.0);
  for (int k = 0; k < 4; k = k + 1) {
    fixed dh = h - fh[k];
    fixed da = fract(a - fa[k] + fixed(0.5)) - fixed(0.5);
    fixed d = dh * dh + da * da * fixed(2.8);
    sp = max(sp, (r2 - d) * fb[k]);
  }
  fixed s = max(fixed(trl[i]) * dec, clamp(sp, fixed(0.0), fixed(1.0)));
  trl[i] = s;

  return eCol * heat + hCol * (heat * heat * heat) + sCol * s;
}
