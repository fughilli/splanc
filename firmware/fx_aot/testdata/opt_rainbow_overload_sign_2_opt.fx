// Hand-optimised rewrite of the user's "Rainbow overload (sign)" (the costliest
// effect in the library; fx-perf study). Same layers, same timing:
//  - the 3-5 hsv2rgb(h, 1, 1) calls per LED become lookups into a 32-entry
//    rainbow table baked once (saturated hues only depend on h);
//  - the radial distance sqrt(dx²+dy²) is LED-invariant: computed once per LED
//    and cached in a buffer (0 = not computed yet);
//  - the per-LED sines are the fixed LUT sine (turns); hues are fixed fract().
uniform float speed   : 0.0 .. 1.0 = 1.0;
uniform float chaos   : 0.0 .. 1.0 = 1.0;
uniform float glitter : 0.0 .. 1.0 = 1.0;
uniform float strobe  : 0.0 .. 1.0 = 1.0;

state float fr; state float fl; state float pulse; state float flood; state float side;
state fixed ta; state fixed tb; state fixed td; state fixed ts2; state fixed hfA; state fixed hfB;
state fixed mixd; state float gthr;
state vec3 rb[32];
state bool baked;
buffer fixed rad;   // cached radial hue term + 1 (never 0 once set)

void update() {
  if (!baked) {
    for (int i = 0; i < 32; i = i + 1) { rb[i] = hsv2rgb(vec3(float(i) / 32.0, 1.0, 1.0)); }
    baked = true;
  }
  float t = time * (0.5 + speed * 2.5);
  fr = floor(time * 30.0);
  fl = 0.0;
  if (fract(time * 3.0) < 0.12) { fl = strobe * 0.8; }
  pulse = 0.7 + 0.3 * sin(time * 9.0);
  float fp = fract(time * 0.7);
  flood = 0.0;
  if (fp < 0.2) { flood = (1.0 - fp / 0.2) * chaos; }
  float fh = hash(floor(time * 0.7) * 7.7);
  side = mod(floor(time * 0.7), 2.0);
  ta = fixed(fract(-t * 0.5));
  tb = fixed(fract(t * 0.6));
  td = fixed(fract(-t * 0.8));
  ts2 = fixed(fract(t * 2.0 * 0.15915494));
  mixd = fixed(0.5 + 0.5 * sin(t * 1.3));
  hfA = fixed(fh);
  hfB = fixed(fract(fh + 0.5));
  gthr = 1.0 - glitter * 0.2;
}

vec3 hue(fixed h) { return rb[int(fract(h) * 32)]; }

vec3 shade(Led led) {
  if (led.seg < 0) { return vec3(0.0, 0.0, 0.0); }
  int i = led.idx;
  fixed j = fixed((hash(float(i) * 1.9 + fr) - 0.5) * 0.25 * chaos);
  fixed ux = fixed(led.uv.x);
  fixed uy = fixed(led.uv.y);
  fixed r = rad[i];
  if (r == fixed(0.0)) {
    fixed dx = ux - fixed(0.5);
    fixed dy = uy - fixed(0.5);
    r = sqrt(dx * dx + dy * dy) * 6 + fixed(1.0);
    rad[i] = r;
  }
  vec3 a = hue(ux * 3 + uy * fixed(1.5) + ta + j);
  vec3 b = hue(fixed(led.s) * 4 + fixed(float(led.seg) * 0.13) + tb + j);
  vec3 d = hue(r + td);
  fixed m = fixed(0.5) + fixed(0.5) * sin(ux * fixed(3.183099) + ts2);
  vec3 c = mix(mix(a, b, float(m)), d, float(mixd)) * pulse;
  bool top = led.uv.y > 0.48;
  if (led.seg == 0 || led.seg == 2 || led.seg == 17 || led.seg == 18) { top = false; }
  fixed hf = hfA;
  float topf = 0.0;
  if (top) { topf = 1.0; }
  if (topf != side) { hf = hfB; }
  if (flood > 0.0) { c = mix(c, hue(hf), flood); }
  float g = hash(float(i) * 3.3 + fr);
  if (g > gthr) { c = hsv2rgb(vec3(hash(g * 13.0), 0.3, 1.0)) * 1.3; }
  return c + vec3(fl, fl, fl);
}
