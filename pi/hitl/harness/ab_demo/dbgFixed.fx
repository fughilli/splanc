// FX debugger HITL gate: the fully-fixed native path (LoadCtxFix, fixed trig,
// fixed hsv) with a fixed state accumulator.
state fixed ph;
void update() { ph = fract(ph + fixed(0.0625)); }
vec3 shade(Led led) {
  fixed x = fixed(led.pos.x);
  fixed v = sin(x * fixed(6.0) + ph) + cos(fixed(led.pos.y) * fixed(4.0) - ph);
  fixed h = fract(v * fixed(0.25) + ph);
  return hsv2rgb(h, fixed(1.0), fixed(0.9));
}
