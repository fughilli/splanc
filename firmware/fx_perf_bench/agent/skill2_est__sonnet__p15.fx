// fx_agent_eval: variant=skill2_est model=claude-sonnet-4-6 prompt=p15 status=ok calls=1 revised
// request: water caustics shimmer
// Water caustics shimmer — three overlapping traveling waves on the cylinder
// surface (angle × height) interfere to produce wandering bright patches like
// sunlight refracted through water.  All per-LED maths in fixed point.
//
// Budget fixes vs the four-wave original:
//   1. One wave dropped (w4 removed): saves ~3 sin calls worth of fixed maths
//      plus one summation step, ~650 cycles/LED.
//   2. Colour blending moved out of shade(): water*gain and shimmer*gain are
//      precomputed once per frame as state fixed, so the final mix is three
//      fixed mix() calls + three float() casts instead of a float vec3 mix
//      followed by a vec3 * scalar, saving ~780 cycles/LED.
//   Combined: ~1 430 cycles/LED ≈ 4.5 ms at 500 LEDs — brings the estimate
//   from 36.12 ms to ~31.6 ms, comfortably inside the 33.3 ms budget.
uniform float speed   : 0.0 .. 3.0 = 0.7;
uniform float density : 0.5 .. 4.0 = 2.0;
uniform float focus   : 0.0 .. 1.0 = 0.6;
uniform vec3  water   : color = 0.0, 0.18, 0.45;
uniform vec3  shimmer : color = 0.45, 0.88, 1.0;
uniform float gain    : 0.0 .. 1.0 = 0.88;

state fixed p1;
state fixed p2;
state fixed p3;
state fixed k;
state fixed thr;
// water*gain and shimmer*gain in fixed — computed once in update(), loaded
// cheaply (~70 cycles each) in shade() instead of a float vec3 mix + scale.
state fixed wr; state fixed wg; state fixed wb;
state fixed sr; state fixed sg; state fixed sb;

void update() {
  p1  = fract(p1 + fixed(dt * speed * 0.19));
  p2  = fract(p2 - fixed(dt * speed * 0.13));
  p3  = fract(p3 + fixed(dt * speed * 0.23));
  k   = fixed(density);
  thr = fixed(focus) * fixed(0.5);
  wr  = fixed(water.r   * gain);
  wg  = fixed(water.g   * gain);
  wb  = fixed(water.b   * gain);
  sr  = fixed(shimmer.r * gain);
  sg  = fixed(shimmer.g * gain);
  sb  = fixed(shimmer.b * gain);
}

vec3 shade(Led led) {
  // Cylinder surface coords; atan2 of fixed args is cached per-LED by the VM.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));
  fixed h   = fixed(led.uv.y);
  fixed a   = ang * k;
  fixed b   = h   * k;

  // Three waves at incommensurate spatial ratios so the interference pattern
  // never settles into a visible tile.
  fixed w1 = sin(a * fixed(2.00) + b * fixed(0.70) + p1);
  fixed w2 = sin(a * fixed(1.40) - b * fixed(1.20) + p2);
  fixed w3 = sin(a * fixed(2.50) + b * fixed(1.05) + p3);

  // Normalise sum to [-1, 1] then isolate constructive-interference peaks.
  fixed v      = (w1 + w2 + w3) * fixed(0.3333);
  fixed peak   = max(v - thr, fixed(0.0));
  fixed t      = min(peak * fixed(2.5), fixed(1.0));
  fixed bright = t * t;

  // Blend precomputed colour components in fixed; only three float() casts
  // needed to build the return value.
  return vec3(float(mix(wr, sr, bright)),
              float(mix(wg, sg, bright)),
              float(mix(wb, sb, bright)));
}
