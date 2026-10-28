// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p14 status=ok calls=1
// request: a scanner beam sweeping left to right
// Scanner beam: a sharp bright stripe sweeps left-to-right around the
// cylinder, leaving a decaying phosphor glow in its wake. Azimuthal angle is
// computed from led.pos in the XZ plane (+Y up). All per-LED maths are
// fixed-point or simple float — no float transcendentals per LED.

uniform float speed  : 0.5 .. 8.0  = 2.0;    // sweeps per second
uniform float width  : 0.01 .. 0.25 = 0.04;  // beam width (fraction of circumference)
uniform float tail   : 0.0  .. 0.7  = 0.28;  // trailing glow length
uniform vec3  beam   : color = 0.25, 0.85, 1.0;
uniform vec3  glow   : color = 0.0,  0.18, 0.4;
uniform float bg     : 0.0  .. 0.12 = 0.004; // ambient floor

state fixed pos;       // beam-front azimuth, turns [0..1)
state fixed kw;        // beam width as fixed
state fixed kt;        // tail length as fixed
state float inv_tail;  // 1 / tail — avoid per-LED division

void update() {
  pos      = fract(pos + fixed(dt * speed));
  kw       = fixed(width);
  kt       = fixed(tail);
  inv_tail = 1.0 / max(tail, 0.001);
}

vec3 shade(Led led) {
  // Azimuthal angle in turns [0..1) from the XZ position.
  // atan2(fixed, fixed) uses the integer LUT (~350 cycles, cached per LED).
  fixed ang = fract(atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5));

  // Angular distance behind the beam front [0..1):
  //   0 = at the leading edge, grows as the beam sweeps past.
  // Adding fixed(1.0) before fract keeps the argument positive.
  float b  = float(fract(ang - pos + fixed(1.0)));
  float fw = float(kw);
  float ft = float(kt);

  // Beam core: 1 when b < fw (sharp leading edge + width).
  float in_beam = 1.0 - step(fw, b);

  // Trailing glow: linear falloff from beam rear to tail end.
  float in_tail = step(fw, b) * (1.0 - step(fw + ft, b));
  float tail_v  = in_tail * (1.0 - (b - fw) * inv_tail);

  // Cheap height vignette: full brightness at mid-height, 70 % at tips.
  // Uses only multiply + add — no transcendentals.
  float hy   = led.uv.y * 2.0 - 1.0;          // −1..1, 0 at centre
  float vign = 0.7 + 0.3 * (1.0 - hy * hy);   // parabola: 1.0 mid, 0.7 ends

  return (beam * in_beam + glow * tail_v) * vign + vec3(bg, bg, bg);
}
