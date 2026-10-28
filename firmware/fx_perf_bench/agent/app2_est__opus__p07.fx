// fx_agent_eval: variant=app2_est model=claude-opus-5-5 prompt=p07 status=ok calls=0 within_budget
// request: fireflies blinking at random
// Fireflies blinking at random: every LED is a potential firefly.
// Each one has its own blink rhythm and decides at random, cycle by cycle, whether to flash.
uniform float speed      : 0.05 .. 2.0 = 0.35;   // blink cycles per second (average)
uniform float density    : 0.0 .. 1.0  = 0.12;   // chance an LED flashes in a given cycle
uniform float flash      : 0.05 .. 0.6 = 0.2;    // flash length as a fraction of the cycle
uniform float hue        : 0.0 .. 1.0  = 0.2;    // firefly colour (yellow-green default)
uniform float hue_spread : 0.0 .. 0.3  = 0.06;   // per-firefly colour variation
uniform float sat        : 0.0 .. 1.0  = 0.85;
uniform float brightness : 0.0 .. 1.0  = 1.0;

state fixed ph;
state fixed dens;
state fixed k;
state fixed h;
state fixed hs;
state fixed s;
state fixed v;

void update() {
  ph = ph + fixed(dt * speed);
  if (ph > fixed(1024.0)) { ph = ph - fixed(1024.0); }
  dens = fixed(density);
  k = fixed(2.0 / flash);
  h = fixed(hue);
  hs = fixed(hue_spread);
  s = fixed(sat);
  v = fixed(brightness);
}

vec3 shade(Led led) {
  // per-LED random constants (cached once per LED by the compiler)
  fixed r1 = fixed(hash(float(led.idx)));
  fixed r2 = fixed(hash(float(led.idx) * 1.618 + 7.3));

  // individual rhythm: rate 0.7..1.3x, random offset
  fixed t = ph * (fixed(0.7) + r2 * fixed(0.6)) + r1 * fixed(16.0);
  fixed c = floor(t);

  // pseudo-random gate per cycle: does this firefly light up this time?
  fixed g = fract(c * (r1 * fixed(11.3) + fixed(3.7)) + r2);
  fixed on = step(g, dens);

  // soft flash in the middle of the cycle
  fixed p = clamp(fixed(1.0) - abs(fract(t) - fixed(0.5)) * k, fixed(0.0), fixed(1.0));
  p = p * p * on * v;

  fixed hh = fract(h + (r2 - fixed(0.5)) * hs);
  return hsv2rgb(hh, s, p);
}
