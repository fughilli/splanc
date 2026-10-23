// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p14 status=ok calls=0 within_budget
// request: a scanner beam sweeping left to right
// Scanner beam: a bright vertical band of light sweeps left to right across the
// lamp (along X, using the projection led.uv.x), leaving a fading tail behind it.
// On the cylinder it reads as a plane of light passing through the lamp. Turn on
// `bounce` for a back-and-forth "Cylon" scanner. Uses fixed point per LED: the
// beam position, direction and reciprocals are computed once per frame in update().
uniform float speed  : 0.05 .. 2.0 = 0.4;    // sweeps per second
uniform float width  : 0.02 .. 0.5 = 0.08;   // beam half-width (fraction of the lamp)
uniform float tail   : 0.02 .. 1.0 = 0.35;   // length of the fading tail
uniform float trail  : 0.0 .. 1.0 = 0.6;     // tail brightness
uniform vec3  tint   : color = 1.0, 0.08, 0.02;
uniform vec3  base   : color = 0.01, 0.0, 0.0;
uniform bool  bounce = false;                // back-and-forth instead of wrapping

state fixed ph;    // sweep phase, 0..1
state fixed bp;    // beam position in uv.x space
state fixed dir;   // +1 moving right, -1 moving left
state fixed iw;    // 1 / width
state fixed it;    // 1 / tail
state fixed amt;   // tail brightness

void update() {
  ph = fract(ph + fixed(dt * speed));
  float p = float(ph);
  float tri = p;
  float dirf = 1.0;
  if (bounce) {
    tri = 1.0 - abs(2.0 * p - 1.0);
    if (p >= 0.5) {
      dirf = -1.0;
    }
  }
  // Let the beam (and its tail) travel fully off each side before it returns.
  float m = width + tail;
  bp = fixed(-m + tri * (1.0 + 2.0 * m));
  dir = fixed(dirf);
  iw = fixed(1.0 / width);
  it = fixed(1.0 / tail);
  amt = fixed(trail);
}

vec3 shade(Led led) {
  fixed x = fixed(led.uv.x);
  fixed d = (x - bp) * dir;                                  // > 0 ahead of the beam
  fixed core = clamp(fixed(1.0) - abs(d) * iw, fixed(0.0), fixed(1.0));
  core = core * core;
  fixed t = clamp(fixed(1.0) + d * it, fixed(0.0), fixed(1.0)) * step(d, fixed(0.0));
  fixed v = max(core, t * t * amt);
  return base + tint * float(v);
}
