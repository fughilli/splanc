// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p05 status=ok calls=1
// request: a heartbeat pulse from the centre outward
// Heartbeat: a lub-dub double pulse radiates from the vertical centre of the
// lamp simultaneously toward the top and bottom, creating an expanding bright
// ring on each beat. Fixed-point per-LED maths: ≈ 3 400 cycles/LED, well under
// the 33 ms / 30 fps budget at 500 LEDs.
//
// led.uv.y: 0 = lowest LED, 1 = highest.  Midpoint 0.5 = vertical centre.
// d: normalised distance from that midpoint, 0 (centre) → 1 (top or bottom).
// w1 / w2: wavefront positions for the two beats, expressed in the same 0..1
//   units.  Both travel at `speed` units/s; beat 2 lags beat 1 by b2gap of
//   the period, so their separation is constant and they never overlap.

uniform float bpm   : 30.0 .. 120.0 = 65.0;   // heart rate
uniform float speed : 0.5  .. 5.0   = 2.5;    // wavefront expansion (units/s)
uniform float tail  : 0.03 .. 0.35  = 0.13;   // pulse half-width in distance units
uniform float b2gap : 0.05 .. 0.45  = 0.18;   // 2nd beat delay (fraction of period)
uniform float b2amp : 0.2  .. 1.0   = 0.65;   // 2nd beat amplitude
uniform vec3  color : color = 1.0, 0.12, 0.22; // pulse colour (deep rose-red)

state fixed w1;     // beat-1 wavefront
state fixed w2;     // beat-2 wavefront
state fixed itail;  // 1.0 / tail, hoisted out of shade()
state fixed b2a;    // b2amp as fixed

void update() {
  float period = 60.0 / bpm;
  // mod() gives the elapsed time since the last firing of each beat.
  // beat 2 always lags beat 1 by b2gap * period seconds.
  w1    = fixed(mod(time,                  period) * speed);
  w2    = fixed(mod(time - b2gap * period, period) * speed);
  itail = fixed(1.0 / tail);
  b2a   = fixed(b2amp);
}

vec3 shade(Led led) {
  // Normalised distance from vertical midpoint: 0 = centre, 1 = top/bottom.
  fixed d = abs(fixed(led.uv.y) - fixed(0.5)) * fixed(2.0);

  // Triangular pulse: peak where d == wavefront, decays linearly over `tail`
  // on each side.  Beats maintain a constant separation of b2gap * period *
  // speed ≈ 0.42 distance units (> 2 * tail), so they never overlap.
  fixed v1 = max(fixed(1.0) - abs(d - w1) * itail, fixed(0.0));
  fixed v2 = max(fixed(1.0) - abs(d - w2) * itail, fixed(0.0)) * b2a;

  // Whichever beat is brighter wins.  Convert once to float for the colour
  // multiply; the rest of the chain is fixed arithmetic.
  return color * float(max(v1, v2));
}
