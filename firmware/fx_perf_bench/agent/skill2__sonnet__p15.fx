// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p15 status=ok calls=1
// request: water caustics shimmer
// Water caustics shimmer — four overlapping traveling waves on the cylinder
// surface (angle × height) interfere to produce wandering bright patches like
// sunlight refracted through water.  All per-LED maths in fixed point.
uniform float speed   : 0.0 .. 3.0 = 0.7;
uniform float density : 0.5 .. 4.0 = 2.0;        // wave spatial frequency
uniform float focus   : 0.0 .. 1.0 = 0.6;        // 0 = soft wash  1 = tight spots
uniform vec3  water   : color = 0.0, 0.18, 0.45;  // ambient water colour
uniform vec3  shimmer : color = 0.45, 0.88, 1.0;  // caustic highlight
uniform float gain    : 0.0 .. 1.0 = 0.88;        // master brightness

state fixed p1;
state fixed p2;
state fixed p3;
state fixed p4;
state fixed k;
state fixed thr;

void update() {
  p1  = fract(p1 + fixed(dt * speed * 0.19));
  p2  = fract(p2 - fixed(dt * speed * 0.13));
  p3  = fract(p3 + fixed(dt * speed * 0.23));
  p4  = fract(p4 - fixed(dt * speed * 0.09));
  k   = fixed(density);
  // threshold: focus=0 → many dim patches, focus=1 → few tight bright spots
  thr = fixed(focus) * fixed(0.5);
}

vec3 shade(Led led) {
  // Cylinder surface coords: angle in turns (atan2 cached per-LED by compiler)
  // and normalised height 0..1.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));
  fixed h   = fixed(led.uv.y);

  // Four waves at incommensurate spatial ratios so the interference pattern
  // never settles into a visible tile.
  fixed a  = ang * k;
  fixed b  = h   * k;
  fixed w1 = sin(a * fixed(2.00)  + b * fixed(0.70)  + p1);
  fixed w2 = sin(a * fixed(1.40)  - b * fixed(1.20)  + p2);
  fixed w3 = sin(a * fixed(2.50)  + b * fixed(1.05)  + p3);
  fixed w4 = sin(b * fixed(1.85)  - a * fixed(0.85)  + p4);

  // Interference sum → -1..1.
  fixed v = (w1 + w2 + w3 + w4) * fixed(0.25);

  // Caustic: keep only the constructive-interference peaks above threshold,
  // then square for narrow, bright spots surrounded by dark water.
  fixed peak  = max(v - thr, fixed(0.0));
  fixed t     = min(peak * fixed(2.5), fixed(1.0));
  fixed bright = t * t;

  return mix(water, shimmer, float(bright)) * gain;
}
