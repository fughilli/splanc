// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p01 status=ok calls=0 no_lint_hits
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up a helical cylinder lamp.
// Per-LED math stays in fixed-point; trig uses the native fixed sin (angle in turns).

uniform float speed : 0.0 .. 2.0 = 0.22;
uniform float swells : 0.5 .. 6.0 = 1.8;
uniform float swirl : 0.0 .. 2.0 = 0.6;
uniform float foam : 0.0 .. 1.0 = 0.45;
uniform float brightness : 0.1 .. 1.0 = 0.8;
uniform vec3 deep : color = 0.0, 0.04, 0.18;
uniform vec3 shallow : color = 0.0, 0.32, 0.48;
uniform vec3 crest : color = 0.55, 0.85, 1.0;

state fixed p1;
state fixed p2;
state fixed k1;
state fixed k2;
state fixed kx;
state fixed kz;
state fixed fFoam;
state vec3 cDeep;
state vec3 cShal;
state vec3 cCrest;

void update() {
  // Phases in turns, wrapped to keep fixed precision.
  p1 = fixed(fract(time * speed));
  p2 = fixed(fract(time * speed * 0.63 + 0.3));
  // Height 0..0.30 m -> number of swells along the lamp.
  k1 = fixed(swells / 0.3);
  k2 = fixed(swells * 1.7 / 0.3);
  // Radius 0.08 m -> gentle angular tilt of the wavefronts.
  kx = fixed(swirl * 0.15 / 0.08);
  kz = fixed(swirl * 0.10 / 0.08);
  fFoam = fixed(foam);
  cDeep = deep * brightness;
  cShal = shallow * brightness;
  cCrest = crest * brightness;
}

vec3 shade(Led led) {
  fixed y = fixed(led.pos.y);
  fixed x = fixed(led.pos.x);
  fixed z = fixed(led.pos.z);

  // Two slow swells rolling upward, slightly skewed around the cylinder.
  fixed w1 = sin(y * k1 - p1 + x * kx);
  fixed w2 = sin(y * k2 - p2 + z * kz);
  fixed w = w1 * fixed(0.65) + w2 * fixed(0.35);

  fixed t = w * fixed(0.5) + fixed(0.5);
  fixed t2 = t * t;
  fixed cr = t2 * t2 * fFoam;

  return mix(cDeep, cShal, float(t)) + cCrest * float(cr);
}
