// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p11 status=ok calls=0 no_lint_hits
// request: police lights spinning red/blue
// Police lights: a red and a blue beacon beam sweeping around the cylinder
uniform float speed : 0.1 .. 5.0 = 1.5;
uniform float width : 0.05 .. 0.95 = 0.45;
uniform vec3 redCol : color = 1.0, 0.0, 0.0;
uniform vec3 blueCol : color = 0.0, 0.12, 1.0;
uniform bool strobe = true;
uniform float strobeRate : 0.2 .. 4.0 = 1.2;
uniform float ambient : 0.0 .. 0.3 = 0.02;

state float ang;
state fixed ca;
state fixed sa;
state fixed thr;
state fixed invw;
state fixed rGain;
state fixed bGain;
state fixed invR;

void update() {
  ang = fract(ang + speed * dt);
  float a = ang * 6.2831853;
  ca = fixed(cos(a));
  sa = fixed(sin(a));
  thr = fixed(1.0 - width);
  invw = fixed(1.0 / width);
  invR = fixed(12.5);

  float rg = 1.0;
  float bg = 1.0;
  if (strobe) {
    // double-flash pattern: red flashes twice, then blue flashes twice
    float t = fract(time * strobeRate);
    float f1 = step(0.0, t) * (1.0 - step(0.07, t)) + step(0.14, t) * (1.0 - step(0.21, t));
    float t2 = t - 0.5;
    float f2 = step(0.0, t2) * (1.0 - step(0.07, t2)) + step(0.14, t2) * (1.0 - step(0.21, t2));
    rg = 0.55 + 0.45 * f1;
    bg = 0.55 + 0.45 * f2;
  }
  rGain = fixed(rg);
  bGain = fixed(bg);
}

vec3 shade(Led led) {
  fixed x = fixed(led.pos.x) * invR;
  fixed z = fixed(led.pos.z) * invR;
  fixed c = x * ca + z * sa;
  fixed r = clamp((c - thr) * invw, fixed(0.0), fixed(1.0));
  fixed b = clamp((fixed(0.0) - c - thr) * invw, fixed(0.0), fixed(1.0));
  r = r * r * rGain;
  b = b * b * bGain;
  return redCol * float(r) + blueCol * float(b) + vec3(ambient, ambient, ambient);
}
