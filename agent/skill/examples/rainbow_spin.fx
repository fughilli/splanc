// Rotating rainbow with a vertical wobble — the fixed-point pattern for cheap
// per-LED maths: phases are `state fixed` in TURNS (1.0 = one revolution),
// advanced once per frame in update(); shade() reads the LED as fixed and uses
// the integer sin and hsv2rgb. About 20 ops per LED; a float version of the same
// look costs ~1.5x as much.
uniform float speed : 0.0 .. 4.0 = 1.0;
uniform float waves : 0.5 .. 8.0 = 3.0;
uniform float sat   : 0.0 .. 1.0 = 0.9;

state fixed ph1;
state fixed ph2;
state fixed k;
state fixed s;

void update() {
  ph1 = fract(ph1 + fixed(dt * speed * 0.25));
  ph2 = fract(ph2 + fixed(dt * speed * 0.17));
  k = fixed(waves);
  s = fixed(sat);
}

vec3 shade(Led led) {
  // Angle around the vertical axis: atan2 of fixed args is in turns (-0.5..0.5).
  // It depends only on led.*, so the compiler computes it once per LED and
  // caches it.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  // Every literal is wrapped in fixed(): a bare 0.125 would make this float.
  fixed w = sin(fixed(led.uv.y) * k + ph2) * fixed(0.125);
  return hsv2rgb(fract(ang + ph1 + w), s, fixed(1.0));
}
