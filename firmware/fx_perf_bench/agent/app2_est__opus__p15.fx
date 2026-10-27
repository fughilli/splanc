// fx_agent_eval: variant=app2_est model=claude-opus-5-5 prompt=p15 status=ok calls=1 revised
// request: water caustics shimmer
// Water caustics shimmer: moving bright lines on a cylinder, built from warped interference waves.
// Per-LED maths is all in fixed point. Angles are in TURNS.

uniform float speed     : 0.0 .. 3.0  = 0.8;
uniform float density   : 2.0 .. 30.0 = 10.0;   // wave turns per metre of height
uniform float sharpness : 0.5 .. 6.0  = 2.2;    // thinner, crisper caustic lines
uniform float warp      : 0.0 .. 0.4  = 0.18;   // ripple distortion of the lines
uniform float hue       : 0.0 .. 1.0  = 0.53;   // water colour
uniform float depth     : 0.0 .. 0.6  = 0.18;   // ambient brightness of the water
uniform float glow      : 0.0 .. 1.0  = 0.85;   // brightness of the caustic highlights
uniform float sat       : 0.0 .. 1.0  = 0.85;

state fixed p1;
state fixed p2;
state fixed p3;
state fixed p4;
state fixed p5;
state fixed kh;    // height scale for warp 1
state fixed k13;   // height scale for warp 2 (x1.3)
state fixed k07;   // height scales for the three waves
state fixed k11;
state fixed k19;
state fixed kw;
state fixed ks;
state fixed fh;
state fixed fs;
state fixed fs6;   // sat * 0.6: highlight whitening
state fixed fb;
state fixed fg;

void update() {
  float t = dt * speed;
  p1 = fract(p1 + fixed(t * 0.23));
  p2 = fract(p2 + fixed(t * 0.31));
  p3 = fract(p3 + fixed(t * 0.41));
  p4 = fract(p4 + fixed(t * 0.37));
  p5 = fract(p5 + fixed(t * 0.29));
  kh  = fixed(density);
  k13 = fixed(density * 1.3);
  k07 = fixed(density * 0.7);
  k11 = fixed(density * 1.1);
  k19 = fixed(density * 1.9);
  kw = fixed(warp);
  ks = fixed(sharpness);
  fh = fixed(hue);
  fs = fixed(sat);
  fs6 = fixed(sat * 0.6);
  fb = fixed(depth);
  fg = fixed(glow);
}

vec3 shade(Led led) {
  // Angular multiples depend only on the LED: written directly so the compiler caches them (4 slots).
  fixed a2  = atan2(fixed(led.pos.z), fixed(led.pos.x)) * fixed(2.0);
  fixed a3  = atan2(fixed(led.pos.z), fixed(led.pos.x)) * fixed(3.0);
  fixed a5  = atan2(fixed(led.pos.z), fixed(led.pos.x)) * fixed(5.0);
  fixed a4n = atan2(fixed(led.pos.z), fixed(led.pos.x)) * fixed(-4.0);
  fixed y = fixed(led.pos.y);

  // Slow warp fields. Integer angular frequencies keep the pattern seamless around the cylinder.
  fixed w1 = sin(a3 + y * kh + p1) * kw;
  fixed w2 = sin(a2 - y * k13 + p2) * kw;

  // Three interfering waves. The bright caustic lines sit near where their sum crosses zero.
  fixed s1 = sin(a5 + y * k07 + w1 + p3);
  fixed s2 = sin(a4n + y * k11 + w2 + p4);
  fixed s3 = sin(a5 + a4n + y * k19 + w1 - w2 + p5);   // a5 + a4n == 1 x angle

  fixed c = abs(s1 + s2 + s3);
  fixed l = max(fixed(1.0) - c * ks, fixed(0.0));      // c >= 0, so only the lower bound matters
  l = l * l;

  fixed v = min(fb + l * fg, fixed(1.0));               // all terms >= 0
  fixed hh = fract(fh - l * fixed(0.04));
  fixed ss = fs - l * fs6;                               // highlights wash toward white
  return hsv2rgb(hh, ss, v);
}
