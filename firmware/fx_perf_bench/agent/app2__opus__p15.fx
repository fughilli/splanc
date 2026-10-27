// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p15 status=ok calls=1
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
state fixed kh;
state fixed kw;
state fixed ks;
state fixed fh;
state fixed fs;
state fixed fb;
state fixed fg;

void update() {
  float t = dt * speed;
  p1 = fract(p1 + fixed(t * 0.23));
  p2 = fract(p2 + fixed(t * 0.31));
  p3 = fract(p3 + fixed(t * 0.41));
  p4 = fract(p4 + fixed(t * 0.37));
  p5 = fract(p5 + fixed(t * 0.29));
  kh = fixed(density);
  kw = fixed(warp);
  ks = fixed(sharpness);
  fh = fixed(hue);
  fs = fixed(sat);
  fb = fixed(depth);
  fg = fixed(glow);
}

vec3 shade(Led led) {
  // Angle around the lamp axis in turns. It depends only on the LED, so the compiler caches it.
  fixed a = atan2(fixed(led.pos.z), fixed(led.pos.x));
  fixed h = fixed(led.pos.y) * kh;

  // Slow warp fields. Integer angular frequencies keep the pattern seamless around the cylinder.
  fixed w1 = sin(a * fixed(3.0) + h + p1) * kw;
  fixed w2 = sin(a * fixed(2.0) - h * fixed(1.3) + p2) * kw;

  // Three interfering waves. The bright caustic lines sit near where their sum crosses zero.
  fixed s1 = sin(a * fixed(5.0) + h * fixed(0.7) + w1 + p3);
  fixed s2 = sin(a * fixed(-4.0) + h * fixed(1.1) + w2 + p4);
  fixed s3 = sin(a + h * fixed(1.9) + w1 - w2 + p5);

  fixed c = abs(s1 + s2 + s3);
  fixed l = clamp(fixed(1.0) - c * ks, fixed(0.0), fixed(1.0));
  l = l * l;

  fixed v = clamp(fb + l * fg, fixed(0.0), fixed(1.0));
  fixed hh = fract(fh - l * fixed(0.04));
  fixed ss = fs * (fixed(1.0) - l * fixed(0.6));   // highlights wash toward white
  return hsv2rgb(hh, ss, v);
}
