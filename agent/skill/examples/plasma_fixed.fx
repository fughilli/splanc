// Plasma: three travelling sine waves summed over the fixture and mapped to a
// hue — the classic "trig-heavy" look, written in fixed point. Each sin() takes
// a fixed angle in TURNS (an integer LUT, ~150 cycles) instead of float radians
// (~570), the phases advance once per frame in update(), and the colour is the
// integer hsv2rgb. ~2.5x cheaper than the float version.
uniform float speed : 0.0 .. 4.0 = 1.0;
uniform float scale : 0.5 .. 4.0 = 1.5;   // waves across the fixture
uniform float sat   : 0.0 .. 1.0 = 0.85;

state fixed p1;
state fixed p2;
state fixed p3;
state fixed k;
state fixed s;

void update() {
  p1 = fract(p1 + fixed(dt * speed * 0.16));
  p2 = fract(p2 - fixed(dt * speed * 0.21));
  p3 = fract(p3 + fixed(dt * speed * 0.11));
  k = fixed(scale);
  s = fixed(sat);
}

vec3 shade(Led led) {
  fixed x = fixed(led.uv.x) * k;
  fixed y = fixed(led.uv.y) * k;
  fixed v = sin(x + p1) + sin(y * fixed(0.8) + p2) + sin((x + y) * fixed(0.7) + p3);
  return hsv2rgb(fract(v * fixed(0.25) + p1), s, fixed(1.0));
}
