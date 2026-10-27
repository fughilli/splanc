// fx_agent_eval: variant=app2_est model=claude-sonnet-4-6 prompt=p04 status=ok calls=0 within_budget
// request: a slow rainbow rotating around the lamp (cylindrical)
// Slow rainbow rotating around a cylindrical lamp.
// Hue is driven by the azimuth angle around the Y-axis, so the
// whole spectrum sweeps around the tube.  A vertical twist adds
// depth and flatters the helix winding.

uniform float speed  : 0.0 .. 2.0 = 0.25;   // rotations per second
uniform float twist  : 0.0 .. 4.0 = 1.0;    // rainbow cycles over full height
uniform float sat    : 0.0 .. 1.0 = 1.0;    // saturation
uniform float val    : 0.0 .. 1.0 = 1.0;    // brightness

state fixed ph;   // rotation phase in TURNS
state fixed s;    // saturation (fixed, ready for hsv2rgb integer path)
state fixed v;    // value
state fixed k;    // twist coefficient

void update() {
  ph = fract(ph + fixed(dt * speed));
  s  = fixed(sat);
  v  = fixed(val);
  k  = fixed(twist);
}

vec3 shade(Led led) {
  // Azimuth angle around vertical axis, in TURNS (0..1).
  // atan2(fixed,fixed) returns TURNS (-0.5..0.5); +0.5 maps it to 0..1.
  // The compiler caches this once per LED (depends only on led.pos).
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  // Vertical position: cylinder height 0.30 m → 0..1 range.
  fixed vy  = fixed(led.pos.y) * fixed(3.3333);

  // Hue = azimuth + vertical spiral + rotating phase.
  fixed hue = fract(ang + vy * k + ph);

  // All-fixed hsv2rgb takes the integer path (~370 cycles).
  return hsv2rgb(hue, s, v);
}
