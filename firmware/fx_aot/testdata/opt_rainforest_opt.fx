// Hand-optimised rewrite of the user's "Rainforest" (fx-perf study): the same
// five swaying sine layers, but every per-LED sine is the fixed-point LUT sine
// (angles in TURNS, so radians/2π), the time phases are folded into fixed state
// once per frame, the smoothstep is fixed and the droplet's exp() decay is a
// per-frame constant (it only depends on time).
uniform float sway  : 0.0 .. 1.0 = 0.3;
uniform float beams : 0.0 .. 1.0 = 0.5;
uniform float drops : 0.0 .. 1.0 = 0.4;
uniform vec3  leaf  : color = 0.04, 0.35, 0.08;
uniform vec3  light : color = 1.0, 0.85, 0.4;

state fixed p1; state fixed p2; state fixed p3; state fixed p4; state fixed p5;
state fixed e0; state float dropAmt; state float dropSeed; state float dropThr;

void update() {
  float t1 = time * sway * 1.3;
  float t2 = time * sway * 0.7;
  float t3 = time * 0.08;
  float k = 0.15915494; // 1 / 2π: radians -> turns
  p1 = fixed(fract(t1 * k));
  p2 = fixed(fract(t2 * k));
  p3 = fixed(fract((-t2 * 1.3 + 2.1) * k));
  p4 = fixed(fract(-t3 * 6.0 * k));
  p5 = fixed(fract(t1 * 2.0 * k));
  e0 = fixed(1.0 - beams * 0.35);
  float rate = 0.5 + drops * 2.0;
  dropAmt = exp(-fract(time * rate) * 5.0);
  dropSeed = floor(time * rate) * 37.0;
  dropThr = 1.0 - drops * 0.04;
}

vec3 shade(Led led) {
  fixed x = fixed(led.uv.x);
  fixed y = fixed(led.uv.y);
  // sin(x*11 + y*7 + t1 + sin(y*5 + t2)*1.5) with every term in turns
  fixed w = sin(y * fixed(0.795775) + p2) * fixed(0.238732);
  fixed a = fixed(0.5) + fixed(0.5) * sin(x * fixed(1.750704) + y * fixed(1.114085) + p1 + w);
  fixed b = fixed(0.5) + fixed(0.5) * sin(x * fixed(0.954930) - y * fixed(1.432394) + p3);
  fixed shaft = fixed(0.5) + fixed(0.5) * sin(x * fixed(1.114085) + y * fixed(0.397887) + p4);
  fixed flick = fixed(0.5) + fixed(0.5) * sin(x * fixed(3.660564) - y * fixed(2.705634) + p5);
  fixed t = clamp((shaft - e0) / (fixed(1.0) - e0), fixed(0.0), fixed(1.0));
  fixed beam = t * t * (fixed(3.0) - fixed(2.0) * t) * (fixed(0.5) + fixed(0.5) * flick);
  vec3 g = leaf * float(fixed(0.35) + fixed(0.65) * a) + vec3(0.02, 0.12, 0.0) * float(b);
  vec3 c = mix(g, light, float(beam * fixed(0.8)));
  if (hash(float(led.idx) + dropSeed) > dropThr) {
    c = c + vec3(0.6, 0.85, 1.0) * dropAmt;
  }
  return c;
}
