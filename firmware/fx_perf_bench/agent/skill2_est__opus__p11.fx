// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p11 status=ok calls=0 within_budget
// request: police lights spinning red/blue
// Police lights: a red and a blue beam sweep around the cylinder like a
// rotating lightbar, 180 degrees apart, with an optional alternating strobe.
// The beams use the angle around the vertical (+Y) axis, measured from the
// lamp's centre. All per-LED maths is fixed point (angle in turns).
uniform float speed       : 0.0 .. 4.0  = 1.5;   // revolutions per second
uniform float width       : 0.05 .. 0.5 = 0.22;  // beam width, fraction of a turn
uniform float strobe      : 0.0 .. 1.0  = 0.35;  // how hard the beams alternate
uniform float strobe_rate : 1.0 .. 12.0 = 5.0;   // red/blue alternations per second
uniform float glow        : 0.0 .. 0.3  = 0.02;  // dim fill between beams
uniform vec3  red_col     : color = 1.0, 0.0, 0.0;
uniform vec3  blue_col    : color = 0.0, 0.12, 1.0;

state fixed ph;   // rotation phase, turns
state fixed k;    // 1 / half beam width
state fixed gr;   // red strobe gain
state fixed gb;   // blue strobe gain
state fixed g;    // glow
state fixed cx;   // lamp axis (x)
state fixed cz;   // lamp axis (z)

void update() {
  ph = fract(ph + fixed(dt * speed));
  k = fixed(2.0 / width);
  g = fixed(glow);
  cx = fixed((room.min.x + room.max.x) * 0.5);
  cz = fixed((room.min.z + room.max.z) * 0.5);
  float on = 1.0;
  float off = 1.0 - strobe;
  if (fract(time * strobe_rate * 0.5) < 0.5) {
    gr = fixed(on);
    gb = fixed(off);
  } else {
    gr = fixed(off);
    gb = fixed(on);
  }
}

vec3 shade(Led led) {
  // Angle around the axis in turns, 0..1.
  fixed ang = atan2(fixed(led.pos.z) - cz, fixed(led.pos.x) - cx) + fixed(0.5);
  fixed a = fract(ang + ph);
  fixed dr = abs(a - fixed(0.25));
  fixed db = abs(a - fixed(0.75));
  fixed ir = clamp(fixed(1.0) - dr * k, fixed(0.0), fixed(1.0));
  fixed ib = clamp(fixed(1.0) - db * k, fixed(0.0), fixed(1.0));
  ir = ir * ir * gr + g;
  ib = ib * ib * gb + g;
  return red_col * float(ir) + blue_col * float(ib);
}
