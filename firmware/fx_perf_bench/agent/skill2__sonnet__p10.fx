// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p10 status=ok calls=2
// request: matrix-style green rain falling down
// Matrix rain — bright green columns cascade down the helix cylinder.
// Each of `density` angular columns carries a falling streak:
// white-tipped head, quadratically fading green tail, black background.
// Per-column phase offsets are seeded once into a state array so shade()
// pays only a cheap array lookup instead of a per-LED hash each frame.

uniform float speed    : 0.2 .. 4.0 = 1.5;
uniform float density  : 2.0 .. 10.0 = 6.0;
uniform float tail_len : 0.05 .. 0.6 = 0.35;
uniform float glow     : 0.0 .. 0.3 = 0.05;

state fixed col_phases[12];
state bool  seeded;
state fixed dens;
state int   max_ci;
state fixed f_tail;
state fixed tlk;
state fixed phase_t;
state float glow_flt;

void update() {
  if (!seeded) {
    for (int i = 0; i < 12; i = i + 1) {
      col_phases[i] = fixed(hash(float(i) * 2.399963));
    }
    seeded = true;
  }
  dens     = fixed(density);
  max_ci   = int(dens) - 1;
  if (max_ci < 0)  { max_ci = 0; }
  if (max_ci > 11) { max_ci = 11; }
  f_tail   = fixed(tail_len);
  tlk      = fixed(1.0 / max(tail_len, 0.01));
  phase_t  = fract(phase_t + fixed(dt * speed * 0.5));
  glow_flt = glow;
}

vec3 shade(Led led) {
  // Angle around the Y axis → which column.
  // atan2(fixed, fixed) returns turns; the compiler caches it per LED
  // because it depends only on led.pos.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  int   ci  = int(ang * dens);
  if (ci < 0)      { ci = 0; }
  if (ci > max_ci) { ci = max_ci; }

  // Head descends from y=1 to y=0, looping continuously.
  fixed head = fract(col_phases[ci] - phase_t);

  // d = how far ABOVE the head this LED sits (0 at head, upward into tail).
  // fixed(led.uv.y): the first fixed(led.*) costs ~1200 cycles to load all
  // LED properties; every subsequent one is a cheap cached read.
  fixed h = fixed(led.uv.y);
  fixed d = fract(h - head + fixed(1.0));

  // Brightness: quadratic decay over tail length, hard white at head tip.
  fixed bright = fixed(0.0);
  if (d < f_tail) {
    fixed t = fixed(1.0) - d * tlk;
    bright = t * t;
  }
  if (d < fixed(0.04)) {
    bright = fixed(1.0);
  }

  // White at head tip (w=1) blends to Matrix green through the body (w=0).
  fixed w = max(fixed(0.0), fixed(1.0) - d * tlk * fixed(5.0));

  // All colour arithmetic in fixed; two conversions at the return.
  fixed gc = bright * (fixed(0.75) + fixed(0.25) * w);
  fixed rc = bright * w * fixed(0.65);

  float g = float(gc);
  float r = float(rc);

  // Static per-LED ambient flicker; hash(float(led.idx)) is compiler-cached.
  float bg = glow_flt * hash(float(led.idx));

  return vec3(r, g + bg, r * 0.15);
}
